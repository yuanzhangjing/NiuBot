import path from "node:path";
import type Database from "better-sqlite3";
import { hasUpdateNotification, recordUpdateNotification } from "./database/schema.js";
import type { TransportClient } from "./transport/types.js";
import {
  AUTO_UPDATE_DEFAULTS,
  isInUpgradeWindow,
  isSafeForUpgrade,
  minutesUntilUpgradeWindowEnd,
  UPGRADE_SAFENESS_WINDOW_MS,
  type AutoUpdateConfig,
  type UpgradeSafenessSource,
} from "./core/auto-update.js";
import { createLogger } from "./logger.js";
import { dateInTimeZone, getZonedDateTimeParts, millisecondsUntilLocalHour, TZ } from "./tz.js";
import { isNewerPackageVersion, isProductionVersion } from "./version.js";
import { markAutoUpdateReported, readRestartState } from "./restart-state.js";
import type { EngineLifecycle } from "./engine-lifecycle.js";

const UPDATE_CONFIRM_COMMAND = "/update 1";
const UPDATE_CHECK_HOUR = 10;
const UPDATE_REMINDER_WEEKDAY = 1; // Monday
const AUTO_UPGRADE_CHECK_INTERVAL_MS = 30 * 60_000;
const LEGACY_AUTO_UPDATE_ENABLED_KEY = "auto_update_enabled";

export interface EngineAutoUpdateParticipant {
  getUpgradeSafenessSources(): UpgradeSafenessSource[];
}

export interface EngineAutoUpdateNotificationTarget {
  id: string;
  db: Database.Database;
  dbPath: string;
  transport: Pick<TransportClient, "sendCard">;
  platform: string;
}

export interface EngineAutoUpdateOptions {
  lifecycle: EngineLifecycle;
  participants: EngineAutoUpdateParticipant[];
  notificationTarget: EngineAutoUpdateNotificationTarget;
}

/**
 * Engine 级自动升级协调器。
 *
 * 它是检查、空闲判定、预下载和重启触发的唯一所有者。Bot 只提供：
 * 1. 当前运行状态的只读空闲判定 Source；2. 第一个 Bot 的通知出口。
 */
export class EngineAutoUpdateCoordinator {
  private readonly log = createLogger("engine-auto-update");
  private readonly lifecycle: EngineLifecycle;
  private readonly participants: EngineAutoUpdateParticipant[];
  private readonly notificationTarget: EngineAutoUpdateNotificationTarget;
  private running = false;
  private updateCheckTimer: ReturnType<typeof setTimeout> | null = null;
  private updateCheckGeneration = 0;
  private autoUpgradeTimer: ReturnType<typeof setTimeout> | null = null;
  private autoUpgradeGeneration = 0;
  private autoUpgradeFetchedWindow = "";
  private autoUpgradeFetchRetryWindow = "";
  private autoUpgradeLatestCache: string | null = null;
  private autoUpgradeCheckInFlight: { generation: number; promise: Promise<void> } | null = null;
  private upgradeResultReported = false;

  constructor(options: EngineAutoUpdateOptions) {
    this.lifecycle = options.lifecycle;
    this.participants = options.participants;
    this.notificationTarget = options.notificationTarget;
  }

  start(): void {
    if (this.running) return;
    this.migrateLegacyAutoUpdateSetting();
    this.running = true;
    const generation = ++this.updateCheckGeneration;
    this.scheduleNextUpdateCheck(generation);
    this.resetAutoUpgradeSchedule();
    this.log.info("engine auto-update coordinator started", {
      participantCount: this.participants.length,
      notificationBot: this.notificationTarget.id,
    });
  }

  stop(): void {
    if (!this.running && !this.updateCheckTimer && !this.autoUpgradeTimer) return;
    this.running = false;
    this.updateCheckGeneration++;
    this.autoUpgradeGeneration++;
    if (this.updateCheckTimer) {
      clearTimeout(this.updateCheckTimer);
      this.updateCheckTimer = null;
    }
    if (this.autoUpgradeTimer) {
      clearInterval(this.autoUpgradeTimer);
      this.autoUpgradeTimer = null;
    }
    this.log.info("engine auto-update coordinator stopped");
  }

  /** 任意 Bot 修改共享配置后调用；按最新开关重排窗口定时器。 */
  configChanged(): void {
    if (!this.running) return;
    this.resetAutoUpgradeSchedule();
  }

  private readServiceAutoUpdateConfig(): AutoUpdateConfig | undefined {
    return this.lifecycle.getAutoUpdateConfig();
  }

  private isAutoUpdateEnabled(): boolean {
    return this.readServiceAutoUpdateConfig()?.enabled === true;
  }

