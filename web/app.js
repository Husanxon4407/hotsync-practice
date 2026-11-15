/*
  HotSync: app.js  (Stage 4: website core)

  Reads the files that process_all.py made:
    data/countries.json          list of countries (for the country picker)
    data/country/<slug>.json     one country: monthly totals, squares, daily
    data/recent/...              the current year (made by update_recent.py)
  No numbers are typed in here: everything comes from those files.

  The big idea: ONE "state" object holds what the user picked (country,
  dates, area, calendar mode, day...). When something changes we call
  render(), and render() updates every section from the state. So the map,
  calendar, cards, table and downloads always agree with each other.
*/

// ------------------------------------------------------------------ SETTINGS
const DEFAULT_COUNTRY = "world";            // first view: all countries together
const DEFAULT_FROM = "2001-01";
const NORMAL_YEARS = [2001, 2025];          // "normal" = median of these years
const AQUA_START = "2002-07";                // before this: Terra-only MODIS months
// Fire dots for the whole planet: NASA FIRMS dots drawn by NASA GIBS (WMS).
// We store nothing: NASA sends a picture of the dots for any day.
const FIRE_WMS = "https://gibs.earthdata.nasa.gov/wms/epsg3857/best/wms.cgi";
const MODIS_FIRST = "2000-11-01", AQUA_FIRST = "2002-07-04";
const VIIRS_FIRST = "2012-01-20", SNPP_LAST = "2026-11-02";   // then NOAA-20
const SPANS = [["1", "1 day"], ["3", "3 days"], ["7", "7 days"], ["month", "1 month"]];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

// Colour ramps (ColorBrewer, colour-blind friendly).
// Counts: YlOrRd, light yellow (few) -> dark red (many).
const SEQ = ["#ffeda0", "#fed976", "#feb24c", "#fd8d3c", "#fc4e2a", "#e31a1c", "#bd0026", "#800026"];
// Anomaly: blue (below normal) - white (normal) - red (above normal).
const DIV = ["#2166ac", "#4393c3", "#92c5de", "#d1e5f0", "#f7f7f7", "#fddbc7", "#f4a582", "#d6604d", "#b2182b"];
const DIV_EDGES = [-75, -50, -25, -10, 10, 25, 50, 100];   // % borders between DIV colours

// ------------------------------------------------------------------ STATE
const state = {
  countries: [],        // countries.json
  cache: new Map(),     // slug -> country JSON (loaded once, kept in memory)
  c: null,              // the country we show now
  from: DEFAULT_FROM,   // date range 'YYYY-MM'
  to: null,
  area: null,           // null = whole country, or {feature, label, layer}
  selCells: null,       // null = all squares, or Set of square keys inside the area
  series: null,         // monthly numbers of the selection {modis, viirs, h, normal}
  calMode: "harmonized",
  squareMode: "harmonized",
  period: { kind: "range" },   // what the map shows: range | {month: i} | {day}
  day: null,            // 'YYYY-MM-DD' for the day view
  fire: { on: false, date: null, span: "1", modis: true, viirs: true },  // planet dots
  live: false,          // live fires of the last 48 h (clickable)
  normalMonth: 12,      // "this month vs normal": calendar month 1..12 ...
  normalYear: 2025,     // ... and the year to highlight
  gibs: { on: false, layer: "MODIS_Terra_CorrectedReflectance_Bands721", date: null },
  bg: "earth",          // map background: "earth" (NASA Blue Marble) or "streets"
};

// ------------------------------------------------------------------ HELPERS
const $ = (id) => document.getElementById(id);
const fmt = (n) => (n === null || n === undefined ? "–" : Math.round(n).toLocaleString("en-US"));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

