/*
  HotSync practice: app.js
  Reads data/summary.json (made by process.py) and draws every section.
  No numbers are typed in here: everything comes from the JSON.

  The big idea of this file: ONE "state" object holds what the user picked
  (which day, which ratio, which sensors). When something changes, we call
  render(), and render() updates every section from the state.
  So the map, chart, calendar and table always agree with each other.
*/

// ------------------------------------------------------------------ STATE
const state = {
  data: null,          // summary.json
  ratioKey: "overlap", // which ratio method we use (changed by the buttons)
  day: null,           // null = whole month, or index 0..30 of the day
  show: { MODIS: true, VIIRS: true },
  timer: null,         // the "Play" timer
};

// The 4 ratio methods. "why" explains each one in simple words.
const RATIOS = [
  { key: "total", short: "Total", name: "Total, all days",
    why: (d) => `Adds up the whole month. But it also counts ${noDataText(d)}, when VIIRS sent <b>no data</b>, as if VIIRS saw nothing. So the rate comes out <b>too small</b>.` },
  { key: "overlap", short: "Both days", name: "Total, days both saw fires",
    why: (d) => `Adds up only the <b>${d.ratio.days_used} days</b> when both cameras saw fires. No-data days can't make it smaller, and the month total of harmonized MODIS matches VIIRS exactly. <b>Our main choice.</b>` },
  { key: "median_daily", short: "Median", name: "Median of daily ratios",
    why: () => `Takes every day's own ratio, sorts them and picks the <b>middle one</b>. One strange day (like 36 VIIRS vs 1 MODIS) can't pull it away. <b>The safest</b> against crazy days.` },
  { key: "grid_cells", short: "Grid", name: "Grid cells (10 km squares)",
    why: () => `Counts fire <b>places</b> (10 km squares), not dots. If VIIRS puts 5 dots on one fire, the square counts once. Close to the others here, because we already removed the factories with hundreds of dots.` },
];

// Nice names for the cleaning rules from process.py
const RULE_NAMES = {
  "type == 0": "Only vegetation fires",
  "inside Uzbekistan box": "Inside Uzbekistan",
};
function ruleName(rule) {
  if (RULE_NAMES[rule]) return RULE_NAMES[rule];
  if (rule.startsWith("confidence")) return "Confident detections";
  if (rule.startsWith("not at ")) return "Not a factory: " + rule.slice(7).replace(" site", "");
  return rule;
}

// ------------------------------------------------------------------ HELPERS
const $ = (id) => document.getElementById(id);
const fmt = (n) => Number(n).toLocaleString("en-US");
const fmt1 = (n) => (Math.round(n * 10) / 10).toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });
// We add T00:00 so the browser doesn't move the day because of time zones.
const asDate = (d) => new Date(d + "T00:00");
const shortDate = (d) => asDate(d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
const longDate = (d) => asDate(d).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" });
const dayNum = (d) => Number(d.slice(8, 10));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

function noDataText(d) {
  const nd = d.no_data_days.viirs;
  return nd.length ? nd.map(shortDate).join(", ") : "no days";
}
function monthName(d) {
  return asDate(d.month + "-01").toLocaleDateString("en-US", { month: "long", year: "numeric" });
}
// The ratio value we use right now
const ratio = () => state.data.ratio[state.ratioKey];
// Harmonized MODIS for one day = MODIS raw × ratio (we compute it here, so
// the ratio buttons can change it live)
const harm = (row) => (row.modis_raw === null ? null : Math.round(row.modis_raw * ratio() * 10) / 10);
// Is this day's VIIRS / MODIS ratio defined? (both saw at least one fire)
const dayRatio = (row) => (row.modis_raw > 0 && row.viirs_raw > 0 ? row.viirs_raw / row.modis_raw : null);

// Numbers that count up from 0 when they first appear (feels alive)
function countUp(el, to, { decimals = 0, suffix = "" } = {}) {
  const show = (v) => (decimals ? v.toFixed(decimals) : fmt(Math.round(v))) + suffix;
  if (reduceMotion) { el.textContent = show(to); return; }
  const from = Number(el.dataset.now || 0);
  const t0 = performance.now(), dur = 900;
  const step = (t) => {
    const k = Math.min(1, (t - t0) / dur);
    const e = 1 - Math.pow(1 - k, 3); // ease-out: fast start, soft stop
    el.textContent = show(from + (to - from) * e);
    if (k < 1) requestAnimationFrame(step);
  };
  el.dataset.now = to;
  requestAnimationFrame(step);
}

// One floating tooltip, shared by the calendar, the ratio dots and the "?" buttons
const tip = $("tip");
function showTip(html, x, y) {
  tip.innerHTML = html;
  tip.classList.add("show");
  const r = tip.getBoundingClientRect();
  // keep it inside the window
  const left = Math.min(window.innerWidth - r.width - 8, Math.max(8, x - r.width / 2));
  const top = y - r.height - 12 < 8 ? y + 18 : y - r.height - 12;
  tip.style.left = left + "px";
  tip.style.top = top + "px";
}
const hideTip = () => tip.classList.remove("show");
window.addEventListener("scroll", hideTip, { passive: true }); // don't leave a tooltip floating
function tipFor(el, getHtml) {
  const at = (e) => {
    const b = el.getBoundingClientRect();
    const x = e && e.clientX !== undefined && e.type.startsWith("mouse") ? e.clientX : b.left + b.width / 2;
    const y = e && e.clientY !== undefined && e.type.startsWith("mouse") ? e.clientY : b.top;
    showTip(getHtml(), x, y);
  };
  el.addEventListener("mouseenter", at);
  el.addEventListener("mousemove", at);
  el.addEventListener("focus", at);
  el.addEventListener("mouseleave", hideTip);
  el.addEventListener("blur", hideTip);
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2600);
}

