import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { initDatabase } from "../database/schema.js";
import { TeamConfigStore, parseTeamConfig } from "./team-config.js";

const BOT_ID = "test-bot";

let db: Database.Database;
let store: TeamConfigStore;

const VALID_YAML = `maxConcurrent: 3
maxJobsPerWork: 8
profiles:
  - id: reviewer
    description: 代码审查
    access: read_only
    prompt: |
      你是代码审查 Worker。
  - id: developer
    description: 开发
    access: git_worktree
    maxConcurrent: 1
    prompt: |
      你是开发 Worker。
`;

beforeEach(() => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "team-config-"));
  db = initDatabase(path.join(dir, "test.db"));
  store = new TeamConfigStore(db, BOT_ID);
});

afterEach(() => {
  db.close();
});

describe("parseTeamConfig", () => {
  test("解析合法配置", () => {
    const config = parseTeamConfig(VALID_YAML);
    expect(config.maxConcurrent).toBe(3);
    expect(config.maxJobsPerWork).toBe(8);
    expect(config.profiles).toHaveLength(2);
    expect(config.profiles[0]!.id).toBe("reviewer");
    expect(config.profiles[1]!.access).toBe("git_worktree");
  });

  test("拒绝非法配置", () => {
    expect(() => parseTeamConfig("profiles: []")).toThrow(/至少一个/);
    expect(() => parseTeamConfig("profiles:\n  - id: Bad_ID\n    prompt: x")).toThrow(/id 非法/);
    expect(() => parseTeamConfig("profiles:\n  - id: a\n    prompt: x\n  - id: a\n    prompt: y")).toThrow(/重复/);
    expect(() => parseTeamConfig("profiles:\n  - id: a\n    prompt: ''")).toThrow(/缺少 prompt/);
    expect(() => parseTeamConfig("profiles:\n  - id: a\n    prompt: x\n    access: nope")).toThrow(/access 非法/);
    expect(() => parseTeamConfig("profiles:\n  - id: a\n    prompt: x\nmaxConcurrent: -1")).toThrow(/正整数/);
  });
});

describe("TeamConfigStore", () => {
  test("默认关闭；on/off 持久化", () => {
    expect(store.isEnabled()).toBe(false);
    store.setEnabled(true);
    expect(store.isEnabled()).toBe(true);
    const fresh = new TeamConfigStore(db, BOT_ID);
    expect(fresh.isEnabled()).toBe(true);
    store.setEnabled(false);
    expect(store.isEnabled()).toBe(false);
  });

  test("无配置版本时返回内置默认", () => {
    const active = store.getActiveConfig();
    expect(active.version).toBeUndefined();
    expect(active.config.maxConcurrent).toBe(4);
    expect(active.config.profiles).toEqual([]);
  });

  test("草案创建（校验失败拒绝）→ 应用 → 生效 → 历史可查", () => {
    const created = store.createDraft(VALID_YAML, "u1");
    expect(created.ok).toBe(true);
    const draftId = created.ok ? created.draftId : "";

    // 非法草案拒绝
    const bad = store.createDraft("profiles:\n  - id: BAD\n    prompt: x", "u1");
    expect(bad.ok).toBe(false);

    const applied = store.applyDraft(draftId, "u1");
    expect(applied.ok).toBe(true);
    const version = applied.ok ? applied.version : "";

    const active = store.getActiveConfig();
    expect(active.version).toBe(version);
    expect(active.config.profiles.map((p) => p.id)).toEqual(["reviewer", "developer"]);

    // 版本历史
    const versions = store.listVersions();
    expect(versions).toHaveLength(1);
    expect(versions[0]!.version).toBe(version);

    // 草案状态 applied，重复应用拒绝
    expect(store.getDraft(draftId)?.status).toBe("applied");
    expect(store.applyDraft(draftId, "u1").ok).toBe(false);
  });

  test("回滚生成新版本且保留历史", () => {
    const d1 = store.createDraft(VALID_YAML, "u1");
    const v1 = store.applyDraft(d1.ok ? d1.draftId : "", "u1");
    const version1 = v1.ok ? v1.version : "";

    const yaml2 = VALID_YAML.replace("maxConcurrent: 3", "maxConcurrent: 5");
    const d2 = store.createDraft(yaml2, "u1");
    const v2 = store.applyDraft(d2.ok ? d2.draftId : "", "u1");
    const version2 = v2.ok ? v2.version : "";
    expect(store.getActiveConfig().config.maxConcurrent).toBe(5);

    const rollback = store.rollback(version1, "u1");
    expect(rollback.ok).toBe(true);
    expect(store.getActiveConfig().config.maxConcurrent).toBe(3);
    expect(store.listVersions()).toHaveLength(3);
    expect(store.listVersions().find((v) => v.rollbackOf === version1)).toBeTruthy();
  });

  test("回滚不存在的版本拒绝", () => {
    const result = store.rollback("V-不存在", "u1");
    expect(result.ok).toBe(false);
  });
});