// 12345 -> "12k" (short numbers that fit in a calendar cell)
function compact(v) {
  if (v === null || v === undefined || Number.isNaN(v)) return "–";
  const a = Math.abs(v);
  if (a < 1000) return String(Math.round(v));
  if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  if (a < 1e6) return Math.round(v / 1000) + "k";
  return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
}
const pct = (v) => {
  if (v === null || v === undefined) return "n/a";
  const r = Math.round(v);
  return (r > 0 ? "+" : "") + r + "%";      // round first, so we never show "+0%"
};
const monthShort = (m) => `${MONTHS[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
const monthLong = (m) => `${MONTHS_LONG[+m.slice(5, 7) - 1]} ${m.slice(0, 4)}`;
// 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 11 -> "11th", 22 -> "22nd"
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// Days: we count in UTC so time zones can't move a date by one day.
const dayMs = 86400000;
const toUTC = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
const dateOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const dayIndex = (d) => Math.round((toUTC(d) - toUTC(state.c.days_start)) / dayMs);
const dayAt = (i) => dateOf(toUTC(state.c.days_start) + i * dayMs);
// Satellite pictures and fire dots exist up to YESTERDAY: never ask for a later day.
const yesterday = () => dateOf(Date.now() - dayMs);
const picDate = (d) => (d > yesterday() ? yesterday() : d);
const longDate = (d) => new Date(toUTC(d)).toLocaleDateString("en-US", { timeZone: "UTC", weekday: "long", day: "numeric", month: "long", year: "numeric" });

const median = (arr) => {
  const a = arr.filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const k = Math.floor(a.length / 2);
  return a.length % 2 ? a[k] : (a[k - 1] + a[k]) / 2;
};

// Colour class for a count. Map squares use a log scale (a few squares have
// thousands of fires, most have a handful). The calendar uses a square-root
// scale: it separates "a normal month" from "a terrible month" better.
function seqClass(v, max, scale = "log") {
  if (!(v > 0)) return -1;
  if (!(max > 0)) return 0;
  const t = scale === "sqrt" ? Math.sqrt(v / max) : Math.log1p(v) / Math.log1p(max);
  return Math.min(SEQ.length - 1, Math.floor(t * SEQ.length));
}
function divClass(p) {
  let k = 0;
  while (k < DIV_EDGES.length && p >= DIV_EDGES[k]) k++;
  return k;
}

// ------------------------------------------------------------------ TOOLTIP + TOAST
const tip = $("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  tip.style.left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2)) + "px";
  tip.style.top = (y - r.height - 12 < 8 ? y + 18 : y - r.height - 12) + "px";
}
const hideTip = () => tip.classList.remove("show");
window.addEventListener("scroll", hideTip, { passive: true });
function tipFor(el, getHtml) {
  const at = (e) => {
    const b = el.getBoundingClientRect();
    const mouse = e && e.type.startsWith("mouse");
    showTip(getHtml(), mouse ? e.clientX : b.left + b.width / 2, mouse ? e.clientY : b.top);
  };
  ["mouseenter", "mousemove", "focus"].forEach((ev) => el.addEventListener(ev, at));
  ["mouseleave", "blur"].forEach((ev) => el.addEventListener(ev, hideTip));
}
document.querySelectorAll("[data-tip]").forEach((el) => tipFor(el, () => el.dataset.tip));

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2800);
}
function setLoading(msg) { $("loading").textContent = msg || ""; }
function showError(html) { const b = $("error"); b.style.display = "block"; b.innerHTML = html; }

// ------------------------------------------------------------------ THEME
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
};
const themeMode = () => document.documentElement.dataset.theme || "auto";
function setTheme(mode) {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  try { localStorage.setItem("hotsync-theme", mode); } catch (e) { /* ignore */ }
  $("themeBtn").innerHTML = THEME_ICONS[mode];
  $("themeBtn").title = "Theme: " + mode + " (click to change)";
  if (state.c) recolor();
}
$("themeBtn").addEventListener("click", () => {
  const next = { auto: "light", light: "dark", dark: "auto" }[themeMode()];
  setTheme(next);
  toast(next === "auto" ? "Theme: follows your computer" : `Theme: ${next}`);
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (themeMode() === "auto" && state.c) recolor();
});
setTheme(themeMode());

// ------------------------------------------------------------------ SEGMENTED BUTTONS
function makeSeg(el, items, current, onPick) {
  items.forEach(([key, label]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.dataset.key = key;
    b.setAttribute("aria-pressed", String(key === current));
    b.addEventListener("click", () => { setSeg(el, key); onPick(key); });
    el.appendChild(b);
  });
  requestAnimationFrame(() => moveThumb(el));
}
function setSeg(el, key) {
  el.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === key)));
  moveThumb(el);
}
function moveThumb(el) {
  const b = el.querySelector('button[aria-pressed="true"]');
  const t = el.querySelector(".thumb");
  // left AND top: on a phone the buttons can wrap onto 2 lines
  if (b && t) {
    Object.assign(t.style, { left: b.offsetLeft + "px", width: b.offsetWidth + "px",
      top: b.offsetTop + "px", height: b.offsetHeight + "px", bottom: "auto" });
  }
}
window.addEventListener("resize", () => document.querySelectorAll(".seg").forEach(moveThumb));

// ------------------------------------------------------------------ LOAD
async function getJSON(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return res.json();
}

// ------------------------------------------------------------------ MAP SQUARES (fast loading)
// Each place has a small <slug>.json (opens the page at once, with one total
// per square for the first view) and <slug>.cells.gz: every square month by
// month, packed by process_all.py (pack_cells). The packed file loads in the
// background; it is needed only for other dates, a drawn area or a popup.
async function gunzip(buf) {
  if (typeof DecompressionStream === "undefined") {          // very old browser
    if (!window.pako) await new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = "https://cdnjs.cloudflare.com/ajax/libs/pako/2.1.0/pako.min.js";
      s.onload = ok; s.onerror = () => fail(new Error("could not load pako"));
      document.head.appendChild(s);
    });
    return window.pako.ungzip(buf);
  }
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Bytes -> {"i_j": [[month_index, modis, viirs, h, frp_m, frp_v], ...]}
function unpackCells(buf) {
  let p = 0;
  const next = () => {                       // one LEB128 number
    let b = buf[p++];
    if (b < 128) return b;                   // most numbers are small: 1 byte
    let x = b & 127, mul = 128;
    do { b = buf[p++]; x += (b & 127) * mul; mul *= 128; } while (b >= 128);
    return x;
  };
  const unzig = (x) => (x % 2 ? -(x + 1) / 2 : x / 2);
  if (next() !== 1) throw new Error("unknown squares file format");
  const n = next(), heads = new Array(n);
  let total = 0;
  for (let k = 0; k < n; k++) { const i = unzig(next()), j = unzig(next()), len = next(); heads[k] = [i, j, len]; total += len; }
  const cols = [];
  for (let c = 0; c < 6; c++) { const a = new Float64Array(total); for (let k = 0; k < total; k++) a[k] = next(); cols.push(a); }
  const [c0, c1, c2, c3, c4, c5] = cols, cells = {};
  let k = 0;
  for (const [i, j, len] of heads) {
    const rows = new Array(len);
    let mi = 0;
    for (let r = 0; r < len; r++, k++) {
      mi += c0[k];
      rows[r] = [mi, c1[k], c2[k], c3[k] / 10, c4[k], c5[k]];
    }
    cells[`${i}_${j}`] = rows;
  }
  return cells;
}

// Start (once) loading the full squares of place c. Resolves when ready.
function loadDetail(c) {
  if (c.detailReady) return Promise.resolve();
  if (!c._detail) {
    c._detail = (async () => {
      let cells = c.cells;                   // an old one-file JSON already has them
      if (!cells) {
        const res = await fetch(`data/country/${c.cells_file}`);
        if (!res.ok) throw new Error(`${c.cells_file}: HTTP ${res.status}`);
        let buf = new Uint8Array(await res.arrayBuffer());
        if (buf[0] === 0x1f && buf[1] === 0x8b) buf = await gunzip(buf);   // server did not unzip it
        cells = unpackCells(buf);
      }
      for (const [key, rows] of Object.entries(c.recentCells || {})) (cells[key] ||= []).push(...rows);
      c.cells = cells;
      c.detailReady = true;
    })().catch((err) => { c._detail = null; throw err; });   // allow a retry
  }
  return c._detail;
}

// Can the first-view totals answer months [a, b] (no full squares needed)?
function quickOK(a, b) {
  const c = state.c;
  return !!c.quick && a === c.quickA && b >= c.quickB;
}

// Wait for the full squares (shows a note while loading). false = failed.
async function needDetail() {
  const c = state.c;
  if (c.detailReady) return true;
  setLoading("Loading map details…");
  try { await loadDetail(c); return true; }
  catch (err) { console.error(err); toast("Could not load the map details. Check your internet and try again."); return false; }
  finally { setLoading(""); }
}

// Is point (x = lon, y = lat) inside a GeoJSON Polygon / MultiPolygon?
// (Ray casting; holes count as outside.)
function insideShape(x, y, geom) {
  const ring = (pts) => {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i], [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  const poly = (rings) => ring(rings[0]) && !rings.slice(1).some(ring);
  if (geom.type === "Polygon") return poly(geom.coordinates);
  if (geom.type === "MultiPolygon") return geom.coordinates.some(poly);
  return false;
}

// ------------------------------------------------------------------ PRINT REPORT (Stage 7, extra 2)
// "Report mode" = the class "report" on <html> (see style.css): light colours,
// one page with the header, summary, key cards, map, calendar and sources.
// The button waits for the map pictures, then opens the print window
// (where "Save as PDF" is also offered). Ctrl+P gets the same layout.
let baseTiles = null, reportSaved = null;

function enterReport() {
  if (reportSaved || !state.c) return;
  const root = document.documentElement;
  reportSaved = { theme: root.dataset.theme, center: map.getCenter(), zoom: map.getZoom() };
  writeHash();                               // the link printed on the page
  const made = new Date().toISOString().slice(0, 16).replace("T", " ");
  const c = state.c, last = c.lastComplete || c.months[c.months.length - 1];
  $("rhMeta").innerHTML = `Made ${made} UTC<br>Data up to ${last}`;
  $("rhLine").innerHTML = `<b>Place:</b> ${c.name} &nbsp;·&nbsp; <b>Area:</b> ${state.area ? state.area.label : isWorld() ? "Whole world" : "Whole country"}` +
    ` &nbsp;·&nbsp; <b>Dates:</b> ${monthShort(state.from)} – ${monthShort(state.to)}`;
  $("rhLink").textContent = pageURL();
  root.dataset.theme = "light";              // paper is white (not saved as the user's choice)
  // On screen the summary is the head of the map card; on paper it goes on top
  $("where").before($("overview"));
  root.classList.add("report");
  map.invalidateSize();                      // the map box changed size
  map.options.zoomSnap = 0;                  // any zoom, so the place fills the small map
  if (state.area) map.fitBounds(state.area.layer.getBounds(), { padding: [8, 8], animate: false });
  else if (isWorld()) map.fitBounds([[-56, -168], [76, 178]], { animate: false });   // the whole planet
  else fitCountry();
  recolor();
}

function exitReport() {
  if (!reportSaved) return;
  const s = reportSaved, root = document.documentElement;
  reportSaved = null;
  root.classList.remove("report");
  $("where").prepend($("overview"));          // the summary back into the map card
  if (s.theme) root.dataset.theme = s.theme; else delete root.dataset.theme;
  map.options.zoomSnap = 0.25;
  map.invalidateSize();
  map.setView(s.center, s.zoom, { animate: false });   // back to the user's own view
  recolor();
  document.querySelectorAll(".seg").forEach(moveThumb);
}

async function printReport() {
  if (!state.c) return;
  enterReport();
  setLoading("Preparing the report…");
  // Wait for the street-map pictures of the new map size (at most 4 s).
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  if (baseTiles && baseTiles.isLoading()) {
    await new Promise((ok) => { baseTiles.once("load", ok); setTimeout(ok, 4000); });
  }
  setLoading("");
  window.print();                            // "afterprint" puts the page back
  // Backup, if a browser never sends "afterprint": the next click or key does it.
  setTimeout(() => {
    const back = () => { exitReport(); removeEventListener("pointerdown", back); removeEventListener("keydown", back); };
    addEventListener("pointerdown", back); addEventListener("keydown", back);
  }, 1000);
}
window.addEventListener("beforeprint", enterReport);
window.addEventListener("afterprint", exitReport);

// ------------------------------------------------------------------ CURRENT YEAR (Stage 6)
// History 2000-2025 never changes. The current year comes from small files
// that the robot (update_recent.py) refreshes, and we join them here.
const recent = { meta: null, daily: new Map(), cells: new Map() };

async function loadRecentMeta() {
  try { recent.meta = await getJSON("data/recent/meta.json"); } catch (e) { recent.meta = null; }
}
async function loadRecentDaily(year) {
  if (!recent.daily.has(year)) {
    recent.daily.set(year, getJSON(`data/recent/${year}/daily.json`).catch(() => null));
  }
  return recent.daily.get(year);
}
async function loadRecentCells(month, slug) {
  const key = `${month}/${slug}`;
  if (!recent.cells.has(key)) {
    recent.cells.set(key, getJSON(`data/recent/${month.slice(0, 4)}/cells/${month}/${slug}.json`).catch(() => ({})));
  }
  return recent.cells.get(key);
}
const nextMonth = (m) => { const y = +m.slice(0, 4), k = +m.slice(5, 7); return k === 12 ? `${y + 1}-01` : `${y}-${String(k + 1).padStart(2, "0")}`; };
const monthEnd = (m) => dateOf(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0));

// Add the current year to one country's data (once; the result is cached).
async function mergeRecent(c) {
  if (c._recent || !recent.meta) return;
  c._recent = true;
  const lastHist = c.months[c.months.length - 1], lastDay = recent.meta.last_day_with_data;
  const newMonths = [];
  for (let m = nextMonth(lastHist); m <= lastDay.slice(0, 7); m = nextMonth(m)) newMonths.push(m);
  if (!newMonths.length) return;
  const years = [...new Set(newMonths.map((m) => +m.slice(0, 4)))];
  const dailies = await Promise.all(years.map(loadRecentDaily));

  // Daily numbers: the current year after the history (VIIRS = harmonized from 2012)
  c.noaa20Days = new Set();
  dailies.forEach((d, yk) => {
    if (!d) {
      // This year's file did not load: add "no data" days, so the position of
      // every later day stays right (day index = days since days_start).
      const y = years[yk], last = lastDay < `${y}-12-31` ? lastDay : `${y}-12-31`;
      const n = Math.round((toUTC(last) - toUTC(`${y}-01-01`)) / dayMs) + 1;
      for (let k = 0; k < n; k++) { c.daily.modis.push(null); c.daily.viirs.push(null); c.daily.harmonized.push(null); }
      return;
    }
    (d.noaa20_days || []).forEach((x) => c.noaa20Days.add(x));
    const mine = d.countries[c.slug], missing = new Set(d.missing_days || []);
    for (let k = 0; k < d.n_days; k++) {
      const day = dateOf(toUTC(d.days_start) + k * dayMs);
      const gap = missing.has(day);
      const m = gap ? null : mine ? mine.m[k] : 0, v = gap ? null : mine ? mine.v[k] : 0;
      c.daily.modis.push(m); c.daily.viirs.push(v); c.daily.harmonized.push(v);
    }
  });
  // Monthly totals = sum of the days of that month
  for (const m of newMonths) {
    const d = dailies[years.indexOf(+m.slice(0, 4))], mine = d && d.countries[c.slug];
    let mo = 0, vi = 0, fm = 0, fv = 0, have = 0;
    if (d) {
      const missing = new Set(d.missing_days || []);
      const k0 = Math.round((toUTC(m + "-01") - toUTC(d.days_start)) / dayMs);
      const k1 = Math.min(d.n_days - 1, k0 + new Date(Date.UTC(+m.slice(0, 4), +m.slice(5, 7), 0)).getUTCDate() - 1);
      for (let k = k0; k <= k1; k++) {
        if (missing.has(dateOf(toUTC(d.days_start) + k * dayMs))) continue;
        have++;
        if (mine) { mo += mine.m[k]; vi += mine.v[k]; fm += mine.fm[k]; fv += mine.fv[k]; }
      }
    }
    // A month with no data at all (not fetched yet) is "no data", not 0 fires.
    c.months.push(m);
    c.totals.modis.push(have ? mo : null); c.totals.viirs.push(have ? vi : null); c.totals.harmonized.push(have ? vi : null);
    c.totals.frp_modis.push(have ? fm : null); c.totals.frp_viirs.push(have ? fv : null);
  }
  // Map squares of each new month (joined to the full squares in loadDetail)
  const cellObjs = await Promise.all(newMonths.map((m) => loadRecentCells(m, c.slug)));
  c.recentCells = {};
  newMonths.forEach((m, k) => {
    const mi = c.months.indexOf(m);          // month_index = place in c.months
    for (const [key, [mo, vi, fm, fv]] of Object.entries(cellObjs[k])) (c.recentCells[key] ||= []).push([mi, mo, vi, vi, fm, fv]);
  });
  c.recentLastDay = lastDay;
  // The newest day may still be loading (near-real-time data). Only days up
  // to last_complete_day are complete; without that mark, the last day is partial.
  c.lastComplete = recent.meta.last_complete_day || dateOf(toUTC(lastDay) - dayMs);
  c.inProgress = lastDay < monthEnd(lastDay.slice(0, 7)) || c.lastComplete < lastDay ? lastDay.slice(0, 7) : null;
}
// How many days of month m used the other VIIRS satellite (NOAA-20)?
function noaa20In(m) {
  const c = state.c;
  if (!c.noaa20Days) return 0;
  let n = 0;
  c.noaa20Days.forEach((d) => { if (d.startsWith(m)) n++; });
  return n;
}

// "Updated 3 hours ago · data to 14 Nov 2026"
function renderUpdated() {
  const chip = $("updatedChip");
  if (!recent.meta) { chip.hidden = true; return; }
  const hours = Math.max(0, (Date.now() - Date.parse(recent.meta.last_updated)) / 3600000);
  const ago = hours < 1 ? "less than 1 hour ago" : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  chip.hidden = false;
  $("updatedText").textContent = `Updated ${ago} · data to ${new Date(toUTC(recent.meta.last_day_with_data)).toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })}`;
  chip.title = `Last update: ${recent.meta.last_updated} (UTC). A robot on GitHub adds new fires from NASA FIRMS.`;
}

// ------------------------------------------------------------------ SHAREABLE LINKS (Stage 7, extra 1)
// The address bar always describes what you see, e.g.
//   #c=brazil&from=2019-01&to=2021-12&mode=normal&m=2020-09&v=-10.5,-55.2,5
// Opening such a link shows exactly the same view (great for our video).
const MODE_CODE = { harmonized: "fair", modis: "modis", viirs: "viirs", anomaly: "normal" };
const SQ_CODE = { harmonized: "fair", modis: "modis", viirs: "viirs", off: "off" };
const PIC_CODE = { MODIS_Terra_CorrectedReflectance_Bands721: "721", VIIRS_NOAA20_CorrectedReflectance_TrueColor: "tc" };
const flip = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [v, k]));
const okMonth = (x) => /^\d{4}-\d{2}$/.test(x || "");
const okDay = (x) => /^\d{4}-\d{2}-\d{2}$/.test(x || "");
let applyingHash = false, lastHash = "";

// The map page can run alone (map.html) or inside the home page (index.html
// opens it in a full-screen iframe). Then the address people see is the home
// page's: we keep it in sync, and Share / the report use it.
const IN_FRAME = window.parent !== window;
function pageURL() {
  try {
    if (IN_FRAME && parent.location.origin === location.origin)
      return parent.location.origin + parent.location.pathname + "?view=explore" + location.hash;
  } catch (e) { /* another site framed us: use our own address */ }
  return location.href;
}

// Read the link (null when the hash is just a section like #calendar)
function readHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (!h.includes("=")) return null;
  return Object.fromEntries(new URLSearchParams(h));
}

// Write the current view into the address bar (no new history entries)
function writeHash() {
  if (applyingHash || !state.c || !map) return;
  const p = new URLSearchParams();
  p.set("c", state.c.slug);
  p.set("from", state.from);
  p.set("to", state.to);
  if (state.calMode !== "harmonized") p.set("mode", MODE_CODE[state.calMode]);
  if (state.squareMode !== "harmonized") p.set("sq", SQ_CODE[state.squareMode]);
  if (state.area) {
    const layer = state.area.layer;
    if (layer instanceof L.Rectangle) {
      const b = layer.getBounds();
      p.set("box", [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()].map((x) => +x.toFixed(3)).join(","));
    } else {
      p.set("shape", layer.getLatLngs()[0].map((q) => `${+q.lng.toFixed(3)},${+q.lat.toFixed(3)}`).join(";"));
    }
  }
  if (state.period.kind === "month") p.set("m", state.c.months[state.period.mi]);
  else if (state.period.kind === "day") p.set("day", state.period.day);
  if (state.day && state.day !== dayAt(state.c.daily.modis.length - 1)) p.set("d", state.day);
  const f = state.fire;
  if (f.on) p.set("dots", `${f.date},${f.span},${f.modis ? "m" : ""}${f.viirs ? "v" : ""}`);
  if (state.live) p.set("live", "1");
  if (state.bg === "streets") p.set("bg", "streets");
  if (state.gibs.on) p.set("pic", `${PIC_CODE[state.gibs.layer]},${state.gibs.date}`);
  const cen = map.getCenter();
  p.set("v", `${cen.lat.toFixed(2)},${cen.lng.toFixed(2)},${+map.getZoom().toFixed(2)}`);
  const h = "#" + p.toString().replace(/%2C/g, ",").replace(/%3B/g, ";");
  if (h !== location.hash) history.replaceState(null, "", h);
  lastHash = h;
  if (IN_FRAME) { try { parent.postMessage({ type: "hotsync-hash", hash: h }, location.origin); } catch (e) { /* alone */ } }
}

// Apply a shared link after its place has loaded
function applyHash(H) {
  const c = state.c, shape = { color: "#2f5bea", weight: 2, fillOpacity: 0.05 };
  if (H.box) {
    const [w, s, e, n] = H.box.split(",").map(Number);
    if ([w, s, e, n].every(Number.isFinite) && w < e && s < n) useArea(L.rectangle([[s, w], [n, e]], shape), `Shared box ${w}, ${s}, ${e}, ${n}`);
  } else if (H.shape) {
    const pts = H.shape.split(";").map((t) => t.split(",").map(Number)).filter((q) => q.length === 2 && q.every(Number.isFinite));
    if (pts.length >= 3) useArea(L.polygon(pts.map(([x, y]) => [y, x]), shape), "Shared shape");
  }
  if (okMonth(H.m) && c.months.includes(H.m)) {
    state.period = { kind: "month", mi: c.months.indexOf(H.m) };
    state.normalMonth = +H.m.slice(5, 7);
    state.normalYear = +H.m.slice(0, 4);
  } else if (okDay(H.day)) {
    state.period = { kind: "day", day: clampDay(H.day) };
  }
  if (okDay(H.d)) state.day = clampDay(H.d);
  if (H.dots) {
    const [d, span, sens = ""] = H.dots.split(",");
    if (okDay(d) && SPANS.some(([k]) => k === span)) {
      Object.assign(state.fire, { on: true, date: picDate(d), span, modis: sens.includes("m"), viirs: sens.includes("v") });
      setSeg($("fireSpan"), span);
    }
  }
  if (H.live === "1") state.live = true;
  if (H.pic) {
    const [code, d] = H.pic.split(","), layer = flip(PIC_CODE)[code];
    if (layer && okDay(d)) state.gibs = { on: true, layer, date: picDate(d) };
  }
  render();
  if (state.live) renderLive();
  if (H.v) {
    const [la, lo, z] = H.v.split(",").map(Number);
    if ([la, lo, z].every(Number.isFinite)) { map.setView([la, lo], z, { animate: false }); refitOnBorders = false; }
  }
}

// "Share this view": copy the address of exactly this view. If the browser
// does not let us copy, the link appears in a small box to copy by hand.
let copyTimer = 0;
async function copyLink() {
  writeHash();
  const url = pageURL();
  let ok = false;
  try {
    // Some browsers ask for permission and wait: give up after 1.5 s.
    await Promise.race([navigator.clipboard.writeText(url),
      new Promise((_, no) => setTimeout(() => no(new Error("slow")), 1500))]);
    ok = true;
  } catch (e) {
    try {                                    // the old way
      const t = document.createElement("textarea");
      t.value = url; t.setAttribute("readonly", ""); t.style.position = "fixed"; t.style.opacity = "0";
      document.body.appendChild(t); t.select();
      ok = document.execCommand("copy");
      t.remove();
    } catch (e2) { ok = false; }
  }
  const b = $("shareBtn"), txt = $("shareBtnText");
  if (ok) {
    $("shareFallback").hidden = true;
    b.classList.add("copied"); txt.textContent = "Link copied ✓";
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { b.classList.remove("copied"); txt.textContent = "Share this view"; }, 2000);
    toast("Link copied: paste it anywhere to share exactly this view");
  } else {
    const f = $("shareUrl");
    f.value = url;
    $("shareFallback").hidden = false;
    f.focus(); f.select();
    toast("Copying is blocked here: the link is selected below, press Ctrl+C");
  }
  state.shared = true;
  updateSteps();
}

async function start() {
  try {
    setLoading("Loading the country list…");
    state.countries = await getJSON("data/countries.json");
    await loadRecentMeta();
  } catch (err) {
    setLoading("");
    showError("<b>Could not load the data</b> (" + err.message + ").<br>" +
      "Open the site through a small server, not by double-clicking the file: " +
      "in the <code>web</code> folder run <code>python -m http.server 8000</code>, " +
      "then open <code>http://localhost:8000</code>.");
    console.error(err);
    return;
  }

  // A shared link? Take its dates and views BEFORE the buttons are built.
  const H = readHash();
  if (H) {
    if (okMonth(H.from)) state.from = H.from;
    if (okMonth(H.to)) state.to = H.to;
    if (flip(MODE_CODE)[H.mode]) state.calMode = flip(MODE_CODE)[H.mode];
    if (flip(SQ_CODE)[H.sq] && H.sq !== "off") state.squareMode = flip(SQ_CODE)[H.sq];
    if (H.bg === "streets") state.bg = "streets";
  }
  buildControls();
  initMap();
  buildDayChart();
  buildProofCharts();
  setupReveal();
  setupScrollSpy();
  renderUpdated();

  applyingHash = true;                       // don't rewrite the link while we read it
  const slug = H && state.countries.some((c) => c.slug === H.c) ? H.c : DEFAULT_COUNTRY;
  await chooseCountry(slug);
  if (H) applyHash(H);
  applyingHash = false;
  writeHash();

  // Keep the link up to date while the map moves; open other shared links.
  let t;
  map.on("moveend", () => { clearTimeout(t); t = setTimeout(writeHash, 300); });
  window.addEventListener("hashchange", () => {
    if (location.hash === lastHash) return;
    if (readHash()) location.reload();       // another shared link pasted in
  });
  $("shareBtn").addEventListener("click", copyLink);
  setupPickBar();
  setupToggles();
  $("shareUrl").addEventListener("focus", (e) => e.target.select());
  $("printBtn").addEventListener("click", printReport);
  setupRateBadge();
  // Menu links scroll to their section WITHOUT replacing the shared link.
  document.querySelectorAll("nav.sections a").forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    const el = document.querySelector(a.getAttribute("href"));
    const acc = el && el.querySelector(":scope > details");
    if (acc && el.classList.contains("acc")) acc.open = true;
    if (el) el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  }));
}

// Load one country (only when it is chosen) and keep it in memory.
async function chooseCountry(slug) {
  const info = state.countries.find((c) => c.slug === slug);
  if (!info) return;
  $("countryInput").value = info.name;
  fadeOut();
  let data = state.cache.get(slug);
  if (!data) {
    setLoading(`Loading ${info.name}…`);
    try {
      data = await getJSON(`data/country/${slug}.json`);
    } catch (err) {
      setLoading("");
      toast(`Could not load ${info.name}`);
      console.error(err);
      return;
    }
    state.cache.set(slug, data);
  }
  await mergeRecent(data);                  // add the current year (once)
  if (!data.cellKeys) {
    // First-view square totals + the square list (history + current year)
    const q = data.cell_quick;
    data.quick = q ? q.squares : null;
    if (q) { data.quickA = data.months.indexOf(q.from); data.quickB = data.months.indexOf(q.to); }
    data.cellKeys = [...new Set([...Object.keys(data.quick || data.cells), ...Object.keys(data.recentCells || {})])];
  }
  setLoading("");
  stopPlay();
  state.c = data;
  const last = data.months[data.months.length - 1];
  // Keep the user's dates if they still fit, otherwise use the default.
  state.to = !state.to || state.to > last ? last : state.to;
  if (state.from < data.months[0]) state.from = data.months[0];
  state.day = dayAt(data.daily.modis.length - 1);   // latest day with data
  state.period = { kind: "range" };
  // "This month vs normal" starts at the latest month; the satellite
  // picture and the fire dots start at the 15th of that month.
  state.normalMonth = +last.slice(5, 7);
  state.normalYear = +last.slice(0, 4);
  if (!state.gibs.date) state.gibs.date = picDate(last + "-15");
  if (!state.fire.date) state.fire.date = picDate(last + "-15");
  clearArea(false);
  setupDateInputs();
  buildSquares();
  fitCountry();
  render();
  drawBorders();                            // clear border + darker world outside it
  // Now that the page is drawn, fetch the full squares in the background.
  fadeIn();
  setTimeout(() => loadDetail(data).catch((err) => console.warn(err)), 300);
}

// ------------------------------------------------------------------ CONTROLS
function buildControls() {
  // Step 1, Place: our own drop-down list (js/place-picker.js) and the
  // 3D globe (js/globe-picker.js, loaded only when its button is pressed).
  const placeOpts = {
    getPlaces: () => state.countries,
    getCurrent: () => state.c,
    onPick: (slug) => chooseCountry(slug),
  };
  HS.initPlacePicker({ input: $("countryInput"), ...placeOpts });
  HS.initGlobePicker({ button: $("globeBtn"), ...placeOpts });

  // Step 2, Dates: one button + pop-up (js/date-picker.js)
  datePicker = HS.initDatePicker({
    button: $("dateBtn"),
    getData: dateData,
    onApply: (a, b) => {
      stopPlay();
      state.from = a; state.to = b;
      state.period = { kind: "range" };
      fadeOut();
      setTimeout(() => { setupDateInputs(); render(); fadeIn(); }, reduceMotion ? 0 : 140);
    },
  });
  // "Custom area ✕": removes the area drawn on the map
  $("areaChip").addEventListener("click", () => { clearArea(true); render(); });

  // Calendar mode + square mode
  makeSeg($("calSeg"), [["harmonized", "Fair count"], ["modis", "MODIS saw"], ["viirs", "VIIRS saw"], ["anomaly", "vs normal"]],
    state.calMode, (k) => { state.calMode = k; renderCalendar(); });
  // What the dots show: the 3 number buttons above the map
  const modeBtns = $("modeBtns").querySelectorAll(".mode-btn");
  const markMode = () => modeBtns.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.key === state.squareMode)));
  modeBtns.forEach((b) => b.addEventListener("click", () => { state.squareMode = b.dataset.key; markMode(); renderMap(); }));
  markMode();
  // Time on the map: slider + Play (year by year, or month by month)
  $("playBtn").addEventListener("click", () => (playTimer ? stopPlay() : startPlay()));
  $("playSlider").addEventListener("input", (e) => { stopPlay(); showFrame(+e.target.value); });
  playButton();
  makeSeg($("bgSeg"), [["earth", "Earth (NASA)"], ["streets", "Streets"]],
    state.bg, (k) => { setBackground(k); renderMap(); });

  $("periodResetBtn").addEventListener("click", () => { stopPlay(); state.period = { kind: "range" }; render(); });

  // Lat/lon box
  $("boxForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const w = +$("boxW").value, s = +$("boxS").value, east = +$("boxE").value, n = +$("boxN").value;
    if (!(w < east) || !(s < n)) { toast("West must be smaller than East, and South smaller than North"); return; }
    const layer = L.rectangle([[s, w], [n, east]], { color: "#2f5bea", weight: 2, fillOpacity: 0.05 });
    useArea(layer, `Box ${w}, ${s}, ${east}, ${n}`);
    map.fitBounds(layer.getBounds(), { padding: [20, 20] });
  });

  // Live fires (last 48 h)
  $("liveToggle").addEventListener("change", (e) => { state.live = e.target.checked; renderLive(); renderMap(); });

  // Fire dots, whole planet: on/off, date, how many days, which sensors
  const fire = state.fire;
  $("fireToggle").addEventListener("change", (e) => { fire.on = e.target.checked; renderMap(); });
  $("fireDate").addEventListener("change", (e) => { if (e.target.value) { fire.date = e.target.value; fire.on = true; renderMap(); } });
  $("firePrev").addEventListener("click", () => stepFire(-1));
  $("fireNext").addEventListener("click", () => stepFire(1));
  $("fireModis").addEventListener("change", (e) => { fire.modis = e.target.checked; renderMap(); });
  $("fireViirs").addEventListener("change", (e) => { fire.viirs = e.target.checked; renderMap(); });
  makeSeg($("fireSpan"), SPANS, fire.span, (k) => { fire.span = k; fire.on = true; renderMap(); });
  $("fireDate").min = MODIS_FIRST;
  $("fireDate").max = dateOf(Date.now() - dayMs);   // yesterday: newer pictures don't exist yet

  // Day view
  $("dayInput").addEventListener("change", (e) => {
    if (!e.target.value) return;
    state.day = clampDay(e.target.value);
    renderDay();
  });
  $("dayPrev").addEventListener("click", () => stepDay(-1));
  $("dayNext").addEventListener("click", () => stepDay(1));
  $("dayDotsBtn").addEventListener("click", () => {
    stopPlay();
    state.period = { kind: "day", day: state.day };
    Object.assign(state.fire, { on: true, date: state.day, span: "1" });
    setSeg($("fireSpan"), "1");
    renderMap();
    $("where").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  });

  // Downloads
  $("dlMonthly").addEventListener("click", downloadMonthly);

  // Busiest-day card: click (or Enter) opens that day in the day view
  const openBusy = () => {
    const d = $("kBusyDayCard").dataset.day;
    if (!d) return;
    state.day = d;
    renderDay();
    $("day").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  };
  $("kBusyDayCard").addEventListener("click", openBusy);
  $("kBusyDayCard").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openBusy(); } });

  // This month vs normal: month picker
  $("normalMonth").innerHTML = MONTHS_LONG.map((m, k) => `<option value="${k + 1}">${m}</option>`).join("");
  $("normalMonth").addEventListener("change", (e) => { state.normalMonth = +e.target.value; renderNormal(); renderHow(); });

  // Satellite picture (NASA GIBS)
  $("gibsToggle").addEventListener("change", (e) => { state.gibs.on = e.target.checked; renderGibs(); renderMap(); });
  $("gibsLayer").addEventListener("change", (e) => { state.gibs.layer = e.target.value; state.gibs.on = true; $("gibsToggle").checked = true; renderGibs(); renderMap(); });
  $("gibsDate").addEventListener("change", (e) => { if (e.target.value) { state.gibs.date = e.target.value; renderGibs(); } });
  $("gibsDate").max = dateOf(Date.now() - dayMs);   // yesterday: newer pictures don't exist yet
}

let datePicker = null;

// What the date pop-up needs: newest month, the chosen dates, fires per year
function dateData() {
  const c = state.c, m = c.months, last = m[m.length - 1];
  // fires per year of what is selected now (whole place or the drawn area)
  const h = state.series ? state.series.h : c.totals.harmonized;
  const yearTotals = {};
  m.forEach((x, i) => {
    const v = h[i];
    if (v === null || v === undefined) return;
    const y = +x.slice(0, 4);
    yearTotals[y] = (yearTotals[y] || 0) + v;
  });
  const partialYear = last.slice(5) !== "12" || c.inProgress ? +last.slice(0, 4) : null;
  return { first: m[0], last, from: state.from, to: state.to, yearTotals, partialYear };
}

function setupDateInputs() {
  if (datePicker) datePicker.setLabel(state.from, state.to);
  const last = dayAt(state.c.daily.modis.length - 1);
  $("dayInput").min = state.c.days_start;
  $("dayInput").max = last;
}

// ------------------------------------------------------------------ SELECTION -> MONTHLY SERIES
// Month index range [a, b] of the chosen dates.
function rangeIdx() {
  const m = state.c.months;
  return [Math.max(0, m.indexOf(state.from)), Math.max(0, m.indexOf(state.to))];
}

// Monthly MODIS, VIIRS, harmonized for the selection (whole country or area),
// plus the "normal" (median) for each calendar month over 2001-2025.
function computeSeries() {
  const c = state.c, n = c.months.length;
  let modis, viirs, h, frpM, frpV;          // frp = fire power (MW), summed
  if (!state.selCells) {
    modis = c.totals.modis.slice();
    viirs = c.totals.viirs.slice();
    h = c.totals.harmonized.slice();
    frpM = c.totals.frp_modis.map((x) => x || 0);
    frpV = c.totals.frp_viirs.map((x) => x || 0);
  } else {
    modis = new Array(n).fill(0); viirs = new Array(n).fill(0); h = new Array(n).fill(0);
    frpM = new Array(n).fill(0); frpV = new Array(n).fill(0);
    for (const key of state.selCells) {
      for (const r of c.cells[key]) {
        modis[r[0]] += r[1]; viirs[r[0]] += r[2]; h[r[0]] += r[3]; frpM[r[0]] += r[4]; frpV[r[0]] += r[5];
      }
    }
    // VIIRS has no data before 2012 (and months not fetched yet): "no data", not 0.
    c.totals.viirs.forEach((v, i) => { if (v === null) viirs[i] = null; });
    c.totals.modis.forEach((v, i) => { if (v === null) { modis[i] = null; h[i] = null; } });
    h = h.map((x) => Math.round(x * 10) / 10);
  }
  const normal = MONTHS.map((_, k) => median(c.months
    .map((m, i) => [m, i])
    .filter(([m]) => +m.slice(5, 7) === k + 1 && +m.slice(0, 4) >= NORMAL_YEARS[0] && +m.slice(0, 4) <= NORMAL_YEARS[1])
    .map(([, i]) => h[i])));
  state.series = { modis, viirs, h, normal, frpM, frpV };
}
const anomaly = (i) => {
  const s = state.series, m = state.c.months[i], k = +m.slice(5, 7);
  if (s.h[i] === null || s.h[i] === undefined) return null;     // no data
  if (m === state.c.inProgress) {
    // A month still in progress: its COMPLETE days vs the same days of past years.
    const sf = soFar(k);
    return sf.D > 0 && sf.normal > 0 ? ((sf.value - sf.normal) / sf.normal) * 100 : null;
  }
  const nm = s.normal[k - 1];
  return nm > 0 ? ((s.h[i] - nm) / nm) * 100 : null;
};

// The unfinished month: complete days 1..D (the last, partial day is left out).
// For each year 2001-2025, add up the harmonized daily numbers of the same
// days; "normal" = the median. Daily numbers are for the whole country/world;
// a drawn area is scaled by its share.
function soFar(k) {
  const c = state.c, d = c.daily.harmonized, vals = [];
  const m = c.inProgress;
  // complete days of the month in progress (0 if even day 1 is still loading)
  const D = c.lastComplete && c.lastComplete.slice(0, 7) === m ? +c.lastComplete.slice(8, 10)
    : c.lastComplete && c.lastComplete > m ? 31 : 0;
  // this year's value for days 1..D (and the share of the month-to-date it is)
  let value = 0, mtd = 0;
  const j0 = dayIndex(m + "-01");
  for (let i = j0; i < d.length && dayAt(i).startsWith(m); i++) {
    mtd += d[i] || 0;
    if (i - j0 < D) value += d[i] || 0;
  }
  for (let y = NORMAL_YEARS[0]; y <= NORMAL_YEARS[1]; y++) {
    const i0 = dayIndex(`${y}-${String(k).padStart(2, "0")}-01`);
    if (i0 < 0 || i0 + D > d.length) continue;
    let t = 0;
    for (let i = i0; i < i0 + D; i++) t += d[i] || 0;
    vals.push(t);
  }
  let normal = median(vals);
  if (state.area) {
    const full = median(c.months.map((m, i) => [m, i])
      .filter(([m]) => +m.slice(5, 7) === k && +m.slice(0, 4) >= NORMAL_YEARS[0] && +m.slice(0, 4) <= NORMAL_YEARS[1])
      .map(([, i]) => c.totals.harmonized[i]));
    normal = full > 0 ? normal * state.series.normal[k - 1] / full : null;
    // the area's own month-to-date, cut to the complete days the same way
    const i = c.months.indexOf(m), areaMtd = state.series.h[i] || 0;
    value = mtd > 0 ? areaMtd * value / mtd : 0;
  }
  return { normal, vals, D, value };
}

// ------------------------------------------------------------------ RENDER
function render() {
  computeSeries();
  renderHeader();
  renderCards();
  renderRealStats();
  renderMap();
  renderCalendar();
  renderDay();
  renderTable();
  renderProof();
  renderNormal();
  renderHow();
  renderGibs();
  writeHash();                 // keep the shareable link up to date
}

// When the theme changes, things drawn with JS colours must be repainted.
function recolor() {
  renderMap();
  applyDayChartColors();
  renderProof();     // these two read their colours from CSS each time
  renderNormal();
}

// Big numbers count up from 0 to their value (0.8 s): "449.3M", "+19%",
// "4.3", "9.9 MW". Anything else ("August", "n/a") is just written.
// A number that is not on screen yet waits, and counts when it appears
// (setupReveal calls countUp). With "reduce motion" on, the final text appears at once.
const NUM_RE = /^([+-]?)(\d+(?:\.\d+)?)(k|M| MW|%)?$/;
function setNum(id, text) {
  const el = $(id);
  el.dataset.final = text;
  const hidden = el.closest(".reveal:not(.in)");
  if (hidden && !reduceMotion) { cancelAnimationFrame(el._raf || 0); el.textContent = text; return; }   // counts when shown
  countUp(el);
}
function countUp(el) {
  const text = el.dataset.final, m = NUM_RE.exec(text || "");
  cancelAnimationFrame(el._raf || 0);
  if (!m || reduceMotion || document.documentElement.classList.contains("report")) { el.textContent = text ?? el.textContent; return; }
  const sign = m[1] === "-" ? -1 : 1, to = sign * parseFloat(m[2]), unit = m[3] || "";
  const dec = (m[2].split(".")[1] || "").length, from = 0;
  if (to === 0) { el.textContent = text; return; }
  const show = (v) => (unit === "%" && Math.round(v) > 0 ? "+" : "") + v.toFixed(dec) + unit;
  const t0 = performance.now(), dur = 800;
  const step = (now) => {
    // (a frame's time can be a little BEFORE t0: keep k between 0 and 1)
    const k = Math.min(1, Math.max(0, (now - t0) / dur)), e = 1 - Math.pow(1 - k, 3);   // ease out
    if (k < 1) { el.textContent = show(from + (to - from) * e); el._raf = requestAnimationFrame(step); }
    else el.textContent = text;                                           // exact final text
  };
  el._raf = requestAnimationFrame(step);
}

// "the United Kingdom", "the Netherlands", but "Brazil"
const NEEDS_THE = /^(United|Netherlands|Philippines|Bahamas|Gambia|Maldives|Czech|Dominican|Central African|Democratic|Republic|Solomon|Marshall|Cayman|Falkland|Faeroe|British|Virgin|Comoros|Seychelles)/;
const countryName = () => (isWorld() ? "the whole world" : NEEDS_THE.test(state.c.name) ? "the " + state.c.name : state.c.name);
const areaName = () => (state.area ? `the drawn area in ${countryName()}` : countryName());

// The 3 step boxes: a step with a value gets a thin ember line on top.
function updateSteps() {
  $("stepPlace").classList.toggle("done", !!state.c);
  $("stepDates").classList.toggle("done", !!(state.from && state.to));
  $("stepShare").classList.toggle("done", !!state.shared);
  if (datePicker && state.from && state.to) datePicker.setLabel(state.from, state.to);   // the Dates button
  // What the shared link will open
  if (state.c) $("sharePreview").textContent = `${state.c.name} · ${monthShort(state.from)} – ${monthShort(state.to)}${state.area ? " · custom area" : ""}`;
  if (state.c) $("pickBarText").textContent = `${state.c.name}${state.area ? " (your area)" : ""} · ${monthShort(state.from)} – ${monthShort(state.to)}`;
}

function renderHeader() {
  const c = state.c;
  updateSteps();
  $("heroRange").textContent = `${monthShort(state.from)} – ${monthShort(state.to)}` + (state.area ? ` · ${state.area.label}` : "");
  $("areaChip").hidden = !state.area;                 // "Custom area ✕" only when one is drawn
  $("shareFallback").hidden = true;                   // the view changed: an old link is wrong now

  // Exchange-rate picture: 1 MODIS ring = N VIIRS dots, for YOUR dates:
  // the rate of each month in the range, weighted by its MODIS fires
  // (sum of rate x MODIS / sum of MODIS). Terra-only months use their own rate.
  const s = state.series, [a, b] = rangeIdx();
  let num = 0, den = 0;
  const plain = [];
  for (let i = a; i <= b; i++) {
    const m = c.months[i], k = String(+m.slice(5, 7));
    const r = (m < AQUA_START ? c.rates_terra : c.rates)[k];
    const rate = r && Number.isFinite(r.rate) ? r.rate : null;
    if (rate === null) continue;
    plain.push(rate);
    const mo = s.modis[i] || 0;
    num += rate * mo; den += mo;
  }
  let avg = den > 0 ? num / den : plain.length ? plain.reduce((x, y) => x + y, 0) / plain.length : 0;
  if (!Number.isFinite(avg)) avg = 0;
  setNum("exNum", avg.toFixed(1));
  const full = Math.min(12, Math.floor(avg)), part = avg - Math.floor(avg);
  let dots = "";
  for (let k = 0; k < full; k++) dots += `<span class="ex-dot" style="animation-delay:${k * 60}ms"></span>`;
  if (part > 0.05 && full < 12) dots += `<span class="ex-dot part"><i style="width:${Math.round(part * 100)}%"></i></span>`;
  $("exDots").innerHTML = dots;
  const notes = [];
  if (c.months[a] >= "2012-02") notes.push("<b>Not needed for these dates: VIIRS was already flying, so the fair count is simply what VIIRS saw.</b>");
  if (isWorld()) notes.push("Every country uses its own rate; pick a country to see it.");
  if (c.rate_source === "global") notes.push("<b>Few fires here, so we use the world median rate.</b>");
  if (avg === 0) notes.push("<b>Rate 0:</b> MODIS sees hot places here that VIIRS does not count as fires, so MODIS-only years become 0.");
  $("exCap").innerHTML = `<b>1 MODIS fire = ${avg.toFixed(1)} VIIRS fires.</b> That is how many fires VIIRS sees for every 1 fire MODIS sees in ${countryName()}, for your dates. ` +
    `We call this the <b>"exchange rate"</b>: VIIRS sees more because its pixels are smaller.` + (notes.length ? "<br>" + notes.join(" ") : "");
}

// ------------------------------------------------------------------ SUMMARY CARDS + SENTENCE
// "Real fire numbers": what the satellites actually counted (after cleaning,
// no exchange rate), like the cards of the first prototype.
// A card's short line; the full text stays in its tooltip (title).
function short(id, text, full) {
  const el = $(id);
  el.textContent = text;
  el.title = full && full !== text ? full : "";
}

function renderRealStats() {
  const c = state.c, s = state.series, [a, b] = rangeIdx();
  // Totals include everything; "per year" uses FULL months only (the month
  // still in progress would make the average too low).
  let mo = 0, vi = 0, fm = 0, fv = 0, moFull = 0, viFull = 0, moMonths = 0, viMonths = 0;
  for (let i = a; i <= b; i++) {
    const done = c.months[i] !== c.inProgress;
    if (s.modis[i] !== null) { mo += s.modis[i]; fm += s.frpM[i]; if (done) { moFull += s.modis[i]; moMonths++; } }
    if (s.viirs[i] !== null) { vi += s.viirs[i]; fv += s.frpV[i]; if (done) { viFull += s.viirs[i]; viMonths++; } }
  }
  setNum("kModis", compact(mo));
  short("kModisS", moMonths ? `${compact(moFull / (moMonths / 12))} per year` : `${fmt(mo)} detections`,
    `${fmt(mo)} detections` + (moMonths ? ` · ${compact(moFull / (moMonths / 12))} per year` : ""));
  setNum("kViirs", vi || viMonths ? compact(vi) : "no data");
  if (vi || viMonths) short("kViirsS", (viMonths ? `${compact(viFull / (viMonths / 12))} per year` : `${fmt(vi)} detections`) +
      (c.months[a] < "2012-02" ? " · from 2012" : ""),
    `${fmt(vi)} detections` + (viMonths ? ` · ${compact(viFull / (viMonths / 12))} per year` : "") +
      (c.months[a] < "2012-02" ? " (VIIRS starts 20 Jan 2012)" : ""));
  else short("kViirsS", "starts 20 Jan 2012", "No VIIRS yet: its data starts on 20 Jan 2012");

  // Busiest day in the range (daily numbers are for the whole country/world)
  const d = c.daily, i0 = Math.max(0, dayIndex(state.from + "-01"));
  const endDay = dateOf(Date.UTC(+state.to.slice(0, 4), +state.to.slice(5, 7), 0));
  const i1 = Math.min(d.harmonized.length - 1, dayIndex(endDay));
  let best = i0;
  for (let i = i0; i <= i1; i++) if ((d.harmonized[i] || 0) > (d.harmonized[best] || 0)) best = i;
  const day = dayAt(best);
  $("kBusyDay").textContent = new Date(toUTC(day)).toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  short("kBusyDayS", `${compact(d.harmonized[best])} fires`, `${fmt(d.harmonized[best])} fires (fair count)` +
    (state.area ? (isWorld() ? " (whole world)" : " (whole country)") : "") + ". Click to open this day.");
  $("kBusyDayCard").dataset.day = day;

  // Fire strength: average fire radiative power (FRP) per detection
  const useV = vi > 0, frp = useV ? fv / vi : mo ? fm / mo : 0;
  setNum("kFrp", frp ? frp.toFixed(1) + " MW" : "–");
  short("kFrpS", `per ${useV ? "VIIRS" : "MODIS"} detection`, `average per ${useV ? "VIIRS" : "MODIS"} detection` +
    (useV && mo ? ` · MODIS: ${(fm / mo).toFixed(1)} MW (bigger pixels)` : ""));
}

function renderCards() {
  const c = state.c, s = state.series, [a, b] = rangeIdx();
  const idx = [];
  for (let i = a; i <= b; i++) idx.push(i);
  const many = idx.length >= 24;                // long enough to say "usually"

  // 1. Total harmonized
  const total = idx.reduce((t, i) => t + (s.h[i] || 0), 0);
  setNum("kTotal", compact(total));
  short("kTotalS", `in ${idx.length} month${idx.length === 1 ? "" : "s"}`, `${fmt(total)} fires (fair count) in ${idx.length} month${idx.length === 1 ? "" : "s"}`);

  // 2. Busiest calendar month (average; the month in progress is left out)
  const sums = new Array(12).fill(0), counts = new Array(12).fill(0);
  idx.forEach((i) => {
    if (s.h[i] === null || c.months[i] === c.inProgress) return;
    const k = +c.months[i].slice(5, 7) - 1;
    sums[k] += s.h[i]; counts[k]++;
  });
  const avgs = sums.map((x, k) => (counts[k] ? x / counts[k] : -1));
  const busy = avgs.indexOf(Math.max(...avgs));
  $("kBusy").textContent = avgs[busy] >= 0 ? MONTHS_LONG[busy] : "–";
  if (avgs[busy] < 0) short("kBusyS", "no complete month", "No complete month in your range");
  else short("kBusyS", `${compact(avgs[busy])} fires${counts[busy] > 1 ? " on average" : ""}`,
    counts[busy] > 1 ? `${fmt(avgs[busy])} fires on average (${counts[busy]} years)` : `${fmt(avgs[busy])} fires`);

  // 3. Top 3 years: FULL years only (all 12 months in range, none missing or
  // in progress). Terra-only years (before Jul 2002) get a "*".
  const byYear = {};
  idx.forEach((i) => {
    const m = c.months[i], y = m.slice(0, 4);
    const v = (byYear[y] ||= { t: 0, n: 0, terra: false });
    if (s.h[i] !== null && m !== c.inProgress) { v.t += s.h[i]; v.n++; }
    if (m < AQUA_START) v.terra = true;
  });
  const fullYears = Object.entries(byYear).filter(([, v]) => v.n === 12).sort((x, y) => y[1].t - x[1].t);
  const top = fullYears.slice(0, 3);
  const star = ([y, v]) => y + (v.terra ? "*" : "");
  const anyTerra = top.some(([, v]) => v.terra);
  if (fullYears.length >= 2) {
    $("kTop").textContent = top.map(star).join(" · ");
    $("kTop").title = anyTerra ? "* Terra only: least certain years" : "";
    short("kTopS", top.map(([, v]) => compact(v.t)).join(" · ") + " fires",
      top.map(([, v]) => compact(v.t)).join(" · ") + " fires" + (anyTerra ? " · * Terra only: least certain years" : ""));
  } else {
    $("kTop").textContent = "–";
    $("kTop").title = "";
    short("kTopS", "pick 2+ full years", "Pick at least 2 full years to compare years");
  }

  // 4. LAST MONTH IN YOUR RANGE vs its normal (+ rank among the same month).
  // "So far / same days" only when that month is still in progress.
  const li = b, lm = c.months[li], k = +lm.slice(5, 7) - 1;
  const an = anomaly(li), going = lm === c.inProgress;
  let lmName = monthLong(lm), verb = "was";
  if (going) {
    const sf = soFar(k + 1), mine = state.area ? null : sf.value;
    const rank = mine === null || !sf.D ? null : 1 + sf.vals.filter((x) => x > mine).length;
    lmName = sf.D ? `${monthLong(lm)} so far (1–${sf.D})` : `${monthLong(lm)} so far`;
    verb = "is";
    setNum("kLatest", pct(an));
    short("kLatestS", sf.D ? `${monthShort(lm)} so far (days 1–${sf.D})` : `${monthShort(lm)}: just started`,
      sf.D
        ? `${lmName}, vs the same days of ${NORMAL_YEARS[0]}–${NORMAL_YEARS[1]}` + (rank ? ` · ${ordinal(rank)} highest of ${sf.vals.length + 1}` : "")
        : `${monthLong(lm)} has just started: no complete day yet`);
  } else if (s.h[li] === null) {
    setNum("kLatest", "n/a");
    short("kLatestS", `${monthShort(lm)}: no data`, `${monthLong(lm)}: no data`);
  } else {
    const same = c.months.map((m, i) => [m, i]).filter(([m]) => +m.slice(5, 7) === k + 1 && m >= "2001-01" && m !== c.inProgress);
    const rank = 1 + same.filter(([, i]) => s.h[i] > s.h[li]).length;
    setNum("kLatest", pct(an));
    short("kLatestS", `${monthShort(lm)} · ${ordinal(rank)} highest`, `${monthLong(lm)}: ${ordinal(rank)} highest ${MONTHS_LONG[k]} since 2001`);
  }

  // One short sentence built from the numbers: busiest month + last month vs normal
  let text = avgs[busy] < 0 ? "" : `<b>${MONTHS_LONG[busy]}</b> ${many ? "is usually" : "was"} the busiest month. `;
  text += an === null
    ? `${lmName} has no normal to compare with.`
    : Math.abs(Math.round(an)) < 1
      ? `${lmName} ${verb} <b>about normal</b>.`
      : `${lmName} ${verb} <b>${Math.abs(Math.round(an))}% ${an >= 0 ? "above" : "below"} normal</b>${going ? " for the same days" : ""}.`;
  $("summary").innerHTML = text;
  $("heroTitle").innerHTML = `${compact(total)} fires in ${state.area ? "your area" : countryName()}`;
}

// ------------------------------------------------------------------ MAP
let map, squareLayer, dotLayer, drawnGroup, renderer;
const squares = new Map();      // key -> Leaflet rectangle

function initMap() {
  renderer = L.canvas({ padding: 0.5 });    // canvas = fast with many shapes
  // scrollWheelZoom off at first: scrolling the PAGE over the map must not
  // zoom the map. A click on the map turns wheel zoom on; leaving turns it off.
  map = L.map("map", { preferCanvas: true, zoomSnap: 0.25, worldCopyJump: true, scrollWheelZoom: false }).setView([41.4, 64.6], 5);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  // Backgrounds (see setBackground): NASA Blue Marble, or streets (with place names).
  // (NASA's place-name layer was tested: at most zooms it sends black or empty
  // pictures, so it is not used.)
  map.createPane("mask").style.zIndex = 380;       // darkens the world outside the country
  map.createPane("borders").style.zIndex = 390;    // borders: under the fire dots (400)
  ["mask", "borders"].forEach((p) => { map.getPane(p).style.pointerEvents = "none"; });
  earthTiles = L.tileLayer(GIBS_WMTS + "BlueMarble_ShadedRelief_Bathymetry/default/GoogleMapsCompatible_Level8/{z}/{y}/{x}.jpeg", {
    maxNativeZoom: 8, maxZoom: 18,
    attribution: 'Earth: NASA Blue Marble, <a href="https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api">NASA GIBS</a>',
  });
  streetTiles = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  });
  setBackground(state.bg);
  map.setMinZoom(1);
  setupMapOverlay();
  map.on("zoomend", () => styleDots());            // dots grow when you zoom in
  // Own layer ("pane") for the NASA satellite picture: above the street map,
  // below the squares and dots. (Outside the tile pane, so dark mode doesn't
  // invert the picture's colours.)
  map.createPane("gibs").style.zIndex = 250;
  // Fire dots above the squares (squares are in the 400 "overlay" pane).
  // VIIRS dots get a CSS colour filter: NASA draws them orange, we show them purple.
  map.createPane("firesV").style.zIndex = 440;
  map.createPane("firesM").style.zIndex = 450;
  map.getPane("firesV").classList.add("viirs-dots");
  map.createPane("live").style.zIndex = 460;         // live dots on top
  liveLayer = L.layerGroup().addTo(map);
  map.on("moveend", () => { if (state.live) renderLive(); });
  squareLayer = L.layerGroup().addTo(map);
  dotLayer = L.layerGroup().addTo(map);
  drawnGroup = L.featureGroup().addTo(map);

  // Drawing tools (Leaflet-Geoman): rectangle, polygon, edit, delete.
  map.pm.addControls({
    position: "topleft", drawMarker: false, drawCircleMarker: false, drawPolyline: false,
    drawCircle: false, drawText: false, cutPolygon: false, rotateMode: false, dragMode: false,
    drawRectangle: true, drawPolygon: true, editMode: true, removalMode: true,
  });
  map.pm.setPathOptions({ color: "#2f5bea", weight: 2, fillOpacity: 0.05 });
  // Accessibility: Geoman puts the tool name on the box around each button,
  // so screen readers can't read it. Copy it onto the button itself.
  document.querySelectorAll(".leaflet-pm-toolbar .button-container").forEach((box) => {
    const btn = box.querySelector("a.leaflet-buttons-control-button");
    if (btn && box.title) btn.setAttribute("aria-label", box.title);
  });
  map.on("pm:create", (e) => useArea(e.layer, e.shape === "Rectangle" ? "Drawn box" : "Drawn shape"));
  map.on("pm:remove", (e) => { if (state.area && e.layer === state.area.layer) { clearArea(true); render(); } });
}

// Room the map buttons (top bar) and the legend (bottom) take inside the map
function mapPad() {
  const top = $("mapTop").offsetHeight + 12, bottom = $("mapLegend").offsetHeight + 14;
  return { paddingTopLeft: [16, top], paddingBottomRight: [16, bottom] };
}
function fitCountry() {
  // World: the whole Earth fits in the map, like a flat globe.
  if (isWorld()) { map.fitBounds([[-56, -168], [76, 178]], { animate: false, ...mapPad() }); return; }
  // A country: zoom to its border (its biggest part, so far islands don't
  // make it small), with the world outside darker (drawBorders).
  refitOnBorders = !bordersData;   // borders not here yet: fit again when they arrive
  const f = bordersData && bordersData.features.find((x) => x.properties.slug === state.c.slug);
  if (f) {
    const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
    const area = (r) => { let t = 0; for (let i = 0, j = r.length - 1; i < r.length; j = i++) t += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]); return Math.abs(t / 2); };
    const big = polys.reduce((x, y) => (area(y[0]) > area(x[0]) ? y : x));
    map.fitBounds(L.latLngBounds(big[0].map(([x, y]) => [y, x])), mapPad());
    return;
  }
  const [w, s, e, n] = state.c.bbox;
  if (e - w <= 180) { map.fitBounds([[s, w], [n, e]], mapPad()); return; }
  // Countries across the 180° line (Russia, Fiji...) have a box around the
  // whole world. Zoom to the half (east or west) that has most fire places.
  const pts = [...squares.values()].map((d) => d.getLatLng());
  const east = pts.filter((q) => q.lng >= 0), west = pts.filter((q) => q.lng < 0);
  const side = east.length >= west.length ? east : west;
  map.fitBounds(side.length ? L.latLngBounds(side) : [[s, w], [n, e]], mapPad());
}

// The bar inside the top of the map + the full screen button
function setupMapOverlay() {
  const wrap = $("mapWrap"), top = $("mapTop");
  for (const el of [top, $("mapLegend")]) { L.DomEvent.disableClickPropagation(el); L.DomEvent.disableScrollPropagation(el); }
  // Leaflet's own buttons (zoom, drawing) move down under the bar
  const place = () => wrap.style.setProperty("--bar-h", top.offsetHeight + 16 + "px");
  new ResizeObserver(place).observe(top);
  place();
  const btn = $("fullBtn");
  const icon = (on) => {
    btn.innerHTML = on
      ? '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>'
      : '<svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>';
    btn.setAttribute("aria-pressed", String(on));
    btn.title = btn.ariaLabel = on ? "Leave full screen (Esc)" : "Full screen map";
  };
  const setFull = (on) => {
    const c = map.getCenter(), z = map.getZoom();
    wrap.classList.toggle("is-full", on);
    document.documentElement.classList.toggle("map-full-open", on);
    icon(on);
    // the map keeps its centre; a bigger box = a little closer zoom is fine
    requestAnimationFrame(() => { map.invalidateSize(); map.setView(c, z, { animate: false }); styleDots(); });
  };
  btn.addEventListener("click", () => {
    const on = !wrap.classList.contains("is-full");
    if (on) {
      setFull(true);
      // real full screen when the browser allows it (hides the browser bars too)
      if (wrap.requestFullscreen) wrap.requestFullscreen().catch(() => {});
    } else if (document.fullscreenElement) document.exitFullscreen().catch(() => setFull(false));
    else setFull(false);
  });
  document.addEventListener("fullscreenchange", () => {
    if (!document.fullscreenElement && wrap.classList.contains("is-full")) setFull(false);
  });
  document.addEventListener("keydown", (e) => {   // Esc when the browser had no real full screen
    if (e.key === "Escape" && wrap.classList.contains("is-full") && !document.fullscreenElement) setFull(false);
  });
  icon(false);
}

// ------------------------------------------------------------------ FIRE DOTS (the map's main layer)
// One ROUND dot per square, in the middle of the square. Only the STRONGEST
// hotspots are drawn: the places that together have 80% of the fires in the
// chosen dates (at least 25, at most 5,000 dots), so the map is not covered.
// The level of a dot = its colour AND its size: light + small (fewer fires)
// -> dark + big (strong hotspot), in its own colour: fair count red, MODIS
// orange, VIIRS purple. 5 steps, each step has the same number of dots.
const HOT_SHARE = 0.8, HOT_MIN = 25, HOT_MAX = 5000;
const HOT_RAMPS = {   // single-hue ramps, light -> dark (wide range = easy to tell apart)
  harmonized: ["#fdd5c4", "#fc9272", "#ef3b2c", "#b3111b", "#5c0010"],   // Reds
  modis: ["#fee3c4", "#fdae6b", "#f16913", "#b84203", "#6b2502"],        // Oranges
  viirs: ["#e6e3f3", "#bcbddc", "#8c84c3", "#5e3c99", "#2f0f63"],        // Purples
};
const HOT_SIZE = [0.7, 0.82, 0.94, 1.06, 1.25];   // dot size per level (x the base size)
const hotRamp = () => HOT_RAMPS[state.squareMode] || HOT_RAMPS.harmonized;
let hot = { vals: new Map(), max: 0, shown: new Set(), share: 0, n: 0, breaks: [] };

function buildSquares() {
  squareLayer.clearLayers();
  squares.clear();
  hot = { vals: new Map(), max: 0, shown: new Set(), share: 0, n: 0, breaks: [] };
  const cs = state.c.cell_size;
  for (const key of state.c.cellKeys) {
    const [i, j] = key.split("_").map(Number);
    const dot = L.circleMarker([(i + 0.5) * cs, (j + 0.5) * cs],
      { renderer, radius: 0, weight: 0, opacity: 0, fillOpacity: 0, interactive: false });
    dot.on("click", (e) => squarePopup(key, e.latlng));
    squares.set(key, dot);
    dot.addTo(squareLayer);
  }
}

// Month index range the map shows.
function mapRange() {
  const p = state.period, m = state.c.months;
  if (p.kind === "month") return [p.mi, p.mi];
  if (p.kind === "frame") return [p.a, p.b];
  if (p.kind === "day") { const i = m.indexOf(p.day.slice(0, 7)); return [i, i]; }
  return rangeIdx();
}
const FIELD = { modis: 1, viirs: 2, harmonized: 3 };

// Sum of one square over the map months: [modis, viirs, h]
// Before the full squares arrive, the first view uses the ready-made totals
// (+ the current year's squares). Needs detailReady || quickOK(a, b).
function squareSum(key, a, b) {
  const c = state.c, out = [0, 0, 0];
  let rows = c.detailReady ? c.cells[key] : (c.recentCells || {})[key];
  if (!c.detailReady && c.quick && c.quick[key]) { const q = c.quick[key]; out[0] = q[0]; out[1] = q[1]; out[2] = q[2]; }
  for (const r of rows || []) {
    if (r[0] >= a && r[0] <= b) { out[0] += r[1]; out[1] += r[2]; out[2] += r[3]; }
  }
  return out;
}

// How many screen pixels one square is wide now (dots grow when you zoom in)
function cellPx() {
  const c = map.getCenter(), cs = state.c.cell_size;
  return Math.abs(map.latLngToContainerPoint([c.lat, c.lng + cs]).x - map.latLngToContainerPoint([c.lat, c.lng]).x);
}

// Size + colour of every dot (also called after zooming)
function styleDots() {
  if (!state.c || !squares.size) return;
  const px = cellPx(), pal = hotRamp();
  const order = [];
  for (const [key, dot] of squares) {
    const show = hot.shown.has(key) && hot.max > 0;
    dot.options.interactive = show;            // hidden dots can't be clicked
    if (!show) { dot.setRadius(0); dot.setStyle({ opacity: 0, fillOpacity: 0, weight: 0 }); continue; }
    const v = hot.vals.get(key);
    let k = 0;                                               // level 0..4
    while (k < hot.breaks.length && v > hot.breaks[k]) k++;
    // radius: grows when you zoom in, and with the level (strong = big)
    const base = Math.max(2.7, Math.min(11, px * 0.42));
    const r = base * HOT_SIZE[k];
    const inside = !state.selCells || state.selCells.has(key);
    dot.setRadius(r);
    // thin light edge: dark dots stay visible on the dark Earth picture
    dot.setStyle({ fillColor: pal[k], color: "#ffffff", weight: 0.6,
      opacity: inside ? 0.55 : 0.05, fillOpacity: inside ? 0.95 : 0.1 });
    order.push([v, dot]);
  }
  order.sort((x, y) => x[0] - y[0]).forEach(([, d]) => d.bringToFront());   // big dots on top
}

function renderMap() {
  if (!state.c) return;
  const [a, b] = mapRange(), off = state.squareMode === "off";
  const c = state.c, waiting = !c.detailReady && !quickOK(a, b);
  if (waiting) {
    // Other dates need the full squares: draw again as soon as they are here.
    loadDetail(c).then(() => { if (state.c === c) renderMap(); })
      .catch(() => toast("Could not load the map details. Check your internet and try again."));
  }
  if (!waiting) {
    const f = off ? 2 : FIELD[state.squareMode] - 1;
    const vals = new Map(), list = [];
    let total = 0;
    for (const key of squares.keys()) {
      const v = squareSum(key, a, b)[f];
      vals.set(key, v);
      // With a drawn area, the main hotspots are found INSIDE the area.
      if (v > 0 && (!state.selCells || state.selCells.has(key))) { list.push([key, v]); total += v; }
    }
    list.sort((x, y) => y[1] - x[1]);
    const shown = new Set();
    let acc = 0;
    for (const [key, v] of list) {
      if (shown.size >= HOT_MAX || (acc >= HOT_SHARE * total && shown.size >= HOT_MIN)) break;
      shown.add(key);
      acc += v;
    }
    // colour steps: 5 groups with the same number of dots (smallest -> biggest)
    const sv = [...shown].map((k) => vals.get(k)).sort((x, y) => x - y);
    const breaks = sv.length ? [1, 2, 3, 4].map((q) => sv[Math.floor((q * sv.length) / 5) - 1] ?? sv[0]) : [];
    hot = { vals, max: list.length ? list[0][1] : 0, shown: off ? new Set() : shown, share: total ? acc / total : 0, n: list.length, breaks,
      lo: sv.length ? sv[0] : 0 };
    styleDots();
  }

  // Time line above the map
  const p = state.period, m = state.c.months;
  $("mapPeriod").textContent = (p.kind === "range" ? `${monthShort(m[a])} – ${monthShort(m[b])} (all)`
    : p.kind === "frame" ? p.label
    : p.kind === "month" ? monthLong(m[a]) : `${longDate(p.day)}`) + (waiting ? " · loading…" : "");
  $("periodResetBtn").hidden = p.kind === "range";
  syncSlider();

  // Legend: the 5 colour steps (light -> dark) + how many hotspots are shown
  const sq = { harmonized: "fair count of fires", modis: "fires MODIS saw", viirs: "fires VIIRS saw" }[state.squareMode];
  const dots = hotRamp().map((col, k) => `<i class="hot-dot" style="--d:${Math.round(10 * HOT_SIZE[k])}px;background:${col}"></i>`).join("");
  let leg = off ? `<span class="key">Fire dots hidden</span>`
    : waiting ? `<span class="key">Loading map details…</span>`
    : `<span class="key" title="${compact(hot.lo)} – ${compact(hot.max)} ${sq} per place">weaker <span class="hot-key">${dots}</span> stronger</span>` +
      `<span class="key">${fmt(hot.shown.size)} hotspots = ${Math.round(hot.share * 100)}% of fires</span>`;
  if (state.selCells && !off) leg += `<span class="key">inside your area</span>`;
  if (state.fire.on || state.live) {
    leg += `<span class="key"><span class="dot" style="background:var(--modis)"></span> MODIS <span class="dot" style="background:var(--viirs)"></span> VIIRS dot</span>`;
  }
  $("mapLegend").innerHTML = leg;

  renderAreaStats(a, b);
  renderFire();
  writeHash();                 // keep the shareable link up to date
}

// ------------------------------------------------------------------ BACKGROUND + BORDERS
// Background: NASA Blue Marble (a real picture of the Earth), or the
// OpenStreetMap street map with place names ("Streets" button on the map).
const GIBS_WMTS = "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/";
let earthTiles = null, streetTiles = null;

function setBackground(kind) {
  state.bg = kind === "streets" ? "streets" : "earth";
  for (const t of [earthTiles, streetTiles]) if (t && map.hasLayer(t)) map.removeLayer(t);
  if (state.bg === "streets") { streetTiles.addTo(map); baseTiles = streetTiles; }
  else { earthTiles.addTo(map); baseTiles = earthTiles; }
  const box = map.getContainer();
  box.classList.toggle("map-streets", state.bg === "streets");
  box.classList.toggle("map-earth", state.bg !== "streets");
  if (focusLayer) drawBorders();               // the border colour follows the background
}

// Country borders (our own Natural Earth file with the FIRMS names, the same
// one the globe uses). World: thin lines. A country: a clear ember border,
// and everything outside it darker, so only its fires stand out.
let bordersGeo = null, bordersData = null, borderLayer = null, focusLayer = null, refitOnBorders = false;
function loadBorders() {
  if (!bordersGeo) bordersGeo = fetch("data/globe_countries.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
  return bordersGeo;
}
async function drawBorders() {
  const geo = await loadBorders();
  if (!geo || !map || !state.c) return;
  if (!bordersData) {
    bordersData = geo;
    if (refitOnBorders) fitCountry();   // first time: zoom to the real border
  }
  if (!borderLayer) {
    borderLayer = L.geoJSON(geo, { pane: "borders", interactive: false,
      style: () => ({ color: "#ffffff", weight: 0.6, opacity: 0.35, fill: false }) }).addTo(map);
  }
  if (focusLayer) { map.removeLayer(focusLayer); focusLayer = null; }
  if (isWorld()) return;
  const f = geo.features.find((x) => x.properties.slug === state.c.slug);
  if (!f) return;                               // too small for the border map
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const ll = (ring) => ring.map(([x, y]) => [y, x]);
  const outside = [[-85, -540], [85, -540], [85, 540], [-85, 540]];     // the whole map...
  const mask = L.polygon([outside, ...polys.map((pg) => ll(pg[0]))],       // ...with the country cut out
    { pane: "mask", interactive: false, stroke: false, fillColor: "#0b0908", fillOpacity: state.bg === "streets" ? 0.45 : 0.68 });
  const rings = polys.map((pg) => pg.map(ll));
  const halo = L.polygon(rings, { pane: "borders", interactive: false, fill: false, color: "#000", weight: 4.5, opacity: 0.4 });
  const line = L.polygon(rings, { pane: "borders", interactive: false, fill: false, color: state.bg === "streets" ? "#c2410c" : "#ff8a4c", weight: 2, opacity: 1 });
  focusLayer = L.layerGroup([mask, halo, line]).addTo(map);
}

async function squarePopup(key, latlng) {
  if (!state.c.detailReady && !quickOK(...mapRange()) && !(await needDetail())) return;
  const [a, b] = mapRange(), m = state.c.months, cs = state.c.cell_size;
  const [i, j] = key.split("_").map(Number);
  const [mo, vi, h] = squareSum(key, a, b);
  const lat = (x) => `${Math.abs(x).toFixed(2)}°${x >= 0 ? "N" : "S"}`;
  const lon = (x) => `${Math.abs(x).toFixed(2)}°${x >= 0 ? "E" : "W"}`;
  const viirsNote = m[b] < "2012-01" ? "no data (VIIRS starts 20 Jan 2012)" : fmt(vi);
  L.popup().setLatLng(latlng).setContent(
    `<div class="pop"><b>Square ${lat(i * cs)}–${lat((i + 1) * cs)}, ${lon(j * cs)}–${lon((j + 1) * cs)}</b>
     <div class="small">${a === b ? monthLong(m[a]) : `${monthShort(m[a])} – ${monthShort(m[b])}`}</div>
     <div class="row"><span>MODIS saw</span><b>${fmt(mo)}</b></div>
     <div class="row"><span>VIIRS saw</span><b>${viirsNote}</b></div>
     <div class="row"><span>Fair count</span><b>${fmt(h)}</b></div>
     ${state.selCells && !state.selCells.has(key) ? '<div class="small">Outside your area</div>' : ""}</div>`).openOn(map);
}

// The 3 numbers above the map (they are also the buttons). Same monthly
// series as the cards and the calendar, so all numbers match.
function renderAreaStats(a, b) {
  const s = state.series, sum = [0, 0, 0];
  for (let i = a; i <= b; i++) { sum[0] += s.modis[i]; sum[1] += s.viirs[i] || 0; sum[2] += s.h[i]; }
  const m = state.c.months;
  $("mbH").textContent = compact(sum[2]);
  $("mbM").textContent = compact(sum[0]);
  $("mbV").textContent = m[b] < "2012-01" ? "no data" : compact(sum[1]);
  $("areaStats").innerHTML = state.area
    ? `Numbers for <b>${state.area.label}</b> only. ${isWorld() ? "Every square uses its own country's exchange rates." : `A drawn area uses ${state.c.name}'s exchange rates.`} Squares count if their centre is inside.`
    : "";
}

// ---- Play: the map through time
// Frames: one per year of the chosen dates (one per month if the dates are
// 2 years or shorter). Slider 0 = all chosen dates added up.
var playTimer = null;   // var: buildControls may run before this line
function playFrames() {
  const [a, b] = rangeIdx(), m = state.c.months, out = [];
  if (b - a < 24) {
    for (let i = a; i <= b; i++) out.push({ a: i, b: i, label: monthLong(m[i]) });
  } else {
    for (let i = a; i <= b;) {
      const y = m[i].slice(0, 4);
      let j = i;
      while (j + 1 <= b && m[j + 1].slice(0, 4) === y) j++;
      out.push({ a: i, b: j, label: j - i === 11 ? y : `${y} (${monthShort(m[i])} – ${monthShort(m[j])})` });
      i = j + 1;
    }
  }
  return out;
}
function syncSlider() {
  const fr = playFrames(), sl = $("playSlider"), p = state.period;
  sl.max = fr.length;
  let v = 0;
  if (p.kind === "frame") v = p.n;
  else if (p.kind === "month") v = fr.findIndex((f) => f.a <= p.mi && p.mi <= f.b) + 1;
  sl.value = v;
  sl.style.setProperty("--p", fr.length ? (v / fr.length) * 100 + "%" : "0%");
}
function showFrame(n) {
  const fr = playFrames();
  state.period = n > 0 && fr[n - 1] ? { kind: "frame", n, ...fr[n - 1] } : { kind: "range" };
  renderMap();
}
async function startPlay() {
  const c = state.c;
  if (!(await needDetail()) || state.c !== c) return;   // every frame needs the full squares
  const fr = playFrames();
  if (fr.length < 2) { toast("Choose longer dates to play them"); return; }
  let n = state.period.kind === "frame" ? state.period.n : 0;
  if (n >= fr.length) n = 0;
  showFrame(n + 1);
  playTimer = setInterval(() => {
    const k = state.period.kind === "frame" ? state.period.n + 1 : 1;
    if (k > playFrames().length) { stopPlay(); return; }
    showFrame(k);
  }, reduceMotion ? 1600 : 1000);
  playButton();
}
function stopPlay() {
  if (!playTimer) return;
  clearInterval(playTimer);
  playTimer = null;
  playButton();
}
function playButton() {
  $("playBtn").innerHTML = playTimer
    ? '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg> Pause'
    : '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 5v14l12-7z"/></svg> Play';
  $("playBtn").setAttribute("aria-pressed", String(!!playTimer));
}

// ---- Area (drawn shape or typed box)
function useArea(layer, label) {
  if (state.area && state.area.layer !== layer) drawnGroup.removeLayer(state.area.layer);
  drawnGroup.addLayer(layer);
  const update = async () => {
    const c = state.c;
    // Area numbers add up squares month by month: they need the full squares.
    if (!(await needDetail()) || state.c !== c) return;
    state.area = { layer, label, feature: layer.toGeoJSON() };
    const cs = c.cell_size, geom = state.area.feature.geometry;
    state.selCells = new Set(c.cellKeys.filter((key) => {
      const [i, j] = key.split("_").map(Number);
      return insideShape((j + 0.5) * cs, (i + 0.5) * cs, geom);
    }));
    if (!state.selCells.size) toast("No fire squares inside this area. Try a bigger area inside " + countryName());
    render();
  };
  layer.on("pm:edit", update);
  update();
}
function clearArea(removeLayer) {
  if (state.area && removeLayer !== false) drawnGroup.removeLayer(state.area.layer);
  drawnGroup.clearLayers();
  state.area = null;
  state.selCells = null;
}

// ---- Fire dots for the whole planet (NASA FIRMS, drawn by NASA GIBS)
// For every day in the chosen window we add one transparent NASA picture
// of that day's fire dots (MODIS and/or VIIRS). 1 month = ~31 pictures.
let fireLayers = [], fireKey = "";

// The days the dots cover: one day, 3 or 7 days around the date, or the month.
function fireDays() {
  const f = state.fire, d = f.date;
  if (f.span === "month") {
    const n = new Date(Date.UTC(+d.slice(0, 4), +d.slice(5, 7), 0)).getUTCDate();
    return Array.from({ length: n }, (_, k) => `${d.slice(0, 7)}-${String(k + 1).padStart(2, "0")}`);
  }
  const n = +f.span, half = Math.floor(n / 2);
  return Array.from({ length: n }, (_, k) => dateOf(toUTC(d) + (k - half) * dayMs));
}

// Which NASA layer for each sensor on a given day
function fireLayersFor(day) {
  const out = [];
  if (state.fire.modis && day >= MODIS_FIRST)
    out.push(["modis", day < AQUA_FIRST ? "MODIS_Terra_Thermal_Anomalies_All" : "MODIS_Combined_Thermal_Anomalies_All"]);
  if (state.fire.viirs && day >= VIIRS_FIRST)
    out.push(["viirs", day <= SNPP_LAST ? "VIIRS_SNPP_Thermal_Anomalies_375m_All" : "VIIRS_NOAA20_Thermal_Anomalies_375m_All"]);
  return out;
}

function stepFire(dir) {
  const f = state.fire;
  if (f.span === "month") {
    const y = +f.date.slice(0, 4), m = +f.date.slice(5, 7) - 1 + dir;
    f.date = dateOf(Date.UTC(y, m, 15));
  } else {
    f.date = dateOf(toUTC(f.date) + dir * (+f.span) * dayMs);
  }
  f.date = f.date < MODIS_FIRST ? MODIS_FIRST : f.date > $("fireDate").max ? $("fireDate").max : f.date;
  f.on = true;
  renderMap();
}

function renderFire() {
  const f = state.fire, yesterday = $("fireDate").max;
  $("fireToggle").checked = f.on;
  $("fireDate").value = f.date || "";
  $("fireModis").checked = f.modis;
  $("fireViirs").checked = f.viirs;
  const days = f.on && f.date ? fireDays().filter((d) => d >= MODIS_FIRST && d <= yesterday) : [];
  const wanted = days.flatMap((d) => fireLayersFor(d).map(([s, l]) => `${s}|${l}|${d}`));
  const key = wanted.join(",");
  if (key !== fireKey) {                      // only rebuild when something changed
    fireLayers.forEach((l) => map.removeLayer(l));
    fireLayers = wanted.map((w) => {
      const [s, layer, day] = w.split("|");
      return L.tileLayer.wms(FIRE_WMS, {
        layers: layer, format: "image/png", transparent: true, version: "1.3.0", TIME: day,
        pane: s === "modis" ? "firesM" : "firesV", maxZoom: 18,
        attribution: 'Fire dots: NASA FIRMS via <a href="https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api">NASA GIBS</a>',
      }).addTo(map);
    });
    fireKey = key;
  }
  // Explain what is shown
  if (!f.on) { $("fireNote").textContent = "Every fire the satellites saw, for any day since November 2000, on the whole planet."; return; }
  const label = f.span === "month" ? monthLong(f.date.slice(0, 7))
    : days.length > 1 ? `${days[0]} – ${days[days.length - 1]}` : longDate(f.date);
  const notes = [`Showing ${label} (${days.length} day${days.length === 1 ? "" : "s"}), whole planet.`];
  if (f.viirs && days.length && days[days.length - 1] < VIIRS_FIRST) notes.push("VIIRS starts on 20 Jan 2012, so only MODIS dots here.");
  if (!f.modis && !f.viirs) notes.push("Tick MODIS or VIIRS to see dots.");
  notes.push("These are NASA's own dots: not cleaned (factories show too) and not clickable. The squares and the calendar use our cleaned data.");
  $("fireNote").textContent = notes.join(" ");
}

// ---- LIVE fires: last 48 hours, whole world, clickable (robot file)
const MAX_LIVE = 12000;          // more dots than this in view: show a sample
let live = null, liveLayer = null;

async function loadLive() {
  if (!live) {
    try { live = await getJSON("data/live/latest.json"); } catch (e) { live = { points: [], missing: true }; }
  }
  return live;
}

async function renderLive() {
  if (!liveLayer) return;
  liveLayer.clearLayers();
  $("liveToggle").checked = state.live;
  if (!state.live) { $("liveNote").textContent = "Every fire of the last 48 hours on the whole planet. Click a dot for details."; return; }
  $("liveNote").textContent = "Loading live fires…";
  const L0 = await loadLive();
  if (!state.live) return;
  if (L0.missing || !L0.points.length) { $("liveNote").textContent = "No live file yet (the robot has not run)."; return; }
  const b = map.getBounds().pad(0.05);
  let pts = L0.points.filter((p) => b.contains([p[0], p[1]]));
  const inView = pts.length;
  if (inView > MAX_LIVE) { const step = Math.ceil(inView / MAX_LIVE); pts = pts.filter((_, k) => k % step === 0); }
  const colM = css("--modis"), colV = css("--viirs"), r = map.getZoom() >= 7 ? 4 : 2.5;
  for (const p of pts) {
    const isM = p[2] === 0;
    L.circleMarker([p[0], p[1]], { renderer, pane: "live", radius: isM ? r + 1 : r, weight: isM ? 1.5 : 0.5,
      color: isM ? colM : "#ffffff", fillColor: isM ? colM : colV, fillOpacity: isM ? 0.3 : 0.9 })
      .on("click", (e) => livePopup(p, e.latlng)).addTo(liveLayer);
  }
  const hours = Math.max(0, (Date.now() - Date.parse(L0.updated_at)) / 3600000);
  $("liveNote").textContent = `${fmt(L0.points.length)} fires worldwide (updated ${hours < 1 ? "less than 1 h" : Math.round(hours) + " h"} ago). ` +
    `Showing ${fmt(pts.length)}${inView > MAX_LIVE ? ` of ${fmt(inView)}` : ""} in this view${inView > MAX_LIVE ? ": zoom in to see every dot" : ""}.`;
}

function livePopup(p, latlng) {
  const [lat, lon, s, day, time, frp, conf] = p;
  const t = String(time).padStart(4, "0"), sensor = live.sensors[s];
  const confText = s === 0 ? conf + "%" : ({ n: "nominal", h: "high", l: "low" }[String(conf).toLowerCase()[0]] || conf);
  L.popup().setLatLng(latlng).setContent(
    `<div class="pop"><b>Live fire · ${sensor}</b>
     <div class="row"><span>Lat, lon</span><b>${lat.toFixed(3)}, ${lon.toFixed(3)}</b></div>
     <div class="row"><span>Date</span><b>${dateOf(toUTC(live.base_date) + day * dayMs)}</b></div>
     <div class="row"><span>Time</span><b>${t.slice(0, 2)}:${t.slice(2)} UTC</b></div>
     <div class="row"><span>Confidence</span><b>${confText}</b></div>
     <div class="row"><span>Fire power (FRP)</span><b>${frp} MW</b></div>
     <div class="small">Near-real-time data from NASA FIRMS</div></div>`).openOn(map);
}

// The world first view is a special "country"
const isWorld = () => state.c && state.c.slug === "world";

// ------------------------------------------------------------------ BURNING CALENDAR
function calValue(i) {
  const s = state.series;
  if (state.calMode === "harmonized") return s.h[i];
  if (state.calMode === "modis") return s.modis[i];
  if (state.calMode === "viirs") return s.viirs[i];
  return anomaly(i);
}

function renderCalendar() {
  const c = state.c, s = state.series, [a, b] = rangeIdx();
  const mIndex = new Map(c.months.map((m, i) => [m, i]));
  const y0 = +state.from.slice(0, 4), y1 = +state.to.slice(0, 4);
  const anomalyMode = state.calMode === "anomaly";

  // One colour scale for the 3 count modes (max of harmonized in the range):
  // raw MODIS looks pale next to harmonized - that IS the problem we fix.
  let max = 0;
  for (let i = a; i <= b; i++) max = Math.max(max, s.h[i] || 0, s.viirs[i] || 0);

  const parts = ['<div></div>', ...MONTHS.map((m) => `<div class="h">${m}</div>`)];
  for (let y = y0; y <= y1; y++) {
    parts.push(`<div class="rl">${y}</div>`);
    for (let k = 1; k <= 12; k++) {
      const m = `${y}-${String(k).padStart(2, "0")}`, i = mIndex.get(m);
      const out = m < state.from || m > state.to;
      const v = i === undefined ? null : calValue(i);
      let cls = "c", style = "", label;
      if (i === undefined || (v === null && !anomalyMode)) {
        cls += " nodata"; label = "";
      } else if (anomalyMode) {
        if (v === null) { cls += " nodata"; label = "n/a"; }
        // white text only on the darkest blue and red (contrast >= 4.5:1)
        else { const d = divClass(v); style = `background:${DIV[d]}`; if (d === 0 || d === DIV.length - 1) cls += " dark-txt"; label = pct(v); }
      } else {
        const k2 = seqClass(v, max, "sqrt");
        if (k2 >= 0) { style = `background:${SEQ[k2]}`; if (k2 >= 5) cls += " dark-txt"; }
        else cls += " zero";
        label = compact(v);
      }
      if (out) cls += " out";
      if (m === c.inProgress) cls += " inprog";       // dashed: month not finished
      if (noaa20In(m)) cls += " n20";                 // used NOAA-20 on some days
      if (c.partial_months[m]) cls += " partial";
      else if (c.terra_only_months.includes(m)) cls += " terra";
      if (state.period.kind === "month" && state.period.mi === i) cls += " sel";
      style += `;--w:${(y - y0) * 35 + (k - 1) * 22}ms`;       // wave delay
      parts.push(`<button type="button" class="${cls}" style="${style}" data-i="${i ?? ""}" data-m="${m}" aria-label="${monthLong(m)}: ${label || "no data"}">${label}</button>`);
    }
  }
  const cal = $("cal");
  cal.innerHTML = parts.join("");
  // Wave only when the place, dates or view changed (not on a month click)
  const waveKey = `${c.slug}|${state.from}|${state.to}|${state.calMode}|${!!state.selCells}`;
  cal.classList.toggle("wave", waveKey !== cal.dataset.wave && !reduceMotion);
  cal.dataset.wave = waveKey;

  const modeName = { harmonized: "Fair count of fires", modis: "Fires MODIS saw", viirs: "Fires VIIRS saw", anomaly: "Compared to normal" }[state.calMode];
  $("calTitle").textContent = `Fire calendar · ${modeName}`;
  $("calSum").textContent = anomalyMode
    ? "Blue = fewer fires than normal, red = more."
    : "Same colours in every view: darker = more fires.";
  $("calNote").innerHTML = anomalyMode
    ? `Each month compared with its <b>normal</b> (the median of the same month, ${NORMAL_YEARS[0]}–${NORMAL_YEARS[1]}). Blue = fewer fires than normal, red = more.`
    : `All count views use <b>the same colours</b>. "MODIS saw" looks pale because MODIS misses small fires; the <b>fair count</b> makes old and new years comparable. <b>Click a month</b> to see it on the map.`;

  // Legend
  const marks = `<span><span class="mark"></span>satellite gap (part of the month missing)</span>` +
    `<span><span class="mark sq"></span>Terra only (before Jul 2002): converted with the Terra-only rate</span>` +
    (c.inProgress ? `<span><span class="s inprog-key"></span>month in progress (so far)</span>` : "") +
    (c.noaa20Days && c.noaa20Days.size ? `<span><span class="mark n20-key"></span>other VIIRS satellite (NOAA-20) on some days, adjusted</span>` : "") +
    `<span><span class="s" style="background:repeating-linear-gradient(45deg,var(--nodata-a) 0 3px,var(--nodata-b) 3px 6px)"></span>no data</span>`;
  $("scale").innerHTML = anomalyMode
    ? `<span class="ramp">${DIV.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>−75% … normal … +100%</span>${marks}`
    : `<span>Fewer</span><span class="ramp">${SEQ.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>More (up to ${compact(max)})</span>` +
      `<span><span class="s" style="background:var(--r0)"></span>0</span>${marks}`;
  writeHash();                 // keep the shareable link up to date
}

// Calendar tooltip + click (one listener for all cells)
function calTip(el) {
  const i = el.dataset.i === "" ? undefined : +el.dataset.i, m = el.dataset.m, c = state.c, s = state.series;
  if (i === undefined) return `<div class="tt">${monthLong(m)}</div>No data`;
  const nm = s.normal[+m.slice(5, 7) - 1];
  let html = `<div class="tt">${monthLong(m)}</div>` +
    `Fair count: <b>${fmt(s.h[i])}</b><br>MODIS saw: ${fmt(s.modis[i])}<br>VIIRS saw: ${s.viirs[i] === null ? "no data" : fmt(s.viirs[i])}` +
    `<br>Normal for this month: ${nm === null ? "n/a" : fmt(nm)} · ${pct(anomaly(i))}`;
  if (c.partial_months[m]) html += `<br><i>Partial month: ${c.partial_months[m]}</i>`;
  if (c.terra_only_months.includes(m)) html += `<br><i>Terra only: converted with the Terra-only rate</i>`;
  if (m === c.inProgress) {
    const D = soFar(+m.slice(5, 7)).D;
    html += `<br><i>In progress: ${D ? `days 1–${D} are complete` : "no complete day yet"}` +
      `${c.recentLastDay > (c.lastComplete || "") ? `, ${+c.recentLastDay.slice(8, 10)} ${MONTHS[+m.slice(5, 7) - 1]} is still loading` : ""}; ` +
      `compared with the same days of past years</i>`;
  }
  if (noaa20In(m)) html += `<br><i>Other VIIRS satellite (NOAA-20) on ${noaa20In(m)} day(s), adjusted to the S-NPP scale</i>`;
  else if (m > "2025-12") html += `<br><i>Current-year data (updated by the robot; recent days are near-real-time)</i>`;
  return html;
}
(() => {
  const cal = $("cal");
  const over = (e) => {
    const el = e.target.closest(".c");
    if (!el) return;
    const b = el.getBoundingClientRect();
    showTip(calTip(el), e.clientX ?? b.left + b.width / 2, e.clientY ?? b.top);
  };
  cal.addEventListener("mouseover", over);
  cal.addEventListener("mousemove", over);
  cal.addEventListener("focusin", (e) => { const el = e.target.closest(".c"); if (el) { const b = el.getBoundingClientRect(); showTip(calTip(el), b.left + b.width / 2, b.top); } });
  cal.addEventListener("mouseleave", hideTip);
  cal.addEventListener("focusout", hideTip);
  cal.addEventListener("click", (e) => {
    const el = e.target.closest(".c");
    if (!el || el.dataset.i === "") return;
    const m = el.dataset.m;
    stopPlay();
    state.period = { kind: "month", mi: +el.dataset.i };
    // The same month also drives "this month vs normal" and the satellite picture date.
    state.normalMonth = +m.slice(5, 7);
    state.normalYear = +m.slice(0, 4);
    state.gibs.date = picDate(m + "-15");
    if (state.fire.on) {                 // fire dots follow: the whole month
      Object.assign(state.fire, { date: picDate(m + "-15"), span: "month" });
      setSeg($("fireSpan"), "month");
    }
    renderMap();
    renderCalendar();
    renderNormal();
    renderHow();
    renderGibs();
    toast(`The map now shows ${monthLong(m)}`);
  });
})();

// ------------------------------------------------------------------ DAY VIEW
let dayChart;
function clampDay(d) {
  const last = dayAt(state.c.daily.modis.length - 1);
  return d < state.c.days_start ? state.c.days_start : d > last ? last : d;
}
function stepDay(delta) {
  state.day = clampDay(dateOf(toUTC(state.day) + delta * dayMs));
  renderDay();
}

function renderDay() {
  const c = state.c, d = state.day, i = dayIndex(d), daily = c.daily;
  $("dayInput").value = d;
  // The newest day may still be loading (near-real-time data).
  const partial = c.lastComplete && d > c.lastComplete && c.recentLastDay && d <= c.recentLastDay;
  $("dTitle").textContent = longDate(d) + (partial ? " (partial day, still loading)" : "");
  const m = d.slice(0, 7), place = isWorld() ? "world" : "country";
  const notes = [`Whole-${place} totals`];
  if (state.area) notes.push(`daily numbers are for the whole ${place}, not only your area`);
  if (c.noaa20Days && c.noaa20Days.has(d)) notes.push("other VIIRS satellite (NOAA-20), adjusted");
  if (c.partial_months[m]) notes.push(c.partial_months[m]);
  if (c.terra_only_months.includes(m)) notes.push("Terra only: converted with the Terra-only rate");
  $("dSub").textContent = notes.join(" · ");

  const rows = [["MODIS saw", daily.modis[i], "var(--modis)"], ["VIIRS saw", daily.viirs[i], "var(--viirs)"], ["Fair count", daily.harmonized[i], "var(--harm)"]];
  const top = Math.max(1, ...rows.map((r) => r[1] || 0));
  $("dStats").innerHTML = rows.map(([name, v, col]) =>
    `<div class="stat-row"><span>${name}</span><span class="bar"><i style="width:${v === null ? 0 : (v / top) * 100}%;background:${col}"></i></span>` +
    `<span class="val ${v === null ? "nd" : ""}">${v === null ? "no data" : fmt(v)}</span></div>`).join("");

  // Chart: 15 days before and after
  const a = Math.max(0, i - 15), b = Math.min(daily.modis.length - 1, i + 15);
  const labels = [], mo = [], vi = [], h = [];
  for (let k = a; k <= b; k++) { labels.push(dayAt(k).slice(5)); mo.push(daily.modis[k]); vi.push(daily.viirs[k]); h.push(daily.harmonized[k]); }
  dayChart.data.labels = labels;
  dayChart.data.datasets[0].data = mo;
  dayChart.data.datasets[1].data = vi;
  dayChart.data.datasets[2].data = h;
  dayChart.$sel = i - a;
  // From Feb 2012 harmonized = VIIRS, so the two lines lie on top of each other.
  const whole = isWorld() ? "Whole world" : "Whole country";
  $("dayHint").textContent = dayAt(a) >= "2012-02-01" ? `${whole} · from Feb 2012 the fair count = VIIRS (the lines overlap)` : whole;
  dayChart.update(reduceMotion ? "none" : undefined);
  writeHash();                 // keep the shareable link up to date
}

function buildDayChart() {
  dayChart = new Chart($("dayChart"), {
    type: "line",
    data: { labels: [], datasets: [
      // 3 different line patterns, so colour is never the only difference
      { label: "MODIS saw", data: [], borderWidth: 2.5, pointRadius: 0, tension: 0.25, borderDash: [2, 3] },
      { label: "VIIRS saw", data: [], borderWidth: 3, pointRadius: 0, tension: 0.25, spanGaps: false },
      { label: "Fair count", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25, borderDash: [7, 4] },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 800, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false },
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxTicksLimit: 8 } }, y: { beginAtZero: true } },
      onClick: (e, els) => { if (els.length) { stepDay(els[0].index - dayChart.$sel); } },
    },
    // A thin line marks the chosen day.
    plugins: [{ id: "selLine", afterDatasetsDraw(ch) {
      if (ch.$sel === undefined) return;
      const x = ch.scales.x.getPixelForValue(ch.$sel);
      if (Number.isNaN(x)) return;
      const g = ch.ctx; g.save(); g.strokeStyle = css("--brand"); g.lineWidth = 1.5;
      g.beginPath(); g.moveTo(x, ch.chartArea.top); g.lineTo(x, ch.chartArea.bottom); g.stroke(); g.restore();
    } }],
  });
  applyDayChartColors();
}
function applyDayChartColors() {
  const [m, v, h] = [css("--modis"), css("--viirs"), css("--harm")];
  const ds = dayChart.data.datasets;
  ds[0].borderColor = m; ds[1].borderColor = v; ds[2].borderColor = h;
  const sc = dayChart.options.scales;
  sc.x.ticks.color = sc.y.ticks.color = css("--axis");
  sc.x.grid = { color: css("--grid") }; sc.y.grid = { color: css("--grid") };
  dayChart.update("none");
}

// ------------------------------------------------------------------ SATELLITE PICTURE (NASA GIBS)
const GIBS_MODIS = "MODIS_Terra_CorrectedReflectance_Bands721";
const NOAA20_FIRST_DAY = "2018-01-05";       // first VIIRS NOAA-20 picture in GIBS
let gibsLayer = null, gibsUrl = "";

function renderGibs() {
  const g = state.gibs;
  $("gibsToggle").checked = g.on;
  $("gibsLayer").value = g.layer;
  $("gibsDate").value = g.date || "";
  let layer = g.layer, note = "Clicking a month in the calendar sets the picture date to the 15th of that month.";
  if (layer !== GIBS_MODIS && g.date < NOAA20_FIRST_DAY) {
    layer = GIBS_MODIS;
    note = "VIIRS NOAA-20 pictures start on 5 January 2018, so MODIS 7-2-1 is shown for this date.";
  }
  const url = g.on && g.date
    ? `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/${layer}/default/${g.date}/GoogleMapsCompatible_Level9/{z}/{y}/{x}.jpg` : "";
  if (url !== gibsUrl) {                    // only rebuild when something changed
    if (gibsLayer) map.removeLayer(gibsLayer);
    gibsLayer = url ? L.tileLayer(url, {
      pane: "gibs", maxNativeZoom: 9, maxZoom: 18,
      attribution: 'Imagery: <a href="https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api">NASA GIBS</a>',
    }).addTo(map) : null;
    gibsUrl = url;
  }
  $("gibsNote").textContent = (g.on && g.date ? `Picture of ${longDate(g.date)}. ` : "") + note;
  writeHash();                 // keep the shareable link up to date
}

// ------------------------------------------------------------------ PROOF CHART + THIS MONTH VS NORMAL
let proofChart, normalChart;
function buildProofCharts() {
  const base = {
    responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 800, easing: "easeOutQuart" },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
  };
  proofChart = new Chart($("proofChart"), {
    type: "line",
    data: { labels: [], datasets: [
      { label: "MODIS saw", data: [], borderWidth: 2, pointRadius: 0, borderDash: [2, 3] },
      { label: "VIIRS saw", data: [], borderWidth: 3, pointRadius: 0 },
      { label: "MODIS converted (rate × MODIS)", data: [], borderWidth: 2, pointRadius: 0, borderDash: [7, 4] },
    ] },
    options: { ...base, scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } }, y: { beginAtZero: true } } },
  });
  normalChart = new Chart($("normalChart"), {
    type: "bar",
    data: { labels: [], datasets: [
      { type: "line", label: "25%", data: [], pointRadius: 0, borderWidth: 0, fill: false, order: 3 },
      { type: "line", label: "middle 50% of years", data: [], pointRadius: 0, borderWidth: 0, fill: "-1", order: 3 },
      { type: "line", label: "normal (median)", data: [], pointRadius: 0, borderWidth: 2, borderDash: [6, 4], order: 1 },
      { type: "bar", label: "fires (fair count)", data: [], borderRadius: 3, order: 2 },
    ] },
    options: { ...base, interaction: { mode: "index", intersect: false },
      scales: { x: { ticks: { maxTicksLimit: 13 } }, y: { beginAtZero: true } },
      onClick: (e, els) => {
        if (!els.length) return;
        state.normalYear = +normalChart.data.labels[els[0].index];
        renderNormal();
      } },
  });
}
function chartChrome(ch) {
  const sc = ch.options.scales;
  sc.x.ticks.color = sc.y.ticks.color = css("--axis");
  sc.x.grid = { color: css("--grid") }; sc.y.grid = { color: css("--grid") };
}

// One verdict word from the hidden-years test (typical error and total bias, in %)
function verdict(e, bias) {
  if (e === null || e === undefined || bias === null || bias === undefined) return "not enough fires to test";
  const b = Math.abs(bias);
  if (e < 5 && b < 5) return "very good";
  if (e < 10 && b < 10) return "good";
  if (e < 20 && b < 20) return "OK";
  return "weak, use with care";
}

function renderProof() {
  if (!proofChart || !state.c) return;
  const c = state.c, s = state.series, rate = (m) => c.rates[String(+m.slice(5, 7))].rate;
  const idx = c.months.map((m, i) => [m, i]).filter(([m]) => m >= "2012-02" && m <= "2025-12");
  const ds = proofChart.data.datasets;
  proofChart.data.labels = idx.map(([m]) => monthShort(m));
  ds[0].data = idx.map(([, i]) => s.modis[i]);
  ds[1].data = idx.map(([, i]) => s.viirs[i]);
  ds[2].data = idx.map(([m, i]) => Math.round(rate(m) * s.modis[i]));
  [ds[0].borderColor, ds[1].borderColor, ds[2].borderColor] = [css("--modis"), css("--viirs"), css("--harm")];
  chartChrome(proofChart);
  proofChart.update();

  // How close are the lines (whole period)? And the honest hidden-years test.
  const sumV = idx.reduce((t, [, i]) => t + (s.viirs[i] || 0), 0);
  const sumH = ds[2].data.reduce((t, x) => t + x, 0);
  const v = c.validation;
  let html = `Over 2012–2025, MODIS converted with the exchange rates adds up to <b>${sumV ? Math.round((sumH / sumV) * 100) : "–"}%</b> of what VIIRS really saw ` +
    `(100% = the lines match). It is not exactly 100% because each month's rate is the middle value (median) of its yearly ratios, ` +
    `and middle values do not add up exactly to the total. ` +
    `<b>The fair test hides the answer:</b> rates learned only on 2015–2025 predicted the hidden 2012–2014 VIIRS months ` +
    `from MODIS alone, off by <b>${v.median_abs_error_pct ?? "–"}%</b> in a typical month, r = <b>${v.pearson_r ?? "–"}</b>, ` +
    `total bias <b>${pct(v.bias_pct)}</b>. Verdict: <b>${verdict(v.median_abs_error_pct, v.bias_pct)}</b>.`;
  if (state.area) html += ` <i>(Test numbers are for ${isWorld() ? "the whole world" : `all of ${countryName()}`}.)</i>`;
  if (c.rate_source === "global") html += ` <i>Few fires here, so the world median rate is used: this test says little.</i>`;
  $("proofNote").innerHTML = html;
  $("proofSum").innerHTML = `Converted MODIS = <b>${sumV ? Math.round((sumH / sumV) * 100) : "–"}%</b> of VIIRS · test: <b>${verdict(v.median_abs_error_pct, v.bias_pct)}</b>`;
}

function quantile(arr, q) {
  const a = arr.filter((x) => x !== null && !Number.isNaN(x)).sort((x, y) => x - y);
  if (!a.length) return null;
  const pos = (a.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
  return a[lo] + (a[hi] - a[lo]) * (pos - lo);
}

function renderNormal() {
  if (!normalChart || !state.c) return;
  const c = state.c, s = state.series, k = state.normalMonth;
  $("normalMonth").value = String(k);
  const rows = c.months.map((m, i) => [m, i]).filter(([m]) => +m.slice(5, 7) === k && m >= "2001-01");
  const years = rows.map(([m]) => m.slice(0, 4));
  const vals = rows.map(([, i]) => s.h[i]);
  const base = rows.filter(([m]) => +m.slice(0, 4) <= NORMAL_YEARS[1]).map(([, i]) => s.h[i]);
  const med = s.normal[k - 1], q25 = quantile(base, 0.25), q75 = quantile(base, 0.75);
  if (!years.includes(String(state.normalYear))) state.normalYear = +years[years.length - 1];

  const ds = normalChart.data.datasets, band = css("--harm");
  normalChart.data.labels = years;
  ds[0].data = years.map(() => q25);
  ds[1].data = years.map(() => q75);
  ds[1].backgroundColor = band + "40";
  ds[2].data = years.map(() => med);
  ds[2].borderColor = css("--ink");
  ds[3].data = vals;
  ds[3].backgroundColor = years.map((y) => (+y === state.normalYear ? css("--brand-solid") : css("--line-strong")));
  chartChrome(normalChart);
  normalChart.update();

  const yi = years.indexOf(String(state.normalYear)), val = vals[yi];
  const chosen = `${state.normalYear}-${String(k).padStart(2, "0")}`;
  if (chosen === c.inProgress) {
    // Unfinished month: compare with the same days of past years, not full months.
    const sf = soFar(k), an = sf.D > 0 && sf.normal > 0 ? ((sf.value - sf.normal) / sf.normal) * 100 : null;
    $("normalNote").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b> (blue bar) is <b>still in progress</b>: ` +
      `${fmt(sf.value)} fires (fair count) in its complete days 1–${sf.D}, <b>${an === null ? "no normal" : pct(an)}</b> vs the same days of ` +
      `${NORMAL_YEARS[0]}–${NORMAL_YEARS[1]} (normal = ${fmt(sf.normal)}). The other bars are full months. Click a bar to pick another year.`;
    $("normalSum").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b> so far: <b>${an === null ? "no normal" : pct(an)}</b> vs normal`;
    return;
  }
  const rank = 1 + vals.filter((x) => x > val).length;
  const an = med > 0 ? ((val - med) / med) * 100 : null;
  $("normalNote").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b> (blue bar): ${fmt(val)} fires (fair count), ` +
    `<b>${an === null ? "no normal to compare" : pct(an) + " vs normal"}</b> (normal = ${fmt(med)}). ` +
    `${ordinal(rank)} highest ${MONTHS_LONG[k - 1]} of ${years.length} years. ` +
    `Half of all years fall inside the green band (${fmt(q25)}–${fmt(q75)}). Click a bar to pick another year.`;
  $("normalSum").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b>: <b>${an === null ? "no normal" : pct(an) + " vs normal"}</b> · ${ordinal(rank)} highest of ${years.length}`;
}

// ------------------------------------------------------------------ HOW HOTSYNC WORKS (this country's numbers)
const STEP_NAMES = ["Only vegetation fires", "Confident detections", "Not a factory or gas flare"];

function renderHow() {
  const c = state.c;
  $("howCountry").textContent = `Numbers for ${c.name}`;

  // 1) Cleaning funnel, per sensor
  $("funnel").innerHTML = ["MODIS", "VIIRS"].map((sensor) => {
    const st = c.cleaning, loaded = st[0][sensor].before;
    if (!loaded) return "";
    let left = loaded;
    const rows = [`<div class="f-row"><span class="name">Loaded from FIRMS</span><span class="bar"><i style="width:100%;background:var(--muted)"></i></span><span class="val">${fmt(loaded)}</span></div>`];
    st.forEach((s, n) => {
      left -= s[sensor].removed;
      rows.push(`<div class="f-row ${n === st.length - 1 ? "final" : ""}" style="--i:${n + 1}"><span class="name" title="${s.step}">${STEP_NAMES[n] || s.step}</span>` +
        `<span class="bar"><i style="width:${(left / loaded) * 100}%;background:var(--${sensor.toLowerCase()})"></i></span>` +
        `<span class="val">${fmt(left)}<span class="rm">−${fmt(s[sensor].removed)}</span></span></div>`);
    });
    return `<div class="f-sensor"><div class="f-head"><b>${sensor}</b><span class="small">${Math.round((left / loaded) * 100)}% kept</span></div>${rows.join("")}</div>`;
  }).join("") + `<p class="small">${fmt(c.static_cells.count)} "always hot" places of about 1 km were found and removed (with the squares around them).</p>`;

  // 2) Exchange-rate table
  const k = state.normalMonth, max = Math.max(...Object.values(c.rates).map((r) => r.rate), 1);
  const r = c.rates[String(k)];
  $("rateSentence").innerHTML = `In <b>${MONTHS_LONG[k - 1]}</b>, 1 fire seen by MODIS = <b>${r.rate} fires seen by VIIRS</b> in ${countryName()}. ` +
    `VIIRS sees more because its pixels are smaller (375 m instead of 1 km). We use the median of the years, so one strange year can't move it much.` +
    (c.rate_source === "global" ? ` <b>Few fires here: all months use the world median rate.</b>` : "");
  $("rateBody").innerHTML = MONTHS_LONG.map((name, n) => {
    const x = c.rates[String(n + 1)], t = c.rates_terra[String(n + 1)];
    const tag = x.src === "pooled" ? " <span class='small'>(all-year median: too few years)</span>" : x.src === "global" ? " <span class='small'>(world rate)</span>" : "";
    return `<tr class="${n + 1 === k ? "cur" : ""}"><td>${name.slice(0, 3)}</td>` +
      `<td><span class="rbar"><i style="width:${(x.rate / max) * 70}px"></i><b>${x.rate}</b>${tag}</span></td>` +
      `<td class="num">${x.q25 === null ? "–" : `${x.q25}–${x.q75}`}</td><td class="num">${x.n}</td><td class="num">${t.rate}</td></tr>`;
  }).join("");

  // 3) Validation ("hide the answer")
  const v = c.validation, e = v.median_abs_error_pct;
  const word = verdict(e, v.bias_pct);           // same verdict as the proof chart
  $("validBox").innerHTML =
    `<div class="valid-num">` +
    `<div><b>${e ?? "–"}%</b><span>typical month off by</span></div>` +
    `<div><b>${v.pearson_r ?? "–"}</b><span>correlation r (1 = perfect)</span></div>` +
    `<div><b>${pct(v.bias_pct)}</b><span>total bias</span></div>` +
    `<div><b>${v.loyo_mean_error_pct ?? "–"}%</b><span>leave-one-year-out (${v.loyo_years} years)</span></div></div>` +
    `<p class="small">We <b>hid</b> the real VIIRS numbers for Feb 2012 – Dec 2014, learned the exchange rates only from 2015–2025, ` +
    `and predicted the hidden months from MODIS. Then we compared with the real VIIRS: <b>${word}</b>. ` +
    `Leave-one-year-out does the same for every year 2012–2025, one at a time.</p>`;

  // 4) A country note in "Limits" when this country's numbers need care
  const avg = Object.values(c.rates).reduce((t, x) => t + x.rate, 0) / 12;
  const notes = [];
  if (c.rate_source === "global") notes.push("it has very few fires, so it uses the world median exchange rate");
  if (avg < 1.5) notes.push(`its exchange rate is unusually low (${avg.toFixed(1)}): MODIS sees hot places here that VIIRS does not count as fires`);
  if (avg > 10) notes.push(`its exchange rate is unusually high (${avg.toFixed(1)}): non-vegetation heat (lava, gas flares) may be left in the data`);
  if (e !== null && e > 40) notes.push(`the hidden-years test is rough (${e}%), so the converted years before Feb 2012 are less certain`);
  $("countryLimits").hidden = !notes.length;
  $("countryLimits").innerHTML = notes.length ? `<b>Note for ${c.name}:</b> ${notes.join("; ")}.` : "";
}

// ------------------------------------------------------------------ TABLE + DOWNLOADS
function monthlyRows() {
  const c = state.c, s = state.series, [a, b] = rangeIdx(), rows = [];
  for (let i = a; i <= b; i++) {
    const an = anomaly(i);
    rows.push({ month: c.months[i], modis_raw: s.modis[i], viirs_raw: s.viirs[i], harmonized: s.h[i],
      normal_median: s.normal[+c.months[i].slice(5, 7) - 1], vs_normal_pct: an === null ? null : Math.round(an) });
  }
  return rows;
}

function renderTable() {
  $("tbody").innerHTML = monthlyRows().reverse().map((r) =>
    `<tr><td>${monthShort(r.month)}</td><td class="num">${fmt(r.modis_raw)}</td>` +
    `<td class="num ${r.viirs_raw === null ? "nd" : ""}">${r.viirs_raw === null ? "no data" : fmt(r.viirs_raw)}</td>` +
    `<td class="num">${fmt(r.harmonized)}</td>` +
    `<td class="num ${!r.vs_normal_pct ? "" : r.vs_normal_pct > 0 ? "up" : "down"}">${pct(r.vs_normal_pct)}</td></tr>`).join("");
}

function saveCSV(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
const fileTag = () => `hotsync_${state.c.slug}${state.area ? "_area" : ""}_${state.from}_${state.to}`;

function downloadMonthly() {
  const rows = monthlyRows().map((r) => ({ country: state.c.name, area: state.area ? state.area.label : isWorld() ? "whole world" : "whole country", ...r }));
  saveCSV(Papa.unparse(rows), fileTag() + "_monthly.csv");
  toast(`Downloaded ${rows.length} months`);
}

// ------------------------------------------------------------------ PAGE FEEL (animations, compact picker)
// Place or dates change: the content fades out and back in (opacity only,
// so nothing jumps).
function fadeOut() { if (!reduceMotion) document.querySelector("main").classList.add("changing"); closePickPanel(); }
function fadeIn() { requestAnimationFrame(() => document.querySelector("main").classList.remove("changing")); }

// The picker (Place · Dates · Share) stays in its place at the top. When it
// scrolls out of view, a small pill bar appears: "United States · May 2025 –
// Sep 2025 [Change]". Clicking it opens the full picker as a panel; a click
// outside or Esc closes it. Its empty place in the page keeps the same height
// (the "slot"), so the content below never jumps.
var pickOpen = false;          // var: chooseCountry may call closePickPanel early
function closePickPanel(focusBar) {
  if (!pickOpen) return;
  pickOpen = false;
  const box = document.querySelector(".controls.filters"), slot = $("pickSlot");
  box.classList.remove("as-panel");
  slot.style.height = "";
  $("pickBar").classList.remove("open");
  $("pickBarBtn").setAttribute("aria-expanded", "false");
  if (focusBar) $("pickBarBtn").focus();
}
function setupPickBar() {
  const box = document.querySelector(".controls.filters"), slot = $("pickSlot");
  const bar = $("pickBar"), btn = $("pickBarBtn");
  const show = (on) => {
    bar.classList.toggle("show", on);
    bar.setAttribute("aria-hidden", String(!on));
    btn.tabIndex = on ? 0 : -1;
    if (!on) closePickPanel();
  };
  // The bar shows when the picker's slot has scrolled up under the header.
  new IntersectionObserver(([en]) => show(!en.isIntersecting && en.boundingClientRect.top < 0),
    { rootMargin: "-70px 0px 0px 0px" }).observe(slot);
  btn.addEventListener("click", () => {
    if (pickOpen) { closePickPanel(); return; }
    pickOpen = true;
    slot.style.height = slot.offsetHeight + "px";       // keep the space
    box.classList.add("as-panel");
    bar.classList.add("open");
    btn.setAttribute("aria-expanded", "true");
    box.tabIndex = -1;                                    // keyboard focus goes into the panel
    box.focus({ preventScroll: true });
  });
  // Click outside closes it (the date pop-up, globe and lists are not "outside")
  document.addEventListener("pointerdown", (e) => {
    if (!pickOpen) return;
    const t = e.target;
    if (box.contains(t) || bar.contains(t) || t.closest(".dp, .dp-back, .gmodal, .place-list")) return;
    closePickPanel();
  });
  // Esc closes it, unless a pop-up inside it is open (that one closes first).
  // (Capture phase: we look before the pop-up closes itself.)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !pickOpen) return;
    if (document.querySelector(".dp.open, .gmodal.open") || $("countryInput").getAttribute("aria-expanded") === "true") return;
    closePickPanel(true);
  }, true);
}

// "More ▾", "Why fair count?" and the accordions: opening fades the text in
// (CSS); closing fades it out first, then closes. Esc closes the one you are in.
function setupToggles() {
  document.querySelectorAll("details.more, .acc > details, details.why, details.map-more").forEach((d) => {
    d.querySelector(":scope > summary").addEventListener("click", (e) => {
      if (!d.open || reduceMotion) return;
      e.preventDefault();
      d.classList.add("closing");
      setTimeout(() => { d.open = false; d.classList.remove("closing"); }, 180);
    });
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const d = document.activeElement && document.activeElement.closest("details[open]");
    if (d) { d.open = false; d.querySelector(":scope > summary").focus(); }
  });
}

// ------------------------------------------------------------------ SCROLL EFFECTS
// The exchange-rate badge opens its explanation (click, Esc or a click outside closes)
function setupRateBadge() {
  const btn = $("rateBadge"), pop = $("ratePop");
  const set = (on) => { pop.hidden = !on; btn.setAttribute("aria-expanded", String(on)); };
  btn.addEventListener("click", (e) => { e.stopPropagation(); set(pop.hidden); });
  document.addEventListener("click", (e) => { if (!pop.hidden && !pop.contains(e.target)) set(false); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !pop.hidden) { set(false); btn.focus(); } });
}

