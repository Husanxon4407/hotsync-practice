/*
  HotSync: app.js  (Stage 4: website core)

  Reads the files that process_all.py made:
    data/countries.json          list of countries (for the country picker)
    data/country/<slug>.json     one country: monthly totals, squares, daily
    data/points/<slug>/<y>.csv   every fire dot (showcase countries only)
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
  dailies.forEach((d) => {
    if (!d) return;
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
  // Map squares of each new month
  const cellObjs = await Promise.all(newMonths.map((m) => loadRecentCells(m, c.slug)));
  newMonths.forEach((m, k) => {
    const mi = c.months.indexOf(m);          // month_index = place in c.months
    for (const [key, [mo, vi, fm, fv]] of Object.entries(cellObjs[k])) (c.cells[key] ||= []).push([mi, mo, vi, vi, fm, fv]);
  });
  c.recentLastDay = lastDay;
  c.inProgress = lastDay < monthEnd(lastDay.slice(0, 7)) ? lastDay.slice(0, 7) : null;
}

// "Updated 3 hours ago · data to 14 Nov 2026"
function renderUpdated() {
  const chip = $("updatedChip");
  if (!recent.meta) { chip.hidden = true; return; }
  const hours = Math.max(0, (Date.now() - Date.parse(recent.meta.last_updated)) / 3600000);
  const ago = hours < 1 ? "less than 1 hour ago" : hours < 48 ? `${Math.round(hours)} h ago` : `${Math.round(hours / 24)} days ago`;
  chip.hidden = false;
  chip.textContent = `🔄 Updated ${ago} · data to ${new Date(toUTC(recent.meta.last_day_with_data)).toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" })}`;
  chip.title = `Last update: ${recent.meta.last_updated} (UTC). A robot on GitHub adds new fires from NASA FIRMS.`;
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
  $("countryList").innerHTML = state.countries.map((c) => `<option value="${c.name}"></option>`).join("");
  buildControls();
  initMap();
  buildDayChart();
  buildProofCharts();
  setupReveal();
  setupScrollSpy();
  renderUpdated();
  await chooseCountry(DEFAULT_COUNTRY);
}

// Load one country (only when it is chosen) and keep it in memory.
async function chooseCountry(slug) {
  const info = state.countries.find((c) => c.slug === slug);
  if (!info) return;
  $("countryInput").value = info.name;
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
  setLoading("");
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
  if (!state.gibs.date) state.gibs.date = last + "-15";
  if (!state.fire.date) state.fire.date = last + "-15";
  clearArea(false);
  setupDateInputs();
  buildSquares();
  fitCountry();
  render();
}

// ------------------------------------------------------------------ CONTROLS
function buildControls() {
  // Country: pick from the list (typing filters it).
  const input = $("countryInput");
  const pick = () => {
    const v = input.value.trim().toLowerCase();
    const hit = state.countries.find((c) => c.name.toLowerCase() === v);
    if (hit && (!state.c || hit.slug !== state.c.slug)) chooseCountry(hit.slug);
  };
  input.addEventListener("change", pick);
  // Picking from the list fires "input" without a typing type: load at once.
  // While the user is still typing ("Niger" -> "Nigeria") we wait for Enter.
  input.addEventListener("input", (e) => { if (!e.inputType || e.inputType === "insertReplacementText") pick(); });
  input.addEventListener("blur", () => { if (state.c) input.value = state.c.name; });
  input.addEventListener("focus", () => input.select());

  // Dates
  const onDates = () => {
    let a = $("fromMonth").value, b = $("toMonth").value;
    if (!a || !b) return;
    if (a > b) [a, b] = [b, a];   // the user swapped them: fix it quietly
    state.from = a; state.to = b;
    state.period = { kind: "range" };
    render();
  };
  $("fromMonth").addEventListener("change", onDates);
  $("toMonth").addEventListener("change", onDates);
  $("allTimeBtn").addEventListener("click", () => {
    const m = state.c.months;
    state.from = DEFAULT_FROM < m[0] ? m[0] : DEFAULT_FROM;
    state.to = m[m.length - 1];
    state.period = { kind: "range" };
    setupDateInputs();
    render();
  });
  $("resetAreaBtn").addEventListener("click", () => { clearArea(true); render(); });

  // Calendar mode + square mode
  makeSeg($("calSeg"), [["harmonized", "Harmonized"], ["modis", "Raw MODIS"], ["viirs", "Raw VIIRS"], ["anomaly", "Anomaly"]],
    state.calMode, (k) => { state.calMode = k; renderCalendar(); });
  makeSeg($("squareSeg"), [["harmonized", "Harmonized"], ["modis", "MODIS"], ["viirs", "VIIRS"], ["off", "None"]],
    state.squareMode, (k) => { state.squareMode = k; renderMap(); });

  $("periodResetBtn").addEventListener("click", () => { state.period = { kind: "range" }; render(); });

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

function setupDateInputs() {
  const m = state.c.months;
  for (const id of ["fromMonth", "toMonth"]) {
    $(id).min = m[0];
    $(id).max = m[m.length - 1];
  }
  $("fromMonth").value = state.from;
  $("toMonth").value = state.to;
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
  // A month still in progress is compared with the SAME DAYS of past years.
  if (s.h[i] === null || s.h[i] === undefined) return null;     // no data
  const nm = m === state.c.inProgress ? soFar(k).normal : s.normal[k - 1];
  return nm > 0 ? ((s.h[i] - nm) / nm) * 100 : null;
};

// The unfinished month: days 1..D. For each year 2001-2025, add up the
// harmonized daily numbers of the same days; "normal" = the median.
// (Daily numbers are for the whole country; a drawn area is scaled by its
// share of the country's normal for the full month.)
function soFar(k) {
  const c = state.c, d = c.daily.harmonized, D = +c.recentLastDay.slice(8, 10), vals = [];
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
  }
  return { normal, vals, D };
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
}

// When the theme changes, things drawn with JS colours must be repainted.
function recolor() {
  renderMap();
  applyDayChartColors();
  renderProof();     // these two read their colours from CSS each time
  renderNormal();
}

// "the United Kingdom", "the Netherlands", but "Brazil"
const NEEDS_THE = /^(United|Netherlands|Philippines|Bahamas|Gambia|Maldives|Czech|Dominican|Central African|Democratic|Republic|Solomon|Marshall|Cayman|Falkland|Faeroe|British|Virgin|Comoros|Seychelles)/;
const countryName = () => (isWorld() ? "the whole world" : NEEDS_THE.test(state.c.name) ? "the " + state.c.name : state.c.name);
const areaName = () => (state.area ? `the drawn area in ${countryName()}` : countryName());

function renderHeader() {
  const c = state.c;
  $("heroArea").textContent = state.area ? `${c.name} · ${state.area.label}` : c.name;
  $("heroRange").textContent = `${monthShort(state.from)} – ${monthShort(state.to)}`;
  $("areaChip").textContent = state.area ? state.area.label : "Whole country";
  $("resetAreaBtn").hidden = !state.area;

  // Exchange-rate picture: 1 MODIS ring = N VIIRS dots (average of 12 months)
  const rates = Object.values(c.rates).map((r) => r.rate);
  const avg = rates.reduce((a, b) => a + b, 0) / rates.length;
  $("exNum").textContent = avg.toFixed(1);
  const full = Math.min(12, Math.floor(avg)), part = avg - Math.floor(avg);
  let dots = "";
  for (let k = 0; k < full; k++) dots += `<span class="ex-dot" style="animation-delay:${k * 60}ms"></span>`;
  if (part > 0.05 && full < 12) dots += `<span class="ex-dot part"><i style="width:${Math.round(part * 100)}%"></i></span>`;
  $("exDots").innerHTML = dots;
  $("exCap").innerHTML = `VIIRS hotspots for every 1 MODIS hotspot in ${countryName()} (the "exchange rate", average of 12 months)` +
    (isWorld() ? ". Every country uses its own rate; pick a country to see it" : "") +
    (c.rate_source === "global" ? ". <b>Few fires here, so we use the world median rate.</b>" : "");
}

// ------------------------------------------------------------------ SUMMARY CARDS + SENTENCE
// "Real fire numbers": what the satellites actually counted (after cleaning,
// no exchange rate), like the cards of the first prototype.
function renderRealStats() {
  const c = state.c, s = state.series, [a, b] = rangeIdx();
  let mo = 0, vi = 0, fm = 0, fv = 0, viMonths = 0;
  for (let i = a; i <= b; i++) {
    mo += s.modis[i]; fm += s.frpM[i];
    if (s.viirs[i] !== null) { vi += s.viirs[i]; fv += s.frpV[i]; viMonths++; }
  }
  const years = (b - a + 1) / 12;
  $("kModis").textContent = compact(mo);
  $("kModisS").textContent = `${fmt(mo)} detections · ${compact(mo / years)} per year`;
  $("kViirs").textContent = viMonths ? compact(vi) : "no data";
  $("kViirsS").textContent = viMonths
    ? `${fmt(vi)} detections · ${compact(vi / (viMonths / 12))} per year (from Jan 2012)` : "VIIRS starts in January 2012";

  // Busiest day in the range (daily numbers are for the whole country/world)
  const d = c.daily, i0 = Math.max(0, dayIndex(state.from + "-01"));
  const endDay = dateOf(Date.UTC(+state.to.slice(0, 4), +state.to.slice(5, 7), 0));
  const i1 = Math.min(d.harmonized.length - 1, dayIndex(endDay));
  let best = i0;
  for (let i = i0; i <= i1; i++) if ((d.harmonized[i] || 0) > (d.harmonized[best] || 0)) best = i;
  const day = dayAt(best);
  $("kBusyDay").textContent = new Date(toUTC(day)).toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
  $("kBusyDayS").textContent = `${fmt(d.harmonized[best])} harmonized hotspots` + (state.area ? " (whole country)" : "");
  $("kBusyDayCard").dataset.day = day;

  // Fire strength: average fire radiative power (FRP) per detection
  const useV = vi > 0, frp = useV ? fv / vi : mo ? fm / mo : 0;
  $("kFrp").textContent = frp ? frp.toFixed(1) + " MW" : "–";
  $("kFrpS").textContent = `average per ${useV ? "VIIRS" : "MODIS"} detection` +
    (useV && mo ? ` · MODIS: ${(fm / mo).toFixed(1)} MW (bigger pixels)` : "");
}

function renderCards() {
  const c = state.c, s = state.series, [a, b] = rangeIdx();
  const idx = [];
  for (let i = a; i <= b; i++) idx.push(i);

  // 1. Total harmonized
  const total = idx.reduce((t, i) => t + (s.h[i] || 0), 0);
  $("kTotal").textContent = compact(total);
  $("kTotalS").textContent = `${fmt(total)} in ${idx.length} months`;

  // 2. Busiest calendar month (average over the selected years)
  const sums = new Array(12).fill(0), counts = new Array(12).fill(0);
  idx.forEach((i) => { if (s.h[i] === null) return; const k = +c.months[i].slice(5, 7) - 1; sums[k] += s.h[i]; counts[k]++; });
  const avgs = sums.map((x, k) => (counts[k] ? x / counts[k] : -1));
  const busy = avgs.indexOf(Math.max(...avgs));
  $("kBusy").textContent = MONTHS_LONG[busy];
  $("kBusyS").textContent = `${fmt(avgs[busy])} hotspots on average`;

  // 3. Top 3 years (full years inside the range if possible)
  const byYear = {};
  idx.forEach((i) => { const y = c.months[i].slice(0, 4); (byYear[y] = byYear[y] || { t: 0, n: 0 }); byYear[y].t += s.h[i] || 0; byYear[y].n++; });
  let years = Object.entries(byYear).filter(([, v]) => v.n === 12);
  if (years.length < 3) years = Object.entries(byYear);
  years.sort((x, y) => y[1].t - x[1].t);
  const top = years.slice(0, 3);
  $("kTop").textContent = top.map(([y]) => y).join(" · ");
  $("kTopS").textContent = top.map(([, v]) => compact(v.t)).join(" · ") + " hotspots";

  // 4. Latest complete month vs its normal (+ rank among the same month)
  const li = c.months.length - 1, lm = c.months[li], k = +lm.slice(5, 7) - 1;
  const an = anomaly(li), going = lm === c.inProgress;
  if (going) {
    // Month in progress: "so far" vs the same days of 2001-2025
    const sf = soFar(k + 1), mine = state.area ? null : s.h[li];
    const rank = mine === null ? null : 1 + sf.vals.filter((x) => x > mine).length;
    $("kLatest").textContent = pct(an);
    $("kLatestS").textContent = `${MONTHS_LONG[k]} ${lm.slice(0, 4)} so far (1–${sf.D}), vs the same days of 2001–2025` +
      (rank ? ` · ${ordinal(rank)} highest of ${sf.vals.length + 1}` : "");
  } else {
    const same = c.months.map((m, i) => [m, i]).filter(([m]) => +m.slice(5, 7) === k + 1 && m >= "2001-01");
    const rank = 1 + same.filter(([, i]) => s.h[i] > s.h[li]).length;
    $("kLatest").textContent = pct(an);
    $("kLatestS").textContent = `${monthLong(lm)}: ${ordinal(rank)} highest ${MONTHS_LONG[k]} since 2001`;
  }

  // Sentence built from the numbers
  const firstYear = c.months[a].slice(0, 4);
  let text = `In ${areaName()}, <b>${MONTHS_LONG[busy]}</b> is usually the busiest month. `;
  if (top.length) text += `<b>${top[0][0]}</b> had the most fires of all the years from ${firstYear} to ${c.months[b].slice(0, 4)}. `;
  const lmName = going ? `${monthLong(lm)} so far` : monthLong(lm), verb = going ? "is" : "was";
  text += an === null
    ? `${lmName} has no normal to compare with (almost no fires in past ${MONTHS_LONG[k]}s).`
    : Math.abs(Math.round(an)) < 1
      ? `${lmName} ${verb} <b>about normal</b>.`
      : `${lmName} ${verb} <b>${Math.abs(Math.round(an))}% ${an >= 0 ? "above" : "below"} normal</b>${going ? " for the same days" : ""}.`;
  $("summary").innerHTML = text;
  $("heroTitle").innerHTML = `${compact(total)} fair-to-compare hotspots in ${state.area ? "your area" : countryName()}, ${monthShort(state.from)} – ${monthShort(state.to)}`;
}

// ------------------------------------------------------------------ MAP
let map, squareLayer, dotLayer, drawnGroup, renderer;
const squares = new Map();      // key -> Leaflet rectangle

function initMap() {
  renderer = L.canvas({ padding: 0.5 });    // canvas = fast with many shapes
  // scrollWheelZoom off at first: scrolling the PAGE over the map must not
  // zoom the map. A click on the map turns wheel zoom on; leaving turns it off.
  map = L.map("map", { preferCanvas: true, zoomSnap: 0.5, worldCopyJump: true, scrollWheelZoom: false }).setView([41.4, 64.6], 5);
  map.on("click", () => map.scrollWheelZoom.enable());
  map.on("mouseout", () => map.scrollWheelZoom.disable());
  L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
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

function fitCountry() {
  if (isWorld()) { map.setView([20, 10], 2); return; }
  const [w, s, e, n] = state.c.bbox;
  if (e - w <= 180) { map.fitBounds([[s, w], [n, e]], { padding: [10, 10] }); return; }
  // Countries across the 180° line (Russia, Fiji...) have a box around the
  // whole world. Zoom to the half (east or west) that has most fire squares.
  const rects = [...squares.values()];
  const east = rects.filter((r) => r.getBounds().getCenter().lng >= 0);
  const west = rects.filter((r) => r.getBounds().getCenter().lng < 0);
  const side = east.length >= west.length ? east : west;
  map.fitBounds(side.length ? L.featureGroup(side).getBounds() : [[s, w], [n, e]], { padding: [10, 10] });
}

// One rectangle per square (built once per country, re-coloured on change).
function buildSquares() {
  squareLayer.clearLayers();
  squares.clear();
  const cs = state.c.cell_size;
  for (const key of Object.keys(state.c.cells)) {
    const [i, j] = key.split("_").map(Number);
    const rect = L.rectangle([[i * cs, j * cs], [(i + 1) * cs, (j + 1) * cs]],
      { renderer, weight: 0.4, color: "#ffffff", fillOpacity: 0.85 });
    rect.on("click", (e) => squarePopup(key, e.latlng));
    squares.set(key, rect);
    rect.addTo(squareLayer);
  }
}

// Month index range the map shows.
function mapRange() {
  const p = state.period, m = state.c.months;
  if (p.kind === "month") return [p.mi, p.mi];
  if (p.kind === "day") { const i = m.indexOf(p.day.slice(0, 7)); return [i, i]; }
  return rangeIdx();
}
const FIELD = { modis: 1, viirs: 2, harmonized: 3 };

// Sum of one square over the map months: [modis, viirs, h]
function squareSum(key, a, b) {
  const out = [0, 0, 0];
  for (const r of state.c.cells[key]) {
    if (r[0] >= a && r[0] <= b) { out[0] += r[1]; out[1] += r[2]; out[2] += r[3]; }
  }
  return out;
}

function renderMap() {
  if (!state.c) return;
  const [a, b] = mapRange(), off = state.squareMode === "off";
  const f = off ? 2 : FIELD[state.squareMode] - 1;
  const vals = new Map();
  let max = 0;
  for (const key of squares.keys()) {
    const v = squareSum(key, a, b)[f];
    vals.set(key, v);
    if ((!state.selCells || state.selCells.has(key)) && v > max) max = v;
  }
  const edge = css("--card-solid") || "#fff";
  for (const [key, rect] of squares) {
    const v = vals.get(key), k = seqClass(v, max);
    const inside = !state.selCells || state.selCells.has(key);
    // With a satellite picture under them, squares get see-through.
    const full = state.gibs.on ? 0.35 : 0.85;
    rect.setStyle(k < 0 || off            // "None": hide the squares (see the picture)
      ? { fillOpacity: 0, opacity: 0 }
      : { fillColor: SEQ[k], color: edge, opacity: inside ? 0.6 : 0.1, fillOpacity: inside ? full : 0.1 });
  }

  // "The map shows ..." text
  const p = state.period, m = state.c.months;
  $("mapPeriod").textContent = p.kind === "range" ? `${monthShort(m[a])} – ${monthShort(m[b])} (sum)`
    : p.kind === "month" ? monthLong(m[a]) : `${longDate(p.day)}`;
  $("periodResetBtn").hidden = p.kind === "range";

  // Legend
  const sq = { harmonized: "harmonized", modis: "raw MODIS", viirs: "raw VIIRS" }[state.squareMode];
  let leg = off ? `<span class="key">Squares hidden</span>`
    : `<span class="key"><span class="ramp" style="display:inline-flex">${SEQ.map((c) => `<i style="width:12px;height:10px;display:block;background:${c}"></i>`).join("")}</span> ${sq} hotspots per ${state.c.cell_size}° square (1 → ${compact(max)})</span>`;
  if (state.selCells && !off) leg += `<span class="key"><span class="sw" style="background:${SEQ[3]};opacity:.2"></span> outside your area</span>`;
  if (state.fire.on || state.live) {
    leg += `<span class="key"><span class="dot" style="background:var(--modis)"></span> MODIS fire dot</span>`;
    leg += `<span class="key"><span class="dot" style="background:var(--viirs)"></span> VIIRS fire dot</span>`;
  }
  $("mapLegend").innerHTML = leg;

  renderAreaStats(a, b);
  renderFire();
}

function squarePopup(key, latlng) {
  const [a, b] = mapRange(), m = state.c.months, cs = state.c.cell_size;
  const [i, j] = key.split("_").map(Number);
  const [mo, vi, h] = squareSum(key, a, b);
  const lat = (x) => `${Math.abs(x).toFixed(2)}°${x >= 0 ? "N" : "S"}`;
  const lon = (x) => `${Math.abs(x).toFixed(2)}°${x >= 0 ? "E" : "W"}`;
  const viirsNote = m[b] < "2012-01" ? "no data (before 2012)" : fmt(vi);
  L.popup().setLatLng(latlng).setContent(
    `<div class="pop"><b>Square ${lat(i * cs)}–${lat((i + 1) * cs)}, ${lon(j * cs)}–${lon((j + 1) * cs)}</b>
     <div class="small">${a === b ? monthLong(m[a]) : `${monthShort(m[a])} – ${monthShort(m[b])}`}</div>
     <div class="row"><span>MODIS raw</span><b>${fmt(mo)}</b></div>
     <div class="row"><span>VIIRS raw</span><b>${viirsNote}</b></div>
     <div class="row"><span>Harmonized</span><b>${fmt(h)}</b></div>
     ${state.selCells && !state.selCells.has(key) ? '<div class="small">Outside your area</div>' : ""}</div>`).openOn(map);
}

function renderAreaStats(a, b) {
  const keys = state.selCells ? [...state.selCells] : [...squares.keys()];
  // Same monthly series as the cards and the calendar, so all numbers match.
  const s = state.series, sum = [0, 0, 0];
  for (let i = a; i <= b; i++) { sum[0] += s.modis[i]; sum[1] += s.viirs[i] || 0; sum[2] += s.h[i]; }
  const m = state.c.months;
  $("areaStats").innerHTML =
    `<b>${state.area ? state.area.label : isWorld() ? "Whole world" : "Whole country"}</b> · ${keys.length.toLocaleString("en-US")} squares with fires<br>` +
    `${a === b ? monthLong(m[a]) : `${monthShort(m[a])} – ${monthShort(m[b])}`}: ` +
    `MODIS <b>${fmt(sum[0])}</b> · VIIRS <b>${m[b] < "2012-01" ? "no data" : fmt(sum[1])}</b> · harmonized <b>${fmt(sum[2])}</b>` +
    (state.area ? `<br><span class="small">${isWorld() ? "Every square uses its own country's exchange rates." : `A drawn area uses ${state.c.name}'s exchange rates.`} Squares count if their centre is inside.</span>` : "");
}

// ---- Area (drawn shape or typed box)
function useArea(layer, label) {
  if (state.area && state.area.layer !== layer) drawnGroup.removeLayer(state.area.layer);
  drawnGroup.addLayer(layer);
  const update = () => {
    state.area = { layer, label, feature: layer.toGeoJSON() };
    const cs = state.c.cell_size, feat = state.area.feature;
    state.selCells = new Set(Object.keys(state.c.cells).filter((key) => {
      const [i, j] = key.split("_").map(Number);
      return turf.booleanPointInPolygon(turf.point([(j + 0.5) * cs, (i + 0.5) * cs]), feat);
    }));
    if (!state.selCells.size) toast("No fire squares inside this area. Try a bigger area inside " + state.c.name);
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
  notes.push("These are NASA's raw dots (not cleaned, so factories show too) and can't be clicked. Squares and the calendar use our cleaned data.");
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
      if (c.partial_months[m]) cls += " partial";
      else if (c.terra_only_months.includes(m)) cls += " terra";
      if (state.period.kind === "month" && state.period.mi === i) cls += " sel";
      parts.push(`<button type="button" class="${cls}" style="${style}" data-i="${i ?? ""}" data-m="${m}" aria-label="${monthLong(m)}: ${label || "no data"}">${label}</button>`);
    }
  }
  const cal = $("cal");
  cal.innerHTML = parts.join("");

  const modeName = { harmonized: "Harmonized hotspots", modis: "Raw MODIS hotspots", viirs: "Raw VIIRS hotspots", anomaly: "Anomaly vs normal" }[state.calMode];
  $("calTitle").textContent = `Burning calendar · ${modeName}`;
  $("calNote").innerHTML = anomalyMode
    ? `Each month compared with its <b>normal</b> (the median of the same month, ${NORMAL_YEARS[0]}–${NORMAL_YEARS[1]}). Blue = fewer fires than normal, red = more.`
    : `The 3 count modes share <b>one colour scale</b>. Raw MODIS looks pale because it misses small fires; harmonized makes old and new years fair to compare. Click a month to show it on the map.`;

  // Legend
  const marks = `<span><span class="mark"></span>satellite gap (part of the month missing)</span>` +
    `<span><span class="mark sq"></span>Terra only (before Jul 2002): converted with the Terra-only rate</span>` +
    (c.inProgress ? `<span><span class="s inprog-key"></span>month in progress (so far)</span>` : "") +
    `<span><span class="s" style="background:repeating-linear-gradient(45deg,var(--nodata-a) 0 3px,var(--nodata-b) 3px 6px)"></span>no data</span>`;
  $("scale").innerHTML = anomalyMode
    ? `<span class="ramp">${DIV.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>−75% … normal … +100%</span>${marks}`
    : `<span>Fewer</span><span class="ramp">${SEQ.map((c) => `<i style="background:${c}"></i>`).join("")}</span><span>More (up to ${compact(max)})</span>` +
      `<span><span class="s" style="background:var(--r0)"></span>0</span>${marks}`;
}

// Calendar tooltip + click (one listener for all cells)
function calTip(el) {
  const i = el.dataset.i === "" ? undefined : +el.dataset.i, m = el.dataset.m, c = state.c, s = state.series;
  if (i === undefined) return `<div class="tt">${monthLong(m)}</div>No data`;
  const nm = s.normal[+m.slice(5, 7) - 1];
  let html = `<div class="tt">${monthLong(m)}</div>` +
    `Harmonized: <b>${fmt(s.h[i])}</b><br>MODIS raw: ${fmt(s.modis[i])}<br>VIIRS raw: ${s.viirs[i] === null ? "no data" : fmt(s.viirs[i])}` +
    `<br>Normal (median): ${nm === null ? "n/a" : fmt(nm)} · ${pct(anomaly(i))}`;
  if (c.partial_months[m]) html += `<br><i>Partial month: ${c.partial_months[m]}</i>`;
  if (c.terra_only_months.includes(m)) html += `<br><i>Terra only: converted with the Terra-only rate</i>`;
  if (m === c.inProgress) html += `<br><i>In progress: so far, 1–${+c.recentLastDay.slice(8, 10)} ${MONTHS[+m.slice(5, 7) - 1]}; compared with the same days of past years</i>`;
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
    state.period = { kind: "month", mi: +el.dataset.i };
    // The same month also drives "this month vs normal" and the satellite picture date.
    state.normalMonth = +m.slice(5, 7);
    state.normalYear = +m.slice(0, 4);
    state.gibs.date = m + "-15";
    if (state.fire.on) {                 // fire dots follow: the whole month
      Object.assign(state.fire, { date: m + "-15", span: "month" });
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
  $("dTitle").textContent = longDate(d);
  const m = d.slice(0, 7);
  const notes = ["Whole-country totals"];
  if (state.area) notes.push("daily numbers are for the whole country, not only your area");
  if (c.partial_months[m]) notes.push(c.partial_months[m]);
  if (c.terra_only_months.includes(m)) notes.push("Terra only: harmonized with the Terra-only rate");
  $("dSub").textContent = notes.join(" · ");

  const rows = [["MODIS raw", daily.modis[i], "var(--modis)"], ["VIIRS raw", daily.viirs[i], "var(--viirs)"], ["Harmonized", daily.harmonized[i], "var(--harm)"]];
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
  $("dayHint").textContent = dayAt(a) >= "2012-02-01" ? "Whole country · after Feb 2012 harmonized = VIIRS (lines overlap)" : "Whole country";
  dayChart.update(reduceMotion ? "none" : undefined);
}

function buildDayChart() {
  dayChart = new Chart($("dayChart"), {
    type: "line",
    data: { labels: [], datasets: [
      // 3 different line patterns, so colour is never the only difference
      { label: "MODIS raw", data: [], borderWidth: 2.5, pointRadius: 0, tension: 0.25, borderDash: [2, 3] },
      { label: "VIIRS raw", data: [], borderWidth: 3, pointRadius: 0, tension: 0.25, spanGaps: false },
      { label: "Harmonized", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25, borderDash: [7, 4] },
    ] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 400 },
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
}

// ------------------------------------------------------------------ PROOF CHART + THIS MONTH VS NORMAL
let proofChart, normalChart;
function buildProofCharts() {
  const base = {
    responsive: true, maintainAspectRatio: false, animation: reduceMotion ? false : { duration: 400 },
    interaction: { mode: "index", intersect: false },
    plugins: { legend: { display: false } },
  };
  proofChart = new Chart($("proofChart"), {
    type: "line",
    data: { labels: [], datasets: [
      { label: "MODIS raw", data: [], borderWidth: 2, pointRadius: 0, borderDash: [2, 3] },
      { label: "VIIRS raw", data: [], borderWidth: 3, pointRadius: 0 },
      { label: "Harmonized MODIS (rate × MODIS)", data: [], borderWidth: 2, pointRadius: 0, borderDash: [7, 4] },
    ] },
    options: { ...base, scales: { x: { ticks: { maxTicksLimit: 8, autoSkip: true } }, y: { beginAtZero: true } } },
  });
  normalChart = new Chart($("normalChart"), {
    type: "bar",
    data: { labels: [], datasets: [
      { type: "line", label: "25%", data: [], pointRadius: 0, borderWidth: 0, fill: false, order: 3 },
      { type: "line", label: "middle 50% of years", data: [], pointRadius: 0, borderWidth: 0, fill: "-1", order: 3 },
      { type: "line", label: "normal (median)", data: [], pointRadius: 0, borderWidth: 2, borderDash: [6, 4], order: 1 },
      { type: "bar", label: "harmonized hotspots", data: [], borderRadius: 3, order: 2 },
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
  proofChart.update("none");

  // How close are the lines (whole period)? And the honest hidden-years test.
  const sumV = idx.reduce((t, [, i]) => t + (s.viirs[i] || 0), 0);
  const sumH = ds[2].data.reduce((t, x) => t + x, 0);
  const v = c.validation;
  let html = `Over 2012–2025, harmonized MODIS adds up to <b>${sumV ? Math.round((sumH / sumV) * 100) : "–"}%</b> of the real VIIRS count ` +
    `(100% = the lines match). These rates were learned on all of 2012–2025, so the lines should match. ` +
    `<b>The fair test hides the answer:</b> rates learned only on 2015–2025 predicted the hidden 2012–2014 VIIRS months ` +
    `from MODIS alone, off by <b>${v.median_abs_error_pct ?? "–"}%</b> in a typical month, r = <b>${v.pearson_r ?? "–"}</b>, ` +
    `total bias <b>${pct(v.bias_pct)}</b>.`;
  if (state.area) html += ` <i>(Test numbers are for the whole of ${countryName()}.)</i>`;
  if (c.rate_source === "global") html += ` <i>Few fires here, so the world median rate is used: this test says little.</i>`;
  $("proofNote").innerHTML = html;
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
  normalChart.update("none");

  const yi = years.indexOf(String(state.normalYear)), val = vals[yi];
  const chosen = `${state.normalYear}-${String(k).padStart(2, "0")}`;
  if (chosen === c.inProgress) {
    // Unfinished month: compare with the same days of past years, not full months.
    const sf = soFar(k), an = sf.normal > 0 ? ((val - sf.normal) / sf.normal) * 100 : null;
    $("normalNote").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b> (blue bar) is <b>still in progress</b>: ` +
      `${fmt(val)} harmonized hotspots in days 1–${sf.D}, <b>${an === null ? "no normal" : pct(an)}</b> vs the same days of ` +
      `${NORMAL_YEARS[0]}–${NORMAL_YEARS[1]} (normal = ${fmt(sf.normal)}). The other bars are full months. Click a bar to pick another year.`;
    return;
  }
  const rank = 1 + vals.filter((x) => x > val).length;
  const an = med > 0 ? ((val - med) / med) * 100 : null;
  $("normalNote").innerHTML = `<b>${MONTHS_LONG[k - 1]} ${state.normalYear}</b> (blue bar): ${fmt(val)} harmonized hotspots, ` +
    `<b>${an === null ? "no normal to compare" : pct(an) + " vs normal"}</b> (normal = ${fmt(med)}). ` +
    `${ordinal(rank)} highest ${MONTHS_LONG[k - 1]} of ${years.length} years. ` +
    `Half of all years fall inside the green band (${fmt(q25)}–${fmt(q75)}). Click a bar to pick another year.`;
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
  $("rateSentence").innerHTML = `In <b>${MONTHS_LONG[k - 1]}</b>, 1 MODIS hotspot = <b>${r.rate} VIIRS hotspots</b> in ${countryName()}. ` +
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
  const word = e === null ? "not enough fires to test" : e < 15 ? "very good" : e < 30 ? "good" : "rough (few fires)";
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
  if (e !== null && e > 40) notes.push(`the hidden-years test is rough (${e}%), so harmonized years before 2012 are less certain`);
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
  const rows = monthlyRows().map((r) => ({ country: state.c.name, area: state.area ? state.area.label : "whole country", ...r }));
  saveCSV(Papa.unparse(rows), fileTag() + "_monthly.csv");
  toast(`Downloaded ${rows.length} months`);
}

// ------------------------------------------------------------------ SCROLL EFFECTS
function setupReveal() {
  const els = document.querySelectorAll(".reveal");
  if (reduceMotion || !("IntersectionObserver" in window)) { els.forEach((e) => e.classList.add("in")); return; }
  const io = new IntersectionObserver((list) => list.forEach((en) => { if (en.isIntersecting) { en.target.classList.add("in"); io.unobserve(en.target); } }), { threshold: 0.08 });
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
