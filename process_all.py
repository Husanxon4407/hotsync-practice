"""
HotSync: process_all.py  (Stage 2: one country, Stage 3: all countries)

For each country, this script turns the raw FIRMS zips into one small JSON
file for the website:

    1. LOAD      that country's MODIS + VIIRS CSVs, YEAR BY YEAR, straight
                 from the zips (no unzipping to disk)
    2. CLEAN     type, confidence, "always hot" places (factories)
    3. GRID      count fires per square per month (+ fire power)
    4. RATES     the "exchange rate" VIIRS / MODIS for each calendar month
    5. HARMONIZE H = rate x MODIS before Feb 2012, H = VIIRS after
    6. VALIDATE  hide 2012-2014, predict it from MODIS, compare with real VIIRS
    7. EXPORT    web/data/country/<slug>.json (+ dots for showcase countries)
                 and a check image in D:\\hotsync_data\\checks

Why year by year? Big countries are BIG (Brazil: ~1.5 million VIIRS fires
per year). All years at once would not fit in the laptop's memory. So:
    Pass A  read one year -> clean type + confidence -> save a small parquet
            file in data_work, and remember which ~1 km squares were hot in
            8+ months that year (factory candidates).
    Pass B  read the saved years again, one by one -> drop factories ->
            add the year's counts to the running totals (grid, daily).
Only the totals stay in memory, never all the fires.

Run:
    .venv\\Scripts\\python process_all.py --country Uzbekistan
    .venv\\Scripts\\python process_all.py --all
    (add --fresh to re-read the zips instead of using saved work)
"""

import argparse
import json
import math
import re
import shutil
import sys
import time
import zipfile

import numpy as np
import pandas as pd

import config

# ---------------------------------------------------------------------------
# SETTINGS (all the numbers of the method, in one place)
# ---------------------------------------------------------------------------
MODIS_YEARS = range(2000, 2026)
VIIRS_YEARS = range(2012, 2026)
HISTORY_START = "2000-11"          # first MODIS month
VIIRS_START_DAY = "2012-01-20"     # Suomi NPP VIIRS first day
OVERLAP_START = "2012-02"          # first FULL month with both sensors
OVERLAP_END = "2025-12"
SNPP_LAST_DAY = "2026-11-02"       # after this, VIIRS = NOAA-20

MODIS_MIN_CONF = 30                # MODIS confidence is 0-100
VIIRS_KEEP_CONF = ("n", "h")       # VIIRS: nominal, high (not low)

STATIC_CELL = 0.01                 # ~1 km squares to find factories
STATIC_MONTHS = 8                  # hot in >= 8 different months of a year...
STATIC_YEARS = 3                   # ...in >= 3 different years -> static
# Team decision (Stage 2): NEW factories (e.g. one that started in 2024)
# can't have 3 busy years yet. Farm fires are seasonal, so a ~1 km square
# hot in >= 10 months of ANY single year is also static.
STATIC_ANY_YEAR_MONTHS = 10
# One factory's dots scatter over neighbouring squares (pixel position is
# not exact), so we also remove the 8 squares around each static square.
STATIC_RING = True

# Team decision (Stage 2): before Jul 2002 only Terra MODIS existed (Aqua
# started 4 Jul 2002), so MODIS counts there are ~half. Those months use a
# separate "Terra-only" rate: VIIRS / Terra MODIS, learned on 2012-2025.
AQUA_START = "2002-07"

# Map squares. 0.1 degree (~11 km) if the file stays small; for very big
# countries 0.25 degree, as the plan says (never coarser).
CELL_SIZES = (0.1, 0.25)
MAX_JSON_MB = 3

MIN_MODIS = 10                     # a month needs >= 10 MODIS fires for a ratio
MIN_YEARS = 3                      # a calendar month needs >= 3 such years
MIN_RATIOS = 6                     # a country needs >= 6 ratios, else global
PLACEHOLDER_GLOBAL = 3.5           # used until --all has computed the real one

VALID_TRAIN = range(2015, 2026)    # learn the rates on these years...
VALID_TEST = ("2012-02", "2014-12")  # ...and predict these months
MIN_VIIRS_FOR_ERROR = 10           # % error only where VIIRS >= 10

# MODIS months with missing days (satellite problems).
PARTIAL_MONTHS = {
    "2001-04": "MODIS data gap",
    "2001-06": "Terra MODIS off ~15 Jun - 3 Jul 2001",
    "2001-07": "Terra MODIS off ~15 Jun - 3 Jul 2001",
    "2002-03": "Terra MODIS off ~19-28 Mar 2002",
}

# Team decision (Stage 5): every place is treated the same, so no country
# gets its own dot files. Fire dots for the whole planet come straight from
# NASA GIBS on the website. (Set names here to write dot CSVs again.)
SHOWCASE = set()
CHECK_IMAGES = {"Uzbekistan", "Argentina", "United_Kingdom", "Brazil",
                "Kazakhstan"}
COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite",
           "confidence", "frp", "type"]

OUT_COUNTRY = config.WEB_DATA_DIR / "country"
OUT_POINTS = config.WEB_DATA_DIR / "points"
GEOJSON = config.REPO_DIR / "data" / "countries.geojson"
STATIC_LIST = config.REPO_DIR / "data" / "static_cells.csv"
GLOBAL_FILE = config.WORK_DIR / "global_rates.json"

# Dates are stored as small numbers to save memory.
EPOCH = pd.Timestamp("2000-01-01")
DAY0 = (pd.Timestamp(f"{HISTORY_START}-01") - EPOCH).days   # 2000-11-01
LAST_POSSIBLE_DAY = (pd.Timestamp("2026-12-31") - EPOCH).days
HISTORY_END_DAY = (pd.Timestamp("2025-12-31") - EPOCH).days  # last zip day

# 2026 world files from the FIRMS Archive (optional): code -> (sensor, sat)
WORLD_CODES = {"M-C61": ("MODIS", None), "SV-C2": ("VIIRS", "S-NPP"),
               "J1V-C2": ("VIIRS", "NOAA-20")}


def slug_of(name):
    """'United_Kingdom' -> 'united-kingdom' (safe for file names and URLs)."""
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def short(x, digits=1):
    """Round, and write 12.0 as 12 (shorter JSON). NaN -> None (null)."""
    if x is None or (isinstance(x, float) and math.isnan(x)):
        return None
    r = round(float(x), digits)
    return int(r) if r.is_integer() else r


def ym_str(ym):
    """Month number (months since Jan 2000) -> 'YYYY-MM'."""
    return f"{2000 + ym // 12}-{ym % 12 + 1:02d}"


