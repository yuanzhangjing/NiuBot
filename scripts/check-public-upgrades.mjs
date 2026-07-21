import { x as extractTar } from "tar";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const packageName = "@yuanzhangjing/niubot";
const registryUrl = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
const response = await fetch(registryUrl);
if (!response.ok) throw new Error(`npm registry metadata failed: ${response.status}`);
const metadata = await response.json();
const versions = Object.keys(metadata.versions ?? {})
  .filter((version) => /^\d+\.\d+\.\d+$/.test(version))
  .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
if (versions.length === 0) throw new Error("npm registry returned no stable public versions");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "niubot-public-upgrades-"));
fs.symlinkSync(path.join(repository, "node_modules"), path.join(root, "node_modules"), "dir");
process.env.NIUBOT_LOG_LEVEL = "error";

try {
  await downloadPackages(versions, 8);
  const candidateLogger = await import(pathToFileURL(path.join(repository, "dist/logger.js")).href);
  candidateLogger.setLogLevel("error");
  const candidate = await import(
    `${pathToFileURL(path.join(repository, "dist/database/schema.js")).href}?matrix=${Date.now()}`
  );
  const results = [];

  for (const version of versions) {
    const packageDirectory = path.join(root, version, "package");
    const schemaModule = path.join(packageDirectory, "dist", "database", "schema.js");
    if (!fs.existsSync(schemaModule)) throw new Error(`${version} has no packaged database schema`);
    const oldLogger = await import(pathToFileURL(path.join(packageDirectory, "dist", "logger.js")).href);
    oldLogger.setLogLevel("error");
    const oldRelease = await import(`${pathToFileURL(schemaModule).href}?version=${version}`);
    const testDirectory = fs.mkdtempSync(path.join(root, `case-${version}-`));
    const databasePath = path.join(testDirectory, "niubot.db");

    const oldDatabase = oldRelease.initDatabase(databasePath);
    const oldSchema = oldDatabase.pragma("user_version", { simple: true });
    insertLegacyCron(oldDatabase, "before-upgrade", "0 * * * *");
    oldDatabase.close();

    const upgraded = candidate.initDatabase(databasePath);
    const upgradedSchema = upgraded.pragma("user_version", { simple: true });
    const transportSchema = upgraded.prepare(
      "SELECT version FROM niubot_component_schema_versions WHERE component = 'transport'",
    ).pluck().get();
    upgraded.prepare(`
      INSERT INTO transport_inbox (
        bot_id, platform, platform_msg_id, payload_json, status
      ) VALUES ('NiuBot', 'feishu', 'matrix-pending', '{}', 'pending')
    `).run();
    upgraded.close();

    const rolledBack = oldRelease.initDatabase(databasePath);
    insertLegacyCron(rolledBack, "during-rollback", "30 * * * *");
    rolledBack.close();

    const reupgraded = candidate.initDatabase(databasePath);
    const quickCheck = reupgraded.pragma("quick_check", { simple: true });
    const prompts = reupgraded.prepare("SELECT prompt FROM cron_jobs ORDER BY id").pluck().all();
    const pending = reupgraded.prepare(
      "SELECT status FROM transport_inbox WHERE platform_msg_id = 'matrix-pending'",
    ).pluck().get();
    reupgraded.close();

    if (!candidate.ROLLBACK_COMPATIBLE_SCHEMA_VERSIONS.includes(oldSchema)
      || upgradedSchema !== oldSchema || transportSchema !== candidate.LATEST_TRANSPORT_SCHEMA_VERSION
      || quickCheck !== "ok" || JSON.stringify(prompts) !== JSON.stringify(["before-upgrade", "during-rollback"])
      || pending !== "pending") {
      throw new Error(
        `${version} failed: old=${oldSchema} upgraded=${upgradedSchema} transport=${transportSchema} `
        + `quickCheck=${quickCheck} prompts=${JSON.stringify(prompts)} pending=${pending}`,
      );
    }
    results.push({ version, schema: oldSchema });
  }

  const schemaGroups = new Map();
  for (const result of results) {
    const group = schemaGroups.get(result.schema) ?? [];
    group.push(result);
    schemaGroups.set(result.schema, group);
  }
  console.log(JSON.stringify({
    packageCount: results.length,
    firstVersion: results[0]?.version,
    lastVersion: results.at(-1)?.version,
    schemaGroups: Object.fromEntries([...schemaGroups].map(([schema, group]) => [schema, {
      count: group.length,
      first: group[0]?.version,
      last: group.at(-1)?.version,
    }])),
    cyclesPassed: results.length,
  }, null, 2));
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function insertLegacyCron(database, prompt, cronExpression) {
  database.prepare(`
    INSERT INTO cron_jobs (
      chat_id, creator_user_id, cron_expr, run_at, prompt,
      description, max_times, until_time
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run("compat-chat", "compat-user", cronExpression, null, prompt, "", null, null);
}

async function downloadPackages(targetVersions, concurrency) {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < targetVersions.length) {
      const version = targetVersions[cursor++];
      const target = path.join(root, version);
      fs.mkdirSync(target, { recursive: true });
      const archive = path.join(target, "package.tgz");
      const tarball = metadata.versions[version]?.dist?.tarball;
      if (!tarball) throw new Error(`${version} has no tarball`);
      const packageResponse = await fetch(tarball);
      if (!packageResponse.ok) throw new Error(`${version} download failed: ${packageResponse.status}`);
      fs.writeFileSync(archive, Buffer.from(await packageResponse.arrayBuffer()));
      await extractTar({ file: archive, cwd: target });
      fs.rmSync(archive);
    }
  }));
}
