import { describe, expect, test, vi } from "vitest";
import { TimeoutError, withTimeout } from "./timeout.js";

describe("withTimeout", () => {
  test("returns the original result when the operation resolves before timeout", async () => {
    await expect(withTimeout({
      label: "fast operation",
      timeoutMs: 100,
      fn: async () => "ok",
    })).resolves.toBe("ok");
  });

  test("throws TimeoutError when the operation exceeds timeoutMs", async () => {
    vi.useFakeTimers();

    const promise = withTimeout({
      label: "slow operation",
      timeoutMs: 100,
      fn: () => new Promise<string>(() => {}),
    });
    const failure = promise.catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(100);

    const err = await failure;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(err).toMatchObject({
      code: "TIMEOUT",
      message: "slow operation timed out after 100ms",
    });
  });

  test("fails immediately when the external signal is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");
    controller.abort(reason);
    const fn = vi.fn(async () => "not called");

    await expect(withTimeout({
      label: "externally aborted",
      timeoutMs: 100,
      signal: controller.signal,
      fn,
    })).rejects.toBe(reason);
    expect(fn).not.toHaveBeenCalled();
  });

  test("fails when the external signal aborts while the operation is pending", async () => {
    const controller = new AbortController();
    const reason = new Error("stopped");

    const failure = withTimeout({
      label: "externally aborted while pending",
      timeoutMs: 1000,
      signal: controller.signal,
      fn: () => new Promise<string>(() => {}),
    }).catch((err: unknown) => err);

    controller.abort(reason);

    await expect(failure).resolves.toBe(reason);
  });

  test("aborts the signal passed to fn after timeout", async () => {
    vi.useFakeTimers();
    let innerSignal: AbortSignal | undefined;

    const promise = withTimeout({
      label: "abort inner",
      timeoutMs: 100,
      fn: (signal) => {
        innerSignal = signal;
        return new Promise<string>(() => {});
      },
    });
    const failure = promise.catch((err: unknown) => err);

    expect(innerSignal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(100);

    expect(innerSignal?.aborted).toBe(true);
    await expect(failure).resolves.toBeInstanceOf(TimeoutError);
  });
});
