import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../logger.js";

const DEFAULT_REWRITE_PROMPT = [
  "你是回复改写器，不是对话助手。",
  "",
  "任务：",
  "根据用户原始请求，重写“原始回复”，让它更清楚、更直接、更容易读。",
  "",
  "要求：",
  "- 只改写原始回复，不重新回答用户问题。",
  "- 不添加原始回复中没有的新事实、新结论、新步骤。",
  "- 不改变技术含义、数字、路径、版本号、命令和责任归属。",
  "- 用户原始请求只用于理解意图和取舍重点。",
  "- 输出最终要发给用户的正文，不要解释改写过程。",
].join("\n");

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 4096;

type MessageContentBlock = { type: string; text?: string };

export interface OutputRewriteMarkerConfig {
  enabled?: boolean;
  text?: string;
}

export interface OutputRewriteConfig {
  enabled: boolean;
  applyToBackends?: string[];
  provider?: "anthropic-compatible";
  baseURL?: string;
  apiKey?: string;
  apiKeyEnv?: string;
  model?: string;
  timeoutMs?: number;
  maxTokens?: number;
  prompt?: string;
  logText?: boolean;
  marker?: OutputRewriteMarkerConfig;
}

type AnthropicMessagesClient = {
  messages: {
    create: (
      params: {
        model: string;
        max_tokens: number;
        temperature: number;
        system: string;
        messages: Array<{ role: "user"; content: string }>;
      },
      options?: { signal?: AbortSignal; timeout?: number },
    ) => Promise<{ content: MessageContentBlock[] }>;
  };
};

type OutputRewriterOptions = {
  config?: OutputRewriteConfig;
  env?: NodeJS.ProcessEnv;
  createClient?: (options: { apiKey: string; baseURL?: string }) => AnthropicMessagesClient;
};

const log = createLogger("output-rewrite");

export class OutputRewriter {
  private readonly config?: OutputRewriteConfig;
  private readonly env: NodeJS.ProcessEnv;
  private readonly createClient: (options: { apiKey: string; baseURL?: string }) => AnthropicMessagesClient;
  private client?: AnthropicMessagesClient;

  constructor(options: OutputRewriterOptions = {}) {
    this.config = options.config;
    this.env = options.env ?? process.env;
    this.createClient = options.createClient ?? ((clientOptions) => new Anthropic(clientOptions));
  }

  async rewrite(input: { backendType: string; text: string; originalPrompt?: string; signal?: AbortSignal }): Promise<string> {
    const config = this.config;
    if (!config?.enabled) return input.text;
    if (!this.shouldApplyToBackend(config, input.backendType)) return input.text;
    if (!input.text.trim()) return input.text;

    const provider = config.provider ?? "anthropic-compatible";
    if (provider !== "anthropic-compatible") {
      log.warn("unsupported output rewrite provider", { provider });
      return input.text;
    }

    const apiKeyEnv = config.apiKeyEnv ?? "ANTHROPIC_API_KEY";
    const apiKey = config.apiKey ?? this.env[apiKeyEnv];
    if (!apiKey) {
      log.warn("output rewrite skipped, api key env is missing", { apiKeyEnv });
      return input.text;
    }

    try {
      const client = this.getClient({
        apiKey,
        baseURL: config.baseURL ?? this.env["ANTHROPIC_BASE_URL"],
      });
      const model = config.model ?? this.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] ?? DEFAULT_MODEL;
      const message = await client.messages.create({
        model,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: 0.2,
        system: config.prompt ?? DEFAULT_REWRITE_PROMPT,
        messages: [{ role: "user", content: buildRewriteUserMessage(input.originalPrompt ?? "", input.text) }],
      }, {
        signal: input.signal,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      const rewritten = message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("")
        .trim();

      if (!rewritten) return input.text;
      return appendMarkerIfNeeded({
        originalText: input.text,
        rewrittenText: rewritten,
        model,
        marker: config.marker,
      });
    } catch (err) {
      log.warn("output rewrite failed, using original text", { error: String(err) });
      return input.text;
    }
  }

  shouldLogText(): boolean {
    return this.config?.logText === true;
  }

  private shouldApplyToBackend(config: OutputRewriteConfig, backendType: string): boolean {
    const backends = config.applyToBackends ?? ["codex"];
    return backends.includes(backendType);
  }

  private getClient(options: { apiKey: string; baseURL?: string }): AnthropicMessagesClient {
    this.client ??= this.createClient(options);
    return this.client;
  }
}

function buildRewriteUserMessage(originalPrompt: string, originalReply: string): string {
  return [
    "用户原始请求：",
    "<<<",
    originalPrompt,
    ">>>",
    "",
    "原始回复：",
    "<<<",
    originalReply,
    ">>>",
  ].join("\n");
}

function appendMarkerIfNeeded(input: {
  originalText: string;
  rewrittenText: string;
  model: string;
  marker?: OutputRewriteMarkerConfig;
}): string {
  if (input.marker?.enabled === false) return input.rewrittenText;
  const markerText = `📝 <font color='grey'>rewritten by ${escapeMarkerText(input.model)}</font>`;
  if (input.rewrittenText === input.originalText) return input.rewrittenText;
  if (input.rewrittenText.endsWith(markerText)) return input.rewrittenText;
  return `${input.rewrittenText}\n\n${markerText}`;
}

function escapeMarkerText(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
