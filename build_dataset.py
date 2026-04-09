"""
Build historical HKJC dataset via HTML scraping
------------------------------------------------
Scrapes race results from racing.hkjc.com results pages, which are
server-side rendered with real HTML tables — no GraphQL needed.

URL pattern:
  https://racing.hkjc.com/en-us/local/information/localresults
    ?RaceDate=YYYY/MM/DD&Venue=HV|ST&RaceNo=N

Usage:
    python -m horse_racing.build_dataset --out hkjc_results.csv
    python -m horse_racing.build_dataset --out hkjc_results.csv --start 2018-09-01
    python -m horse_racing.build_dataset --out hkjc_results.csv --resume  # append new dates
    python -m horse_racing.build_dataset --out hkjc_results.csv --start 2010-01-01 --all-days

Notes
-----
- HKJC races Wed (HV), Sat and Sun (HV or ST).  The script tries only those
  weekdays to reduce requests (~30% of calendar days).
- Rate-limited to ~1.5 s per request so the server doesn't block us.
- An empty results page (no tbody data) means no race that day/venue; skipped.
- Run time for 6 seasons (2018-2024): ~2-3 hours.  Use --resume to continue.
"""

import argparse
import time
import os
import re
import sys
from datetime import date, timedelta

import requests
import pandas as pd
from bs4 import BeautifulSoup

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

BASE_URL    = "https://racing.hkjc.com/en-us/local/information/localresults"
HEADERS     = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://racing.hkjc.com/",
}
VENUES        = ["HV", "ST"]
RACE_WEEKDAYS = {2, 5, 6}   # Wednesday=2, Saturday=5, Sunday=6
MAX_RACES     = 12           # HKJC cards have at most 12 races
SLEEP_S       = 1.5          # seconds between HTTP requests


# ---------------------------------------------------------------------------
# Date helpers
# ---------------------------------------------------------------------------

def _all_dates(start: date, end: date):
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def _candidate_dates(start: date, end: date):
    for d in _all_dates(start, end):
        if d.weekday() in RACE_WEEKDAYS:
            yield d


# ---------------------------------------------------------------------------
# HTML parsing
# ---------------------------------------------------------------------------

def _clean(text: str) -> str:
    """Strip whitespace and HTML entities from a cell text."""
    return re.sub(r"\s+", " ", text).strip()


def _safe_float(s: str):
    try:
        return float(re.sub(r"[^\d.]", "", s)) if s and s.strip("-") else None
    except ValueError:
        return None


def _safe_int(s: str):
    try:
        return int(re.sub(r"[^\d]", "", s))
    except (ValueError, TypeError):
        return None


