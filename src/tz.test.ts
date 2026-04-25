import { describe, expect, it } from "vitest";
import { formatLocalDateTimeWithTZ, labelLocalDateTime, labelLocalTime, utcDateTimeForSql } from "./tz.js";

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
});