// ------------------------------------------------------------------ THEME
// 3 modes: auto (follow the computer) → light → dark → auto …
const THEME_ICONS = {
  auto: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor"/></svg>',
  light: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M2 12h2M20 12h2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>',
  dark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
};
function currentThemeMode() {
  return document.documentElement.dataset.theme || "auto";
}
function setTheme(mode) {
  if (mode === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = mode;
  try { localStorage.setItem("hotsync-theme", mode); } catch (e) { /* ignore */ }
  const btn = $("themeBtn");
  btn.innerHTML = THEME_ICONS[mode];
  btn.title = "Theme: " + mode + " (click to change)";
  if (state.data) recolor(); // charts and map dots read colours from CSS
}
$("themeBtn").addEventListener("click", () => {
  const next = { auto: "light", light: "dark", dark: "auto" }[currentThemeMode()];
  setTheme(next);
  toast(next === "auto" ? "Theme: follows your computer" : `Theme: ${next}`);
});
// If the computer switches light/dark while in "auto", follow it.
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (currentThemeMode() === "auto" && state.data) recolor();
});
setTheme(currentThemeMode());

// ------------------------------------------------------------------ LOAD
fetch("data/summary.json")
  .then((res) => {
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  })
  .then(init)
  .catch((err) => {
    // Most common reason: the page was opened by double-click (file://).
    const box = $("error");
    box.style.display = "block";
    box.innerHTML =
      "<b>Could not load data/summary.json</b> (" + err.message + ").<br>" +
      "1) Run <code>python process.py</code>. " +
      "2) From the hotsync-practice folder run <code>python -m http.server 8000</code>. " +
      "3) Open <code>http://localhost:8000/web/</code>.";
    console.error(err);
  });

function init(data) {
  state.data = data;
  if (data.ratio[data.ratio.used] !== undefined) state.ratioKey = data.ratio.used;

  drawHeroStatic(data);
  drawKpisStatic(data);
  buildRatioButtons();
  initMap(data);
  buildChart(data);
  buildCalendar(data);
  buildFunnel(data);
  buildRatioList();
  buildTable(data);
  wireControls(data);
  setupReveal();
  setupScrollSpy();
  render();
}

// ------------------------------------------------------------------ RENDER (everything that can change)
function render() {
  const d = state.data;
  renderHero(d);
  renderKpis(d);
  renderControls(d);
  renderMap(d);
  renderDayCard(d);
  renderChart(d);
  renderCalendar(d);
  renderRatioList(d);
  drawStrip(d);
  renderTable(d);
}

// When the theme changes, things drawn with JS colours must be repainted.
function recolor() {
  styleMarkers();
  if (chart) { applyChartColors(); chart.update("none"); }
  drawStrip(state.data);
}

// ------------------------------------------------------------------ HERO
function drawHeroStatic(d) {
  $("heroArea").textContent = d.area;
  $("heroMonth").textContent = monthName(d);
  const m = d.totals.modis_raw, v = d.totals.viirs_raw;
  $("heroTitle").innerHTML =
    `Same fires, two cameras: <span class="v">${fmt(v)}</span> vs <span class="m">${fmt(m)}</span>. HotSync makes them <span class="h">fair</span>.`;
  $("heroText").innerHTML =
    `In ${monthName(d)}, NASA satellites watched ${d.area}. After cleaning, the new <b>VIIRS</b> camera found ${fmt(v)} real fires, ` +
    `but the old <b>MODIS</b> camera found only ${fmt(m)}. There weren't more fires: VIIRS just has sharper eyes (smaller pixels). ` +
    `So we find the <b>exchange rate</b> between them, and turn MODIS numbers into "VIIRS-like" numbers.`;
}

function renderHero(d) {
  const r = ratio();
  // Only redraw the dots if the ratio changed (so they "pop" again)
  if (renderHero.last !== r) {
    renderHero.last = r;
    const full = Math.floor(r), part = r - full;
    let html = "";
    for (let i = 0; i < full; i++) html += `<span class="ex-dot" style="animation-delay:${i * 90}ms"></span>`;
    if (part > 0.05) html += `<span class="ex-dot part" style="animation-delay:${full * 90}ms"><i style="width:${Math.round(part * 100)}%"></i></span>`;
    $("exDots").innerHTML = html;
    countUp($("exNum"), r, { decimals: 2, suffix: "×" });
    const name = RATIOS.find((x) => x.key === state.ratioKey).name.toLowerCase();
    $("exCap").innerHTML = `1 MODIS hot spot ≈ <b>${r.toFixed(2)}</b> VIIRS hot spots<br><span class="muted">method: ${name}</span>`;
  }
}

