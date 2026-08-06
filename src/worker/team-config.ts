/**
 * TeamConfigStore：/worker 配置体系（Phase 5）。
 *
 * 配置流程（方案 §15）：Agent 生成草案（yaml）→ 确定性校验 →
 * 管理员确认后 apply 生成不可变版本 → 历史版本可回滚（回滚也是新版本）。
 * 新版本只影响新 Job（运行中 Job 使用创建时的 profile 快照）。
 *
 * 命名说明：Team* 类名与 team_* 表名沿袭早期「Teams」叫法（对应命令已统一为
 * /worker）；改名需同步迁移表结构（team_settings / team_config_versions /
 * team_config_drafts），当前保留以降低迁移成本。
 */

import { createHash, randomUUID } from "node:crypto";

import type Database from "better-sqlite3";
import yaml from "yaml";

import { createLogger } from "../logger.js";
import type { WorkspaceAccess } from "./types.js";

const log = createLogger("worker-team-config");

export interface TeamProfileSkills {
  sharedSets?: string[];
  include?: string[];
  exclude?: string[];
  required?: string[];
}

export interface TeamProfileConfig {
  id: string;
  displayName?: string;
  description?: string;
  prompt: string;
  /** 工作原则（system prompt；与内置角色一致的分层注入） */
  principles?: string;
  /** 典型工作流（system prompt；与内置角色一致的分层注入） */
  workflow?: string;
  access: WorkspaceAccess;
  maxConcurrent?: number;
  skills?: TeamProfileSkills;
  /** 专属 backend 类型（如 "claude"）；未设置时复用主 Agent 的 backend */
  backend?: string;
  /** 专属模型（backend 支持时生效）；未设置时使用 Bot 全局模型 */
  model?: string;
}

export interface TeamConfig {
  maxConcurrent: number;
  maxJobsPerWork: number;
  profiles: TeamProfileConfig[];
}

export interface TeamDraft {
  id: string;
  configYaml: string;
  status: "pending" | "applied" | "superseded" | "rejected";
  baseVersion?: string;
  createdAt: string;
}

export interface TeamConfigVersion {
  version: string;
  configYaml: string;
  appliedBy?: string;
  appliedAt: string;
  rollbackOf?: string;
}

export const DEFAULT_TEAM_CONFIG: TeamConfig = {
  maxConcurrent: 4,
  maxJobsPerWork: 10,
  profiles: [],
};

const PROFILE_ID_PATTERN = /^[a-z][a-z0-9-]*$/;

export function parseTeamConfig(yamlText: string): TeamConfig {
  const raw = yaml.parse(yamlText) as Record<string, unknown> | null;
  if (!raw || typeof raw !== "object") {
    throw new Error("配置必须是 YAML 对象");
  }
  const config: TeamConfig = {
    maxConcurrent: toPositiveInt(raw["maxConcurrent"], 4, "maxConcurrent"),
    maxJobsPerWork: toPositiveInt(raw["maxJobsPerWork"], 10, "maxJobsPerWork"),
    profiles: [],
  };
  const rawProfiles = raw["profiles"];
  if (!Array.isArray(rawProfiles) || rawProfiles.length === 0) {
    throw new Error("配置必须包含至少一个 profiles 条目");
  }
  const seen = new Set<string>();
  for (const item of rawProfiles) {
    if (!item || typeof item !== "object") {
      throw new Error("profiles 条目必须是对象");
    }
    const p = item as Record<string, unknown>;
    const id = typeof p["id"] === "string" ? p["id"] : "";
    if (!PROFILE_ID_PATTERN.test(id)) {
      throw new Error(`profile id 非法（须为小写字母/数字/连字符）: ${JSON.stringify(p["id"])}`);
    }
    if (seen.has(id)) {
      throw new Error(`重复的 profile id: ${id}`);
    }
    seen.add(id);
    const prompt = typeof p["prompt"] === "string" ? p["prompt"] : "";
    if (!prompt.trim()) {
      throw new Error(`profile ${id} 缺少 prompt`);
    }
    let access = p["access"] ?? "read_only";
    if (!["read_only", "direct"].includes(access as string)) {
      // 兼容旧值：git_worktree/scratch 已废弃（写任务现在直接在目标目录修改），映射为 direct
      if (access === "git_worktree" || access === "scratch") {
        access = "direct";
      } else {
        throw new Error(`profile ${id} 的 access 非法: ${String(access)}`);
      }
    }
    const maxConcurrent = p["maxConcurrent"] === undefined ? undefined : toPositiveInt(p["maxConcurrent"], 1, `profiles.${id}.maxConcurrent`);
    const rawSkills = p["skills"];
    let skills: TeamProfileSkills | undefined;
    if (rawSkills !== undefined) {
      if (!rawSkills || typeof rawSkills !== "object" || Array.isArray(rawSkills)) {
        throw new Error(`profile ${id} 的 skills 必须是对象`);
      }
      const s = rawSkills as Record<string, unknown>;
      const strList = (key: string): string[] | undefined => {
        const v = s[key];
        if (v === undefined) return undefined;
        if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
          throw new Error(`profile ${id} 的 skills.${key} 必须是字符串数组`);
        }
        return v as string[];
      };
      skills = {
        sharedSets: strList("sharedSets"),
        include: strList("include"),
        exclude: strList("exclude"),
        required: strList("required"),
      };
    }
    config.profiles.push({
      id,
      displayName: typeof p["displayName"] === "string" ? p["displayName"] : undefined,
      description: typeof p["description"] === "string" ? p["description"] : undefined,
      prompt,
      principles: typeof p["principles"] === "string" ? p["principles"] : undefined,
      workflow: typeof p["workflow"] === "string" ? p["workflow"] : undefined,
      access: access as WorkspaceAccess,
      maxConcurrent,
      skills,
      // 空串视为未配置（避免 backend: "" 静默回退主 backend 但 model 仍覆盖生效）
      backend: typeof p["backend"] === "string" && p["backend"].trim() !== "" ? p["backend"] : undefined,
      model: typeof p["model"] === "string" && p["model"].trim() !== "" ? p["model"] : undefined,
    });
  }
  return config;
}