def ym_of(text):
    """'YYYY-MM' -> month number."""
    return (int(text[:4]) - 2000) * 12 + int(text[5:7]) - 1


def cell_code(ci, cj):
    """Two square numbers -> one number (fast to compare with np.isin)."""
    return ci.astype(np.int64) * 100_000 + cj.astype(np.int64)


# ---------------------------------------------------------------------------
# 1. LOAD (one year at a time)
# ---------------------------------------------------------------------------
def read_zip_country(prefix, year, name):
    """One country's CSV for one year, read straight from the yearly zip."""
    path = config.DATA_DIR / f"{prefix}_{year}_all_countries.zip"
    member = f"{prefix}/{year}/{prefix}_{year}_{name}.csv"
    with zipfile.ZipFile(path) as z:
        if member not in z.namelist():
            return None          # no fires in this country that year
        with z.open(member) as f:
            # acq_time and confidence as text: "0520" keeps its 0, and
            # VIIRS confidence is a letter.
            return pd.read_csv(f, usecols=lambda c: c in COLUMNS,
                               dtype={"acq_time": str, "confidence": str,
                                      "satellite": str})


def load_world_2026(name):
    """Optional 2026 world CSVs (no country column) -> rows of this country.

    The country is found with polygons (countries.assign_country) and the
    result is cached in data_work, so --all doesn't repeat the slow part.
    VIIRS rule: S-NPP up to SNPP_LAST_DAY, NOAA-20 after it.
    Archive (standard) data wins over NRT for the days it covers.
    """
    files = sorted(config.DATA_2026_DIR.glob("fire_*.csv"))
    if not files:
        return None
    from countries import assign_country
    frames = []
    for f in files:
        code = next((c for c in WORLD_CODES if f"_{c}_" in f.name), None)
        if code is None:
            continue
        sensor, sat = WORLD_CODES[code]
        cache = config.WORK_DIR / "world2026" / (f.stem + ".parquet")
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            df = pd.read_csv(f, usecols=lambda c: c in COLUMNS,
                             dtype={"acq_time": str, "confidence": str,
                                    "satellite": str})
            assign_country(df).to_parquet(cache)
        df = pd.read_parquet(cache)
        df = df[df["country"] == name].drop(columns="country")
        if sat == "S-NPP":
            df = df[df["acq_date"] <= SNPP_LAST_DAY]
        elif sat == "NOAA-20":
            df = df[df["acq_date"] > SNPP_LAST_DAY]
        frames.append(df.assign(sensor=sensor,
                                kind="nrt" if "_nrt_" in f.name else "sp"))
    if not frames:
        return None
    df = pd.concat(frames, ignore_index=True)
    # Per sensor: use NRT only for days after the last standard (sp) day.
    keep = []
    for _, g in df.groupby("sensor"):
        last_sp = g.loc[g["kind"] == "sp", "acq_date"].max()
        keep.append(g if pd.isna(last_sp) else
                    g[(g["kind"] == "sp") | (g["acq_date"] > last_sp)])
    return pd.concat(keep).drop(columns="kind")


def load_year(name, year):
    """Both sensors for one year (2026 = optional world files)."""
    if year == 2026:
        return load_world_2026(name)
    frames = []
    for sensor, prefix, years in (("MODIS", "modis", MODIS_YEARS),
                                  ("VIIRS", "viirs-snpp", VIIRS_YEARS)):
        if year in years:
            df = read_zip_country(prefix, year, name)
            if df is not None and len(df):
                frames.append(df.assign(sensor=sensor))
    return pd.concat(frames, ignore_index=True) if frames else None


# ---------------------------------------------------------------------------
# 2. CLEAN
# ---------------------------------------------------------------------------
def new_steps():
    """Empty cleaning table: per step, per sensor, before / removed."""
    names = ["type == 0 (vegetation fire)",
             f"confidence (MODIS >= {MODIS_MIN_CONF}, VIIRS n/h)",
             "static places"]
    return [{"step": n, "MODIS": {"before": 0, "removed": 0},
             "VIIRS": {"before": 0, "removed": 0}} for n in names]


def count_step(step, is_viirs, keep):
    """Add one year's numbers for one cleaning rule to the table."""
    for s, mine in (("MODIS", ~is_viirs), ("VIIRS", is_viirs)):
        step[s]["before"] += int(mine.sum())
        step[s]["removed"] += int((mine & ~keep).sum())


def clean_year(df, steps):
    """Rules 1 and 2 (type, confidence) for one year -> compact table."""
    is_viirs = (df["sensor"] == "VIIRS").to_numpy()

    # Rule 1: only vegetation fires (type 0). Rows with no type (NRT data)
    # are kept here; the static-cell rule catches their factories.
    if "type" in df:
        keep = (df["type"].isna() | (df["type"] == 0)).to_numpy()
    else:
        keep = np.ones(len(df), bool)
    count_step(steps[0], is_viirs, keep)
    df, is_viirs = df[keep], is_viirs[keep]

    # Rule 2: confidence. MODIS: number >= 30. VIIRS: n or h (any case;
    # some NRT files write "nominal" / "high", so we check the 1st letter).
    conf_num = pd.to_numeric(df["confidence"], errors="coerce").to_numpy()
    conf_letter = df["confidence"].astype(str).str.lower().str[0]
    keep = np.where(is_viirs, conf_letter.isin(VIIRS_KEEP_CONF).to_numpy(),
                    conf_num >= MODIS_MIN_CONF)
    count_step(steps[1], is_viirs, keep)
    df = df[keep]

    # Compact table: numbers instead of text where we can (less memory).
    date = pd.to_datetime(df["acq_date"], format="%Y-%m-%d")
    sat = df["satellite"].astype(str)
    return pd.DataFrame({
        "lat": df["latitude"].to_numpy(float),
        "lon": df["longitude"].to_numpy(float),
        "day": (date - EPOCH).dt.days.to_numpy(np.int32),
        "ym": ((date.dt.year - 2000) * 12 + date.dt.month - 1)
        .to_numpy(np.int16),
        "time": df["acq_time"].astype(str).str.zfill(4).to_numpy(),
        "viirs": (df["sensor"] == "VIIRS").to_numpy(),
        "terra": sat.str.upper().str.startswith("T").to_numpy(),
        "sat": sat.to_numpy(),
        "conf": df["confidence"].astype(str).to_numpy(),
        "frp": df["frp"].to_numpy(float),
    })


