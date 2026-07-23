export const SUPPORTED_NODE_MAJORS = [20, 22, 24] as const;

export function isSupportedNodeMajor(major: number): boolean {
  return SUPPORTED_NODE_MAJORS.some((supported) => supported === major);
}

export function assertSupportedNodeRuntime(version = process.versions.node): void {
  const major = Number.parseInt(version.split(".")[0] ?? "", 10);
  if (isSupportedNodeMajor(major)) return;
  throw new Error(
    `Unsupported Node.js v${version}. Use Node.js ${SUPPORTED_NODE_MAJORS.join(", ")} `
    + "and install NiuBot with that Node installation's npm.",
  );
}
