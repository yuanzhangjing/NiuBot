/**
 * CLI: send / send-file — send messages and files via IPC to the running daemon.
 */

import http from "node:http";
import path from "node:path";
import os from "node:os";

const NIUBOT_HOME = process.env["NIUBOT_HOME"] ?? path.join(os.homedir(), ".niubot");
const BOT_NAME = process.env["NIUBOT_BOT_NAME"];

function getSocketPath(): string {
  return process.env["NIUBOT_API_SOCKET"]
    ?? (BOT_NAME
      ? path.join(NIUBOT_HOME, BOT_NAME, "api.sock")
      : path.join(NIUBOT_HOME, "run", "api.sock"));
}

function ipcRequest(socketPath: string, urlPath: string, body: unknown): Promise<string> {
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        socketPath,
        path: urlPath,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString();
          if (res.statusCode && res.statusCode >= 400) {
            reject(new Error(`API error (${res.statusCode}): ${body}`));
          } else {
            resolve(body);
          }
        });
      },
    );
    req.on("error", (err) => {
      reject(new Error(`Cannot connect to NiuBot daemon: ${err.message}. Is NiuBot running?`));
    });
    req.write(data);
    req.end();
  });
}

export function handleSend(
  args: string[],
  chatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? chatId;
  const text = positional.join(" ");

  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }
  if (!text) {
    console.error("Usage: niubot send <text>");
    process.exit(1);
  }

  const socketPath = getSocketPath();
  ipcRequest(socketPath, "/send", { chat_id: targetChatId, text })
    .then(() => console.log("Message sent."))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

export function handleRestart(): void {
  // Admin-only: check env var set by pipeline
  if (process.env["NIUBOT_IS_ADMIN"] !== "true") {
    console.error("Error: restart is admin-only");
    process.exit(1);
  }

  const socketPath = getSocketPath();
  ipcRequest(socketPath, "/restart", {})
    .then(() => console.log("Restart signal sent."))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}

export function handleSendFile(
  args: string[],
  chatId: string | undefined,
  parseArgs: (args: string[]) => { positional: string[]; flags: Record<string, string> },
): void {
  const { positional, flags } = parseArgs(args);
  const targetChatId = flags["chat-id"] ?? chatId;
  const filePath = positional[0];

  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }
  if (!filePath) {
    console.error("Usage: niubot send-file <file-path>");
    process.exit(1);
  }

  const socketPath = getSocketPath();
  ipcRequest(socketPath, "/send-file", { chat_id: targetChatId, file_path: filePath })
    .then(() => console.log("File sent."))
    .catch((err) => {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    });
}
