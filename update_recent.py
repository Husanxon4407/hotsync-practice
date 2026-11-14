"""
HotSync: update_recent.py  (Stage 6: keep the current year growing)

History 2000-2025 is fixed (made once by process_all.py). The CURRENT year
lives in small separate files that this script keeps up to date:

    data/recent_days/<YYYY-MM-DD>.csv.gz   the robot's memory: one small file
                                           per day (fires per country square).
                                           A day fetched again REPLACES its
                                           file, so nothing is counted twice.
    web/data/recent/<YEAR>/daily.json      daily totals per country (+ world)
    web/data/recent/<YEAR>/cells/<YYYY-MM>/<slug>.json
                                           map squares per country per month
                                           (written only when they changed)
    web/data/recent/meta.json              last update, last day with data
    web/data/live/latest.json              live fires of the last 48 hours

The website adds these to the history in the browser.

When a year is over: download its yearly FIRMS zips, run process_all.py
with that year added, and it becomes fixed history like 2000-2025.
(Recipe in PROGRESS.md / README.md.)

Modes:
    python update_recent.py --backfill 2026-01-01   (once: from that day to today)
    python update_recent.py --recent                (robot: the last 3 days)
    add --skip-live to leave the live layer alone, --live-only for just that.

The FIRMS key comes from the environment variable FIRMS_MAP_KEY (GitHub
secret) or from the .env file. It is never printed.
"""

import argparse
import gzip
import io
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import numpy as np
import pandas as pd

REPO = Path(__file__).parent
DAYS_DIR = REPO / "data" / "recent_days"
SOURCES_FILE = DAYS_DIR / "sources.json"
STATIC_LIST = REPO / "data" / "static_cells.csv"
CELL_SIZES = REPO / "data" / "cell_sizes.json"
RECENT = REPO / "web" / "data" / "recent"
LIVE = REPO / "web" / "data" / "live" / "latest.json"

API = "https://firms.modaps.eosdis.nasa.gov/api"
HISTORY_END = "2025-12-31"        # last day inside the fixed history
SNPP_LAST = "2026-11-02"          # Suomi NPP VIIRS stopped; NOAA-20 after
DAYS_PER_CALL = 5                 # the API gives at most 5 days per call
PAUSE = 2                         # seconds between calls (be polite)
TRIES = 3                         # then skip with a warning
WORLD_CELL = 2.0                  # world squares, same as world.json
LIVE_MAX_MB = 5                   # bigger: keep only nominal/high confidence

# Same cleaning rules as the history (process_all.py)
MODIS_MIN_CONF = 30
VIIRS_KEEP_CONF = ("n", "h")
STATIC_CELL = 0.01
STATIC_RING = True
COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "confidence",
           "frp", "type", "satellite"]


def say(msg):
    print(msg, flush=True)


def slug_of(name):
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def read_key():
    key = os.environ.get("FIRMS_MAP_KEY", "").strip()
    env = REPO / ".env"
    if not key and env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("FIRMS_MAP_KEY="):
                key = line.split("=", 1)[1].strip()
    if not key:
        sys.exit("No FIRMS_MAP_KEY (set the GitHub secret, or put it in .env)")
    return key


