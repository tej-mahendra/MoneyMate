import Papa from "papaparse";
import {
  db,
  type Bracket,
  type BudgetHistoryEntry,
  type Category,
  type SplitShare,
  type Transaction,
} from "../db/db";
import { addMonths, daysInMonth, isoWeek, monthKey, todayISO } from "./format";
import { budgetForMonth } from "./monthReport";
import { buildMonthSnapshot } from "./monthSnapshot";
import { SCHEMA_VERSION } from "./csv";
import { makeWorkbook, type Sheet } from "./xlsx";
import { downloadBinary } from "./downloadBinary";

// ─────────────────────────────────────────────────────────────────────────
// Analytics export — a star schema for Power BI Desktop and a flat, clean
// set of CSVs for Python/ML. File names and column names are a CONTRACT:
// Power BI remembers them, so renaming one breaks the user's refresh. Only
// ever ADD columns (at the end) and bump ANALYTICS_SCHEMA_VERSION.
// ─────────────────────────────────────────────────────────────────────────

export const ANALYTICS_SCHEMA_VERSION = 1;

export interface AnalyticsInput {
  transactions: Transaction[];
  categories: Category[];
  brackets: Bracket[];
  splitShares: SplitShare[];
  budgetHistory: BudgetHistoryEntry[];
  currency: string;
  /** yyyy-mm-dd */
  today: string;
  /** When the export was made, ms. */
  now: number;
}

type Cell = string | number | boolean;
type Flow = "Income" | "Spend" | "Saving";

interface TableDef {
  file: string;
  title: string;
  grain: string;
  columns: [name: string, description: string][];
}

