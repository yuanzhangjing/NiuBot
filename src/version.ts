interface ParsedVersion {
  core: [number, number, number];
  prerelease: string[];
}

export type RuntimeEnvironment = "dev" | "production";

const PRODUCTION_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const DEVELOPMENT_VERSION_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-dev\.([1-9]\d*)$/;

/** Stable release versions are the only production runtime channel. */
export function isProductionVersion(version: string): boolean {
  return PRODUCTION_VERSION_RE.test(version);
}

/** Local development artifacts use one exact, ordered SemVer form. */
export function isDevVersion(version: string): boolean {
  return DEVELOPMENT_VERSION_RE.test(version);
}

export function runtimeEnvironmentForVersion(version: string): RuntimeEnvironment | undefined {
  if (isProductionVersion(version)) return "production";
  if (isDevVersion(version)) return "dev";
  return undefined;
}

export function devVersionParts(version: string): { baseVersion: string; sequence: number } | undefined {
  const match = DEVELOPMENT_VERSION_RE.exec(version);
  if (!match) return undefined;
  return { baseVersion: `${match[1]}.${match[2]}.${match[3]}`, sequence: Number(match[4]) };
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

/** 当前版本是否为预发布版本（含 -dev/-alpha/-beta 等 prerelease 后缀）或无法识别的版本号。 */
export function isPrereleaseOrUnrecognizedVersion(version: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return true;
  return parsed.prerelease.length > 0;
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