# ---------------------------------------------------------------------------
# FIRMS API
# ---------------------------------------------------------------------------
class Firms:
    def __init__(self, key):
        self.key = key
        self.calls = 0

    def used(self):
        """How many of the key's 5000 transactions (per 10 min) are used now."""
        try:
            url = f"https://firms.modaps.eosdis.nasa.gov/mapserver/mapkey_status/?MAP_KEY={self.key}"
            with urllib.request.urlopen(url, timeout=60) as r:
                s = json.loads(r.read().decode())
            return int(s.get("current_transactions", 0)), int(s.get("transaction_limit", 5000))
        except (urllib.error.URLError, OSError, ValueError):
            return None, None

    def wait_for_limit(self):
        """NASA refuses calls when the key is over its limit (5000 per 10
        minutes; big world requests count as many). Wait until it resets."""
        for _ in range(15):                       # at most ~15 minutes
            used, limit = self.used()
            if used is not None and used < 0.8 * limit:
                return
            say(f"    key limit: {used}/{limit} used, waiting 60 s for NASA's 10-minute window")
            time.sleep(60)

    def get_text(self, path):
        """GET with retries. Returns text, or None after TRIES failures."""
        attempt = 0
        while attempt < TRIES:
            try:
                with urllib.request.urlopen(f"{API}/{path}", timeout=600) as r:
                    text = r.read().decode("utf-8")
                self.calls += 1
                time.sleep(PAUSE)
                return text
            except urllib.error.HTTPError as e:
                if e.code in (400, 429):            # usually "over the limit"
                    used, limit = self.used()
                    if used is not None and used >= 0.8 * limit:
                        self.wait_for_limit()       # does not count as a failed try
                        continue
                attempt += 1
                say(f"    try {attempt}/{TRIES} failed: HTTP {e.code}")
                time.sleep(10 * attempt)
            except (urllib.error.URLError, OSError) as e:
                attempt += 1
                # never print the key (it is part of the URL)
                say(f"    try {attempt}/{TRIES} failed: {str(e).replace(self.key, '<KEY>')}")
                time.sleep(10 * attempt)
        return None

    def availability(self):
        """{source: (first day, last day)} from /data_availability."""
        text = self.get_text(f"data_availability/csv/{self.key}/ALL")
        if text is None:
            sys.exit("FIRMS data_availability failed")
        df = pd.read_csv(io.StringIO(text))
        return {r.data_id: (r.min_date, r.max_date) for r in df.itertuples()}

    def area(self, source, first_day, n_days):
        """World fires for n_days from first_day. None = the call failed."""
        text = self.get_text(f"area/csv/{self.key}/{source}/world/{n_days}/{first_day}")
        if text is None:
            return None
        df = pd.read_csv(io.StringIO(text), dtype={"acq_time": str, "confidence": str,
                                                   "satellite": str})
        return df[[c for c in COLUMNS if c in df.columns]]


def pick(avail, day, sp, nrt):
    """Standard (SP) data when it exists for that day, else near-real-time."""
    for src in (sp, nrt):
        if src in avail and avail[src][0] <= day <= avail[src][1]:
            return src
    return None


def modis_source(avail, day):
    return pick(avail, day, "MODIS_SP", "MODIS_NRT")


def viirs_source(avail, day):
    """S-NPP up to 2026-11-02, NOAA-20 after (same VIIRS camera)."""
    if day <= SNPP_LAST:
        return pick(avail, day, "VIIRS_SNPP_SP", "VIIRS_SNPP_NRT")
    return noaa20_source(avail, day)


def noaa20_source(avail, day):
    return pick(avail, day, "VIIRS_NOAA20_SP", "VIIRS_NOAA20_NRT")


def fetch(firms, days, source_of):
    """Fetch the given days; returns ({day: rows}, {day: source}, failed days).

    Days are grouped into calls of up to 5 days with the same source.
    """
    by_day, used, failed = {}, {}, []
    groups = []
    for d in days:
        src = source_of(d)
        if src is None:
            continue
        if groups and groups[-1][0] == src and len(groups[-1][1]) < DAYS_PER_CALL \
                and (date.fromisoformat(d) - date.fromisoformat(groups[-1][1][-1])).days == 1:
            groups[-1][1].append(d)
        else:
            groups.append((src, [d]))
    for src, ds in groups:
        df = firms.area(src, ds[0], len(ds))
        if df is None:
            failed += ds
            say(f"    WARNING: skipped {src} {ds[0]}..{ds[-1]}")
            continue
        for d in ds:
            by_day[d] = df[df["acq_date"] == d]
            used[d] = src
        say(f"    {src} {ds[0]}..{ds[-1]}: {len(df):,} rows")
    return by_day, used, failed


# ---------------------------------------------------------------------------
# CLEAN + COUNT one day
# ---------------------------------------------------------------------------
_STATIC = None