  private effectiveAutoUpdateConfig(): AutoUpdateConfig {
    return this.readServiceAutoUpdateConfig() ?? { enabled: true, ...AUTO_UPDATE_DEFAULTS };
  }

  private getNextUpdateCheckDelayMs(now: Date): number {
    return millisecondsUntilLocalHour(now, UPDATE_CHECK_HOUR, TZ);
  }

  private scheduleNextUpdateCheck(generation: number): void {
    if (!this.running || generation !== this.updateCheckGeneration) return;
    if (this.updateCheckTimer) clearTimeout(this.updateCheckTimer);
    this.updateCheckTimer = setTimeout(() => {
      this.runDailyCheck()
        .catch((err) => this.log.warn("scheduled update check failed", { error: String(err) }))
        .finally(() => this.scheduleNextUpdateCheck(generation));
    }, this.getNextUpdateCheckDelayMs(new Date()));
  }

  private resetAutoUpgradeSchedule(): void {
    const generation = ++this.autoUpgradeGeneration;
    if (this.autoUpgradeTimer) {
      clearTimeout(this.autoUpgradeTimer);
      this.autoUpgradeTimer = null;
    }
    if (!this.running || !this.isAutoUpdateEnabled()) return;
    this.scheduleAutoUpgradeCheck(generation, false);
  }

  /**
   * 正常调度只对齐到下一次窗口起点，不在窗口内补查；窗口起点执行后，
   * 才允许每 30 分钟重试查询失败或忙碌状态。
   * npm 查询是否已经成功完成，由 autoUpgradeFetchedWindow 单独控制。
   */
  private scheduleAutoUpgradeCheck(generation: number, retryInCurrentWindow: boolean): void {
    if (!this.running || generation !== this.autoUpgradeGeneration || !this.isAutoUpdateEnabled()) return;
    const config = this.effectiveAutoUpdateConfig();
    const now = new Date();
    const remainingMinutes = minutesUntilUpgradeWindowEnd(now, config);
    const usableWindow = isInUpgradeWindow(now, config) && remainingMinutes >= config.marginMinutes;
    const retryFits = remainingMinutes >= config.marginMinutes + AUTO_UPGRADE_CHECK_INTERVAL_MS / 60_000;
    let delay: number;
    let rescheduleOnly = false;
    if (retryInCurrentWindow && usableWindow && retryFits) {
      delay = AUTO_UPGRADE_CHECK_INTERVAL_MS;
    } else {
      try {
        delay = millisecondsUntilLocalHour(now, config.windowStartHour, config.timezone);
      } catch (err) {
        // DST 跳时可能不存在 02:00；逐小时重算下一窗口，但不在当前窗口补查。
        this.log.warn("failed to resolve next auto-upgrade window start; retrying schedule", { error: String(err) });
        delay = 60 * 60_000;
        rescheduleOnly = true;
      }
    }

    this.autoUpgradeTimer = setTimeout(() => {
      this.autoUpgradeTimer = null;
      if (rescheduleOnly) {
        this.scheduleAutoUpgradeCheck(generation, false);
        return;
      }
      this.requestAutoUpgradeCheck(generation)
        .finally(() => this.scheduleAutoUpgradeCheck(generation, this.shouldRetryCurrentWindow()));
    }, delay);
  }

  private shouldRetryCurrentWindow(): boolean {
    if (!this.running || !this.isAutoUpdateEnabled()) return false;
    const config = this.effectiveAutoUpdateConfig();
    const now = new Date();
    if (!isInUpgradeWindow(now, config)) return false;
    const windowKey = autoUpgradeWindowKey(now, config);
    return this.autoUpgradeFetchRetryWindow === windowKey || this.autoUpgradeLatestCache !== null;
  }

  private requestAutoUpgradeCheck(generation = this.autoUpgradeGeneration): Promise<void> {
    if (this.autoUpgradeCheckInFlight?.generation === generation) {
      return this.autoUpgradeCheckInFlight.promise;
    }
    const check = this.runAutoUpgradeCheck(generation)
      .catch((err) => this.log.warn("auto-upgrade check failed", { error: String(err) }))
      .finally(() => {
        if (this.autoUpgradeCheckInFlight?.promise === check) this.autoUpgradeCheckInFlight = null;
      });
    this.autoUpgradeCheckInFlight = { generation, promise: check };
    return check;
  }

