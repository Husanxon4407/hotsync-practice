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


## 2026-11-14 ~22:30 · Stage 6 (in progress): current-year robot
- Team decisions: current year in small separate files (history never changes); robot every **48 h**;
  when a year ends, download its yearly FIRMS zips and run process_all.py so it joins the fixed history.
- `update_recent.py` (SP or NRT per day; S-NPP → NOAA-20 after 2026-11-02 and on S-NPP gap days, e.g. early March 2026),
  same cleaning as history, polygons, one file per day in `data/recent_days/` (re-fetch replaces it: no double counting —
  tested), waits when the FIRMS key hits 5000 transactions / 10 min, `--fill-gaps`. A failed download is never saved as 0.
- Website: 2026 joined in the browser, month in progress (so far vs same days of past years), "Updated X ago",
  live 48 h clickable dots (140k dots, 4.7 MB). Workflow `.github/workflows/update.yml` (every 2 days; push trigger for testing).
- Branch `full-history` uploaded to GitHub up to commit 0fa8c9b; commit ed19044 (Stage 6 code) NOT pushed yet.


## 2026-11-14 ~23:30 · Stage 6: robot green on GitHub + review fixes (13 items)
- Robot runs on GitHub: 2 test runs green (42 s, 6 API calls); commits only real changes (fixed Windows/Linux zip bytes).
- 2026 backfill complete and checked (318 days; S-NPP partial days → NOAA-20, e.g. 3 Aug 2026).
- Review fixes (team list of 13):
  1–2 `renderCards()`: last month IN THE RANGE; wording by range length; Top 3 = full years only (≥2), Terra-only years marked "*";
      busiest month without the month in progress; card renamed "Last month in your range vs normal".
  3 `renderHeader()`: exchange rate follows the range, weighted by MODIS (Σ rate×MODIS / Σ MODIS); "Not needed for these dates" from Feb 2012;
      safe for rate 0 (Djibouti) and world-rate countries.
  4 `update_recent.py`: every day gets a source (+ viirs_sat, fetched_at); NOAA-20 → S-NPP factor per country (world factor if < 300 fires),
      learned on 24 days when both flew (`--learn-factor`, `data/noaa20_factor.json`); website marks NOAA-20 days/months.
  5 `last_complete_day` in meta.json (NRT day complete 12 h after it ended); `soFar()` uses complete days only; "(partial day, still loading)".
  6 `picDate()`: picture/dot dates never after yesterday.  7 `onDates()`: boxes show the real order after a swap.
  8 `renderRealStats()`: "(VIIRS starts 20 Jan 2012)" only for ranges before Feb 2012; per-year without the month in progress.
  9 World wording ("Whole world"). 10 `renderProof()`: why not 100% + verdict word. 11 `mergeRecent()`: nulls if a year file fails.
  12 Limits: MODIS orbit drift + NOAA-20 days. 13 `check_all_countries.py`.


## 2026-11-15 ~00:30 · Stage 7, extra 1: shareable links + plain-language pass
- The address bar describes the view: place, dates, calendar view, square view, drawn box/shape, chosen month/day,
  fire dots, live layer, satellite picture, map position. Opening the link shows the same view; "🔗 Copy link" button
  (with a fallback when the clipboard waits); menu links scroll without replacing the link. Tested on the live site
  (Brazil + box + Sept 2020 + dots, round trip after reload, World "vs normal").
- Plain words everywhere: "fair count" (harmonized), "MODIS saw / VIIRS saw" (raw), "vs normal" (anomaly), "Fire calendar";
  new "What is this?" sentence and a "How to use" line; tooltips rewritten.
- index.html loads app.js/style.css with ?v=… (change it on every update) so browsers don't keep old code for 10 min.
- My Chrome automation can open the live https site (not localhost): test there after each upload.


## 2026-11-15 ~00:45 · Stage 8: final checks, README, SUBMISSION, merge to main
- Checks: check_all_countries.py (0 bad months; only Djibouti rate 0, known); 2026: 318/318 days with sources,
  31 NOAA-20 days, last complete day 2026-11-13; live site files all load; World view verified in Chrome.
- README.md rewritten (what, method, run, files, sources + acknowledgement, AI note, team), screenshot assets/screenshot.jpg.
- SUBMISSION.md: project name, summary, description, use of AI, data & resources, 30-second video script.
- `full-history` merged into `main` (fast-forward) and pushed; GitHub Pages switched back to `main`.
- The robot's schedule (every 2 days) is active now that the workflow is on `main`.

---
## HANDOVER (read this first) — 2026-11-15
**Everything is on `main`.** Live site: https://husanxon4407.github.io/hotsync-practice/ (opens on World).

**To work on it:** `git clone https://github.com/Husanxon4407/hotsync-practice.git` (or `git pull` on `main`),
then `cd web` → `python -m http.server 8000` → http://localhost:8000. Only plain Python is needed to view the site.
To re-process data you need the 7 GB of FIRMS zips (`python download_firms.py`) and `pip install -r requirements.txt`.

**After every website change:** bump the version in `web/index.html` (`app.js?v=…`, `style.css?v=…`), so browsers load the new files.

