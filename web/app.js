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
const DEFAULT_COUNTRY = "uzbekistan";
const DEFAULT_FROM = "2001-01";
const NORMAL_YEARS = [2001, 2025];          // "normal" = median of these years
const SHOWCASE = new Set(["uzbekistan", "argentina"]);   // have fire dots
const MAX_DOT_MONTHS = 3;                    // dots only for short periods
const MAX_DOTS = 15000;                      // more than this: show a sample
const MAX_DOT_YEARS_CSV = 3;                 // dots CSV: at most 3 years
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
  dots: false,
};
const points = new Map();     // "slug/year" -> array of fire dots (CSV)

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

async function start() {
  try {
    setLoading("Loading the country list…");
    state.countries = await getJSON("data/countries.json");
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
  setupReveal();
  setupScrollSpy();
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
  setLoading("");
  state.c = data;
  const last = data.months[data.months.length - 1];
  // Keep the user's dates if they still fit, otherwise use the default.
  state.to = !state.to || state.to > last ? last : state.to;
  if (state.from < data.months[0]) state.from = data.months[0];
  state.day = dayAt(data.daily.modis.length - 1);   // latest day with data
  state.period = { kind: "range" };
  state.dots = false;
  $("dotsToggle").checked = false;
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
  makeSeg($("squareSeg"), [["harmonized", "Harmonized"], ["modis", "MODIS"], ["viirs", "VIIRS"]],
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

  // Dots
  $("dotsToggle").addEventListener("change", (e) => { state.dots = e.target.checked; renderDots(); });

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
    state.dots = true;
    $("dotsToggle").checked = true;
    renderMap();
    $("where").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth" });
  });

  // Downloads
  $("dlMonthly").addEventListener("click", downloadMonthly);
  $("dlPoints").addEventListener("click", downloadPoints);
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
  let modis, viirs, h;
  if (!state.selCells) {
    modis = c.totals.modis.slice();
    viirs = c.totals.viirs.slice();
    h = c.totals.harmonized.slice();
  } else {
    modis = new Array(n).fill(0); viirs = new Array(n).fill(0); h = new Array(n).fill(0);
    for (const key of state.selCells) {
      for (const r of c.cells[key]) { modis[r[0]] += r[1]; viirs[r[0]] += r[2]; h[r[0]] += r[3]; }
    }
    // VIIRS has no data before 2012: keep it "no data", not 0.
    c.totals.viirs.forEach((v, i) => { if (v === null) viirs[i] = null; });
    h = h.map((x) => Math.round(x * 10) / 10);
  }
  const normal = MONTHS.map((_, k) => median(c.months
    .map((m, i) => [m, i])
    .filter(([m]) => +m.slice(5, 7) === k + 1 && +m.slice(0, 4) >= NORMAL_YEARS[0] && +m.slice(0, 4) <= NORMAL_YEARS[1])
    .map(([, i]) => h[i])));
  state.series = { modis, viirs, h, normal };
}
const anomaly = (i) => {
  const s = state.series, nm = s.normal[+state.c.months[i].slice(5, 7) - 1];
  return nm > 0 ? ((s.h[i] - nm) / nm) * 100 : null;
};

// ------------------------------------------------------------------ RENDER
function render() {
  computeSeries();
  renderHeader();
  renderCards();
  renderMap();
  renderCalendar();
  renderDay();
  renderTable();
}

// When the theme changes, things drawn with JS colours must be repainted.
function recolor() {
  renderMap();
  applyDayChartColors();
}

// "the United Kingdom", "the Netherlands", but "Brazil"
const NEEDS_THE = /^(United|Netherlands|Philippines|Bahamas|Gambia|Maldives|Czech|Dominican|Central African|Democratic|Republic|Solomon|Marshall|Cayman|Falkland|Faeroe|British|Virgin|Comoros|Seychelles)/;
const countryName = () => (NEEDS_THE.test(state.c.name) ? "the " + state.c.name : state.c.name);
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
  $("exCap").innerHTML = `VIIRS hotspots for every 1 MODIS hotspot in ${c.name} (the "exchange rate", average of 12 months)` +
    (c.rate_source === "global" ? ". <b>Few fires here, so we use the world median rate.</b>" : "");
}

