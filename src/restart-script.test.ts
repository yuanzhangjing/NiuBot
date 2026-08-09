import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("restart.sh compatibility entry", () => {
  const readScript = () => readFileSync(path.resolve(__dirname, "../restart.sh"), "utf-8");

  test("delegates to the Node restart implementation", () => {
    const script = readScript();
    expect(script).toContain("dist/restart-compat.js");
    expect(script).not.toContain("pkill");
    expect(script).not.toContain("npm install");
    expect(script).not.toContain("nohup");
  });

  test("the Engine lifecycle service calls the Node launcher directly", () => {
    const pipeline = readFileSync(path.resolve(__dirname, "core/pipeline.ts"), "utf-8");
    const lifecycle = readFileSync(path.resolve(__dirname, "engine-lifecycle.ts"), "utf-8");
    expect(lifecycle).toContain("launchRestartWorker");
    expect(pipeline).not.toContain("launchRestartWorker");
    expect(pipeline).not.toContain('spawn("bash"');
    expect(lifecycle).not.toContain('spawn("bash"');
  });
});