**The robot** (`.github/workflows/update.yml`) runs every 2 days on `main` and needs the secret `FIRMS_MAP_KEY`
(already set). "Run workflow" button: GitHub → Actions → Update fire data. It commits only when data changed.

**Ideas not done yet (Stage 7 extras 3–7, optional):** exchange-rate world map,
fire-season clock, calendar PNG download, 3D globe intro, English/Uzbek switch.
**Year end:** see README "When a year ends".

---
## 2026-11-15 · Speed fix (Stage 8 target: first load < 3 s)
- Problem: world.json was 16.7 MB (6.4 MB compressed), 99% of it map squares month by month.
- Fix: every place is now TWO files: `<slug>.json` (summary + ONE total per square for the first view,
  2001-01 -> latest) and `<slug>.cells.gz` (all squares, packed: number columns + gzip). The page draws from
  the small file; the packed file loads in the background (needed for other dates, a drawn area, a popup).
- No method change: same numbers. Checked: all 235 files unpacked and compared with the old squares (identical);
  quick totals = full squares for all 5,078 World squares; Brazil test box 2019 = old file exactly.
- Turf.js removed (only used for "is the square inside the area?"; now a small function). Libraries load with `defer`.
- First visit (World, compressed): ~7.2 MB -> ~0.86 MB. Switching country: Brazil 8.2 MB -> 168 KB before it shows.
- `python process_all.py --repack` converts old one-file JSONs; normal runs write the two files directly.

---
## 2026-11-15 · Stage 7 extra 2: one-page "Fire report" (print / PDF)
- Button "🖨 Print report" (next to Copy link). Also works with Ctrl+P.
- Report mode = class `report` on <html> (style.css, end of file): always light colours; one A4 page with
  header (place, area, dates, "made" time UTC, data up to), summary + exchange rate, the 8 key cards,
  map (left) + calendar (right), "how to read it", data sources, NASA FIRMS acknowledgement, link to this exact view.
- The button waits for the map pictures (max 4 s) before the print window. Afterwards ("afterprint") the page goes
  back: same theme, same map view. In the report the map fits the area / country / whole world.
- Tests (Chrome): World and Uzbekistan + drawn box, dark theme: page height 967 / 942 px (A4 holds ~1054 px);
  right place/area/dates/numbers; after printing theme dark + map view restored; no console errors.

---
## 2026-11-15 · Control box redesign (phases 1-6, asked by the user before the other Stage 7 extras)
- Phase 1: 3 step boxes (1 Place · 2 Dates · 3 Share), ember top line when a step has a value, small data status with a green dot.
- Phase 2: own place list (`web/js/place-picker.js` + `place-search.js`): World on top then all A-Z, typing filters
  (starts-with first, then contains; no accents; short names USA/UK/UAE/Russia/DRC...), marked letters, arrows/Enter/Esc.
- Phase 3: "Find on globe" (`web/js/globe-picker.js`): globe.gl loaded only on click; borders = our own Natural Earth file
  with FIRMS names (`countries.py --globe` -> `web/data/globe_countries.json`, 179 KB gz), so names always match.
  Hover = name + fires, click = open, names by zoom without overlaps, search flies there, faint fire tint, no-WebGL message.
- Phase 4: dates pop-up (`web/js/date-picker.js`): Start/End labels, quick buttons, years with fire bars, month grid,
  range across years, future months locked, Apply/Reset, Esc/outside; bottom sheet on phones. Links still work.
- Phase 5: "Custom area ✕" only when an area is drawn; "Share this view" + live preview; copy fallback box.
- Phase 6: warm charcoal / warm paper tokens, one ember accent, 4-6 px corners, no glow/blur/gradients/emoji;
  Bricolage Grotesque headings, IBM Plex Mono numbers; contour pattern behind the box; count-up numbers; press-down buttons.
  Data colours (MODIS orange, VIIRS purple, fair-count green, calendar ramp) kept on purpose: they carry meaning.
- Tests (Chrome, laptop + 380 px frame, light + dark): all phases + shared links, calendar click, map drawing,
  print report, theme. Bugs found and fixed: list under the status line, year list scroll, count-up first frame
  negative, phone gap from the old sticky offset, globe labels too dense, tooltip wording (2000-2025).

---
## 2026-11-15 · Map: real Earth + round "main hotspot" dots (asked by the user)
- Background: NASA Blue Marble (GIBS) by default; "Streets" (OpenStreetMap) in Map settings (link: bg=streets).
  NASA place-name layer tested and NOT used (black/empty tiles at most zooms); CARTO labels need an API key now.
- Squares -> round dots in the middle of each square, 3 warm tones, size + brightness = fires, soft glow.
- Only main hotspots: the places that together hold 80% of the fires in the dates (min 25, max 1,500 dots).
- World: whole Earth fits, thin borders. Country: zoom in, ember border, world outside darker (our borders file).
- Sticky control box shrinks to one slim row when scrolled (laptops). Map height 500 px.
- Update (user): only the STRONGEST hotspots = 60% of the fires; colour = level, light -> dark, in each mode's own colour
  (fair count Reds, MODIS Oranges, VIIRS Purples, ColorBrewer, 5 steps with the same number of dots); min dot ~5 px.

