# HotSync: build plan for Claude Code (NASA Space Apps 2026)

You are helping team **Capella** (Tashkent, Uzbekistan) finish **HotSync** for the NASA Space Apps 2026 challenge
**"Harmonization of MODIS and VIIRS Hot Spots"**. Our goal is to **win**: correct science, a polished site, and a clear story.

- **Hard deadline:** Sunday 15 Nov 2026, 23:59 Asia/Tashkent.
- The site must be working and pushed by **Sunday 17:00**.
- The owner is a student. Explain everything in **simple English**, and write clear code comments.
- **Simple and working beats fancy and broken.** Finish the core stages before any extras.

---

## RULES (read first, follow always)

1. **One stage at a time.** Do only the stage I ask for. When it is finished, stop and write a report with exactly these 4 parts:
   - **What I did:** short bullets in simple English.
   - **Files changed:** the list of files.
   - **How to test it:** numbered steps I can do myself, and what I should see if it works ("Expected: …").
   - **Problems / decisions:** anything that went wrong, anything you decided for me, and anything I must do by hand.

   Then **wait** until I type `go` (or give feedback).
2. Keep a file `PROGRESS.md` in the repo. After every stage, add the date/time, the stage number, and a 3–5 line summary.
   If our chat restarts, read `PROGRESS.md` and this plan first.
3. **Git:**
   - Work on the branch `full-history`.
   - Commit at the end of each stage, with a message like `Stage 2: Uzbekistan processing`.
   - Don't push to `main` until Stage 8.
   - Ask before deleting any file.
4. **Never commit** big raw data, `.env`, or any API key.
5. **Data folders** (outside the repo, on drive D:):
   - Raw downloads: `D:\hotsync_data\data_raw` (2026 files go in `D:\hotsync_data\data_raw\2026`)
   - Working files: `D:\hotsync_data\data_work`
   - Check images: `D:\hotsync_data\checks`

   Put these paths in one small file `config.py` and use it from every script.
6. The website must stay **static** (GitHub Pages): plain HTML/CSS/JS, no backend, no build step, relative paths only.
   Libraries come from a CDN.
7. **Python:** `pandas`, `numpy`, `pyarrow` and `matplotlib` (for the check images). Install them if missing and list them in `requirements.txt`.
   Read zip files directly with `zipfile`; never unzip everything to disk.
8. **AI disclosure is required by the hackathon rules.** In `README.md`, say the code was written with help from AI (Claude Code).
   The idea and the method choices are the team's.
9. **No NASA logo** anywhere on the site.

---

## WHAT THE CHALLENGE WANTS (keep this in mind)

- MODIS (Terra/Aqua, from Nov 2000, 1 km pixels) and VIIRS (from 20 Jan 2012, 375 m pixels) both detect fire "hotspots".
  But VIIRS sees many more, because it is sharper, so the raw counts can't be compared over time.
- **Part 1, harmonization:** make one consistent monthly time series, where "which satellite saw it" no longer matters.
- **Part 2, web app:** the user selects an area and dates, sees a **burning activity calendar** (years × months, colour = hotspot count) from the early 2000s to now,
  compares the current month with the **historical median**, and downloads **CSV** files.
- The challenge also suggests:
  - an interactive map with a drawn area or a lat/lon input
  - accessible colour ramps
  - anomalies against multi-year averages
- **Judges score:** Impact, Creativity, Validity (scientific and works), Relevance (NASA data at the core), and Presentation.
- **Our method, the "exchange rate":** in the overlap years 2012–2025, learn VIIRS ÷ MODIS for each calendar month, then convert
  the MODIS-only months into "VIIRS-equivalent hotspots". Then prove it works with a hold-out test.
- **Suomi NPP VIIRS stopped on 2 Nov 2026.** NOAA-20 VIIRS (the same sensor) continues after that.
- **Scope:** every country (choose a country, or draw an area inside it). Showcase countries with real historical dots: **Uzbekistan** and **Argentina**.
  Argentina matters because the challenge author (CONAE) used the Chilecito, La Rioja fire of July 2026 as her example.

The current repo has a prototype: `process.py`, `web/index.html`, `web/style.css`, `web/app.js` and `web/data/summary.json`.
It covers Uzbekistan, July 2025 only, using Leaflet 1.9.4 and Chart.js 4.4.1. Reuse its look and its good ideas:
the cleaning steps shown to the user, the "exchange rate" wording, and the "How HotSync works" box.

