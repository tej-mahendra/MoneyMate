import { db } from "../db/db";

/** One-off brackets have no category step: a purchase is logged by its own
 *  name ("iPhone 16"). Every transaction still needs a category (totals,
 *  exports and the monthly-spend exclusion all find the bracket through it),
 *  so each one-off bracket quietly owns a single "Purchases" category. */
export const ONE_OFF_CATEGORY_NAME = "Purchases";

/** Id of the bracket's "Purchases" category, creating it on first use. */
export async function ensureOneOffCategory(bracketId: number): Promise<number> {
  const bracket = await db.brackets.get(bracketId);
  const existing = (
    await db.categories.where("bracketId").equals(bracketId).toArray()
  ).find((c) => c.name === ONE_OFF_CATEGORY_NAME);
  if (existing?.id != null) {
    if (existing.archived) await db.categories.update(existing.id, { archived: false });
    return existing.id;
  }
  return (await db.categories.add({
    name: ONE_OFF_CATEGORY_NAME,
    icon: "🛍️",
    color: bracket?.color ?? "#B98CF0",
    budget: 0,
    bracketId,
  })) as number;
}
