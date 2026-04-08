import { describe, expect, it, vi } from "vitest";
import type { AgentBackend, AgentSession } from "../agent/types.js";
import { generateSummary } from "./llm.js";

function makeAgent(responses: string[]): AgentBackend {
  const session: AgentSession = { id: "s1" };
  const sendMessage = vi.fn(async () => ({ text: responses.shift() ?? "" }));

  return {
    start: vi.fn(),
    stop: vi.fn(),
    createSession: vi.fn(async () => session),
    sendMessage,
    cancelSession: vi.fn(),
    closeSession: vi.fn(async () => {}),
  };
}

describe("generateSummary", () => {
  it("repairs malformed JSON responses", async () => {
    const agent = makeAgent([
      "{\"summary\":\"x\",\"detail\":\"bad\"",
      "{\"summary\":\"fixed\",\"detail\":\"ok\"}",
    ]);

    await expect(generateSummary(agent, "prompt")).resolves.toEqual({
      summary: "fixed",
      detail: "ok",
    });
    expect(agent.sendMessage).toHaveBeenCalledTimes(2);
  });

  it("rejects non-string fields and retries before returning", async () => {
    const agent = makeAgent([
      "{\"summary\":[\"topic\"],\"detail\":[]}",
      "{\"summary\":\"valid\",\"detail\":\"detail\"}",
    ]);

    await expect(generateSummary(agent, "prompt")).resolves.toEqual({
      summary: "valid",
      detail: "detail",
    });
    expect(agent.sendMessage).toHaveBeenCalledTimes(2);
  });
});
