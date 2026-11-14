import { describe, it, expect } from "vitest";
import { adjacentMonth, loggedMonthsFromDates } from "./loggedMonths";

describe("loggedMonthsFromDates", () => {
  it("lists only months with entries, plus the current month, oldest first", () => {
    expect(
      loggedMonthsFromDates(["2026-11-03", "2026-11-20", "2027-01-05"], "2027-02"),
    ).toEqual(["2026-11", "2027-01", "2027-02"]);
  });
  it("does not invent earlier months when logging started this month", () => {
    expect(loggedMonthsFromDates(["2026-11-03"], "2026-11")).toEqual(["2026-11"]);
    expect(loggedMonthsFromDates([], "2026-11")).toEqual(["2026-11"]);
  });
});

describe("adjacentMonth", () => {
  const months = ["2026-11", "2027-01", "2027-02"];
  it("skips empty gap months", () => {
    expect(adjacentMonth(months, "2027-01", -1)).toBe("2026-11");
    expect(adjacentMonth(months, "2026-11", 1)).toBe("2027-01");
  });
  it("returns null at the ends", () => {
    expect(adjacentMonth(months, "2026-11", -1)).toBeNull();
    expect(adjacentMonth(months, "2027-02", 1)).toBeNull();
  });
  it("works from a month that is not in the list", () => {
    expect(adjacentMonth(months, "2026-12", -1)).toBe("2026-11");
    expect(adjacentMonth(months, "2026-12", 1)).toBe("2027-01");
  });
});