def static_candidates(d):
    """~1 km squares hot in >= 8 different months of THIS year."""
    ci = np.round(d["lat"].to_numpy() / STATIC_CELL).astype(np.int32)
    cj = np.round(d["lon"].to_numpy() / STATIC_CELL).astype(np.int32)
    t = pd.DataFrame({"ci": ci, "cj": cj, "ym": d["ym"].to_numpy()})
    months = t.drop_duplicates().groupby(["ci", "cj"]).size()
    hits = t.groupby(["ci", "cj"]).size()
    busy = months[months >= STATIC_MONTHS]
    return pd.DataFrame({"months": busy,
                         "hits": hits.reindex(busy.index)}).reset_index()


def decide_static(candidates):
    """Static = busy (>= 8 months) in >= 3 years, or >= 10 months in a year."""
    if candidates.empty:
        return pd.DataFrame(columns=["ci", "cj", "busy_years", "max_months",
                                     "detections", "lat", "lon"])
    g = candidates.groupby(["ci", "cj"]).agg(
        busy_years=("months", "size"), max_months=("months", "max"),
        detections=("hits", "sum")).reset_index()
    s = g[(g["busy_years"] >= STATIC_YEARS)
          | (g["max_months"] >= STATIC_ANY_YEAR_MONTHS)].copy()
    s["lat"] = (s["ci"] * STATIC_CELL).round(2)
    s["lon"] = (s["cj"] * STATIC_CELL).round(2)
    return s.sort_values("detections", ascending=False)


def static_codes(static):
    """All square codes to remove: each static square (+ its ring)."""
    ring = (-1, 0, 1) if STATIC_RING else (0,)
    ci, cj = static["ci"].to_numpy(np.int64), static["cj"].to_numpy(np.int64)
    return np.unique(np.concatenate(
        [cell_code(ci + di, cj + dj) for di in ring for dj in ring]
        or [np.array([], np.int64)]))


# ---------------------------------------------------------------------------
# PASS A + B: aggregate one country (heavy part, saved in data_work)
# ---------------------------------------------------------------------------
def work_dir(name):
    return config.WORK_DIR / slug_of(name)


def write_points_year(folder, year, d):
    """Showcase countries: every clean fire dot of one year as CSV."""
    date = (EPOCH + pd.to_timedelta(d["day"], unit="D")).dt.strftime(
        "%Y-%m-%d")
    pts = pd.DataFrame({
        "lat": d["lat"].round(4), "lon": d["lon"].round(4),
        "date": date, "time": d["time"],
        "sensor": np.where(d["viirs"], "VIIRS", "MODIS"),
        "confidence": d["conf"], "frp": d["frp"].round(2),
        "satellite": d["sat"],
    }).sort_values(["date", "time"])
    pts.to_csv(folder / f"{year}.csv", index=False)


def aggregate_country(name):
    """Read all years and make the country's totals. Saved in data_work."""
    wd = work_dir(name)
    years_dir = wd / "years"
    if wd.exists():
        shutil.rmtree(wd)
    years_dir.mkdir(parents=True)
    steps = new_steps()

    # ---- Pass A: clean type + confidence, save each year, find candidates
    candidates, years = [], []
    for year in list(MODIS_YEARS) + [2026]:
        raw = load_year(name, year)
        if raw is None or raw.empty:
            continue
        d = clean_year(raw, steps)
        del raw
        if d.empty:
            continue
        d.to_parquet(years_dir / f"{year}.parquet", index=False)
        candidates.append(static_candidates(d).assign(year=year))
        years.append(year)
    if not years:
        return None

    static = decide_static(pd.concat(candidates, ignore_index=True))
    codes = static_codes(static)

    # ---- Pass B: drop static places, add up counts year by year
    n_days = LAST_POSSIBLE_DAY - DAY0 + 1
    daily = {"MODIS": np.zeros(n_days, np.int64),
             "VIIRS": np.zeros(n_days, np.int64)}
    terra = np.zeros(13 * 12 * 3, np.int64)     # per month number
    grids = {c: [] for c in CELL_SIZES}
    last_day = DAY0
    points_dir = None
    if name in SHOWCASE:
        points_dir = OUT_POINTS / slug_of(name)
        if points_dir.exists():
            shutil.rmtree(points_dir)
        points_dir.mkdir(parents=True)

    for year in years:
        d = pd.read_parquet(years_dir / f"{year}.parquet")
        ci = np.round(d["lat"].to_numpy() / STATIC_CELL).astype(np.int64)
        cj = np.round(d["lon"].to_numpy() / STATIC_CELL).astype(np.int64)
        keep = ~np.isin(cell_code(ci, cj), codes)
        count_step(steps[2], d["viirs"].to_numpy(), keep)
        d = d[keep]
        if d.empty:
            continue
        last_day = max(last_day, int(d["day"].max()))

        for sensor, mine in (("MODIS", ~d["viirs"]), ("VIIRS", d["viirs"])):
            daily[sensor] += np.bincount(d.loc[mine, "day"] - DAY0,
                                         minlength=n_days)[:n_days]
        t = d[~d["viirs"] & d["terra"]]
        terra += np.bincount(t["ym"], minlength=len(terra))[:len(terra)]

        for c in CELL_SIZES:
            g = (d.assign(i=np.floor(d["lat"] / c).astype(np.int32),
                          j=np.floor(d["lon"] / c).astype(np.int32))
                 .groupby(["ym", "i", "j", "viirs"])
                 .agg(n=("frp", "size"), frp=("frp", "sum")))
            grids[c].append(g)

        if points_dir:
            write_points_year(points_dir, year, d)

    steps[2]["step"] = (f"static places ({len(static)} squares of ~1 km"
                        + (" + ring around each)" if STATIC_RING else ")"))

    # Choose the square size: the smallest that keeps the JSON small.
    # ~26 bytes per (square, month) row in the JSON (measured).
    cell, grid = None, None
    for c in CELL_SIZES:
        g = (pd.concat(grids[c]).unstack("viirs", fill_value=0)
             .sort_index())
        g.columns = [f"{k}_{'viirs' if v else 'modis'}" for k, v in g.columns]
        for col in ("n_modis", "n_viirs", "frp_modis", "frp_viirs"):
            if col not in g:
                g[col] = 0
        cell, grid = c, g.reset_index()
        if len(grid) * 26 / 1e6 <= MAX_JSON_MB - 0.5:
            break
    del grids

    # Save the totals (small) so export never needs the zips again.
    grid.to_parquet(wd / "grid.parquet", index=False)
    static.to_parquet(wd / "static_cells.parquet", index=False)
    n = last_day - DAY0 + 1
    np.savez(wd / "daily.npz", modis=daily["MODIS"][:n],
             viirs=daily["VIIRS"][:n], terra=terra)
    meta = {"name": name, "cell": cell, "last_day": last_day,
            "steps": steps, "years": years}
    (wd / "meta.json").write_text(json.dumps(meta))
    shutil.rmtree(years_dir)          # the big per-year files are not needed
    return meta


