# HotSync practice app: full plan (read this first)

Team Capella · NASA Space Apps 2026 · Challenge: "Harmonization of MODIS and VIIRS Hot Spots"

This file explains the whole practice project from the beginning to the end.
It is written for two readers:

- **Husan (a human learner):** read it top to bottom to understand the logic.
- **Claude Code (in the terminal):** follow it step by step to build the app.

> **Important rule:** Space Apps says teams may not start the real challenge
> before 14 November. This is a **practice app** to learn the logic.
> At the hackathon, the team writes the real code again from zero.

---

## 0. Note for Claude Code (how to work with Husan)

- Husan is learning. **Explain every step in simple English** before and after you do it.
  Short sentences, no hard words. If you must use a technical word, explain it in brackets.
- Build **one step at a time**. After each step, run it, show the result, and stop so Husan can check it.
- Put **many short comments** in the code that explain *why*, not only *what*.
- If the CSV files look different from what this file says (other column names, other format),
  **stop and show Husan what you found** before changing the plan.
- Use `mockup.html` as the design (colours, layout, sections). Copy its look, but use **real numbers**.
- Keep it simple: Python + pandas for data, one plain HTML page for the website. No React, no database.

---

## 1. The idea in one minute

1. Satellites find **hot spots** (very hot places on the ground, usually fires).
2. Two satellite cameras do this:
   - **MODIS**: old camera, big pixels (about 1 km). Sees **fewer** fires.
   - **VIIRS**: new camera, small pixels (about 375 m). Sees **more** fires.
3. For the **same place and the same days**, VIIRS counts many more fires than MODIS.
   So we can't just put their numbers together. That would be unfair.
4. **Harmonization** = find the "exchange rate" between them
   (for example 1 MODIS hot spot ≈ 4.8 VIIRS hot spots), and convert MODIS with it.
5. Then we show the fair numbers on a **burning calendar** (coloured boxes).

In the real project we have 20+ years, so the calendar is **years × months**.
In this practice app we only have **one month**, so the calendar is **sensor × days**.
The logic is the same.

---

## 2. What we have (inputs)

Two CSV files downloaded from NASA FIRMS, for **Uzbekistan, one month**:

- one MODIS file (name often contains `M-C61` or `modis`)
- one VIIRS file (name often contains `SV-C2`, `J1V-C2`, `J2V-C2` or `viirs`)

Put them here:

```
data/raw/modis.csv
data/raw/viirs.csv
```

(If the names are different, keep them and update `config` at the top of `process.py`.)

### Columns we expect

| Column | Meaning | MODIS | VIIRS |
| --- | --- | --- | --- |
| `latitude`, `longitude` | where the hot spot is | yes | yes |
| `acq_date` | date (YYYY-MM-DD) | yes | yes |
| `acq_time` | time in UTC, like 0835 = 08:35 | yes | yes |
| `confidence` | how sure the satellite is | number 0–100 | letter: `l` low, `n` nominal, `h` high |
| `brightness` / `bright_ti4` | temperature of the pixel (Kelvin) | `brightness` | `bright_ti4` |
| `frp` | fire power (how strong the fire is) | yes | yes |
| `daynight` | `D` day or `N` night | yes | yes |
| `satellite` | which satellite (Terra/Aqua, N/N20/N21) | yes | yes |
| `type` | 0 = vegetation fire, 1 = volcano, 2 = other fixed hot place, 3 = offshore | archive files only | archive files only |

**Claude Code:** first print the columns and 5 rows of each file, and tell Husan if anything is different.

---

## 3. Folder structure (what we will build)

```
hotsync-practice/
├── SPEC.md              ← this file
├── mockup.html          ← the design (fake numbers)
├── assets/
│   ├── capella-logo.png ← full team logo
│   └── capella-mark.png ← small logo for the header
├── data/
│   ├── raw/             ← the 2 downloaded CSV files (do not change them)
│   └── processed/       ← files that process.py makes
├── process.py           ← Python: load → clean → count → harmonize → export
├── requirements.txt     ← pandas
└── web/
    ├── index.html       ← the website (looks like mockup.html)
    ├── app.js           ← reads the JSON and draws everything
    └── data/summary.json← made by process.py
```

---

## 4. Step by step

### Step 1. Set up (5 min)

- Create the folders above.
- `requirements.txt` with `pandas`.
- Create a virtual environment and install:
  `python -m venv .venv` → activate → `pip install -r requirements.txt`.

**Check:** `python -c "import pandas; print(pandas.__version__)"` prints a version.

### Step 2. Load the data (10 min)

In `process.py`:

- Read both CSVs with pandas.
- Add a column `sensor` = `"MODIS"` or `"VIIRS"`.
- Turn `acq_date` into a real date.
- Print: number of rows, first and last date, column names.

**Check:** both files load, dates are inside the same month.
**Learning point:** VIIRS should already have **many more rows** than MODIS. This is the whole problem.

### Step 3. Clean the data (15 min)

Keep only good, real fires:

1. If a `type` column exists → keep only `type == 0` (vegetation fires).
   If it doesn't exist (near-real-time files) → keep everything and tell Husan.
2. Confidence:
   - MODIS: keep `confidence >= 30`.
   - VIIRS: remove `l` (low). Keep `n` and `h`.
3. Optional: remove hot spots outside Uzbekistan's box
   (latitude 37–46, longitude 56–74) just in case.

Print how many rows were removed at each step and **why**.

**Check:** a small table "before / after cleaning" for each sensor.

### Step 4. Count fires per day (10 min)

- Group by `sensor` and `acq_date`, count rows.
- Make one table with columns: `date`, `modis_raw`, `viirs_raw`.
- Days with no fires = 0 (fill every day of the month).