// ------------------------------------------------------------------ SUMMARY CARDS + SENTENCE
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
  idx.forEach((i) => { const k = +c.months[i].slice(5, 7) - 1; sums[k] += s.h[i] || 0; counts[k]++; });
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
  const an = anomaly(li);
  const same = c.months.map((m, i) => [m, i]).filter(([m]) => +m.slice(5, 7) === k + 1 && m >= "2001-01");
  const rank = 1 + same.filter(([, i]) => s.h[i] > s.h[li]).length;
  $("kLatest").textContent = pct(an);
  $("kLatestS").textContent = `${monthLong(lm)}: ${ordinal(rank)} highest ${MONTHS_LONG[k]} since 2001`;

  // Sentence built from the numbers
  const firstYear = c.months[a].slice(0, 4);
  let text = `In ${areaName()}, <b>${MONTHS_LONG[busy]}</b> is usually the busiest month. `;
  if (top.length) text += `<b>${top[0][0]}</b> had the most fires since ${firstYear}. `;
  text += an === null
    ? `${monthLong(lm)} has no normal to compare with (almost no fires in past ${MONTHS_LONG[k]}s).`
    : Math.abs(Math.round(an)) < 1
      ? `${monthLong(lm)} was <b>about normal</b>.`
      : `${monthLong(lm)} was <b>${Math.abs(Math.round(an))}% ${an >= 0 ? "above" : "below"} normal</b>.`;
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
  map.on("pm:create", (e) => useArea(e.layer, e.shape === "Rectangle" ? "Drawn box" : "Drawn shape"));
  map.on("pm:remove", (e) => { if (state.area && e.layer === state.area.layer) { clearArea(true); render(); } });
}

function fitCountry() {
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
  const [a, b] = mapRange(), f = FIELD[state.squareMode] - 1;
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
    rect.setStyle(k < 0
      ? { fillOpacity: 0, opacity: 0 }
      : { fillColor: SEQ[k], color: edge, opacity: inside ? 0.6 : 0.1, fillOpacity: inside ? 0.85 : 0.15 });
  }

  // "The map shows ..." text
  const p = state.period, m = state.c.months;
  $("mapPeriod").textContent = p.kind === "range" ? `${monthShort(m[a])} – ${monthShort(m[b])} (sum)`
    : p.kind === "month" ? monthLong(m[a]) : `${longDate(p.day)}`;
  $("periodResetBtn").hidden = p.kind === "range";

  // Legend
  const sq = { harmonized: "harmonized", modis: "raw MODIS", viirs: "raw VIIRS" }[state.squareMode];
  let leg = `<span class="key"><span class="ramp" style="display:inline-flex">${SEQ.map((c) => `<i style="width:12px;height:10px;display:block;background:${c}"></i>`).join("")}</span> ${sq} hotspots per ${state.c.cell_size}° square (1 → ${compact(max)})</span>`;
  if (state.selCells) leg += `<span class="key"><span class="sw" style="background:${SEQ[3]};opacity:.2"></span> outside your area</span>`;
  if (SHOWCASE.has(state.c.slug)) {
    leg += `<span class="key"><span class="dot" style="background:var(--modis)"></span> MODIS dot</span>`;
    leg += `<span class="key"><span class="dot" style="background:var(--viirs)"></span> VIIRS dot</span>`;
  }
  $("mapLegend").innerHTML = leg;

  renderAreaStats(a, b);
  renderDots();
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
    `<b>${state.area ? state.area.label : "Whole country"}</b> · ${keys.length.toLocaleString("en-US")} squares with fires<br>` +
    `${a === b ? monthLong(m[a]) : `${monthShort(m[a])} – ${monthShort(m[b])}`}: ` +
    `MODIS <b>${fmt(sum[0])}</b> · VIIRS <b>${m[b] < "2012-01" ? "no data" : fmt(sum[1])}</b> · harmonized <b>${fmt(sum[2])}</b>` +
    (state.area ? `<br><span class="small">A drawn area uses ${state.c.name}'s exchange rates. Squares count if their centre is inside.</span>` : "");
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

// ---- Fire dots (showcase countries)
function loadPointsYear(slug, year) {
  const key = `${slug}/${year}`;
  if (points.has(key)) return Promise.resolve(points.get(key));
  return new Promise((resolve) => {
    Papa.parse(`data/points/${slug}/${year}.csv`, {
      download: true, header: true, skipEmptyLines: true,
      dynamicTyping: { lat: true, lon: true, frp: true },
      complete: (res) => { points.set(key, res.data); resolve(res.data); },
      error: () => { points.set(key, []); resolve([]); },
    });
  });
}

// Dates the dots cover: one day, or the map's months.
function dotWindow() {
  const p = state.period, m = state.c.months;
  if (p.kind === "day") return [p.day, p.day];
  const [a, b] = mapRange();
  if (b - a + 1 > MAX_DOT_MONTHS) return null;
  const end = new Date(Date.UTC(+m[b].slice(0, 4), +m[b].slice(5, 7), 0)).toISOString().slice(0, 10);
  return [m[a] + "-01", end];
}

function insideArea(p) {
  return !state.area || turf.booleanPointInPolygon(turf.point([p.lon, p.lat]), state.area.feature);
}

