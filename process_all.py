"""
HotSync: process_all.py  (Stage 2: one country, Stage 3: all countries)

For each country, this script turns the raw FIRMS zips into one small JSON
file for the website:

    1. LOAD      that country's MODIS + VIIRS CSVs, year by year, straight
                 from the zips (no unzipping to disk)
    2. CLEAN     type, confidence, "always hot" places (factories)
    3. GRID      count fires per 0.1 degree square per month (+ fire power)
    4. RATES     the "exchange rate" VIIRS / MODIS for each calendar month
    5. HARMONIZE H = rate x MODIS before Feb 2012, H = VIIRS after
    6. VALIDATE  hide 2012-2014, predict it from MODIS, compare with real VIIRS
    7. EXPORT    web/data/country/<slug>.json (+ dots for showcase countries)
                 and a check image in D:\\hotsync_data\\checks

Run:
    .venv\\Scripts\\python process_all.py --country Uzbekistan
    .venv\\Scripts\\python process_all.py --all          (Stage 3)
"""

import argparse
import json
import math
import re
import shutil
import zipfile
from pathlib import Path

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

CELL = 0.1                         # map squares (~11 km)
BIG_CELL = 0.25                    # used if the JSON would be too big
MAX_JSON_MB = 3

MIN_MODIS = 10                     # a month needs >= 10 MODIS fires for a ratio
MIN_YEARS = 3                      # a calendar month needs >= 3 such years
MIN_RATIOS = 6                     # a country needs >= 6 ratios, else global
GLOBAL_RATE = 3.5                  # placeholder, recomputed in Stage 3

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

SHOWCASE = {"Uzbekistan", "Argentina"}   # these keep every fire dot
COLUMNS = ["latitude", "longitude", "acq_date", "acq_time", "satellite",
           "confidence", "frp", "type"]

OUT_COUNTRY = config.WEB_DATA_DIR / "country"
OUT_POINTS = config.WEB_DATA_DIR / "points"
GEOJSON = config.REPO_DIR / "data" / "countries.geojson"

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


# ---------------------------------------------------------------------------
# 1. LOAD
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
                               dtype={"acq_time": str, "confidence": str})


def load_world_2026(name):
    """Optional 2026 world CSVs (no country column) -> rows of this country.

    The country is found with polygons (countries.assign_country) and the
    result is cached in data_work, so --all doesn't repeat the slow part.
    VIIRS rule: S-NPP up to SNPP_LAST_DAY, NOAA-20 after it.
    Archive (standard) data wins over NRT for the days it covers.
    """
    from countries import assign_country
    frames = []
    for f in sorted(config.DATA_2026_DIR.glob("fire_*.csv")):
        code = next((c for c in WORLD_CODES if f"_{c}_" in f.name), None)
        if code is None:
            continue
        sensor, sat = WORLD_CODES[code]
        cache = config.WORK_DIR / "world2026" / (f.stem + ".parquet")
        if not cache.exists():
            cache.parent.mkdir(parents=True, exist_ok=True)
            df = pd.read_csv(f, usecols=lambda c: c in COLUMNS,
                             dtype={"acq_time": str, "confidence": str})
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
    for s, g in df.groupby("sensor"):
        last_sp = g.loc[g["kind"] == "sp", "acq_date"].max()
        keep.append(g if pd.isna(last_sp) else
                    g[(g["kind"] == "sp") | (g["acq_date"] > last_sp)])
    return pd.concat(keep).drop(columns="kind")


def load_country(name):
    """All years, both sensors, one table with a 'sensor' column."""
    frames = []
    for sensor, prefix, years in (("MODIS", "modis", MODIS_YEARS),
                                  ("VIIRS", "viirs-snpp", VIIRS_YEARS)):
        for year in years:
            df = read_zip_country(prefix, year, name)
            if df is not None:
                frames.append(df.assign(sensor=sensor))
    recent = load_world_2026(name)
    if recent is not None:
        frames.append(recent)
    if not frames:
        return None
    return pd.concat(frames, ignore_index=True)


