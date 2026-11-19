#!/usr/bin/env python3
"""Money Mate — ML analysis of the analytics export.

Usage:
    python analyze.py moneymate-analytics-2026-11-18.zip
    python analyze.py D:\\MoneyMateData --out D:\\MoneyMateData\\ml_output

Reads the CSVs from the app's "Export analytics bundle" (a .zip or the unzipped
folder) and writes results as CSV files you can load straight into Power BI:

    forecast_next_month.csv     next month's spending, total and per category
    budget_risk.csv             which categories are on track to break this month's budget
    anomalies.csv               unusually large purchases and possible duplicate charges
    merchant_category_map.csv   merchant -> usual category (for auto-categorising new entries)
    category_review.csv         past entries whose category looks inconsistent with the rest
    summary.txt                 plain-English report: what was done, how good it is, caveats

Methods are deliberately simple. A person logging ~75 entries a month has a few
hundred rows a year: enough for these techniques, not enough for deep learning.
summary.txt says how well each one actually works on YOUR data (backtests against
naive baselines) so you know how far to trust it.
"""
from __future__ import annotations

import argparse
import sys
import tempfile
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

Z80 = 1.2816  # 80% two-sided normal interval
MIN_MONTHS = 3


# ───────────────────────── loading ─────────────────────────
def load(src: Path) -> dict[str, pd.DataFrame]:
    if src.suffix.lower() == ".zip":
        tmp = Path(tempfile.mkdtemp(prefix="moneymate_"))
        with zipfile.ZipFile(src) as z:
            z.extractall(tmp)
        src = tmp
    names = ["fact_transactions", "dim_category", "fact_monthly", "fact_month_summary", "export_info"]
    out = {}
    for n in names:
        f = src / f"{n}.csv"
        if not f.exists():
            sys.exit(f"Missing {f.name} in {src}. Is this a Money Mate analytics export?")
        out[n] = pd.read_csv(f, encoding="utf-8-sig")  # BOM-safe
    info = dict(zip(out["export_info"]["Key"], out["export_info"]["Value"].astype(str)))
    if int(info.get("AnalyticsSchemaVersion", 0)) > 1:
        print("Warning: this export is newer than this script knows; results may be incomplete.")
    out["info"] = info
    return out


# ───────────────────────── forecasting ─────────────────────────
def ses_fit(y: np.ndarray) -> tuple[float, float, float]:
    """Simple exponential smoothing. Returns (next_level, alpha, one-step error std)."""
    best = None
    for alpha in np.arange(0.1, 0.95, 0.05):
        level, errs = y[0], []
        for v in y[1:]:
            errs.append(v - level)
            level = alpha * v + (1 - alpha) * level
        sse = float(np.sum(np.square(errs)))
        if best is None or sse < best[0]:
            best = (sse, level, alpha, errs)
    _, level, alpha, errs = best
    return level, float(alpha), float(np.std(errs, ddof=1)) if len(errs) > 1 else 0.0


# Candidate methods, simplest first (ties go to the simpler one).
METHODS = {
    "last_month": lambda y: float(y[-1]),
    "mean_last_3": lambda y: float(np.mean(y[-3:])),
    "mean_last_6": lambda y: float(np.mean(y[-6:])),
    "exp_smoothing": lambda y: float(ses_fit(y)[0]),
}


def rolling_errors(y: np.ndarray, fn, start: int) -> np.ndarray:
    """One-step-ahead errors: forecast each month using only the months before it."""
    return np.array([y[i] - fn(y[:i]) for i in range(start, len(y))])


