import { describe, it, expect } from "vitest";
import Papa from "papaparse";
import {
  ANALYTICS_FILE_NAME,
  ANALYTICS_SCHEMA_VERSION,
  buildAnalyticsFiles,
  buildAnalyticsWorkbook,
  buildTables,
  fiscalOf,
  TABLES,
  type AnalyticsInput,
} from "./analyticsExport";
import type { Bracket, BudgetHistoryEntry, Category, SplitShare, Transaction } from "../db/db";
import { readZip } from "../test/zipReader";
import { excelDateSerial } from "./xlsx";

const brackets: Bracket[] = [
  { id: 1, name: "Expenditure", icon: "💳", color: "#111", kind: "spend" },
  { id: 2, name: "Savings", icon: "💰", color: "#222", kind: "allocation" },
  { id: 3, name: "Income", icon: "💼", color: "#333", kind: "income" },
];
const categories: Category[] = [
  { id: 10, name: "Food", icon: "🍲", color: "#aa0000", budget: 8000, bracketId: 1 },
  { id: 11, name: "Rent", icon: "🏠", color: "#00aa00", budget: 20000, bracketId: 1 },
  { id: 20, name: "Emergency fund", icon: "🛟", color: "#0000aa", budget: 5000, bracketId: 2 },
  { id: 30, name: "Salary", icon: "💼", color: "#aaaa00", budget: 0, bracketId: 3 },
  { id: 12, name: "Old hobby", icon: "🎨", color: "#999999", budget: 0, bracketId: 1, archived: true },
];
const tx = (id: number, type: "expense" | "income", categoryId: number, amount: number, date: string, extra: Partial<Transaction> = {}): Transaction => ({
  id, type, categoryId, amount, date, createdAt: new Date(`${date}T12:00:00`).getTime(), ...extra,
});
const transactions: Transaction[] = [
  tx(1, "income", 30, 60000, "2026-09-01", { note: "Sept salary" }),
  tx(2, "expense", 10, 450, "2026-09-05", { merchant: "  Swiggy   Order ", note: "dinner =cmd", tags: ["food", "late"] }),
  tx(3, "expense", 20, 8000, "2026-09-06"),
  tx(4, "expense", 11, 20000, "2026-10-01", { recurringId: 7 }),
  tx(5, "expense", 10, 300, "2026-10-12", { merchant: "-refund shop", createdAt: new Date("2026-10-15T09:00:00").getTime() }),
  tx(6, "expense", 99, 70, "2026-10-13"), // category was deleted
  tx(7, "income", 30, 60000, "2026-11-01"),
  tx(8, "expense", 10, 600, "2026-11-10", { merchant: "Cafe" }),
];
const splitShares: SplitShare[] = [
  { id: 1, transactionId: 2, personName: "Rahul", amountOwed: 150, amountSettled: 50, createdAt: 100 },
  { id: 2, transactionId: 2, personName: "Priya", amountOwed: 150, amountSettled: 150, createdAt: 101 },
  { id: 3, transactionId: 8, personName: "rahul ", amountOwed: 200, amountSettled: 0, createdAt: 102 },
];
// Food budget was 5000 in Sept, raised to 8000 from Oct.
const budgetHistory: BudgetHistoryEntry[] = [
  { id: 1, categoryId: 10, month: "2026-09", budget: 5000, origin: "created", createdAt: 1 },
  { id: 2, categoryId: 10, month: "2026-10", budget: 8000, origin: "edited", createdAt: 2 },
];
const input: AnalyticsInput = {
  transactions, categories, brackets, splitShares, budgetHistory,
  currency: "₹", today: "2026-11-18", now: Date.UTC(2026, 10, 18, 8, 0, 0),
};

function table(name: string, inp = input) {
  const files = buildAnalyticsFiles(inp);
  const f = files.find((x) => x.name === TABLES[name].file)!;
  const parsed = Papa.parse<Record<string, string>>(f.content.replace(/^\uFEFF/, ""), { header: true, skipEmptyLines: true });
  return { raw: f.content, rows: parsed.data, fields: parsed.meta.fields ?? [] };
}