# ---------------------------------------------------------------------------
# 2. CLEAN
# ---------------------------------------------------------------------------
def find_static_cells(df):
    """Find ~1 km squares that are hot almost all year.

    A real fire burns for days or weeks. A factory or gas flare is hot
    month after month, year after year. So a square is "static" if it has
    fires in >= 8 different months of one year, in >= 3 different years,
    OR in >= 10 different months of any single year (new factories).
    Both sensors together.
    """
    cells = pd.DataFrame({
        # Integer keys (lat x 100) avoid float rounding surprises.
        "ci": np.round(df["latitude"] / STATIC_CELL).astype(int),
        "cj": np.round(df["longitude"] / STATIC_CELL).astype(int),
        "year": df["acq_date"].str[:4],
        "month": df["acq_date"].str[5:7],
    })
    months_per_year = (cells.drop_duplicates()
                       .groupby(["ci", "cj", "year"]).size())
    busy_years = (months_per_year >= STATIC_MONTHS).groupby(
        ["ci", "cj"]).sum()
    max_months = months_per_year.groupby(["ci", "cj"]).max()
    static = busy_years[(busy_years >= STATIC_YEARS)
                        | (max_months >= STATIC_ANY_YEAR_MONTHS)]

    # How many detections each static square had (to show the biggest).
    hits = cells.groupby(["ci", "cj"]).size()
    out = pd.DataFrame({"busy_years": static,
                        "max_months": max_months.reindex(static.index),
                        "detections": hits.reindex(static.index)})
    out = out.reset_index().sort_values("detections", ascending=False)
    out["lat"] = (out["ci"] * STATIC_CELL).round(2)
    out["lon"] = (out["cj"] * STATIC_CELL).round(2)
    return out


def clean(df):
    """Apply the cleaning rules in order. Returns (clean df, steps, static)."""
    steps = []

    def record(step, keep):
        nonlocal df
        row = {"step": step}
        for s in ("MODIS", "VIIRS"):
            mine = df["sensor"] == s
            row[s] = {"before": int(mine.sum()),
                      "removed": int((mine & ~keep).sum())}
        steps.append(row)
        df = df[keep]

    # Rule 1: only vegetation fires (type 0). Rows with no type (NRT data)
    # are kept here; the static-cell rule catches their factories.
    has_type = df["type"].notna() if "type" in df else False
    record("type == 0 (vegetation fire)",
           ~has_type | (df["type"] == 0) if "type" in df
           else pd.Series(True, index=df.index))

    # Rule 2: confidence. MODIS: number >= 30. VIIRS: n or h (any case;
    # some NRT files write "nominal" / "high", so we check the 1st letter).
    is_modis = df["sensor"] == "MODIS"
    conf_num = pd.to_numeric(df["confidence"], errors="coerce")
    conf_letter = df["confidence"].astype(str).str.lower().str[0]
    record(f"confidence (MODIS >= {MODIS_MIN_CONF}, VIIRS n/h)",
           (is_modis & (conf_num >= MODIS_MIN_CONF))
           | (~is_modis & conf_letter.isin(VIIRS_KEEP_CONF)))

    # Rule 3: always-hot places.
    static = find_static_cells(df)
    key = (np.round(df["latitude"] / STATIC_CELL).astype(int).astype(str)
           + "_" + np.round(df["longitude"] / STATIC_CELL).astype(int)
           .astype(str))
    ring = (-1, 0, 1) if STATIC_RING else (0,)
    static_keys = {f"{i + di}_{j + dj}"
                   for i, j in zip(static["ci"], static["cj"])
                   for di in ring for dj in ring}
    record(f"static places ({len(static)} squares of ~1 km"
           + (" + ring around each)" if STATIC_RING else ")"),
           ~key.isin(static_keys))

    return df.copy(), steps, static


# ---------------------------------------------------------------------------
# 3. GRID (fires and fire power per square per month)
# ---------------------------------------------------------------------------
def grid(df, cell):
    """Count fires and add up FRP per square, per month, per sensor."""
    g = df.assign(month=df["acq_date"].str[:7],
                  i=np.floor(df["latitude"] / cell).astype(int),
                  j=np.floor(df["longitude"] / cell).astype(int))
    agg = (g.groupby(["month", "i", "j", "sensor"])
           .agg(n=("frp", "size"), frp=("frp", "sum"))
           .unstack("sensor", fill_value=0))
    out = pd.DataFrame(index=agg.index)
    for s in ("MODIS", "VIIRS"):
        low = s.lower()
        out[low] = agg[("n", s)] if ("n", s) in agg else 0
        out[f"frp_{low}"] = agg[("frp", s)] if ("frp", s) in agg else 0.0
    return out.reset_index()


def month_list(last_month):
    """['2000-11', '2000-12', ..., last_month]."""
    return [str(p) for p in pd.period_range(HISTORY_START, last_month,
                                            freq="M")]


