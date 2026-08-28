#!/usr/bin/env python3
"""Spendlight — turn a My Expenses (org.totschnig.myexpenses) CSV export into an
interactive dashboard.

Reads the export, normalises every row, precomputes the aggregates that are a
property of the whole dataset (rather than of the current filter), and writes
them to data.js. index.html + script.js do the rest client-side.

Standard library only — the system Python is externally managed (PEP 668) and
1,262 rows do not need pandas.

    python3 spendlight.py                    # newest Budget Book-*.csv nearby
    python3 spendlight.py path/to/export.csv # explicit file
    python3 spendlight.py --serve            # regenerate, serve, open browser
    python3 spendlight.py --currency PLN     # zł; remembered in spendlight.local.json
"""

import argparse
import csv
import functools
import glob
import http.server
import json
import os
import statistics
import sys
import webbrowser
from collections import defaultdict
from datetime import datetime

# --- Configuration ---------------------------------------------------------

# Display currency is not a source edit. Pass --currency CZK (or PLN, EUR, …)
# once; it is remembered in spendlight.local.json, which is gitignored.
NBSP = "\u00a0"
DEFAULT_CURRENCY = "CZK"
CURRENCIES = {
    "CZK": {"symbol": "Kč", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 0},
    "PLN": {"symbol": "zł", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "EUR": {"symbol": "€", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "USD": {"symbol": "$", "position": "prefix", "thousands": ",", "decimal": ".", "decimals": 2},
    "GBP": {"symbol": "£", "position": "prefix", "thousands": ",", "decimal": ".", "decimals": 2},
    "HUF": {"symbol": "Ft", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 0},
    "RON": {"symbol": "lei", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "BGN": {"symbol": "лв", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "CHF": {"symbol": "CHF", "position": "prefix", "thousands": "'", "decimal": ".", "decimals": 2},
    "SEK": {"symbol": "kr", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "NOK": {"symbol": "kr", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
    "DKK": {"symbol": "kr", "position": "suffix", "thousands": NBSP, "decimal": ",", "decimals": 2},
}

# The export's date format follows the phone's locale, so never assume one.
DATE_FORMATS = ["%m/%d/%y", "%d/%m/%y", "%Y-%m-%d", "%d.%m.%Y", "%m/%d/%Y", "%d/%m/%Y"]

# Thresholds: many months, about once a month, about the same amount.
RECURRING_MIN_MONTHS = 4
RECURRING_MAX_PER_MONTH = 1.3
RECURRING_MAX_CV = 0.25

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
UNCATEGORIZED = "Uncategorized"
LOCAL_CONFIG = os.path.join(SCRIPT_DIR, "spendlight.local.json")


def _currency_codes():
    return ", ".join(sorted(CURRENCIES))


def _read_local():
    if not os.path.isfile(LOCAL_CONFIG):
        return {}
    try:
        with open(LOCAL_CONFIG, encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, json.JSONDecodeError) as exc:
        sys.exit(f"Could not read {LOCAL_CONFIG}: {exc}")
    if not isinstance(data, dict):
        sys.exit(f"{LOCAL_CONFIG} must be a JSON object.")
    return data


def _write_local(data):
    with open(LOCAL_CONFIG, "w", encoding="utf-8") as handle:
        json.dump(data, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def resolve_currency(cli_code):
    """CLI flag, then spendlight.local.json, then CZK. Never a source edit."""
    local = _read_local()
    if cli_code:
        code = cli_code.strip().upper()
        if code not in CURRENCIES:
            sys.exit(
                f"Unknown currency {cli_code!r}. Known codes: {_currency_codes()}.\n"
                f"For anything else, put symbol/position/thousands/decimal/decimals "
                f"in {os.path.basename(LOCAL_CONFIG)}."
            )
        local = {"currency": code}
        _write_local(local)
    if local.get("symbol"):
        spec = {
            "symbol": str(local["symbol"]),
            "position": local.get("position") or "suffix",
            "thousands": local.get("thousands") if local.get("thousands") is not None else NBSP,
            "decimal": local.get("decimal") or ",",
            "decimals": int(local.get("decimals", 2)),
            "code": (local.get("currency") or "custom").upper(),
        }
        if spec["position"] not in ("prefix", "suffix"):
            sys.exit("currency position must be 'prefix' or 'suffix'.")
        return spec
    code = (local.get("currency") or DEFAULT_CURRENCY).strip().upper()
    if code not in CURRENCIES:
        sys.exit(
            f"{os.path.basename(LOCAL_CONFIG)} has unknown currency {code!r}. "
            f"Known codes: {_currency_codes()}."
        )
    spec = dict(CURRENCIES[code])
    spec["code"] = code
    return spec


# --- Input -----------------------------------------------------------------

def discover_csv():
    """Newest 'Budget Book-*.csv' in the script directory or its parent.

    The export usually lands beside the project rather than inside it, so look
    one level up too. Names carry a sortable -YYYYMMDD-HHMMSS stamp.
    """
    candidates = []
    for folder in (SCRIPT_DIR, os.path.dirname(SCRIPT_DIR)):
        candidates.extend(glob.glob(os.path.join(folder, "Budget Book-*.csv")))
    if not candidates:
        sys.exit(
            "No 'Budget Book-*.csv' found in:\n"
            f"  {SCRIPT_DIR}\n  {os.path.dirname(SCRIPT_DIR)}\n"
            "Pass the file explicitly: python3 spendlight.py path/to/export.csv"
        )
    return max(candidates, key=lambda p: (os.path.basename(p), os.path.getmtime(p)))


def _fits_date_format(fmt, raw_rows):
    try:
        for row in raw_rows:
            datetime.strptime(row["Date"], fmt)
        return True
    except (ValueError, TypeError, KeyError):
        return False


def sniff_date_format(raw_rows):
    """Pick the one format that parses every date in the file.

    Guessing per-row would silently swap day and month. If two formats both
    fit (every day is 1–12), refuse rather than pick MM/DD first.
    """
    fits = [fmt for fmt in DATE_FORMATS if _fits_date_format(fmt, raw_rows)]
    sample = [r.get("Date") for r in raw_rows[:5]]
    if len(fits) == 1:
        return fits[0]
    if len(fits) > 1:
        sys.exit(
            "Date column matches more than one format; refusing to guess "
            "(a day/month swap would scramble every chart).\n"
            f"  Matching formats: {fits}\n"
            f"  First dates seen: {sample}\n"
            "Re-export as ISO YYYY-MM-DD, or include a day > 12 so the locale is obvious."
        )
    sys.exit(
        f"Could not parse the Date column with any known format.\n"
        f"  First dates seen: {sample}\n"
        f"  Formats tried:    {DATE_FORMATS}"
    )


def money(value):
    """Parse an amount. The unused side is '' or '0'."""
    text = (value or "").strip().replace("\u00a0", "").replace(" ", "")
    if not text:
        return 0.0
    if "," in text and "." in text:
        if text.rfind(",") > text.rfind("."):
            text = text.replace(".", "").replace(",", ".")
        else:
            text = text.replace(",", "")
    elif "," in text:
        whole, _, frac = text.partition(",")
        text = (whole + "." + frac) if frac and len(frac) <= 2 and "," not in whole else text.replace(",", "")
    elif text.count(".") > 1:
        text = text.replace(".", "")
    try:
        return float(text)
    except ValueError:
        raise ValueError(f"could not parse amount {value!r}") from None


def split_category(raw):
    """'Food > Grocery' -> ('Food', 'Grocery'); '' -> ('Uncategorized', '')."""
    text = (raw or "").strip()
    if not text:
        return UNCATEGORIZED, ""
    if " > " in text:
        parent, child = text.split(" > ", 1)
        return parent.strip(), child.strip()
    return text, ""


def load(path):
    with open(path, newline="", encoding="utf-8-sig") as handle:
        raw_rows = list(csv.DictReader(handle))
    if not raw_rows:
        sys.exit(f"{path} contains no rows.")

    date_fmt = sniff_date_format(raw_rows)
    splits = sum(1 for row in raw_rows if (row.get("Split transaction") or "").strip())
    records = []
    for index, row in enumerate(raw_rows):
        when = datetime.strptime(row["Date"], date_fmt)
        try:
            income, expense = money(row.get("Income")), money(row.get("Expense"))
        except ValueError as exc:
            sys.exit(f"Row {index + 2}: {exc}")
        if income > 0 and expense > 0:
            sys.exit(
                f"Row {index + 2} has both Income ({income}) and Expense ({expense}). "
                "Spendlight expects one side per row."
            )
        parent, child = split_category(row.get("Category"))
        is_income = income > 0
        records.append({
            "i": index,
            "date": when.strftime("%Y-%m-%d"),
            "cp": (row.get("Counterparty") or "").strip(),
            "amt": income if is_income else expense,
            "kind": "income" if is_income else "expense",
            "parent": parent,
            "child": child,
            "cat": f"{parent} > {child}" if child else parent,
            "ym": when.strftime("%Y-%m"),
            "dow": when.weekday(),      # 0 = Monday
            "dom": when.day,
        })
    records.sort(key=lambda r: (r["date"], r["i"]))
    return records, date_fmt, splits


# --- Whole-dataset aggregates ----------------------------------------------

def find_recurring(records):
    """Counterparties that look like subscriptions, newest charge first.

    Filter-independent: whether Spotify is a subscription does not change when
    you zoom the dashboard into one month, so it is settled once, here.
    """
    charges = defaultdict(list)
    for rec in records:
        if rec["kind"] == "expense" and rec["cp"]:
            charges[rec["cp"]].append(rec)

    found = []
    for merchant, rows in charges.items():
        months = {r["ym"] for r in rows}
        if len(months) < RECURRING_MIN_MONTHS:
            continue
        if len(rows) / len(months) > RECURRING_MAX_PER_MONTH:
            continue
        amounts = [r["amt"] for r in rows]
        mean = statistics.fmean(amounts)
        if mean <= 0:
            continue
        cv = statistics.pstdev(amounts) / mean
        if cv >= RECURRING_MAX_CV:
            continue
        found.append({
            "cp": merchant,
            "n": len(rows),
            "months": len(months),
            "total": round(sum(amounts), 2),
            "avg": round(mean, 2),
            "cv": round(cv, 3),
            "annual": round(mean * 12, 2),
            "last": rows[-1]["date"],
            "cat": rows[-1]["cat"],
            # Sparkline of the charge history — a price rise shows up as a step.
            "history": [{"date": r["date"], "amt": r["amt"]} for r in rows],
        })
    found.sort(key=lambda item: -item["annual"])
    return found


def category_tree(records):
    """{parent: [child, ...]} over every row, so Income (Salary, …) is filterable."""
    tree = defaultdict(set)
    for rec in records:
        tree[rec["parent"]].add(rec["child"])
    return {parent: sorted(children) for parent, children in sorted(tree.items())}


def summarise(records, tree, recurring, path, date_fmt, splits, currency):
    """Print the stdout summary used to verify the numbers did not drift."""
    expense = sum(r["amt"] for r in records if r["kind"] == "expense")
    income = sum(r["amt"] for r in records if r["kind"] == "income")
    months = sorted({r["ym"] for r in records})
    leaves = {r["cat"] for r in records if r["kind"] == "expense"}
    uncategorized = sum(1 for r in records if r["parent"] == UNCATEGORIZED)
    rate = (income - expense) / income * 100 if income else 0.0

    print(f"Spendlight — {os.path.basename(path)}")
    print(f"  rows parsed        {len(records)}  (date format {date_fmt})")
    print(f"  date range         {records[0]['date']} -> {records[-1]['date']}"
          f"  ({len(months)} months)")
    print(f"  categories         {len(leaves)} leaves in {len(tree)} parents")
    print(f"  total expense      {expense:,.2f}")
    print(f"  total income       {income:,.2f}")
    print(f"  net saved          {income - expense:,.2f}  ({rate:.1f}%)")
    print(f"  uncategorized      {uncategorized} rows")
    if splits:
        print(f"  split rows         {splits} (column ignored; each line is one record)")
    print(f"  currency           {currency['code']} ({currency['symbol']})")
    print(f"  recurring detected {len(recurring)}: "
          f"{', '.join(item['cp'] for item in recurring[:8])}")


# --- Output ----------------------------------------------------------------

def write_data_js(records, tree, recurring, path, out_path, currency):
    dump = functools.partial(json.dumps, ensure_ascii=False)
    meta = {
        "source": os.path.basename(path),
        "generated": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "first": records[0]["date"],
        "last": records[-1]["date"],
        "count": len(records),
    }
    with open(out_path, "w", encoding="utf-8") as handle:
        handle.write(
            "// data.js — generated by spendlight.py, do not edit by hand.\n"
            f"const META = {dump(meta)};\n"
            f"const CURRENCY = {dump(currency)};\n"
            f"const CATEGORY_TREE = {dump(tree)};\n"
            f"const RECURRING = {dump(recurring)};\n"
            f"const ROWS = {dump(records)};\n"
        )


def serve(port):
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=SCRIPT_DIR)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://127.0.0.1:{port}/index.html"
        print(f"\n  serving {url}   (ctrl-c to stop)")
        webbrowser.open(url)
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n  stopped.")


def main():
    parser = argparse.ArgumentParser(
        description="Build the Spendlight dashboard from a My Expenses CSV export.")
    parser.add_argument("csv", nargs="?",
                        help="export to read (default: newest Budget Book-*.csv nearby)")
    parser.add_argument("--serve", action="store_true",
                        help="serve the dashboard and open it in a browser")
    parser.add_argument("--port", type=int, default=8000, help="port for --serve")
    parser.add_argument(
        "--currency", metavar="CODE",
        help="display currency (CZK, PLN, EUR, USD, …). Saved in spendlight.local.json, not in git.")
    args = parser.parse_args()

    currency = resolve_currency(args.currency)

    path = args.csv or discover_csv()
    if not os.path.exists(path):
        sys.exit(f"No such file: {path}")

    records, date_fmt, splits = load(path)
    tree = category_tree(records)
    recurring = find_recurring(records)

    out_path = os.path.join(SCRIPT_DIR, "data.js")
    write_data_js(records, tree, recurring, path, out_path, currency)
    summarise(records, tree, recurring, path, date_fmt, splits, currency)
    print(f"  wrote              {out_path}")

    if args.serve:
        serve(args.port)
    else:
        print(f"\n  open {os.path.join(SCRIPT_DIR, 'index.html')} "
              f"— or rerun with --serve")


if __name__ == "__main__":
    main()