def static_codes():
    """Square codes of the 'always hot' places (+ the ring around each)."""
    global _STATIC
    if _STATIC is None:
        s = pd.read_csv(STATIC_LIST)
        ci = np.round(s["lat"].to_numpy() / STATIC_CELL).astype(np.int64)
        cj = np.round(s["lon"].to_numpy() / STATIC_CELL).astype(np.int64)
        ring = (-1, 0, 1) if STATIC_RING else (0,)
        _STATIC = np.unique(np.concatenate(
            [(ci + a) * 100_000 + (cj + b) for a in ring for b in ring]))
    return _STATIC


def clean(df, sensor):
    """Type, confidence and static places: the same rules as the history."""
    if df is None or df.empty:
        return df
    if "type" in df:                          # NRT files have no type column
        df = df[df["type"].isna() | (df["type"] == 0)]
    if sensor == "MODIS":
        df = df[pd.to_numeric(df["confidence"], errors="coerce") >= MODIS_MIN_CONF]
    else:
        df = df[df["confidence"].astype(str).str.lower().str[0].isin(VIIRS_KEEP_CONF)]
    ci = np.round(df["latitude"].to_numpy() / STATIC_CELL).astype(np.int64)
    cj = np.round(df["longitude"].to_numpy() / STATIC_CELL).astype(np.int64)
    return df[~np.isin(ci * 100_000 + cj, static_codes())]


def count_day(modis, viirs, sizes):
    """One day's fires -> rows (slug, i, j, m, v, fm, fv) at each country's square size."""
    from countries import assign_country     # polygons (shapely)
    parts = [d.assign(sensor=s) for d, s in ((modis, "MODIS"), (viirs, "VIIRS"))
             if d is not None and len(d)]
    if not parts:
        return pd.DataFrame(columns=["slug", "i", "j", "m", "v", "fm", "fv"])
    df = assign_country(pd.concat(parts, ignore_index=True))
    df = df[df["country"].notna()]
    df["slug"] = df["country"].map(slug_of)
    df = df[df["slug"].isin(sizes)]
    cs = df["slug"].map(sizes).to_numpy(float)
    df = df.assign(i=np.floor(df["latitude"].to_numpy() / cs).astype(int),
                   j=np.floor(df["longitude"].to_numpy() / cs).astype(int),
                   is_m=(df["sensor"] == "MODIS"))
    df["m"] = df["is_m"].astype(int)
    df["v"] = (~df["is_m"]).astype(int)
    df["fm"] = np.where(df["is_m"], df["frp"], 0.0)
    df["fv"] = np.where(df["is_m"], 0.0, df["frp"])
    out = df.groupby(["slug", "i", "j"], as_index=False)[["m", "v", "fm", "fv"]].sum()
    out["fm"] = out["fm"].round(1)
    out["fv"] = out["fv"].round(1)
    return out


def write_day(day, rows):
    """Replace this day's file (so a day fetched twice is never counted twice)."""
    DAYS_DIR.mkdir(parents=True, exist_ok=True)
    path = DAYS_DIR / f"{day}.csv.gz"
    # "\n" line ends on every computer (Windows writes "\r\n"): the same data
    # then gives the same bytes on the laptop and on GitHub -> no empty commits.
    buf = rows.to_csv(index=False, lineterminator="\n").encode("utf-8")
    # Same data already saved? Then don't touch the file. (We compare the
    # unzipped text: Windows and Linux zip the same text into different bytes.)
    if path.exists():
        try:
            if gzip.decompress(path.read_bytes()) == buf:
                return
        except OSError:
            pass                                    # broken file: rewrite it
    with gzip.GzipFile(path, "wb", mtime=0) as f:
        f.write(buf)