**Check:** print the table. The VIIRS column should be bigger almost every day.

### Step 5. Harmonize (the most important step, 20 min)

**Method A: simple ratio (do this first).**

```
ratio = total VIIRS hot spots this month ÷ total MODIS hot spots this month
modis_harmonized (each day) = modis_raw × ratio
```

Example: VIIRS 1,986 ÷ MODIS 412 = **4.8**. A day with 10 MODIS hot spots → 48 "VIIRS-like" hot spots.

Also compute the ratio **only on days when both sensors saw fires**, and the **median of the daily ratios**.
Show all three numbers. Explain to Husan why the median is safer
(one strange day can't break it).

**Method B: same grid boxes (bonus, if time).**
The two sensors have different pixel sizes, so compare them on the **same boxes**:

- Round latitude and longitude to a 0.1° grid (about 10 km squares).
- For each sensor, count how many **grid boxes had at least one fire** each day ("fire cells").
- Ratio B = VIIRS fire cells ÷ MODIS fire cells.

Ratio B is usually **smaller** than ratio A, because VIIRS often puts 3–5 dots
on one fire that MODIS sees as 1 dot. Show Husan both and explain the difference.

**Honest note (tell Husan):** with only one month, we learn the ratio and use it on the same month.
That is fine for practice. In the real project we learn the ratio from the
**overlap years (2012 → now)** and use it on the **old years (2000 → 2011)**, where only MODIS exists.

**Check:** print `date, modis_raw, viirs_raw, modis_harmonized`.
The harmonized line should be close to the VIIRS line.

### Step 6. Export (10 min)

`process.py` writes:

1. `data/processed/hotspots_clean.csv`: all cleaned hot spots, both sensors, with a `sensor` column.
2. `data/processed/daily_counts.csv`: date, modis_raw, viirs_raw, modis_harmonized.
3. `web/data/summary.json`: everything the website needs:

```json
{
  "area": "Uzbekistan",
  "month": "2026-10",
  "totals": {"modis_raw": 412, "viirs_raw": 1986},
  "ratio": {"total": 4.82, "median_daily": 4.6, "grid_cells": 2.9},
  "busiest_day": "2026-10-17",
  "daily": [{"date": "2026-10-01", "modis_raw": 9, "viirs_raw": 43, "modis_harmonized": 43}],
  "points": [{"lat": 41.2, "lon": 69.1, "sensor": "VIIRS", "date": "2026-10-01", "frp": 3.4}]
}
```

(Numbers above are examples.) If there are more than 5,000 points, keep a random 5,000 for the map.

**Check:** open the JSON and see real numbers.

### Step 7. Build the website (60 min)

Make `web/index.html` + `web/app.js` that **look like `mockup.html`** but read `data/summary.json`.

Sections, top to bottom (same as the mockup):

1. **Header:** Capella logo (`../assets/capella-mark.png`), "HotSync", subtitle.
2. **Left panel:** file info (row counts), area (only "All Uzbekistan" works for now), cleaning info, and the
   "How we made it fair" text with the real ratio.
3. **KPI cards:** MODIS raw total, VIIRS raw total, ratio, busiest day.
4. **Map:** Leaflet (from a CDN), OpenStreetMap tiles, centred on Uzbekistan (lat 41.4, lon 64.6, zoom 6).
   MODIS = blue rings, VIIRS = small orange dots. Click a dot → popup with date and FRP.
   A checkbox to show/hide each sensor.
5. **Line chart:** Chart.js (from a CDN). Three lines per day: MODIS raw (blue), VIIRS raw (orange),
   MODIS harmonized (green, dashed).
6. **Burning calendar:** a grid. Rows = "MODIS raw", "VIIRS raw", "MODIS harmonized". Columns = days.
   Box colour = count (light yellow → dark red, 5 steps). Hover a box → exact number.
7. **Daily table** + **Download CSV** button (downloads the daily table made in the browser).
8. **"How HotSync works"** strip with the 4 steps.

Colours (from the logo and mockup): ink `#0f1115`, background `#eef1f6`, Capella blue `#2f5bea`,
VIIRS orange `#e8613a`, harmonized green `#1a9e75`.

**Run it:** from the `hotsync-practice` folder, run `python -m http.server 8000`,
then open `http://localhost:8000/web/`.
(Opening the HTML file directly may block the JSON from loading. That's why we use a small server.)

**Check:** every section shows real numbers, the map shows dots in Uzbekistan, and the CSV downloads.

### Step 8. Explain it back (15 min)

Claude Code: at the end, ask Husan to explain these 5 things in his own words, and correct him kindly:

1. Why does VIIRS see more hot spots than MODIS?
2. What is the ratio, and how did we compute it?
3. Why is the median ratio safer than the total ratio?
4. Why is ratio B (grid boxes) smaller than ratio A?
5. How will this change in the real project with 20+ years of data?

---

## 5. From practice to the real project (for the team meeting)

| Practice app (now) | Real project (14–15 Nov) |
| --- | --- |
| 1 month, Uzbekistan | 2000 → now, any area the user picks |
| Ratio learned and used on the same month | Ratio learned on 2012 → now, used on 2000 → 2011 |
| One ratio for the whole month | One ratio per calendar month (season), maybe per region |
| Calendar = sensor × days | Calendar = years × months, plus a "normal year" (median) row |
| Data files on disk | Data from FIRMS archive / API, pre-processed |
| No anomaly | "This month vs normal: +X%" |

---

## 6. Prompt to paste into Claude Code

```
Read SPEC.md and look at mockup.html in this folder.
I am learning, so explain every step in simple English.
Start with Step 1 and Step 2 only, then stop and show me the results.
My two CSV files are in data/raw/.
```
