import type Database from "better-sqlite3";
import type { AgentBackend } from "../agent/types.js";
import { createLogger } from "../logger.js";
import { generateSummary } from "./llm.js";
import { dailyPrompt, weeklyPrompt, overviewPrompt } from "./prompts.js";
import {
  getOverview,
  upsertOverview,
  upsertDaily,
  listDailies,
  upsertWeekly,
  listWeeklies,
  toMonday,
  toSunday,
} from "../memory/chat-summary.js";
import { localToday, localYesterday, localDateStartUTC, nextDay, sqlTZModifier } from "../tz.js";

const log = createLogger("summarizer");

/** 最大回溯 4 周 */
const MAX_LOOKBACK_WEEKS = 4;

/** 消息截断限制（字符数），防止 prompt 过长 */
const MAX_MESSAGE_CHARS = 50000;

interface DayStats {
  day: string;
  count: number;
  startId: number;
  endId: number;
}

/** 获取指定 chat 在 since 之后每天的消息统计（按本地日期分组，排除今天） */
function getDailyMessageStats(db: Database.Database, chatId: string, since: string): DayStats[] {
  const todayStartUTC = localDateStartUTC(localToday());
  const sinceUTC = localDateStartUTC(since);
  const tzMod = sqlTZModifier();

  const rows = db.prepare(`
    SELECT SUBSTR(datetime(created_at, '${tzMod}'), 1, 10) as day,
           COUNT(*) as cnt,
           MIN(id) as start_id,
           MAX(id) as end_id
    FROM messages
    WHERE chat_id = ? AND created_at >= ? AND created_at < ?
    GROUP BY 1
    ORDER BY day
  `).all(chatId, sinceUTC, todayStartUTC) as Array<{ day: string; cnt: number; start_id: number; end_id: number }>;

  return rows.map((r) => ({ day: r.day, count: r.cnt, startId: r.start_id, endId: r.end_id }));
}

/** 获取指定 chat 某天（本地日期）的消息文本 */
function getDayMessages(db: Database.Database, chatId: string, date: string): string {
  const dateStartUTC = localDateStartUTC(date);
  const dateEndUTC = localDateStartUTC(nextDay(date));
  const rows = db.prepare(`
    SELECT u.name, m.role, m.content_text
    FROM messages m
    LEFT JOIN users u ON m.sender_id = u.id
    WHERE m.chat_id = ? AND m.created_at >= ? AND m.created_at < ?
    ORDER BY m.id
  `).all(chatId, dateStartUTC, dateEndUTC) as Array<{ name: string | null; role: string; content_text: string | null }>;

  let result = "";
  for (const r of rows) {
    const sender = r.name ?? (r.role === "assistant" ? "Bot" : "User");
    const text = r.content_text ?? "";
    result += `[${sender}] ${text}\n`;
    if (result.length > MAX_MESSAGE_CHARS) {
      result += "\n...(消息过多，已截断)";
      break;
    }
  }
  return result;
}

/** 获取有新消息的 chat 列表 */
function getActiveChats(db: Database.Database, since: string): string[] {
  const rows = db.prepare(
    "SELECT DISTINCT chat_id FROM messages WHERE created_at >= ?",
  ).all(since) as Array<{ chat_id: string }>;

  return rows.map((r) => r.chat_id);
}

/** 计算回溯起点（4 周前的周一，基于本地日期） */
function maxSince(): string {
  const monday = toMonday(localToday());
  const d = new Date(monday + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - MAX_LOOKBACK_WEEKS * 7);
  return d.toISOString().slice(0, 10);
}

