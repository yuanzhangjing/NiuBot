import { describe, expect, it } from "vitest";
import { formatContactCreatedAt } from "./contacts.js";

describe("contacts CLI time display", () => {
  it("formats stored UTC timestamps as local time with timezone label", () => {
    const formatted = formatContactCreatedAt("2026-04-24 16:30:00");

    expect(formatted).toContain("2026-04-25");
    expect(formatted).toContain("(");
    expect(formatted).toContain(")");
  });
});