def scrape_race(race_date: str, venue: str, race_no: int):
    """
    Fetch and parse one race result page.

    Returns dict with keys:
        meta   – {class, distance, going, course, pool}
        runners – list of row dicts

    Returns None if the page has no results (no race that day/number).
    """
    params = {
        "RaceDate": race_date.replace("-", "/"),   # YYYY/MM/DD format
        "Venue":    venue,
        "RaceNo":   str(race_no),
    }
    try:
        resp = requests.get(BASE_URL, params=params, headers=HEADERS, timeout=20)
        resp.raise_for_status()
    except requests.RequestException:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")

    # ── Race-level metadata ──────────────────────────────────────────────────
    # The race info lives in a <tbody> before the performance table.
    # Row pattern:  "Class 5 - 1650M - (40-0)"  /  "GOING: GOOD"  /  "COURSE: ..."
    meta = {"class": "", "distance": None, "going": "", "course": "", "pool": None}

    info_rows = soup.select("table tbody tr")
    for tr in info_rows:
        cells = [_clean(td.get_text()) for td in tr.find_all("td")]
        if not cells:
            continue
        first = cells[0]
        # Class / distance:  "Class 5 - 1650M - (...)"
        m = re.match(r"(Class\s*\S+)\s*[-–]\s*(\d+)\s*M", first, re.IGNORECASE)
        if m:
            meta["class"]    = m.group(1).strip()
            meta["distance"] = int(m.group(2))
        # Prize money:  "HK$ 875,000"
        if "HK$" in first:
            num = re.sub(r"[^\d]", "", first.split("HK$")[-1])
            meta["pool"] = int(num) if num else None
        # Going / Course labels appear in column 1
        if len(cells) >= 3:
            label = cells[1].lower()
            if "going" in label:
                meta["going"]  = _clean(cells[2]) if len(cells) > 2 else ""
            if "course" in label:
                meta["course"] = _clean(cells[2]) if len(cells) > 2 else ""

    # ── Performance table ────────────────────────────────────────────────────
    # Locate the table that has the "Pla." header.
    perf_table = None
    for tbl in soup.find_all("table"):
        header_text = tbl.get_text()
        if "Pla." in header_text and "Horse No." in header_text:
            perf_table = tbl
            break

    if perf_table is None:
        return None   # no results → no race this number/day

    # Parse column positions from thead
    col_headers = [
        _clean(td.get_text()).lower()
        for td in perf_table.select("thead tr td")
    ]

    def _col(names):
        for name in names:
            for i, h in enumerate(col_headers):
                if name in h:
                    return i
        return None

    i_place   = _col(["pla"])
    i_horse_no= _col(["horse no"])
    i_horse   = _col(["horse"])
    i_jockey  = _col(["jockey"])
    i_trainer = _col(["trainer"])
    i_act_wt  = _col(["act. wt", "actual"])
    i_decl_wt = _col(["declar"])
    i_draw    = _col(["dr."])
    i_lbw     = _col(["lbw", "length"])
    i_time    = _col(["finish time", "time"])
    i_odds    = _col(["win odds", "odds"])

    # horse column may match trainer too (both contain "horse") — take the
    # first occurrence after horse_no
    if i_horse is not None and i_horse_no is not None and i_horse <= i_horse_no:
        # find the SECOND occurrence of "horse"
        hits = [i for i, h in enumerate(col_headers) if "horse" in h]
        i_horse = hits[1] if len(hits) > 1 else i_horse

    runners = []
    tbody = perf_table.find("tbody", class_="f_fs12")
    if tbody is None:
        tbody = perf_table.find("tbody")
    if tbody is None:
        return None

    for tr in tbody.find_all("tr"):
        cells_raw = tr.find_all("td")
        if len(cells_raw) < 4:
            continue
        cells = [_clean(c.get_text()) for c in cells_raw]

        def _get(idx):
            if idx is None or idx >= len(cells):
                return ""
            return cells[idx]

        place_raw = _get(i_place)
        # Skip non-numeric placing (header rows, spacer rows)
        if not re.match(r"^\d", place_raw.split()[0] if place_raw else ""):
            continue

        # Horse name: strip the "(code)" suffix
        horse_raw = _get(i_horse)
        horse_match = re.match(r"^(.*?)\s*\(([A-Z0-9]+)\)\s*$", horse_raw)
        horse_name = horse_match.group(1).strip() if horse_match else horse_raw
        horse_id   = horse_match.group(2).strip() if horse_match else ""

        # Jockey / Trainer: link text already cleaned
        jockey  = _get(i_jockey)
        trainer = _get(i_trainer)

        runners.append({
            "place":     _safe_int(place_raw),
            "horse_no":  _safe_int(_get(i_horse_no)),
            "horse":     horse_name,
            "horse_id":  horse_id,
            "jockey":    jockey,
            "trainer":   trainer,
            "act_wt":    _safe_float(_get(i_act_wt)),
            "declar_wt": _safe_float(_get(i_decl_wt)),
            "draw":      _safe_int(_get(i_draw)),
            "lbw":       _safe_float(_get(i_lbw)),
            "time":      _get(i_time) or None,
            "win_odds":  _safe_float(_get(i_odds)),
        })

    if not runners:
        return None

    return {"meta": meta, "runners": runners}


