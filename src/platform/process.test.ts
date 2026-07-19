import { describe, expect, it } from "vitest";
import { isProcessAlive, waitForProcessStartMarker } from "./process.js";

describe("process platform helpers", () => {
  it("reads a stable OS-owned marker for a live process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    const first = waitForProcessStartMarker(process.pid);
    const second = waitForProcessStartMarker(process.pid);
    expect(first).toBeTruthy();
    expect(second).toBe(first);
  });

  it("does not invent a marker for an invalid PID", () => {
    expect(waitForProcessStartMarker(-1, process.platform, 1, 1)).toBeUndefined();
  });
});
