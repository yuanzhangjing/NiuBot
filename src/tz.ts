/**
 * Timezone utilities for converting UTC database timestamps to local time.
 *
 * Configure via NIUBOT_TZ env var (e.g., "Asia/Shanghai").
 * Falls back to system timezone.
 */

/** Configured timezone (IANA name) */
export const TZ = process.env["NIUBOT_TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Get today's date (YYYY-MM-DD) in configured timezone */
export function localToday(): string {
  return new Date().toLocaleDateString("sv-SE", { timeZone: TZ });
}

/** Get yesterday's date (YYYY-MM-DD) in configured timezone */
export function localYesterday(): string {
  const todayStr = localToday();
  const [y, m, d] = todayStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - 1));
  return dt.toISOString().slice(0, 10);
}

/** Convert a UTC datetime from DB (e.g. "2026-04-01 13:35:00") to HH:MM in configured timezone */
export function utcToLocalHHMM(utcDatetime: string): string {
  return parseUTC(utcDatetime).toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
}

/** Convert a UTC datetime from DB to "YYYY-MM-DD HH:MM" in configured timezone */
export function utcToLocalDateTime(utcDatetime: string): string {
  const d = parseUTC(utcDatetime);
  const date = d.toLocaleDateString("sv-SE", { timeZone: TZ });
  const time = d.toLocaleTimeString("en-GB", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  return `${date} ${time}`;
}

/**
 * Get the UTC datetime string for the start of a local date (00:00 local → UTC).
 * Used for SQL range queries against UTC timestamps in the database.
 *
 * Example: "2026-04-02" in Asia/Shanghai (UTC+8) → "2026-04-01 16:00:00"
 */
export function localDateStartUTC(localDateStr: string): string {
  const [y, m, d] = localDateStr.split("-").map(Number);
  // Use noon UTC to compute offset (avoids DST edge cases)
  const noon = new Date(Date.UTC(y, m - 1, d, 12));
  const utcParts = noon.toLocaleString("en-US", { timeZone: "UTC" });
  const tzParts = noon.toLocaleString("en-US", { timeZone: TZ });
  const offsetMs = new Date(tzParts).getTime() - new Date(utcParts).getTime();
  const midnight = new Date(Date.UTC(y, m - 1, d) - offsetMs);
  return midnight.toISOString().slice(0, 19).replace("T", " ");
}

/** Get next day's date string (YYYY-MM-DD) */
export function nextDay(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return dt.toISOString().slice(0, 10);
}

/**
 * Get the SQLite datetime modifier for UTC → local conversion.
 * E.g., "+8 hours" for Asia/Shanghai.
 */
export function sqlTZModifier(): string {
  const now = new Date();
  const utcStr = now.toLocaleString("en-US", { timeZone: "UTC" });
  const tzStr = now.toLocaleString("en-US", { timeZone: TZ });
  const offsetMs = new Date(tzStr).getTime() - new Date(utcStr).getTime();
  const totalMinutes = Math.round(offsetMs / 60000);
  const sign = totalMinutes >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(totalMinutes) / 60);
  const m = Math.abs(totalMinutes) % 60;
  if (m === 0) return `${sign}${h} hours`;
  return `${sign}${Math.abs(totalMinutes)} minutes`;
}

/** Parse a UTC datetime string from DB to Date object */
function parseUTC(utcStr: string): Date {
  const normalized = utcStr.replace(" ", "T");
  return new Date(normalized.endsWith("Z") ? normalized : normalized + "Z");
}
