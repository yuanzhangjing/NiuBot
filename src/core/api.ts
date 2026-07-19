/**
 * IPC API Server — Unix socket server for CLI commands (send, send-file, cron).
 * Allows the CLI process to communicate with the running daemon.
 */

import http from "node:http";
import path from "node:path";
import { createLogger } from "../logger.js";
import {
  cleanupLocalIpcEndpoint,
  endpointFromAddress,
  prepareLocalIpcEndpoint,
  type LocalIpcEndpoint,
} from "../platform/ipc.js";

const log = createLogger("api");

export interface ApiHandler {
  /** Send text message to a chat */
  sendMessage(chatId: string, text: string): Promise<void>;
  /** Send card message to a chat */
  sendCard(chatId: string, header: string, content: string): Promise<void>;
  /** Send file to a chat */
  sendFile(chatId: string, filePath: string): Promise<void>;
  /** Resolve chat platform_id from short ID or platform ID */
  resolveChatPlatformId(chatIdOrShort: string): string | undefined;
  /** Get the default platform chat ID (from current session context) */
  getDefaultPlatformChatId(sessionId?: string): string | undefined;
}

export class ApiServer {
  private server: http.Server | null = null;
  private endpoint: LocalIpcEndpoint;
  private handler: ApiHandler;

  constructor(endpoint: LocalIpcEndpoint | string, handler: ApiHandler) {
    this.endpoint = typeof endpoint === "string" ? endpointFromAddress(endpoint) : endpoint;
    this.handler = handler;
  }

  async start(): Promise<void> {
    await prepareLocalIpcEndpoint(this.endpoint);

    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("api request error", { error: String(err) });
        res.writeHead(500);
        res.end(JSON.stringify({ error: String(err) }));
      });
    });

    return new Promise((resolve, reject) => {
      this.server!.listen(this.endpoint.address, () => {
        log.info("api server started", { endpoint: this.endpoint.address, kind: this.endpoint.kind });
        resolve();
      });
      this.server!.on("error", reject);
    });
  }

  stop(): void {
    if (this.server) {
      this.server.close();
      try { cleanupLocalIpcEndpoint(this.endpoint); } catch { /* ignore */ }
      this.server = null;
      log.info("api server stopped");
    }
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const body = await readBody(req);
    let data: any = {};
    try {
      if (body) data = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    const url = req.url ?? "";

    if (url === "/send" && req.method === "POST") {
      const chatId = data.chat_id;
      const text = data.text;
      const cardHeader = data.card_header;
      if (!chatId || !text) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing chat_id or text" }));
        return;
      }
      const platformChatId = this.handler.resolveChatPlatformId(chatId);
      if (!platformChatId) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Chat not found" }));
        return;
      }
      if (cardHeader != null) {
        await this.handler.sendCard(platformChatId, String(cardHeader), text);
      } else {
        await this.handler.sendMessage(platformChatId, text);
      }
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
    } else if (url === "/send-file" && req.method === "POST") {
      const chatId = data.chat_id;
      const filePath = data.file_path;
      if (!chatId || !filePath) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "Missing chat_id or file_path" }));
        return;
      }
      if (!path.isAbsolute(filePath)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: "file_path must be absolute" }));
        return;
      }
      const platformChatId = this.handler.resolveChatPlatformId(chatId);
      if (!platformChatId) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Chat not found" }));
        return;
      }
      await this.handler.sendFile(platformChatId, filePath);
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
    } else if (url === "/ping") {
      res.writeHead(200);
      res.end(JSON.stringify({ status: "ok" }));
    } else {
      res.writeHead(404);
      res.end(JSON.stringify({ error: "Not found" }));
    }
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}
