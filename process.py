"""
HotSync practice: process.py

This script does the data work, one step at a time:
    Step 2. Load   -> read the two CSV files       (done)
    Step 3. Clean  -> keep only good, real fires    (next)
    Step 4. Count  -> fires per day                 (later)
    Step 5. Make fair (harmonize)                   (later)
    Step 6. Export -> CSV + JSON for the website    (later)

Run it from the hotsync-practice folder:
    .venv\\Scripts\\python process.py
"""

import json
from pathlib import Path

import pandas as pd

# ---------------------------------------------------------------------------
# CONFIG: all settings in one place, so we never hunt for them in the code.
# ---------------------------------------------------------------------------
# Path(__file__).parent = the folder this script is in.
# This way the script works no matter which folder you run it from.
ROOT = Path(__file__).parent

CONFIG = {
    # Where the raw files are. We copied them here in Step 1.
    "modis_file": ROOT / "data" / "raw" / "modis.csv",
    "viirs_file": ROOT / "data" / "raw" / "viirs.csv",

    # --- Cleaning rules (Step 3) ---
    # MODIS confidence is a number 0-100. Below 30 = "low", we drop it.
    "modis_min_confidence": 30,
    # VIIRS confidence is a letter: l = low, n = nominal (normal), h = high.
    # We keep only these letters.
    "viirs_keep_confidence": ["n", "h"],
    # A simple box around Uzbekistan (in degrees).
    # Anything outside is a mistake or a fire in a neighbour country.
    "box": {"lat_min": 37, "lat_max": 46, "lon_min": 56, "lon_max": 74},
    # Known fixed hot places (factories, gas flares). They are hot every day,
    # but they are NOT fires. VIIRS forgets to mark this one as type 2,
    # so the type rule alone can't catch it. We remove a small square
    # around it: +/- 0.05 degrees = about 5 km in each direction.
    "fixed_hot_places": [
        {"name": "industrial site", "lat": 38.05, "lon": 67.27, "size": 0.05},
        # Near Angren (coal power plant, mines). Hot on 27 of 31 days in
        # VIIRS. A real fire does not burn almost every day in one spot.
        {"name": "Angren site", "lat": 41.0, "lon": 70.2, "size": 0.05},
    ],

    # --- Harmonizing (Step 5) ---
    # Grid size for Method B: 0.1 degree = about 10 km squares.
    "grid_size": 0.1,
    # Which ratio we use to convert MODIS: "total", "overlap" or "median".
    "ratio_to_use": "overlap",

    # --- Export (Step 6) ---
    "processed_dir": ROOT / "data" / "processed",
    "summary_file": ROOT / "web" / "data" / "summary.json",
    "area": "Uzbekistan",
    # The map gets slow with too many dots, so we keep at most this many.
    "max_map_points": 5000,
}


# ---------------------------------------------------------------------------
# STEP 2. LOAD
# ---------------------------------------------------------------------------
def load_one(path, sensor_name):
    """Read one CSV file and label every row with the sensor name."""
    # dtype={"acq_time": str} -> keep the time as text, like "0520".
    # If pandas read it as a number, "0520" would become 520 and lose the 0.
    df = pd.read_csv(path, dtype={"acq_time": str})

    # Add a new column so every row "remembers" which camera found it.
    # Later we put both tables together, and this is how we tell them apart.
    df["sensor"] = sensor_name

    # acq_date is text like "2025-07-01". Turn it into a real date,
    # so pandas can sort it, find the first/last day, and group by day.
    df["acq_date"] = pd.to_datetime(df["acq_date"])

    return df


def describe(df, sensor_name):
    """Print a short report about one table."""
    print(f"\n=== {sensor_name} ===")
    print(f"Rows (hot spots): {len(df):,}")
    print(f"First date: {df['acq_date'].min().date()}")
    print(f"Last date:  {df['acq_date'].max().date()}")
    print(f"Different days with data: {df['acq_date'].nunique()}")
    print(f"Columns: {', '.join(df.columns)}")
    print("First 5 rows:")
    # Show only the most useful columns, so the table fits on the screen.
    cols = ["latitude", "longitude", "acq_date", "acq_time",
            "confidence", "frp", "daynight", "satellite", "type"]
    print(df[cols].head().to_string(index=False))