---

## STAGE 0: Setup and repo review

- Read the whole repo. Explain the current structure and what each file does, in 5–10 simple lines.
- Create the branch `full-history`.
- Create `config.py` with the D: paths (Rule 5). Create the folders if they don't exist.
- Update `.gitignore`: `.env`, `__pycache__/`, `*.part`, `*.parquet`, `data_raw/`, `data_work/`.
- Create `requirements.txt` and `PROGRESS.md`.

**Tests to include in your report:**
- `git branch` shows `* full-history`
- `.gitignore` contains the lines above
- the folders on D: exist
- the old site still opens: `cd web && python -m http.server 8000`, then http://localhost:8000

---

## STAGE 1: Check the raw data

A download script (`download_firms.py`) may already exist and may already have run. If it does not exist, create it:

- Source: `https://firms.modaps.eosdis.nasa.gov/data/country/zips/<NAME>`
  - `modis_<YEAR>_all_countries.zip` for 2000–2025
  - `viirs-snpp_<YEAR>_all_countries.zip` for 2012–2025
- Download to `.part` first, then rename. Skip files that already exist, show progress, and validate each one with `zipfile.is_zipfile`.

Then write `check_data.py`, which:

- lists all the zips in `data_raw` with their sizes, and says clearly which of the expected 26 MODIS + 14 VIIRS files are **missing or broken**
- prints the member name pattern and the CSV columns of one MODIS zip and one VIIRS zip
  - The MODIS pattern is known: `modis/2000/modis_2000_Uzbekistan.csv`, columns `latitude,longitude,brightness,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_t31,frp,daynight,type`.
  - Verify the VIIRS pattern and columns yourself.
- checks `data_raw\2026` for optional 2026 world CSV files from the FIRMS Archive (`fire_archive_*.csv` and `fire_nrt_*.csv` for MODIS, VIIRS S-NPP and VIIRS NOAA-20).
  It prints which ones are present, with their row counts and columns. **It's OK if they are missing.**
  2026 will mainly come from the API backfill in Stage 6, and Stages 2–5 must work with history ending in 2025.

**Tests to include:** run `python check_data.py`. Expected: 40 files OK, total about 7 GB, headers printed, and the 2026 status shown.

---

## STAGE 2: Process ONE country (Uzbekistan) and check the science

Write `process_all.py` with `--country <Name>` (one country) and `--all`. In this stage, run **Uzbekistan only**.

### Steps for each country

1. **Load.** Go year by year: read that country's MODIS and VIIRS CSVs from the zips.
   - **World files** (the optional 2026 archive files, and later the Stage 6 API data) have no country column.
     Assign each point to a country with **country polygons**, not bounding boxes, because boxes overlap and would count fires twice:
     - Use a Natural Earth admin-0 GeoJSON (1:50m is enough), saved once in `data/countries.geojson`.
     - Use `geopandas`/`shapely`, or a fast point-in-polygon method.
     - Make the country names match the zip file names (e.g. `United_Kingdom`). Print any names that don't match.
     - Put this in one reusable function `assign_country(df)`, because Stage 6 uses it too.
   - 2026 NRT rows may have **no `type` column**. Handle that.
   - Design the code so that **new days can be added later without reprocessing 2000–2025**: keep the history aggregates in `data_work`, and merge "recent" data on top (Stage 6).
2. **Clean, in this order.** Record how many rows each step removes, per sensor.
   1. Keep `type == 0` (vegetation fire) where the column exists.
   2. MODIS: keep `confidence >= 30`. VIIRS: keep `n` or `h` (case-insensitive).
   3. **Remove "always hot" places** (factories, gas flares, power plants):
      - Use about 1 km cells: `round(lat, 2)`, `round(lon, 2)`, both sensors together.
      - A cell is static if it has detections in **8 or more different months of one year**, in **3 or more different years**.
      - Drop all points in static cells, and save the static cells list.
   4. VIIRS: use S-NPP until 2026-11-02, then NOAA-20 for later dates (2026 file only).
3. **Grid.** Cell = 0.1° (`i = floor(lat*10)`, `j = floor(lon*10)`, key `"i_j"`). Count per cell per month (`YYYY-MM`) for MODIS and VIIRS.
   For very large countries, if the output would be more than 3 MB, use 0.25° cells and store `cell_size`.