describe("analytics export — shape and contract", () => {
  it("produces exactly the contracted files, plus the data dictionary", () => {
    const names = buildAnalyticsFiles(input).map((f) => f.name);
    expect(names).toEqual([
      "fact_transactions.csv", "dim_date.csv", "dim_category.csv", "fact_monthly.csv",
      "fact_month_summary.csv", "fact_splits.csv", "export_info.csv", "README_data_dictionary.txt",
    ]);
  });
  it("column names and order are the documented contract (Power BI refresh depends on them)", () => {
    for (const k of Object.keys(TABLES)) {
      expect(table(k).fields).toEqual(TABLES[k].columns.map((c) => c[0]));
    }
  });
  it("every CSV starts with a UTF-8 byte-order mark so Excel/Power BI read ₹ correctly", () => {
    for (const f of buildAnalyticsFiles(input).filter((x) => x.name.endsWith(".csv"))) {
      expect(f.content.charCodeAt(0)).toBe(0xfeff);
    }
  });
  it("still writes headers for an empty database", () => {
    const empty: AnalyticsInput = { ...input, transactions: [], splitShares: [], budgetHistory: [] };
    expect(table("fact_transactions", empty).fields.length).toBe(TABLES.fact_transactions.columns.length);
    expect(table("fact_transactions", empty).rows).toHaveLength(0);
    expect(table("dim_date", empty).rows.length).toBe(30); // current month only
  });
  it("documents every table and column in the dictionary", () => {
    const dict = buildAnalyticsFiles(input).find((f) => f.name === "README_data_dictionary.txt")!.content;
    for (const k of Object.keys(TABLES)) {
      expect(dict).toContain(TABLES[k].file);
      for (const [c] of TABLES[k].columns) expect(dict).toContain(c);
    }
    expect(dict).toMatch(/not encrypted/i);
  });
});

describe("fact_transactions", () => {
  const { rows } = table("fact_transactions");
  const byId = (id: number) => rows.find((r) => r.TransactionId === String(id))!;

  it("separates Income, Spend and Saving — savings are not spending", () => {
    expect(byId(1).Flow).toBe("Income");
    expect(byId(2).Flow).toBe("Spend");
    expect(byId(3).Flow).toBe("Saving");
  });
  it("signs the cash effect: + income, − spend, − saving", () => {
    expect(Number(byId(1).SignedAmount)).toBe(60000);
    expect(Number(byId(2).SignedAmount)).toBe(-450);
    expect(Number(byId(3).SignedAmount)).toBe(-8000);
  });
  it("derives the whole bill for split expenses from the other people's shares", () => {
    expect(byId(2).IsSplit).toBe("true");
    expect(Number(byId(2).Amount)).toBe(450);
    expect(Number(byId(2).TotalBill)).toBe(750);
    expect(byId(4).IsSplit).toBe("false");
    expect(Number(byId(4).TotalBill)).toBe(20000);
  });
  it("cleans merchant names for grouping", () => {
    expect(byId(2).Merchant).toBe("  Swiggy   Order ");
    expect(byId(2).MerchantClean).toBe("swiggy order");
  });
  it("neutralises spreadsheet formulas in free text only", () => {
    expect(byId(5).Merchant).toBe("'-refund shop");
    expect(byId(4).Amount).toBe("20000"); // numbers untouched
  });
  it("maps a deleted category to -1 instead of leaving an orphan id", () => {
    expect(byId(6).CategoryId).toBe("-1");
  });
  it("measures how late an entry was logged, and flags recurring ones", () => {
    expect(byId(5).EntryLagDays).toBe("3");
    expect(byId(2).EntryLagDays).toBe("0");
    expect(byId(4).IsRecurring).toBe("true");
  });
  it("DateKey is the yyyymmdd number", () => {
    expect(byId(2).DateKey).toBe("20260905");
  });
});