# ---------------------------------------------------------------------------
# STEP 3. CLEAN
# ---------------------------------------------------------------------------
def clean_one(df, sensor_name):
    """Keep only good, real fires. Return (clean table, report rows)."""
    report = []  # one line per rule: what we did and how many rows it removed

    def apply(rule, reason, keep_mask):
        # keep_mask is a True/False column: True = keep this row.
        # We use "nonlocal" so this little helper can change df outside it.
        nonlocal df
        before = len(df)
        df = df[keep_mask]
        report.append({"sensor": sensor_name, "rule": rule, "reason": reason,
                       "before": before, "removed": before - len(df),
                       "after": len(df)})

    # Rule 1: only vegetation fires.
    # type: 0 = vegetation fire, 1 = volcano, 2 = other fixed hot place
    # (factory, gas flare), 3 = offshore. Only 0 is a "real" fire for us.
    # Near-real-time files have no "type" column, so we check first.
    if "type" in df.columns:
        apply("type == 0", "not a vegetation fire (factory, gas flare, offshore)",
              df["type"] == 0)
    else:
        print(f"NOTE: {sensor_name} has no 'type' column, so we keep all types.")

    # Rule 2: confidence. The two sensors write it in different ways.
    if sensor_name == "MODIS":
        limit = CONFIG["modis_min_confidence"]
        apply(f"confidence >= {limit}", "satellite not sure it is a fire",
              df["confidence"] >= limit)
    else:
        keep = CONFIG["viirs_keep_confidence"]
        apply(f"confidence in {keep}", "low confidence ('l')",
              df["confidence"].isin(keep))

    # Rule 3: inside the Uzbekistan box. between() includes both ends.
    b = CONFIG["box"]
    apply("inside Uzbekistan box", "outside lat 37-46 / lon 56-74",
          df["latitude"].between(b["lat_min"], b["lat_max"])
          & df["longitude"].between(b["lon_min"], b["lon_max"]))

    # Rule 4: not at a known fixed hot place.
    # For each place: a point is "near" if both its latitude AND longitude
    # are within "size" degrees. We keep the rows that are NOT near (~ = not).
    for place in CONFIG["fixed_hot_places"]:
        near = (((df["latitude"] - place["lat"]).abs() < place["size"])
                & ((df["longitude"] - place["lon"]).abs() < place["size"]))
        apply(f"not at {place['name']}",
              "fixed hot place, always hot, not a fire", ~near)

    return df, report


# ---------------------------------------------------------------------------
# STEP 4. COUNT FIRES PER DAY
# ---------------------------------------------------------------------------
def count_per_day(modis_raw, viirs_raw, modis_clean, viirs_clean):
    """One row per day of the month: how many clean fires each sensor saw."""
    # Every day of the month, from day 1 to the last day.
    # We build the full list ourselves, so days with no fires are not lost.
    month = modis_raw["acq_date"].min().to_period("M")
    all_days = pd.date_range(month.start_time, month.end_time.normalize(),
                             freq="D")

    def daily(df):
        # value_counts() counts rows per date.
        # reindex(all_days) makes one row for EVERY day; missing days get 0.
        return (df["acq_date"].value_counts()
                .reindex(all_days, fill_value=0))

    table = pd.DataFrame({
        "date": all_days,
        "modis_raw": daily(modis_clean).values,
        "viirs_raw": daily(viirs_clean).values,
    })

    # "0 fires" and "no data" are different things!
    # If the RAW file (before cleaning) has no rows at all on a day,
    # the satellite sent nothing that day -> no data.
    # If the raw file has rows but cleaning removed them all -> really 0 fires.
    table["modis_has_data"] = daily(modis_raw).values > 0
    table["viirs_has_data"] = daily(viirs_raw).values > 0

    return table


