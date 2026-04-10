interface ResponseFooterInput {
  sessionId: string;
  turnCount?: number;
  contextTokens?: number;
  compactCount?: number;
  model?: string;
}

export function buildResponseFooter(input: ResponseFooterInput): string {
  const footerParts = [`${input.sessionId} · #${input.turnCount ?? "?"}`];

  if (input.contextTokens && input.contextTokens > 0) {
    footerParts.push(formatTokenCount(input.contextTokens));
  }

  if (input.compactCount && input.compactCount > 0) {
    footerParts.push(`📦×${input.compactCount}`);
  }

  if (input.model) {
    footerParts.push(formatModelName(input.model));
  }

  return footerParts.join(" · ");
}

function formatTokenCount(value: number): string {
  return `${(value / 1000).toFixed(1)}k`;
}

export function formatModelName(raw: string): string {
  if (raw.startsWith("gpt-")) return raw.toUpperCase();

  if (raw.startsWith("claude-")) {
    const s = raw.replace(/^claude-/, "");
    const parts = s.split("-").filter((p) => p.length > 0 && !(p.length === 8 && /^\d+$/.test(p)));
    if (parts.length === 0) return raw;
    const name = parts[0]![0]!.toUpperCase() + parts[0]!.slice(1);
    return parts.length > 1 ? `${name} ${parts.slice(1).join(".")}` : name;
  }

  return raw;
}
