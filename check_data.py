"""
HotSync: check_data.py  (Stage 1)

Checks the raw data BEFORE we process it, so we don't build on broken files:
    1. Are all 40 yearly zips there (26 MODIS + 14 VIIRS)? Any missing or broken?
    2. What is inside a zip: file name pattern and CSV columns, MODIS and VIIRS.
    3. Which countries are in the zips (names we must match later).
    4. Optional 2026 world CSV files in data_raw\\2026 (OK if missing).

It only READS files. It never changes or unzips anything.

Run:
    .venv\\Scripts\\python check_data.py           (fast check, ~10 seconds)
    .venv\\Scripts\\python check_data.py --deep    (also tests every byte, ~5 min)
"""

import re
import sys
import zipfile
from pathlib import Path

import config
from download_firms import file_list   # the 40 names we expect

# Columns the plan says MODIS has. We compare, so a change in NASA's format
# is noticed now and not in the middle of Stage 2.
MODIS_COLUMNS = ("latitude,longitude,brightness,scan,track,acq_date,acq_time,"
                 "satellite,instrument,confidence,version,bright_t31,frp,"
                 "daynight,type").split(",")

# FIRMS archive codes in 2026 file names -> sensor name.
# Example: fire_archive_SV-C2_123456.csv = VIIRS S-NPP, standard data.
SENSOR_CODES = {"M-C61": "MODIS", "SV-C2": "VIIRS S-NPP",
                "J1V-C2": "VIIRS NOAA-20"}


def mb(n):
    return f"{n / 1e6:8.1f} MB"


# ---------------------------------------------------------------------------
# 1. Are all the zips there and OK?
# ---------------------------------------------------------------------------
def check_zips(deep):
    print("=" * 70)
    print(f"1. YEARLY ZIPS in {config.DATA_DIR}")
    print("=" * 70)
    ok, missing, broken = [], [], []
    for name in file_list():
        path = config.DATA_DIR / name
        if not path.exists():
            missing.append(name)
            status = "MISSING"
        elif not zipfile.is_zipfile(path):
            broken.append(name)
            status = "BROKEN (not a zip)"
        else:
            status = "OK"
            if deep:
                # testzip() reads every file inside and checks it (CRC).
                # It returns the first bad member's name, or None if all good.
                bad = zipfile.ZipFile(path).testzip()
                if bad:
                    broken.append(name)
                    status = f"BROKEN (bad member {bad})"
            if status == "OK":
                ok.append(name)
        size = mb(path.stat().st_size) if path.exists() else " " * 11
        print(f"  {name:38s} {size}  {status}")

    # Files in the folder that we did NOT expect (e.g. leftovers).
    extra = sorted(p.name for p in config.DATA_DIR.iterdir()
                   if p.is_file() and p.name not in file_list())
    total = sum((config.DATA_DIR / n).stat().st_size for n in ok)

    modis_ok = sum(n.startswith("modis") for n in ok)
    viirs_ok = sum(n.startswith("viirs") for n in ok)
    print(f"\n  OK: {len(ok)}/40  (MODIS {modis_ok}/26, VIIRS {viirs_ok}/14)"
          f"   total {total / 1e9:.2f} GB"
          f"   check: {'deep (every byte)' if deep else 'fast (zip index)'}")
    print(f"  Missing: {missing or 'none'}")
    print(f"  Broken:  {broken or 'none'}")
    if extra:
        print(f"  Other files in folder (not used): {extra}")
    return ok, missing + broken


# ---------------------------------------------------------------------------
# 2 + 3. What is inside one MODIS and one VIIRS zip?
# ---------------------------------------------------------------------------
def country_of(member):
    """'modis/2000/modis_2000_Uzbekistan.csv' -> 'Uzbekistan'."""
    return re.sub(r"^.*_\d{4}_", "", Path(member).stem)


def look_inside(name):
    path = config.DATA_DIR / name
    with zipfile.ZipFile(path) as z:
        members = z.namelist()
        csvs = [m for m in members if m.endswith(".csv")]
        others = [m for m in members if not m.endswith(".csv")
                  and not m.endswith("/")]
        # Open one CSV straight from the zip (no unzipping to disk).
        with z.open(csvs[0]) as f:
            header = f.readline().decode("utf-8").strip().split(",")
            first = f.readline().decode("utf-8").strip()
    print(f"\n  {name}")
    print(f"    members: {len(csvs)} CSV files"
          + (f" + {others}" if others else ""))
    print(f"    pattern: {csvs[0]}")
    print(f"    columns ({len(header)}): {','.join(header)}")
    print(f"    first row: {first}")
    return header, {country_of(m) for m in csvs}


