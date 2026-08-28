# Spendlight

![Python](https://img.shields.io/badge/python-3.8%2B-blue)
![Dependencies](https://img.shields.io/badge/dependencies-none-brightgreen)

An interactive dashboard for [My Expenses](https://f-droid.org/packages/org.totschnig.myexpenses/)
CSV exports — read your spending on a real screen instead of scrolling the phone
app, and without opening a spreadsheet.



## Requirements

**Python 3.8 or newer. That is the entire list.**

There are no third-party packages, so there is nothing to install, no
`virtualenv` to activate and no lockfile to keep current. `requirements.txt`
exists but is deliberately empty — `pip install -r requirements.txt` succeeds
and installs nothing.

This is a deliberate design choice, not an oversight. Many distributions now
mark the system Python as *externally managed* ([PEP 668](https://peps.python.org/pep-0668/) —
Arch, Manjaro, Debian, Fedora), where `pip install` refuses to touch the system
environment and pushes you into a virtualenv. Spendlight avoids that entirely:
it imports only `csv`, `json`, `argparse`, `statistics`, `http.server`,
`webbrowser`, `glob`, `functools`, `datetime`, `os` and `sys`.

The dashboard loads Chart.js from a CDN (pinned with a Subresource Integrity
hash) in the browser, so viewing it needs an internet connection on first load;
generating `data.js` works fully offline.

## Run it

```bash
python3 spendlight.py --serve
```

That is the whole setup. **No dependencies, no virtualenv, no `pip install`** —
Spendlight uses only the Python standard library, so it runs on a stock
system Python (including PEP 668 "externally managed" ones like Arch/Manjaro).

```bash
python3 spendlight.py                     # rebuild data.js from the newest export
python3 spendlight.py path/to/export.csv  # use a specific file
python3 spendlight.py --serve             # rebuild, serve, open the browser
python3 spendlight.py --serve --port 8080 # different port
python3 spendlight.py --currency PLN      # zł, remembered for the next run
```

Without a filename it picks the newest `Budget Book-*.csv` in this folder or the
one above it, and prints which file it used. Without `--serve` it just writes
`data.js`; open `index.html` directly afterwards.

### Getting the export out of the phone

In My Expenses: **⋮ → Backup / Export → Export as CSV**, then copy the file next
to this folder and rerun `spendlight.py`.

## What it shows

**Categories** — a treemap of where the money goes; click a tile to drill from
`Food` into `Grocery / Restaurant / Sweets`. Alongside it, spend per month broken
down by category, and the biggest subcategories in the current selection.

**Trends** — income, spending and what is left, month by month on one scale;
the savings rate with a 3-month average; and a month-by-category table shaded by
how far each month sits from that category's own median, which is what makes an
unusual month obvious.

**Merchants & recurring** — top merchants by spend, and an automatic
subscription detector. A counterparty is flagged as recurring when it bills
across **≥ 4 distinct months**, **≤ 1.3 times per active month**, and with a
**coefficient of variation under 0.25** — that is, roughly monthly, for roughly
the same amount. The three conditions together separate real subscriptions from
merchants you simply visit often: Revolut, Grok, VPS and ChatGPT are caught,
while Lidl and Albert — which recur just as reliably, but at wildly varying
amounts several times a month — correctly are not. Tune the thresholds at the
top of `spendlight.py`.

**Calendar & transactions** — a daily heatmap, spending rhythm by weekday and by
day of month, and a sortable, searchable table of every row.

Filters sit in one row at the top and scope everything below them, so the
charts and the numbers always agree. Almost everything is clickable: a treemap
tile drills in, a bar or a heatmap day becomes a filter, and active filters show
as chips you can dismiss. The tab is kept in the URL, so a view can be
bookmarked. Every chart also has a **Table** toggle — no value is reachable only
by hovering.

## Changing the currency

Do not edit `spendlight.py`. The JavaScript never hardcodes a symbol; the
generator writes whatever you asked for into `data.js`.

```bash
python3 spendlight.py --currency CZK      # Kč (the default)
python3 spendlight.py --currency PLN      # zł
python3 spendlight.py --currency EUR
```

That choice is saved in `spendlight.local.json` next to the script (already in
`.gitignore`), so the next `python3 spendlight.py --serve` keeps it. Built-in
codes: CZK, PLN, EUR, USD, GBP, HUF, RON, BGN, CHF, SEK, NOK, DKK.

Anything else: create `spendlight.local.json` yourself.

```json
{
  "symbol": "RSD",
  "position": "suffix",
  "thousands": " ",
  "decimal": ",",
  "decimals": 2
}
```

## Files

| File | Role |
|---|---|
| `spendlight.py` | Reads the CSV, normalises it, detects recurring charges, writes `data.js`. Also the `--serve` web server. |
| `index.html` | Layout, theme and tab shell. |
| `script.js` | All aggregation, filtering and rendering — runs in the browser, so filters respond instantly. |
| `data.js` | Generated. Not in version control. |
| `spendlight.local.json` | Your currency. Generated by `--currency`. Not in version control. |
| `requirements.txt` | Intentionally empty — documents that there is nothing to install. |
| `pyproject.toml` | Project metadata and the `>=3.8` floor. |

## Notes on the data

Only six of the twelve columns My Expenses exports actually carry data
(`Date`, `Counterparty`, `Income`, `Expense`, `Category`); split transactions,
tags, notes, payment methods, status, reference numbers and attachments are
empty, so nothing is built for them. Rows with no category are bucketed as
`Uncategorized` rather than dropped.

The date format follows the exporting phone's locale, so Spendlight sniffs it:
it tries each known format against **every** row and keeps the one that parses
them all. If two formats both fit (every day is 1–12), it refuses to guess
rather than risk a silent day/month swap. Re-export as ISO `YYYY-MM-DD`, or
include a day greater than 12.

Spendlight is strictly read-only. It never writes back to the phone.