def load_aggregates(name):
    """Read what aggregate_country saved (None if not done yet)."""
    wd = work_dir(name)
    if not (wd / "meta.json").exists():
        return None
    meta = json.loads((wd / "meta.json").read_text())
    z = np.load(wd / "daily.npz")
    # Every country's timeline runs to at least the end of the history
    # (31 Dec 2025), even if its last fire was earlier: no fire = 0,
    # not "missing".
    meta["end_day"] = max(meta["last_day"], HISTORY_END_DAY)
    n = meta["end_day"] - DAY0 + 1

    def pad(a):
        return np.concatenate([a, np.zeros(n - len(a), a.dtype)])
    return {"meta": meta, "grid": pd.read_parquet(wd / "grid.parquet"),
            "static": pd.read_parquet(wd / "static_cells.parquet"),
            "daily_modis": pad(z["modis"]), "daily_viirs": pad(z["viirs"]),
            "terra": z["terra"]}


# ---------------------------------------------------------------------------
# 4. EXCHANGE RATES
# ---------------------------------------------------------------------------
def learn_rates(monthly, years=None, global_rate=PLACEHOLDER_GLOBAL):
    """VIIRS / MODIS for each calendar month, from the overlap years.

    monthly: table with columns month ('YYYY-MM'), modis, viirs.
    For each calendar month: ratio of every year with MODIS >= 10,
    rate = median of those ratios (one strange year can't move it much).
    """
    m = monthly[(monthly["month"] >= OVERLAP_START)
                & (monthly["month"] <= OVERLAP_END)
                & (monthly["modis"] >= MIN_MODIS)].copy()
    if years is not None:
        m = m[m["month"].str[:4].astype(int).isin(list(years))]
    m["ratio"] = m["viirs"] / m["modis"]
    m["cal"] = m["month"].str[5:7].astype(int)
    pooled = m["ratio"].median()
    use_global = len(m) < MIN_RATIOS

    rates = {}
    for cal in range(1, 13):
        r = m.loc[m["cal"] == cal, "ratio"]
        if use_global:
            rate, src = global_rate, "global"
        elif len(r) < MIN_YEARS:
            rate, src = pooled, "pooled"
        else:
            rate, src = r.median(), "month"
        rates[str(cal)] = {
            "rate": short(rate, 2),
            "q25": short(r.quantile(0.25), 2) if len(r) else None,
            "q75": short(r.quantile(0.75), 2) if len(r) else None,
            "n": int(len(r)), "src": src}
    return rates, ("global" if use_global else "country"), len(m)


def harmonize(month, modis, viirs, rates, terra_rates):
    """H for one month: rate x MODIS before Feb 2012, VIIRS after.

    Before Jul 2002 MODIS = Terra only, so we use the Terra-only rate.
    """
    if month < OVERLAP_START:
        use = terra_rates if month < AQUA_START else rates
        return modis * use[str(int(month[5:7]))]["rate"]
    return viirs


# ---------------------------------------------------------------------------
# 6. VALIDATION ("hide the answer" test)
# ---------------------------------------------------------------------------
def errors(pred, real):
    """Median absolute % error (VIIRS >= 10), Pearson r, total bias %."""
    pred, real = np.asarray(pred, float), np.asarray(real, float)
    big = real >= MIN_VIIRS_FOR_ERROR
    mae = (np.median(np.abs(pred[big] - real[big]) / real[big] * 100)
           if big.any() else None)
    r = (np.corrcoef(pred, real)[0, 1]
         if len(real) > 2 and real.std() > 0 and pred.std() > 0 else None)
    bias = ((pred.sum() - real.sum()) / real.sum() * 100
            if real.sum() > 0 else None)
    return mae, r, bias


def validate(monthly, global_rate):
    """Learn on 2015-2025, predict 2012-02..2014-12. Also leave-one-year-out."""
    rates, src, _ = learn_rates(monthly, VALID_TRAIN, global_rate)
    test = monthly[(monthly["month"] >= VALID_TEST[0])
                   & (monthly["month"] <= VALID_TEST[1])]
    pred = [rates[str(int(m[5:7]))]["rate"] * x
            for m, x in zip(test["month"], test["modis"])]
    mae, r, bias = errors(pred, test["viirs"])

    # Leave-one-year-out: for every overlap year, learn on all the OTHER
    # years and predict this one. The mean error shows how stable it is.
    loyo = []
    for year in range(2012, 2026):
        others = [y for y in range(2012, 2026) if y != year]
        yr_rates, _, _ = learn_rates(monthly, others, global_rate)
        t = monthly[(monthly["month"].str[:4] == str(year))
                    & (monthly["month"] >= OVERLAP_START)]
        p = [yr_rates[str(int(m[5:7]))]["rate"] * x
             for m, x in zip(t["month"], t["modis"])]
        e, _, _ = errors(p, t["viirs"])
        if e is not None:
            loyo.append(e)

    result = {
        "train": "2015-2025", "test": "2012-02..2014-12",
        "months": int(len(test)),
        "median_abs_error_pct": short(mae),
        "pearson_r": short(r, 3),
        "bias_pct": short(bias),
        "loyo_mean_error_pct": short(np.mean(loyo)) if loyo else None,
        "loyo_years": len(loyo),
        "rate_source": src,
    }
    pairs = pd.DataFrame({"month": test["month"].values,
                          "pred": pred, "real": test["viirs"].values})
    return result, pairs


# ---------------------------------------------------------------------------
# RATES for one country (light, from the saved totals)
# ---------------------------------------------------------------------------
def monthly_table(agg):
    """Country totals per month: modis, viirs, FRP, Terra-only MODIS."""
    meta, grid = agg["meta"], agg["grid"]
    first = ym_of(HISTORY_START)
    last = (pd.Timestamp(EPOCH) + pd.Timedelta(days=meta["end_day"]))
    yms = list(range(first, (last.year - 2000) * 12 + last.month))
    sums = (grid.groupby("ym")[["n_modis", "n_viirs", "frp_modis",
                                "frp_viirs"]].sum().reindex(yms, fill_value=0))
    return pd.DataFrame({
        "ym": yms, "month": [ym_str(y) for y in yms],
        "modis": sums["n_modis"].to_numpy(),
        "viirs": sums["n_viirs"].to_numpy(),
        "frp_modis": sums["frp_modis"].to_numpy(),
        "frp_viirs": sums["frp_viirs"].to_numpy(),
        "terra": agg["terra"][yms],
    })


