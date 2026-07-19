interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

/** Compare SemVer strings. Returns undefined when either value is not SemVer. */
export function comparePackageVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < a.core.length; index++) {
    if (a.core[index]! !== b.core[index]!) return a.core[index]! > b.core[index]! ? 1 : -1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < length; index++) {
    const leftPart = a.prerelease[index];
    const rightPart = b.prerelease[index];
    if (leftPart === undefined || rightPart === undefined) {
      return leftPart === rightPart ? 0 : leftPart === undefined ? -1 : 1;
    }
    if (leftPart === rightPart) continue;
    const leftNumber = /^[0-9]+$/.test(leftPart) ? Number(leftPart) : undefined;
    const rightNumber = /^[0-9]+$/.test(rightPart) ? Number(rightPart) : undefined;
    if (leftNumber !== undefined && rightNumber !== undefined) return leftNumber > rightNumber ? 1 : -1;
    if (leftNumber !== undefined || rightNumber !== undefined) return leftNumber !== undefined ? -1 : 1;
    return leftPart > rightPart ? 1 : -1;
  }
  return 0;
}

export function isNewerPackageVersion(candidate: string, current: string): boolean {
  const compared = comparePackageVersions(candidate, current);
  return compared === undefined ? candidate !== current : compared > 0;
}

function parseVersion(value: string): ParsedVersion | undefined {
  const match = value.match(/^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/);
  if (!match) return undefined;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => !part || (/^\d+$/.test(part) && part.length > 1 && part.startsWith("0")))) return undefined;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease,
  };
}
