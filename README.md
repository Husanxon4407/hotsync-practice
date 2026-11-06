# HotSync practice app

Team Capella · NASA Space Apps 2026 · Challenge: "Harmonization of MODIS and VIIRS Hot Spots"

A practice app that makes MODIS and VIIRS fire counts fair to compare, for Uzbekistan, July 2025
(data from [NASA FIRMS](https://firms.modaps.eosdis.nasa.gov/)).

**Live site:** https://husanxon4407.github.io/hotsync-practice/

## What it does

1. **Load** the MODIS and VIIRS CSV files (`data/raw/`).
2. **Clean**: keep vegetation fires (`type == 0`), remove low confidence, and remove two
   factories (fixed hot places) that look like fires every day.
3. **Make fair**: find the VIIRS ÷ MODIS "exchange rate" (≈ 4.07, from days when both saw fires)
   and convert MODIS into "VIIRS-like" numbers.
4. **Show**: map, daily chart, burning calendar, table and CSV download.

## Run it yourself

```
python -m venv .venv
.venv\Scripts\activate          # Windows (macOS/Linux: source .venv/bin/activate)
pip install -r requirements.txt
python process.py               # makes data/processed/*.csv and web/data/summary.json
python -m http.server 8000      # then open http://localhost:8000/web/
```

See `SPEC.md` for the full plan. This is a practice app; the real project is written again at the hackathon.