def country_rates(monthly, global_rate, global_terra):
    rates, source, n = learn_rates(monthly, global_rate=global_rate)
    terra_rates, terra_source, _ = learn_rates(
        monthly[["month", "viirs"]].assign(modis=monthly["terra"]),
        global_rate=global_terra)
    return rates, source, n, terra_rates, terra_source


# ---------------------------------------------------------------------------
# 7. EXPORT (light, from the saved totals)
# ---------------------------------------------------------------------------
_BBOXES = None


def country_bbox(name):
    """[west, south, east, north] from the country polygon."""
    global _BBOXES
    if _BBOXES is None:
        from shapely.geometry import shape
        with open(GEOJSON, encoding="utf-8") as f:
            _BBOXES = {ft["properties"]["firms"]:
                       [round(v, 2) for v in shape(ft["geometry"]).bounds]
                       for ft in json.load(f)["features"]}
    return _BBOXES.get(name)


def daily_arrays(agg, rates, terra_rates):
    """Country totals per day, from 2000-11-01: MODIS, VIIRS, harmonized."""
    first_viirs = (pd.Timestamp(VIIRS_START_DAY) - EPOCH).days - DAY0
    days = pd.date_range(f"{HISTORY_START}-01",
                         periods=len(agg["daily_modis"]), freq="D")
    months = days.strftime("%Y-%m")
    out_v, out_h = [], []
    for k, (m, a, b) in enumerate(zip(months, agg["daily_modis"],
                                      agg["daily_viirs"])):
        out_v.append(None if k < first_viirs else int(b))
        out_h.append(short(harmonize(m, int(a), int(b), rates, terra_rates)))
    return {"modis": agg["daily_modis"].astype(int).tolist(),
            "viirs": out_v, "harmonized": out_h}


def build_json(name, agg, global_rate, global_terra):
    """Everything the website needs for one country, as a Python dict."""
    meta, grid, static = agg["meta"], agg["grid"], agg["static"]
    monthly = monthly_table(agg)
    months = monthly["month"].tolist()
    first = ym_of(HISTORY_START)

    rates, rate_source, n_ratios, terra_rates, _ = country_rates(
        monthly, global_rate, global_terra)
    monthly["h"] = [harmonize(m, a, b, rates, terra_rates) for m, a, b in
                    zip(monthly["month"], monthly["modis"], monthly["viirs"])]
    validation, pairs = validate(monthly, global_rate)

    before_viirs = monthly["month"] < VIIRS_START_DAY[:7]
    totals = {
        "modis": monthly["modis"].astype(int).tolist(),
        "viirs": [None if b else int(v)
                  for b, v in zip(before_viirs, monthly["viirs"])],
        "harmonized": [short(h) for h in monthly["h"]],
        "frp_modis": [short(x, 0) for x in monthly["frp_modis"]],
        "frp_viirs": [None if b else short(x, 0)
                      for b, x in zip(before_viirs, monthly["frp_viirs"])],
    }

    # Squares: only months with at least one fire.
    cell_map = {}
    for row in grid.itertuples(index=False):
        month = ym_str(row.ym)
        h = harmonize(month, row.n_modis, row.n_viirs, rates, terra_rates)
        cell_map.setdefault(f"{row.i}_{row.j}", []).append(
            [int(row.ym) - first, int(row.n_modis), int(row.n_viirs),
             short(h), short(row.frp_modis, 0), short(row.frp_viirs, 0)])

    data = {
        "name": name.replace("_", " "), "slug": slug_of(name),
        "firms_name": name,
        "bbox": country_bbox(name),
        "cell_size": meta["cell"],
        "months": months,
        "totals": totals,
        "rates": rates, "rate_source": rate_source, "n_ratios": n_ratios,
        # Used instead of "rates" for the Terra-only months.
        "rates_terra": terra_rates,
        "terra_only_months": [m for m in months if m < AQUA_START],
        "validation": validation,
        "cleaning": meta["steps"],
        "static_cells": {
            "count": int(len(static)),
            "top": static.head(50)[["lat", "lon", "detections"]]
            .values.tolist()},
        "partial_months": {m: r for m, r in PARTIAL_MONTHS.items()
                           if m in months},
        "days_start": f"{HISTORY_START}-01",
        "daily": daily_arrays(agg, rates, terra_rates),
        # Square key "i_j": south-west corner = (i x cell_size, j x cell_size).
        "cell_fields": ["month_index", "modis", "viirs", "harmonized",
                        "frp_modis_mw", "frp_viirs_mw"],
        "cells": cell_map,
    }
    if data["bbox"] is None:      # no polygon (tiny island): use the squares
        c = meta["cell"]
        data["bbox"] = [round(grid["j"].min() * c, 2),
                        round(grid["i"].min() * c, 2),
                        round((grid["j"].max() + 1) * c, 2),
                        round((grid["i"].max() + 1) * c, 2)]
    return data, monthly, pairs


