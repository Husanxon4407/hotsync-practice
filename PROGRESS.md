# HotSync progress log

If the chat restarts: read `HOTSYNC_PLAN.md` and this file first.

## 2026-11-14 ~15:40 (Asia/Tashkent) · Before Stage 0: raw data download
- `download_firms.py` downloaded all 40 FIRMS yearly zips (MODIS 2000–2025, VIIRS S-NPP 2012–2025)
  to `D:\hotsync_data\data_raw`: 6.96 GB, 150 min, 2 dropped connections recovered by retry.
- Every zip passed `zipfile.testzip()` (no broken files).
- 2026 yearly zips do not exist (year not finished); 2026 will come from the FIRMS API in Stage 6.

## 2026-11-14 ~16:00 · Stage 0: setup and repo review
- Created branch `full-history`, a `.venv` with pandas, numpy, pyarrow, matplotlib (`requirements.txt`).
- Added `config.py` (all D: paths in one place) and created `data_raw\2026`, `data_work`, `checks` on D:.
- `.gitignore` now ignores `.env`, `firms_key.txt`, `*.part`, `*.parquet`, `data_raw/`, `data_work/`.
- `download_firms.py` now reads its folder from `config.py`.
- Copied the logo into `web/assets/` so the site works when served from `web/` (it used `../assets/` before).

## 2026-11-14 ~16:30 · Stage 1: check the raw data
- New `check_data.py`: 40/40 zips OK (MODIS 26, VIIRS 14), 6.96 GB, no missing or broken files.
- Zip pattern `modis/<Y>/modis_<Y>_<Country>.csv` and `viirs-snpp/<Y>/viirs-snpp_<Y>_<Country>.csv`;
  VIIRS columns = MODIS columns but `bright_ti4`/`bright_ti5` instead of `brightness`/`bright_t31`.
- 233 MODIS / 236 VIIRS country names (232 in both). No 2026 files yet (expected, Stage 6).
- `download_firms.py` now validates each zip with `zipfile.is_zipfile`. README has the AI disclosure.
- **Decision for Stage 2:** also store the sum of fire power (FRP) per cell per month (team approved).

## 2026-11-14 ~17:30 · Stage 2: process Uzbekistan and check the science
- New `countries.py` (+ `data/countries.geojson`, Natural Earth 1:50m, 236 shapes with FIRMS names; `assign_country(df)` for world files).
- New `process_all.py --country/--all`: load from zips → clean → 0.1° grid (+ FRP sums) → monthly rates → H → validation → JSON + dots + check image.
- **Team decisions:** static places also = any single year with ≥10 hot months, plus a ring of 8 neighbour squares (catches a new factory at 38.05N 67.27E);
  Nov 2000–Jun 2002 (Terra only) use a separate Terra-only rate.
- Uzbekistan: rates 3.1–9.1 (high May–Sep), hold-out error 18.8%, r = 0.934, bias +16.3%, LOYO 20%. July 2025: MODIS 232 / VIIRS 833 (prototype 225 / 807).
- Outputs: `web/data/country/uzbekistan.json` 0.86 MB, `web/data/points/uzbekistan/` 8.8 MB, `D:\hotsync_data\checks\uzbekistan.png`.

## 2026-11-14 ~17:40 · Stage 3: process all countries
- `process_all.py` rewritten to work **year by year** (pass A: clean + save each year as parquet in data_work; pass B: drop static places, add up counts), so big countries fit in 7.8 GB RAM. Uzbekistan results identical to Stage 2.
- 237 FIRMS countries → **234 country JSON files** (3 had no data). Squares: 0.1° for 183 countries, 0.25° for 51 big ones (plan rule; never coarser).
- **Global median rate 4.36** (from 171 countries; Terra-only 10.63); **63 small countries use it**.
- Written: `web/data/countries.json`, `web/data/rates_summary.csv`, `data/static_cells.csv` (4,519 squares, for the Stage 6 robot), 5 check images in `D:\hotsync_data\checks`.
- `web/data` = 488 MB (plan said 300 MB; **team decided to keep it**: GitHub Pages limit is 1 GB, biggest file 26 MB).
- Fixed: every country timeline now runs to 2025-12 (65 small countries used to stop at their last fire).
- **Stage 6 warning:** don't rewrite the big country files every 6 h (git history would grow ~1 GB/day); keep 2026 in small separate files.

## 2026-11-14 ~19:30 · Stage 4: website core
- New `web/index.html` + `web/app.js` (rewritten) + `web/style.css` (prototype look kept). CDN: Leaflet 1.9.4, Leaflet-Geoman 2.17.0, Turf 7.1.0, Chart.js 4.4.1, PapaParse 5.4.1.
- Searchable country picker (234 countries, loads `country/<slug>.json` only when chosen, cached), month-to-month date range.
- Map: squares (log colour scale), draw box/shape (Geoman) or type a lat/lon box → selection = squares whose centre is inside; click square → numbers; fire dots for Uzbekistan/Argentina (orange MODIS #E66100, purple VIIRS #5D3A9B) for ≤3 months, clickable.
- Burning calendar years × months: Harmonized | Raw MODIS | Raw VIIRS | Anomaly (vs 2001–2025 median), number in each cell, gap/Terra-only marks; click → map month.
- Cards (total, busiest month, top 3 years, latest month vs normal + rank), auto summary sentence, day view + 30-day chart, monthly CSV, dots CSV (showcase) / FIRMS link.
- Tested in Chrome: Uzbekistan, Brazil, UK, Argentina; box + drawn rectangle; dots; phone width (390 px, no sideways scroll); light/dark; no console errors.

---
## WHERE WE STOPPED (2026-11-14 evening) — read this first after a restart
**Done:** Stages 0–4 (all committed on branch `full-history`). **Next:** Stage 5 (science, story and trust) — waiting for the team to type `go`.

**Open questions for the team (answer before / at the start of Stage 5):**
1. **Terra-only rate window:** Uzbekistan's top 3 years are 2002 · 2001 · 2004 — 2001–2002 are the Terra-only years. The Terra-only rate may be too high because it is learned on 2012–2025 and Terra's orbit has drifted since 2020 (fewer Terra detections). Proposal: learn it on 2012–2019 only. Not changed yet.
2. **Old prototype files** no longer used by the site: `web/data/summary.json`, `process.py`, `data/processed/`, `data/raw/`, `DL_FIRE_*` folders. Delete or keep? (Plan: ask before deleting.)

**Remember for later stages:**
- Stage 6: do NOT rewrite the big country JSON files every 6 h (git history would grow ~1 GB/day). Keep 2026 in small separate files and merge in the browser.
- `web/data` is 488 MB (plan said 300 MB); the team decided to keep it (GitHub Pages limit 1 GB, biggest file 26 MB).
- Stage 5 "Limits" section should mention: Djibouti rate 0 (MODIS hot ground), Iceland 11.9 (lava), Libya 11.7 (gas flares left), Switzerland 1.2 (few fires); Terra-only rate is the least certain part.
- Team decisions so far: new-factory static rule (≥10 months in one year) + ring of 8 neighbour squares; Terra-only rate before Jul 2002; FRP sums stored; sizes 0.1° / 0.25° only.

**How to look at the site:** `cd web` → `..\.venv\Scripts\python -m http.server 8000` → http://localhost:8000
