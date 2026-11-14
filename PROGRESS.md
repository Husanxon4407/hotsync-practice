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
