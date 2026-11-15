/*
  PyroVision: js/date-picker.js  (control box, step 2 "Dates")
  One button ("Jan 2001 – Nov 2026"). A click opens a pop-up (laptop) or a
  sheet that slides up from the bottom (phone) with:
  - "Start: ___  End: ___" on top: you always see which one you are setting
  - quick buttons: All years, Last 12 months, This year, Last 5 years
  - a year list (2001 -> latest) with a tiny bar = that year's fires
  - the 12 months of the chosen year. 1st click = start, 2nd click = end,
    months in between are highlighted; the range can cross years
  - months after the newest data can't be picked
  - Apply / Reset; Esc or a click outside closes it (nothing changes)

  HS.initDatePicker({ button, getData, onApply })
    getData() -> { first, last, from, to, yearTotals: {year: fires}, partialYear }
    onApply(from, to)   ('YYYY-MM' strings, from <= to)
*/
(function () {
  "use strict";

  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const MON_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
  const ym = (y, m) => `${y}-${String(m).padStart(2, "0")}`;            // (2019, 3) -> "2019-03"
  const label = (s) => (s ? `${MON[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}` : "");
  const addMonths = (s, k) => { const t = +s.slice(0, 4) * 12 + (+s.slice(5, 7) - 1) + k; return ym(Math.floor(t / 12), (t % 12) + 1); };
  const compact = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(Math.round(v)));
  const CAL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>';

  function initDatePicker({ button, getData, onApply }) {
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    const phone = () => matchMedia("(max-width: 640px)").matches;
    let el, back, d = null, isOpen = false;
    // pend = what the user is choosing (not applied yet)
    const pend = { start: null, end: null, next: "start", year: 0, hover: null };

    // The button in the Dates box
    button.innerHTML = `${CAL_ICON}<span class="dp-btn-text" id="dpBtnText"></span><span class="dp-caret" aria-hidden="true"></span>`;
    button.setAttribute("aria-haspopup", "dialog");
    button.setAttribute("aria-expanded", "false");

    function build() {
      back = document.createElement("div");
      back.className = "dp-back";
      el = document.createElement("div");
      el.className = "dp";
      el.id = "datePop";
      el.setAttribute("role", "dialog");
      el.setAttribute("aria-label", "Choose the dates");
      el.hidden = back.hidden = true;
      el.innerHTML = `
        <div class="dp-slots">
          <button type="button" class="dp-slot" data-slot="start" aria-label="Set the start month"><span class="k">Start</span><span class="v" id="dpStart"></span></button>
          <span class="dp-arrow" aria-hidden="true">→</span>
          <button type="button" class="dp-slot" data-slot="end" aria-label="Set the end month"><span class="k">End</span><span class="v" id="dpEnd"></span></button>
        </div>
        <p class="dp-hint" id="dpHint" aria-live="polite"></p>
        <div class="dp-quick" role="group" aria-label="Quick choices">
          <button type="button" data-q="all">All years</button>
          <button type="button" data-q="12m">Last 12 months</button>
          <button type="button" data-q="year">This year</button>
          <button type="button" data-q="5y">Last 5 years</button>
        </div>
        <div class="dp-main">
          <div class="dp-years" id="dpYears" role="group" aria-label="Years (bar = fires that year)"></div>
          <div class="dp-months">
            <div class="dp-yhead">
              <button type="button" class="dp-nav" data-step="-1" aria-label="Previous year">‹</button>
              <b id="dpYear"></b>
              <button type="button" class="dp-nav" data-step="1" aria-label="Next year">›</button>
            </div>
            <div class="dp-grid" id="dpGrid" role="group" aria-label="Months"></div>
          </div>
        </div>
        <div class="dp-foot">
          <button type="button" class="ghost-btn" data-act="reset">Reset</button>
          <button type="button" class="btn-ember" data-act="apply">Apply</button>
        </div>`;
      document.body.append(back, el);

      back.addEventListener("click", () => close());
      el.addEventListener("click", (e) => {
        const t = e.target.closest("button");
        if (!t) return;
        if (t.dataset.slot) { pend.next = t.dataset.slot; pend.year = +(pend[t.dataset.slot] || d.last).slice(0, 4); draw(); }
        else if (t.dataset.q) quick(t.dataset.q);
        else if (t.dataset.year) { pend.year = +t.dataset.year; draw(); focusMonth(); }
        else if (t.dataset.step) moveYear(+t.dataset.step);
        else if (t.dataset.m) pickMonth(t.dataset.m);
        else if (t.dataset.act === "reset") { pend.start = d.defaultFrom || firstPick(); pend.end = d.last; pend.next = "start"; pend.year = +d.last.slice(0, 4); draw(); }
        else if (t.dataset.act === "apply") apply();
      });
      // preview the range while choosing the end month
      el.addEventListener("mouseover", (e) => {
        const t = e.target.closest("[data-m]");
        const h = t && pend.next === "end" && pend.start ? t.dataset.m : null;
        if (h !== pend.hover) { pend.hover = h; paintRange(); }
      });
      el.addEventListener("keydown", onKey);
      document.addEventListener("pointerdown", (e) => {
        if (isOpen && !el.contains(e.target) && !button.contains(e.target)) close();
      });
      window.addEventListener("resize", () => isOpen && place());
      window.addEventListener("scroll", () => isOpen && place(), { passive: true });
    }

    const firstPick = () => (d.first > "2001-01" ? d.first : "2001-01");

    // Laptop: under the button (stays with the sticky box). Phone: CSS sheet.
    function place() {
      if (phone()) { el.style.top = el.style.left = ""; return; }
      const r = button.getBoundingClientRect(), w = el.offsetWidth;
      el.style.top = Math.round(r.bottom + 6) + "px";
      el.style.left = Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8))) + "px";
    }

    function open() {
      if (!el) build();
      d = getData();
      Object.assign(pend, { start: d.from, end: d.to, next: "start", year: +d.from.slice(0, 4), hover: null });
      draw();
      el.hidden = back.hidden = false;
      el.classList.toggle("sheet", phone());
      back.classList.toggle("sheet", phone());
      place();
      requestAnimationFrame(() => { el.classList.add("open"); back.classList.add("open"); });
      isOpen = true;
      button.setAttribute("aria-expanded", "true");
      focusMonth();
    }

    function close(focusBack = true) {
      if (!isOpen) return;
      isOpen = false;
      el.classList.remove("open"); back.classList.remove("open");
      button.setAttribute("aria-expanded", "false");
      setTimeout(() => { if (!isOpen) el.hidden = back.hidden = true; }, reduce ? 0 : 200);
      if (focusBack) button.focus();
    }

    function apply() {
      let a = pend.start || d.from, b = pend.end || a;
      if (a > b) [a, b] = [b, a];
      close();
      if (a !== d.from || b !== d.to) onApply(a, b);
    }

    // Quick buttons choose AND apply at once
    function quick(q) {
      const last = d.last, Y = +last.slice(0, 4);
      const start = { all: firstPick(), "12m": addMonths(last, -11), year: ym(Y, 1), "5y": ym(Y - 4, 1) }[q];
      pend.start = start < firstPick() ? firstPick() : start;
      pend.end = last;
      apply();
    }

    function pickMonth(m) {
      if (pend.next === "start") {
        pend.start = m; pend.end = null; pend.next = "end";       // now choose the end
      } else {
        if (m < pend.start) { pend.end = pend.start; pend.start = m; } else pend.end = m;
        pend.next = "start";
      }
      pend.hover = null;
      draw();
      focusMonth(m);
    }

    function moveYear(step) {
      const y = pend.year + step;
      if (y < +firstPick().slice(0, 4) || y > +d.last.slice(0, 4)) return;
      pend.year = y;
      draw();
    }

    // ---- drawing
    function draw() {
      // Button text in the Dates box is drawn by setLabel(); here the pop-up.
      el.querySelector("#dpStart").textContent = label(pend.start) || "pick a month";
      el.querySelector("#dpEnd").textContent = label(pend.end) || "pick a month";
      el.querySelector("#dpEnd").classList.toggle("empty", !pend.end);
      el.querySelectorAll(".dp-slot").forEach((b) => {
        const on = b.dataset.slot === pend.next;
        b.classList.toggle("active", on);
        b.setAttribute("aria-pressed", String(on));
      });
      el.querySelector("#dpHint").textContent = pend.next === "start"
        ? "Click a month to set the START."
        : "Now click the END month (it can be in another year).";

      // years + bars
      const y0 = +firstPick().slice(0, 4), y1 = +d.last.slice(0, 4);
      const vals = Object.values(d.yearTotals || {}), max = Math.max(1, ...vals.filter(Number.isFinite));
      const sy = +(pend.start || "0000").slice(0, 4), ey = +((pend.end || pend.start) || "0000").slice(0, 4);
      let yh = "";
      for (let y = y0; y <= y1; y++) {
        const v = d.yearTotals ? d.yearTotals[y] : null;
        const bar = Number.isFinite(v)
          ? `<i class="dp-bar${y === d.partialYear ? " part" : ""}" style="--w:${Math.max(2, (v / max) * 100).toFixed(1)}%"></i>` : "";
        const inRange = y >= Math.min(sy, ey) && y <= Math.max(sy, ey);
        const t = Number.isFinite(v) ? `${y}: ${compact(v)} fires (fair count)${y === d.partialYear ? ", so far" : ""}` : String(y);
        yh += `<button type="button" class="dp-yr${y === pend.year ? " cur" : ""}${inRange ? " in" : ""}" data-year="${y}" title="${t}" aria-label="${t}"${y === pend.year ? ' aria-current="true"' : ""}><span>${y}</span>${bar}</button>`;
      }
      const years = el.querySelector("#dpYears");
      years.innerHTML = yh;
      const cur = years.querySelector(".cur");
      if (cur) years.scrollTop = cur.offsetTop - years.clientHeight / 2 + cur.offsetHeight / 2;

      // months of the chosen year
      el.querySelector("#dpYear").textContent = pend.year;
      el.querySelector('[data-step="-1"]').disabled = pend.year <= y0;
      el.querySelector('[data-step="1"]').disabled = pend.year >= y1;
      let gh = "";
      for (let k = 1; k <= 12; k++) {
        const m = ym(pend.year, k), off = m > d.last || m < firstPick();
        gh += `<button type="button" class="dp-m" data-m="${m}"${off ? " disabled" : ""} aria-label="${MON_LONG[k - 1]} ${pend.year}${off ? " (no data yet)" : ""}">${MON[k - 1]}</button>`;
      }
      el.querySelector("#dpGrid").innerHTML = gh;
      paintRange();
    }

    // start / end / in-between marks (and the hover preview)
    function paintRange() {
      let a = pend.start, b = pend.end || pend.hover || null;
      if (a && b && b < a) [a, b] = [b, a];
      el.querySelectorAll(".dp-m").forEach((x) => {
        const m = x.dataset.m;
        const isA = m === a, isB = b && m === b;
        x.classList.toggle("start", isA);
        x.classList.toggle("end", !!isB);
        x.classList.toggle("in", !!(a && b && m > a && m < b));
        x.classList.toggle("preview", !pend.end && !!pend.hover);
        x.setAttribute("aria-pressed", String(isA || !!isB));
      });
    }

    function focusMonth(m) {
      const want = m || pend[pend.next] || pend.start;
      const btn = (want && el.querySelector(`[data-m="${want}"]:not([disabled])`)) || el.querySelector(".dp-m:not([disabled])");
      if (btn) btn.focus({ preventScroll: true });
    }

    // Keyboard: arrows move between months (and years), Esc closes
    function onKey(e) {
      if (e.key === "Escape") { e.preventDefault(); close(); return; }
      const t = e.target.closest(".dp-m");
      if (!t) return;
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -3, ArrowDown: 3 }[e.key];
      if (!step) return;
      e.preventDefault();
      const to = addMonths(t.dataset.m, step);
      if (to > d.last || to < firstPick()) return;
      if (+to.slice(0, 4) !== pend.year) { pend.year = +to.slice(0, 4); draw(); }
      focusMonth(to);
    }

    // The text on the button ("Jan 2001 – Nov 2026")
    function setLabel(from, to) {
      const t = `${label(from)} – ${label(to)}`;
      button.querySelector("#dpBtnText").textContent = t;
      button.setAttribute("aria-label", `Dates: ${t}. Click to change`);
    }

    button.addEventListener("click", () => (isOpen ? close() : open()));
    return { open, close, setLabel };
  }

  window.HS = window.HS || {};
  window.HS.initDatePicker = initDatePicker;
})();
