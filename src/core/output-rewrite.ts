import Anthropic from "@anthropic-ai/sdk";
import { createLogger } from "../logger.js";

const DEFAULT_REWRITE_PROMPT = [
  "重写下面这段回复，第一目标是让用户看得清楚。",
  "不要为了变短牺牲清晰度；根据内容复杂度决定篇幅。",
  "简单内容用几句话说清；复杂内容保留必要结构，但不要完整复述。",
  "先给结论，再说关键原因、重要问题和下一步动作。",
  "可以重新组织段落，合并重复内容，删掉铺垫、废话和不影响判断的过程说明。",
  "优先保留核心内容：结论、关键进展、重要问题、限制条件、错误信息、下一步动作。",
  "命令、路径、URL、数字、版本号、配置名和技术名词，只有在影响理解、判断或下一步时才保留。",
  "保留人称和责任归属，不要把“我”改成“你”，不要改变谁做了什么。",
  "语气平实、克制，像靠谱同事说话；不要客服腔、汇报腔、黑话。",
  "不要添加任何关于改写过程、改写结果或任务完成情况的说明。",
].join("\n");

const DEFAULT_MODEL = "deepseek-v4-flash";
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_TOKENS = 4096;

type MessageContentBlock = { type: string; text?: string };

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

  async rewrite(input: { backendType: string; text: string; signal?: AbortSignal }): Promise<string> {
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
      const message = await client.messages.create({
        model: config.model ?? this.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] ?? DEFAULT_MODEL,
        max_tokens: config.maxTokens ?? DEFAULT_MAX_TOKENS,
        temperature: 0.2,
        system: config.prompt ?? DEFAULT_REWRITE_PROMPT,
        messages: [{ role: "user", content: input.text }],
      }, {
        signal: input.signal,
        timeout: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      });

      const rewritten = message.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text!)
        .join("")
        .trim();

      return rewritten || input.text;
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
