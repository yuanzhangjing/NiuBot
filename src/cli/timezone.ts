import { localApiRequest } from "../local-api/client.js";
import { DEFAULT_TIMEZONE } from "../tz.js";
import { resolveSendEndpoint } from "./send.js";

export type TimezoneCliRequest =
  | { kind: "help" }
  | { kind: "get" }
  | { kind: "set"; raw: string }
  | { kind: "error"; message: string };

/** Agent-only: apply a resolved timezone through the running Engine. */
export function parseTimezoneCliArgs(args: string[]): TimezoneCliRequest {
  const action = args[0];
  if (action === "--help" || action === "help") return { kind: "help" };
  if (!action || action === "get" || action === "show") return { kind: "get" };
  if (action === "reset") return { kind: "set", raw: DEFAULT_TIMEZONE };
  const raw = (action === "set" ? args.slice(1) : args).join(" ").trim();
  if (!raw) return { kind: "error", message: "Error: nbt timezone set 需要时区，例如 America/Los_Angeles" };
  return { kind: "set", raw };
}

export async function handleTimezoneCli(
  args: string[],
  isAdmin: boolean,
): Promise<void> {
  const request = parseTimezoneCliArgs(args);
  if (request.kind === "help") {
    console.log(`Apply the Engine display timezone (agent use).

Usage:
  nbt timezone
  nbt timezone set <America/Los_Angeles|西雅图|...>
  nbt timezone reset`);
    return;
  }
  if (request.kind === "error") {
    console.error(request.message);
    process.exit(1);
  }
  if (request.kind === "get") {
    console.log(await getEngineTimezone());
    return;
  }
  if (!isAdmin) {
    console.error("Error: timezone 仅管理员可用");
    process.exit(1);
  }

  console.log(await setEngineTimezone(request.raw));
}

async function getEngineTimezone(): Promise<string> {
  const response = await localApiRequest(resolveSendEndpoint(), "/timezone", { method: "GET" });
  if (response.statusCode >= 400) {
    throw new Error(`无法读取时区 (${response.statusCode}): ${response.body}`);
  }
  const parsed = JSON.parse(response.body) as { timezone?: string };
  if (!parsed.timezone) throw new Error("引擎没有返回时区");
  return parsed.timezone;
}

async function setEngineTimezone(raw: string): Promise<string> {
  const response = await localApiRequest(resolveSendEndpoint(), "/timezone", {
    method: "POST",
    body: { timezone: raw },
  });
  if (response.statusCode >= 400) {
    let detail = response.body;
    try {
      const parsed = JSON.parse(response.body) as { error?: string };
      detail = parsed.error ?? detail;
    } catch { /* keep body */ }
    throw new Error(detail);
  }
  const parsed = JSON.parse(response.body) as { timezone?: string };
  if (!parsed.timezone) throw new Error("引擎没有返回时区");
  return parsed.timezone;
}
