# HotSync: texts for the Space Apps project page (drafts, edit freely)

## Project Name

**HotSync: every fire since 2000, counted fairly**

## High-Level Summary

Two NASA satellite cameras count fires from space, but the newer one (VIIRS) sees about four times more fires than the
older one (MODIS), so fire counts from 2001 and from today cannot be compared honestly. HotSync learns a monthly
"exchange rate" between the two cameras for every country, converts the MODIS-only years into VIIRS-like counts, and
proves it works by hiding years and predicting them. The result is a free website with a fair fire calendar from 2001
to today for every country, any drawn area, and the whole world, updated automatically with new NASA data.

## Detailed Description

**What it does.** HotSync shows a *fire calendar* (years × months) for any country, any area you draw on the map, or
the whole world, from 2001 to today. You can see how a month compares with its normal (and how a month that is still
going compares with the same days of past years), the busiest months and years, one single day, fire dots for the
whole planet on any day since 2000, live fires of the last 48 hours, and NASA satellite pictures. Every view can be
shared with a link, and the numbers can be downloaded as CSV.

**How it works.**
1. *Load:* NASA FIRMS yearly files for every country (MODIS 2000–2025, VIIRS 2012–2025, about 7 GB) plus the FIRMS API
   for the current year.
2. *Clean:* only vegetation fires, no low-confidence detections, and no "always hot" places (factories, gas flares),
   which we find automatically: about 1 km squares that are hot almost every month (4,519 places worldwide).
3. *Make fair:* in 2012–2025, when both cameras flew, we compute VIIRS ÷ MODIS for every country, every calendar month
   and every year, and take the median: the "exchange rate". Older months are converted with it (a separate rate is
   used before July 2002, when only the Terra satellite existed). From February 2012 the fair count is simply what
   VIIRS saw.
4. *Prove it:* we learn the rates only from 2015–2025, predict 2012–2014 from MODIS alone and compare with the real
   VIIRS. For the whole world a typical month is off by 2.2 % (correlation 0.986); for Brazil 3.5 % (0.999). Each
   country's result is shown on the site, with a plain verdict.
5. *Keep growing:* a GitHub robot fetches new fires every two days, cleans them the same way and updates the current
   year and a live layer. When Suomi NPP had gaps in 2026 (and after it stopped on 2 November 2026) we use NOAA-20,
   adjusted with a factor learned when both flew.

**Benefits.** Fire managers, researchers, journalists and students can finally see whether fires are really increasing
in a place, or whether it only looks that way because the satellites changed. Every country and the whole world are
treated the same way, and the site explains its limits honestly (clouds, small areas, satellite gaps, near-real-time
data).

**Goals.** A trustworthy, simple tool that turns 25 years of NASA fire data into one fair story, for everyone, for
free, and that keeps itself up to date.

**Tools.** Python (pandas, NumPy, PyArrow, Shapely, Matplotlib), GitHub Actions and GitHub Pages; website in plain
HTML/CSS/JavaScript with Leaflet, Leaflet-Geoman, Turf.js, Chart.js and PapaParse.

## Use of AI

We used an AI assistant (Claude Code) to help write and check the code (data pipeline, website, robot) and to draft
texts. The idea, the method (cleaning rules, monthly median exchange rates, the Terra-only rate, the hold-out test,
treating every place the same) and all decisions are the team's; we checked the results ourselves (check images,
validation numbers, a check script for every country). No AI-generated images, video or voice are used as NASA data.

## Data & Resources

- NASA FIRMS: MODIS Collection 6.1 and VIIRS 375 m active fires (Suomi NPP, NOAA-20, NOAA-21), yearly country files and
  API: https://www.earthdata.nasa.gov/data/tools/firms
- FIRMS Archive Download: https://firms.modaps.eosdis.nasa.gov/download/
- NASA GIBS (satellite pictures and daily fire-dot layers):
  https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api
- Natural Earth country borders (1:50m): https://www.naturalearthdata.com/
- OpenStreetMap map tiles: https://www.openstreetmap.org/copyright
- Libraries: Leaflet https://leafletjs.com, Leaflet-Geoman https://github.com/geoman-io/leaflet-geoman,
  Turf.js https://turfjs.org, Chart.js https://www.chartjs.org, PapaParse https://www.papaparse.com,
  pandas https://pandas.pydata.org, NumPy https://numpy.org, PyArrow https://arrow.apache.org,
  Shapely https://shapely.readthedocs.io, Matplotlib https://matplotlib.org, ColorBrewer https://colorbrewer2.org
- Code and live site: https://github.com/Husanxon4407/hotsync-practice · https://husanxon4407.github.io/hotsync-practice/

Acknowledgement: We acknowledge the use of data and/or imagery from NASA's Fire Information for Resource Management
System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth
observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).

## 30-second video script

| Time | Picture (screen recording of the live site) | Voice |
| --- | --- | --- |
| 0:00 | HotSync logo, World map with fire squares | "Hi, we are Team Capella from Tashkent." |
| 0:02 | Calendar: switch "MODIS saw" → "VIIRS saw" (2012 suddenly jumps) | "NASA's newer satellite sees four times more fires, so old and new years can't be compared." |
| 0:05 | Title "HotSync: every fire since 2000, counted fairly" | "This is HotSync: every fire since 2000, counted fairly." |
| 0:10 | Proof chart (lines overlap) → switch to "Fair count" calendar → draw a box on the map | "We learn a monthly exchange rate between the satellites for every country, prove it on hidden years, and give a fair fire calendar for any country, any area, or the whole world." |
| 0:20 | "vs normal" view, live fires, "Copy link" | "It updates itself every two days, shows live fires, and every view can be shared." |
| 0:25–0:30 | World view + live link | "Next: burned area, alerts and more languages. Try it: husanxon4407.github.io/hotsync-practice." |