// ------------------------------------------------------------------ KPI CARDS
function drawKpisStatic(d) {
  countUp($("kModis"), d.totals.modis_raw);
  countUp($("kViirs"), d.totals.viirs_raw);
  $("kModisS").textContent = `kept from ${fmt(d.files.modis_rows)} raw rows`;
  $("kViirsS").textContent = `kept from ${fmt(d.files.viirs_rows)} raw rows`;
  $("kBusy").textContent = shortDate(d.busiest_day);
  $("kBusyS").textContent = `${d.busiest_day_viirs} VIIRS hot spots · click to see`;
  const goBusy = () => selectDay(d.daily.findIndex((x) => x.date === d.busiest_day), true);
  $("kBusyCard").addEventListener("click", goBusy);
  $("kBusyCard").addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); goBusy(); } });
}
function renderKpis(d) {
  if (renderKpis.last === state.ratioKey) return;
  renderKpis.last = state.ratioKey;
  countUp($("kRatio"), ratio(), { decimals: 2, suffix: "×" });
  const name = RATIOS.find((x) => x.key === state.ratioKey).short;
  $("kRatioS").textContent = `VIIRS ÷ MODIS · method: ${name}`;
}

// ------------------------------------------------------------------ CONTROLS
function buildRatioButtons() {
  const seg = $("ratioSeg");
  for (const r of RATIOS) {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.key = r.key;
    b.textContent = r.short;
    b.title = r.name;
    b.addEventListener("click", () => setRatio(r.key));
    seg.appendChild(b);
  }
}
function setRatio(key) {
  if (key === state.ratioKey) return;
  state.ratioKey = key;
  render();
}

function wireControls(d) {
  const slider = $("daySlider");
  slider.max = d.daily.length;
  slider.addEventListener("input", () => {
    stopPlay();
    const v = Number(slider.value);
    selectDay(v === 0 ? null : v - 1);
  });
  $("allBtn").addEventListener("click", () => { stopPlay(); selectDay(null); });
  $("prevBtn").addEventListener("click", () => { stopPlay(); stepDay(-1); });
  $("nextBtn").addEventListener("click", () => { stopPlay(); stepDay(1); });
  $("playBtn").addEventListener("click", () => (state.timer ? stopPlay() : startPlay()));

  for (const [id, s] of [["showModis", "MODIS"], ["showViirs", "VIIRS"]]) {
    $(id).addEventListener("change", (e) => { state.show[s] = e.target.checked; render(); });
  }

  // Keyboard: ← → change day, Esc = whole month
  document.addEventListener("keydown", (e) => {
    const tag = (e.target.tagName || "").toLowerCase();
    if (["input", "select", "textarea"].includes(tag)) return;
    if (e.key === "ArrowRight") { stopPlay(); stepDay(1); e.preventDefault(); }
    else if (e.key === "ArrowLeft") { stopPlay(); stepDay(-1); e.preventDefault(); }
    else if (e.key === "Escape") { stopPlay(); selectDay(null); }
  });

  // "?" buttons: show their explanation
  document.querySelectorAll(".q").forEach((q) => {
    tipFor(q, () => q.dataset.tip);
    // Phones have no mouse hover, so a tap opens the explanation too.
    q.addEventListener("click", (e) => {
      e.stopPropagation();
      const b = q.getBoundingClientRect();
      showTip(q.dataset.tip, b.left + b.width / 2, b.top);
    });
  });
  // A tap anywhere else closes it again
  document.addEventListener("click", (e) => { if (!e.target.closest(".q")) hideTip(); });

  $("download").addEventListener("click", downloadCsv);
}

function selectDay(i, scrollToMap = false) {
  state.day = i;
  render();
  if (scrollToMap) $("where").scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "start" });
}
function stepDay(delta) {
  const n = state.data.daily.length;
  if (state.day === null) selectDay(delta > 0 ? 0 : n - 1);
  else selectDay(Math.min(n - 1, Math.max(0, state.day + delta)));
}

// Play: walk through the month, one day every 0.9 seconds
function startPlay() {
  const n = state.data.daily.length;
  if (state.day === null || state.day >= n - 1) selectDay(0);
  state.timer = setInterval(() => {
    if (state.day >= n - 1) { stopPlay(); return; }
    selectDay(state.day + 1);
  }, 900);
  renderControls(state.data);
}
function stopPlay() {
  if (!state.timer) return;
  clearInterval(state.timer);
  state.timer = null;
  renderControls(state.data);
}

function renderControls(d) {
  $("daySlider").value = state.day === null ? 0 : state.day + 1;
  $("dayLabel").textContent = state.day === null ? "Whole month" : shortDate(d.daily[state.day].date);
  $("allBtn").disabled = state.day === null;
  $("playBtn").innerHTML = state.timer
    ? '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg> Pause'
    : '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5v14l12-7z"/></svg> Play month';
  // segmented control: mark the active button and slide the "thumb" under it
  const seg = $("ratioSeg");
  let active = null;
  seg.querySelectorAll("button").forEach((b) => {
    const on = b.dataset.key === state.ratioKey;
    b.setAttribute("aria-pressed", on);
    if (on) active = b;
  });
  if (active) {
    const thumb = seg.querySelector(".thumb");
    thumb.style.left = active.offsetLeft + "px";
    thumb.style.width = active.offsetWidth + "px";
  }
}
window.addEventListener("resize", () => state.data && renderControls(state.data));