def check_image(name, monthly, rates, terra_rates, pairs, validation):
    """3 panels to LOOK at: lines, rates, validation scatter."""
    import matplotlib
    matplotlib.use("Agg")              # draw to a file, no window
    import matplotlib.pyplot as plt

    config.CHECKS_DIR.mkdir(parents=True, exist_ok=True)
    fig, ax = plt.subplots(1, 3, figsize=(18, 5),
                           gridspec_kw={"width_ratios": [2.2, 1, 1]})
    x = pd.PeriodIndex(monthly["month"], freq="M").to_timestamp()
    v = monthly["viirs"].where(monthly["month"] >= VIIRS_START_DAY[:7])

    ax[0].plot(x, monthly["modis"], color="#2f5bea", lw=1, label="MODIS raw")
    ax[0].plot(x, v, color="#e8613a", lw=1, label="VIIRS raw")
    ax[0].plot(x, monthly["h"], color="#1a9e75", lw=1.4, ls="--",
               label="Harmonized (H)")
    ax[0].axvline(pd.Timestamp("2012-02-01"), color="grey", lw=0.8, ls=":")
    ax[0].set_title(f"(a) {name.replace('_', ' ')}: monthly hotspots")
    ax[0].legend()

    cal = list(range(1, 13))
    r = [rates[str(c)]["rate"] for c in cal]
    own = [rates[str(c)]["src"] == "month" for c in cal]
    ax[1].bar(cal, r, color="#2f5bea", alpha=0.75, label="Terra + Aqua",
              hatch=["" if o else "//" for o in own])
    # q25-q75 lines only for months with their OWN median. Months using a
    # backup rate (pooled / global, hatched) have too few years for a range.
    mc = [c for c, o in zip(cal, own) if o]
    mr = [rates[str(c)]["rate"] for c in mc]
    lo = [max(0, x - rates[str(c)]["q25"]) for c, x in zip(mc, mr)]
    hi = [max(0, rates[str(c)]["q75"] - x) for c, x in zip(mc, mr)]
    if mc:
        ax[1].errorbar(mc, mr, yerr=[lo, hi], fmt="none", color="black",
                       capsize=3)
    ax[1].plot(cal, [terra_rates[str(c)]["rate"] for c in cal], "o",
               color="#e8613a", label="Terra only (before Jul 2002)")
    ax[1].legend(fontsize=8)
    for c in cal:
        ax[1].text(c, 0.1, rates[str(c)]["n"], ha="center", fontsize=7,
                   color="white")
    ax[1].set_xticks(list(cal))
    ax[1].set_title("(b) exchange rate VIIRS/MODIS per month\n"
                    "(bar = median, line = q25-q75, number = years,\n"
                    "hatched = too few years, backup rate used)")

    mx = max(pairs["pred"].max(), pairs["real"].max(), 1) * 1.05
    ax[2].scatter(pairs["real"], pairs["pred"], color="#1a9e75", s=18)
    ax[2].plot([0, mx], [0, mx], color="grey", lw=0.8)
    ax[2].set_xlabel("real VIIRS")
    ax[2].set_ylabel("predicted from MODIS")
    ax[2].set_title(
        f"(c) hold-out test 2012-02..2014-12\nmedian error "
        f"{validation['median_abs_error_pct']}%, r = "
        f"{validation['pearson_r']}, bias {validation['bias_pct']}%")

    fig.tight_layout()
    path = config.CHECKS_DIR / f"{slug_of(name)}.png"
    fig.savefig(path, dpi=110)
    plt.close(fig)
    return path


def export_country(name, agg, global_rate, global_terra, image=False):
    """Write the country JSON (and check image). Returns a summary."""
    data, monthly, pairs = build_json(name, agg, global_rate, global_terra)
    OUT_COUNTRY.mkdir(parents=True, exist_ok=True)
    out = OUT_COUNTRY / f"{data['slug']}.json"
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    path = (check_image(name, monthly, data["rates"], data["rates_terra"],
                        pairs, data["validation"]) if image else None)
    return {"data": data, "monthly": monthly, "json": out, "image": path}


# ---------------------------------------------------------------------------
# REPORT for one country (printed, for us to check the science)
# ---------------------------------------------------------------------------
def report(name, agg, result):
    data, monthly, static = result["data"], result["monthly"], agg["static"]
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")

    print("\nCLEANING (rows removed per step)")
    print(f"  {'step':54s} {'MODIS':>18s} {'VIIRS':>20s}")
    for s in data["cleaning"]:
        cols = [f"-{s[k]['removed']:,} of {s[k]['before']:,}"
                for k in ("MODIS", "VIIRS")]
        print(f"  {s['step']:54s} {cols[0]:>18s} {cols[1]:>20s}")
    left = {k: s[k]["before"] - s[k]["removed"]
            for s in data["cleaning"][-1:] for k in ("MODIS", "VIIRS")}
    print(f"  {'left after cleaning':54s} {left['MODIS']:>18,} "
          f"{left['VIIRS']:>20,}")

    print("\nEXCHANGE RATES (VIIRS / MODIS), learned on 2012-02..2025-12")
    names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    for c in range(1, 13):
        r = data["rates"][str(c)]
        print(f"  {names[c - 1]}: {r['rate']:>5}   q25-q75 {r['q25']}-"
              f"{r['q75']}   years {r['n']:>2}   ({r['src']})")
    print(f"  rate source: {data['rate_source']}, valid ratios: "
          f"{data['n_ratios']}")
    t = data["rates_terra"]
    print("  Terra-only (2000-11..2002-06): "
          + "  ".join(f"{names[c - 1]} {t[str(c)]['rate']}"
                      for c in range(1, 13)))

    v = data["validation"]
    print("\nVALIDATION (learn 2015-2025, predict 2012-02..2014-12)")
    print(f"  months tested: {v['months']}, median absolute error: "
          f"{v['median_abs_error_pct']}%, Pearson r: {v['pearson_r']}, "
          f"total bias: {v['bias_pct']}%")
    print(f"  leave-one-year-out mean error: {v['loyo_mean_error_pct']}% "
          f"({v['loyo_years']} years)")

    print(f"\nSTATIC PLACES: {len(static)} squares (+ ring) removed. Biggest:")
    print(static.head(5)[["lat", "lon", "busy_years", "max_months",
                          "detections"]].to_string(index=False))

    def near(lat, lon, d=0.1):
        s = static[(abs(static["lat"] - lat) < d)
                   & (abs(static["lon"] - lon) < d)]
        return f"YES ({len(s)} squares)" if len(s) else "no"
    if name == "Uzbekistan":
        jul = monthly.set_index("month").loc["2025-07"]
        print(f"\nCHECKS\n  Angren (41.0 N, 70.1 E) static: {near(41.0, 70.1)}")
        print(f"  Industrial site (38.05 N, 67.27 E) static: "
              f"{near(38.05, 67.27)}")
        print(f"  July 2025 after cleaning: MODIS {jul['modis']}, VIIRS "
              f"{jul['viirs']}   (prototype: MODIS 225, VIIRS 807)")

    out = result["json"]
    print(f"\nOUTPUT\n  {out}  ({out.stat().st_size / 1e6:.2f} MB, cell "
          f"{data['cell_size']} deg, {len(data['cells'])} squares, "
          f"{len(data['months'])} months)")
    if result["image"]:
        print(f"  check image: {result['image']}")


