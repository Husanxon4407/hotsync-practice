# HotSync

Team Capella · NASA Space Apps 2026 · Challenge: "Harmonization of MODIS and VIIRS Hot Spots"

HotSync makes MODIS and VIIRS fire hotspot counts fair to compare, for every country, from 2000 to now
(data from [NASA FIRMS](https://www.earthdata.nasa.gov/data/tools/firms)).

**Live site:** https://husanxon4407.github.io/hotsync-practice/

## What it does

1. **Load** 25 years of NASA FIRMS fire data (MODIS 2000–2025, VIIRS 2012–2025) for every country.
2. **Clean**: keep vegetation fires (`type == 0`), remove low confidence, and remove "always hot"
   places (factories, gas flares) found automatically.
3. **Make fair**: learn the VIIRS ÷ MODIS "exchange rate" for each calendar month (2012–2025) and
   convert the MODIS-only years into "VIIRS-equivalent" hotspots.
4. **Show**: map, burning calendar (years × months), anomalies, day view and CSV downloads.

## Run it yourself

```
python -m venv .venv
.venv\Scripts\activate                 # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python download_firms.py               # ~7 GB of FIRMS zips (folder set in config.py)
python check_data.py                   # are all 40 zips OK?
python process_all.py --all            # makes web/data/ (country files, list, rates)
cd web
python -m http.server 8000             # then open http://localhost:8000
```

See `HOTSYNC_PLAN.md` for the plan and `PROGRESS.md` for what is done.

## Use of AI

The code was written with help from AI (Claude Code). The idea and the method choices
(cleaning rules, the "exchange rate" harmonization, validation) are the team's.