function toPositiveInt(value: unknown, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error(`${field} 必须是正整数`);
  }
  return n;
}

function configHash(yamlText: string): string {
  return createHash("sha256").update(yamlText.replace(/\s+/g, "")).digest("hex").slice(0, 16);
}

export class TeamConfigStore {
  constructor(
    private readonly db: Database.Database,
    private readonly botId: string,
  ) {}

  // -----------------------------------------------------------------------
  // 开关
  // -----------------------------------------------------------------------

  isEnabled(): boolean {
    const row = this.db.prepare("SELECT enabled FROM team_settings WHERE bot_id = ?").get(this.botId) as
      | { enabled: number }
      | undefined;
    // 默认开启（全开放方向）：未显式关闭时团队模式可用，/worker off 为临时暂停
    return row ? row.enabled === 1 : true;
  }

  setEnabled(enabled: boolean): void {
    this.db.prepare(`
      INSERT INTO team_settings (bot_id, enabled, updated_at)
      VALUES (?, ?, datetime('now'))
      ON CONFLICT(bot_id) DO UPDATE SET enabled = excluded.enabled, updated_at = datetime('now')
    `).run(this.botId, enabled ? 1 : 0);
  }

  // -----------------------------------------------------------------------
  // 版本
  // -----------------------------------------------------------------------

  /** 当前生效配置；无版本时返回内置默认。 */
  getActiveConfig(): { version?: string; config: TeamConfig } {
    const row = this.db.prepare("SELECT active_config_version FROM team_settings WHERE bot_id = ?").get(this.botId) as
      | { active_config_version: string | null }
      | undefined;
    const version = row?.active_config_version;
    if (!version) return { config: DEFAULT_TEAM_CONFIG };
    const versionRow = this.db.prepare("SELECT config_yaml FROM team_config_versions WHERE version = ? AND bot_id = ?")
      .get(version, this.botId) as { config_yaml: string } | undefined;
    if (!versionRow) return { config: DEFAULT_TEAM_CONFIG };
    try {
      return { version, config: parseTeamConfig(versionRow.config_yaml) };
    } catch (err) {
      // 显式记录解析失败：静默回退内置默认会让自定义角色无声消失，必须可排查
      log.error("active team config failed to parse, falling back to defaults", {
        botId: this.botId,
        version,
        error: err instanceof Error ? err.message : String(err),
      });
      return { config: DEFAULT_TEAM_CONFIG };
    }
  }

  listVersions(): TeamConfigVersion[] {
    const rows = this.db.prepare(
      "SELECT version, config_yaml, applied_by, applied_at, rollback_of FROM team_config_versions WHERE bot_id = ? ORDER BY applied_at DESC",
    ).all(this.botId) as Array<{
      version: string;
      config_yaml: string;
      applied_by: string | null;
      applied_at: string;
      rollback_of: string | null;
    }>;
    return rows.map((row) => ({
      version: row.version,
      configYaml: row.config_yaml,
      appliedBy: row.applied_by ?? undefined,
      appliedAt: row.applied_at,
      rollbackOf: row.rollback_of ?? undefined,
    }));
  }