def scrape_day(race_date: str, venue: str) -> pd.DataFrame:
    """Scrape all races for one date+venue. Returns empty DF if no races."""
    rows = []
    for race_no in range(1, MAX_RACES + 1):
        result = scrape_race(race_date, venue, race_no)
        time.sleep(SLEEP_S)
        if result is None:
            # No more races on this card
            break
        meta    = result["meta"]
        runners = result["runners"]
        for r in runners:
            rows.append({
                "date":      race_date,
                "location":  venue,
                "race_no":   race_no,
                "class":     meta["class"],
                "distance":  meta["distance"],
                "going":     meta["going"],
                "course":    meta["course"],
                "pool":      meta["pool"],
                **r,
            })
    df = pd.DataFrame(rows)
    if not df.empty and "place" in df.columns:
        df["won"] = (pd.to_numeric(df["place"], errors="coerce") == 1).astype(int)
    return df


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Build HKJC historical dataset via HTML scraping")
    parser.add_argument("--out",   default="hkjc_results.csv",
                        help="Output CSV path (default: hkjc_results.csv)")
    parser.add_argument("--start", default="2018-09-01",
                        help="Start date YYYY-MM-DD (default: 2018-09-01)")
    parser.add_argument("--end",   default=date.today().strftime("%Y-%m-%d"),
                        help="End date YYYY-MM-DD (default: today)")
    parser.add_argument("--resume", action="store_true",
                        help="Append to existing CSV, skip already-fetched dates")
    parser.add_argument("--all-days", action="store_true",
                        help="Try every calendar day (slow; Wed/Sat/Sun by default)")
    args = parser.parse_args()

    start = date.fromisoformat(args.start)
    end   = date.fromisoformat(args.end)

    # Load existing data if resuming
    existing_dates: set = set()
    frames = []
    if args.resume and os.path.exists(args.out):
        existing_df = pd.read_csv(args.out, low_memory=False)
        existing_dates = set(existing_df["date"].astype(str).unique())
        frames.append(existing_df)
        print(f"[resume] {len(existing_df):,} rows across {len(existing_dates)} dates already saved.")

    gen      = _all_dates if args.all_days else _candidate_dates
    all_days = list(gen(start, end))
    total    = len(all_days)
    fetched  = 0

    for i, d in enumerate(all_days, 1):
        d_str = d.strftime("%Y-%m-%d")
        if d_str in existing_dates:
            continue

        day_frames = []
        for venue in VENUES:
            df = scrape_day(d_str, venue)
            if not df.empty:
                day_frames.append(df)
                fetched += len(df)

        if day_frames:
            frames.extend(day_frames)
            races_today = sum(df["race_no"].max() for df in day_frames)
            print(f"  {d_str}  races={int(races_today)}  rows={sum(len(f) for f in day_frames)}")

        # Save checkpoint every 30 calendar days processed
        if frames and i % 30 == 0:
            _save(frames, args.out)
            print(f"  [checkpoint {i}/{total}]  {fetched:,} rows saved → {args.out}")

    if not frames:
        print("No data fetched. Check --start / --end or try --all-days.")
        return

    _save(frames, args.out)
    result = pd.read_csv(args.out)
    print(f"\nDone. {len(result):,} rows → {args.out}")
    print(f"Date range : {result['date'].min()} → {result['date'].max()}")
    print(f"Unique days: {result['date'].nunique()}")


def _save(frames, path):
    df = pd.concat(frames, ignore_index=True)
    sort_cols = ["date", "location", "race_no"]
    if "place" in df.columns:
        df["_place_num"] = pd.to_numeric(df["place"], errors="coerce")
        sort_cols.append("_place_num")
    df = df.sort_values(sort_cols).drop(columns=["_place_num"], errors="ignore")
    df.to_csv(path, index=False)


if __name__ == "__main__":
    main()