4. **Exchange rates.**
   - Use the overlap months **2012-02 … 2025-12**. Skip 2012-01, because S-NPP started on 20 Jan.
   - For each calendar month m = 1..12, compute ratio = VIIRS_total ÷ MODIS_total for every year where MODIS_total ≥ 10.
   - `rate_m` = median of those ratios. Also store `q25`, `q75` and `n_years`.
   - **Fallbacks:**
     - If `n_years < 3`, use the country's pooled median of all its valid monthly ratios.
     - If the country has fewer than 6 valid ratios in total, use the **global median rate** and mark `rate_source: "global"`.
       In this stage, use a placeholder of 3.5 and recompute it properly in Stage 3.
5. **Harmonized value H.**
   - Months **before 2012-02**: `H = rate_m × MODIS`
   - Months **from 2012-02**: `H = VIIRS`

   Apply this per cell too. Round H to 1 decimal.
6. **Validation (the "hide the answer" test).**
   - Learn the rates from 2015–2025 only.
   - Predict the VIIRS monthly totals for 2012-02 … 2014-12 from MODIS, and compare with the real VIIRS.
   - Store:
     - the median absolute % error (months with VIIRS ≥ 10)
     - Pearson r
     - the total bias %
   - Also do **leave-one-year-out** for 2012–2025 if it's fast. Store the mean error.
7. **Known MODIS gaps.** Mark months `2001-04`, `2001-06`, `2001-07` and `2002-03` as partial.
8. **Daily totals** (extra, small). For each day from 2000-11-01, store the country's MODIS, VIIRS and harmonized daily counts as compact arrays.
   Harmonized daily uses `rate_m` before 2012-02.

### Outputs (compact JSON, no spaces) in `web/data/`

- `country/<slug>.json` containing:
  - `name`, `slug`, `bbox [w,s,e,n]`, `cell_size`
  - `months` (from 2000-11 to the last month)
  - `totals {modis, viirs, harmonized}`
  - `rates {"1":{rate,q25,q75,n}, …}`, `rate_source`
  - `validation`, `cleaning` (the step counts), `static_cells` (count and up to 50 locations), `partial_months`
  - `days_start`, `daily {modis, viirs, harmonized}`
  - `cells {"i_j": [[monthIndex, modis, viirs, H], …]}` (non-zero months only)
- **Points, for showcase countries only** (Uzbekistan, Argentina):
  - `points/<slug>/<year>.csv` with columns `lat,lon,date,time,sensor,confidence,frp`
  - round lat/lon to 4 decimals

### Check image

Save a check image `D:\hotsync_data\checks\<slug>.png` with 3 panels:

- (a) monthly lines 2001–2026: raw MODIS, raw VIIRS, harmonized
- (b) the 12 monthly rates with q25–q75 bars
- (c) the validation scatter: predicted vs real VIIRS

**Tests to include:**
- the cleaning table
- the 12 rates (these should look sensible: mostly between 1 and 10, and higher in the summer/autumn farm-burning months)
- the validation numbers
- the JSON file size
- the path of the check image to open
- a comparison with the prototype: for July 2025 it had MODIS 225 and VIIRS 807 after cleaning. Our numbers should be the same size; explain any difference.
- whether the Angren area (about 41.0 N, 70.1 E) is among the static cells (it should be)

---

## STAGE 3: Process ALL countries

