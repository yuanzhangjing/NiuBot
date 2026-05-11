export type ProxyEnvironmentSummary = {
  httpProxy: string;
  httpsProxy: string;
  allProxy: string;
  noProxyEntries: number;
  noProxyHasFeishu: boolean;
};

const FEISHU_PROXY_HOSTS = new Set(["open.feishu.cn", "open.larksuite.com"]);

export function summarizeProxyEnvironment(env: Record<string, string | undefined> = process.env): ProxyEnvironmentSummary {
  const noProxyEntries = splitNoProxy(readFirstNonEmptyEnv(env, ["npm_config_no_proxy", "no_proxy"]) ?? "");
  return {
    httpProxy: summarizeProxyUrl(readEnv(env, "http_proxy")),
    httpsProxy: summarizeProxyUrl(readEnv(env, "https_proxy")),
    allProxy: summarizeProxyUrl(readEnv(env, "all_proxy")),
    noProxyEntries: noProxyEntries.length,
    noProxyHasFeishu: noProxyEntries.some(matchesFeishuHost),
  };
}

function readEnv(env: Record<string, string | undefined>, lowerKey: string): string | undefined {
  return env[lowerKey] ?? env[lowerKey.toUpperCase()];
}

function readFirstNonEmptyEnv(env: Record<string, string | undefined>, lowerKeys: string[]): string | undefined {
  for (const key of lowerKeys) {
    const value = readEnv(env, key);
    if (value?.trim()) return value;
  }
  return undefined;
}

function summarizeProxyUrl(value: string | undefined): string {
  if (!value) return "unset";
  try {
    const url = new URL(value);
    const port = url.port ? `:${url.port}` : "";
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    return "set";
  }
}

function splitNoProxy(value: string): string[] {
  return value
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
}

function matchesFeishuHost(entry: string): boolean {
  const withoutPort = entry.replace(/:\d+$/, "");
  const normalized = withoutPort.startsWith("*.") ? withoutPort.slice(1) : withoutPort;
  if (normalized === "*") return true;
  if (FEISHU_PROXY_HOSTS.has(normalized)) return true;
  if (["feishu.cn", ".feishu.cn", "larksuite.com", ".larksuite.com"].includes(normalized)) return true;
  if (normalized.startsWith(".")) {
    return Array.from(FEISHU_PROXY_HOSTS).some((host) => host.endsWith(normalized));
  }
  return false;
}
