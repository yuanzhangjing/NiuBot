import http from "node:http";
import { createLogger } from "../logger.js";
import {
  cleanupLocalIpcEndpoint,
  prepareLocalIpcEndpoint,
  type LocalIpcEndpoint,
} from "../platform/ipc.js";

const log = createLogger("engine-api");

export interface EngineIdentity {
  pid: number;
  instanceId: string;
  home: string;
  version: string;
  runtimePath: string;
  startedAt: string;
}

export class EngineControlServer {
  private server: http.Server | undefined;

  constructor(
    private endpoint: LocalIpcEndpoint,
    private identity: EngineIdentity,
    private controlToken: string,
    private onShutdown: () => void | Promise<void>,
  ) {}

  async start(): Promise<void> {
    await prepareLocalIpcEndpoint(this.endpoint);
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        log.error("engine control request failed", { error: String(err) });
        sendJson(res, 500, { error: "internal error" });
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(this.endpoint.address, () => {
        this.server!.off("error", reject);
        resolve();
      });
    });
    log.info("engine control API started", { endpoint: this.endpoint.address, kind: this.endpoint.kind });
  }

  stop(): void {
    this.server?.close();
    this.server = undefined;
    try { cleanupLocalIpcEndpoint(this.endpoint); } catch { /* ignore */ }
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method === "GET" && (req.url === "/health" || req.url === "/identity")) {
      sendJson(res, 200, req.url === "/health" ? { status: "ok" } : this.identity);
      return;
    }
    if (req.method === "POST" && req.url === "/shutdown") {
      const token = req.headers["x-niubot-control-token"];
      if (token !== this.controlToken) {
        sendJson(res, 403, { error: "forbidden" });
        return;
      }
      sendJson(res, 202, { status: "shutting-down" });
      setImmediate(() => void this.onShutdown());
      return;
    }
    sendJson(res, 404, { error: "not found" });
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