# ---------------------------------------------------------------------------
# STEP 5. HARMONIZE (make the two sensors fair to compare)
# ---------------------------------------------------------------------------
def compute_ratios(daily, modis_clean, viirs_clean):
    """Find the 'exchange rate' VIIRS / MODIS in several ways."""
    # Days when BOTH sensors saw at least one fire.
    # This drops: no-data days (VIIRS = 0 there, but it is not a real 0),
    # and days when MODIS = 0 (we can't divide by 0).
    both = (daily["modis_raw"] > 0) & (daily["viirs_raw"] > 0)

    # Method A1: total ratio. Simple, but it uses ALL days,
    # also the 3 days when VIIRS sent no data. That makes it too small.
    total = daily["viirs_raw"].sum() / daily["modis_raw"].sum()

    # Method A2: total ratio, but only on days when both saw fires.
    overlap = (daily.loc[both, "viirs_raw"].sum()
               / daily.loc[both, "modis_raw"].sum())

    # Method A3: median of the daily ratios.
    # Median = the middle value when you sort them. One crazy day
    # (like 36 / 1 = 36) moves the average a lot, but not the median.
    daily_ratio = daily.loc[both, "viirs_raw"] / daily.loc[both, "modis_raw"]
    median = daily_ratio.median()

    # Method B: grid cells.
    # Round each point to a 0.1 degree square. Then, per day, count how many
    # DIFFERENT squares had a fire. 5 VIIRS dots on one fire = 1 square.
    g = CONFIG["grid_size"]

    def fire_cells(df):
        cells = df.assign(cell_lat=(df["latitude"] / g).round(),
                          cell_lon=(df["longitude"] / g).round())
        # drop_duplicates: same day + same square counts only once.
        return len(cells.drop_duplicates(["acq_date", "cell_lat", "cell_lon"])
                   [lambda d: d["acq_date"].isin(daily.loc[both, "date"])])

    modis_cells, viirs_cells = fire_cells(modis_clean), fire_cells(viirs_clean)
    grid = viirs_cells / modis_cells

    return {
        "total": total, "overlap": overlap, "median_daily": median,
        "grid_cells": grid,
        # extra details, printed for learning
        "days_used": int(both.sum()), "daily_ratio": daily_ratio,
        "modis_cells": modis_cells, "viirs_cells": viirs_cells,
        "both": both,
    }


def harmonize(daily, ratio):
    """MODIS harmonized = MODIS raw x ratio ('VIIRS-like' numbers)."""
    daily = daily.copy()
    daily["modis_harmonized"] = (daily["modis_raw"] * ratio).round(1)
    return daily


