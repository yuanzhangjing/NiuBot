import { describe, expect, it } from "vitest";
import {
  dateTimeInTimeZone,
  formatLocalDateTimeWithTZ,
  isInLocalHourWindow,
  labelLocalDateTime,
  labelLocalTime,
  millisecondsUntilLocalHour,
  userDateTimeToUtcSql,
  userTimeRangeToUtc,
  utcDateTimeForSql,
  zonedDateTimeToDate,
} from "./tz.js";

describe("timezone display helpers", () => {
  it("labels local time with the configured timezone", () => {
    const formatted = formatLocalDateTimeWithTZ("2026-04-24 16:30:00");

    expect(formatted).toContain("(");
    expect(formatted).toContain(")");
  });

  it("labels already-local schedule text without converting it", () => {
    expect(labelLocalDateTime("2026-04-25 10:00")).toContain("2026-04-25 10:00 (");
    expect(labelLocalTime("0 10 * * *")).toContain("0 10 * * * (local time, ");
  });

  it("formats UTC Date values for SQLite datetime comparisons", () => {
    const dt = new Date("2026-04-24T16:30:05.123Z");

    expect(utcDateTimeForSql(dt)).toBe("2026-04-24 16:30:05");
  });

  it("converts local calendar input and explicit offsets to canonical UTC", () => {
    expect(userDateTimeToUtcSql("2026-07-20", "Asia/Shanghai")).toBe("2026-07-19 16:00:00");
    expect(userDateTimeToUtcSql("2026-07-20 10:30:15", "Asia/Shanghai")).toBe("2026-07-20 02:30:15");
    expect(userDateTimeToUtcSql("2026-07-20T10:30:15+08:00", "America/New_York")).toBe("2026-07-20 02:30:15");
  });

  it("normalizes half-open query ranges and rejects reversed ranges", () => {
    expect(userTimeRangeToUtc({ since: "2026-07-20", before: "2026-07-21" }, "Asia/Shanghai")).toEqual({
      since: "2026-07-19 16:00:00",
      before: "2026-07-20 16:00:00",
    });
    expect(() => userTimeRangeToUtc({ since: "2026-07-21", before: "2026-07-20" }, "UTC"))
      .toThrow("--since must be earlier than --before");
  });

  it("handles DST gaps and overlaps deterministically", () => {
    expect(() => userDateTimeToUtcSql("2026-03-08 02:30:00", "America/New_York"))
      .toThrow("does not exist");
    expect(userDateTimeToUtcSql("2026-11-01 01:30:00", "America/New_York"))
      .toBe("2026-11-01 05:30:00");
  });

  it("uses the requested timezone instead of the operating-system timezone", () => {
    const instant = new Date("2026-07-20T02:00:00Z");
    expect(dateTimeInTimeZone(instant, "Asia/Shanghai")).toBe("2026-07-20 10:00:00");
    expect(zonedDateTimeToDate({
      year: 2026, month: 7, day: 20, hour: 10, minute: 0, second: 0,
    }, "Asia/Shanghai").toISOString()).toBe("2026-07-20T02:00:00.000Z");
  });

  it("schedules local daily work independently of the operating-system timezone", () => {
    expect(isInLocalHourWindow(new Date("2026-07-20T02:00:00Z"), 10, 22, "Asia/Shanghai")).toBe(true);
    expect(isInLocalHourWindow(new Date("2026-07-20T01:00:00Z"), 10, 22, "Asia/Shanghai")).toBe(false);
    expect(millisecondsUntilLocalHour(new Date("2026-07-20T15:00:00Z"), 10, "Asia/Shanghai"))
      .toBe(11 * 60 * 60 * 1000);
    expect(millisecondsUntilLocalHour(new Date("2026-03-07T15:00:00Z"), 10, "America/New_York"))
      .toBe(23 * 60 * 60 * 1000);
  });
});
