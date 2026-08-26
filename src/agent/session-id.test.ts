import { describe, expect, test } from "vitest";
import { createEngineHandle, isEngineHandle, nativeSessionId } from "./session-id.js";

describe("session identity", () => {
  test("createEngineHandle is an internal handle, not a native id", () => {
    const handle = createEngineHandle("grok");
    expect(isEngineHandle(handle)).toBe(true);
    expect(nativeSessionId(handle)).toBeUndefined();
    expect(handle.startsWith("grok_")).toBe(true);
  });

  test("keeps backend-native ids", () => {
    expect(nativeSessionId("019ffb94-1c5b-72f3-b3eb-42e766619372")).toBe(
      "019ffb94-1c5b-72f3-b3eb-42e766619372",
    );
    expect(nativeSessionId("grok-native-agent_1")).toBe("grok-native-agent_1");
    expect(nativeSessionId("  sess_abc  ")).toBe("sess_abc");
  });

  test("drops engine handles", () => {
    expect(isEngineHandle("grok_1787630975612_af90f32a")).toBe(true);
    expect(nativeSessionId("grok_1787630975612_af90f32a")).toBeUndefined();
    expect(nativeSessionId("codex_1787613030736_b30d032e")).toBeUndefined();
    expect(nativeSessionId("claude_1700000000000_deadbeef")).toBeUndefined();
  });

  test("drops the current engine handle even when it is not wrapper-shaped", () => {
    expect(nativeSessionId("agent_1", "agent_1")).toBeUndefined();
    expect(nativeSessionId("native-id", "agent_1")).toBe("native-id");
  });

  test("drops empty values", () => {
    expect(nativeSessionId(undefined)).toBeUndefined();
    expect(nativeSessionId(null)).toBeUndefined();
    expect(nativeSessionId("")).toBeUndefined();
    expect(nativeSessionId("   ")).toBeUndefined();
    expect(isEngineHandle(undefined)).toBe(false);
  });
});
