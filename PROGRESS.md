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
