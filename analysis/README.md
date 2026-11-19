# Money Mate — ML analysis

Reads the **analytics bundle** exported from the app (Settings → Analysis exports →
*Export analytics bundle (.zip)*) and produces forecasts, budget warnings, anomaly
flags and a merchant→category lookup. Runs fully on your own PC; nothing is uploaded.

## Run it

```powershell
pip install -r requirements.txt
python analyze.py D:\MoneyMateData\moneymate-analytics-2026-11-18.zip
```

Results go to an `ml_output` folder next to the zip (or use `--out <folder>`).
Read **`summary.txt`** first — it says what was done, how well each method worked on
*your* data, and what not to trust yet.

| File | What it is |
|---|---|
| `forecast_next_month.csv` | Next month's spending: total and per category, with an 80% range |
| `budget_risk.csv` | This month: projected end-of-month spend vs. budget per category (`ok` / `watch` / `over`) |
| `anomalies.csv` | Unusually large purchases and possible duplicate charges |
| `merchant_category_map.csv` | Each merchant's usual category — for auto-categorising new entries later |
| `category_review.csv` | Past entries whose category disagrees with a confident prediction |
| `summary.txt` | Plain-English report |

## Load the results into Power BI

*Get Data → Text/CSV* for each result file. They are standalone tables; relate
`CategoryId` to `dim_category[CategoryId]` if you want to filter them with the rest of
your model. Re-run the script after each new export and click Refresh.

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

The export is plain text. Keep it and these outputs on a personal drive, not a work account.