describe("complete export data", () => {
  it("always includes transaction notes and merchant names", () => {
    const t = table("fact_transactions");
    expect(t.rows.find((r) => r.TransactionId === "1")!.Notes).toBe("Sept salary");
    expect(t.rows.find((r) => r.TransactionId === "2")!.Notes).toBe("dinner =cmd");
    expect(t.rows.find((r) => r.TransactionId === "2")!.Merchant).toBe("  Swiggy   Order ");
    expect(t.rows.find((r) => r.TransactionId === "2")!.MerchantClean).toBe("swiggy order");
  });
  it("always includes the actual names of people in split expenses", () => {
    expect(table("fact_splits").rows.map((r) => r.Person)).toEqual(["Rahul", "Priya", "rahul "]);
  });
  it("records that all personal data fields are included", () => {
    const info = Object.fromEntries(table("export_info").rows.map((r) => [r.Key, r.Value]));
    expect(info.IncludeNotes).toBe("true");
    expect(info.IncludeMerchants).toBe("true");
    expect(info.RealPersonNames).toBe("true");
    expect(info.AnalyticsSchemaVersion).toBe(String(ANALYTICS_SCHEMA_VERSION));
    expect(info.AsOfDate).toBe("2026-11-18");
    expect(info.Currency).toBe("₹");
  });
});

describe("fact_splits", () => {
  it("computes outstanding and settled status", () => {
    const rows = table("fact_splits").rows;
    expect(rows.map((r) => Number(r.AmountOutstanding))).toEqual([100, 0, 200]);
    expect(rows.map((r) => r.IsSettled)).toEqual(["false", "true", "false"]);
  });
});

describe("fact_monthly", () => {
  const { rows } = table("fact_monthly");
  const get = (m: string, c: number) => rows.find((r) => r.YearMonth === m && r.CategoryId === String(c))!;

  it("uses the budget that applied in each month, not today's", () => {
    expect(Number(get("2026-09", 10).Budget)).toBe(5000);
    expect(Number(get("2026-10", 10).Budget)).toBe(8000);
    expect(Number(get("2026-11", 10).Budget)).toBe(8000);
  });
  it("zero-fills months with no activity so time series have no gaps", () => {
    const r = get("2026-09", 11); // Rent: nothing in September
    expect(Number(r.Actual)).toBe(0);
    expect(Number(r.TxCount)).toBe(0);
  });
  it("totals actuals per month and category", () => {
    expect(Number(get("2026-10", 10).Actual)).toBe(300);
    expect(Number(get("2026-10", -1).Actual)).toBe(70);
  });
  it("flags only the in-progress month as partial", () => {
    expect(get("2026-10", 10).IsPartialMonth).toBe("false");
    expect(get("2026-11", 10).IsPartialMonth).toBe("true");
  });
  it("leaves out archived categories with nothing in the month", () => {
    expect(rows.some((r) => r.CategoryId === "12")).toBe(false);
  });
});

describe("fact_month_summary", () => {
  const rows = table("fact_month_summary").rows;
  it("matches the app's month snapshot: savings are not spending, left over is income − spent − saved", () => {
    const sep = rows.find((r) => r.YearMonth === "2026-09")!;
    expect(Number(sep.Income)).toBe(60000);
    expect(Number(sep.Spent)).toBe(450);
    expect(Number(sep.Saved)).toBe(8000);
    expect(Number(sep.LeftOver)).toBe(51550);
    expect(Number(sep.SavingsRate)).toBeCloseTo(0.1333, 4);
    expect(Number(sep.SpendBudget)).toBe(25000); // Food 5000 + Rent 20000 that month
  });
  it("has one row per month and no NaN for a month with no income", () => {
    expect(rows.map((r) => r.YearMonth)).toEqual(["2026-09", "2026-10", "2026-11"]);
    const oct = rows.find((r) => r.YearMonth === "2026-10")!;
    expect(Number(oct.Income)).toBe(0);
    expect(Number(oct.SavingsRate)).toBe(0);
    expect(oct.LeftOver).not.toBe("NaN");
  });
});

