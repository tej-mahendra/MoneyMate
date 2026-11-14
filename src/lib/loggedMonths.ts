import { monthKey } from "./format";

/** Months that actually have something logged, oldest → newest. The current
 *  month is always included so there is somewhere to land on day one. Months
 *  before logging began (or empty gaps) never appear in month pickers. */
export function loggedMonthsFromDates(dates: string[], current: string): string[] {
  const set = new Set<string>([current]);
  for (const d of dates) set.add(monthKey(d));
  return [...set].sort();
}

/** The logged month before/after `month`, or null at either end. Works even
 *  when `month` itself is not in the list (e.g. its last entry was deleted). */
export function adjacentMonth(
  months: string[],
  month: string,
  dir: -1 | 1,
): string | null {
  if (dir < 0) {
    for (let i = months.length - 1; i >= 0; i--) if (months[i] < month) return months[i];
  } else {
    for (const m of months) if (m > month) return m;
  }
  return null;
}
