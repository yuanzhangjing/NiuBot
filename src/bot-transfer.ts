import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { c as createTar, t as listTar, x as extractTar } from "tar";
import yaml from "yaml";
import { DEFAULT_BOT_PROFILE } from "./bot-profile.js";
import { loadConfig, resolveHomePath } from "./config.js";
import { createRestartDatabaseSnapshot, cleanupRestartDatabaseSnapshot } from "./database/restart-snapshot.js";
import { LATEST_SCHEMA_VERSION } from "./database/schema.js";
import { replaceFileSync, samePlatformPath } from "./platform/files.js";
import { isProcessAlive } from "./platform/process.js";
import { inspectRunningEngine } from "./process-manager.js";
import { readProcessState } from "./process-state.js";
import { acquireProcessLock } from "./process-lock.js";

const BUNDLE_SCHEMA_VERSION = 1;
const BUNDLE_KIND = "niubot-bot-export";
const BUNDLE_FILES = ["manifest.json", "bot.yaml", "niubot.db", "bot_profile.md"] as const;
const BUNDLE_FILE_SET = new Set<string>(BUNDLE_FILES);
const MAX_METADATA_SIZE = 1024 * 1024;
const MAX_DATABASE_SIZE = 16 * 1024 * 1024 * 1024;

type BundleFile = (typeof BUNDLE_FILES)[number];
type RawBot = Record<string, unknown>;

interface BotBundleManifest {
  schemaVersion: typeof BUNDLE_SCHEMA_VERSION;
  kind: typeof BUNDLE_KIND;
  botId: string;
  createdAt: string;
  sourceVersion: string;
  databaseSchemaVersion: number;
  includesSecrets: boolean;
  files: Record<Exclude<BundleFile, "manifest.json">, string>;
}

interface RawHomeConfig {
  configPath: string;
  value: Record<string, unknown>;
  bots: RawBot[];
}

export interface ExportBotOptions {
  home: string;
  botId: string;
  outputPath: string;
  includeSecrets?: boolean;
  sourceVersion: string;
  preserveWorkingDirectory?: boolean;
}

export interface ImportBotOptions {
  home: string;
  bundlePath: string;
  appId?: string;
  appSecret?: string;
  workingDirectory?: string;
}

interface InternalImportBotOptions extends ImportBotOptions {
  preserveDeviceLocalState?: boolean;
}

export interface ImportBotResult {
  botId: string;
  databasePath: string;
  profilePath: string;
}

export interface ImportBotRollback {
  home: string;
  botId: string;
  originalConfig: Buffer;
}

export interface MoveBotOptions {
  sourceHome: string;
  targetHome: string;
  botId: string;
  apply?: boolean;
  sourceVersion: string;
  transactionId?: string;
  activeLifecycleId?: string;
}

export interface MoveBotResult {
  botId: string;
  applied: boolean;
  sourceHome: string;
  targetHome: string;
  recoveryDirectory?: string;
}