  async runAutoUpgradeCheck(generation = this.autoUpgradeGeneration): Promise<void> {
    if (!this.isAutoUpgradeGenerationActive(generation)) return;
    const status = this.lifecycle.getStatus();
    const version = status.version;
    if (status.environment !== "production" || !isProductionVersion(version)) return;
    const config = this.effectiveAutoUpdateConfig();
    const now = new Date();

    // npm 只在窗口内查询；成功查询一次后，本窗口只复用结果。
    // 查询失败不写 fetchedWindow，下一轮仍可重试。
    if (!isInUpgradeWindow(now, config)) return;
    if (minutesUntilUpgradeWindowEnd(now, config) < config.marginMinutes) return;

    const windowKey = autoUpgradeWindowKey(now, config);
    let latest = this.autoUpgradeLatestCache;
    if (windowKey !== this.autoUpgradeFetchedWindow) {
      try {
        latest = await this.fetchLatestVersion();
      } catch (err) {
        this.autoUpgradeFetchRetryWindow = windowKey;
        this.log.warn("auto-upgrade check: fetch failed", { error: String(err) });
        return;
      }
      if (!this.isAutoUpgradeGenerationActive(generation)) return;
      this.autoUpgradeFetchRetryWindow = "";
      this.autoUpgradeFetchedWindow = windowKey;
      this.autoUpgradeLatestCache = latest
        && isProductionVersion(latest)
        && isNewerPackageVersion(latest, version)
        ? latest
        : null;
    }
    if (!latest || !isNewerPackageVersion(latest, version)) {
      this.autoUpgradeLatestCache = null;
      return;
    }
    await this.maybeRunAutoUpgrade(latest, generation);
  }

  async runDailyCheck(): Promise<void> {
    if (!this.running) return;
    await this.maybeReportUpgradeResult();
    if (!this.running || this.isAutoUpdateEnabled()) return;
    if (localWeekday(new Date(), TZ) !== UPDATE_REMINDER_WEEKDAY) return;
    const status = this.lifecycle.getStatus();
    const version = status.version;
    if (status.environment !== "production" || !isProductionVersion(version)) return;
    let latest: string | null;
    try {
      latest = await this.fetchLatestVersion();
    } catch (err) {
      this.log.warn("update check failed", { error: String(err) });
      return;
    }
    if (!this.running || !latest) return;
    if (!isNewerPackageVersion(latest, version)) return;
    await this.notifyUpdateAvailable(latest);
  }

  private async maybeRunAutoUpgrade(latest: string, generation: number): Promise<void> {
    if (!this.isAutoUpgradeGenerationActive(generation)) return;
    const config = this.effectiveAutoUpdateConfig();
    if (!isProductionVersion(latest)) return;

    const beforeDownload = new Date();
    if (!isInUpgradeWindow(beforeDownload, config)) return;
    if (minutesUntilUpgradeWindowEnd(beforeDownload, config) < config.marginMinutes) return;

    const predownloaded = await this.lifecycle.predownloadUpdate(latest).catch((err) => {
      this.log.warn("auto-upgrade predownload failed", { latest, error: String(err) });
      return false;
    });
    if (!this.isAutoUpgradeGenerationActive(generation)) return;

    const afterDownload = new Date();
    if (!isInUpgradeWindow(afterDownload, config)) return;
    if (minutesUntilUpgradeWindowEnd(afterDownload, config) < config.marginMinutes) return;

    const sources = this.buildSafenessSources();
    const firstCheck = isSafeForUpgrade(sources, afterDownload.getTime(), UPGRADE_SAFENESS_WINDOW_MS);
    if (!firstCheck.safe) {
      this.log.info("auto-upgrade deferred: engine busy", { latest, blockers: firstCheck.blockers });
      return;
    }
    const secondCheck = isSafeForUpgrade(this.buildSafenessSources(), Date.now(), UPGRADE_SAFENESS_WINDOW_MS);
    if (!secondCheck.safe || !this.isAutoUpgradeGenerationActive(generation)) return;

    this.log.info("auto-upgrade starting", { latest, version: this.lifecycle.getStatus().version, predownloaded });
    try {
      this.triggerRestart(latest);
      this.autoUpgradeLatestCache = null;
    } catch (err) {
      this.log.warn("auto-upgrade trigger failed", { latest, error: String(err) });
    }
  }

  private isAutoUpgradeGenerationActive(generation: number): boolean {
    return this.running
      && generation === this.autoUpgradeGeneration
      && this.isAutoUpdateEnabled();
  }

  private buildSafenessSources(): UpgradeSafenessSource[] {
    return this.participants.flatMap((participant) => participant.getUpgradeSafenessSources());
  }

  private async fetchLatestVersion(): Promise<string | null> {
    return (await this.lifecycle.checkForUpdate()).latestVersion;
  }

  private triggerRestart(latest: string): void {
    this.lifecycle.restart({
      botName: this.notificationTarget.id,
      autoUpdate: true,
      updateVersion: latest,
    });
  }

