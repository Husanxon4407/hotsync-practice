"""
HotSync: home_summary.py

Writes web/data/home-summary.json: the few world numbers the home page shows
(web/index.html). It is small, so the home page loads fast and never needs the
big map files.

Every number uses THE SAME RULES as the map page (web/app.js), so the home
page and the map's World view always agree:
  - months: the history file (data/country/world.json) + the current year from
    web/data/recent/<year>/daily.json (like mergeRecent in app.js: a new month
    = the sum of its days, VIIRS = fair count from 2012 on)
  - "Fires since 2001": fair count of all months from 2001-01 to today
    (= the "Fires (fair count)" card of the World view, default dates)
  - busiest year = top of the "Top 3 years" card (full years only)
  - busiest month = the "Busiest month" card (average; the unfinished month left out)
  - this year so far: Jan 1 .. last COMPLETE day, vs the same days of each year
    2001-2025; normal = the median (like soFar() in app.js, for a whole year)
  - exchange rate = the badge "1 MODIS fire = X VIIRS fires" (each month's rate,
    weighted by its MODIS fires; Terra-only months use the Terra-only rate)
  - top countries: fair count of the last full year, from each country's file

Run it by hand:   python home_summary.py
The robot (update_recent.py) runs it after every data update.
Only the Python standard library is used.
"""
import json
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent
WEB_DATA = ROOT / "web" / "data"
OUT = WEB_DATA / "home-summary.json"

NORMAL_YEARS = (2001, 2025)      # "normal" = median of these years (app.js)
AQUA_START = "2002-07"           # before this: Terra-only MODIS months (app.js)
FROM_MONTH = "2001-01"           # the map page's default first month


def median(values):
    a = sorted(v for v in values if v is not None)
    if not a:
        return None
    k = len(a) // 2
    return a[k] if len(a) % 2 else (a[k - 1] + a[k]) / 2


def next_month(m):
    y, mo = int(m[:4]), int(m[5:7])
    return f"{y + 1}-01" if mo == 12 else f"{y}-{mo + 1:02d}"


def month_end(m):
    y, mo = int(m[:4]), int(m[5:7])
    nxt = date(y + 1, 1, 1) if mo == 12 else date(y, mo + 1, 1)
    return (nxt - timedelta(days=1)).isoformat()


def load_place(slug, meta):
    """One place's months + totals + daily numbers, with the current year added
    exactly like mergeRecent() in app.js."""
    c = json.loads((WEB_DATA / "country" / f"{slug}.json").read_text(encoding="utf-8"))
    months = list(c["months"])
    tot = {k: list(c["totals"][k]) for k in ("modis", "viirs", "harmonized")}
    daily_h = list(c["daily"]["harmonized"])
    if not meta:
        return c, months, tot, daily_h
    last_day = meta["last_day_with_data"]
    new = []
    m = next_month(months[-1])
    while m <= last_day[:7]:
        new.append(m)
        m = next_month(m)
    dailies = {}
    for y in sorted({int(x[:4]) for x in new}):
        p = WEB_DATA / "recent" / str(y) / "daily.json"
        dailies[y] = json.loads(p.read_text(encoding="utf-8")) if p.exists() else None
    # daily numbers after the history (VIIRS = harmonized from 2012)
    for y, d in dailies.items():
        if d is None:
            last = min(last_day, f"{y}-12-31")
            n = (date.fromisoformat(last) - date(y, 1, 1)).days + 1
            daily_h += [None] * n
            continue
        mine, missing = d["countries"].get(slug), set(d.get("missing_days") or [])
        start = date.fromisoformat(d["days_start"])
        for k in range(d["n_days"]):
            day = (start + timedelta(k)).isoformat()
            daily_h.append(None if day in missing else (mine["v"][k] if mine else 0))
    # monthly totals = the sum of the days of that month
    for m in new:
        d = dailies.get(int(m[:4]))
        mo = vi = have = 0
        if d:
            mine, missing = d["countries"].get(slug), set(d.get("missing_days") or [])
            start = date.fromisoformat(d["days_start"])
            k0 = (date.fromisoformat(m + "-01") - start).days
            k1 = min(d["n_days"] - 1, k0 + int(month_end(m)[8:10]) - 1)
            for k in range(k0, k1 + 1):
                if (start + timedelta(k)).isoformat() in missing:
                    continue
                have += 1
                if mine:
                    mo += mine["m"][k]
                    vi += mine["v"][k]
        months.append(m)
        tot["modis"].append(mo if have else None)
        tot["viirs"].append(vi if have else None)
        tot["harmonized"].append(vi if have else None)
    return c, months, tot, daily_h


