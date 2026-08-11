import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, test, vi } from "vitest";
import { buildKeepAwakeInvocation, KeepAwakeController } from "./keep-awake.js";

describe("keep awake", () => {
  test("uses caffeinate on macOS", () => {
    expect(buildKeepAwakeInvocation("darwin", { PATH: "" })).toEqual({
      command: "/usr/bin/caffeinate",
      args: ["-d", "-i"],
      method: "caffeinate",
    });
  });

  test("uses PowerShell and Windows system execution state", () => {
    const invocation = buildKeepAwakeInvocation("win32", { Path: "", PATHEXT: ".EXE" });

    expect(invocation?.method).toBe("powershell");
    expect(invocation?.args).toContain("-Command");
    expect(invocation?.args.at(-1)).toContain("SetThreadExecutionState");
    expect(invocation?.args.at(-1)).toContain("ES_DISPLAY_REQUIRED");
    expect(invocation?.readyMarker).toBe("NIUBOT_KEEP_AWAKE_READY");
  });

  test("reports unsupported platforms", () => {
    expect(buildKeepAwakeInvocation("linux")).toBeUndefined();
  });

  test("starts once, reports status, and stops the process", async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const controller = new KeepAwakeController({
      platform: "darwin",
      dependencies: { spawnProcess: spawnProcess as never, delay: async () => {} },
    });

    const enabling = controller.setEnabled(true);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.emit("spawn");
    expect((await enabling).enabled).toBe(true);
    expect((await controller.setEnabled(true)).enabled).toBe(true);
    expect(spawnProcess).toHaveBeenCalledTimes(1);

    expect((await controller.setEnabled(false)).enabled).toBe(false);
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  test("does not report enabled when the helper fails to spawn", async () => {
    const child = createFakeChild();
    const controller = new KeepAwakeController({
      platform: "darwin",
      dependencies: { spawnProcess: (() => child) as never, delay: async () => {} },
    });

    const enabling = controller.setEnabled(true);
    await Promise.resolve();
    child.emit("error", new Error("spawn failed"));
    await expect(enabling).rejects.toThrow("spawn failed");
    expect(controller.status().enabled).toBe(false);
  });

  test("waits for Windows to confirm the execution state is active", async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const controller = new KeepAwakeController({
      platform: "win32",
      env: { Path: "", PATHEXT: ".EXE" },
      dependencies: { spawnProcess: spawnProcess as never },
    });

    const enabling = controller.setEnabled(true);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    expect(controller.status().enabled).toBe(false);
    child.stdout.write("NIUBOT_KEEP_AWAKE_READY\n");

    expect((await enabling).enabled).toBe(true);
  });

  test("rejects when the Windows helper exits before confirming readiness", async () => {
    const child = createFakeChild();
    const controller = new KeepAwakeController({
      platform: "win32",
      env: { Path: "", PATHEXT: ".EXE" },
      dependencies: { spawnProcess: (() => child) as never },
    });

    const enabling = controller.setEnabled(true);
    await Promise.resolve();
    child.stderr.write("native call failed");
    child.exitCode = 1;
    child.emit("exit", 1, null);

    await expect(enabling).rejects.toThrow("native call failed");
    expect(controller.status().enabled).toBe(false);
  });

  test("keeps the process reference when stopping fails and can retry", async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const controller = new KeepAwakeController({
      platform: "darwin",
      dependencies: { spawnProcess: spawnProcess as never, delay: async () => {} },
    });

    const enabling = controller.setEnabled(true);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.emit("spawn");
    await enabling;
    child.kill.mockReturnValueOnce(false);

    await expect(controller.setEnabled(false)).rejects.toThrow("无法停止防休眠辅助进程");
    expect(controller.status().enabled).toBe(true);
    expect((await controller.setEnabled(false)).enabled).toBe(false);
  });

  test("runs a queued request after the previous request fails", async () => {
    const first = createFakeChild();
    const second = createFakeChild();
    const spawnProcess = vi.fn()
      .mockReturnValueOnce(first as never)
      .mockReturnValueOnce(second as never);
    const controller = new KeepAwakeController({
      platform: "darwin",
      dependencies: { spawnProcess: spawnProcess as never, delay: async () => {} },
    });

    const failed = controller.setEnabled(true);
    const retried = controller.setEnabled(true);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(1));
    first.emit("error", new Error("first spawn failed"));
    await expect(failed).rejects.toThrow("first spawn failed");
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledTimes(2));
    second.emit("spawn");

    expect((await retried).enabled).toBe(true);
    await controller.setEnabled(false);
  });

  test("does not lose a helper reference after startup and cleanup both fail", async () => {
    const child = createFakeChild();
    const spawnProcess = vi.fn(() => child as never);
    const controller = new KeepAwakeController({
      platform: "win32",
      env: { Path: "", PATHEXT: ".EXE" },
      dependencies: { spawnProcess: spawnProcess as never },
    });
    child.kill.mockReturnValueOnce(false);

    const enabling = controller.setEnabled(true);
    await vi.waitFor(() => expect(spawnProcess).toHaveBeenCalledOnce());
    child.emit("error", new Error("PowerShell startup failed"));
    await expect(enabling).rejects.toThrow("辅助进程未能停止");

    await expect(controller.setEnabled(true)).rejects.toThrow("需先执行 /awake off");
    expect(spawnProcess).toHaveBeenCalledOnce();
    expect((await controller.setEnabled(false)).enabled).toBe(false);
  });
});

function createFakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = 123;
  child.exitCode = null;
  child.signalCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    child.emit("exit", 0, null);
    return true;
  });
  return child;
}