/** 对单个 chat 执行完整的摘要流水线 */
async function summarizeChat(db: Database.Database, agent: AgentBackend, chatId: string, since: string): Promise<void> {
  const dayStats = getDailyMessageStats(db, chatId, since);
  if (dayStats.length === 0) {
    log.debug("no messages to summarize", { chatId });
    return;
  }

  let dailyGenerated = false;
  let weeklyGenerated = false;

  // Phase 1: 生成 daily
  const existingDailies = new Set(
    listDailies(db, chatId, { limit: 100 }).map((d) => d.period),
  );

  for (const ds of dayStats) {
    if (existingDailies.has(ds.day)) {
      log.debug("daily already exists, skipping", { chatId, day: ds.day });
      continue;
    }

    log.info("generating daily", { chatId, day: ds.day, messages: ds.count });

    try {
      const messages = getDayMessages(db, chatId, ds.day);
      const prompt = dailyPrompt(ds.day, messages);
      const result = await generateSummary(agent, prompt);
      upsertDaily(db, chatId, ds.day, result.summary, result.detail, ds.startId, ds.endId);
      dailyGenerated = true;
      log.info("daily generated", { chatId, day: ds.day });
    } catch (err) {
      log.error("daily generation failed", { chatId, day: ds.day, error: String(err) });
    }
  }

  // Phase 2: 生成 weekly
  const yesterdayStr = localYesterday();

  const existingWeeklies = new Set(
    listWeeklies(db, chatId, { limit: 20 }).map((w) => w.period),
  );

  // 从 since 的周一开始，遍历每周
  let monday = toMonday(since);
  while (monday <= yesterdayStr) {
    const sunday = toSunday(monday);

    // 只处理已完成的周（周日 <= 昨天）
    if (sunday > yesterdayStr) break;

    if (!existingWeeklies.has(monday)) {
      const weekDailies = listDailies(db, chatId, { since: monday, before: toNextDay(sunday), limit: 7 });

      if (weekDailies.length > 0) {
        log.info("generating weekly", { chatId, monday, dailyCount: weekDailies.length });

        try {
          const dailyText = weekDailies
            .sort((a, b) => (a.period ?? "").localeCompare(b.period ?? ""))
            .map((d) => `【${d.period}】${d.summary}${d.detail ? "\n" + d.detail : ""}`)
            .join("\n\n");

          const prompt = weeklyPrompt(monday, sunday, dailyText);
          const result = await generateSummary(agent, prompt);
          upsertWeekly(db, chatId, monday, result.summary, result.detail);
          weeklyGenerated = true;
          log.info("weekly generated", { chatId, monday });
        } catch (err) {
          log.error("weekly generation failed", { chatId, monday, error: String(err) });
        }
      }
    }

    // 下一周
    const nextMon = new Date(monday + "T00:00:00Z");
    nextMon.setUTCDate(nextMon.getUTCDate() + 7);
    monday = nextMon.toISOString().slice(0, 10);
  }

  // Phase 3: 更新 overview
  if (dailyGenerated || weeklyGenerated) {
    log.info("updating overview", { chatId });

    try {
      const currentOverview = getOverview(db, chatId);
      const allDailies = listDailies(db, chatId, { limit: 30 });
      const allWeeklies = listWeeklies(db, chatId, { limit: 8 });

      // 筛选 overview 之后的新条目
      const overviewDate = currentOverview?.period ?? "1970-01-01";
      const weeklyPeriods = allWeeklies.map((w) => w.period!);

      const newEntries: Array<{ sortKey: string; text: string }> = [];

      for (const w of allWeeklies) {
        if (toSunday(w.period!) > overviewDate) {
          const sun = toSunday(w.period!);
          newEntries.push({
            sortKey: sun,
            text: `【weekly ${w.period}~${sun}】${w.summary}${w.detail ? "\n" + w.detail : ""}`,
          });
        }
      }

      for (const d of allDailies) {
        if (d.period! <= overviewDate) continue;
        const covered = weeklyPeriods.some((mon) => d.period! >= mon && d.period! <= toSunday(mon));
        if (!covered) {
          newEntries.push({
            sortKey: d.period!,
            text: `【daily ${d.period}】${d.summary}${d.detail ? "\n" + d.detail : ""}`,
          });
        }
      }

      if (newEntries.length > 0) {
        newEntries.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
        const newText = newEntries.map((e) => e.text).join("\n\n");

        const currentText = currentOverview
          ? `summary: ${currentOverview.summary}\ndetail:\n${currentOverview.detail}`
          : null;

        const prompt = overviewPrompt(currentText, newText);
        const result = await generateSummary(agent, prompt);

        // 计算最新覆盖日期
        const latestDate = [...allDailies.map((d) => d.period!), ...allWeeklies.map((w) => toSunday(w.period!))].sort().pop();

        upsertOverview(db, chatId, result.summary, result.detail, latestDate);
        log.info("overview updated", { chatId, latestDate });
      }
    } catch (err) {
      log.error("overview generation failed", { chatId, error: String(err) });
    }
  }
}

/** 日期 +1 天 */
function toNextDay(dateStr: string): string {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** 执行一次完整的摘要任务（所有活跃 chat） */
export async function runSummarize(db: Database.Database, agent: AgentBackend): Promise<void> {
  const since = maxSince();
  const chats = getActiveChats(db, since);

  log.info("summarize started", { since, chatCount: chats.length });

  for (const chatId of chats) {
    try {
      await summarizeChat(db, agent, chatId, since);
    } catch (err) {
      log.error("summarize failed for chat", { chatId, error: String(err) });
    }
  }

  log.info("summarize completed");
}

/** 启动定时摘要任务（每天 UTC 20:00 = CST 4:00） */
export function startSummarizer(db: Database.Database, agent: AgentBackend, hourUTC = 20): { stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const schedule = () => {
    if (stopped) return;

    const now = new Date();
    const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hourUTC));
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1);
    }

    const delay = next.getTime() - now.getTime();
    log.info("summarizer scheduled", { nextRun: next.toISOString(), delayMs: delay });

    timer = setTimeout(async () => {
      try {
        await runSummarize(db, agent);
      } catch (err) {
        log.error("summarizer run failed", { error: String(err) });
      }
      schedule(); // 调度下一次
    }, delay);
  };

  schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      log.info("summarizer stopped");
    },
  };
}
