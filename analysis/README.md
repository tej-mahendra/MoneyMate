# Money Mate — ML analysis

Reads the **analytics workbook** exported from the app (Settings → *Export for analysis* →
**Export analytics (.xlsx)**) and produces forecasts, budget warnings, anomaly flags and a
merchant→category lookup. One file in, one file out. Runs fully on your own PC; nothing is
uploaded.

## Run it

```powershell
pip install -r requirements.txt
python analyze.py D:\MoneyMateData\moneymate-analytics.xlsx
```

Results go to an `ml_output` folder next to the workbook (or use `--out <folder>`).
Read **`summary.txt`** first — it says what was done, how well each method worked on
*your* data, and what not to trust yet.

| In `ml_output` | What it is |
|---|---|
| `ml_results.xlsx` | One workbook, one sheet per result (below) |
| `summary.txt` | Plain-English report |

Sheets in `ml_results.xlsx`:

| Sheet | What it is |
|---|---|
| `forecast_next_month` | Next month's spending: total and per category, with an 80% range |
| `budget_risk` | This month: projected end-of-month spend vs. budget per category (`ok` / `watch` / `over`) |
| `anomalies` | Unusually large purchases and possible duplicate charges |
| `merchant_category_map` | Each merchant's usual category — for auto-categorising new entries later |
| `category_review` | Past entries whose category disagrees with a confident prediction |

Add `--csv` to write separate CSV files instead of the workbook. Older exports (a `.zip` of
CSVs, or the unzipped folder) are still accepted as input.

## Power BI Desktop

1. **Export** from the app and save the file as `moneymate-analytics.xlsx` — always the same
   name in the same folder, so Power BI's saved path keeps working.
2. **Get Data → Excel workbook** → choose it → tick every sheet **except README** → Load.
   Dates and true/false columns arrive already typed. The README sheet lists the
   relationships to create.
3. Run `analyze.py`, then **Get Data → Excel workbook** once more for `ml_results.xlsx`.
4. Next time: save the new export over the old file, re-run the script, and click **Refresh**.

## How it works, and its limits

- **Forecast** — tries four simple methods (last month, 3-month average, 6-month average,
  exponential smoothing), replays each over your past months, and uses the one with the
  smallest average miss. The range comes from that method's own past errors. It needs 3
  completed months to run and 8 to choose between methods; seasonality needs ~24.
- **Budget risk** — projects the month from how past months typically filled up by this day
  (so rent paid on the 2nd doesn't trigger a false alarm), not a straight line.
- **Anomalies** — robust z-score on the log of the amount within each category (needs 8+
  entries in the category), plus same merchant/amount/category within 2 days.
- **Category model** — character n-gram TF-IDF + logistic regression on the merchant name,
  checked with cross-validation against "always guess the biggest category".

A few hundred rows a year is enough for these; it is not enough for deep learning, and the
report will say so rather than pretend. The current (partial) month is never used for
training or backtesting.

The export is not encrypted. Keep it and these outputs on a personal drive, not a work account.
