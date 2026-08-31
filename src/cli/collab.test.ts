import http from "node:http";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveBotEndpoint } from "../platform/ipc.js";
import { handleCollab } from "./collab.js";

const tempDirs: string[] = [];
const servers: http.Server[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => resolve());
  })));
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("nbt collab", () => {
  it("posts a structured handoff with the current session context", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "niubot-collab-cli-"));
    tempDirs.push(root);
    const endpoint = resolveBotEndpoint(root, "TestBot");
    mkdirSync(path.dirname(endpoint.address), { recursive: true });
    const bodies: unknown[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        bodies.push(JSON.parse(Buffer.concat(chunks).toString()));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ output: "协作动作已记录。" }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(endpoint.address, resolve);
    });

    vi.stubEnv("NIUBOT_API_SOCKET", endpoint.address);
    vi.stubEnv("NIUBOT_CHAT_ID", "c1");
    vi.stubEnv("NIUBOT_SCOPE_KEY", "c1#omt_topic");
    vi.stubEnv("NIUBOT_THREAD_ID", "omt_topic");
    vi.stubEnv("NIUBOT_WAKE_REPLY_TO", "om_trigger");
    vi.stubEnv("NIUBOT_COLLAB_TOKEN", "turn-token");
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await handleCollab(["turn", "--action", "handoff", "--to", "ou-cow"]);

    expect(bodies).toEqual([{
      chat_id: "c1",
      decision: { action: "handoff", to: "ou-cow" },
      collab_token: "turn-token",
      scope_key: "c1#omt_topic",
      thread_id: "omt_topic",
      reply_to_msg_id: "om_trigger",
    }]);
    expect(output).toHaveBeenCalledWith("Collab turn recorded.");
  });
});
