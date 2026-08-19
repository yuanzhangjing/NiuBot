/**
 * Time utilities.
 *
 * Instants are persisted and compared as UTC. Calendar input and human-facing
 * output use one display timezone: config.yaml `timezone`, else NIUBOT_TZ, else Asia/Shanghai.
 */

export const DEFAULT_TIMEZONE = "Asia/Shanghai";

const TIMEZONE_ALIASES: Record<string, string> = {
  "北京": DEFAULT_TIMEZONE,
  "上海": DEFAULT_TIMEZONE,
  beijing: DEFAULT_TIMEZONE,
  shanghai: DEFAULT_TIMEZONE,
  china: DEFAULT_TIMEZONE,
  cn: DEFAULT_TIMEZONE,
  utc: "UTC",
  "东京": "Asia/Tokyo",
  tokyo: "Asia/Tokyo",
  japan: "Asia/Tokyo",
  "日本": "Asia/Tokyo",
  "大阪": "Asia/Tokyo",
  "首尔": "Asia/Seoul",
  seoul: "Asia/Seoul",
  "韩国": "Asia/Seoul",
  "香港": "Asia/Hong_Kong",
  hongkong: "Asia/Hong_Kong",
  "台北": "Asia/Taipei",
  taipei: "Asia/Taipei",
  "新加坡": "Asia/Singapore",
  singapore: "Asia/Singapore",
  "纽约": "America/New_York",
  newyork: "America/New_York",
  "new york": "America/New_York",
  nyc: "America/New_York",
  "洛杉矶": "America/Los_Angeles",
  losangeles: "America/Los_Angeles",
  "los angeles": "America/Los_Angeles",
  "旧金山": "America/Los_Angeles",
  sanfrancisco: "America/Los_Angeles",
  "san francisco": "America/Los_Angeles",
  "西雅图": "America/Los_Angeles",
  seattle: "America/Los_Angeles",
  "hong kong": "Asia/Hong_Kong",
  "伦敦": "Europe/London",
  london: "Europe/London",
  "巴黎": "Europe/Paris",
  paris: "Europe/Paris",
  "柏林": "Europe/Berlin",
  berlin: "Europe/Berlin",
  "悉尼": "Australia/Sydney",
  sydney: "Australia/Sydney",
};

/** Current display timezone (IANA name). */
export let TZ = resolveInitialTimezone();

