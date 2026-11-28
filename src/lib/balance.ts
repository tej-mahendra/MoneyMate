import type { SplitShare, Transaction } from "../db/db";
import { addMonths, monthKey, roundMoney } from "./format";

/**
 * "Money in hand": what is actually left in the bank after everything logged —
 * spending, savings, investments and one-off purchases all leave the account.
 *
 *  - This month left = this month's income (fixed monthly income + income
 *    logged so far) − everything paid out so far this month.
 *  - Total left      = the balance the person last confirmed (the anchor) plus
 *    everything that happened since. Without an anchor the history can't say
 *    what the account held before logging began, so there is no total.
 *
 * Only entries dated today or earlier count, so a future-dated entry never
 * moves the number before it happens.
 *
 * A split expense is stored as your share only, but you paid the whole bill:
 * whatever friends haven't paid back yet is money out of the account too.
 */
export interface BalanceInput {
  transactions: Transaction[];
  splitShares: SplitShare[];
  /** Fixed income that counts automatically every month (Settings). */
  monthlyIncome: number;
  today: string;
  anchorAmount?: number;
  anchorDate?: string;
  anchorAt?: number;
}

export interface BalanceFigures {
  monthLeft: number;
  /** null until the person has confirmed their balance once. */
  totalLeft: number | null;
}

export function computeBalance(input: BalanceInput): BalanceFigures {
  const { transactions, splitShares, monthlyIncome, today } = input;

  const unsettled = new Map<number, number>();
  for (const sh of splitShares) {
    const open = Math.max(0, sh.amountOwed - sh.amountSettled);
    unsettled.set(sh.transactionId, (unsettled.get(sh.transactionId) ?? 0) + open);
  }
  const outOf = (t: Transaction) => t.amount + (t.id != null ? unsettled.get(t.id) ?? 0 : 0);

  const cur = monthKey(today);
  let monthIn = Math.max(0, monthlyIncome);
  let monthOut = 0;
  for (const t of transactions) {
    if (t.date > today || monthKey(t.date) !== cur) continue;
    if (t.type === "income") monthIn += t.amount;
    else monthOut += outOf(t);
  }
  const monthLeft = roundMoney(monthIn - monthOut);

  const { anchorAmount, anchorDate } = input;
  if (typeof anchorAmount !== "number" || !anchorDate) {
    return { monthLeft, totalLeft: null };
  }
  const anchorAt = input.anchorAt ?? 0;

  let delta = 0;
  for (const t of transactions) {
    if (t.date > today) continue;
    // After the anchor day, or later the same day than the confirmation —
    // anything dated earlier was already in the balance the person typed in.
    const after = t.date > anchorDate || (t.date === anchorDate && t.createdAt > anchorAt);
    if (!after) continue;
    delta += t.type === "income" ? t.amount : -outOf(t);
  }

  // Fixed monthly income lands once per month that began after the anchor.
  let months = 0;
  for (let m = addMonths(monthKey(anchorDate), 1); m <= cur; m = addMonths(m, 1)) months++;

  return {
    monthLeft,
    totalLeft: roundMoney(anchorAmount + delta + Math.max(0, monthlyIncome) * months),
  };
}