def update_days(firms, days):
    """Fetch, clean, count and save each day."""
    sizes = json.loads(CELL_SIZES.read_text())
    avail = firms.availability()
    sources = json.loads(SOURCES_FILE.read_text()) if SOURCES_FILE.exists() else {}
    report = {}
    # Work in windows of 5 days so memory stays small during a long backfill.
    for w in range(0, len(days), DAYS_PER_CALL):
        win = days[w:w + DAYS_PER_CALL]
        say(f"  days {win[0]} .. {win[-1]}")
        m_rows, m_src, m_failed = fetch(firms, win, lambda d: modis_source(avail, d))
        v_rows, v_src, v_failed = fetch(firms, win, lambda d: viirs_source(avail, d))
        # S-NPP had days without data in 2026 (satellite off): use NOAA-20,
        # which carries the same VIIRS camera. (Only for days that downloaded
        # fine but were empty: a FAILED download is not "no data".)
        gaps = [d for d in win if d <= SNPP_LAST and d not in v_failed
                and (d not in v_rows or v_rows[d].empty)]
        if gaps:
            say(f"    S-NPP has no data on {len(gaps)} day(s): using NOAA-20")
            g_rows, g_src, g_failed = fetch(firms, gaps, lambda d: noaa20_source(avail, d))
            v_rows.update(g_rows)
            v_src.update(g_src)
            v_failed += g_failed
        for d in win:
            # A failed download must never be saved as "0 fires": skip the day,
            # keep the old file (if any); --fill-gaps / the next run fetches it.
            if d in m_failed or d in v_failed:
                say(f"    {d}: a download failed, day NOT saved (will be fetched again)")
                continue
            if d not in m_rows and d not in v_rows:
                say(f"    {d}: no data from FIRMS yet, kept the old file (if any)")
                continue
            mo, vi = clean(m_rows.get(d), "MODIS"), clean(v_rows.get(d), "VIIRS")
            rows = count_day(mo, vi, sizes)
            # S-NPP sometimes sends only PART of a day (e.g. 3 Aug 2026: 1,763
            # fires instead of ~60,000). VIIRS normally sees ~4-5x more than
            # MODIS; below 2x the day is broken: try NOAA-20, keep the better one.
            m_n, v_n = int(rows["m"].sum()), int(rows["v"].sum())
            if (d <= SNPP_LAST and str(v_src.get(d, "")).startswith("VIIRS_SNPP")
                    and m_n > 0 and v_n < 2 * m_n):
                alt, alt_src, _ = fetch(firms, [d], lambda x: noaa20_source(avail, x))
                if d in alt:
                    alt_rows = count_day(mo, clean(alt[d], "VIIRS"), sizes)
                    if alt_rows["v"].sum() > 1.3 * v_n:
                        say(f"    {d}: S-NPP sent part of the day ({v_n:,} fires); "
                            f"NOAA-20 has {int(alt_rows['v'].sum()):,}: using NOAA-20")
                        rows, v_src[d] = alt_rows, alt_src[d]
            write_day(d, rows)
            sources[d] = {"modis": m_src.get(d), "viirs": v_src.get(d)}
            for s, n in (("MODIS", int(rows["m"].sum())), ("VIIRS", int(rows["v"].sum()))):
                src = (m_src if s == "MODIS" else v_src).get(d) or "none"
                report.setdefault(src, [0, 0])
                report[src][0] += 1
                report[src][1] += n
        # save after every window, so a stopped run loses nothing
        SOURCES_FILE.write_text(json.dumps(dict(sorted(sources.items())), indent=0))
    say("  days and clean fires per source:")
    for src, (n_days, n) in sorted(report.items()):
        say(f"    {src:22s} {n_days:4d} days {n:12,} fires")


# ---------------------------------------------------------------------------
# REBUILD the website files of the current year(s) from the day files
# ---------------------------------------------------------------------------
def write_if_changed(path, obj):
    """Write JSON only if it is different: no change -> no git commit."""
    text = json.dumps(obj, separators=(",", ":"))
    if path.exists() and path.read_text(encoding="utf-8") == text:
        return False
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return True


