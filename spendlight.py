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
from datetime import datetime, timezone

# --- Configuration ---------------------------------------------------------

# Change `symbol` to "лв", "€", "$" … and the whole dashboard follows; the
# JavaScript never hardcodes a currency.
CURRENCY = {
    "symbol": "Kč",
    "position": "suffix",   # "suffix" -> "1 234 Kč"; "prefix" -> "€1 234"
    "thousands": " ",  # non-breaking space, Czech convention
    "decimals": 0,          # dashboards read better without haléře
}

# The export's date format follows the phone's locale, so never assume one.
DATE_FORMATS = ["%m/%d/%y", "%d/%m/%y", "%Y-%m-%d", "%d.%m.%Y", "%m/%d/%Y", "%d/%m/%Y"]

# A counterparty is a subscription when it bills across many months, about once
# a month, for about the same amount. Tuned against the reference export: it
# catches Revolut/Grok/Vps/Chatgpt and rejects Lidl/Albert, which recur just as
# often but at wildly varying amounts and several times a month.
RECURRING_MIN_MONTHS = 4
RECURRING_MAX_PER_MONTH = 1.3
RECURRING_MAX_CV = 0.25

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
UNCATEGORIZED = "Uncategorized"


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


def sniff_date_format(raw_rows):
    """Pick the one format that parses every date in the file.

    Guessing per-row would silently swap day and month on ambiguous dates and
    scramble every chart, so require a format that works for the whole file.
    """
    for fmt in DATE_FORMATS:
        try:
            for row in raw_rows:
                datetime.strptime(row["Date"], fmt)
            return fmt
        except (ValueError, TypeError):
            continue
    sample = [r["Date"] for r in raw_rows[:5]]
    sys.exit(
        f"Could not parse the Date column with any known format.\n"
        f"  First dates seen: {sample}\n"
        f"  Formats tried:    {DATE_FORMATS}"
    )


def money(value):
    """My Expenses writes '' for the unused side of a transaction."""
    text = (value or "").strip()
    if not text:
        return 0.0
    return float(text.replace(",", "."))


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
    records = []
    for index, row in enumerate(raw_rows):
        when = datetime.strptime(row["Date"], date_fmt)
        income, expense = money(row.get("Income")), money(row.get("Expense"))
        parent, child = split_category(row.get("Category"))
        is_income = income > 0
        records.append({
            "i": index,
            "date": when.strftime("%Y-%m-%d"),
            "ts": int(when.replace(tzinfo=timezone.utc).timestamp() * 1000),
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
    records.sort(key=lambda r: (r["ts"], r["i"]))
    return records, date_fmt


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
    """{parent: [child, ...]} over expenses, for the drill-down and filter UI."""
    tree = defaultdict(set)
    for rec in records:
        if rec["kind"] == "expense":
            tree[rec["parent"]].add(rec["child"])
    return {parent: sorted(children) for parent, children in sorted(tree.items())}


def summarise(records, tree, recurring, path, date_fmt):
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
    print(f"  recurring detected {len(recurring)}: "
          f"{', '.join(item['cp'] for item in recurring[:8])}")


# --- Output ----------------------------------------------------------------

def write_data_js(records, tree, recurring, path, out_path):
    dump = functools.partial(json.dumps, ensure_ascii=False)
    merchants = sorted({r["cp"] for r in records if r["cp"]})
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
            f"const CURRENCY = {dump(CURRENCY)};\n"
            f"const CATEGORY_TREE = {dump(tree)};\n"
            f"const MERCHANTS = {dump(merchants)};\n"
            f"const RECURRING = {dump(recurring)};\n"
            f"const ROWS = {dump(records)};\n"
        )


def serve(port):
    handler = functools.partial(
        http.server.SimpleHTTPRequestHandler, directory=SCRIPT_DIR)
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        url = f"http://localhost:{port}/index.html"
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
    args = parser.parse_args()

    path = args.csv or discover_csv()
    if not os.path.exists(path):
        sys.exit(f"No such file: {path}")

    records, date_fmt = load(path)
    tree = category_tree(records)
    recurring = find_recurring(records)

    out_path = os.path.join(SCRIPT_DIR, "data.js")
    write_data_js(records, tree, recurring, path, out_path)
    summarise(records, tree, recurring, path, date_fmt)
    print(f"  wrote              {out_path}")

    if args.serve:
        serve(args.port)
    else:
        print(f"\n  open {os.path.join(SCRIPT_DIR, 'index.html')} "
              f"— or rerun with --serve")


if __name__ == "__main__":
    main()
