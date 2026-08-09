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
import { dateInTimeZone, millisecondsUntilLocalHour, TZ } from "./tz.js";
import { isNewerPackageVersion, isPrereleaseOrUnrecognizedVersion } from "./version.js";
import { markAutoUpdateReported, readRestartState } from "./restart-state.js";
import type { EngineLifecycle } from "./engine-lifecycle.js";

const UPDATE_CONFIRM_COMMAND = "/update 1";
const UPDATE_CHECK_HOUR = 10;
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
  private autoUpgradeTimer: ReturnType<typeof setInterval> | null = null;
  private autoUpgradeFetchedDay = "";
  private autoUpgradeLatestCache: string | null = null;
  private autoUpgradeCheckInFlight: Promise<void> | null = null;
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
    this.scheduleAutoUpgradeCheck();
    this.log.info("engine auto-update coordinator started", {
      participantCount: this.participants.length,
      notificationBot: this.notificationTarget.id,
    });
  }

  stop(): void {
    if (!this.running && !this.updateCheckTimer && !this.autoUpgradeTimer) return;
    this.running = false;
    this.updateCheckGeneration++;
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

  /** 任意 Bot 修改共享配置后调用；开启时立即做一次 Engine 级检查。 */
  configChanged(): void {
    if (!this.running || !this.isAutoUpdateEnabled()) return;
    void this.requestAutoUpgradeCheck();
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

  private scheduleAutoUpgradeCheck(): void {
    if (!this.running) return;
    if (this.autoUpgradeTimer) clearInterval(this.autoUpgradeTimer);
    if (this.isAutoUpdateEnabled()) void this.requestAutoUpgradeCheck();
    this.autoUpgradeTimer = setInterval(() => {
      if (!this.isAutoUpdateEnabled()) return;
      void this.requestAutoUpgradeCheck();
    }, AUTO_UPGRADE_CHECK_INTERVAL_MS);
  }

  private requestAutoUpgradeCheck(): Promise<void> {
    if (this.autoUpgradeCheckInFlight) return this.autoUpgradeCheckInFlight;
    const check = this.runAutoUpgradeCheck()
      .catch((err) => this.log.warn("auto-upgrade check failed", { error: String(err) }))
      .finally(() => {
        if (this.autoUpgradeCheckInFlight === check) this.autoUpgradeCheckInFlight = null;
      });
    this.autoUpgradeCheckInFlight = check;
    return check;
  }

  async runAutoUpgradeCheck(): Promise<void> {
    if (!this.running || !this.isAutoUpdateEnabled()) return;
    const version = this.lifecycle.getStatus().version;
    if (isPrereleaseOrUnrecognizedVersion(version)) return;
    const config = this.effectiveAutoUpdateConfig();
    const now = new Date();
    const today = dateInTimeZone(now, config.timezone);

    let latest = this.autoUpgradeLatestCache;
    if (today === this.autoUpgradeFetchedDay) {
      if (latest === null || !isNewerPackageVersion(latest, version)) return;
    } else {
      try {
        latest = await this.fetchLatestVersion();
      } catch (err) {
        this.log.warn("auto-upgrade check: fetch failed", { error: String(err) });
        return;
      }
      this.autoUpgradeFetchedDay = today;
      this.autoUpgradeLatestCache = latest;
    }
    if (!latest || !isNewerPackageVersion(latest, version)) return;
    if (!isInUpgradeWindow(now, config)) return;
    if (minutesUntilUpgradeWindowEnd(now, config) < config.marginMinutes) return;
    await this.maybeRunAutoUpgrade(latest);
  }

  async runDailyCheck(): Promise<void> {
    const version = this.lifecycle.getStatus().version;
    if (!this.running || isPrereleaseOrUnrecognizedVersion(version)) return;
    let latest: string | null;
    try {
      latest = await this.fetchLatestVersion();
    } catch (err) {
      this.log.warn("update check failed", { error: String(err) });
      return;
    }
    if (!this.running || !latest) return;

    await this.maybeReportUpgradeResult();
    if (!isNewerPackageVersion(latest, version)) return;
    if (this.isAutoUpdateEnabled()) {
      await this.maybeRunAutoUpgrade(latest);
      return;
    }
    await this.notifyUpdateAvailable(latest);
  }

  private async maybeRunAutoUpgrade(latest: string): Promise<void> {
    if (!this.running || !this.isAutoUpdateEnabled()) return;
    const config = this.effectiveAutoUpdateConfig();
    if (isPrereleaseOrUnrecognizedVersion(latest)) return;

    const beforeDownload = new Date();
    if (!isInUpgradeWindow(beforeDownload, config)) return;
    if (minutesUntilUpgradeWindowEnd(beforeDownload, config) < config.marginMinutes) return;

    const predownloaded = await this.lifecycle.predownloadUpdate(latest).catch((err) => {
      this.log.warn("auto-upgrade predownload failed", { latest, error: String(err) });
      return false;
    });
    if (!this.running || !this.isAutoUpdateEnabled()) return;

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
    if (!secondCheck.safe || !this.running || !this.isAutoUpdateEnabled()) return;

    this.log.info("auto-upgrade starting", { latest, version: this.lifecycle.getStatus().version, predownloaded });
    try {
      this.triggerRestart(latest);
    } catch (err) {
      this.log.warn("auto-upgrade trigger failed", { latest, error: String(err) });
    }
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