def build():
    meta_p = WEB_DATA / "recent" / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else None
    c, months, tot, daily_h = load_place("world", meta)
    h, modis = tot["harmonized"], tot["modis"]

    last_day = meta["last_day_with_data"] if meta else month_end(months[-1])
    last_complete = (meta.get("last_complete_day") if meta else None) or \
        (date.fromisoformat(last_day) - timedelta(days=1)).isoformat()
    in_progress = last_day[:7] if (last_day < month_end(last_day[:7]) or last_complete < last_day) else None

    a = months.index(FROM_MONTH)
    idx = list(range(a, len(months)))

    # 1. Fires since 2001 (fair count, all months up to today)
    total = sum(h[i] or 0 for i in idx)

    # 2. Years: fair count per year; full year = 12 months, none missing or in progress
    years = {}
    for i in idx:
        m = months[i]
        y = years.setdefault(int(m[:4]), {"fair": 0.0, "n": 0, "terra": False})
        if h[i] is not None and m != in_progress:
            y["fair"] += h[i]
            y["n"] += 1
        if m < AQUA_START:
            y["terra"] = True
    full = [(yy, v) for yy, v in years.items() if v["n"] == 12]
    by, bv = max(full, key=lambda t: t[1]["fair"])
    last_full_year = max(yy for yy, _ in full)

    # 3. Busiest month of the year (average; the month in progress is left out)
    sums, counts = [0.0] * 12, [0] * 12
    for i in idx:
        if h[i] is None or months[i] == in_progress:
            continue
        k = int(months[i][5:7]) - 1
        sums[k] += h[i]
        counts[k] += 1
    avgs = [s / n if n else -1 for s, n in zip(sums, counts)]
    bm = max(range(12), key=lambda k: avgs[k])

    # 4. This year so far: Jan 1 .. last complete day, vs the same days of 2001-2025
    day0 = date.fromisoformat(c["days_start"])
    end = date.fromisoformat(last_complete)
    this_year = end.year

    def ytd(year):
        try:
            stop = end.replace(year=year)
        except ValueError:                       # 29 Feb in a year without it
            stop = date(year, 2, 28)
        i0, i1 = (date(year, 1, 1) - day0).days, (stop - day0).days
        if i0 < 0 or i1 >= len(daily_h):
            return None
        return sum(daily_h[i] or 0 for i in range(i0, i1 + 1))

    so_far = ytd(this_year)
    normal = median([ytd(y) for y in range(NORMAL_YEARS[0], NORMAL_YEARS[1] + 1)])
    pct = (so_far - normal) / normal * 100 if normal else None

    # 5. Exchange rate, weighted by MODIS fires (the badge on the map page)
    num = den = 0.0
    plain = []
    for i in idx:
        m = months[i]
        r = (c["rates_terra"] if m < AQUA_START else c["rates"]).get(str(int(m[5:7])))
        rate = r.get("rate") if r else None
        if rate is None:
            continue
        plain.append(rate)
        mo = modis[i] or 0
        num += rate * mo
        den += mo
    rate = num / den if den else (sum(plain) / len(plain) if plain else None)

    # 6. Top countries in the last full year (fair count, from each country file)
    names = json.loads((WEB_DATA / "countries.json").read_text(encoding="utf-8"))
    tops = []
    for row in names:
        if row["slug"] == "world":
            continue
        cc = json.loads((WEB_DATA / "country" / f"{row['slug']}.json").read_text(encoding="utf-8"))
        fair = sum(v or 0 for m, v in zip(cc["months"], cc["totals"]["harmonized"]) if m.startswith(str(last_full_year)))
        tops.append({"slug": row["slug"], "name": row["name"], "fair": round(fair)})
    tops.sort(key=lambda t: -t["fair"])

    out = {
        "updated": meta.get("last_updated") if meta else None,
        "dataTo": last_day,
        "world": {
            "fromYear": int(FROM_MONTH[:4]),
            "toYear": int(months[-1][:4]),
            "lastFullYear": last_full_year,
            "totalFair": round(total),
            "busiestYear": {"year": by, "fair": round(bv["fair"]), "terraOnly": bv["terra"]},
            "busiestMonthOfYear": {"month": bm + 1, "avgFair": round(avgs[bm]), "years": counts[bm]},
            "thisYear": {"year": this_year, "fairSoFar": round(so_far or 0),
                         "normalSameDays": round(normal) if normal else None,
                         "pct": round(pct, 1) if pct is not None else None, "toDate": last_complete},
            "exchangeRate": round(rate, 2) if rate is not None else None,
            "years": [{"year": yy, "fair": round(v["fair"]), "terraOnly": v["terra"], "partial": v["n"] < 12}
                      for yy, v in sorted(years.items())],
        },
        "topCountries": {"year": last_full_year, "items": tops[:5]},
    }
    text = json.dumps(out, ensure_ascii=False, separators=(",", ":"))
    if not OUT.exists() or OUT.read_text(encoding="utf-8") != text:
        OUT.write_text(text, encoding="utf-8")
    return out


if __name__ == "__main__":
    o = build()
    w = o["world"]
    print(f"Wrote {OUT.relative_to(ROOT)}: {w['totalFair']:,} fires since {w['fromYear']}, "
          f"busiest year {w['busiestYear']['year']}, this year {w['thisYear']['pct']}% vs normal, "
          f"rate {w['exchangeRate']}, top: {', '.join(t['name'] for t in o['topCountries']['items'])}")