def forecast(y: np.ndarray) -> dict | None:
    """Next-value forecast with an 80% interval, or None if there is too little data.

    With 8+ months the method is chosen by backtest (lowest average miss); the
    interval comes from that method's own past errors, so it is as wide as the
    method has actually been wrong. Below 8 months there is nothing to choose
    between, so it uses the 3-month average and the spread of the data."""
    n = len(y)
    if n < MIN_MONTHS:
        return None
    conf = "low" if n < 6 else "medium" if n < 12 else "good"
    if n < 8:
        point, sigma = METHODS["mean_last_3"](y), float(np.std(y, ddof=1))
        return dict(point=point, low=max(0.0, point - Z80 * sigma), high=point + Z80 * sigma,
                    method="mean_last_3", months=n, confidence=conf, scores=None)
    start = max(4, n // 2)
    errs = {k: rolling_errors(y, fn, start) for k, fn in METHODS.items()}
    scores = {k: float(np.mean(np.abs(e))) for k, e in errs.items()}
    best = min(METHODS, key=lambda k: (round(scores[k], 6), list(METHODS).index(k)))
    point = METHODS[best](y)
    sigma = float(np.std(errs[best], ddof=1)) if len(errs[best]) > 1 else 0.0
    return dict(point=point, low=max(0.0, point - Z80 * sigma), high=point + Z80 * sigma,
                method=best, months=n, confidence=conf, scores=scores, tests=len(errs[best]))


def next_month(asof: pd.Timestamp) -> str:
    return (asof.to_period("M") + 1).strftime("%Y-%m")


def build_forecasts(d, asof, report):
    summary = d["fact_month_summary"]
    complete = summary[~summary["IsPartialMonth"]].sort_values("YearMonth")
    rows, target = [], next_month(asof)
    t = forecast(complete["Spent"].to_numpy(float))
    if t is None:
        report.append(f"FORECAST: needs at least {MIN_MONTHS} completed months; you have {len(complete)}. Skipped.")
        return pd.DataFrame()
    rows.append(dict(Level="Total", CategoryId="", Category="All spending", ForecastMonth=target, **_fmt(t)))

    cat = d["dim_category"].set_index("CategoryId")
    fm = d["fact_monthly"]
    fm = fm[(~fm["IsPartialMonth"]) & (fm["CategoryId"].map(cat["Flow"]) == "Spend")]
    for cid, g in fm.groupby("CategoryId"):
        y = g.sort_values("YearMonth")["Actual"].to_numpy(float)
        if y.sum() == 0:
            continue
        f = forecast(y)
        if f:
            rows.append(dict(Level="Category", CategoryId=cid, Category=cat.loc[cid, "Category"],
                             ForecastMonth=target, **_fmt(f)))
    out = pd.DataFrame(rows)

    report.append(f"FORECAST for {target}: total spend ≈ {t['point']:,.0f} (80% range {t['low']:,.0f}–{t['high']:,.0f}); "
                  f"based on {t['months']} completed months, confidence {t['confidence']}.")
    if t["scores"]:
        ranked = ", ".join(f"{k} {v:,.0f}" for k, v in sorted(t["scores"].items(), key=lambda kv: kv[1]))
        report.append(f"  Method '{t['method']}' was chosen because it had the smallest average miss when replayed on "
                      f"{t['tests']} past months (average miss per method: {ranked}).")
        report.append("  The range is how far off that method has actually been, so it reflects the real noise in your spending.")
    else:
        report.append("  Fewer than 8 completed months, so it uses the average of the last 3 and cannot compare methods yet.")
    if t["months"] < 24:
        report.append("  With under 24 months, seasonal effects (festivals, annual bills) cannot be learned.")
    return out


def _fmt(f):
    return dict(Forecast=round(f["point"], 2), Low80=round(f["low"], 2), High80=round(f["high"], 2),
                Method=f["method"], MonthsOfHistory=f["months"], Confidence=f["confidence"])


# ───────────────────────── budget risk ─────────────────────────
def build_budget_risk(d, asof, report):
    """Project the current month's spend per category from how past months filled up."""
    tx = d["fact_transactions"]
    tx = tx[tx["Flow"] == "Spend"].copy()
    tx["Date"] = pd.to_datetime(tx["Date"])
    tx["YM"] = tx["Date"].dt.strftime("%Y-%m")
    cur = asof.strftime("%Y-%m")
    day, dim = asof.day, asof.days_in_month
    cat = d["dim_category"].set_index("CategoryId")
    fm = d["fact_monthly"]
    now = fm[(fm["YearMonth"] == cur) & (fm["CategoryId"].map(cat["Flow"]) == "Spend") & (fm["Budget"] > 0)]
    hist = tx[tx["YM"] < cur]

    def frac_done(frame) -> tuple[float, int]:
        fr = []
        for _, g in frame.groupby("YM"):
            total = g["Amount"].sum()
            if total > 0:
                fr.append(g.loc[g["Date"].dt.day <= day, "Amount"].sum() / total)
        return (float(np.median(fr)), len(fr)) if fr else (day / dim, 0)

    overall_f, overall_n = frac_done(hist)
    rows = []
    for _, r in now.iterrows():
        cid = int(r["CategoryId"])
        f, n = frac_done(hist[hist["CategoryId"] == cid])
        method = "history" if n >= 3 else "all-spending history" if overall_n >= 3 else "linear"
        if n < 3:
            f = overall_f
        f = float(np.clip(f, 0.15, 1.0))  # don't explode a projection from a tiny fraction
        spent = float(r["Actual"])
        proj = spent / f if spent > 0 else 0.0
        rows.append(_risk_row("Category", cid, cat.loc[cid, "Category"], r["Budget"], spent, day, f, proj, method))

    if len(now):
        tb, ts = float(now["Budget"].sum()), float(now["Actual"].sum())
        f = float(np.clip(overall_f, 0.15, 1.0))
        rows.append(_risk_row("Total", "", "All budgeted spending", tb, ts, day, f, ts / f if ts > 0 else 0.0,
                              "history" if overall_n >= 3 else "linear"))
    out = pd.DataFrame(rows)
    if len(out):
        flagged = out[(out["Level"] == "Category") & (out["Risk"] != "ok")]
        report.append(f"BUDGET RISK ({cur}, day {day} of {dim}): {len(flagged)} of {int((out['Level']=='Category').sum())} "
                      f"budgeted categories look over or close to budget"
                      + (": " + ", ".join(flagged["Category"]) if len(flagged) else "") + ".")
        if overall_n < 3:
            report.append("  Fewer than 3 completed months of history, so projections use a straight-line estimate.")
    return out


def _risk_row(level, cid, name, budget, spent, day, f, proj, method):
    ratio = proj / budget if budget > 0 else 0.0
    return dict(Level=level, CategoryId=cid, Category=name, Budget=round(float(budget), 2),
                SpentSoFar=round(spent, 2), DayOfMonth=day, ExpectedFractionDone=round(f, 3),
                ProjectedEndOfMonth=round(proj, 2), ProjectedVsBudget=round(ratio, 3),
                Risk="over" if ratio > 1.05 else "watch" if ratio >= 0.9 else "ok", Method=method)


# ───────────────────────── anomalies ─────────────────────────
def build_anomalies(d, report):
    tx = d["fact_transactions"]
    tx = tx[tx["Flow"] == "Spend"].copy()
    cat = d["dim_category"].set_index("CategoryId")["Category"]
    tx["Category"] = tx["CategoryId"].map(cat).fillna("Uncategorized")
    rows = []
    for cid, g in tx.groupby("CategoryId"):
        if len(g) < 8:
            continue
        x = np.log1p(g["Amount"].to_numpy(float))  # purchases are right-skewed
        med = np.median(x)
        mad = np.median(np.abs(x - med)) * 1.4826
        if mad == 0:
            continue
        z = (x - med) / mad
        for (_, r), zi in zip(g.iterrows(), z):
            if zi > 3.5:
                rows.append(_anom(r, "unusually large for this category", zi))

    tx["MerchantClean"] = tx["MerchantClean"].fillna("")
    tx["D"] = pd.to_datetime(tx["Date"])
    dup = tx[tx["MerchantClean"] != ""].sort_values(["MerchantClean", "Amount", "D", "TransactionId"])
    for _, g in dup.groupby(["MerchantClean", "Amount", "CategoryId"]):
        prev = None
        for _, r in g.iterrows():
            if prev is not None and (r["D"] - prev["D"]).days <= 2:
                rows.append(_anom(r, f"possible duplicate of transaction {int(prev['TransactionId'])}", np.nan))
            prev = r
    out = pd.DataFrame(rows, columns=["TransactionId", "Date", "Category", "Merchant", "Amount", "Reason", "Score"])
    out = out.sort_values("Date", ascending=False).reset_index(drop=True)
    report.append(f"ANOMALIES: {len(out)} flagged ({int(out['Reason'].str.startswith('unusually').sum())} unusually large, "
                  f"{int(out['Reason'].str.startswith('possible duplicate').sum())} possible duplicates). "
                  "Categories with fewer than 8 entries are not checked. Review them — a flag is a prompt, not a verdict.")
    return out


def _anom(r, reason, z):
    return dict(TransactionId=int(r["TransactionId"]), Date=r["Date"], Category=r["Category"],
                Merchant=r["Merchant"] if isinstance(r["Merchant"], str) else "", Amount=r["Amount"],
                Reason=reason, Score=None if pd.isna(z) else round(float(z), 2))


# ───────────────────────── merchant → category ─────────────────────────
def build_category_model(d, report):
    from sklearn.feature_extraction.text import TfidfVectorizer
    from sklearn.linear_model import LogisticRegression
    from sklearn.model_selection import StratifiedKFold, cross_val_predict
    from sklearn.pipeline import make_pipeline

    tx = d["fact_transactions"]
    cat = d["dim_category"].set_index("CategoryId")["Category"]
    tx = tx[(tx["Flow"] == "Spend") & (tx["CategoryId"] > 0)].copy()
    tx["MerchantClean"] = tx["MerchantClean"].fillna("").astype(str)
    tx = tx[tx["MerchantClean"] != ""]

    mm = pd.DataFrame()
    if len(tx):
        g = tx.groupby(["MerchantClean", "CategoryId"]).size().rename("n").reset_index()
        tot = g.groupby("MerchantClean")["n"].transform("sum")
        g["Share"] = (g["n"] / tot).round(3)
        top = g.sort_values(["MerchantClean", "n"], ascending=[True, False]).drop_duplicates("MerchantClean")
        mm = pd.DataFrame(dict(MerchantClean=top["MerchantClean"], Category=top["CategoryId"].map(cat),
                               CategoryId=top["CategoryId"], Entries=tot.loc[top.index].to_numpy(),
                               Share=top["Share"])).sort_values("Entries", ascending=False)

    counts = tx["CategoryId"].value_counts()
    ok_classes = counts[counts >= 5].index
    use = tx[tx["CategoryId"].isin(ok_classes)]
    if len(use) < 60 or len(ok_classes) < 2:
        report.append(f"CATEGORY MODEL: needs ~60 entries with merchant names across at least 2 categories "
                      f"(5+ each); you have {len(use)} usable so far. Skipped — the merchant lookup table was still written.")
        return mm, pd.DataFrame()

    folds = int(min(5, counts[ok_classes].min()))
    model = make_pipeline(TfidfVectorizer(analyzer="char_wb", ngram_range=(2, 4), lowercase=True),
                          LogisticRegression(max_iter=2000, C=5.0))
    X, y = use["MerchantClean"], use["CategoryId"]
    proba = cross_val_predict(model, X, y, cv=StratifiedKFold(folds, shuffle=True, random_state=0), method="predict_proba")
    classes = np.sort(y.unique())
    pred = classes[proba.argmax(1)]
    acc = float((pred == y.to_numpy()).mean())
    base = float(counts[ok_classes].max() / counts[ok_classes].sum())
    report.append(f"CATEGORY MODEL: predicts a category from the merchant name. {folds}-fold cross-validated accuracy "
                  f"{acc:.0%} vs {base:.0%} for always guessing the biggest category, on {len(use)} entries. "
                  "Real merchant names are messier than a clean demo, so expect this on new merchants to be lower.")

    conf = proba.max(1)
    mism = (pred != y.to_numpy()) & (conf > 0.8)
    review = pd.DataFrame(dict(TransactionId=use["TransactionId"], Date=use["Date"], Merchant=use["Merchant"],
                               CurrentCategory=y.map(cat), SuggestedCategory=pd.Series(pred, index=use.index).map(cat),
                               Probability=np.round(conf, 3)))[mism].sort_values("Date", ascending=False)
    report.append(f"  {len(review)} past entries have a category that disagrees with a confident prediction "
                  "(see category_review.csv) — possible mis-clicks.")
    return mm, review


# ───────────────────────── main ─────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("source", type=Path, help="analytics .zip or the unzipped folder")
    ap.add_argument("--out", type=Path, help="output folder (default: ml_output next to the data)")
    a = ap.parse_args()
    d = load(a.source)
    asof = pd.Timestamp(d["info"]["AsOfDate"])
    out = a.out or (a.source.parent if a.source.is_file() else a.source) / "ml_output"
    out.mkdir(parents=True, exist_ok=True)

    tx = d["fact_transactions"]
    months = int((~d["fact_month_summary"]["IsPartialMonth"]).sum())
    report = [f"MONEY MATE ANALYSIS — data as of {asof.date()}",
              f"{len(tx)} transactions over {len(d['fact_month_summary'])} months ({months} completed).", ""]
    build_forecasts(d, asof, report).to_csv(out / "forecast_next_month.csv", index=False, encoding="utf-8-sig")
    report.append("")
    build_budget_risk(d, asof, report).to_csv(out / "budget_risk.csv", index=False, encoding="utf-8-sig")
    report.append("")
    an = build_anomalies(d, report)
    an.to_csv(out / "anomalies.csv", index=False, encoding="utf-8-sig")
    report.append("")
    mm, review = build_category_model(d, report)
    mm.to_csv(out / "merchant_category_map.csv", index=False, encoding="utf-8-sig")
    review.to_csv(out / "category_review.csv", index=False, encoding="utf-8-sig")
    (out / "summary.txt").write_text("\n".join(report) + "\n", encoding="utf-8")
    print("\n".join(report))
    print(f"\nFiles written to {out}")


if __name__ == "__main__":
    main()