export function isValidTimeZone(timezone: string): boolean {
  try {
    Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function resolveIanaToken(token: string): string | undefined {
  const titled = token.split("/").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("/");
  if (isValidTimeZone(titled)) return titled;
  if (titled !== token && isValidTimeZone(token)) return token;
  return undefined;
}

/** Resolve IANA names, aliases, or a short natural-language phrase. */
export function normalizeTimeZoneInput(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();
  const compact = lower.replace(/[\s_-]+/g, "");
  const exact = TIMEZONE_ALIASES[lower] ?? TIMEZONE_ALIASES[trimmed] ?? TIMEZONE_ALIASES[compact];
  if (exact) return exact;
  const exactIana = resolveIanaToken(trimmed);
  if (exactIana) return exactIana;

  let best: { index: number; length: number; timezone: string } | undefined;
  const consider = (index: number, length: number, timezone: string) => {
    if (index < 0) return;
    if (!best || index > best.index || (index === best.index && length > best.length)) {
      best = { index, length, timezone };
    }
  };

  for (const [alias, timezone] of Object.entries(TIMEZONE_ALIASES)) {
    const aliasLower = alias.toLowerCase();
    if (/^[a-z]{1,3}$/i.test(alias)) {
      const re = new RegExp(`(?<![a-z])${aliasLower}(?![a-z])`, "g");
      let match: RegExpExecArray | null;
      while ((match = re.exec(lower))) consider(match.index, alias.length, timezone);
      continue;
    }
    consider(trimmed.lastIndexOf(alias), alias.length, timezone);
    consider(lower.lastIndexOf(aliasLower), aliasLower.length, timezone);
  }
  if (best) return best.timezone;

  const iana = trimmed.match(/[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)+/);
  if (iana?.[0]) return resolveIanaToken(iana[0]);
  return undefined;
}

const TZ_CHANGE_INTENT_RE = /改成|换成|设成|设为|调成|切到|切换到/;
const TZ_TOPIC_RE = /时区|时间/;

/** True for utterances like「帮我改成北京时区」「改成北京时间」— not `/tz` itself. */
export function isTimezoneChangeUtterance(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith("/")) return false;
  if (!TZ_CHANGE_INTENT_RE.test(trimmed) || !TZ_TOPIC_RE.test(trimmed)) return false;
  return Boolean(normalizeTimeZoneInput(trimmed));
}

/** `/tz` args the builtin can handle locally. Unknown names should fall through to the agent. */
export function timezoneCommandIsResolved(args: string[]): boolean {
  if (args.length === 0) return true;
  const action = args[0]!.toLowerCase();
  if (action === "reset" || action === "get" || action === "show" || action === "help") return true;
  return Boolean(normalizeTimeZoneInput(args.join(" ")));
}

export function setDisplayTimezone(timezone: string): void {
  const resolved = normalizeTimeZoneInput(timezone);
  if (!resolved) throw new Error(`未知时区: ${timezone}`);
  TZ = resolved;
}

/** Startup: config.yaml (from /tz) wins, then NIUBOT_TZ, then Beijing. */
export function applyDisplayTimezone(options: { env?: string; config?: string } = {}): string {
  const config = options.config?.trim();
  if (config && isValidTimeZone(config)) {
    TZ = config;
    return TZ;
  }
  const env = options.env?.trim();
  if (env && isValidTimeZone(env)) {
    TZ = env;
    return TZ;
  }
  TZ = DEFAULT_TIMEZONE;
  return TZ;
}

function resolveInitialTimezone(): string {
  const fromEnv = process.env["NIUBOT_TZ"]?.trim();
  if (fromEnv && isValidTimeZone(fromEnv)) return fromEnv;
  return DEFAULT_TIMEZONE;
}

export interface ZonedDateTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export interface UtcTimeRange {
  since?: string;
  before?: string;
}

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const LOCAL_DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/;
const EXPLICIT_ZONE_RE = /(?:Z|[+-]\d{2}:?\d{2})$/i;

/** Get a Date's calendar fields in an IANA timezone. */
export function getZonedDateTimeParts(date: Date, timeZone: string = TZ): ZonedDateTimeParts {
  assertValidDate(date, "date");
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    calendar: "gregory",
    numberingSystem: "latn",
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const values = new Map(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(values.get("year")),
    month: Number(values.get("month")),
    day: Number(values.get("day")),
    hour: Number(values.get("hour")),
    minute: Number(values.get("minute")),
    second: Number(values.get("second")),
  };
}

/** Format a Date as YYYY-MM-DD in an IANA timezone. */
export function dateInTimeZone(date: Date = new Date(), timeZone: string = TZ): string {
  const parts = getZonedDateTimeParts(date, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)}`;
}

/** Format a Date as YYYY-MM-DD HH:MM:SS in an IANA timezone. */
export function dateTimeInTimeZone(date: Date = new Date(), timeZone: string = TZ): string {
  const parts = getZonedDateTimeParts(date, timeZone);
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

/** Get today's date (YYYY-MM-DD) in the configured timezone. */
export function localToday(): string {
  return dateInTimeZone();
}

/** Get yesterday's date (YYYY-MM-DD) in the configured timezone. */
export function localYesterday(): string {
  return addCalendarDays(localToday(), -1);
}

/** Convert a UTC datetime from DB to HH:MM in an IANA timezone. */
export function utcToLocalHHMM(utcDatetime: string, timeZone: string = TZ): string {
  return dateTimeInTimeZone(parseUTC(utcDatetime), timeZone).slice(11, 16);
}

/** Convert a UTC datetime from DB to YYYY-MM-DD HH:MM in an IANA timezone. */
export function utcToLocalDateTime(utcDatetime: string, timeZone: string = TZ): string {
  return dateTimeInTimeZone(parseUTC(utcDatetime), timeZone).slice(0, 16);
}

/** Convert a UTC datetime from DB to local display text with timezone label. */
export function formatLocalDateTimeWithTZ(utcDatetime: string, timeZone: string = TZ): string {
  return `${utcToLocalDateTime(utcDatetime, timeZone)} (${timeZone})`;
}

/** Label an already-local datetime string with an IANA timezone. */
export function labelLocalDateTime(localDatetime: string, timeZone: string = TZ): string {
  return `${localDatetime} (${timeZone})`;
}

/** Label a cron expression or schedule as using local calendar time. */
export function labelLocalTime(text: string, timeZone: string = TZ): string {
  return `${text} (local time, ${timeZone})`;
}

/** Format a Date as canonical UTC YYYY-MM-DD HH:MM:SS for SQLite. */
export function utcDateTimeForSql(date: Date): string {
  assertValidDate(date, "date");
  return date.toISOString().slice(0, 19).replace("T", " ");
}

/** Parse user date/datetime input and return canonical UTC SQLite text. */
export function userDateTimeToUtcSql(value: string, timeZone: string = TZ): string {
  const input = value.trim();
  const dateMatch = LOCAL_DATE_RE.exec(input);
  if (dateMatch) {
    return utcDateTimeForSql(zonedDateTimeToDate(partsFromMatch(dateMatch, false), timeZone));
  }

  const datetimeMatch = LOCAL_DATETIME_RE.exec(input);
  if (datetimeMatch) {
    return utcDateTimeForSql(zonedDateTimeToDate(partsFromMatch(datetimeMatch, true), timeZone));
  }

  if (EXPLICIT_ZONE_RE.test(input)) {
    const date = new Date(input);
    assertValidDate(date, `datetime: ${value}`);
    return utcDateTimeForSql(date);
  }

  throw new Error(
    `Invalid datetime: ${value}. Use YYYY-MM-DD, YYYY-MM-DD HH:MM[:SS], or ISO 8601 with Z/offset.`,
  );
}

/** Normalize optional user range boundaries to canonical UTC SQLite text. */
export function userTimeRangeToUtc(range: UtcTimeRange, timeZone: string = TZ): UtcTimeRange {
  const normalized = {
    since: range.since ? userDateTimeToUtcSql(range.since, timeZone) : undefined,
    before: range.before ? userDateTimeToUtcSql(range.before, timeZone) : undefined,
  };
  if (normalized.since && normalized.before && normalized.since >= normalized.before) {
    throw new Error("--since must be earlier than --before");
  }
  return normalized;
}

/** Convert local calendar fields in an IANA timezone to an instant. */
export function zonedDateTimeToDate(parts: ZonedDateTimeParts, timeZone: string = TZ): Date {
  assertValidParts(parts);
  const wallClockUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  // Sample nearby offsets. This handles DST transitions and non-hour offsets.
  const offsets = new Set<number>();
  for (let deltaHours = -48; deltaHours <= 48; deltaHours += 6) {
    const probe = new Date(wallClockUtc + deltaHours * 3_600_000);
    offsets.add(timeZoneOffsetMs(probe, timeZone));
  }

  const matches: Date[] = [];
  for (const offset of offsets) {
    const candidate = new Date(wallClockUtc - offset);
    if (sameParts(getZonedDateTimeParts(candidate, timeZone), parts)) matches.push(candidate);
  }
  matches.sort((a, b) => a.getTime() - b.getTime());
  if (matches.length === 0) {
    throw new Error(`Local datetime does not exist in ${timeZone}: ${formatParts(parts)}`);
  }
  // During a fall-back overlap, choose the earlier occurrence deterministically.
  return matches[0]!;
}

/** Get the UTC datetime string for the start of a local date. */
export function localDateStartUTC(localDateStr: string, timeZone: string = TZ): string {
  const match = LOCAL_DATE_RE.exec(localDateStr.trim());
  if (!match) throw new Error(`Invalid date: ${localDateStr}`);
  return utcDateTimeForSql(zonedDateTimeToDate(partsFromMatch(match, false), timeZone));
}

/** Get next day's date string (YYYY-MM-DD). */
export function nextDay(dateStr: string): string {
  return addCalendarDays(dateStr, 1);
}

/** Return whether an ISO/UTC event timestamp is inside a half-open UTC range. */
export function instantIsInUtcRange(timestamp: string | undefined, range: UtcTimeRange): boolean {
  if (!timestamp) return !range.since && !range.before;
  const instant = parseInstant(timestamp).getTime();
  if (range.since && instant < parseUTC(range.since).getTime()) return false;
  if (range.before && instant >= parseUTC(range.before).getTime()) return false;
  return true;
}

/** Check a half-open local-hour window in an IANA timezone. */
export function isInLocalHourWindow(
  date: Date,
  startHour: number,
  endHour: number,
  timeZone: string = TZ,
): boolean {
  const hour = getZonedDateTimeParts(date, timeZone).hour;
  return hour >= startHour && hour < endHour;
}

/** Get milliseconds until the next occurrence of a local hour. */
export function millisecondsUntilLocalHour(date: Date, hour: number, timeZone: string = TZ): number {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) throw new Error(`Invalid hour: ${hour}`);
  let localDate = dateInTimeZone(date, timeZone);
  let [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
  let next = zonedDateTimeToDate({ year, month, day, hour, minute: 0, second: 0 }, timeZone);
  if (next.getTime() <= date.getTime()) {
    localDate = nextDay(localDate);
    [year, month, day] = localDate.split("-").map(Number) as [number, number, number];
    next = zonedDateTimeToDate({ year, month, day, hour, minute: 0, second: 0 }, timeZone);
  }
  return next.getTime() - date.getTime();
}

/** Get the current SQLite offset modifier. Prefer application-side conversion for historical dates. */
export function sqlTZModifier(): string {
  const totalMinutes = Math.round(timeZoneOffsetMs(new Date(), TZ) / 60_000);
  const sign = totalMinutes >= 0 ? "+" : "-";
  const h = Math.floor(Math.abs(totalMinutes) / 60);
  const m = Math.abs(totalMinutes) % 60;
  if (m === 0) return `${sign}${h} hours`;
  return `${sign}${Math.abs(totalMinutes)} minutes`;
}

/** Parse a canonical UTC DB timestamp or an ISO timestamp with explicit zone. */
export function parseInstant(value: string): Date {
  const input = value.trim();
  if (LOCAL_DATETIME_RE.test(input)) return parseUTC(input);
  if (!EXPLICIT_ZONE_RE.test(input)) throw new Error(`Timestamp has no timezone: ${value}`);
  const date = new Date(input);
  assertValidDate(date, `timestamp: ${value}`);
  return date;
}

function parseUTC(utcStr: string): Date {
  const normalized = utcStr.trim().replace(" ", "T");
  const date = new Date(EXPLICIT_ZONE_RE.test(normalized) ? normalized : normalized + "Z");
  assertValidDate(date, `UTC datetime: ${utcStr}`);
  return date;
}

function timeZoneOffsetMs(date: Date, timeZone: string): number {
  const parts = getZonedDateTimeParts(date, timeZone);
  const representedAsUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return representedAsUtc - Math.floor(date.getTime() / 1000) * 1000;
}

function partsFromMatch(match: RegExpExecArray, includesTime: boolean): ZonedDateTimeParts {
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: includesTime ? Number(match[4]) : 0,
    minute: includesTime ? Number(match[5]) : 0,
    second: includesTime ? Number(match[6] ?? 0) : 0,
  };
}

function assertValidParts(parts: ZonedDateTimeParts): void {
  const test = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second));
  const valid = test.getUTCFullYear() === parts.year
    && test.getUTCMonth() + 1 === parts.month
    && test.getUTCDate() === parts.day
    && test.getUTCHours() === parts.hour
    && test.getUTCMinutes() === parts.minute
    && test.getUTCSeconds() === parts.second;
  if (!valid) throw new Error(`Invalid local datetime: ${formatParts(parts)}`);
}

function assertValidDate(date: Date, label: string): void {
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${label}`);
}

function sameParts(left: ZonedDateTimeParts, right: ZonedDateTimeParts): boolean {
  return left.year === right.year
    && left.month === right.month
    && left.day === right.day
    && left.hour === right.hour
    && left.minute === right.minute
    && left.second === right.second;
}

function addCalendarDays(dateStr: string, days: number): string {
  const match = LOCAL_DATE_RE.exec(dateStr.trim());
  if (!match) throw new Error(`Invalid date: ${dateStr}`);
  const parts = partsFromMatch(match, false);
  assertValidParts(parts);
  const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + days));
  return date.toISOString().slice(0, 10);
}

function formatParts(parts: ZonedDateTimeParts): string {
  return `${pad(parts.year, 4)}-${pad(parts.month)}-${pad(parts.day)} ${pad(parts.hour)}:${pad(parts.minute)}:${pad(parts.second)}`;
}

function pad(value: number, length = 2): string {
  return String(value).padStart(length, "0");
}