describe("dim_date and the Indian financial year", () => {
  it("fiscalOf follows April–March", () => {
    expect(fiscalOf(4, 2026)).toEqual({ fiscalYear: "FY2026-27", fiscalMonth: 1, fiscalQuarter: 1 });
    expect(fiscalOf(3, 2027)).toEqual({ fiscalYear: "FY2026-27", fiscalMonth: 12, fiscalQuarter: 4 });
    expect(fiscalOf(1, 2026)).toEqual({ fiscalYear: "FY2025-26", fiscalMonth: 10, fiscalQuarter: 4 });
    expect(fiscalOf(12, 2026)).toEqual({ fiscalYear: "FY2026-27", fiscalMonth: 9, fiscalQuarter: 3 });
  });
  it("covers every day from the first month with data through the current month, once each", () => {
    const rows = table("dim_date").rows;
    expect(rows).toHaveLength(30 + 31 + 30); // Sep + Oct + Nov 2026
    expect(new Set(rows.map((r) => r.DateKey)).size).toBe(rows.length);
    expect(rows[0].Date).toBe("2026-09-01");
    expect(rows.at(-1)!.Date).toBe("2026-11-30");
  });
  it("gets weekday and ISO week right (2026-11-18 is a Wednesday, week 47)", () => {
    const r = table("dim_date").rows.find((x) => x.Date === "2026-11-18")!;
    expect(r.Weekday).toBe("Wednesday");
    expect(r.WeekdayNumber).toBe("3");
    expect(r.IsoWeek).toBe("47");
    expect(r.IsWeekend).toBe("false");
    expect(r.DaysLeftInMonth).toBe("12");
    expect(r.FiscalYear).toBe("FY2026-27");
  });
  it("every transaction DateKey exists in dim_date (relationships never dangle)", () => {
    const keys = new Set(table("dim_date").rows.map((r) => r.DateKey));
    expect(table("fact_transactions").rows.every((r) => keys.has(r.DateKey))).toBe(true);
    expect(table("fact_monthly").rows.every((r) => keys.has(r.DateKey))).toBe(true);
  });
  it("every CategoryId used by a fact exists in dim_category", () => {
    const ids = new Set(table("dim_category").rows.map((r) => r.CategoryId));
    expect(table("fact_transactions").rows.every((r) => ids.has(r.CategoryId))).toBe(true);
    expect(table("fact_monthly").rows.every((r) => ids.has(r.CategoryId))).toBe(true);
  });
});


