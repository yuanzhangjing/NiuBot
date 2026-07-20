/**
 * Time utilities.
 *
 * Instants are persisted and compared as UTC. Calendar input and human-facing
 * output use the configured IANA timezone (NIUBOT_TZ).
 */

/** Configured timezone (IANA name). */
export const TZ = process.env["NIUBOT_TZ"] || Intl.DateTimeFormat().resolvedOptions().timeZone;

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