// ------------------------------------------------------------------ MAP
let map, markers = [];
function initMap(d) {
  // scrollWheelZoom off: scrolling the page doesn't zoom the map by mistake
  map = L.map("map", { scrollWheelZoom: false, zoomSnap: 0.25 }).setView([41.4, 64.6], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 18,
    attribution: "© OpenStreetMap",
  }).addTo(map);

  // Draw VIIRS first and MODIS on top, so the rings are not hidden under dots
  const sorted = [...d.points].sort((a, b) => (a.sensor === "VIIRS" ? -1 : 1) - (b.sensor === "VIIRS" ? -1 : 1));
  for (const p of sorted) {
    const isModis = p.sensor === "MODIS";
    // MODIS = bigger empty ring (its pixel is bigger), VIIRS = small dot
    const m = L.circleMarker([p.lat, p.lon], { radius: isModis ? 6.5 : 4, weight: isModis ? 2 : 1.5 });
    const time = p.time.slice(0, 2) + ":" + p.time.slice(2) + " UTC";
    m.bindPopup(
      `<div class="pop"><b style="color:var(--${isModis ? "modis" : "viirs"})">${p.sensor}</b>` +
      `<div class="row"><span class="muted">Date</span><span>${shortDate(p.date)}, ${time}</span></div>` +
      `<div class="row"><span class="muted">Fire power (FRP)</span><span>${p.frp} MW</span></div>` +
      `<div class="row"><span class="muted">Place</span><span>${p.lat.toFixed(3)}, ${p.lon.toFixed(3)}</span></div></div>`
    );
    markers.push({ m, p });
  }
  styleMarkers();

  // Zoom so all dots fit (many fires are far east, in the Fergana valley)
  if (d.points.length) map.fitBounds(d.points.map((p) => [p.lat, p.lon]), { padding: [20, 20] });
}
function styleMarkers() {
  const cM = css("--modis"), cV = css("--viirs"), surf = css("--card-solid");
  for (const { m, p } of markers) {
    if (p.sensor === "MODIS") m.setStyle({ color: cM, fill: false, opacity: 1 });
    else m.setStyle({ color: surf, fillColor: cV, fillOpacity: 0.88, opacity: 0.9 }); // thin surface ring separates dots
  }
}
function renderMap(d) {
  const date = state.day === null ? null : d.daily[state.day].date;
  let shown = 0;
  for (const { m, p } of markers) {
    const on = state.show[p.sensor] && (date === null || p.date === date);
    if (on && !map.hasLayer(m)) m.addTo(map);
    if (!on && map.hasLayer(m)) m.remove();
    if (on) {
      shown++;
      const el = m.getElement();
      if (el) el.classList.toggle("pulse", date !== null && p.sensor === "VIIRS");
    }
  }
  $("mapHint").textContent = (date === null ? "Whole month" : shortDate(date)) + ` · ${fmt(shown)} dots · click one for details`;
}

// ------------------------------------------------------------------ DAY CARD
function renderDayCard(d) {
  const i = state.day;
  const rows = [];
  let title, sub, note;

  if (i === null) {
    const hm = d.daily.reduce((s, r) => s + (harm(r) || 0), 0);
    title = "Whole month";
    sub = `${monthName(d)} · ${d.daily.length} days`;
    rows.push(["MODIS raw", d.totals.modis_raw, "--modis"]);
    rows.push(["VIIRS raw", d.totals.viirs_raw, "--viirs"]);
    rows.push(["MODIS harmonized", Math.round(hm), "--harm"]);
    note = `VIIRS sent no data on <b>${noDataText(d)}</b>. Harmonized MODIS fills those gaps. ` +
      `Press <b>▶ Play month</b> or click any day in the calendar to explore.`;
  } else {
    const r = d.daily[i];
    const h = harm(r);
    const dr = dayRatio(r);
    title = longDate(r.date);
    rows.push(["MODIS raw", r.modis_raw, "--modis"]);
    rows.push(["VIIRS raw", r.viirs_raw, "--viirs"]);
    rows.push(["MODIS harmonized", h, "--harm"]);

    // strongest fire of the day (by fire power)
    const pts = d.points.filter((p) => p.date === r.date);
    const top = pts.reduce((a, p) => (!a || p.frp > a.frp ? p : a), null);
    sub = top ? `Strongest fire: ${top.frp} MW (${top.sensor}) at ${top.lat.toFixed(2)}, ${top.lon.toFixed(2)}` : "No fires on this day";

    if (r.viirs_raw === null) {
      note = `VIIRS sent <b>no data</b> this day (not 0 fires!). Our best guess from MODIS: about <b>${fmt1(h)}</b> VIIRS-like fires.`;
    } else if (r.modis_raw === 0 && r.viirs_raw > 0) {
      note = `MODIS saw <b>0</b>, VIIRS saw <b>${r.viirs_raw}</b>. These fires were too small for MODIS's big 1 km pixels.`;
    } else if (r.viirs_raw < r.modis_raw) {
      note = `Rare day: <b>MODIS saw more</b>. The satellites pass at different times, so a short fire can be seen by only one of them.`;
    } else if (dr !== null) {
      const off = h - r.viirs_raw;
      note = `VIIRS saw <b>${dr.toFixed(1)}×</b> more than MODIS today (month rate ${ratio().toFixed(2)}). ` +
        `Harmonized guess ${fmt1(h)} vs real ${r.viirs_raw}: off by ${off > 0 ? "+" : ""}${fmt1(off)}. Single days are noisy; months are stable.`;
    } else {
      note = "No fires from either camera this day.";
    }
  }

  $("dTitle").textContent = title;
  $("dSub").textContent = sub;
  $("dNote").innerHTML = note;
  const max = Math.max(1, ...rows.map((x) => x[1] || 0));
  $("dStats").innerHTML = rows.map(([name, v, c]) =>
    `<div class="stat-row"><span>${name}</span>` +
    `<span class="bar"><i style="background:var(${c});width:${v === null ? 0 : (v / max) * 100}%"></i></span>` +
    (v === null ? `<span class="val nd">no data</span>` : `<span class="val">${Number.isInteger(v) ? fmt(v) : fmt1(v)}</span>`) +
    `</div>`).join("");
  $("prevBtn").disabled = i === 0;
  $("nextBtn").disabled = i === d.daily.length - 1;
}

