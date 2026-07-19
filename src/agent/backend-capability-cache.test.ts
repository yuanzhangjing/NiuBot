import { describe, expect, test, vi } from "vitest";
import type { BackendCapability } from "./backend-capability.js";
import { BackendCapabilityCache } from "./backend-capability-cache.js";

function capability(selectable: boolean, version?: string): BackendCapability {
  return {
    backend: "codex",
    platform: "darwin",
    support: "native",
    installed: selectable,
    selectable,
    version,
    reason: selectable ? undefined : "codex CLI not found",
  };
}

describe("BackendCapabilityCache", () => {
  test("refreshes installation state without restarting the process", async () => {
    const probeAll = vi.fn().mockResolvedValue([capability(true, "1.2.3")]);
    const cache = new BackendCapabilityCache(
      [capability(false)],
      probeAll,
      async () => capability(true, "1.2.3"),
    );

    expect(cache.availableBackends()).toEqual([]);
    await cache.refresh();

    expect(cache.availableBackends()).toEqual(["codex"]);
    expect(cache.get("codex")?.version).toBe("1.2.3");
  });

  test("shares one probe across concurrent refreshes", async () => {
    let resolveProbe!: (value: BackendCapability[]) => void;
    const probeAll = vi.fn(() => new Promise<BackendCapability[]>((resolve) => {
      resolveProbe = resolve;
    }));
    const cache = new BackendCapabilityCache([], probeAll, async () => undefined);

    const first = cache.refresh();
    const second = cache.refresh();
    expect(probeAll).toHaveBeenCalledTimes(1);

    resolveProbe([capability(true)]);
    await expect(Promise.all([first, second])).resolves.toEqual([
      [expect.objectContaining({ backend: "codex", selectable: true })],
      [expect.objectContaining({ backend: "codex", selectable: true })],
    ]);
  });

  test("allows retry after a failed refresh", async () => {
    const probeAll = vi.fn()
      .mockRejectedValueOnce(new Error("probe failed"))
      .mockResolvedValueOnce([capability(true)]);
    const cache = new BackendCapabilityCache([], probeAll, async () => undefined);

    await expect(cache.refresh()).rejects.toThrow("probe failed");
    await expect(cache.refresh()).resolves.toHaveLength(1);
    expect(probeAll).toHaveBeenCalledTimes(2);
  });

  test("rechecks and updates one backend before lazy startup", async () => {
    const probeOne = vi.fn().mockResolvedValue(capability(true, "2.0.0"));
    const cache = new BackendCapabilityCache(
      [capability(false)],
      async () => [],
      probeOne,
    );

    await expect(cache.recheck("codex")).resolves.toEqual(
      expect.objectContaining({ selectable: true, version: "2.0.0" }),
    );
    expect(cache.availableBackends()).toEqual(["codex"]);
  });
});