describe("single workbook export", () => {
  const files = readZip(buildAnalyticsWorkbook(input));
  const sheetNames = Array.from(
    new DOMParser().parseFromString(files["xl/workbook.xml"].text, "application/xml").getElementsByTagName("sheet"),
  ).map((s) => s.getAttribute("name")!);
  const sheetXml = (name: string) => files[`xl/worksheets/sheet${sheetNames.indexOf(name) + 1}.xml`].text;
  // Rows are read by each cell's own reference (A1, B1, …), the way every
  // spreadsheet reader does: blank cells are absent from the XML, so a row's
  // position in the list is its column, not the order cells appear in.
  const colIndex = (ref: string) =>
    [...ref.replace(/\d+/g, "")].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  function grid(name: string) {
    const doc = new DOMParser().parseFromString(sheetXml(name), "application/xml");
    return Array.from(doc.getElementsByTagName("row")).map((r) => {
      const row: { ref: string; t: string | null; s: string | null; v: string }[] = [];
      for (const c of Array.from(r.getElementsByTagName("c"))) {
        row[colIndex(c.getAttribute("r")!)] = {
          ref: c.getAttribute("r")!, t: c.getAttribute("t"), s: c.getAttribute("s"),
          v: (c.getElementsByTagName("v")[0] ?? c.getElementsByTagName("t")[0])?.textContent ?? "",
        };
      }
      return Array.from(row, (c) => c ?? { ref: "", t: null, s: null, v: "" });
    });
  }

  it("is ONE file with a README sheet first, then one sheet per table in order", () => {
    expect(sheetNames).toEqual(["README", ...Object.keys(TABLES)]);
    expect(ANALYTICS_FILE_NAME).toBe("moneymate-analytics.xlsx"); // fixed so Power BI Refresh keeps working
  });

  it("every table sheet has exactly the contracted columns and the same rows as the tables", () => {
    const tables = buildTables(input);
    for (const k of Object.keys(TABLES)) {
      const g = grid(k);
      expect(g[0].map((c) => c.v)).toEqual(TABLES[k].columns.map((c) => c[0]));
      expect(g.length - 1).toBe(tables[k].length);
    }
  });

  it("dates are real Excel dates; keys, amounts and flags keep their types", () => {
    const row = grid("fact_transactions").find((r) => r[0].v === "2")!; // Sept-05 swiggy tx
    const byCol = (name: string) => row[TABLES.fact_transactions.columns.findIndex((c) => c[0] === name)];
    expect(byCol("Date")).toMatchObject({ t: null, s: "1", v: String(excelDateSerial("2026-09-05")) });
    expect(byCol("DateKey")).toMatchObject({ t: null, v: "20260905" });
    expect(byCol("Amount")).toMatchObject({ t: null, v: "450" });
    expect(byCol("IsSplit")).toMatchObject({ t: "b", v: "1" });
    expect(byCol("Flow")).toMatchObject({ t: "inlineStr", v: "Spend" });
    expect(byCol("EntryLagDays")).toMatchObject({ t: null, v: "0" });
    const dd = grid("dim_date")[1];
    expect(dd[1]).toMatchObject({ s: "1" }); // dim_date[Date] is a date too
    expect(dd[0]).toMatchObject({ t: null, v: "20260901" });
  });

  it("true/false are real booleans everywhere, and year-months stay text", () => {
    const tx = grid("fact_transactions");
    const isSplit = TABLES.fact_transactions.columns.findIndex((c) => c[0] === "IsSplit");
    expect(tx.slice(1).every((r) => r[isSplit].t === "b")).toBe(true);
    expect(tx.slice(1).some((r) => r[isSplit].v === "1")).toBe(true);
    const sum = grid("fact_month_summary");
    expect(sum[1][TABLES.fact_month_summary.columns.findIndex((c) => c[0] === "IsPartialMonth")].t).toBe("b");
    expect(sum[1][0]).toMatchObject({ t: "inlineStr", v: "2026-09" }); // "2026-09" must not become a date
  });

  it("export_info is all text, so its Value column has one consistent type", () => {
    const g = grid("export_info").slice(1);
    expect(g.length).toBeGreaterThan(0);
    expect(g.every((r) => r[1].t === "inlineStr")).toBe(true);
    expect(g.find((r) => r[0].v === "IncludeMerchants")![1].v).toBe("true");
    expect(g.find((r) => r[0].v === "IncludeNotes")![1].v).toBe("true");
    expect(g.find((r) => r[0].v === "RealPersonNames")![1].v).toBe("true");
    expect(g.find((r) => r[0].v === "AnalyticsSchemaVersion")![1].v).toBe("1");
  });

  it("stores text as plain text — no apostrophe prefix (that is only for CSV)", () => {
    expect(sheetXml("fact_transactions")).toContain(">-refund shop</t>");
    expect(sheetXml("fact_transactions")).not.toContain("'-refund shop");
    const csv = buildAnalyticsFiles(input).find((f) => f.name === "fact_transactions.csv")!;
    expect(csv.content).toContain("'-refund shop"); // CSV keeps its spreadsheet-safety prefix
  });

  it("includes all personal fields in the workbook", () => {
    const text = Object.values(files).map((f) => f.text).join("\n");
    expect(text).toContain("Sept salary");
    expect(text).toContain("Rahul");
    expect(text).toContain("Swiggy");
  });

  it("README sheet explains how to load it in Power BI and warns it is unencrypted", () => {
    const text = grid("README").flat().map((c) => c.v).join("\n");
    expect(text).toContain("Excel workbook");
    expect(text).toMatch(/EXCEPT README/);
    expect(text).toMatch(/not encrypted/i);
    expect(text).toContain("Sheet: fact_transactions");
    expect(text).not.toContain("Unzip"); // CSV-only wording
    for (const k of Object.keys(TABLES)) for (const [c] of TABLES[k].columns) expect(text).toContain(c);
  });

  it("still builds for an empty database (headers only)", () => {
    const empty = readZip(buildAnalyticsWorkbook({ ...input, transactions: [], splitShares: [], budgetHistory: [] }));
    expect(Object.values(empty).every((f) => f.crcOk)).toBe(true);
  });
});
