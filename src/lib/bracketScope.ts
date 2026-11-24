import type { Bracket, BracketKind, Category } from "../db/db";

/** Kinds whose expense-type transactions are NOT part of monthly spend:
 *  allocation (money moved to savings/investments) and one_off (big
 *  irregular purchases). Every "spent this month" figure — Home, the
 *  widget, Analytics charts — excludes exactly these, so the two can never
 *  drift apart. */
export function isOffBudgetKind(kind: BracketKind | undefined): boolean {
  return kind === "allocation" || kind === "one_off";
}

export function bracketIdsOfKind(brackets: Bracket[], kind: BracketKind): Set<number> {
  return new Set(
    brackets.filter((b) => b.kind === kind && b.id != null).map((b) => b.id as number),
  );
}

/** Ids of categories living in brackets of the given kind. */
export function categoryIdsOfKind(
  brackets: Bracket[],
  categories: Category[],
  kind: BracketKind,
): Set<number> {
  const ids = bracketIdsOfKind(brackets, kind);
  return new Set(
    categories.filter((c) => ids.has(c.bracketId) && c.id != null).map((c) => c.id as number),
  );
}

/** Ids of categories whose expenses are excluded from monthly spend. */
export function offBudgetCategoryIds(
  brackets: Bracket[],
  categories: Category[],
): Set<number> {
  const ids = new Set(
    brackets.filter((b) => isOffBudgetKind(b.kind) && b.id != null).map((b) => b.id as number),
  );
  return new Set(
    categories.filter((c) => ids.has(c.bracketId) && c.id != null).map((c) => c.id as number),
  );
}