// One definition drives the CSV headers AND the data dictionary, so the
// documentation can never disagree with the files.
export const TABLES: Record<string, TableDef> = {
  fact_transactions: {
    file: "fact_transactions.csv",
    title: "fact_transactions",
    grain: "One row per transaction.",
    columns: [
      ["TransactionId", "Unique id of the transaction (links to fact_splits)."],
      ["Date", "Transaction date, yyyy-mm-dd."],
      ["DateKey", "Date as a number yyyymmdd — relates to dim_date[DateKey]."],
      ["CategoryId", "Relates to dim_category[CategoryId]. -1 = category was deleted (shown as Uncategorized)."],
      ["Flow", "Income, Spend or Saving. Saving = money moved into a savings/investment bracket (not spent)."],
      ["Amount", "Always positive. For split expenses this is YOUR share only."],
      ["SignedAmount", "Cash effect: + for Income, − for Spend and Saving."],
      ["IsSplit", "true when part of the bill belongs to other people."],
      ["TotalBill", "Whole bill: Amount plus what others owe. Equals Amount when not split."],
      ["Merchant", "As typed. Empty when merchant names are excluded from the export."],
      ["MerchantClean", "Merchant trimmed, lower-cased and de-spaced — group on this, not Merchant."],
      ["PaymentMethod", "As entered."],
      ["IsRecurring", "true when generated from a recurring item."],
      ["EntryLagDays", "Days between the transaction date and when it was logged. >0 = logged afterwards, <0 = scheduled ahead."],
      ["Tags", "Tags joined with |."],
      ["Notes", "Free-text transaction notes, included in the export."],
    ],
  },
  dim_date: {
    file: "dim_date.csv",
    title: "dim_date",
    grain: "One row per calendar day, from the first month with data to the end of the current month.",
    columns: [
      ["DateKey", "yyyymmdd as a number — the key."],
      ["Date", "yyyy-mm-dd."],
      ["Year", "Calendar year."],
      ["Quarter", "Calendar quarter 1-4."],
      ["MonthNumber", "1-12."],
      ["MonthName", "January … December."],
      ["YearMonth", "yyyy-mm — sorts correctly as text."],
      ["IsoWeek", "ISO 8601 week number."],
      ["DayOfMonth", "1-31."],
      ["WeekdayNumber", "Monday = 1 … Sunday = 7."],
      ["Weekday", "Monday … Sunday."],
      ["IsWeekend", "true for Saturday and Sunday."],
      ["IsMonthStart", "true on the 1st."],
      ["IsMonthEnd", "true on the last day of the month."],
      ["DaysLeftInMonth", "Days remaining after this one."],
      ["FiscalYear", "Indian financial year (April–March), e.g. FY2026-27."],
      ["FiscalQuarter", "Fiscal quarter 1-4 (April–June = 1)."],
      ["FiscalMonthNumber", "Fiscal month 1-12 (April = 1, March = 12)."],
    ],
  },
  dim_category: {
    file: "dim_category.csv",
    title: "dim_category",
    grain: "One row per category (plus an Uncategorized row with id -1).",
    columns: [
      ["CategoryId", "The key."],
      ["Category", "Category name."],
      ["BracketId", "Id of the bracket it belongs to."],
      ["Bracket", "Bracket name (Expenditure, Savings, Investments, Income, …)."],
      ["Kind", "Bracket kind as the app stores it: spend, allocation or income."],
      ["Flow", "Income, Spend or Saving (allocation brackets are Saving)."],
      ["CurrentMonthlyBudget", "Today's monthly budget. For past months use fact_monthly[Budget]."],
      ["IsArchived", "true when the category or its bracket is archived."],
      ["Color", "Hex colour used in the app — handy for matching Power BI visuals."],
    ],
  },
  fact_monthly: {
    file: "fact_monthly.csv",
    title: "fact_monthly",
    grain: "One row per month per category, zero-filled, from the first logged month to the current month.",
    columns: [
      ["YearMonth", "yyyy-mm."],
      ["DateKey", "yyyymm01 — first day of the month; relates to dim_date[DateKey]."],
      ["CategoryId", "Relates to dim_category[CategoryId]."],
      ["Budget", "The budget that applied IN THAT MONTH (uses your budget history), not today's."],
      ["Actual", "Total Amount for the month in that category."],
      ["TxCount", "Number of transactions."],
      ["IsPartialMonth", "true for the current month, which is still in progress — exclude it when training models."],
    ],
  },
  fact_month_summary: {
    file: "fact_month_summary.csv",
    title: "fact_month_summary",
    grain: "One row per month — the same totals as the app's month snapshot.",
    columns: [
      ["YearMonth", "yyyy-mm."],
      ["DateKey", "yyyymm01."],
      ["Income", "Total income."],
      ["Spent", "Total spending (savings transfers are NOT spending)."],
      ["Saved", "Total moved into savings and investments."],
      ["LeftOver", "Income − Spent − Saved. Can be negative; meaningful only when Income > 0."],
      ["SavingsRate", "Saved ÷ Income as a fraction (0.2 = 20%). 0 when there is no income."],
      ["SpendBudget", "Sum of spend budgets that applied that month."],
      ["TxCount", "Number of transactions."],
      ["IsPartialMonth", "true for the current month."],
    ],
  },
  fact_splits: {
    file: "fact_splits.csv",
    title: "fact_splits",
    grain: "One row per person per split expense.",
    columns: [
      ["SplitId", "Unique id."],
      ["TransactionId", "Relates to fact_transactions[TransactionId]."],
      ["Person", "Name of the person involved in the split expense."],
      ["AmountOwed", "What this person owes for that expense."],
      ["AmountSettled", "What they have paid back."],
      ["AmountOutstanding", "Owed − Settled."],
      ["IsSettled", "true when nothing is outstanding."],
    ],
  },
  export_info: {
    file: "export_info.csv",
    title: "export_info",
    grain: "Key/value facts about this export.",
    columns: [
      ["Key", "Name of the fact."],
      ["Value", "Its value (ExportedAt, AsOfDate, Currency, schema versions and included data)."],
    ],
  },
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** CSV only: a text cell that starts with = + - @ is read as a formula when a
 *  CSV is opened in Excel. A leading apostrophe makes it literal. (The .xlsx
 *  export stores text as text, so it needs no such prefix.) */
function safe(v: string): string {
  return /^[=+\-@]/.test(v) ? "'" + v : v;
}

function toCSV(def: TableDef, rows: Cell[][]): string {
  // BOM so Excel and Power BI read ₹ and accented text as UTF-8.
  return (
    "\uFEFF" +
    Papa.unparse(
      { fields: def.columns.map((c) => c[0]), data: rows.map((r) => r.map((c) => (typeof c === "boolean" ? String(c) : typeof c === "string" ? safe(c) : c))) },
      { newline: "\r\n" },
    )
  );
}

const dateKey = (iso: string) => Number(iso.replace(/-/g, ""));
const localISO = (ms: number) => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
const dayDiff = (a: string, b: string) =>
  Math.round((Date.UTC(+a.slice(0, 4), +a.slice(5, 7) - 1, +a.slice(8, 10)) - Date.UTC(+b.slice(0, 4), +b.slice(5, 7) - 1, +b.slice(8, 10))) / 86_400_000);

const MONTH_NAMES = ["January","February","March","April","May","June","July","August","September","October","November","December"];
const WEEKDAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday","Sunday"];

/** Indian financial year: April → March. */
export function fiscalOf(month: number, year: number) {
  const startYear = month >= 4 ? year : year - 1;
  return {
    fiscalYear: `FY${startYear}-${String((startYear + 1) % 100).padStart(2, "0")}`,
    fiscalMonth: ((month + 8) % 12) + 1,
    fiscalQuarter: Math.floor((((month + 8) % 12)) / 3) + 1,
  };
}

/** The tables themselves — raw values, shared by the workbook and CSV renderers. */
export function buildTables(input: AnalyticsInput): Record<string, Cell[][]> {
  const { transactions, categories, brackets, splitShares, budgetHistory, today } = input;
  const curMonth = monthKey(today);
  const bracketById = new Map(brackets.map((b) => [b.id!, b]));
  const catById = new Map(categories.map((c) => [c.id!, c]));

  const flowOfBracket = (b: Bracket | undefined): Flow =>
    b?.kind === "income" ? "Income" : b?.kind === "allocation" ? "Saving" : "Spend";
  const flowOfTx = (t: Transaction): Flow => {
    if (t.type === "income") return "Income";
    const c = catById.get(t.categoryId);
    const f = c ? flowOfBracket(bracketById.get(c.bracketId)) : "Spend";
    return f === "Saving" ? "Saving" : "Spend";
  };

  const owedByTx = new Map<number, number>();
  for (const s of splitShares) owedByTx.set(s.transactionId, (owedByTx.get(s.transactionId) ?? 0) + s.amountOwed);

  const txs = transactions
    .slice()
    .sort((a, b) => (a.date === b.date ? a.createdAt - b.createdAt : a.date < b.date ? -1 : 1));

  // ── fact_transactions
  const factTx: Cell[][] = txs.map((t) => {
    const flow = flowOfTx(t);
    const owed = t.type === "expense" ? owedByTx.get(t.id!) ?? 0 : 0;
    const merchantRaw = t.merchant ?? "";
    const clean = merchantRaw.trim().toLowerCase().replace(/\s+/g, " ");
    return [
      t.id!,
      t.date,
      dateKey(t.date),
      catById.has(t.categoryId) ? t.categoryId : -1,
      flow,
      round2(t.amount),
      flow === "Income" ? round2(t.amount) : -round2(t.amount),
      owed > 0,
      round2(t.amount + owed),
      merchantRaw,
      clean,
      t.paymentMethod ?? "",
      Boolean(t.recurringId),
      dayDiff(localISO(t.createdAt), t.date),
      (t.tags ?? []).join("|"),
      t.note ?? "",
    ];
  });

  // ── dim_category
  const dimCat: Cell[][] = categories
    .slice()
    .sort((a, b) => a.id! - b.id!)
    .map((c) => {
      const b = bracketById.get(c.bracketId);
      return [
        c.id!,
        c.name,
        c.bracketId,
        b?.name ?? "",
        b?.kind ?? "spend",
        flowOfBracket(b),
        round2(c.budget),
        Boolean(c.archived || b?.archived),
        c.color,
      ];
    });
  dimCat.push([-1, "Uncategorized", -1, "Uncategorized", "spend", "Spend", 0, false, "#888888"]);

  // ── dim_date: first month with data → end of current month (or later data)
  const months: string[] = [];
  const firstMonth = txs.length ? monthKey(txs[0].date) : curMonth;
  const lastDataMonth = txs.length ? monthKey(txs[txs.length - 1].date) : curMonth;
  const lastMonth = lastDataMonth > curMonth ? lastDataMonth : curMonth;
  for (let m = firstMonth; m <= lastMonth; m = addMonths(m, 1)) months.push(m);

  const dimDate: Cell[][] = [];
  for (const m of months) {
    const y = Number(m.slice(0, 4));
    const mo = Number(m.slice(5, 7));
    const n = daysInMonth(m);
    const f = fiscalOf(mo, y);
    for (let d = 1; d <= n; d++) {
      const wd = (new Date(Date.UTC(y, mo - 1, d)).getUTCDay() + 6) % 7; // Mon=0
      const iso = `${m}-${String(d).padStart(2, "0")}`;
      dimDate.push([
        dateKey(iso), iso, y, Math.ceil(mo / 3), mo, MONTH_NAMES[mo - 1], m,
        isoWeek(iso), d, wd + 1, WEEKDAYS[wd], wd >= 5, d === 1, d === n,
        n - d, f.fiscalYear, f.fiscalQuarter, f.fiscalMonth,
      ]);
    }
  }

  // ── fact_monthly (zero-filled grid) and fact_month_summary
  const actual = new Map<string, { sum: number; n: number }>();
  for (const t of txs) {
    const cid = catById.has(t.categoryId) ? t.categoryId : -1;
    const k = `${monthKey(t.date)}|${cid}`;
    const a = actual.get(k) ?? { sum: 0, n: 0 };
    a.sum += t.amount;
    a.n += 1;
    actual.set(k, a);
  }
  const factMonthly: Cell[][] = [];
  const factSummary: Cell[][] = [];
  for (const m of months) {
    const partial = m >= curMonth; // in progress, or dated ahead
    const mDate = dateKey(`${m}-01`);
    const ids = [...categories.map((c) => c.id!), -1];
    for (const cid of ids) {
      const c = catById.get(cid);
      const b = c ? bracketById.get(c.bracketId) : undefined;
      const isIncome = b?.kind === "income";
      const budget = c && !isIncome ? budgetForMonth(c, m, budgetHistory, curMonth, Boolean(b?.archived)) : 0;
      const a = actual.get(`${m}|${cid}`);
      const archived = Boolean(c?.archived || b?.archived);
      // Skip rows that can never matter: archived/deleted with nothing in the month.
      if ((archived || cid === -1) && !a && budget === 0) continue;
      factMonthly.push([m, mDate, cid, round2(budget), round2(a?.sum ?? 0), a?.n ?? 0, partial]);
    }
    const snap = buildMonthSnapshot(m, txs, categories, brackets);
    const spendBudget = categories.reduce((s, c) => {
      const b = bracketById.get(c.bracketId);
      return b?.kind === "spend" ? s + budgetForMonth(c, m, budgetHistory, curMonth, Boolean(b.archived)) : s;
    }, 0);
    factSummary.push([
      m, mDate, round2(snap.income), round2(snap.spent), round2(snap.saved), round2(snap.left),
      snap.income > 0 ? Math.round((snap.saved / snap.income) * 10000) / 10000 : 0,
      round2(spendBudget), snap.txCount, partial,
    ]);
  }

  // ── fact_splits
  const factSplits: Cell[][] = splitShares
    .slice()
    .sort((a, b) => (a.id ?? 0) - (b.id ?? 0))
    .map((s) => {
      const outstanding = round2(s.amountOwed - s.amountSettled);
      return [
        s.id!, s.transactionId,
        s.personName,
        round2(s.amountOwed), round2(s.amountSettled), outstanding, outstanding <= 0.005,
      ];
    });

  // Every value is text. A single column that mixed numbers, dates and
  // true/false would be read back inconsistently (pandas turned `true` into 1;
  // Power BI guesses one type from the first rows and errors on the rest).
  const info: Cell[][] = (
    [
      ["AnalyticsSchemaVersion", ANALYTICS_SCHEMA_VERSION],
      ["AppSchemaVersion", SCHEMA_VERSION],
      ["ExportedAt", new Date(input.now).toISOString()],
      ["AsOfDate", today],
      ["Currency", input.currency],
      ["IncludeNotes", true],
      ["IncludeMerchants", true],
      ["RealPersonNames", true],
    ] as [string, string | number | boolean][]
  ).map(([key, value]) => [key, String(value)]);

  const data: Record<string, Cell[][]> = {
    fact_transactions: factTx,
    dim_date: dimDate,
    dim_category: dimCat,
    fact_monthly: factMonthly,
    fact_month_summary: factSummary,
    fact_splits: factSplits,
    export_info: info,
  };
  return data;
}

/** Same tables as separate CSV files plus a text data dictionary. */
export function buildAnalyticsFiles(input: AnalyticsInput): { name: string; content: string }[] {
  const data = buildTables(input);
  const files = Object.keys(TABLES).map((k) => ({ name: TABLES[k].file, content: toCSV(TABLES[k], data[k]) }));
  files.push({ name: "README_data_dictionary.txt", content: buildDictionary(data, input, "csv") });
  return files;
}

// Columns that hold dates as "yyyy-mm-dd" text; in the workbook they become
// real Excel dates so Power BI types them as Date automatically.
const DATE_COLUMNS: Record<string, string[]> = {
  fact_transactions: ["Date"],
  dim_date: ["Date"],
};

/** One .xlsx workbook: a README sheet first, then one sheet per table. */
export function buildAnalyticsWorkbook(
  input: AnalyticsInput,
  when: Date = new Date(),
): Uint8Array {
  const data = buildTables(input);
  const readme: Sheet = {
    name: "README",
    columns: ["Money Mate analytics export — data dictionary"],
    rows: buildDictionary(data, input, "workbook").split("\r\n").map((line) => [line]),
    firstColumnWidth: 130,
  };
  const tables: Sheet[] = Object.keys(TABLES).map((k) => ({
    name: k,
    columns: TABLES[k].columns.map((c) => c[0]),
    rows: data[k],
    dateColumns: DATE_COLUMNS[k],
  }));
  return makeWorkbook([readme, ...tables], when);
}

function buildDictionary(
  data: Record<string, Cell[][]>,
  input: AnalyticsInput,
  format: "workbook" | "csv",
): string {
  const L: string[] = [];
  L.push("MONEY MATE — ANALYTICS EXPORT");
  L.push("=".repeat(30));
  L.push(`Exported: ${new Date(input.now).toISOString()}   As of: ${input.today}   Currency: ${input.currency}`);
  L.push(`Analytics schema version: ${ANALYTICS_SCHEMA_VERSION}`);
  L.push("");
  L.push("PRIVACY");
  L.push("  These files are PLAIN TEXT and not encrypted. Anyone who gets them can read your finances.");
  L.push("  Keep them on a personal, preferably encrypted, drive. Do not email them or put them in a work account.");
  L.push("  This export includes transaction notes, merchant names, and the names of people in split expenses.");
  L.push("");
  L.push("HOW TO USE WITH POWER BI DESKTOP");
  if (format === "workbook") {
    L.push("  1. Get Data → Excel workbook → choose this file → tick every sheet EXCEPT README → Load.");
    L.push("  2. Dates are real dates and true/false columns are real booleans, so no type fixing is needed.");
  } else {
    L.push("  1. Unzip into a fixed folder (e.g. D:\\MoneyMateData) — each export replaces the same file names.");
    L.push("  2. Get Data → Text/CSV and load each .csv (file origin: UTF-8).");
  }
  L.push("  3. Relationships (many → one):");
  L.push("       fact_transactions[DateKey]  → dim_date[DateKey]");
  L.push("       fact_transactions[CategoryId] → dim_category[CategoryId]");
  L.push("       fact_monthly[DateKey]       → dim_date[DateKey]");
  L.push("       fact_monthly[CategoryId]    → dim_category[CategoryId]");
  L.push("       fact_month_summary[DateKey] → dim_date[DateKey]");
  L.push("       fact_splits[TransactionId]  → fact_transactions[TransactionId]");
  L.push(format === "workbook"
    ? "  4. Next time: save the new export over the same file (same name and folder) and click Refresh."
    : "  4. Next time: replace the files with the new export and click Refresh.");
  L.push(`  ${format === "workbook" ? "Sheet" : "File"} names and column names never change between versions; new columns are only ever added at the end.`);
  L.push("");
  L.push("NOTES FOR ANALYSIS");
  L.push("  - Use Flow, not the category, to separate Income / Spend / Saving. Savings are NOT spending.");
  L.push("  - The current month is partial (IsPartialMonth = true). Exclude it when forecasting or comparing months.");
  if (format === "csv") {
    L.push("  - Text cells that begin with = + - @ are prefixed with ' so spreadsheets don't treat them as formulas.");
    L.push("    Use MerchantClean for grouping; strip a leading ' if you need the raw text.");
  }
  L.push("  - Amount for split expenses is YOUR share. TotalBill is the whole bill.");
  L.push("");
  for (const k of Object.keys(TABLES)) {
    const t = TABLES[k];
    L.push(`${format === "workbook" ? `Sheet: ${t.title}` : t.file}   (${data[k].length} rows)`);
    L.push(`  ${t.grain}`);
    for (const [name, desc] of t.columns) L.push(`    ${name.padEnd(22)} ${desc}`);
    L.push("");
  }
  return L.join("\r\n");
}

/** Fixed name on purpose: Power BI remembers the file path, so saving each new
 *  export over the same name keeps Refresh working. The export date is inside
 *  (export_info sheet). */
export const ANALYTICS_FILE_NAME = "moneymate-analytics.xlsx";
const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

async function loadAnalyticsInput(today: string): Promise<AnalyticsInput> {
  const [transactions, categories, brackets, splitShares, budgetHistory, settings] = await Promise.all([
    db.transactions.toArray(),
    db.categories.toArray(),
    db.brackets.toArray(),
    db.splitShares.toArray(),
    db.budgetHistory.toArray(),
    db.settings.get(1),
  ]);
  return { transactions, categories, brackets, splitShares, budgetHistory, currency: settings?.currency ?? "", today, now: Date.now() };
}

/** Loads everything and builds the workbook. */
export async function buildAnalyticsWorkbookFromDb(
  today: string = todayISO(),
): Promise<Uint8Array> {
  return buildAnalyticsWorkbook(await loadAnalyticsInput(today));
}

export async function exportAnalyticsWorkbook(): Promise<void> {
  await downloadBinary(ANALYTICS_FILE_NAME, await buildAnalyticsWorkbookFromDb(), XLSX_MIME);
}