---
## 2026-11-15 · Map card: full width, numbers + Play above (asked by the user)
- Right "Map settings" panel removed. The map now uses the full card width (580 px high, 420 px on phones).
- Above the map: 3 number buttons (Fair count / MODIS saw / VIIRS saw) = the totals AND the switch for the dots
  (like the first prototype), then a time line: Play/Pause + slider (one frame per year, per month if dates <= 2 years).
- Earth/Streets switch sits on the map (top right). Box, live fires, NASA daily dots, satellite picture: "More map tools".
- Dots: strongest places with 80% of the fires (max 5,000 dots), 5 levels: light + small -> dark + big, wider colour ramps.
- Tested: World, Brazil (Play, MODIS/VIIRS buttons, "no data" before 2012), calendar month click, All dates, print report.
- Update (user): the buttons moved INSIDE the map (one glass bar at the top, in line with Earth/Streets),
  legend = small label in the bottom-left corner, "More map tools" = one small line. Full screen button
  (real browser full screen, Esc or the button to leave). A country zooms to its real border (biggest part),
  zoom steps of 1/4, world outside darker. Tested laptop + 380 px, full screen in/out.

---
## 2026-11-15 · Page redesign (asked by the user; old design saved as git tag design-v1)
- Summary: short title "N fires in <place>", dates line, one sentence; "Why fair count?" opens the full text;
  exchange rate = small badge "1 MODIS fire = X VIIRS fires", explanation opens on click. Place/Dates/Data chips removed.
- The 8 cards moved under the calendar as "Key numbers" (4 main + 4 "What the satellites counted"),
  one short line each (the long line is the tooltip), shorter (?) texts. 4 / 2 / 1 columns.
- New look: design tokens at the top of style.css (space, 16 px card radius, soft shadows, 4 text sizes),
  section headers = badge + title + short line, long notes behind "More", How/Limits/Sources = closed accordions
  (menu links open them). Animations: page-load stagger (80 ms), scroll reveal with card stagger, reduced motion respected.
- No number calculations changed. Print report: same page order (summary, key numbers, map + calendar).
- Part 4-5 (user): numbers count up from 0 (0.8 s) when shown and on every change; calendar months appear in a wave
  (only when place/dates/view change); charts animate (Chart.js, replay when scrolled into view); cards lift -3 px;
  buttons press; toggles fade open/closed, Esc closes; place/dates change = fade out/in (opacity only).
  The picker is no longer sticky: when scrolled away a pill bar shows "place · dates [Change]"; it opens the full
  picker as a panel (click outside / Esc closes, closes after a pick); its slot keeps the height (no jump).
  Print: no bar, no animation. Tested: US, Brazil, India, Mexico, Chile, Kenya, World, date quick button, shared link,
  print report, 504 px + 1280 px, no console errors.
- Update (user): the summary (title, dates, sentence, rate badge) is now the head of the map card, compact
  (dates next to the title, "Why fair count?" next to the sentence); map hint moved under the map. Print report
  moves the summary back on top. Phones: compact picker (Place full row, Dates + Share side by side).
  First screen shows 59% of the map on a 1536x730 laptop, 45% on a 375x740 phone.

---
## 2026-11-15 · New home page (HOMEPAGE.md, asked by the user)
- web/index.html = new home page: space hero with a 3D Earth (Three.js 0.160.0, GSAP 3.12.5 entrance 7.5 s,
  Replay / Pause / Esc, static picture if WebGL fails), dark-to-white transition, summary "Fire on Earth, in short"
  (4 big numbers, year chart, top 5 countries of the last full year, why fair count + world rate), footer.
- The old page moved to web/map.html; the home page opens it in a full-screen iframe (?view=explore).
  Old share links (#c=...) open the map at once; Back returns home; the visible address follows the map view,
  and Share / the report use it. Root index.html keeps ?view and #c when it forwards to web/.
- Numbers: home_summary.py writes web/data/home-summary.json with the map page's rules (checked: 449.3M,
  August, 2001*, rate 4.3 = the World view). The robot runs it after each update (update.yml adds the file).
- Earth pictures (user choice): NASA Blue Marble from three-globe@2.31.1 -> web/intro/earth.jpg; normal map
  made from its height map (make_intro_images.py).

---
## 2026-11-15 · 3D background on the map page + new name PyroVision (asked by the user)
- js/bg-scene.js: behind the map page, a faint turning Earth (the home page picture) with a glowing fire point
  per country (size from countries.json total_H), two satellites on polar orbits (MODIS orange, VIIRS purple)
  and an ember glow. Starts after load, max 30 fps, stops when the tab is hidden / map full screen / printing;
  reduced motion = one still picture; no WebGL = nothing. Cards are 86% opaque so it shows faintly.
- The website is now called PyroVision (all visible text, README, SUBMISSION). Internal names (repo, files,
  saved theme key) stay the same. README screenshot (assets/screenshot.jpg) still shows the old name.
