import { describe, expect, it } from "vitest";
import { parseTimezoneCliArgs } from "./timezone.js";

describe("parseTimezoneCliArgs", () => {
  it("reads the current timezone by default", () => {
    expect(parseTimezoneCliArgs([])).toEqual({ kind: "get" });
  });

  it("treats a phrase as set so the agent can apply a resolved zone", () => {
    expect(parseTimezoneCliArgs(["set", "America/Los_Angeles"])).toEqual({
      kind: "set",
      raw: "America/Los_Angeles",
    });
    expect(parseTimezoneCliArgs(["西雅图"])).toEqual({ kind: "set", raw: "西雅图" });
  });
});
