/*
  PyroVision home page: summary.js
  "Fire on Earth, in short": loads data/home-summary.json (made by
  home_summary.py with the same rules as the map page) and draws the 4 big
  numbers, the year chart, the top 5 countries and the exchange rate.
  No numbers are written in this file: they all come from the data.
*/
(function () {
  "use strict";
  document.documentElement.classList.add("js");
  const $ = (id) => document.getElementById(id);
  const reduceMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
  const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const MINUS = "−";                       // real minus sign

  // Same short format as the map page: 98.4M, 174k, 5.2k, 812
  function compact(v) {
    const a = Math.abs(v);
    if (a < 1000) return String(Math.round(v));
    if (a < 10000) return (v / 1000).toFixed(1).replace(/\.0$/, "") + "k";
    if (a < 1e6) return Math.round(v / 1000) + "k";
    return (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  }
  const full = (v) => Math.round(v).toLocaleString("en-US");
  const pct = (v) => (Math.round(v) > 0 ? "+" : Math.round(v) < 0 ? MINUS : "") + Math.abs(Math.round(v)) + "%";
  const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));

  // ---------------------------------------------------------------- tooltips
  // Small "?" buttons and the year bars: show on hover AND on keyboard focus.
  const tip = $("htip");
  function showTip(el) {
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const b = el.getBoundingClientRect(), t = tip.getBoundingClientRect();
    tip.style.left = Math.max(8, Math.min(innerWidth - t.width - 8, b.left + b.width / 2 - t.width / 2)) + "px";
    tip.style.top = Math.max(8, b.top - t.height - 8) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  document.addEventListener("pointerover", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); });
  document.addEventListener("pointerout", (e) => { if (e.target.closest("[data-tip]")) hideTip(); });
  document.addEventListener("focusin", (e) => { const el = e.target.closest("[data-tip]"); if (el) showTip(el); else hideTip(); });
  document.addEventListener("focusout", hideTip);
  document.addEventListener("scroll", hideTip, { passive: true });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") hideTip(); });

  // ---------------------------------------------------------------- count-up
  // From 0 to the value in 0.9 s (ease-out), short format while counting.
  function countUp(el) {
    const to = +el.dataset.value, kind = el.dataset.kind;
    const show = (v) => (kind === "pct" ? pct(v) : kind === "year" ? String(Math.round(v)) : compact(v));
    if (reduceMotion() || !Number.isFinite(to)) { el.textContent = show(to); return; }
    if (kind === "year") { el.textContent = show(to); return; }      // a year does not count up
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, Math.max(0, (now - t0) / 900)), e = 1 - Math.pow(1 - k, 3);
      el.textContent = show(to * e);
      if (k < 1) requestAnimationFrame(step); else el.textContent = show(to);
    };
    requestAnimationFrame(step);
  }

  // ---------------------------------------------------------------- reveal
  // Blocks fade in and move up once; inside, cards and bars come one by one.
  let io = null;
  function reveal(el) {
    if (el.classList.contains("in")) return;
    el.classList.add("in");
    revealInner(el);
  }
  // numbers count up, bars grow (again after the data arrives, if the block was already shown)
  function revealInner(el) {
    el.querySelectorAll("[data-value]").forEach((n) => setTimeout(() => countUp(n), parseFloat(n.closest("[style]")?.style.getPropertyValue("--d")) || 0));
    el.querySelectorAll(".year-chart, .top5").forEach((x) => x.classList.add("in"));
  }
  function watch(el) {
    if (reduceMotion() || !("IntersectionObserver" in window)) { reveal(el); return; }
    io ||= new IntersectionObserver((list) => list.forEach((en) => {
      if (en.isIntersecting) { reveal(en.target); io.unobserve(en.target); }
    }), { threshold: 0.15 });
    io.observe(el);
  }

  // ---------------------------------------------------------------- blocks
  function mapLink(slug, year) {
    return `?view=explore#c=${encodeURIComponent(slug)}&from=${year}-01&to=${year}-12`;
  }

  function bigCards(w) {
    const t = w.thisYear, by = w.busiestYear, bm = w.busiestMonthOfYear;
    const up = t.pct !== null && t.pct >= 0;
    const card = (label, help, numHTML, line, i) =>
      `<div class="hcard" style="--d:${i * 90}ms"><div class="big-label">${label} <button class="q" type="button" data-tip="${esc(help)}" aria-label="${esc(label)}: ${esc(help)}">?</button></div>` +
      `${numHTML}<div class="big-line">${line}</div></div>`;
    const yearsTxt = `${w.fromYear}–${w.toYear}`;
    $("bigCards").innerHTML =
      card("Fires since " + w.fromYear, "Old MODIS counts are converted, so every year can be compared.",
        `<div class="big-num" data-value="${w.totalFair}" title="${full(w.totalFair)} fires" aria-label="${full(w.totalFair)} fires">${compact(w.totalFair)}</div>`,
        `fair count, ${yearsTxt}`, 0) +
      card("Busiest year", "The full year with the most fires (fair count).",
        `<div class="big-num" aria-label="${by.year}${by.terraOnly ? ", only one satellite" : ""}">${by.year}${by.terraOnly ? "*" : ""}</div>`,
        `<span title="${full(by.fair)} fires">${compact(by.fair)} fires (fair count)</span>`, 1) +
      card("Busiest month", "The month with the most fires, on average over all years.",
        `<div class="big-num" title="${full(bm.avgFair)} fires on average">${MONTHS[bm.month - 1]}</div>`,
        "on average, every year", 2) +
      card("This year so far", `${t.year}, 1 January to ${new Date(t.toDate + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "long" })}, vs the same days of ${w.fromYear}–${w.lastFullYear} (the middle value).`,
        t.pct === null ? `<div class="big-num">n/a</div>`
          : `<div class="big-num ${up ? "up" : "down"}" data-value="${t.pct}" data-kind="pct" title="${full(t.fairSoFar)} fires so far; normal ${full(t.normalSameDays)}" aria-label="${pct(t.pct)}, ${up ? "above" : "below"} normal">${pct(t.pct)}</div>`,
        t.pct === null ? "no normal to compare" : `${up ? "above" : "below"} normal · vs the same days of ${w.fromYear}–${w.lastFullYear}`, 3);
    $("terraNote").hidden = !by.terraOnly;
  }

  function yearChart(w) {
    const ys = w.years, max = Math.max(...ys.map((y) => y.fair));
    const best = w.busiestYear.year, mobile = innerWidth <= 560;
    const bars = ys.map((y, i) => {
      const h = max ? (y.fair / max) * 100 : 0, cls = y.year === best ? " best" : y.partial ? " part" : "";
      const label = `${y.year}${y.terraOnly ? "*" : ""} · ${compact(y.fair)} fires (fair count)${y.partial ? ", so far" : ""}`;
      const flag = y.year === best ? `<span class="flag" style="bottom:calc(${h}% + 6px)">${compact(y.fair)}</span>`
        : y.partial ? `<span class="flag" style="bottom:calc(${h}% + 6px)">so far</span>` : "";
      return `<button type="button" class="ybar${cls}" data-tip="${esc(label)}" aria-label="${esc(label)}" style="--d:${i * 25}ms"><i style="height:${h}%"></i>${flag}</button>`;
    }).join("");
    const labels = ys.map((y) => {
      const show = !mobile || y.year % 5 === 0 || y.year === ys[ys.length - 1].year;
      return `<span class="${show ? "" : "hide"}">${y.year}${y.terraOnly ? "*" : ""}</span>`;
    }).join("");
    // A text version of the chart for screen readers
    const table = `<table class="sr-table"><caption>Fair count of fires on Earth, per year</caption><tr><th>Year</th><th>Fires</th></tr>` +
      ys.map((y) => `<tr><td>${y.year}${y.partial ? " (so far)" : ""}</td><td>${full(y.fair)}</td></tr>`).join("") + `</table>`;
    $("yearChart").innerHTML = `<div class="ybars" aria-hidden="true">${bars}</div><div class="ylabels" aria-hidden="true">${labels}</div>` +
      `<div class="sr-only">${table}</div>`;
    // keyboard users can still reach the bars' numbers via the table; the bars stay for mouse/touch
    $("yearChart").querySelectorAll(".ybar").forEach((b) => b.setAttribute("tabindex", "-1"));
  }

  function top5(t) {
    $("topTitle").textContent = `Most fires in ${t.year}`;
    const max = t.items.length ? t.items[0].fair : 0;
    $("top5").innerHTML = t.items.map((c, i) =>
      `<li><a href="${mapLink(c.slug, t.year)}" data-map data-hash="${mapLink(c.slug, t.year).split("#")[1]}" title="${full(c.fair)} fires (fair count) in ${t.year}">` +
      `<span class="rank">${i + 1}</span><span class="cname" title="${esc(c.name)}">${esc(c.name)}</span>` +
      `<span class="tbar"><i style="width:${max ? (c.fair / max) * 100 : 0}%;--d:${i * 80}ms"></i></span>` +
      `<span class="tnum" aria-label="${full(c.fair)} fires">${compact(c.fair)}</span></a></li>`).join("");
  }

  function rate(w) {
    if (w.exchangeRate === null) return;
    const r = w.exchangeRate.toFixed(1);
    $("rateTimes").textContent = `${r}×`;
    $("rateNum").textContent = r;
    $("rateChip").hidden = false;
  }

  function updated(d) {
    if (!d.dataTo) return;
    let ago = "";
    if (d.updated) {
      const hrs = Math.max(0, (Date.now() - Date.parse(d.updated)) / 3600000);
      ago = hrs < 1 ? "less than 1 hour ago" : hrs < 48 ? `${Math.round(hrs)} h ago` : `${Math.round(hrs / 24)} days ago`;
    }
    const to = new Date(d.dataTo + "T00:00:00Z").toLocaleDateString("en-US", { timeZone: "UTC", day: "numeric", month: "short", year: "numeric" });
    $("footUpdated").innerHTML = `<b>Updated:</b> ${ago ? ago + " · " : ""}data to ${to}`;
  }

  // ---------------------------------------------------------------- start
  let data = null;                 // kept in memory (no second download)
  async function load() {
    try {
      const res = await fetch("data/home-summary.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
      const w = data.world;
      bigCards(w); yearChart(w); top5(data.topCountries); rate(w); updated(data);
      document.querySelectorAll(".summary .reveal.in").forEach(revealInner);   // shown while loading
    } catch (err) {
      console.warn("home summary:", err);
      // Simple message; the number blocks hide, the rest keeps working.
      $("sumError").hidden = false;
      ["blockA", "blockB", "blockC"].forEach((id) => { $(id).hidden = true; });
      $("rateTimes").parentElement.textContent = "Its pixels are smaller, so it sees many more fires.";
    }
  }
  // Watch the blocks at once, so the grey skeletons show while the numbers load
  function startReveal() {
    document.querySelectorAll(".step").forEach((s, i) => s.querySelector(".step-num").style.setProperty("--d", i * 120 + "ms"));
    document.querySelectorAll(".summary .reveal").forEach(watch);
  }
  const go = () => { startReveal(); load(); };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", go); else go();

  // The year labels change between mobile and desktop
  let lastMobile = innerWidth <= 560;
  addEventListener("resize", () => {
    const m = innerWidth <= 560;
    if (m !== lastMobile && data) { lastMobile = m; yearChart(data.world); if (document.querySelector("#blockB.in")) $("yearChart").classList.add("in"); }
  });
})();