# ---------------------------------------------------------------------------
# 4. EXCHANGE RATES
# ---------------------------------------------------------------------------
def learn_rates(monthly, years=None):
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
            rate, src = GLOBAL_RATE, "global"
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


def validate(monthly):
    """Learn on 2015-2025, predict 2012-02..2014-12. Also leave-one-year-out."""
    rates, src, _ = learn_rates(monthly, VALID_TRAIN)
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
        yr_rates, _, _ = learn_rates(monthly, others)
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
# 8. DAILY TOTALS
# ---------------------------------------------------------------------------
def daily_arrays(df, rates, terra_rates, last_day):
    """Country totals per day, from 2000-11-01: MODIS, VIIRS, harmonized."""
    days = pd.date_range(f"{HISTORY_START}-01", last_day, freq="D")
    labels = days.strftime("%Y-%m-%d")
    counts = (df.groupby(["acq_date", "sensor"]).size()
              .unstack(fill_value=0).reindex(labels, fill_value=0))
    modis = counts.get("MODIS", pd.Series(0, index=labels)).astype(int)
    viirs = counts.get("VIIRS", pd.Series(0, index=labels)).astype(int)

    out_v, out_h = [], []
    for day, m, v in zip(labels, modis, viirs):
        out_v.append(None if day < VIIRS_START_DAY else int(v))
        out_h.append(short(harmonize(day[:7], m, v, rates, terra_rates)))
    return {"modis": modis.tolist(), "viirs": out_v, "harmonized": out_h}


# ---------------------------------------------------------------------------
# 7. EXPORT
# ---------------------------------------------------------------------------
def country_bbox(name, df):
    """[west, south, east, north] from the country polygon (or the dots)."""
    try:
        from shapely.geometry import shape
        with open(GEOJSON, encoding="utf-8") as f:
            for ft in json.load(f)["features"]:
                if ft["properties"]["firms"] == name:
                    return [round(v, 2) for v in shape(ft["geometry"]).bounds]
    except (OSError, ImportError):
        pass
    return [round(df["longitude"].min(), 2), round(df["latitude"].min(), 2),
            round(df["longitude"].max(), 2), round(df["latitude"].max(), 2)]


def build_json(name, df, steps, static, cell):
    """Everything the website needs for one country, as a Python dict."""
    last_day = df["acq_date"].max()
    months = month_list(last_day[:7])
    m_index = {m: k for k, m in enumerate(months)}

    cells = grid(df, cell)
    monthly = (cells.groupby("month")[["modis", "viirs", "frp_modis",
                                       "frp_viirs"]].sum()
               .reindex(months, fill_value=0).reset_index()
               .rename(columns={"index": "month"}))

    rates, rate_source, n_ratios = learn_rates(monthly)

    # Terra-only rate: the same method, but MODIS = Terra fires only.
    terra = df[(df["sensor"] == "MODIS")
               & df["satellite"].astype(str).str.upper().str.startswith("T")]
    terra_monthly = monthly[["month", "viirs"]].assign(
        modis=terra.groupby(terra["acq_date"].str[:7]).size()
        .reindex(monthly["month"], fill_value=0).values)
    terra_rates, _, _ = learn_rates(terra_monthly)

    monthly["h"] = [harmonize(m, a, b, rates, terra_rates) for m, a, b in
                    zip(monthly["month"], monthly["modis"], monthly["viirs"])]
    validation, pairs = validate(monthly)

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
    for row in cells.itertuples(index=False):
        h = harmonize(row.month, row.modis, row.viirs, rates, terra_rates)
        cell_map.setdefault(f"{row.i}_{row.j}", []).append(
            [m_index[row.month], int(row.modis), int(row.viirs), short(h),
             short(row.frp_modis, 0), short(row.frp_viirs, 0)])

    data = {
        "name": name.replace("_", " "), "slug": slug_of(name),
        "firms_name": name,
        "bbox": country_bbox(name, df),
        "cell_size": cell,
        "months": months,
        "totals": totals,
        "rates": rates, "rate_source": rate_source, "n_ratios": n_ratios,
        # Used instead of "rates" for the Terra-only months.
        "rates_terra": terra_rates,
        "terra_only_months": [m for m in months if m < AQUA_START],
        "validation": validation,
        "cleaning": steps,
        "static_cells": {
            "count": int(len(static)),
            "top": static.head(50)[["lat", "lon", "detections"]]
            .values.tolist()},
        "partial_months": {m: r for m, r in PARTIAL_MONTHS.items()
                           if m in m_index},
        "days_start": f"{HISTORY_START}-01",
        "daily": daily_arrays(df, rates, terra_rates, last_day),
        # Square key "i_j": south-west corner = (i x cell_size, j x cell_size).
        "cell_fields": ["month_index", "modis", "viirs", "harmonized",
                        "frp_modis_mw", "frp_viirs_mw"],
        "cells": cell_map,
    }
    return data, monthly, pairs, cells


