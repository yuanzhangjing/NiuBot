import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";

describe("restart.sh", () => {
  const readScript = () => readFileSync(path.resolve(__dirname, "../restart.sh"), "utf-8");

  test("does not use pkill -f for fallback service cleanup", () => {
    const script = readScript();

    expect(script).not.toMatch(/\bpkill\b[^\n]*\s-f\s/);
  });

  test("scoped fallback cleanup to the current script directory", () => {
    const script = readScript();

    expect(script).toContain("SCRIPT_DIR_REAL=");
    expect(script).toContain("process_cwd");
    expect(script).toContain('[ "$cwd" = "$SCRIPT_DIR_REAL" ]');
  });

  test("uses release directories and last-known-good instead of dist.bak rollback", () => {
    const script = readScript();

    expect(script).toContain("RELEASES_DIR=");
    expect(script).toContain("CURRENT_LINK=");
    expect(script).toContain("PREVIOUS_LINK=");
    expect(script).toContain("LKG_LINK=");
    expect(script).toContain("last-known-good");
    expect(script).not.toContain("dist.bak");
  });

  test("updates last-known-good only after candidate health check passes", () => {
    const script = readScript();
    const healthSuccessIndex = script.indexOf("candidate health check passed");
    const lkgUpdateIndex = script.indexOf("last-known-good updated");

    expect(healthSuccessIndex).toBeGreaterThan(-1);
    expect(lkgUpdateIndex).toBeGreaterThan(healthSuccessIndex);
  });

  test("switches current release only after the old service is stopped", () => {
    const script = readScript();
    const stopIndex = script.indexOf('write_state "stop_old_service"');
    const switchIndex = script.indexOf("current release switched candidate=");

    expect(stopIndex).toBeGreaterThan(-1);
    expect(switchIndex).toBeGreaterThan(stopIndex);
  });

  test("records restart state and candidate pid for rollback diagnostics", () => {
    const script = readScript();

    expect(script).toContain("STATE_FILE=");
    expect(script).toContain("CANDIDATE_PID_FILE=");
    expect(script).toContain("write_state");
    expect(script).toContain('echo "$!" > "$CANDIDATE_PID_FILE"');
    expect(script).toContain('rm -f "$CANDIDATE_PID_FILE"');
  });

  test("prefers configured restart source directory over inherited source env", () => {
    const script = readScript();
    const configIndex = script.indexOf("CONFIG_SOURCE_DIR=");
    const sourceIndex = script.indexOf('SOURCE_DIR="${NIUBOT_SOURCE_DIR:-$SCRIPT_DIR}"');

    expect(script).toContain("resolve_config_source_dir");
    expect(script).toContain("restart.sourceDirectory");
    expect(configIndex).toBeGreaterThan(-1);
    expect(sourceIndex).toBeGreaterThan(configIndex);
  });

  test("builds npm updates as immutable releases without leaking update inputs", () => {
    const script = readScript();
    const modeIndex = script.indexOf('RESTART_MODE" = "npm-update"');
    const configIndex = script.indexOf('elif [ -n "$CONFIG_SOURCE_DIR" ]');
    const unsetIndex = script.indexOf("unset NIUBOT_RESTART_MODE NIUBOT_UPDATE_VERSION");
    const startIndex = script.indexOf("start_service() {");

    expect(modeIndex).toBeGreaterThan(-1);
    expect(configIndex).toBeGreaterThan(modeIndex);
    expect(unsetIndex).toBeGreaterThan(configIndex);
    expect(unsetIndex).toBeLessThan(startIndex);
    expect(script).toContain("build_npm_candidate_release");
    expect(script).toContain("pack_npm_update");
    expect(script).toContain("NPM_PACK_TIMEOUT=");
    expect(script).toContain("npm candidate pack timed out after ${NPM_PACK_TIMEOUT}s");
    expect(script).toContain('if [ "$RESTART_MODE" = "npm-update" ]; then');
    expect(script).toContain("DEFAULT_DEPENDENCY_INSTALL_TIMEOUT=600");
    expect(script).toContain('start_service "$candidate_package_dir" "npm-release"');
    expect(script).toContain('start_service "$rollback_package_dir" "$PREVIOUS_RUNTIME_MODE"');
    expect(script).toContain("npm candidate health check failed, rolling back");
    expect(script).toContain('PREVIOUS_RUNTIME_MODE="${NIUBOT_RUNTIME_MODE:-}"');
    expect(script).not.toContain("npm link");

    const startScript = readFileSync(path.resolve(__dirname, "../start.sh"), "utf-8");
    expect(startScript).not.toContain("npm link");

    const pipeline = readFileSync(path.resolve(__dirname, "core/pipeline.ts"), "utf-8");
    expect(pipeline).toContain('process.env["NIUBOT_RUNTIME_MODE"] === "npm-release"');
    expect(pipeline).toContain("opts?.updateVersion || useNpmRelease");
  });

  test("passes the current bot name to the detached restart script", () => {
    const pipeline = readFileSync(path.resolve(__dirname, "core/pipeline.ts"), "utf-8");

    expect(pipeline).toContain("NIUBOT_BOT_NAME: this.botIdentity.name");
  });

  test("bounds candidate dependency install and checks local proxy env first", () => {
    const script = readScript();
    const installIndex = script.indexOf("installing production dependencies for candidate");
    const timeoutIndex = script.indexOf("DEPENDENCY_INSTALL_TIMEOUT=");
    const proxyCheckIndex = script.indexOf("preflight_npm_proxy_environment");
    const installFunctionIndex = script.indexOf("install_candidate_dependencies");
    const installSetsidIndex = script.indexOf(
      'exec perl -e \'use POSIX "setsid"; setsid(); exec @ARGV\'',
      installFunctionIndex,
    );
    const redactBareAuthIndex = script.indexOf("s#^[^/@]+@#***@#");

    expect(timeoutIndex).toBeGreaterThan(-1);
    expect(proxyCheckIndex).toBeGreaterThan(-1);
    expect(installFunctionIndex).toBeGreaterThan(-1);
    expect(script).toContain("timed out after ${DEPENDENCY_INSTALL_TIMEOUT}s");
    expect(script).toContain("/dev/tcp/");
    expect(script).toContain("PROXY_CHECK_TIMEOUT=");
    expect(script).toContain("wait \"$install_pid\" 2>/dev/null || status=$?");
    expect(script).toContain("skipping local proxy check for IPv6 endpoint");
    expect(script).toContain("kill_process_tree");
    expect(script).not.toContain("kill -s \"$signal\" --");
    expect(installSetsidIndex).toBeGreaterThan(installFunctionIndex);
    expect(redactBareAuthIndex).toBeGreaterThan(-1);
    expect(proxyCheckIndex).toBeLessThan(installIndex);
    expect(installFunctionIndex).toBeLessThan(installIndex);
  });
});
