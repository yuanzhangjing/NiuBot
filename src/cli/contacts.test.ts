import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("contacts CLI time display", () => {
  it("formats stored UTC timestamps as configured local time with timezone label", async () => {
    vi.stubEnv("NIUBOT_TZ", "Asia/Shanghai");
    vi.resetModules();
    const { formatContactCreatedAt } = await import("./contacts.js");

    const formatted = formatContactCreatedAt("2026-04-24 16:30:00");

    expect(formatted).toBe("2026-04-25 00:30 (Asia/Shanghai)");
  });
});