def write_points(name, df):
    """Showcase countries: every clean fire dot, one CSV per year."""
    folder = OUT_POINTS / slug_of(name)
    if folder.exists():
        shutil.rmtree(folder)       # old files from an earlier run
    folder.mkdir(parents=True)
    pts = pd.DataFrame({
        "lat": df["latitude"].round(4), "lon": df["longitude"].round(4),
        "date": df["acq_date"], "time": df["acq_time"].str.zfill(4),
        "sensor": df["sensor"], "confidence": df["confidence"],
        "frp": df["frp"], "satellite": df["satellite"],
    }).sort_values(["date", "time"])
    sizes = {}
    for year, g in pts.groupby(pts["date"].str[:4]):
        path = folder / f"{year}.csv"
        g.to_csv(path, index=False)
        sizes[year] = path.stat().st_size
    return folder, sizes


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

    cal = range(1, 13)
    r = [rates[str(c)]["rate"] for c in cal]
    lo = [r[k] - (rates[str(c)]["q25"] or r[k]) for k, c in enumerate(cal)]
    hi = [(rates[str(c)]["q75"] or r[k]) - r[k] for k, c in enumerate(cal)]
    ax[1].bar(cal, r, color="#2f5bea", alpha=0.75, label="Terra + Aqua")
    ax[1].errorbar(cal, r, yerr=[lo, hi], fmt="none", color="black",
                   capsize=3)
    ax[1].plot(cal, [terra_rates[str(c)]["rate"] for c in cal], "o",
               color="#e8613a", label="Terra only (before Jul 2002)")
    ax[1].legend(fontsize=8)
    for c in cal:
        ax[1].text(c, 0.1, rates[str(c)]["n"], ha="center", fontsize=7,
                   color="white")
    ax[1].set_xticks(list(cal))
    ax[1].set_title("(b) exchange rate VIIRS/MODIS per month\n"
                    "(bar = median, line = q25-q75, number = years)")

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


def save_history(name, df, static, cells):
    """Keep history aggregates in data_work, so later stages (and new days)
    don't need to read the 7 GB again."""
    folder = config.WORK_DIR / slug_of(name)
    folder.mkdir(parents=True, exist_ok=True)
    cells.to_parquet(folder / f"cells_{cells.attrs.get('cell', CELL)}.parquet")
    static.to_parquet(folder / "static_cells.parquet")
    (df.groupby(["acq_date", "sensor"]).size().rename("n").reset_index()
     .to_parquet(folder / "daily.parquet"))


def process_country(name, verbose=True):
    """The whole pipeline for one country. Returns a small summary dict."""
    raw = load_country(name)
    if raw is None or raw.empty:
        print(f"{name}: no data")
        return None
    df, steps, static = clean(raw)
    if df.empty:
        print(f"{name}: nothing left after cleaning")
        return None

    # Try 0.1 degree squares; if the file gets too big, use 0.25.
    for cell in (CELL, BIG_CELL):
        data, monthly, pairs, cells = build_json(name, df, steps, static,
                                                 cell)
        text = json.dumps(data, separators=(",", ":"))
        if len(text) / 1e6 <= MAX_JSON_MB:
            break
    cells.attrs["cell"] = cell

    OUT_COUNTRY.mkdir(parents=True, exist_ok=True)
    out = OUT_COUNTRY / f"{slug_of(name)}.json"
    out.write_text(text, encoding="utf-8")
    save_history(name, df, static, cells)

    points = write_points(name, df) if name in SHOWCASE else None
    image = check_image(name, monthly, data["rates"], data["rates_terra"],
                        pairs, data["validation"])

    if verbose:
        report(name, raw, df, data, monthly, static, out, points, image)
    return {"name": name, "json": out, "size": out.stat().st_size,
            "data": data}