# ---------------------------------------------------------------------------
# STEP 6. EXPORT
# ---------------------------------------------------------------------------
def export(modis, viirs, modis_clean, viirs_clean, report, daily, r, chosen):
    """Write 2 CSV files (for people) and 1 JSON file (for the website)."""
    out = CONFIG["processed_dir"]
    out.mkdir(parents=True, exist_ok=True)
    CONFIG["summary_file"].parent.mkdir(parents=True, exist_ok=True)

    # 1) All clean hot spots, both sensors in one table.
    clean = pd.concat([modis_clean, viirs_clean], ignore_index=True)
    clean_path = out / "hotspots_clean.csv"
    clean.to_csv(clean_path, index=False, date_format="%Y-%m-%d")

    # 2) The daily table. On no-data days we write an EMPTY cell, not 0,
    #    so nobody thinks VIIRS saw 0 fires. (.where = keep value if True)
    table = daily[["date", "modis_raw", "viirs_raw", "modis_harmonized"]].copy()
    table["viirs_raw"] = table["viirs_raw"].where(daily["viirs_has_data"])
    table["modis_raw"] = table["modis_raw"].where(daily["modis_has_data"])
    table["date"] = table["date"].dt.strftime("%Y-%m-%d")
    daily_path = out / "daily_counts.csv"
    # Int64 (capital I) = whole numbers that may also be empty.
    table.astype({"modis_raw": "Int64", "viirs_raw": "Int64"}).to_csv(
        daily_path, index=False)

    # 3) summary.json: everything the website needs.
    # JSON doesn't know pandas types, so we turn every value into plain
    # Python int / float / str. Empty cells (NaN) become null.
    def num(v):
        return None if pd.isna(v) else (int(v) if float(v).is_integer()
                                         else float(v))

    daily_rows = [{"date": row["date"], "modis_raw": num(row["modis_raw"]),
                   "viirs_raw": num(row["viirs_raw"]),
                   "modis_harmonized": num(row["modis_harmonized"])}
                  for row in table.to_dict("records")]

    # Busiest day = the day VIIRS saw the most fires (it sees the most).
    busiest = daily.loc[daily["viirs_raw"].idxmax()]

    # Map points. If there are too many, keep a random sample.
    # random_state=42 -> the same "random" sample every time we run.
    points = clean
    if len(points) > CONFIG["max_map_points"]:
        points = points.sample(CONFIG["max_map_points"], random_state=42)
    point_rows = [{"lat": round(float(p["latitude"]), 4),
                   "lon": round(float(p["longitude"]), 4),
                   "sensor": p["sensor"],
                   "date": p["acq_date"].strftime("%Y-%m-%d"),
                   "time": p["acq_time"],
                   "frp": float(p["frp"])}
                  for p in points.to_dict("records")]

    summary = {
        "area": CONFIG["area"],
        "month": daily["date"].iloc[0].strftime("%Y-%m"),
        "files": {"modis_rows": len(modis), "viirs_rows": len(viirs)},
        "cleaning": [{k: num(v) if k in ("before", "removed", "after") else v
                      for k, v in row.items()}
                     for row in report.to_dict("records")],
        "totals": {"modis_raw": len(modis_clean),
                   "viirs_raw": len(viirs_clean)},
        "ratio": {"total": round(r["total"], 2),
                  "overlap": round(r["overlap"], 2),
                  "median_daily": round(r["median_daily"], 2),
                  "grid_cells": round(r["grid_cells"], 2),
                  "used": chosen,
                  "value": round(r[chosen], 2),
                  "days_used": r["days_used"]},
        "no_data_days": {
            "modis": table.loc[~daily["modis_has_data"], "date"].tolist(),
            "viirs": table.loc[~daily["viirs_has_data"], "date"].tolist()},
        "busiest_day": busiest["date"].strftime("%Y-%m-%d"),
        "busiest_day_viirs": int(busiest["viirs_raw"]),
        "daily": daily_rows,
        "points": point_rows,
    }
    with open(CONFIG["summary_file"], "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=1, ensure_ascii=False)

    return [clean_path, daily_path, CONFIG["summary_file"]], summary


def main():
    print("STEP 2. LOAD THE DATA")

    modis = load_one(CONFIG["modis_file"], "MODIS")
    viirs = load_one(CONFIG["viirs_file"], "VIIRS")

    describe(modis, "MODIS")
    describe(viirs, "VIIRS")

    # The key learning point: compare the two row counts.
    print("\n=== Compare ===")
    print(f"MODIS rows: {len(modis):,}")
    print(f"VIIRS rows: {len(viirs):,}")
    print(f"VIIRS has {len(viirs) / len(modis):.1f}x more rows than MODIS "
          "(before any cleaning).")

    # Check that both files cover the same month.
    same_month = (modis["acq_date"].dt.to_period("M").unique().tolist()
                  == viirs["acq_date"].dt.to_period("M").unique().tolist())
    print(f"Both files are in the same month: {same_month}")

    # ----- Step 3 -----
    print("\n\nSTEP 3. CLEAN THE DATA")
    modis_clean, modis_report = clean_one(modis, "MODIS")
    viirs_clean, viirs_report = clean_one(viirs, "VIIRS")

    # Show every rule: how many rows it removed, and why.
    report = pd.DataFrame(modis_report + viirs_report)
    print("\nWhat each rule removed:")
    print(report.to_string(index=False))

    # The short "before / after" table for each sensor.
    print("\nBefore / after cleaning:")
    summary = pd.DataFrame({
        "sensor": ["MODIS", "VIIRS"],
        "before": [len(modis), len(viirs)],
        "after": [len(modis_clean), len(viirs_clean)],
    })
    summary["kept %"] = (summary["after"] / summary["before"] * 100).round(1)
    print(summary.to_string(index=False))

    print(f"\nAfter cleaning, VIIRS has "
          f"{len(viirs_clean) / len(modis_clean):.1f}x more rows than MODIS "
          f"(before cleaning it was {len(viirs) / len(modis):.1f}x).")

    # ----- Step 4 -----
    print("\n\nSTEP 4. COUNT FIRES PER DAY")
    daily = count_per_day(modis, viirs, modis_clean, viirs_clean)

    # Print a friendly version: date as text, and "no data" instead of 0.
    show = daily.copy()
    show["date"] = show["date"].dt.strftime("%Y-%m-%d")
    for s in ["modis", "viirs"]:
        show[f"{s}_raw"] = show[f"{s}_raw"].astype(str).where(
            show[f"{s}_has_data"], "no data")
    # Which sensor saw more that day?
    both = daily["modis_has_data"] & daily["viirs_has_data"]
    show["VIIRS > MODIS?"] = (daily["viirs_raw"] > daily["modis_raw"]).map(
        {True: "yes", False: "no"}).where(both, "-")
    print(show.drop(columns=["modis_has_data", "viirs_has_data"])
          .to_string(index=False))

    print(f"\nDays in month: {len(daily)}")
    print(f"Totals: MODIS {daily['modis_raw'].sum()}, "
          f"VIIRS {daily['viirs_raw'].sum()}")
    print(f"Days with data from both sensors: {both.sum()}")
    print(f"On those days, VIIRS saw more than MODIS on "
          f"{(daily['viirs_raw'] > daily['modis_raw'])[both].sum()} days.")

    # ----- Step 5 -----
    print("\n\nSTEP 5. HARMONIZE")
    r = compute_ratios(daily, modis_clean, viirs_clean)
    dr = r["daily_ratio"]

    print(f"\nDays when both sensors saw fires: {r['days_used']} "
          f"(we skip no-data days and days with MODIS = 0)")
    print(f"Daily ratios go from {dr.min():.1f} to {dr.max():.1f}. "
          f"Average {dr.mean():.1f}, median {dr.median():.1f}.")

    print("\nThe ratio (VIIRS / MODIS), four ways:")
    print(f"  A1 total, all days:              {r['total']:.2f}")
    print(f"  A2 total, days both saw fires:   {r['overlap']:.2f}")
    print(f"  A3 median of daily ratios:       {r['median_daily']:.2f}")
    print(f"  B  grid cells (0.1 deg squares): {r['grid_cells']:.2f}  "
          f"({r['viirs_cells']} VIIRS cells / {r['modis_cells']} MODIS cells)")

    # Which ratio fits best? For each one, harmonize MODIS and see how far
    # it is from VIIRS on the days both saw fires (average difference).
    print("\nHow close is harmonized MODIS to VIIRS? (smaller = better)")
    b = r["both"]
    for name in ["total", "overlap", "median_daily"]:
        h = daily["modis_raw"] * r[name]
        diff = (h - daily["viirs_raw"])[b].abs().mean()
        sum_gap = h[b].sum() - daily.loc[b, "viirs_raw"].sum()
        print(f"  {name:13s} ratio {r[name]:.2f}: average daily miss "
              f"{diff:5.1f} fires, month total off by {sum_gap:+.0f}")

    # Convert MODIS with the chosen ratio.
    chosen = CONFIG["ratio_to_use"]
    chosen = "median_daily" if chosen == "median" else chosen
    ratio = r[chosen]
    daily = harmonize(daily, ratio)
    print(f"\nWe use the '{chosen}' ratio: {ratio:.2f}  "
          f"(change 'ratio_to_use' in CONFIG to try another)")

    show = daily[["date", "modis_raw", "viirs_raw", "modis_harmonized"]].copy()
    show["date"] = show["date"].dt.strftime("%Y-%m-%d")
    show["viirs_raw"] = show["viirs_raw"].astype(str).where(
        daily["viirs_has_data"], "no data")
    print(show.to_string(index=False))

    # ----- Step 6 -----
    print("\n\nSTEP 6. EXPORT")
    paths, summary = export(modis, viirs, modis_clean, viirs_clean, report,
                            daily, r, chosen)
    for p in paths:
        print(f"Wrote {p.relative_to(ROOT)}  ({p.stat().st_size / 1024:.1f} KB)")
    print(f"Map points in JSON: {len(summary['points'])}")


# This line means: run main() only when we start this file directly.
if __name__ == "__main__":
    main()