  private getAdminPrivatePlatformChatIds(): string[] {
    const rows = this.notificationTarget.db.prepare(`
      SELECT DISTINCT c.platform_id
      FROM chats c
      JOIN users u ON u.platform = c.platform AND u.platform_id = c.user_id
      WHERE c.type = 'p2p'
        AND u.is_admin IN ('admin', 'owner')
        AND c.platform = ?
    `).all(this.notificationTarget.platform) as Array<{ platform_id: string }>;
    return rows.map((row) => row.platform_id);
  }

  private async notifyUpdateAvailable(latest: string): Promise<void> {
    const target = this.notificationTarget;
    if (hasUpdateNotification(target.db, target.id, latest)) return;
    const version = this.lifecycle.getStatus().version;
    const text = `发现新版本：${version} → ${latest}\n发送 \`${UPDATE_CONFIRM_COMMAND}\` 升级并重启。`;
    let delivered = false;
    for (const platformChatId of this.getAdminPrivatePlatformChatIds()) {
      try {
        await target.transport.sendCard(platformChatId, "Update", text);
        delivered = true;
      } catch (err) {
        this.log.warn("failed to send update notification", { platformChatId, error: String(err) });
      }
    }
    if (delivered) recordUpdateNotification(target.db, target.id, latest);
  }

  private async maybeReportUpgradeResult(): Promise<void> {
    if (this.upgradeResultReported || !this.effectiveAutoUpdateConfig().notifyOnResult) return;
    const stateFile = path.join(path.dirname(this.notificationTarget.dbPath), "restart", "state.json");
    const state = readRestartState(stateFile);
    if (!state?.autoUpdate || state.phase !== "success" || state.autoUpdateReportedAt) return;

    let delivered = false;
    const version = this.lifecycle.getStatus().version;
    const text = `已自动升级到 **${version}**。`;
    for (const platformChatId of this.getAdminPrivatePlatformChatIds()) {
      try {
        await this.notificationTarget.transport.sendCard(platformChatId, "Update", text);
        delivered = true;
      } catch (err) {
        this.log.warn("failed to send auto-upgrade result", { platformChatId, error: String(err) });
      }
    }
    if (!delivered) return;
    try {
      markAutoUpdateReported(stateFile, state.id);
    } catch (err) {
      this.log.warn("failed to persist auto-upgrade report marker", { error: String(err) });
    }
    recordUpdateNotification(this.notificationTarget.db, this.notificationTarget.id, version);
    this.upgradeResultReported = true;
  }

  private migrateLegacyAutoUpdateSetting(): void {
    const db = this.notificationTarget.db;
    let row: { value: string } | undefined;
    try {
      row = db.prepare("SELECT value FROM settings WHERE key = ?")
        .get(LEGACY_AUTO_UPDATE_ENABLED_KEY) as { value: string } | undefined;
    } catch (err) {
      this.log.warn("failed to read legacy auto-update setting", { error: String(err) });
      return;
    }
    if (!row || (row.value !== "0" && row.value !== "1")) return;

    const enabled = row.value === "1" && this.lifecycle.getAutoUpdateConfig()?.enabled === true;
    if (!this.lifecycle.canPersistAutoUpdate()) {
      this.deleteLegacyAutoUpdateSetting();
      return;
    }
    try {
      this.lifecycle.setAutoUpdateEnabled(enabled);
      this.deleteLegacyAutoUpdateSetting();
      this.log.info("legacy auto-update setting migrated to config", { enabled });
    } catch (err) {
      this.log.warn("failed to migrate legacy auto-update setting", { enabled, error: String(err) });
    }
  }

  private deleteLegacyAutoUpdateSetting(): void {
    try {
      this.notificationTarget.db.prepare("DELETE FROM settings WHERE key = ?").run(LEGACY_AUTO_UPDATE_ENABLED_KEY);
    } catch (err) {
      this.log.warn("failed to delete legacy auto-update setting", { error: String(err) });
    }
  }
}

function localWeekday(date: Date, timezone: string): number {
  const { year, month, day } = getZonedDateTimeParts(date, timezone);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

/** 标识一个本地升级窗口；跨午夜窗口在午夜后仍归到前一天。 */
function autoUpgradeWindowKey(date: Date, config: AutoUpdateConfig): string {
  const localDate = dateInTimeZone(date, config.timezone);
  const prefix = `${config.timezone}:${config.windowStartHour}-${config.windowEndHour}`;
  if (config.windowStartHour <= config.windowEndHour) return `${prefix}:${localDate}`;
  const localHour = getZonedDateTimeParts(date, config.timezone).hour;
  if (localHour >= config.windowStartHour) return `${prefix}:${localDate}`;
  const previous = new Date(`${localDate}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  return `${prefix}:${previous.toISOString().slice(0, 10)}`;
}
