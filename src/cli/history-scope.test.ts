import { describe, expect, it } from "vitest";
import { resolveHistoryThreadScope } from "./history-scope.js";

describe("resolveHistoryThreadScope", () => {
  it("keeps the current thread when listing the same chat", () => {
    expect(resolveHistoryThreadScope({}, "c5", "c5", "omt_aaa", true)).toEqual({
      threadId: "omt_aaa",
      allThreads: false,
    });
  });

  it("defaults isolated topic 主群 to thread_id IS NULL", () => {
    expect(resolveHistoryThreadScope({}, "c5", "c5", undefined, true)).toEqual({
      allThreads: false,
    });
  });

  it("does not hide reply threads in ordinary groups", () => {
    expect(resolveHistoryThreadScope({}, "c4", "c4", undefined, false)).toEqual({
      allThreads: true,
    });
  });

  it("does not inherit the current topic after switching chats", () => {
    expect(resolveHistoryThreadScope({}, "c5", "c4", "omt_aaa", false)).toEqual({
      allThreads: true,
    });
  });

  it("ignores an inherited env thread when the caller passes undefined", () => {
    expect(resolveHistoryThreadScope({}, "c1", "c1", undefined, false)).toEqual({
      allThreads: true,
    });
  });
});
