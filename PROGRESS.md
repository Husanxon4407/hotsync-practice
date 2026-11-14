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


## 2026-11-14 ~21:00 · Stage 5: science, story and trust
- Team decisions: keep the Terra-only rate on 2012–2025 (tested 2012–2019: <2% change); old prototype files deleted (still in git history).
- Proof chart (2012–2025 MODIS raw, VIIRS raw, rate × MODIS) + hidden-years numbers; "this month vs normal" bar chart with median and 25–75% band.
- NASA GIBS picture layer (MODIS Terra 7-2-1 / VIIRS NOAA-20 from 2018-01-05), date picker; calendar click sets the 15th of the month.
- Case study button "Chilecito fire, July 2026": Argentina, box -69.7,-31.9,-65.4,-27.6, GIBS 7-2-1 of 2026-07-28, squares hidden, CONAE caption. Red-orange burned land visible west of Chilecito.
- How HotSync works (country cleaning funnel, 12-month rate table with Terra-only, validation), Limits, Data & Sources with the exact FIRMS acknowledgement.
- Accessibility: muted text 5.2:1, dark-mode button colour 5.3:1, anomaly text colours fixed, line patterns (dotted/solid/dashed), aria-labels on charts and Geoman buttons.


## 2026-11-14 ~23:30 · Stage 5 update: every place treated the same (team decision)
- **Removed** the Chilecito/Argentina case study (it came from a learning video, not from the official challenge) and the CONAE caption/link.
- **Removed** the Uzbekistan/Argentina-only fire-dot files (`web/data/points/`, −221 MB). `web/data` is now **271 MB** (under the plan's 300 MB).
- **New first view: World** (`web/data/country/world.json`, 2° squares, 16.7 MB): all 234 countries added together, each with its own exchange rates.
  World hidden-years test: 2.2% error, r = 0.986. Rebuild only the world: `python process_all.py --world`.
- **New: fire dots for the whole planet, any day since Nov 2000** (MODIS) / Jan 2012 (VIIRS), from NASA GIBS WMS (nothing stored by us).
  Buttons: 1 day / 3 days / 7 days / 1 month, ◀ ▶ to move, MODIS (orange) and VIIRS (purple) on/off; calendar click shows that month.
  These dots are NASA pictures (raw, not cleaned) and can't be clicked; clickable live dots come in Stage 6.

- Added a "Real fire numbers" row (like the first prototype): MODIS / VIIRS real detections after cleaning, busiest day (click → day view), fire strength (average FRP per detection).
- Sharing: team decided to follow the plan and share the live site later (nothing pushed yet; GitHub still shows the old prototype). Note: Stage 6's robot runs on GitHub, so the branch will need to be pushed then (ask first).

---
## WHERE WE STOPPED (2026-11-14 ~23:30) — read this first after a restart
**Done:** Stages 0–5 (+ the "every place the same" update), all committed on branch `full-history`. **Next:** Stage 6 (2026 data + GitHub robot every 6 h + live fires) — waiting for the team to type `go`.

**Remember for Stage 6:**
- Do NOT rewrite the big country JSON files every 6 h (git history would grow ~1 GB/day). Proposal: keep 2026 in small separate files (e.g. `web/data/recent/`) and merge them in the browser; the robot only commits those small files. The World file must get 2026 too (sum of countries).
- Live layer (last 48 h, clickable dots) for the WHOLE world, the same for every place.
- `.env` has FIRMS_MAP_KEY (never print or commit it). The team must add the same key as a GitHub secret `FIRMS_MAP_KEY`.
- S-NPP VIIRS stopped 2026-11-02 → NOAA-20 after that. Static cells list for the robot: `data/static_cells.csv`. Country polygons: `data/countries.geojson` (`countries.assign_country`).
- Every place is treated the same: no "showcase" countries anywhere.

**How to look at the site:** `cd web` → `..\.venv\Scripts\python -m http.server 8000` → http://localhost:8000