def rebuild():
    sizes = json.loads(CELL_SIZES.read_text())
    files = sorted(p for p in DAYS_DIR.glob("*.csv.gz") if p.name[:10] > HISTORY_END)
    if not files:
        say("No recent day files yet.")
        return False
    sources = json.loads(SOURCES_FILE.read_text()) if SOURCES_FILE.exists() else {}
    frames = []
    for p in files:
        df = pd.read_csv(p)
        if len(df):
            frames.append(df.assign(day=p.name[:10]))
    allrows = pd.concat(frames, ignore_index=True) if frames else pd.DataFrame(
        columns=["slug", "i", "j", "m", "v", "fm", "fv", "day"])
    last_day = files[-1].name[:10]
    have_days = {p.name[:10] for p in files}
    changed = 0

    for year in sorted({d[:4] for d in have_days}):
        first = f"{year}-01-01"
        n = (date.fromisoformat(min(last_day, f"{year}-12-31")) - date.fromisoformat(first)).days + 1
        days = [(date.fromisoformat(first) + timedelta(k)).isoformat() for k in range(n)]
        idx = {d: k for k, d in enumerate(days)}
        yr = allrows[allrows["day"].str[:4] == year]

        # 1) daily totals per country (+ world)
        per = yr.groupby(["slug", "day"])[["m", "v", "fm", "fv"]].sum().reset_index()
        countries = {}
        for slug, g in per.groupby("slug"):
            arr = {k: [0] * n for k in ("m", "v", "fm", "fv")}
            for r in g.itertuples(index=False):
                k = idx[r.day]
                arr["m"][k], arr["v"][k] = int(r.m), int(r.v)
                arr["fm"][k], arr["fv"][k] = int(round(r.fm)), int(round(r.fv))
            countries[slug] = arr
        world = {k: [sum(c[k][i] for c in countries.values()) for i in range(n)]
                 for k in ("m", "v", "fm", "fv")}
        countries["world"] = world
        missing = [d for d in days if d not in have_days]
        daily = {"year": int(year), "days_start": first, "n_days": n,
                 "missing_days": missing,
                 "sources": {d: sources.get(d) for d in days if d in sources},
                 "countries": countries}
        changed += write_if_changed(RECENT / year / "daily.json", daily)

        # 2) map squares per country per month (+ world at 2 degrees)
        for month, gm in yr.groupby(yr["day"].str[:7]):
            cells = gm.groupby(["slug", "i", "j"], as_index=False)[["m", "v", "fm", "fv"]].sum()
            for slug, g in cells.groupby("slug"):
                obj = {f"{r.i}_{r.j}": [int(r.m), int(r.v), int(round(r.fm)), int(round(r.fv))]
                       for r in g.itertuples(index=False)}
                changed += write_if_changed(RECENT / year / "cells" / month / f"{slug}.json", obj)
            f = (WORLD_CELL / cells["slug"].map(sizes)).round().astype(int)
            w = cells.assign(I=np.floor_divide(cells["i"], f), J=np.floor_divide(cells["j"], f))
            w = w.groupby(["I", "J"], as_index=False)[["m", "v", "fm", "fv"]].sum()
            obj = {f"{r.I}_{r.J}": [int(r.m), int(r.v), int(round(r.fm)), int(round(r.fv))]
                   for r in w.itertuples(index=False)}
            changed += write_if_changed(RECENT / year / "cells" / month / "world.json", obj)

    years = sorted({d[:4] for d in have_days})
    meta_path = RECENT / "meta.json"
    old = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    meta = {"history_end": HISTORY_END, "years": [int(y) for y in years],
            "last_day_with_data": last_day,
            # the time only moves when the data really changed
            "last_updated": (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
                             if changed or not old else old.get("last_updated"))}
    write_if_changed(meta_path, meta)
    size = sum(p.stat().st_size for p in RECENT.rglob("*") if p.is_file())
    say(f"Rebuilt: {changed} file(s) changed; web/data/recent = {size / 1e6:.1f} MB; "
        f"last day {last_day}; {len(files)} day files")
    return changed > 0


# ---------------------------------------------------------------------------
# LIVE layer: fires of the last 48 hours, whole world, clickable dots
# ---------------------------------------------------------------------------
LIVE_SOURCES = [("MODIS_NRT", "MODIS"), ("VIIRS_NOAA20_NRT", "VIIRS NOAA-20"),
                ("VIIRS_NOAA21_NRT", "VIIRS NOAA-21")]