- Run `--all`, year by year, so memory stays low. Save intermediate parquet files in `data_work`.
- Compute the **global median rate** from the countries with good data, then redo the fallback countries.
- Write:
  - `web/data/countries.json`: `[{name, slug, bbox, total_H, rate_avg, validation_error}]`, sorted by name, skipping countries with no hotspots
  - `web/data/rates_summary.csv`: one row per country with the 12 rates, `rate_source` and the validation numbers (we'll use it in the presentation)
- Save check images for **Uzbekistan, Argentina, United Kingdom, Brazil and Kazakhstan**.
- Print:
  - the number of countries
  - the total size of `web/data` (**must be under 300 MB, and every file under 50 MB**; if not, suggest what to cut)
  - the 10 biggest files
  - the global median rate
  - how many countries used the global rate

**Tests to include:**
- open 3 country JSON files and check the fields exist
- look at the 5 check images
- open `rates_summary.csv` in Excel
- the total size is OK

---

## STAGE 4: Website core (upgrade `web/`)

Keep vanilla JS, Leaflet and Chart.js. Add from CDN: **Leaflet-Geoman** (drawing), **Turf.js** and **PapaParse**. Keep the prototype's style.
It must work on a laptop and a phone.

1. **Top bar:**
   - a searchable country select (from `countries.json`, default Uzbekistan)
   - a date range (from month to month; default 2001-01 to the last month)
2. **Map** (OpenStreetMap base):
   - **Whole-country selection by default.**
   - **Draw a rectangle or polygon** (Geoman), or **type a lat/lon box** (west, south, east, north).
   - The selection = cells whose centre is inside. Drawn areas use the country's rates.
   - Show the cells as coloured squares (sum over the selected months).
   - **Click a square** to see its lat/lon bounds, plus MODIS, VIIRS and harmonized counts for the selected months.
   - **Showcase countries:** a "Show fire dots" toggle with MODIS and VIIRS dots in colour-blind-safe colours (orange `#E66100`, purple `#5D3A9B`) and a legend.
     **Click a dot** to see lat, lon, date, time, satellite, confidence and FRP.
3. **Burning calendar (the main feature):** rows = years 2001 to now, columns = Jan–Dec.
   - Switch: **Harmonized | Raw MODIS | Raw VIIRS | Anomaly**.
   - A colour-blind-safe sequential ramp (YlOrRd or viridis) plus **the number written in each cell**, a hover tooltip, and a legend.
   - Grey = no data. Partial months get a small mark plus an explanation.
   - Click a cell to select that month on the map.
   - **Anomaly mode:** % = (H − median of the same calendar month over 2001–2025) ÷ median × 100. Use a diverging blue–white–red colour-blind-safe ramp. Show "n/a" if the median is 0.
4. **Summary cards:**
   - total harmonized hotspots in the range
   - busiest calendar month (average)
   - top 3 years
   - **latest complete month vs its median** (% difference, plus a rank like "3rd highest October since 2001")
5. **Auto-written summary sentence**, built from the numbers. Example: "In this area, August is usually the busiest month. 2021 had the most fires since 2001. October 2026 was 40% above normal."
6. **Day view:** a date picker. For any day, show the country's daily MODIS, VIIRS and harmonized counts (from `daily`), and a small line chart for the 30 days around it.
   Dots appear only for showcase countries.
7. **Downloads:**
   - CSV of the monthly table for the selection (`Papa.unparse`)
   - for showcase countries, a CSV of the hotspot points inside the selection and dates
   - for others, a clear link to the FIRMS Archive Download
8. Load `country/<slug>.json` only when the country is chosen, and cache it in memory. Show a loading message.
9. Remove every "(real project)" placeholder label from the prototype.

**Tests to include** (local server):
- choose 3 countries: the calendar changes each time
- each calendar switch works
- draw a rectangle: the numbers get smaller
- type a lat/lon box: it works
- click a square and a dot: the popups show their data
- the CSV opens in Excel
- phone view (browser DevTools → device mode) looks fine
- **the console has no errors**

---

## STAGE 5: Science, story and trust (on the website)

1. **Before/after proof chart:** 2012–2025 monthly lines of raw MODIS, VIIRS and harmonized MODIS (rate × MODIS),
   with the validation numbers ("off by X% on average, r = …").
2. **This month vs normal chart:** the selected month's value, its median, and the 25–75% band, for all years.
3. **Satellite picture layer** (toggle plus date) from NASA GIBS:
   - URL: `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/{LAYER}/default/{YYYY-MM-DD}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg`
   - Set `maxNativeZoom: 9`.
   - Layers: `MODIS_Terra_CorrectedReflectance_Bands721` (burned land looks reddish) and `VIIRS_NOAA20_CorrectedReflectance_TrueColor`.
   - Clicking a calendar cell sets the date to the 15th of that month.
4. **Case study button: "Chilecito fire, July 2026".**
   - Switches to Argentina, draws the box `-69.7,-31.9,-65.4,-27.6`, and selects July 2026.
   - Turns on GIBS 7-2-1 for 2026-07-28.
   - Caption: "Case study inspired by CONAE (Argentina) emergency maps".
5. **"How HotSync works"** section:
   - the 4 simple steps (Load, Clean, Make fair, Show)
   - this country's cleaning numbers
   - the 12-month exchange-rate table, with a simple explanation ("1 MODIS hotspot = X VIIRS hotspots in July")
   - the validation result
6. **Limits** (honest):
   - no morning VIIRS pass
   - clouds and smoke hide fires
   - small areas are noisy
   - hotspot counts are not burned area
   - recent months use near-real-time data
7. **Data & Sources** section:
   - Links to NASA FIRMS (https://www.earthdata.nasa.gov/data/tools/firms), FIRMS Archive Download (https://firms.modaps.eosdis.nasa.gov/download/),
     NASA GIBS (https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api), and every library used.
   - This acknowledgement, exactly:
     "We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS)."
8. **Accessibility:**
   - contrast at least 4.5:1
   - labels on all controls
   - visible keyboard focus
   - `aria-label`s on charts
   - colour is never the only signal

**Tests to include:**
- the proof chart lines overlap after harmonizing
- the GIBS picture appears on the map for a chosen date
- the case study button jumps to Chilecito and shows the reddish burned area
- all links open

---

## STAGE 6: Keep 2026 growing automatically ("postman" robot) + live fires

2026 is not finished, so the site must **update itself every 6 hours**, even when our laptops are off.
A GitHub Action (a free robot on GitHub's computers) fetches new hotspots from the FIRMS API,
adds them to the 2026 history, and refreshes the live layer.

### Idea in simple words

- **History 2000–2025** is fixed. It was made once on the laptop (Stages 2–3) and never changes.
- **"Recent" data (2026 onward)** is a small, separate store, kept **inside the repo** in an aggregated form (counts, not raw points),
  so the robot can update it without the 7 GB of raw files.
- After each update, the robot **rebuilds only the 2026 part** of every country file and commits the changes.
  The rates from history stay the same. From 2012-02, H = VIIRS anyway.

### 6a. `update_recent.py`: one script with two modes

- **Sources:**
  - `MODIS_NRT` (or `MODIS_SP` when older days are available)
  - `VIIRS_NOAA20_NRT` / `VIIRS_NOAA20_SP`
  - `VIIRS_SNPP_SP` for dates up to 2026-11-02
- **VIIRS rule** (same as Stage 2): S-NPP until 2026-11-02, then NOAA-20. Check `/api/data_availability/csv/{KEY}/ALL` to pick SP or NRT for each date range.
- **API:** `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{KEY}/{SOURCE}/world/{DAYS}/{DATE}`. `DAYS` is at most 5.
  - The rate limit is 5,000 transactions per 10 minutes, and big requests count as more.
  - Add a short sleep between calls, and retry on errors (3 tries, then skip with a warning).
- **`--backfill 2026-01-01`** (run once, on the laptop or in the Action):
  - Fetches 2026-01-01 → today in 5-day chunks, for each source.
  - This replaces waiting for the big Archive request. If the archive files exist in `data_raw\2026`, you may use them instead for those days.
- **`--recent`** (every 6 hours): fetches the **last 3 days** for each source.
- **For every fetched day:**
  1. Clean with the same rules as Stage 2: confidence filter; drop points inside the saved **static cells** list from history.
     Recent NRT rows have no `type` column, so the static list does that job.
  2. Assign countries with `assign_country()` (polygons).
  3. Aggregate to **daily counts per country per 0.1° cell per sensor**.
- **Storage:** `web/data/recent/days/<YYYY-MM-DD>.json` (compact). **Overwrite a day's file each time it's fetched, never add to it.**
  That way, re-fetching a day never double-counts, and NRT data is replaced naturally when better data comes.
- **Then rebuild 2026** in every `country/<slug>.json`:
  - monthly totals, cells, and daily arrays for 2026
  - mark the current month as **"in progress"** (the calendar shows it with a dashed border and "so far" in the tooltip)
  - update `countries.json` totals and `web/data/meta.json` (`last_updated`, `last_day_with_data`)
- Keep `web/data/recent/` small: one file per day, with only cells that have fire. Print the size.

### 6b. Live layer (same run)

- Fetch the last 2 days of `VIIRS_NOAA20_NRT`, `VIIRS_NOAA21_NRT` and `MODIS_NRT` for the world.
- Write `web/data/live/latest.json` as `{updated_at, points:[{lat,lon,sensor,date,time,frp,confidence}]}` (lat/lon rounded to 3 decimals).
- If the file is over 5 MB, keep only nominal/high confidence.

### 6c. `.github/workflows/update.yml`

- Runs on cron `0 */6 * * *` (every 6 hours) and also on manual dispatch, with Python 3.11 and `permissions: contents: write`.
- Installs only what the script needs (keep it fast).
- Runs `python update_recent.py --recent` with the secret `FIRMS_MAP_KEY`.
- Commits **only if files changed**, with a message like `auto: data update 2026-11-15 06:00 UTC`.
- Must finish in under 10 minutes. `countries.geojson` and the static-cells list are committed to the repo, so the robot has them.

### 6d. Website

- A "Live: last 48 h" layer with clickable dots (worldwide).
- An "Updated X hours ago" label, from `meta.json`.
- The 2026 row of the calendar fills up automatically, with the current month shown as "in progress".
- The "this month vs normal" card uses the current month **so far**, compared with the same days of past years.
  Use the daily arrays: for example, Nov 1–14, 2026 vs Nov 1–14 of every year from 2001 to 2025.
  That's a fair comparison for an unfinished month.

### Explain step by step how I

- add the secret: GitHub repo → Settings → Secrets and variables → Actions → New repository secret, named `FIRMS_MAP_KEY`
- run the backfill once (on the laptop with `.env`, then commit; or with a manual workflow run)
- run the workflow by hand and see that it's green

**Tests to include:**
- the backfill finishes and prints the days and rows per source
- `web/data/recent/days/` has files for 2026-01-01 → today
- the Uzbekistan calendar shows 2026 filled up to this month
- running `--recent` twice in a row gives the **same** numbers (no double counting)
- the workflow run is green on GitHub, and it commits only when there's new data
- the live dots appear on the map, and "Updated X hours ago" is correct

---

## STAGE 7: Winning extras (only after Stages 0–6 work; do them in this order and stop when I say)

1. **Shareable links.** The URL remembers the country, area, dates, calendar mode and map layers (e.g. `#c=uzbekistan&from=2001-01&to=2026-10&mode=anomaly`).
   A judge can open the exact view we show in our video.
2. **One-page "Fire report" (print/PDF).** A "Print report" button with a print stylesheet. It prints:
   - the area name, map snapshot, calendar, key cards and summary sentence
   - the sources, and the date generated

   It's useful for emergency managers' meetings.
3. **Exchange-rate world map.** A small choropleth of countries coloured by average rate (from `countries.json` / `rates_summary.csv`). Clicking a country opens it.
   This shows our science at a glance. Use a simple world GeoJSON from a CDN.
4. **Fire-season clock.** A polar chart (Chart.js `polarArea`) of the average harmonized hotspots per calendar month for the selection.
5. **Calendar image download (PNG)**, for reports and social media.
6. **3D globe intro (optional)** with the last 48 h of live hotspots (globe.gl from a CDN), shown in a small hero section or a modal. Great for our video.
7. **English / Uzbek language switch** (a small dictionary object for the main labels).

**Tests:** for each extra, one or two quick checks.

---

## STAGE 8: Final checks, README, deploy, and submission helpers

- Run through all the tests from Stages 4–7. Give me a ✅/❌ checklist, and fix every ❌ that is quick.
- Check speed: the first page load should be under about 3 s on normal internet, and switching countries under 1 s after the first load.
- **`README.md`:**
  - what HotSync is
  - a screenshot
  - how to run `download_firms.py`, `check_data.py`, `process_all.py` and the local server
  - the method (cleaning, exchange rate, validation) in simple words
  - data sources and the acknowledgement
  - the "Built with help from AI (Claude Code)" note
  - the team names: Bekzod, Husanxon, Arzima, Munisa, Odinabonu
- **`SUBMISSION.md`:** draft texts for the Space Apps project page, in simple, natural English (we will edit them):
  - Project Name
  - High-Level Summary (3–4 sentences)
  - Detailed Description (what it does, how it works, benefits, goals, tools)
  - Use of AI (honest)
  - Data & Resources (every dataset, library and image, with links)

  Also include a 30-second video script following the official timeline: 0:00 intro, 0:02 the challenge, 0:05 the name and tagline, 0:10 how it works, 0:20–0:30 the future.
- Tell me step by step how to merge `full-history` into `main`, push, and confirm GitHub Pages shows the new site. Remind me to test it in a private browser window and on a phone.