// Page load: header + summary parts fade in one after another (80 ms apart).
// Scroll: sections fade in when they come into view; cards in a row one by one.
function shown(el) {
  el.classList.add("in");
  setTimeout(() => el.style.removeProperty("--d"), 1200);    // hover lift without delay later
  const delay = parseFloat(el.style.getPropertyValue("--d")) || 0;
  setTimeout(() => {
    el.querySelectorAll("[data-final]").forEach(countUp);    // numbers count up from 0
    el.querySelectorAll("canvas").forEach((cv) => {           // charts draw / grow
      const ch = window.Chart && Chart.getChart(cv);
      if (ch) { ch.reset(); ch.update(); }
    });
  }, delay);
}

function setupReveal() {
  document.querySelectorAll(".load-in").forEach((el, i) => el.style.setProperty("--i", i));
  document.querySelectorAll(".kpis").forEach((row) => [...row.children].forEach((el, i) => el.style.setProperty("--d", i * 70 + "ms")));
  const els = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((list) => list.forEach((en) => { if (en.isIntersecting) { shown(en.target); io.unobserve(en.target); } }), { threshold: 0.08 });
  els.forEach((e) => io.observe(e));
}
function setupScrollSpy() {
  const links = [...document.querySelectorAll("nav.sections a")];
  const io = new IntersectionObserver((list) => list.forEach((en) => {
    if (en.isIntersecting) links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + en.target.id));
  }), { rootMargin: "-40% 0px -55% 0px" });
  links.forEach((a) => { const s = document.querySelector(a.getAttribute("href")); if (s) io.observe(s); });
}

start();