def update_live(firms):
    today = datetime.now(timezone.utc).date()
    start = (today - timedelta(days=1)).isoformat()      # yesterday + today
    frames = []
    for k, (src, name) in enumerate(LIVE_SOURCES):
        df = firms.area(src, start, 2)
        if df is None:
            say(f"  live: {src} failed, skipped")
            continue
        sensor = "MODIS" if src.startswith("MODIS") else "VIIRS"
        if "type" in df:
            df = df[df["type"].isna() | (df["type"] == 0)]
        ci = np.round(df["latitude"].to_numpy() / STATIC_CELL).astype(np.int64)
        cj = np.round(df["longitude"].to_numpy() / STATIC_CELL).astype(np.int64)
        df = df[~np.isin(ci * 100_000 + cj, static_codes())]       # no factories
        frames.append(df.assign(s=k, sensor=sensor))
        say(f"  live: {src} {len(df):,} fires")
    if not frames:
        return False
    df = pd.concat(frames, ignore_index=True)

    def pack(d):
        base = date.fromisoformat(start)
        day = (pd.to_datetime(d["acq_date"]).dt.date - base).map(lambda x: x.days)
        return [[round(a, 3), round(b, 3), int(s), int(dd), int(t), round(float(f), 1), str(c)]
                for a, b, s, dd, t, f, c in zip(d["latitude"], d["longitude"], d["s"], day,
                                                d["acq_time"].astype(int), d["frp"], d["confidence"])]
    obj = {"updated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
           "base_date": start, "sensors": [n for _, n in LIVE_SOURCES],
           "fields": ["lat", "lon", "sensor", "day", "time_utc", "frp_mw", "confidence"],
           "points": pack(df)}
    text = json.dumps(obj, separators=(",", ":"))
    if len(text) / 1e6 > LIVE_MAX_MB:            # too big: only confident detections
        keep = np.where(df["sensor"] == "MODIS",
                        pd.to_numeric(df["confidence"], errors="coerce") >= MODIS_MIN_CONF,
                        df["confidence"].astype(str).str.lower().str[0].isin(VIIRS_KEEP_CONF))
        obj["points"] = pack(df[keep])
        obj["note"] = "only nominal/high confidence (file size)"
        text = json.dumps(obj, separators=(",", ":"))
    LIVE.parent.mkdir(parents=True, exist_ok=True)
    LIVE.write_text(text, encoding="utf-8")
    say(f"  live: {len(obj['points']):,} dots, {len(text) / 1e6:.1f} MB")
    return True


def main():
    ap = argparse.ArgumentParser(description="Keep the current year growing")
    ap.add_argument("--backfill", metavar="YYYY-MM-DD", help="fetch from this day to today")
    ap.add_argument("--recent", action="store_true", help="fetch the last 3 days")
    ap.add_argument("--fill-gaps", metavar="YYYY-MM-DD",
                    help="fetch only the days from this date that have no file yet")
    ap.add_argument("--skip-live", action="store_true")
    ap.add_argument("--live-only", action="store_true")
    args = ap.parse_args()
    firms = Firms(read_key())
    t0 = time.time()
    today = datetime.now(timezone.utc).date()

    if not args.live_only:
        if args.backfill or args.fill_gaps:
            first = date.fromisoformat(args.backfill or args.fill_gaps)
        elif args.recent:
            first = today - timedelta(days=2)
        else:
            ap.print_help()
            sys.exit(1)
        days = [(first + timedelta(k)).isoformat() for k in range((today - first).days + 1)]
        if args.fill_gaps:                  # only days without a file yet
            days = [d for d in days if not (DAYS_DIR / f"{d}.csv.gz").exists()]
            if not days:
                say("No missing days.")
        if days:
            say(f"Fetching {len(days)} day(s): {days[0]} .. {days[-1]}")
            update_days(firms, days)
        rebuild()
    if not args.skip_live:
        say("Live layer (last 48 h):")
        update_live(firms)
    say(f"Done in {(time.time() - t0) / 60:.1f} min, {firms.calls} API calls")


if __name__ == "__main__":
    main()