# ---------------------------------------------------------------------------
# REPORT (printed, for us to check the science)
# ---------------------------------------------------------------------------
def report(name, raw, df, data, monthly, static, out, points, image):
    print(f"\n{'=' * 70}\n{name}\n{'=' * 70}")

    print("\nCLEANING (rows removed per step)")
    print(f"  {'step':48s} {'MODIS':>16s} {'VIIRS':>16s}")
    for s in data["cleaning"]:
        cols = [f"-{s[k]['removed']:,} of {s[k]['before']:,}"
                for k in ("MODIS", "VIIRS")]
        print(f"  {s['step']:48s} {cols[0]:>16s} {cols[1]:>16s}")
    left = df["sensor"].value_counts()
    print(f"  {'left after cleaning':48s} {left.get('MODIS', 0):>16,} "
          f"{left.get('VIIRS', 0):>16,}")

    print("\nEXCHANGE RATES (VIIRS / MODIS), learned on 2012-02..2025-12")
    names = "Jan Feb Mar Apr May Jun Jul Aug Sep Oct Nov Dec".split()
    for c in range(1, 13):
        r = data["rates"][str(c)]
        print(f"  {names[c - 1]}: {r['rate']:>5}   q25-q75 {r['q25']}-"
              f"{r['q75']}   years {r['n']:>2}   ({r['src']})")
    print(f"  rate source: {data['rate_source']}, valid ratios: "
          f"{data['n_ratios']}")

    v = data["validation"]
    print("\nVALIDATION (learn 2015-2025, predict 2012-02..2014-12)")
    print(f"  months tested: {v['months']}")
    print(f"  median absolute error: {v['median_abs_error_pct']}% "
          f"(months with VIIRS >= {MIN_VIIRS_FOR_ERROR})")
    print(f"  Pearson r: {v['pearson_r']}")
    print(f"  total bias: {v['bias_pct']}%")
    print(f"  leave-one-year-out mean error: {v['loyo_mean_error_pct']}% "
          f"({v['loyo_years']} years)")

    t = data["rates_terra"]
    print("\nTERRA-ONLY RATES (used for " + data["terra_only_months"][0]
          + ".." + data["terra_only_months"][-1] + "):  "
          + "  ".join(f"{names[c - 1]} {t[str(c)]['rate']}"
                      for c in range(1, 13))
          if data["terra_only_months"] else "")

    print(f"\nSTATIC PLACES: {len(static)} squares (+ ring) removed. Biggest:")
    print(static.head(8)[["lat", "lon", "busy_years", "max_months",
                          "detections"]].to_string(index=False))

    # Checks the plan asks for (useful for any country).
    def near(lat, lon, d=0.1):
        s = static[(abs(static["lat"] - lat) < d)
                   & (abs(static["lon"] - lon) < d)]
        return f"YES ({len(s)} squares)" if len(s) else "no"
    if name == "Uzbekistan":
        print(f"\nCHECKS\n  Angren (41.0 N, 70.1 E) static: {near(41.0, 70.1)}")
        print(f"  Industrial site (38.05 N, 67.27 E) static: "
              f"{near(38.05, 67.27)}")
        jul = df[df["acq_date"].str[:7] == "2025-07"]["sensor"].value_counts()
        print(f"  July 2025 after cleaning: MODIS {jul.get('MODIS', 0)}, "
              f"VIIRS {jul.get('VIIRS', 0)}   (prototype: MODIS 225, VIIRS 807)")

    # MODIS before July 2002 = Terra only (Aqua MODIS started 4 Jul 2002).
    m = raw[raw["sensor"] == "MODIS"]
    sat = m.groupby([m["acq_date"].str[:4], "satellite"]).size().unstack(
        fill_value=0)
    print("\nMODIS satellites per year (Terra only before Jul 2002):")
    print(sat.loc[[y for y in ("2001", "2002", "2003", "2015", "2025")
                   if y in sat.index]].to_string())

    print(f"\nOUTPUT\n  {out}  ({out.stat().st_size / 1e6:.2f} MB, "
          f"cell {data['cell_size']} deg, {len(data['cells'])} squares, "
          f"{len(data['months'])} months)")
    if points:
        folder, sizes = points
        print(f"  {folder}  ({len(sizes)} yearly CSV files, "
              f"{sum(sizes.values()) / 1e6:.2f} MB)")
    print(f"  check image: {image}")


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[1])
    ap.add_argument("--country", help="FIRMS name, e.g. Uzbekistan")
    ap.add_argument("--all", action="store_true", help="every country")
    args = ap.parse_args()
    if args.country:
        process_country(args.country)
    elif args.all:
        from countries import firms_names
        for name in sorted(firms_names()):
            s = process_country(name, verbose=False)
            if s:
                print(f"{name}: {s['size'] / 1e6:.2f} MB")
    else:
        ap.print_help()


if __name__ == "__main__":
    main()