export async function exportBotBundle(options: ExportBotOptions): Promise<void> {
  const home = path.resolve(options.home);
  const outputPath = path.resolve(options.outputPath);
  assertSafeBotId(options.botId);
  if (fs.existsSync(outputPath)) throw new Error(`output already exists: ${outputPath}`);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const rawConfig = readRawHomeConfig(home);
  const rawBot = findRawBot(rawConfig.bots, options.botId);
  const parsedBot = loadConfig(rawConfig.configPath).bots.find((bot) => sameBotId(bot.id, options.botId));
  if (!parsedBot) throw new Error(`bot '${options.botId}' was not found in ${rawConfig.configPath}`);
  if (!fs.existsSync(parsedBot.dbPath)) throw new Error(`bot database does not exist: ${parsedBot.dbPath}`);

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-bot-export-"));
  fs.chmodSync(temporaryRoot, 0o700);
  const bundleRoot = path.join(temporaryRoot, "bundle");
  fs.mkdirSync(bundleRoot, { mode: 0o700 });
  let snapshot: Awaited<ReturnType<typeof createRestartDatabaseSnapshot>> | undefined;
  const temporaryArchive = path.join(path.dirname(outputPath), `.${path.basename(outputPath)}.${randomUUID()}.tmp`);
  try {
    snapshot = await createRestartDatabaseSnapshot({
      rootDirectory: path.join(temporaryRoot, "snapshot"),
      databasePaths: [parsedBot.dbPath],
    });
    const databaseSnapshot = snapshot.records[0]?.rollbackPath;
    if (!databaseSnapshot) throw new Error(`bot database snapshot was not created: ${parsedBot.dbPath}`);

    const portableBot = makePortableBot(rawBot, options.includeSecrets === true, options.preserveWorkingDirectory === true);
    writePrivateFile(path.join(bundleRoot, "bot.yaml"), yaml.stringify(portableBot));
    fs.copyFileSync(databaseSnapshot, path.join(bundleRoot, "niubot.db"), fs.constants.COPYFILE_EXCL);
    fs.chmodSync(path.join(bundleRoot, "niubot.db"), 0o600);
    const profile = parsedBot.botProfilePath && fs.existsSync(parsedBot.botProfilePath)
      ? fs.readFileSync(parsedBot.botProfilePath)
      : Buffer.from(DEFAULT_BOT_PROFILE, "utf-8");
    writePrivateFile(path.join(bundleRoot, "bot_profile.md"), profile);

    const databaseSchemaVersion = readAndValidateDatabase(path.join(bundleRoot, "niubot.db"));
    const manifest: BotBundleManifest = {
      schemaVersion: BUNDLE_SCHEMA_VERSION,
      kind: BUNDLE_KIND,
      botId: options.botId,
      createdAt: new Date().toISOString(),
      sourceVersion: options.sourceVersion,
      databaseSchemaVersion,
      includesSecrets: options.includeSecrets === true,
      files: {
        "bot.yaml": hashFile(path.join(bundleRoot, "bot.yaml")),
        "niubot.db": hashFile(path.join(bundleRoot, "niubot.db")),
        "bot_profile.md": hashFile(path.join(bundleRoot, "bot_profile.md")),
      },
    };
    writePrivateFile(path.join(bundleRoot, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    await createTar({ cwd: bundleRoot, file: temporaryArchive, gzip: true, portable: true }, [...BUNDLE_FILES]);
    fs.chmodSync(temporaryArchive, 0o600);
    fs.linkSync(temporaryArchive, outputPath);
    fs.unlinkSync(temporaryArchive);
  } finally {
    if (snapshot) cleanupRestartDatabaseSnapshot(snapshot);
    try { fs.rmSync(temporaryArchive, { force: true }); } catch { /* best effort */ }
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

export async function importBotBundle(options: ImportBotOptions): Promise<ImportBotResult> {
  return withHomeTransferLocks([options.home], async () => {
    const home = path.resolve(options.home);
    await assertHomeStopped(home, "target");
    recoverImportTransactions(home);
    return importBotBundleUnlocked(options);
  });
}

export async function preflightImportBotBundle(options: ImportBotOptions): Promise<{ botId: string }> {
  const home = path.resolve(options.home);
  const extracted = await extractAndValidateBundle(path.resolve(options.bundlePath));
  try {
    const rawConfig = readRawHomeConfig(home);
    assertNoBotCollision(rawConfig, home, extracted.manifest.botId);
    const importedBot = prepareImportedBot(extracted.bot, extracted.manifest, options);
    validateCandidateConfig(rawConfig, [...rawConfig.bots, importedBot]);
    return { botId: extracted.manifest.botId };
  } finally {
    fs.rmSync(extracted.root, { recursive: true, force: true });
  }
}

async function importBotBundleUnlocked(options: InternalImportBotOptions): Promise<ImportBotResult> {
  const home = path.resolve(options.home);
  const extracted = await extractAndValidateBundle(path.resolve(options.bundlePath));
  try {
    const rawConfig = readRawHomeConfig(home);
    assertNoBotCollision(rawConfig, home, extracted.manifest.botId);
    const importedBot = prepareImportedBot(extracted.bot, extracted.manifest, options);
    validateCandidateConfig(rawConfig, [...rawConfig.bots, importedBot]);
    const botDirectory = path.join(home, extracted.manifest.botId);
    const stagingRoot = path.join(home, ".bot-transfer-staging");
    ensurePrivateInternalDirectory(stagingRoot);
    const stagedBotDirectory = path.join(stagingRoot, `${extracted.manifest.botId}-${randomUUID()}`);
    fs.mkdirSync(stagedBotDirectory, { mode: 0o700 });
    let published = false;
    let transactionDirectory: string | undefined;
    try {
      const targetDatabase = path.join(stagedBotDirectory, "niubot.db");
      const targetProfile = path.join(stagedBotDirectory, "bot_profile.md");
      fs.copyFileSync(path.join(extracted.root, "niubot.db"), targetDatabase, fs.constants.COPYFILE_EXCL);
      fs.copyFileSync(path.join(extracted.root, "bot_profile.md"), targetProfile, fs.constants.COPYFILE_EXCL);
      fs.chmodSync(targetDatabase, 0o600);
      fs.chmodSync(targetProfile, 0o600);
      if (!options.preserveDeviceLocalState) clearDeviceLocalDatabaseState(targetDatabase);
      transactionDirectory = createImportTransaction(home, rawConfig, extracted.manifest.botId, botDirectory);
      fs.renameSync(stagedBotDirectory, botDirectory);
      published = true;
      updateTransactionPhase(transactionDirectory, "data-published");
      writeHomeConfig(rawConfig, [...rawConfig.bots, importedBot]);
      updateTransactionPhase(transactionDirectory, "config-written");
      fs.rmSync(transactionDirectory, { recursive: true, force: true });
      removeDirectoryIfEmpty(path.dirname(transactionDirectory));
      return {
        botId: extracted.manifest.botId,
        databasePath: path.join(botDirectory, "niubot.db"),
        profilePath: path.join(botDirectory, "bot_profile.md"),
      };
    } catch (err) {
      const rollbackErrors: Error[] = [];
      if (published) attemptRollback("remove imported Bot data", () => fs.rmSync(botDirectory, { recursive: true, force: true }), rollbackErrors);
      if (transactionDirectory) attemptRollback("restore target config", () => restoreConfigBytes(
          rawConfig.configPath,
          fs.readFileSync(path.join(transactionDirectory!, "config.original")),
        ), rollbackErrors);
      if (transactionDirectory && rollbackErrors.length === 0) {
        fs.rmSync(transactionDirectory, { recursive: true, force: true });
        removeDirectoryIfEmpty(path.dirname(transactionDirectory));
      }
      throwWithRollbackErrors(err, rollbackErrors);
    } finally {
      fs.rmSync(stagedBotDirectory, { recursive: true, force: true });
      removeDirectoryIfEmpty(stagingRoot);
    }
  } finally {
    fs.rmSync(extracted.root, { recursive: true, force: true });
  }
}

export async function moveBot(options: MoveBotOptions): Promise<MoveBotResult> {
  return withHomeTransferLocks([options.sourceHome, options.targetHome], () => moveBotLocked(options));
}

async function moveBotLocked(options: MoveBotOptions): Promise<MoveBotResult> {
  const sourceHome = path.resolve(options.sourceHome);
  const targetHome = path.resolve(options.targetHome);
  assertSafeBotId(options.botId);
  if (samePlatformPath(sourceHome, targetHome)) throw new Error("source and target home must be different");
  assertSameDevice(sourceHome, targetHome);
  if (options.apply) {
    await assertHomeStopped(sourceHome, "source");
    await assertHomeStopped(targetHome, "target");
    recoverImportTransactions(sourceHome);
    recoverImportTransactions(targetHome);
    if (recoverMoveTransactions(sourceHome, targetHome) > 0) {
      throw new Error("an interrupted Bot move was recovered; review both homes, then run the command again");
    }
  } else {
    assertNoPendingBotTransfer(sourceHome, options.activeLifecycleId);
    assertNoPendingBotTransfer(targetHome, options.activeLifecycleId);
  }

  const sourceConfig = readRawHomeConfig(sourceHome);
  findRawBot(sourceConfig.bots, options.botId);
  const parsedSourceBot = loadConfig(sourceConfig.configPath).bots.find((bot) => sameBotId(bot.id, options.botId));
  if (!parsedSourceBot) throw new Error(`bot '${options.botId}' was not found in ${sourceConfig.configPath}`);
  const expectedSourceDirectory = path.join(sourceHome, options.botId);
  assertRealDirectory(expectedSourceDirectory, "source Bot directory");
  if (!samePlatformPath(parsedSourceBot.dbPath, path.join(expectedSourceDirectory, "niubot.db"))
    || !parsedSourceBot.botProfilePath
    || !samePlatformPath(parsedSourceBot.botProfilePath, path.join(expectedSourceDirectory, "bot_profile.md"))) {
    throw new Error("move only supports the standard database and bot profile paths inside the source home");
  }
  if (!fs.existsSync(parsedSourceBot.dbPath)) throw new Error(`bot database does not exist: ${parsedSourceBot.dbPath}`);
  assertNoBotCollision(readRawHomeConfig(targetHome), targetHome, options.botId);

  if (!options.apply) {
    return { botId: options.botId, applied: false, sourceHome, targetHome };
  }

  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-bot-move-"));
  const bundlePath = path.join(temporaryRoot, `${options.botId}.nbot`);
  const sourceConfigBytes = fs.readFileSync(sourceConfig.configPath);
  const targetConfig = readRawHomeConfig(targetHome);
  const targetConfigBytes = fs.readFileSync(targetConfig.configPath);
  const targetBotDirectory = path.join(targetHome, options.botId);
  const transactionId = options.transactionId ?? `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`;
  const transactionDirectory = path.join(sourceHome, ".bot-move-trash", transactionId);
  const recoveryDirectory = path.join(transactionDirectory, options.botId);
  const movedSourceFiles: Array<{ source: string; recovery: string }> = [];
  let imported = false;
  let sourceConfigChanged = false;
  try {
    await exportBotBundle({
      home: sourceHome,
      botId: options.botId,
      outputPath: bundlePath,
      includeSecrets: true,
      sourceVersion: options.sourceVersion,
      preserveWorkingDirectory: true,
    });
    createMoveTransaction(transactionDirectory, {
      botId: options.botId,
      sourceHome,
      targetHome,
      sourceConfigPath: sourceConfig.configPath,
      targetConfigPath: targetConfig.configPath,
      sourceConfigBytes,
      targetConfigBytes,
    });
    writeHomeConfig(sourceConfig, sourceConfig.bots.filter((bot) => rawBotId(bot) !== options.botId));
    sourceConfigChanged = true;
    updateTransactionPhase(transactionDirectory, "source-detached");

    await importBotBundleUnlocked({
      home: targetHome,
      bundlePath,
      preserveDeviceLocalState: true,
    });
    imported = true;
    updateTransactionPhase(transactionDirectory, "target-imported");

    ensurePrivateInternalDirectory(recoveryDirectory);
    for (const source of [parsedSourceBot.dbPath, parsedSourceBot.botProfilePath]) {
      if (!fs.existsSync(source)) continue;
      const recovery = path.join(recoveryDirectory, path.basename(source));
      fs.renameSync(source, recovery);
      movedSourceFiles.push({ source, recovery });
    }
    removeDirectoryIfEmpty(expectedSourceDirectory);
    writeJsonReplacing(path.join(transactionDirectory, "manifest.json"), {
      schemaVersion: 1,
      kind: "move",
      phase: "complete",
      botId: options.botId,
      movedAt: new Date().toISOString(),
      sourceHome,
      targetHome,
    });
    return { botId: options.botId, applied: true, sourceHome, targetHome, recoveryDirectory };
  } catch (err) {
    const rollbackErrors: Error[] = [];
    for (const item of [...movedSourceFiles].reverse()) attemptRollback(`restore ${item.source}`, () => {
      fs.mkdirSync(path.dirname(item.source), { recursive: true, mode: 0o700 });
      if (fs.existsSync(item.recovery) && !fs.existsSync(item.source)) fs.renameSync(item.recovery, item.source);
    }, rollbackErrors);
    if (imported) {
      attemptRollback("restore target config", () => restoreConfigBytes(targetConfig.configPath, targetConfigBytes), rollbackErrors);
      attemptRollback("remove target Bot data", () => fs.rmSync(targetBotDirectory, { recursive: true, force: true }), rollbackErrors);
    }
    if (sourceConfigChanged) {
      attemptRollback("restore source config", () => restoreConfigBytes(sourceConfig.configPath, sourceConfigBytes), rollbackErrors);
    }
    if (rollbackErrors.length === 0) fs.rmSync(transactionDirectory, { recursive: true, force: true });
    throwWithRollbackErrors(err, rollbackErrors);
  } finally {
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

/** Undo a completed import after the imported Engine failed its startup checks. */
export async function rollbackImportedBot(rollback: ImportBotRollback): Promise<void> {
  const home = path.resolve(rollback.home);
  assertSafeBotId(rollback.botId);
  await withHomeTransferLocks([home], async () => {
    await assertHomeStopped(home, "target");
    const config = readRawHomeConfig(home);
    const botDirectory = path.join(home, rollback.botId);
    if (!config.bots.some((bot) => sameBotId(rawBotId(bot), rollback.botId))) {
      throw new Error(`cannot rollback import: target config does not contain bot '${rollback.botId}'`);
    }
    restoreConfigBytes(config.configPath, rollback.originalConfig);
    fs.rmSync(botDirectory, { recursive: true, force: true });
  });
}

/** Undo a completed move after either Engine failed its startup checks. */
export async function rollbackCompletedMove(result: MoveBotResult): Promise<void> {
  if (!result.applied || !result.recoveryDirectory) throw new Error("cannot rollback a move that was not applied");
  const recoveryDirectory = path.resolve(result.recoveryDirectory);
  const sourceHome = path.resolve(result.sourceHome);
  const targetHome = path.resolve(result.targetHome);
  const transactionDirectory = path.dirname(recoveryDirectory);
  await withHomeTransferLocks([sourceHome, targetHome], async () => {
    await assertHomeStopped(sourceHome, "source");
    await assertHomeStopped(targetHome, "target");
    const manifest = readTransactionManifest(transactionDirectory, "move");
    if (manifest["phase"] !== "complete"
      || !samePlatformPath(requiredManifestString(manifest, "sourceHome"), sourceHome)
      || !samePlatformPath(requiredManifestString(manifest, "targetHome"), targetHome)
      || requiredManifestString(manifest, "botId") !== result.botId) {
      throw new Error(`move recovery record does not match the completed move: ${transactionDirectory}`);
    }
    const sourceConfigPath = path.join(sourceHome, "config.yaml");
    const targetConfigPath = path.join(targetHome, "config.yaml");
    const sourceConfigOriginal = path.join(transactionDirectory, "source-config.original");
    const targetConfigOriginal = path.join(transactionDirectory, "target-config.original");
    const targetBotDirectory = path.join(targetHome, result.botId);
    const targetDatabase = path.join(targetBotDirectory, "niubot.db");
    const targetDatabaseSnapshot = path.join(transactionDirectory, `.target-latest-${randomUUID()}.db`);
    let targetDatabaseUsable = false;
    try {
      if (fs.existsSync(targetDatabase)) {
        const database = new Database(targetDatabase, { readonly: true, fileMustExist: true });
        try { await database.backup(targetDatabaseSnapshot); } finally { database.close(); }
        fs.chmodSync(targetDatabaseSnapshot, 0o600);
        readAndValidateDatabase(targetDatabaseSnapshot);
        targetDatabaseUsable = true;
      }
    } catch {
      fs.rmSync(targetDatabaseSnapshot, { force: true });
      /* fall back to the pre-move recovery copy */
    }
    for (const required of [sourceConfigOriginal, targetConfigOriginal]) {
      if (!fs.existsSync(required) || !fs.statSync(required).isFile()) {
        throw new Error(`move recovery record is incomplete: ${required}`);
      }
    }
    for (const name of ["niubot.db", "bot_profile.md"]) {
      const recovery = path.join(recoveryDirectory, name);
      const target = path.join(targetBotDirectory, name);
      const source = path.join(sourceHome, result.botId, name);
      if ((fs.existsSync(recovery) || fs.existsSync(target)) && fs.existsSync(source)) {
        throw new Error(`cannot rollback move: source file already exists: ${source}`);
      }
      if (name === "niubot.db" && !targetDatabaseUsable
        && (!fs.existsSync(recovery) || !fs.statSync(recovery).isFile())) {
        throw new Error(`move recovery record is incomplete: ${recovery}`);
      }
    }
    restoreConfigBytes(targetConfigPath, fs.readFileSync(targetConfigOriginal));
    for (const name of ["niubot.db", "bot_profile.md"]) {
      const recovery = path.join(recoveryDirectory, name);
      const source = path.join(sourceHome, result.botId, name);
      const target = path.join(targetBotDirectory, name);
      const preferred = name === "niubot.db" && targetDatabaseUsable
        ? targetDatabaseSnapshot
        : fs.existsSync(target) ? target : recovery;
      if (!fs.existsSync(preferred)) continue;
      fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
      fs.renameSync(preferred, source);
    }
    fs.rmSync(targetBotDirectory, { recursive: true, force: true });
    restoreConfigBytes(sourceConfigPath, fs.readFileSync(sourceConfigOriginal));
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
    removeDirectoryIfEmpty(path.dirname(transactionDirectory));
  });
}

export async function recoverInterruptedImports(homePath: string): Promise<void> {
  const home = path.resolve(homePath);
  await withHomeTransferLocks([home], async () => {
    await assertHomeStopped(home, "target");
    recoverImportTransactions(home);
  });
}

export async function recoverInterruptedMove(
  sourceHomePath: string,
  targetHomePath: string,
  transactionId: string,
  botId: string,
): Promise<MoveBotResult | undefined> {
  const sourceHome = path.resolve(sourceHomePath);
  const targetHome = path.resolve(targetHomePath);
  const transactionDirectory = path.join(sourceHome, ".bot-move-trash", transactionId);
  await withHomeTransferLocks([sourceHome, targetHome], async () => {
    await assertHomeStopped(sourceHome, "source");
    await assertHomeStopped(targetHome, "target");
    recoverImportTransactions(sourceHome);
    recoverImportTransactions(targetHome);
    recoverMoveTransactions(sourceHome, targetHome);
  });
  if (!fs.existsSync(transactionDirectory)) return undefined;
  const manifest = readTransactionManifest(transactionDirectory, "move");
  if (manifest["phase"] !== "complete") {
    throw new Error(`move transaction recovery did not reach a terminal state: ${transactionDirectory}`);
  }
  return {
    botId,
    applied: true,
    sourceHome,
    targetHome,
    recoveryDirectory: path.join(transactionDirectory, botId),
  };
}

async function extractAndValidateBundle(bundlePath: string): Promise<{
  root: string;
  manifest: BotBundleManifest;
  bot: RawBot;
}> {
  if (!fs.statSync(bundlePath).isFile()) throw new Error(`bundle is not a regular file: ${bundlePath}`);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-bot-import-"));
  const privateArchive = path.join(root, ".input.nbot");
  const entries = new Set<string>();
  let archiveError: Error | undefined;
  const extractedEntries = new Set<string>();
  let extractionError: Error | undefined;
  try {
    fs.chmodSync(root, 0o700);
    fs.copyFileSync(bundlePath, privateArchive, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(privateArchive, 0o600);
    await listTar({
      file: privateArchive,
      strict: true,
      onReadEntry(entry) {
        try {
          const name = normalizeArchivePath(entry.path);
          assertBundleEntry(name, entry.type, entry.size, entries);
          entries.add(name);
        } catch (err) {
          archiveError ??= asError(err);
        }
        entry.resume();
      },
    });
    if (archiveError) throw archiveError;
    const missing = BUNDLE_FILES.filter((name) => !entries.has(name));
    if (missing.length > 0) throw new Error(`bundle is incomplete: missing ${missing.join(", ")}`);
    await extractTar({
      cwd: root,
      file: privateArchive,
      strict: true,
      preservePaths: false,
      filter(entryPath) {
        try {
          const name = normalizeArchivePath(entryPath);
          if (!BUNDLE_FILE_SET.has(name)) throw new Error(`bundle contains unexpected entry: ${name}`);
          return true;
        } catch (err) {
          extractionError ??= asError(err);
          return false;
        }
      },
      onReadEntry(entry) {
        try {
          const name = normalizeArchivePath(entry.path);
          assertBundleEntry(name, entry.type, entry.size, extractedEntries);
          extractedEntries.add(name);
        } catch (err) {
          extractionError ??= asError(err);
        }
      },
    });
    if (extractionError) throw extractionError;
    for (const name of BUNDLE_FILES) {
      const file = path.join(root, name);
      if (!fs.statSync(file).isFile()) throw new Error(`bundle entry is not a regular file: ${name}`);
    }
    const manifest = parseManifest(path.join(root, "manifest.json"));
    for (const name of ["bot.yaml", "niubot.db", "bot_profile.md"] as const) {
      if (hashFile(path.join(root, name)) !== manifest.files[name]) throw new Error(`bundle checksum mismatch: ${name}`);
    }
    const bot = yaml.parse(fs.readFileSync(path.join(root, "bot.yaml"), "utf-8")) as unknown;
    if (!bot || typeof bot !== "object" || Array.isArray(bot)) throw new Error("bot.yaml must contain one bot mapping");
    if (rawBotId(bot as RawBot) !== manifest.botId) throw new Error("bot ID differs between manifest.json and bot.yaml");
    const hasAppId = typeof (bot as RawBot)["appId"] === "string";
    const hasAppSecret = typeof (bot as RawBot)["appSecret"] === "string";
    if (hasAppId !== manifest.includesSecrets || hasAppSecret !== manifest.includesSecrets) {
      throw new Error("credential fields differ from manifest.json");
    }
    const observedSchema = readAndValidateDatabase(path.join(root, "niubot.db"));
    if (observedSchema !== manifest.databaseSchemaVersion) throw new Error("database schema differs from manifest.json");
    return { root, manifest, bot: bot as RawBot };
  } catch (err) {
    fs.rmSync(root, { recursive: true, force: true });
    throw err;
  }
}

function parseManifest(manifestPath: string): BotBundleManifest {
  const value = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Partial<BotBundleManifest>;
  if (value.schemaVersion !== BUNDLE_SCHEMA_VERSION || value.kind !== BUNDLE_KIND) {
    throw new Error("unsupported Bot bundle format");
  }
  if (typeof value.botId !== "string") throw new Error("manifest.json is missing botId");
  assertSafeBotId(value.botId);
  if (typeof value.createdAt !== "string" || typeof value.sourceVersion !== "string"
    || typeof value.databaseSchemaVersion !== "number" || typeof value.includesSecrets !== "boolean") {
    throw new Error("manifest.json has invalid metadata");
  }
  for (const name of ["bot.yaml", "niubot.db", "bot_profile.md"] as const) {
    if (!value.files || typeof value.files[name] !== "string" || !/^[0-9a-f]{64}$/.test(value.files[name])) {
      throw new Error(`manifest.json has invalid checksum for ${name}`);
    }
  }
  return value as BotBundleManifest;
}

function assertBundleEntry(name: string, type: string, size: number, seen: Set<string>): void {
  if (!BUNDLE_FILE_SET.has(name)) throw new Error(`bundle contains unexpected entry: ${name}`);
  if (seen.has(name)) throw new Error(`bundle contains duplicate entry: ${name}`);
  if (type !== "File" && type !== "OldFile") throw new Error(`bundle entry must be a regular file: ${name}`);
  const limit = name === "niubot.db" ? MAX_DATABASE_SIZE : MAX_METADATA_SIZE;
  if (!Number.isSafeInteger(size) || size < 0 || size > limit) throw new Error(`bundle entry is too large: ${name}`);
}

function normalizeArchivePath(value: string): string {
  const normalized = value.replace(/^\.\//, "").replace(/\\/g, "/");
  if (normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`unsafe bundle entry path: ${value}`);
  }
  return normalized;
}

function readRawHomeConfig(home: string): RawHomeConfig {
  const yamlPath = path.join(home, "config.yaml");
  if (!fs.existsSync(yamlPath)) throw new Error(`config.yaml not found in home: ${home}`);
  const parsed = yaml.parse(fs.readFileSync(yamlPath, "utf-8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`invalid config: ${yamlPath}`);
  const value = parsed as Record<string, unknown>;
  if (!Array.isArray(value["bots"])) throw new Error("Bot transfer requires config.yaml with a bots array");
  const bots = value["bots"] as unknown[];
  if (bots.some((bot) => !bot || typeof bot !== "object" || Array.isArray(bot))) {
    throw new Error("config bots array contains an invalid entry");
  }
  return { configPath: yamlPath, value, bots: bots as RawBot[] };
}

function findRawBot(bots: RawBot[], botId: string): RawBot {
  const bot = bots.find((candidate) => sameBotId(rawBotId(candidate), botId));
  if (!bot) throw new Error(`bot '${botId}' was not found`);
  return bot;
}

function rawBotId(bot: RawBot): string | undefined {
  const id = bot["id"] ?? bot["name"];
  return typeof id === "string" ? id : undefined;
}

function makePortableBot(rawBot: RawBot, includeSecrets: boolean, includeWorkingDirectory = true): RawBot {
  const portable: RawBot = { id: rawBotId(rawBot) };
  const fields = includeWorkingDirectory ? ["backend", "model", "workingDirectory"] : ["backend", "model"];
  for (const key of fields) {
    if (typeof rawBot[key] === "string") portable[key] = rawBot[key];
  }
  if (includeSecrets) {
    if (typeof rawBot["appId"] === "string") portable["appId"] = rawBot["appId"];
    if (typeof rawBot["appSecret"] === "string") portable["appSecret"] = rawBot["appSecret"];
  }
  return portable;
}

function prepareImportedBot(rawBot: RawBot, manifest: BotBundleManifest, options: InternalImportBotOptions): RawBot {
  const bot = makePortableBot(rawBot, true);
  const bundledAppId = stringField(bot, "appId");
  const bundledAppSecret = stringField(bot, "appSecret");
  const appId = options.appId ?? bundledAppId;
  const appSecret = options.appSecret ?? bundledAppSecret;
  if (!appId || !appSecret) {
    throw new Error("bundle does not contain credentials; provide both --app-id and --app-secret-file");
  }
  if ((options.appId && !options.appSecret) || (!options.appId && options.appSecret)) {
    throw new Error("--app-id and the app secret must be provided together");
  }
  bot["id"] = manifest.botId;
  bot["appId"] = appId;
  bot["appSecret"] = appSecret;
  if (options.workingDirectory) bot["workingDirectory"] = resolveHomePath(options.workingDirectory);
  else if (!options.preserveDeviceLocalState) delete bot["workingDirectory"];
  return bot;
}

function stringField(value: RawBot, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field.length > 0 ? field : undefined;
}

function assertNoBotCollision(config: RawHomeConfig, home: string, botId: string): void {
  if (config.bots.some((bot) => sameBotId(rawBotId(bot), botId))) {
    throw new Error(`target config already contains bot '${botId}'`);
  }
  const botDirectory = path.join(home, botId);
  if (fs.existsSync(botDirectory)) throw new Error(`target Bot data already exists: ${botDirectory}`);
}

function sameBotId(left: string | undefined, right: string): boolean {
  if (left === undefined) return false;
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function writeHomeConfig(config: RawHomeConfig, bots: RawBot[]): void {
  const value = { ...config.value, bots };
  const serialized = yaml.stringify(value);
  const temporary = path.join(path.dirname(config.configPath), `.${path.basename(config.configPath)}.${randomUUID()}.tmp`);
  writePrivateFile(temporary, serialized);
  try {
    replaceFileSync(temporary, config.configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function validateCandidateConfig(config: RawHomeConfig, bots: RawBot[]): void {
  const temporary = path.join(path.dirname(config.configPath), `.config.bot-transfer-${randomUUID()}.yaml`);
  writePrivateFile(temporary, yaml.stringify({ ...config.value, bots }));
  try {
    loadConfig(temporary);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function restoreConfigBytes(configPath: string, bytes: Buffer): void {
  const temporary = path.join(path.dirname(configPath), `.${path.basename(configPath)}.${randomUUID()}.restore`);
  writePrivateFile(temporary, bytes);
  try {
    replaceFileSync(temporary, configPath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function writePrivateFile(filePath: string, value: string | Buffer): void {
  fs.writeFileSync(filePath, value, { mode: 0o600, flag: "wx" });
}

function hashFile(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function readAndValidateDatabase(databasePath: string): number {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });
  try {
    const quickCheck = database.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") throw new Error("Bot database failed SQLite quick_check");
    const version = database.pragma("user_version", { simple: true }) as number;
    if (!Number.isSafeInteger(version) || version < 0 || version > LATEST_SCHEMA_VERSION) {
      throw new Error(`Bot database schema ${version} is not supported by this NiuBot version (latest ${LATEST_SCHEMA_VERSION})`);
    }
    return version;
  } finally {
    database.close();
  }
}

async function assertHomeStopped(home: string, label: string): Promise<void> {
  const running = await inspectRunningEngine(home);
  const state = readProcessState(home)?.processes.engine;
  if (running || (state && isProcessAlive(state.pid))) {
    throw new Error(`${label} Engine is running; stop it before importing or moving a Bot: ${home}`);
  }
}

function assertSafeBotId(botId: string): void {
  const baseName = botId.split(".")[0]?.toUpperCase();
  const reserved = new Set(["CON", "PRN", "AUX", "NUL", ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`), ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`)]);
  const internal = new Set([".bot-transfer-staging", ".bot-transfer-transactions", ".bot-move-trash"]);
  if (!botId || botId.trim() !== botId || botId === "." || botId === ".."
    || /[\\/\0-\x1f<>:\"|?*]/.test(botId) || /[. ]$/.test(botId)
    || (baseName !== undefined && reserved.has(baseName)) || internal.has(botId.toLowerCase())) {
    throw new Error(`unsafe Bot ID: ${JSON.stringify(botId)}`);
  }
}

function assertSameDevice(sourceHome: string, targetHome: string): void {
  const sourceDevice = fs.statSync(nearestExistingAncestor(sourceHome)).dev;
  const targetDevice = fs.statSync(nearestExistingAncestor(targetHome)).dev;
  if (sourceDevice !== targetDevice) throw new Error("move only supports NIUBOT_HOME paths on the same device");
}

function nearestExistingAncestor(candidate: string): string {
  let current = path.resolve(candidate);
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) throw new Error(`cannot resolve an existing ancestor for ${candidate}`);
    current = parent;
  }
  return current;
}

function removeDirectoryIfEmpty(directory: string): void {
  try {
    if (fs.readdirSync(directory).length === 0) fs.rmdirSync(directory);
  } catch { /* directory may not exist or may contain unrelated data */ }
}

async function withHomeTransferLocks<T>(homes: string[], operation: () => Promise<T>): Promise<T> {
  const releases: Array<() => void> = [];
  const orderedHomes = [...new Set(homes.map((home) => path.resolve(home)))].sort((a, b) => a.localeCompare(b));
  try {
    for (const home of orderedHomes) {
      const runDirectory = path.join(home, "run");
      ensurePrivateInternalDirectory(runDirectory);
      releases.push(acquireProcessLock(path.join(runDirectory, "bot-transfer.lock"), "Bot transfer"));
      releases.push(acquireProcessLock(path.join(runDirectory, "engine-start.lock"), "Engine start"));
    }
    return await operation();
  } finally {
    for (const release of releases.reverse()) release();
  }
}

function createImportTransaction(home: string, config: RawHomeConfig, botId: string, botDirectory: string): string {
  const transactionsRoot = path.join(home, ".bot-transfer-transactions");
  ensurePrivateInternalDirectory(transactionsRoot);
  const transactionDirectory = path.join(transactionsRoot, randomUUID());
  ensurePrivateInternalDirectory(transactionDirectory);
  try {
    writePrivateFile(path.join(transactionDirectory, "config.original"), fs.readFileSync(config.configPath));
    writeJsonReplacing(path.join(transactionDirectory, "manifest.json"), {
      schemaVersion: 1,
      kind: "import",
      phase: "prepared",
      botId,
      home,
      configPath: config.configPath,
      botDirectory,
    });
    return transactionDirectory;
  } catch (err) {
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
    removeDirectoryIfEmpty(transactionsRoot);
    throw err;
  }
}

function createMoveTransaction(transactionDirectory: string, options: {
  botId: string;
  sourceHome: string;
  targetHome: string;
  sourceConfigPath: string;
  targetConfigPath: string;
  sourceConfigBytes: Buffer;
  targetConfigBytes: Buffer;
}): void {
  ensurePrivateInternalDirectory(path.dirname(transactionDirectory));
  ensurePrivateInternalDirectory(transactionDirectory);
  try {
    writePrivateFile(path.join(transactionDirectory, "source-config.original"), options.sourceConfigBytes);
    writePrivateFile(path.join(transactionDirectory, "target-config.original"), options.targetConfigBytes);
    writeJsonReplacing(path.join(transactionDirectory, "manifest.json"), {
      schemaVersion: 1,
      kind: "move",
      phase: "prepared",
      botId: options.botId,
      sourceHome: options.sourceHome,
      targetHome: options.targetHome,
      sourceConfigPath: options.sourceConfigPath,
      targetConfigPath: options.targetConfigPath,
    });
  } catch (err) {
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
    throw err;
  }
}

function updateTransactionPhase(transactionDirectory: string, phase: string): void {
  const manifestPath = path.join(transactionDirectory, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as Record<string, unknown>;
  writeJsonReplacing(manifestPath, { ...manifest, phase, updatedAt: new Date().toISOString() });
}

function recoverImportTransactions(home: string): void {
  const root = path.join(home, ".bot-transfer-transactions");
  if (!fs.existsSync(root)) return;
  assertRealDirectory(root, "Bot transfer transaction directory");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid Bot transfer transaction entry: ${entry.name}`);
    const transactionDirectory = path.join(root, entry.name);
    const manifest = readTransactionManifest(transactionDirectory, "import");
    const botId = requiredManifestString(manifest, "botId");
    assertSafeBotId(botId);
    const configPath = requiredManifestString(manifest, "configPath");
    const botDirectory = requiredManifestString(manifest, "botDirectory");
    if (!samePlatformPath(configPath, path.join(home, "config.yaml"))
      || !samePlatformPath(botDirectory, path.join(home, botId))) {
      throw new Error(`unsafe import transaction paths in ${transactionDirectory}`);
    }
    const config = readRawHomeConfig(home);
    const committed = config.bots.some((bot) => sameBotId(rawBotId(bot), botId)) && hasCompleteBotData(botDirectory);
    if (!committed) {
      restoreConfigBytes(configPath, fs.readFileSync(path.join(transactionDirectory, "config.original")));
      fs.rmSync(botDirectory, { recursive: true, force: true });
    }
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
  }
  removeDirectoryIfEmpty(root);
}

function recoverMoveTransactions(sourceHome: string, targetHome: string): number {
  const root = path.join(sourceHome, ".bot-move-trash");
  if (!fs.existsSync(root)) return 0;
  let recovered = 0;
  assertRealDirectory(root, "Bot move recovery directory");
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid Bot move transaction entry: ${entry.name}`);
    const transactionDirectory = path.join(root, entry.name);
    const manifestPath = path.join(transactionDirectory, "manifest.json");
    if (!fs.existsSync(manifestPath)) throw new Error(`Bot move transaction is missing manifest.json: ${transactionDirectory}`);
    const manifest = readTransactionManifest(transactionDirectory, "move");
    if (manifest["phase"] === "complete") continue;
    const botId = requiredManifestString(manifest, "botId");
    assertSafeBotId(botId);
    if (!samePlatformPath(requiredManifestString(manifest, "sourceHome"), sourceHome)
      || !samePlatformPath(requiredManifestString(manifest, "targetHome"), targetHome)) {
      throw new Error(`unfinished Bot move must be recovered with its original target home: ${transactionDirectory}`);
    }
    const sourceConfigPath = requiredManifestString(manifest, "sourceConfigPath");
    const targetConfigPath = requiredManifestString(manifest, "targetConfigPath");
    if (!samePlatformPath(sourceConfigPath, path.join(sourceHome, "config.yaml"))
      || !samePlatformPath(targetConfigPath, path.join(targetHome, "config.yaml"))) {
      throw new Error(`unsafe move transaction paths in ${transactionDirectory}`);
    }
    const sourceHasBot = readRawHomeConfig(sourceHome).bots.some((bot) => sameBotId(rawBotId(bot), botId));
    const targetHasBot = readRawHomeConfig(targetHome).bots.some((bot) => sameBotId(rawBotId(bot), botId));
    const targetBotDirectory = path.join(targetHome, botId);
    if (targetHasBot && !sourceHasBot && hasCompleteBotData(targetBotDirectory)) {
      const recoveryDirectory = path.join(transactionDirectory, botId);
      ensurePrivateInternalDirectory(recoveryDirectory);
      for (const source of [path.join(sourceHome, botId, "niubot.db"), path.join(sourceHome, botId, "bot_profile.md")]) {
        if (fs.existsSync(source)) fs.renameSync(source, path.join(recoveryDirectory, path.basename(source)));
      }
      fs.rmSync(path.join(transactionDirectory, "source-config.original"), { force: true });
      fs.rmSync(path.join(transactionDirectory, "target-config.original"), { force: true });
      writeJsonReplacing(manifestPath, { ...manifest, phase: "complete", recoveredAt: new Date().toISOString() });
      recovered += 1;
      continue;
    }
    if (targetHasBot) {
      restoreConfigBytes(targetConfigPath, fs.readFileSync(path.join(transactionDirectory, "target-config.original")));
    }
    fs.rmSync(targetBotDirectory, { recursive: true, force: true });
    const recoveryDirectory = path.join(transactionDirectory, botId);
    for (const name of ["niubot.db", "bot_profile.md"]) {
      const recovery = path.join(recoveryDirectory, name);
      const source = path.join(sourceHome, botId, name);
      if (fs.existsSync(recovery) && !fs.existsSync(source)) {
        fs.mkdirSync(path.dirname(source), { recursive: true, mode: 0o700 });
        fs.renameSync(recovery, source);
      }
    }
    restoreConfigBytes(sourceConfigPath, fs.readFileSync(path.join(transactionDirectory, "source-config.original")));
    fs.rmSync(transactionDirectory, { recursive: true, force: true });
    recovered += 1;
  }
  removeDirectoryIfEmpty(root);
  return recovered;
}

export function assertNoPendingBotTransfer(homePath: string, activeLifecycleId?: string): void {
  const home = path.resolve(homePath);
  const lifecycleRoot = path.join(home, "run", "bot-transfer-active");
  if (fs.existsSync(lifecycleRoot)) {
    const activeEntries = fs.readdirSync(lifecycleRoot).filter((entry) => entry !== `${activeLifecycleId}.json`);
    if (activeEntries.length > 0) {
      throw new Error(`Bot transfer lifecycle is active in ${lifecycleRoot}; wait for it to finish`);
    }
  }
  const importRoot = path.join(home, ".bot-transfer-transactions");
  if (fs.existsSync(importRoot) && fs.readdirSync(importRoot).length > 0) {
    throw new Error(`unfinished Bot import found in ${importRoot}; rerun the import command to recover it`);
  }
  const moveRoot = path.join(home, ".bot-move-trash");
  if (!fs.existsSync(moveRoot)) return;
  for (const entry of fs.readdirSync(moveRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`invalid Bot move transaction entry: ${entry.name}`);
    const transactionDirectory = path.join(moveRoot, entry.name);
    const manifest = readTransactionManifest(transactionDirectory, "move");
    if (manifest["phase"] !== "complete") {
      throw new Error(`unfinished Bot move found in ${transactionDirectory}; rerun move with --apply and the original homes`);
    }
  }
}

function readTransactionManifest(transactionDirectory: string, expectedKind: string): Record<string, unknown> {
  const manifest = JSON.parse(fs.readFileSync(path.join(transactionDirectory, "manifest.json"), "utf-8")) as Record<string, unknown>;
  if (manifest["schemaVersion"] !== 1 || manifest["kind"] !== expectedKind || typeof manifest["phase"] !== "string") {
    throw new Error(`invalid ${expectedKind} transaction manifest: ${transactionDirectory}`);
  }
  return manifest;
}

function requiredManifestString(manifest: Record<string, unknown>, key: string): string {
  const value = manifest[key];
  if (typeof value !== "string" || !value) throw new Error(`transaction manifest is missing ${key}`);
  return value;
}

function writeJsonReplacing(filePath: string, value: unknown): void {
  const temporary = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  writePrivateFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  try {
    replaceFileSync(temporary, filePath);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

function clearDeviceLocalDatabaseState(databasePath: string): void {
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      if (databaseColumnExists(database, "sessions", "agent_session_id")) {
        database.prepare("UPDATE sessions SET agent_session_id = NULL WHERE agent_session_id IS NOT NULL").run();
      }
      if (databaseColumnExists(database, "worker_jobs", "backend_session_id")) {
        database.prepare("UPDATE worker_jobs SET backend_session_id = NULL WHERE backend_session_id IS NOT NULL").run();
      }
      if (databaseColumnExists(database, "worker_jobs", "transcript_sources_json")) {
        database.prepare("UPDATE worker_jobs SET transcript_sources_json = '[]' WHERE transcript_sources_json <> '[]'").run();
      }
    })();
  } finally {
    database.close();
  }
}

function databaseColumnExists(database: Database.Database, table: string, column: string): boolean {
  const tableExists = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
  if (!tableExists) return false;
  const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  return columns.some((item) => item.name === column);
}

function hasCompleteBotData(botDirectory: string): boolean {
  try {
    assertRealDirectory(botDirectory, "target Bot directory");
    const profilePath = path.join(botDirectory, "bot_profile.md");
    if (!fs.statSync(profilePath).isFile()) return false;
    readAndValidateDatabase(path.join(botDirectory, "niubot.db"));
    return true;
  } catch {
    return false;
  }
}

function ensurePrivateInternalDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  assertRealDirectory(directory, "internal transfer directory");
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows ACLs do not use POSIX modes */ }
}

function assertRealDirectory(directory: string, label: string): void {
  const stat = fs.lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a real directory: ${directory}`);
}

function attemptRollback(label: string, operation: () => void, errors: Error[]): void {
  try {
    operation();
  } catch (err) {
    errors.push(new Error(`${label}: ${asError(err).message}`));
  }
}

function throwWithRollbackErrors(original: unknown, rollbackErrors: Error[]): never {
  if (rollbackErrors.length === 0) throw original;
  throw new AggregateError([asError(original), ...rollbackErrors],
    `Bot transfer failed and rollback was incomplete: ${rollbackErrors.map((error) => error.message).join("; ")}`);
}

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
