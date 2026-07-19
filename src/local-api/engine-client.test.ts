import { describe, expect, it } from "vitest";
import { engineIdentityMatches } from "./engine-client.js";
import type { EngineIdentity } from "./engine-server.js";

const identity: EngineIdentity = {
  pid: 123,
  instanceId: "instance-a",
  home: "/tmp/niubot-home",
  version: "1.0.0",
  runtimePath: "/tmp/niubot-runtime",
  startedAt: "2026-07-19T00:00:00.000Z",
};

describe("engine identity matching", () => {
  it("checks process and runtime identity fields when provided", () => {
    expect(engineIdentityMatches(identity, {
      instanceId: "instance-a",
      pid: 123,
      home: "/tmp/niubot-home",
      runtimePath: "/tmp/niubot-runtime",
    })).toBe(true);
    expect(engineIdentityMatches(identity, { instanceId: "instance-a", pid: 456 })).toBe(false);
    expect(engineIdentityMatches(identity, { instanceId: "instance-a", home: "/tmp/other-home" })).toBe(false);
    expect(engineIdentityMatches(identity, { instanceId: "instance-a", runtimePath: "/tmp/other-runtime" })).toBe(false);
  });

  it("keeps instance-id-only checks available for diagnostic callers", () => {
    expect(engineIdentityMatches(identity, "instance-a")).toBe(true);
    expect(engineIdentityMatches(identity, "instance-b")).toBe(false);
  });
});