def check_contents(ok):
    print("\n" + "=" * 70)
    print("2. INSIDE THE ZIPS (name pattern and columns)")
    print("=" * 70)
    modis = [n for n in ok if n.startswith("modis")]
    viirs = [n for n in ok if n.startswith("viirs")]
    if not modis or not viirs:
        print("  Need at least one OK MODIS and one OK VIIRS zip.")
        return

    m_cols, _ = look_inside(modis[-1])
    v_cols, _ = look_inside(viirs[-1])

    # MODIS: compare with the columns the plan expects.
    if m_cols == MODIS_COLUMNS:
        print("\n  MODIS columns: same as the plan. OK")
    else:
        print(f"\n  MODIS columns DIFFER from the plan!\n"
              f"    plan: {MODIS_COLUMNS}\n    file: {m_cols}")

    # VIIRS: same order as MODIS, but two columns have other names.
    diff = [(a, b) for a, b in zip(m_cols, v_cols) if a != b]
    print("  VIIRS vs MODIS columns: same order, "
          + ", ".join(f"'{b}' instead of '{a}'" for a, b in diff))

    # ----- 3. countries -----
    print("\n" + "=" * 70)
    print("3. COUNTRIES IN THE ZIPS (all years)")
    print("=" * 70)
    modis_c, viirs_c = set(), set()
    for name in ok:
        with zipfile.ZipFile(config.DATA_DIR / name) as z:
            names = {country_of(m) for m in z.namelist()
                     if m.endswith(".csv")}
        (modis_c if name.startswith("modis") else viirs_c).update(names)
    print(f"  MODIS: {len(modis_c)} countries, VIIRS: {len(viirs_c)} countries,"
          f" both: {len(modis_c & viirs_c)}")
    print(f"  Only in VIIRS: {sorted(viirs_c - modis_c)}")
    print(f"  Only in MODIS: {sorted(modis_c - viirs_c)}")
    for c in ("Uzbekistan", "Argentina"):
        print(f"  Showcase '{c}': MODIS {'yes' if c in modis_c else 'NO'},"
              f" VIIRS {'yes' if c in viirs_c else 'NO'}")


# ---------------------------------------------------------------------------
# 4. Optional 2026 world files
# ---------------------------------------------------------------------------
def check_2026():
    folder = config.DATA_2026_DIR
    print("\n" + "=" * 70)
    print(f"4. OPTIONAL 2026 FILES in {folder}")
    print("=" * 70)
    files = sorted(folder.glob("fire_archive_*.csv")) + \
        sorted(folder.glob("fire_nrt_*.csv")) if folder.exists() else []
    found = set()
    for f in files:
        kind = "archive (standard)" if "archive" in f.name else "NRT"
        code = next((c for c in SENSOR_CODES if f"_{c}_" in f.name), None)
        sensor = SENSOR_CODES.get(code, "unknown sensor")
        found.add((sensor, kind))
        with open(f, encoding="utf-8") as h:
            header = h.readline().strip()
            rows = sum(1 for _ in h)        # count lines without loading all
        print(f"  {f.name}: {sensor}, {kind}, {rows:,} rows, {mb(f.stat().st_size).strip()}")
        print(f"    columns: {header}")
        if "type" not in header.split(","):
            print("    note: no 'type' column -> static-cells list must "
                  "remove factories")
    for sensor in SENSOR_CODES.values():
        for kind in ("archive (standard)", "NRT"):
            if (sensor, kind) not in found:
                print(f"  - {sensor} {kind}: not present")
    print("  This is OK: 2026 mainly comes from the API backfill (Stage 6),")
    print("  and Stages 2-5 work with history ending in 2025.")


def main():
    deep = "--deep" in sys.argv
    ok, problems = check_zips(deep)
    check_contents(ok)
    check_2026()
    print("\n" + "=" * 70)
    print("RESULT: " + ("ALL 40 ZIPS OK" if not problems else
                        f"{len(problems)} PROBLEM FILE(S): run "
                        "download_firms.py again (it re-downloads only those)"))
    sys.exit(1 if problems else 0)


if __name__ == "__main__":
    main()