  /** 应用草案：校验 → 存版本 → 切换 active → 标记 draft applied。 */
  applyDraft(draftId: string, appliedBy?: string): { ok: true; version: string } | { ok: false; error: string } {
    const draft = this.db.prepare("SELECT * FROM team_config_drafts WHERE id = ? AND bot_id = ?")
      .get(draftId, this.botId) as { id: string; config_yaml: string; status: string } | undefined;
    if (!draft) return { ok: false, error: `草案不存在: ${draftId}` };
    if (draft.status !== "pending") return { ok: false, error: `草案状态不是 pending: ${draft.status}` };
    try {
      parseTeamConfig(draft.config_yaml);
    } catch (err) {
      return { ok: false, error: `配置校验失败: ${String(err)}` };
    }
    const version = `V-${Date.now()}-${randomUUID().slice(0, 6)}`;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO team_config_versions (version, bot_id, config_yaml, config_hash, applied_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(version, this.botId, draft.config_yaml, configHash(draft.config_yaml), appliedBy ?? null);
      this.db.prepare(`
        INSERT INTO team_settings (bot_id, active_config_version, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(bot_id) DO UPDATE SET active_config_version = excluded.active_config_version, updated_at = datetime('now')
      `).run(this.botId, version);
      this.db.prepare("UPDATE team_config_drafts SET status = 'applied' WHERE id = ?").run(draftId);
    })();
    return { ok: true, version };
  }

  /** 回滚：生成新版本（rollback_of 标记），不删除历史。 */
  rollback(targetVersion: string, appliedBy?: string): { ok: true; version: string } | { ok: false; error: string } {
    const target = this.db.prepare("SELECT config_yaml FROM team_config_versions WHERE version = ? AND bot_id = ?")
      .get(targetVersion, this.botId) as { config_yaml: string } | undefined;
    if (!target) return { ok: false, error: `版本不存在: ${targetVersion}` };
    const newVersion = `V-${Date.now()}-${randomUUID().slice(0, 6)}`;
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO team_config_versions (version, bot_id, config_yaml, config_hash, applied_by, rollback_of)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(newVersion, this.botId, target.config_yaml, configHash(target.config_yaml), appliedBy ?? null, targetVersion);
      this.db.prepare(`
        INSERT INTO team_settings (bot_id, active_config_version, updated_at)
        VALUES (?, ?, datetime('now'))
        ON CONFLICT(bot_id) DO UPDATE SET active_config_version = excluded.active_config_version, updated_at = datetime('now')
      `).run(this.botId, newVersion);
    })();
    return { ok: true, version: newVersion };
  }

  // -----------------------------------------------------------------------
  // 草案
  // -----------------------------------------------------------------------

  createDraft(configYaml: string, createdBy?: string, baseVersion?: string): { ok: true; draftId: string } | { ok: false; error: string } {
    try {
      parseTeamConfig(configYaml);
    } catch (err) {
      return { ok: false, error: `配置校验失败: ${String(err)}` };
    }
    const draftId = `D-${Date.now()}-${randomUUID().slice(0, 6)}`;
    this.db.prepare(`
      INSERT INTO team_config_drafts (id, bot_id, config_yaml, base_version, created_by)
      VALUES (?, ?, ?, ?, ?)
    `).run(draftId, this.botId, configYaml, baseVersion ?? null, createdBy ?? null);
    return { ok: true, draftId };
  }

  getDraft(draftId: string): TeamDraft | undefined {
    const row = this.db.prepare("SELECT * FROM team_config_drafts WHERE id = ? AND bot_id = ?")
      .get(draftId, this.botId) as {
      id: string; config_yaml: string; status: string; base_version: string | null; created_at: string;
    } | undefined;
    if (!row) return undefined;
    return {
      id: row.id,
      configYaml: row.config_yaml,
      status: row.status as TeamDraft["status"],
      baseVersion: row.base_version ?? undefined,
      createdAt: row.created_at,
    };
  }

  listPendingDrafts(): TeamDraft[] {
    const rows = this.db.prepare(
      "SELECT * FROM team_config_drafts WHERE bot_id = ? AND status = 'pending' ORDER BY created_at DESC",
    ).all(this.botId) as Array<{
      id: string; config_yaml: string; status: string; base_version: string | null; created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      configYaml: row.config_yaml,
      status: row.status as TeamDraft["status"],
      baseVersion: row.base_version ?? undefined,
      createdAt: row.created_at,
    }));
  }
}