# ---------------------------------------------------------------------------
# --all: every country, global rate, summary files
# ---------------------------------------------------------------------------
def run_all(fresh):
    from countries import firms_names
    names = sorted(firms_names())
    t0 = time.time()

    # 1) Heavy part: aggregate each country (skips countries already done,
    #    so a crash or a restart doesn't lose the work).
    print(f"Aggregating {len(names)} countries (year by year)...")
    for k, name in enumerate(names, 1):
        if not fresh and (work_dir(name) / "meta.json").exists():
            continue
        t = time.time()
        meta = aggregate_country(name)
        size = (f"cell {meta['cell']}" if meta else "no data")
        print(f"  [{k}/{len(names)}] {name}: {size} "
              f"({time.time() - t:.0f} s)", flush=True)

    # 2) Global median rate from the countries with good data.
    aggs = {n: a for n in names if (a := load_aggregates(n)) is not None}
    good, good_terra = [], []
    for name, agg in aggs.items():
        _, src, _, terra_rates, tsrc = country_rates(
            monthly_table(agg), PLACEHOLDER_GLOBAL, PLACEHOLDER_GLOBAL)
        rates = learn_rates(monthly_table(agg))[0]
        if src == "country":
            good += [r["rate"] for r in rates.values()]
        if tsrc == "country":
            good_terra += [r["rate"] for r in terra_rates.values()]
    global_rate = round(float(np.median(good)), 2)
    global_terra = round(float(np.median(good_terra)), 2)
    GLOBAL_FILE.write_text(json.dumps({
        "rate": global_rate, "terra_rate": global_terra,
        "countries": len(good) // 12, "terra_countries": len(good_terra) // 12}))

    # 3) Export every country with the real global rate.
    print("\nExporting JSON files...")
    rows, listing, statics = [], [], []
    for name, agg in aggs.items():
        res = export_country(name, agg, global_rate, global_terra,
                             image=name in CHECK_IMAGES)
        d = res["data"]
        total_h = sum(h for h in d["totals"]["harmonized"] if h)
        if total_h <= 0:
            res["json"].unlink()          # no hotspots: skip this country
            continue
        rate_avg = round(float(np.mean([r["rate"]
                                        for r in d["rates"].values()])), 2)
        v = d["validation"]
        listing.append({"name": d["name"], "slug": d["slug"],
                        "bbox": d["bbox"], "total_H": round(total_h),
                        "rate_avg": rate_avg,
                        "validation_error": v["median_abs_error_pct"]})
        row = {"country": d["name"], "slug": d["slug"],
               "rate_source": d["rate_source"], "n_ratios": d["n_ratios"],
               "cell_size": d["cell_size"], "rate_avg": rate_avg}
        row.update({f"rate_{c:02d}": d["rates"][str(c)]["rate"]
                    for c in range(1, 13)})
        row.update({f"terra_rate_{c:02d}": d["rates_terra"][str(c)]["rate"]
                    for c in range(1, 13)})
        row.update({"val_median_abs_error_pct": v["median_abs_error_pct"],
                    "val_pearson_r": v["pearson_r"],
                    "val_bias_pct": v["bias_pct"],
                    "val_loyo_mean_error_pct": v["loyo_mean_error_pct"],
                    "total_H": round(total_h)})
        rows.append(row)
        s = agg["static"]
        if len(s):
            statics.append(pd.DataFrame({"country": name, "lat": s["lat"],
                                         "lon": s["lon"]}))
        if name == "Uzbekistan" or res["image"]:
            report(name, agg, res) if name == "Uzbekistan" else None

    listing.sort(key=lambda x: x["name"])
    # The World overview goes first in the list (it is the page's first view).
    listing.insert(0, build_world(aggs, global_rate, global_terra))
    (config.WEB_DATA_DIR / "countries.json").write_text(
        json.dumps(listing, separators=(",", ":")), encoding="utf-8")
    pd.DataFrame(rows).sort_values("country").to_csv(
        config.WEB_DATA_DIR / "rates_summary.csv", index=False)
    # Static places + square sizes for the Stage 6 robot (it can't read data_work).
    pd.concat(statics).to_csv(STATIC_LIST, index=False)
    (config.REPO_DIR / "data" / "cell_sizes.json").write_text(
        json.dumps({r["slug"]: r["cell_size"] for r in rows}, separators=(",", ":")))

    # 4) Summary printout.
    files = [p for p in config.WEB_DATA_DIR.rglob("*") if p.is_file()]
    total = sum(p.stat().st_size for p in files)
    big = sorted(files, key=lambda p: -p.stat().st_size)[:10]
    n_global = sum(r["rate_source"] == "global" for r in rows)
    print(f"\n{'=' * 70}\nSTAGE 3 SUMMARY ({(time.time() - t0) / 60:.0f} min)")
    print(f"  countries with hotspots: {len(listing)}")
    print(f"  global median rate: {global_rate} (from {len(good) // 12} "
          f"countries), Terra-only: {global_terra}")
    print(f"  countries using the global rate: {n_global}")
    print(f"  cell sizes: {pd.Series([r['cell_size'] for r in rows]).value_counts().to_dict()}")
    print(f"  web/data total: {total / 1e6:.1f} MB "
          f"({'OK' if total < 300e6 else 'over the plan 300 MB, team kept it'}, "
          f"GitHub Pages limit 1 GB)")
    over = [p for p in files if p.stat().st_size > 50e6]
    print(f"  files over 50 MB: {[p.name for p in over] or 'none'}")
    print("  10 biggest files:")
    for p in big:
        print(f"    {p.stat().st_size / 1e6:6.2f} MB  "
              f"{p.relative_to(config.WEB_DATA_DIR)}")
    print(f"  static places list: {STATIC_LIST} "
          f"({sum(len(s) for s in statics)} squares)")
    print(f"  check images: {config.CHECKS_DIR}")


# ---------------------------------------------------------------------------
# WORLD OVERVIEW: all countries added together (the page's first view)
# ---------------------------------------------------------------------------
WORLD_CELLS = (1.0, 2.0)          # world squares: 1 degree, or 2 if too big


def build_world(aggs, global_rate, global_terra):
    """Add up every country into one 'World' file with the same fields.

    Each country keeps ITS OWN exchange rates: world harmonized = the sum
    of every country's harmonized numbers (not one world rate x MODIS).
    """
    t0 = time.time()
    monthly_parts, grids, dailies, statics = [], [], [], []
    steps = new_steps()
    for name, agg in aggs.items():
        monthly = monthly_table(agg)
        rates, _, _, terra_rates, _ = country_rates(monthly, global_rate,
                                                    global_terra)
        monthly["h"] = [harmonize(m, a, b, rates, terra_rates) for m, a, b
                        in zip(monthly["month"], monthly["modis"],
                               monthly["viirs"])]
        monthly_parts.append(monthly)
        g = agg["grid"].copy()
        g["month"] = [ym_str(y) for y in g["ym"]]
        g["h"] = [harmonize(m, a, b, rates, terra_rates) for m, a, b
                  in zip(g["month"], g["n_modis"], g["n_viirs"])]
        g["cs"] = agg["meta"]["cell"]
        grids.append(g)
        dailies.append(daily_arrays(agg, rates, terra_rates))
        for k, s in enumerate(agg["meta"]["steps"]):
            for sensor in ("MODIS", "VIIRS"):
                for f in ("before", "removed"):
                    steps[k][sensor][f] += s[sensor][f]
        if len(agg["static"]):
            statics.append(agg["static"])

    # Monthly totals: sum of all countries (same month list everywhere)
    total = pd.concat(monthly_parts).groupby(["ym", "month"], as_index=False)[
        ["modis", "viirs", "frp_modis", "frp_viirs", "terra", "h"]].sum()
    months = total["month"].tolist()
    before_viirs = total["month"] < VIIRS_START_DAY[:7]

    # World "exchange rates" (all countries together): shown in the table
    # and used by the proof chart; the hidden-years test on world totals.
    rates, _, n_ratios = learn_rates(total, global_rate=global_rate)
    terra_rates, _, _ = learn_rates(
        total[["month", "viirs"]].assign(modis=total["terra"]),
        global_rate=global_terra)
    validation, _ = validate(total, global_rate)

    # Squares: 0.1/0.25 country squares nest exactly into 1 or 2 degree squares
    g = pd.concat(grids, ignore_index=True)
    first = ym_of(HISTORY_START)
    for size in WORLD_CELLS:
        f = (size / g["cs"]).round().astype(int)       # 10, 4, 20 or 8
        w = g.assign(I=np.floor_divide(g["i"], f), J=np.floor_divide(g["j"], f))
        w = w.groupby(["ym", "I", "J"], as_index=False)[
            ["n_modis", "n_viirs", "h", "frp_modis", "frp_viirs"]].sum()
        if len(w) * 26 / 1e6 <= MAX_JSON_MB * 2:         # world may be 2x bigger
            break
    cells = {}
    for r in w.itertuples(index=False):
        cells.setdefault(f"{r.I}_{r.J}", []).append(
            [int(r.ym) - first, int(r.n_modis), int(r.n_viirs), short(r.h),
             short(r.frp_modis, 0), short(r.frp_viirs, 0)])

    n = max(len(d["modis"]) for d in dailies)
    day_m, day_v, day_h = np.zeros(n), np.zeros(n), np.zeros(n)
    for d in dailies:
        day_m[:len(d["modis"])] += d["modis"]
        day_v[:len(d["viirs"])] += [x or 0 for x in d["viirs"]]
        day_h[:len(d["harmonized"])] += [x or 0 for x in d["harmonized"]]
    first_viirs = (pd.Timestamp(VIIRS_START_DAY) - EPOCH).days - DAY0

    st = (pd.concat(statics).sort_values("detections", ascending=False)
          if statics else pd.DataFrame(columns=["lat", "lon", "detections"]))
    data = {
        "name": "World", "slug": "world", "firms_name": "World",
        "bbox": [-180, -60, 180, 80], "cell_size": size,
        "months": months,
        "totals": {
            "modis": total["modis"].astype(int).tolist(),
            "viirs": [None if b else int(v) for b, v in zip(before_viirs, total["viirs"])],
            "harmonized": [short(h) for h in total["h"]],
            "frp_modis": [short(x, 0) for x in total["frp_modis"]],
            "frp_viirs": [None if b else short(x, 0) for b, x in zip(before_viirs, total["frp_viirs"])],
        },
        "rates": rates, "rate_source": "world", "n_ratios": n_ratios,
        "rates_terra": terra_rates,
        "terra_only_months": [m for m in months if m < AQUA_START],
        "validation": validation,
        "cleaning": steps,
        "static_cells": {"count": int(len(st)),
                         "top": st.head(50)[["lat", "lon", "detections"]].values.tolist()},
        "partial_months": {m: r for m, r in PARTIAL_MONTHS.items() if m in months},
        "days_start": f"{HISTORY_START}-01",
        "daily": {"modis": [int(x) for x in day_m],
                  "viirs": [None if k < first_viirs else int(x) for k, x in enumerate(day_v)],
                  "harmonized": [short(x) for x in day_h]},
        "cell_fields": ["month_index", "modis", "viirs", "harmonized",
                        "frp_modis_mw", "frp_viirs_mw"],
        "cells": cells,
    }
    out = OUT_COUNTRY / "world.json"
    out.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    total_h = sum(h for h in data["totals"]["harmonized"] if h)
    print(f"World: {len(aggs)} countries, {size} deg squares ({len(cells)} squares), "
          f"{out.stat().st_size / 1e6:.1f} MB, {time.time() - t0:.0f} s")
    return {"name": "World", "slug": "world", "bbox": data["bbox"],
            "total_H": round(total_h),
            "rate_avg": round(float(np.mean([r["rate"] for r in rates.values()])), 2),
            "validation_error": validation["median_abs_error_pct"]}


def run_world():
    """Rebuild only world.json (and its line in countries.json) from saved work."""
    from countries import firms_names
    g = json.loads(GLOBAL_FILE.read_text())
    aggs = {n: a for n in sorted(firms_names()) if (a := load_aggregates(n)) is not None}
    entry = build_world(aggs, g["rate"], g["terra_rate"])
    path = config.WEB_DATA_DIR / "countries.json"
    listing = [c for c in json.loads(path.read_text(encoding="utf-8")) if c["slug"] != "world"]
    path.write_text(json.dumps([entry] + listing, separators=(",", ":")), encoding="utf-8")


def run_one(name, fresh):
    if fresh or load_aggregates(name) is None:
        if aggregate_country(name) is None:
            print(f"{name}: no data")
            return
    g = (json.loads(GLOBAL_FILE.read_text()) if GLOBAL_FILE.exists()
         else {"rate": PLACEHOLDER_GLOBAL, "terra_rate": PLACEHOLDER_GLOBAL})
    agg = load_aggregates(name)
    res = export_country(name, agg, g["rate"], g["terra_rate"], image=True)
    report(name, agg, res)


def main():
    ap = argparse.ArgumentParser(description="HotSync processing")
    ap.add_argument("--country", help="FIRMS name, e.g. Uzbekistan")
    ap.add_argument("--all", action="store_true", help="every country")
    ap.add_argument("--fresh", action="store_true",
                    help="re-read the zips, don't reuse saved work")
    ap.add_argument("--world", action="store_true",
                    help="rebuild only world.json from saved work")
    args = ap.parse_args()
    config.make_folders()
    if args.world:
        run_world()
    elif args.country:
        run_one(args.country, args.fresh)
    elif args.all:
        run_all(args.fresh)
    else:
        ap.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
