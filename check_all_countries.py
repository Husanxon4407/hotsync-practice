"""
HotSync: check_all_countries.py

Checks every country file (+ World) and the current-year files, and reports
problems per country:
    - months with null or negative values (VIIRS may be null before 2012-01)
    - a missing exchange rate, or a rate of 0 / below 0
    - "proof %": harmonized MODIS (rate x MODIS) / real VIIRS over
      2012-02..2025-12 (100% = the lines in the proof chart match)
    - current year: negative numbers, missing days, NOAA-20 days

It only READS files. Run:
    .venv\\Scripts\\python check_all_countries.py
A CSV with one row per country goes to D:\\hotsync_data\\checks (or here).
"""

import json
import sys
from pathlib import Path

import pandas as pd

REPO = Path(__file__).parent
COUNTRY_DIR = REPO / "web" / "data" / "country"
RECENT_DIR = REPO / "web" / "data" / "recent"
VIIRS_FIRST_MONTH = "2012-01"
PROOF = ("2012-02", "2025-12")
AQUA_START = "2002-07"


def bad_months(c):
    """Months with null or negative numbers (VIIRS null before 2012 is fine)."""
    out = []
    t, months = c["totals"], c["months"]
    for key in ("modis", "viirs", "harmonized", "frp_modis", "frp_viirs"):
        for m, v in zip(months, t.get(key, [])):
            if v is None:
                if key in ("viirs", "frp_viirs") and m < VIIRS_FIRST_MONTH:
                    continue
                out.append(f"{key} {m} null")
            elif v < 0:
                out.append(f"{key} {m} = {v}")
    return out


def bad_rates(c):
    out = []
    for table in ("rates", "rates_terra"):
        rates = c.get(table) or {}
        for k in range(1, 13):
            r = rates.get(str(k))
            if r is None or r.get("rate") is None:
                out.append(f"{table} month {k} missing")
            elif r["rate"] <= 0:
                out.append(f"{table} month {k} = {r['rate']}")
    return out


def proof_pct(c):
    """Harmonized MODIS / real VIIRS over 2012-02..2025-12, in %."""
    t, h, v = c["totals"], 0.0, 0.0
    for m, mo, vi in zip(c["months"], t["modis"], t["viirs"]):
        if PROOF[0] <= m <= PROOF[1] and mo is not None and vi is not None:
            h += c["rates"][str(int(m[5:7]))]["rate"] * mo
            v += vi
    return round(h / v * 100, 1) if v else None


def load_recent():
    """{slug: (negatives, total days)} + the list of missing / NOAA-20 days."""
    meta_file = RECENT_DIR / "meta.json"
    if not meta_file.exists():
        return {}, {}, "no current-year files"
    meta = json.loads(meta_file.read_text())
    per, info = {}, {}
    for year in meta.get("years", []):
        f = RECENT_DIR / str(year) / "daily.json"
        if not f.exists():
            info[year] = "daily.json MISSING"
            continue
        d = json.loads(f.read_text())
        info[year] = (f"{d['n_days']} days, missing {len(d.get('missing_days', []))}, "
                      f"NOAA-20 {len(d.get('noaa20_days', []))}, "
                      f"sources {len(d.get('sources', {}))}/{d['n_days'] - len(d.get('missing_days', []))}")
        for slug, arr in d["countries"].items():
            neg = sum(1 for k in ("m", "v", "fm", "fv") for x in arr[k] if x is not None and x < 0)
            lens = {len(arr[k]) for k in ("m", "v", "fm", "fv")}
            p = per.setdefault(slug, {"neg": 0, "len_ok": True})
            p["neg"] += neg
            p["len_ok"] &= lens == {d["n_days"]}
    return per, info, f"last day {meta.get('last_day_with_data')}, last complete {meta.get('last_complete_day')}"


def main():
    files = sorted(COUNTRY_DIR.glob("*.json"))
    if not files:
        sys.exit(f"No country files in {COUNTRY_DIR}")
    recent, info, recent_note = load_recent()
    rows = []
    for f in files:
        c = json.loads(f.read_text(encoding="utf-8"))
        months, rates = bad_months(c), bad_rates(c)
        r = recent.get(c["slug"])
        rows.append({
            "country": c["name"], "slug": c["slug"], "rate_source": c.get("rate_source"),
            "bad_months": len(months), "bad_months_examples": "; ".join(months[:3]),
            "rate_problems": "; ".join(rates[:3]) + (" ..." if len(rates) > 3 else ""),
            "proof_pct": proof_pct(c),
            "recent_negative": r["neg"] if r else 0,
            "recent_lengths_ok": r["len_ok"] if r else True,
        })
    df = pd.DataFrame(rows)

    print(f"Checked {len(df)} files (+ current year: {recent_note})")
    for y, txt in info.items():
        print(f"  {y}: {txt}")
    bad = df[df["bad_months"] > 0]
    print(f"\nMonths with null/negative values: {len(bad)} countries")
    if len(bad):
        print(bad[["country", "bad_months", "bad_months_examples"]].head(15).to_string(index=False))
    rp = df[df["rate_problems"] != ""]
    print(f"\nRate missing or <= 0: {len(rp)} countries")
    if len(rp):
        print(rp[["country", "rate_source", "rate_problems"]].head(20).to_string(index=False))
    p = df["proof_pct"].dropna()
    print(f"\nProof % (100 = match): median {p.median():.1f}, 25-75% {p.quantile(.25):.1f}-{p.quantile(.75):.1f}")
    far = df[(df["proof_pct"] < 80) | (df["proof_pct"] > 125)]
    print(f"Outside 80-125%: {len(far)} countries (few fires or unusual rates)")
    if len(far):
        print(far.sort_values("proof_pct")[["country", "rate_source", "proof_pct"]].to_string(index=False))
    rn = df[(df["recent_negative"] > 0) | (~df["recent_lengths_ok"])]
    print(f"\nCurrent year: negative numbers or wrong lengths: {len(rn)} countries")
    if len(rn):
        print(rn[["country", "recent_negative", "recent_lengths_ok"]].to_string(index=False))

    out_dir = Path(r"D:\hotsync_data\checks")
    out = (out_dir if out_dir.exists() else REPO) / "country_check.csv"
    df.to_csv(out, index=False)
    print(f"\nFull table: {out}")


if __name__ == "__main__":
    main()