// ------------------------------------------------------------------ LINE CHART
let chart;
function chartColors() {
  return { modis: css("--modis"), viirs: css("--viirs"), harm: css("--harm"), grid: css("--grid"), axis: css("--axis"), ink: css("--ink"), ink2: css("--ink2"), brand: css("--brand"), surface: css("--card-solid"), line: css("--line") };
}

// Plugin 1: a soft band behind the selected day
const selectedBand = {
  id: "selectedBand",
  beforeDatasetsDraw(c) {
    if (state.day === null) return;
    const { ctx, chartArea: a, scales: { x } } = c;
    const w = (a.right - a.left) / Math.max(1, c.data.labels.length - 1);
    const cx = x.getPixelForValue(state.day);
    ctx.save();
    ctx.fillStyle = chartColors().brand + "22";
    ctx.fillRect(cx - w / 2, a.top, w, a.bottom - a.top);
    ctx.restore();
  },
};
// Plugin 2: a thin vertical line where the mouse is (crosshair)
const crosshair = {
  id: "crosshair",
  afterDatasetsDraw(c) {
    const act = c.tooltip && c.tooltip.getActiveElements();
    if (!act || !act.length) return;
    const { ctx, chartArea: a } = c;
    const xPix = act[0].element.x;
    ctx.save();
    ctx.strokeStyle = chartColors().axis;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(xPix, a.top); ctx.lineTo(xPix, a.bottom); ctx.stroke();
    ctx.restore();
  },
};
// Plugin 3: name each line at its right end (direct labels, easier than a legend)
const endLabels = {
  id: "endLabels",
  afterDatasetsDraw(c) {
    const { ctx } = c;
    const col = chartColors();
    const placed = [];
    c.data.datasets.forEach((ds, di) => {
      const meta = c.getDatasetMeta(di);
      if (meta.hidden) return;
      let k = ds.data.length - 1;
      while (k >= 0 && ds.data[k] === null) k--;
      if (k < 0) return;
      const pt = meta.data[k];
      let y = pt.y;
      for (const py of placed) if (Math.abs(py - y) < 14) y = py + (y >= py ? 14 : -14); // avoid overlap
      placed.push(y);
      ctx.save();
      ctx.fillStyle = ds.borderColor;
      ctx.beginPath(); ctx.arc(pt.x + 10, y, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = col.ink2;
      ctx.font = "500 12px Inter, system-ui, sans-serif";
      ctx.textBaseline = "middle";
      ctx.fillText(ds.shortLabel, pt.x + 18, y);
      ctx.restore();
    });
  },
};

function buildChart(d) {
  const line = (label, shortLabel, dashed) => ({
    label, shortLabel, data: [],
    borderWidth: 2,
    borderDash: dashed ? [6, 4] : [],
    pointRadius: 0,
    pointHoverRadius: 5,
    pointHitRadius: 12,
    tension: 0.3,
    spanGaps: false, // no line over no-data days: a gap shows "no data"
  });
  chart = new Chart($("chart"), {
    type: "line",
    data: {
      labels: d.daily.map((x) => dayNum(x.date)),
      datasets: [line("MODIS raw", "MODIS raw"), line("VIIRS raw", "VIIRS raw"), line("MODIS harmonized", "Harmonized", true)],
    },
    options: {
      maintainAspectRatio: false,
      layout: { padding: { right: 92, top: 6 } },
      animation: { duration: reduceMotion ? 0 : 900, easing: "easeOutQuart" },
      interaction: { mode: "index", intersect: false }, // hover shows all 3 values of that day
      onClick: (e) => {
        const el = chart.getElementsAtEventForMode(e, "index", { intersect: false }, false);
        if (el.length) { stopPlay(); selectDay(el[0].index === state.day ? null : el[0].index); }
      },
      onHover: (e, el) => { e.native.target.style.cursor = el.length ? "pointer" : "default"; },
      plugins: {
        legend: { display: false }, // we use direct labels + the legend row under the chart
        tooltip: {
          padding: 10, cornerRadius: 10, boxPadding: 4, usePointStyle: true,
          callbacks: {
            title: (items) => longDate(d.daily[items[0].dataIndex].date),
            label: (item) => ` ${item.dataset.label}: ${item.raw === null ? "no data" : item.raw}`,
          },
        },
      },
      scales: {
        x: { grid: { display: false }, border: {}, ticks: { maxRotation: 0, autoSkipPadding: 8 }, title: { display: true } },
        y: { beginAtZero: true, border: { display: false }, title: { display: true, text: "Hot spots per day" } },
      },
    },
    plugins: [selectedBand, crosshair, endLabels],
  });
  applyChartColors();
  const nd = d.no_data_days.viirs;
  $("chartNote").textContent = nd.length ? `· Gap in the orange line = VIIRS sent no data (${nd.map(shortDate).join(", ")})` : "";
}
function applyChartColors() {
  const c = chartColors();
  const [m, v, h] = chart.data.datasets;
  for (const [ds, col] of [[m, c.modis], [v, c.viirs], [h, c.harm]]) {
    ds.borderColor = col; ds.backgroundColor = col; ds.pointHoverBackgroundColor = col;
    ds.pointHoverBorderColor = c.surface; ds.pointHoverBorderWidth = 2;
  }
  const o = chart.options;
  o.scales.x.ticks.color = c.axis; o.scales.y.ticks.color = c.axis;
  o.scales.x.title.color = c.axis; o.scales.y.title.color = c.axis;
  o.scales.x.border.color = c.line;
  o.scales.y.grid.color = c.grid;
  o.scales.x.title.text = "Day of " + monthName(state.data);
  const t = o.plugins.tooltip;
  t.backgroundColor = c.surface; t.titleColor = c.ink; t.bodyColor = c.ink2;
  t.borderColor = c.line; t.borderWidth = 1;
}
function renderChart(d) {
  chart.data.datasets[0].data = d.daily.map((x) => x.modis_raw);
  chart.data.datasets[1].data = d.daily.map((x) => x.viirs_raw);
  chart.data.datasets[2].data = d.daily.map(harm);
  chart.data.datasets[2].label = `MODIS harmonized (×${ratio().toFixed(2)})`;
  $("harmKey").textContent = `MODIS harmonized (×${ratio().toFixed(2)})`;
  chart.update(); // animates the green line to its new place when the ratio changes
}

// ------------------------------------------------------------------ CALENDAR
const CAL_ROWS = [
  ["MODIS raw", "modis_raw", "--modis"],
  ["VIIRS raw", "viirs_raw", "--viirs"],
  ["MODIS harmonized", "harm", "--harm"],
];
const calValue = (row, key) => (key === "harm" ? harm(row) : row[key]);

function buildCalendar(d) {
  $("calTitle").textContent = `Burning calendar · ${monthName(d)} (days)`;
  const cal = $("cal");
  cal.style.gridTemplateColumns = `140px repeat(${d.daily.length}, minmax(0, 1fr))`;
  let html = "<div></div>" + d.daily.map((x, i) => {
    const n = dayNum(x.date);
    return `<div class="h" data-col="${i}">${n === 1 || n % 5 === 0 ? n : ""}</div>`;
  }).join("");
  let k = 0;
  CAL_ROWS.forEach(([name, key, c], ri) => {
    html += `<div class="rl"><span class="dot" style="background:var(${c})"></span>${name}</div>`;
    d.daily.forEach((x, i) => {
      html += `<button type="button" class="c" data-r="${ri}" data-i="${i}" style="--i:${k++}" aria-label="${shortDate(x.date)} ${name}"></button>`;
    });
  });
  cal.innerHTML = html;

  cal.querySelectorAll(".c").forEach((cell) => {
    const ri = Number(cell.dataset.r), i = Number(cell.dataset.i);
    tipFor(cell, () => {
      const row = state.data.daily[i];
      const [name, key] = CAL_ROWS[ri];
      const v = calValue(row, key);
      return `<div class="tt">${longDate(row.date)}</div>${name}: <b>${v === null ? "no data" : (Number.isInteger(v) ? v : fmt1(v)) + " hot spots"}</b>`;
    });
    cell.addEventListener("click", () => { stopPlay(); selectDay(state.day === i ? null : i); });
  });
}
function renderCalendar(d) {
  // ONE colour scale for all rows, so the same colour = the same number
  const max = Math.max(1, ...d.daily.flatMap((x) => CAL_ROWS.map(([, k]) => calValue(x, k) || 0)));
  const step = max / 5;
  const level = (v) => (v === 0 ? 0 : Math.min(5, Math.floor(v / step) + 1)); // 1..5

  $("cal").querySelectorAll(".c").forEach((cell) => {
    const row = d.daily[Number(cell.dataset.i)];
    const v = calValue(row, CAL_ROWS[Number(cell.dataset.r)][1]);
    cell.classList.toggle("nodata", v === null);
    cell.style.backgroundColor = v === null ? "" : `var(--r${level(v)})`;
    cell.classList.toggle("sel", state.day === Number(cell.dataset.i));
  });
  $("cal").querySelectorAll(".h").forEach((h) => h.classList.toggle("sel", Number(h.dataset.col) === state.day));

  // Legend: number range of each colour step
  let s = `<span><span class="s" style="background:var(--r0)"></span>0</span>`;
  for (let i = 1; i <= 5; i++) {
    const lo = Math.max(1, Math.ceil((i - 1) * step));
    const hi = i === 5 ? Math.ceil(max) : Math.ceil(i * step) - 1;
    s += `<span><span class="s" style="background:var(--r${i})"></span>${lo}–${hi}</span>`;
  }
  s += `<span><span class="s" style="background:repeating-linear-gradient(45deg,var(--nodata-a) 0 3px,var(--nodata-b) 3px 6px)"></span>no data</span>`;
  $("scale").innerHTML = `<span>Few</span>${s}<span>Many</span>`;
}

// ------------------------------------------------------------------ CLEANING FUNNEL
function buildFunnel(d) {
  const maxRaw = Math.max(d.files.modis_rows, d.files.viirs_rows); // same scale for both sensors
  let html = "";
  for (const [sensor, c] of [["MODIS", "--modis"], ["VIIRS", "--viirs"]]) {
    const rules = d.cleaning.filter((r) => r.sensor === sensor);
    const raw = rules[0].before, left = rules[rules.length - 1].after;
    html += `<div class="f-sensor"><div class="f-head"><b style="color:var(${c})">${sensor}</b>` +
      `<span class="muted">${fmt(left)} of ${fmt(raw)} kept (${Math.round((left / raw) * 100)}%)</span></div>`;
    const steps = [{ name: "Raw file", after: raw, removed: null, reason: "Every row in the downloaded CSV" },
      ...rules.map((r) => ({ name: ruleName(r.rule), after: r.after, removed: r.removed, reason: r.reason }))];
    steps.forEach((st, i) => {
      const final = i === steps.length - 1;
      html += `<div class="f-row${final ? " final" : ""}" title="${st.reason}">` +
        `<span class="name">${final ? "✓ " : ""}${st.name}</span>` +
        `<span class="bar"><i data-w="${(st.after / maxRaw) * 100}%" style="--i:${i};background:var(${c});opacity:${final ? 1 : 0.35 + 0.65 * (st.after / raw)}"></i></span>` +
        `<span class="val">${fmt(st.after)}${st.removed ? `<span class="rm">−${fmt(st.removed)}</span>` : ""}</span></div>`;
    });
    html += "</div>";
  }
  html += `<div class="note-box">Only about <b>1 in 3</b> "hot spots" was a real vegetation fire. ` +
    `Two factories alone made up hundreds of VIIRS dots. Cleaning changes the exchange rate as much as the maths does.</div>`;
  $("funnel").innerHTML = html;
}

// ------------------------------------------------------------------ RATIO LIST + DOT STRIP
function buildRatioList() {
  const list = $("ratioList");
  for (const r of RATIOS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "ratio-item";
    b.dataset.key = r.key;
    b.innerHTML = `<span>${r.name}</span><span class="bar"><i></i></span><span class="val"></span>`;
    b.addEventListener("click", () => setRatio(r.key));
    list.appendChild(b);
  }
}
function renderRatioList(d) {
  const max = Math.max(...RATIOS.map((r) => d.ratio[r.key]));
  $("ratioList").querySelectorAll(".ratio-item").forEach((b) => {
    const v = d.ratio[b.dataset.key];
    b.setAttribute("aria-pressed", b.dataset.key === state.ratioKey);
    b.querySelector(".val").textContent = v.toFixed(2);
    // tiny delay so the bars grow from 0 the first time
    requestAnimationFrame(() => { b.querySelector(".bar i").style.width = (v / max) * 100 + "%"; });
  });
  $("ratioWhy").innerHTML = RATIOS.find((r) => r.key === state.ratioKey).why(d);
}

function drawStrip(d) {
  const svg = $("strip");
  const W = Math.max(300, svg.clientWidth || 600), H = 124, P = 14;
  svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
  const days = d.daily.map((r, i) => ({ r, i, v: dayRatio(r) })).filter((x) => x.v !== null);
  if (!days.length) { svg.innerHTML = ""; return; }
  const vals = days.map((x) => x.v).sort((a, b) => a - b);
  const mid = Math.floor(vals.length / 2);
  const median = vals.length % 2 ? vals[mid] : (vals[mid - 1] + vals[mid]) / 2;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const maxV = Math.ceil(vals[vals.length - 1] / 5) * 5;
  const x = (v) => P + (v / maxV) * (W - 2 * P);
  const c = chartColors();
  const base = H - 22;

  // simple "beeswarm": if a dot would overlap one before it, stack it higher
  const placed = [];
  const dots = days.map((dd) => {
    const cx = x(dd.v);
    let level = 0;
    while (placed.some((p) => p.level === level && Math.abs(p.cx - cx) < 9)) level++;
    placed.push({ cx, level });
    return { ...dd, cx, cy: base - 6 - level * 9 };
  });

  let s = `<line x1="${P}" x2="${W - P}" y1="${base}" y2="${base}" stroke="${c.line}" />`;
  for (let t = 0; t <= maxV; t += 5) {
    s += `<text x="${x(t)}" y="${H - 6}" font-size="10.5" fill="${c.axis}" text-anchor="middle">${t}×</text>`;
  }
  // The two reference lines. The smaller one gets its label on the LEFT of its
  // line and the bigger one on the RIGHT, so the labels never overlap.
  const ref = (v, label, color, side) =>
    `<line x1="${x(v)}" x2="${x(v)}" y1="6" y2="${base}" stroke="${color}" stroke-width="2" />` +
    `<text x="${x(v) + (side === "left" ? -6 : 6)}" y="14" font-size="11" font-weight="600" fill="${c.ink2}" ` +
    `text-anchor="${side === "left" ? "end" : "start"}">${label} ${v.toFixed(1)}</text>`;
  s += ref(median, "median", c.harm, median <= mean ? "left" : "right");
  s += ref(mean, "average", c.viirs, median <= mean ? "right" : "left");
  s += dots.map((p) =>
    `<circle class="sd" data-i="${p.i}" cx="${p.cx}" cy="${p.cy}" r="${state.day === p.i ? 6 : 4.5}" fill="${c.modis}" ` +
    `stroke="${state.day === p.i ? c.ink : c.surface}" stroke-width="${state.day === p.i ? 2.5 : 1.5}" style="cursor:pointer"/>`
  ).join("");
  svg.innerHTML = s;

  svg.querySelectorAll(".sd").forEach((el) => {
    const i = Number(el.dataset.i), r = d.daily[i];
    tipFor(el, () => `<div class="tt">${longDate(r.date)}</div>VIIRS ${r.viirs_raw} ÷ MODIS ${r.modis_raw} = <b>${dayRatio(r).toFixed(1)}×</b>`);
    el.addEventListener("click", () => { stopPlay(); selectDay(i); });
  });
}
window.addEventListener("resize", () => state.data && drawStrip(state.data));

// ------------------------------------------------------------------ TABLE + CSV
function buildTable(d) {
  $("tbody").innerHTML = d.daily.map((r, i) => `<tr data-i="${i}"></tr>`).join("");
  $("tbody").querySelectorAll("tr").forEach((tr) => {
    tr.addEventListener("click", () => { stopPlay(); const i = Number(tr.dataset.i); selectDay(state.day === i ? null : i); });
  });
}
function renderTable(d) {
  const cell = (v, f = fmt) => (v === null ? `<td class="num nd">no data</td>` : `<td class="num">${f(v)}</td>`);
  $("harmTh").textContent = `MODIS harmonized (×${ratio().toFixed(2)})`;
  const wrap = document.querySelector(".tablewrap");
  $("tbody").querySelectorAll("tr").forEach((tr) => {
    const i = Number(tr.dataset.i), r = d.daily[i];
    const dr = dayRatio(r);
    tr.innerHTML = `<td>${r.date}</td>${cell(r.modis_raw)}${cell(r.viirs_raw)}${cell(harm(r), fmt1)}` +
      `<td class="num ${dr === null ? "nd" : ""}">${dr === null ? "–" : dr.toFixed(1) + "×"}</td>`;
    const sel = state.day === i;
    tr.classList.toggle("sel", sel);
    // scroll only inside the table box (not the whole page)
    if (sel) {
      const top = tr.offsetTop - wrap.clientHeight / 2;
      wrap.scrollTo({ top, behavior: reduceMotion ? "auto" : "smooth" });
    }
  });
}

function downloadCsv() {
  const d = state.data;
  const lines = ["date,modis_raw,viirs_raw,modis_harmonized"];
  for (const r of d.daily) {
    // empty cell for "no data", same as daily_counts.csv
    lines.push([r.date, r.modis_raw, r.viirs_raw, harm(r)].map((v) => (v === null ? "" : v)).join(","));
  }
  const blob = new Blob([lines.join("\n") + "\n"], { type: "text/csv" });
  const a = document.createElement("a");
  const name = `hotsync_daily_${d.month}_${state.ratioKey}.csv`;
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast(`⬇ Saved ${name} (ratio ${ratio().toFixed(2)})`);
}

// ------------------------------------------------------------------ SCROLL EFFECTS
// Sections fade up when they come into view. Bars with data-w grow then.
function setupReveal() {
  const els = document.querySelectorAll(".reveal");
  const grow = (el) => el.querySelectorAll("[data-w]").forEach((b) => { b.style.width = b.dataset.w; });
  if (!("IntersectionObserver" in window) || reduceMotion) {
    els.forEach((el) => { el.classList.add("in"); grow(el); });
    return;
  }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      e.target.classList.add("in");
      grow(e.target);
      if (e.target.contains($("map"))) setTimeout(() => map.invalidateSize(), 300);
      io.unobserve(e.target);
    }
  }, { threshold: 0.01, rootMargin: "0px 0px 120px 0px" }); // start a bit before it is on screen
  els.forEach((el) => io.observe(el));
}

// Highlight the menu link of the section you are looking at
function setupScrollSpy() {
  const links = [...document.querySelectorAll("nav.sections a")];
  const sections = links.map((a) => $(a.getAttribute("href").slice(1))).filter(Boolean);
  // The active section = the last one whose top is above 40% of the screen.
  const update = () => {
    const line = window.innerHeight * 0.4;
    let current = sections[0];
    for (const s of sections) if (s.getBoundingClientRect().top <= line) current = s;
    links.forEach((a) => a.classList.toggle("active", a.getAttribute("href") === "#" + current.id));
  };
  let ticking = false;
  window.addEventListener("scroll", () => {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { update(); ticking = false; });
  }, { passive: true });
  update();
}
