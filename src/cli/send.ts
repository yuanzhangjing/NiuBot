/**
 * CLI: send — send messages and files via IPC to the running daemon.
 */

import http from "node:http";
import path from "node:path";
import os from "node:os";

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) { console.error(`${name} is not set. nbt must run inside a NiuBot session.`); process.exit(1); }
  return v;
}
const NIUBOT_HOME = requireEnv("NIUBOT_HOME");
const DB_PATH = process.env["NIUBOT_DB_PATH"];

function getSocketPath(): string {
  return process.env["NIUBOT_API_SOCKET"]
    ?? (DB_PATH
      ? path.join(path.dirname(DB_PATH), "api.sock")
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

  if (flags["help"] === "true" || positional[0] === "help") {
    printHelp();
    return;
  }

  if (!targetChatId) {
    console.error("Error: NIUBOT_CHAT_ID not set and --chat-id not provided");
    process.exit(1);
  }

  // Send file
  const fileFlag = flags["file"];
  if (fileFlag !== undefined) {
    const filePath = fileFlag === "true" ? positional[0] : fileFlag;
    if (!filePath) {
      console.error("Usage: nbt send --file <path>");
      process.exit(1);
    }
    const socketPath = getSocketPath();
    const absPath = path.resolve(filePath);
    ipcRequest(socketPath, "/send-file", { chat_id: targetChatId, file_path: absPath })
      .then(() => console.log("File sent."))
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    return;
  }

  // Send card
  const cardHeader = flags["card"];
  if (cardHeader != null) {
    const content = positional.join(" ");
    if (!content) {
      console.error("Usage: nbt send --card <header> <content>");
      process.exit(1);
    }
    const socketPath = getSocketPath();
    ipcRequest(socketPath, "/send", { chat_id: targetChatId, text: content, card_header: cardHeader })
      .then(() => console.log("Card sent."))
      .catch((err) => {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      });
    return;
  }

  // Send text
  const text = positional.join(" ");
  if (!text) {
    console.error("Usage: nbt send <text>");
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

function printHelp(): void {
  console.log(`Send messages or files to the current or specified chat.

  nbt send <text>                        Text message
  nbt send --card <header> <content>     Card message
  nbt send --file <path>                 Send a file
  nbt send --chat-id <id> <text>         Send to a specific chat`);
}
