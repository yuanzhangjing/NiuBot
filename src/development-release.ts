import fs from "node:fs";
import path from "node:path";
import { currentNodeRuntimeRef, type ReleaseRef } from "./release-ref.js";
import { SharedReleaseStore } from "./shared-release-store.js";
import { isProcessAlive, processStartMarkersMatch, queryProcessStartMarker } from "./platform/process.js";
import { comparePackageVersions, devVersionParts, isDevVersion, isProductionVersion } from "./version.js";

const RESERVATION_FILE = ".dev-version-reservation.json";
const RESERVATION_SCHEMA_VERSION = 1;

interface DevelopmentVersionReservationState {
  schemaVersion: typeof RESERVATION_SCHEMA_VERSION;
  baseVersion: string;
  version: string;
  pid: number;
  processStartMarker?: string;
  createdAt: string;
}

export interface DevelopmentVersionReservation {
  version: string;
  directory: string;
  release(): void;
}

export function reserveDevelopmentVersion(
  store: SharedReleaseStore,
  baseVersion: string,
): DevelopmentVersionReservation {
  if (!isProductionVersion(baseVersion)) throw new Error(`Development base version must be stable SemVer: ${baseVersion}`);
  const unlock = store.acquireLock();
  try {
    const published = readPublishedDevVersions(store);
    const latestCore = published
      .map((version) => devVersionParts(version)!.baseVersion)
      .sort((left, right) => comparePackageVersions(right, left) ?? 0)[0];
    if (latestCore && comparePackageVersions(baseVersion, latestCore) === -1) {
      throw new Error(`Refusing implicit development downgrade from ${latestCore} to ${baseVersion}`);
    }

    const reserved = readActiveReservations(store);
    const highest = [...published, ...reserved]
      .map(devVersionParts)
      .filter((item): item is NonNullable<ReturnType<typeof devVersionParts>> => item?.baseVersion === baseVersion)
      .reduce((maximum, item) => Math.max(maximum, item.sequence), 0);
    const version = `${baseVersion}-dev.${highest + 1}`;
    const directory = store.createStagingDirectory(`dev-version-${baseVersion}`);
    const state: DevelopmentVersionReservationState = {
      schemaVersion: RESERVATION_SCHEMA_VERSION,
      baseVersion,
      version,
      pid: process.pid,
      processStartMarker: queryProcessStartMarker(process.pid),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(directory, RESERVATION_FILE), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    let released = false;
    return {
      version,
      directory,
      release() {
        if (released) return;
        released = true;
        fs.rmSync(directory, { recursive: true, force: true });
      },
    };
  } finally {
    unlock();
  }
}

export function selectLatestDevelopmentRelease(store: SharedReleaseStore): {
  ref: ReleaseRef & { storage: "shared" };
  version: string;
  runtimePath: string;
} | undefined {
  let selected: { artifactId: string; version: string } | undefined;
  for (const entry of readDirectories(store.releasesDirectory)) {
    try {
      const manifest = store.assertUsableArtifact(entry.name);
      if (!isDevVersion(manifest.version) || manifest.nodeAbi !== process.versions.modules) continue;
      if (!selected || comparePackageVersions(manifest.version, selected.version) === 1) {
        selected = { artifactId: manifest.artifactId, version: manifest.version };
      }
    } catch {
      // Invalid and incompatible artifacts are not automatic candidates.
    }
  }
  if (!selected) return undefined;
  return {
    ref: { storage: "shared", artifactId: selected.artifactId, node: currentNodeRuntimeRef() },
    version: selected.version,
    runtimePath: store.packageDirectory(selected.artifactId),
  };
}

export function selectLatestProductionRelease(store: SharedReleaseStore): {
  ref: ReleaseRef & { storage: "shared" };
  version: string;
  runtimePath: string;
} | undefined {
  let selected: { artifactId: string; version: string } | undefined;
  for (const entry of readDirectories(store.releasesDirectory)) {
    try {
      const manifest = store.assertUsableArtifact(entry.name);
      if (!isProductionVersion(manifest.version)
        || manifest.sourceKind === "source"
        || manifest.nodeAbi !== process.versions.modules) continue;
      if (!selected || comparePackageVersions(manifest.version, selected.version) === 1) {
        selected = { artifactId: manifest.artifactId, version: manifest.version };
      }
    } catch {
      // Invalid, incompatible, and legacy stable-source artifacts are not recovery candidates.
    }
  }
  if (!selected) return undefined;
  return {
    ref: { storage: "shared", artifactId: selected.artifactId, node: currentNodeRuntimeRef() },
    version: selected.version,
    runtimePath: store.packageDirectory(selected.artifactId),
  };
}

function readPublishedDevVersions(store: SharedReleaseStore): string[] {
  const versions: string[] = [];
  for (const entry of readDirectories(store.releasesDirectory)) {
    try {
      const manifest = store.assertUsableArtifact(entry.name);
      if (isDevVersion(manifest.version)) versions.push(manifest.version);
    } catch {
      // An incomplete/corrupt directory cannot reserve a version number.
    }
  }
  return versions;
}

function readActiveReservations(store: SharedReleaseStore): string[] {
  const versions: string[] = [];
  for (const entry of readDirectories(store.stagingDirectory)) {
    const state = readReservation(path.join(entry.fullPath, RESERVATION_FILE));
    if (!state) continue;
    if (reservationOwnerIsActive(state)) {
      versions.push(state.version);
    } else {
      fs.rmSync(entry.fullPath, { recursive: true, force: true });
    }
  }
  return versions;
}

function reservationOwnerIsActive(state: DevelopmentVersionReservationState): boolean {
  if (!isProcessAlive(state.pid)) return false;
  if (!state.processStartMarker) return true;
  return processStartMarkersMatch(state.processStartMarker, queryProcessStartMarker(state.pid));
}

function readReservation(filePath: string): DevelopmentVersionReservationState | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
    if (value["schemaVersion"] !== RESERVATION_SCHEMA_VERSION
      || typeof value["baseVersion"] !== "string"
      || !isProductionVersion(value["baseVersion"])
      || typeof value["version"] !== "string"
      || !isDevVersion(value["version"])
      || devVersionParts(value["version"])?.baseVersion !== value["baseVersion"]
      || !Number.isSafeInteger(value["pid"])
      || Number(value["pid"]) <= 0
      || typeof value["createdAt"] !== "string") return undefined;
    return value as unknown as DevelopmentVersionReservationState;
  } catch {
    return undefined;
  }
}

function readDirectories(directory: string): Array<{ name: string; fullPath: string }> {
  try {
    return fs.readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => ({ name: entry.name, fullPath: path.join(directory, entry.name) }));
  } catch {
    return [];
  }
}
