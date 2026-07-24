export const MINIMUM_NODE_MAJOR = 20;
export const WINDOWS_TESTED_NODE_MAJORS = [20, 22, 24] as const;

export function isSupportedNodeMajor(
  major: number,
  platform: NodeJS.Platform = process.platform,
): boolean {
  if (!Number.isInteger(major) || major < MINIMUM_NODE_MAJOR) return false;
  if (platform !== "win32") return true;
  return WINDOWS_TESTED_NODE_MAJORS.some((supported) => supported === major);
}

export function assertSupportedNodeRuntime(
  version = process.versions.node,
  platform: NodeJS.Platform = process.platform,
): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (isSupportedNodeMajor(major, platform)) return;
  if (platform === "win32") {
    throw new Error(
      `Unsupported Node.js v${version} on Windows. Use Node.js ${WINDOWS_TESTED_NODE_MAJORS.join(", ")} `
      + "and install NiuBot with that Node installation's npm.",
    );
  }
  throw new Error(
    `Unsupported Node.js v${version}. Use Node.js ${MINIMUM_NODE_MAJOR} or newer `
    + "and reinstall NiuBot with that Node installation's npm.",
  );
}
