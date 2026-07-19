import { describe, expect, it } from "vitest";
import { claudeProjectKey, cursorProjectKey } from "./workspace-path.js";

describe("backend workspace keys", () => {
  it("removes Windows drive colons from backend data directory names", () => {
    expect(claudeProjectKey("C:\\Users\\Zen\\work")).not.toContain(":");
    expect(cursorProjectKey("C:\\Users\\Zen\\work")).not.toContain(":");
  });
});