let dotsJob = 0;
async function renderDots() {
  const c = state.c, showcase = SHOWCASE.has(c.slug);
  $("dotsField").hidden = !showcase;
  $("dayDotsBtn").hidden = !showcase;
  dotLayer.clearLayers();
  $("mapMsg").textContent = "";
  if (!showcase || !state.dots) { $("dotsNote").textContent = showcase ? "Every single fire detection, for a short period." : ""; return; }
  const win = dotWindow();
  if (!win) {
    $("dotsNote").textContent = `Dots are shown for up to ${MAX_DOT_MONTHS} months: click a month in the calendar, or pick a day.`;
    $("mapMsg").textContent = "Click a month in the calendar to see its fire dots";
    return;
  }
  const job = ++dotsJob;
  const years = [...new Set([win[0].slice(0, 4), win[1].slice(0, 4)])];
  $("mapMsg").textContent = "Loading fire dots…";
  const rows = (await Promise.all(years.map((y) => loadPointsYear(c.slug, y)))).flat();
  if (job !== dotsJob) return;          // the user changed something meanwhile
  let pts = rows.filter((p) => p.date >= win[0] && p.date <= win[1] && insideArea(p));
  const total = pts.length;
  if (total > MAX_DOTS) { const step = Math.ceil(total / MAX_DOTS); pts = pts.filter((_, k) => k % step === 0); }
  const colM = css("--modis"), colV = css("--viirs");
  for (const p of pts) {
    const isM = p.sensor === "MODIS";
    L.circleMarker([p.lat, p.lon], {
      renderer, radius: isM ? 4 : 2.6, weight: isM ? 1.6 : 0.6,
      color: isM ? colM : "#ffffff", fillColor: isM ? colM : colV, fillOpacity: isM ? 0.25 : 0.9,
    }).on("click", (e) => dotPopup(p, e.latlng)).addTo(dotLayer);
  }
  $("mapMsg").textContent = "";
  $("dotsNote").textContent = total
    ? `${fmt(total)} fire dots${total > MAX_DOTS ? ` (showing a sample of ${fmt(pts.length)})` : ""}. Click a dot for details.`
    : "No fire dots in this area and period.";
}

function dotPopup(p, latlng) {
  const sat = { N: "Suomi NPP", Terra: "Terra", Aqua: "Aqua", "1": "NOAA-20", N20: "NOAA-20" }[p.satellite] || p.satellite;
  const conf = p.sensor === "VIIRS" ? ({ n: "nominal", h: "high", l: "low" }[p.confidence] || p.confidence) : p.confidence + "%";
  const t = String(p.time).padStart(4, "0");
  L.popup().setLatLng(latlng).setContent(
    `<div class="pop"><b>${p.sensor} fire dot</b>
     <div class="row"><span>Lat, lon</span><b>${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</b></div>
     <div class="row"><span>Date</span><b>${p.date}</b></div>
     <div class="row"><span>Time</span><b>${t.slice(0, 2)}:${t.slice(2)} UTC</b></div>
     <div class="row"><span>Satellite</span><b>${sat}</b></div>
     <div class="row"><span>Confidence</span><b>${conf}</b></div>
     <div class="row"><span>Fire power (FRP)</span><b>${p.frp} MW</b></div></div>`).openOn(map);
}

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
        else { const d = divClass(v); style = `background:${DIV[d]}`; if (d <= 1 || d >= 7) cls += " dark-txt"; label = pct(v); }
      } else {
        const k2 = seqClass(v, max, "sqrt");
        if (k2 >= 0) { style = `background:${SEQ[k2]}`; if (k2 >= 5) cls += " dark-txt"; }
        else cls += " zero";
        label = compact(v);
      }
      if (out) cls += " out";
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
    state.period = { kind: "month", mi: +el.dataset.i };
    renderMap();
    renderCalendar();
    toast(`The map now shows ${monthLong(el.dataset.m)}`);
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
      { label: "MODIS raw", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25 },
      { label: "VIIRS raw", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25, spanGaps: false },
      { label: "Harmonized", data: [], borderWidth: 2, pointRadius: 0, tension: 0.25, borderDash: [6, 4] },
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
  const showcase = SHOWCASE.has(state.c.slug);
  $("dlPoints").hidden = !showcase;
  $("firmsLink").hidden = showcase;
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

async function downloadPoints() {
  const y0 = +state.from.slice(0, 4), y1 = +state.to.slice(0, 4);
  if (y1 - y0 + 1 > MAX_DOT_YEARS_CSV) { toast(`Choose at most ${MAX_DOT_YEARS_CSV} years for the fire dots CSV`); return; }
  setLoading("Preparing fire dots…");
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const rows = (await Promise.all(years.map((y) => loadPointsYear(state.c.slug, y)))).flat();
  const end = new Date(Date.UTC(+state.to.slice(0, 4), +state.to.slice(5, 7), 0)).toISOString().slice(0, 10);
  const pts = rows.filter((p) => p.date >= state.from + "-01" && p.date <= end && insideArea(p));
  setLoading("");
  saveCSV(Papa.unparse(pts), fileTag() + "_fire_dots.csv");
  toast(`Downloaded ${fmt(pts.length)} fire dots`);
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
