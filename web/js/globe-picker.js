/*
  HotSync: js/globe-picker.js  (control box, step 1 "Place": "Find on globe")
  A 3D globe in a big window (full screen on phones) to pick a country.

  - Nothing is loaded with the page. The globe library (globe.gl, from a CDN)
    and the borders (data/globe_countries.json) load the FIRST time the
    button is pressed.
  - Borders = our own Natural Earth file with the NASA FIRMS names
    (countries.py --globe), so every country on the globe has exactly the
    name and slug the website uses. No name guessing.
  - Hover: the country rises + its name. Click: that country opens.
  - Names appear by zoom: big countries first; a smaller one only when it
    is big enough on screen and its name does not overlap another name.
  - Search box: typing a name flies the camera there.
  - Faint orange tint = how many fires (fair count) the country had.
  - No WebGL: a short message, and the normal list still works.

  HS.initGlobePicker({ button, getPlaces, getCurrent, onPick })
*/
(function () {
  "use strict";

  const GLOBE_JS = "https://cdn.jsdelivr.net/npm/globe.gl@2.32.4/dist/globe.gl.min.js";
  const IMG = "https://cdn.jsdelivr.net/npm/three-globe@2.31.1/example/img/";
  const SHAPES = "data/globe_countries.json";
  const EMBER = "255, 106, 31";
  const X_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>';

  function loadScript(src) {
    return new Promise((ok, fail) => {
      const s = document.createElement("script");
      s.src = src; s.async = true;
      s.onload = ok;
      s.onerror = () => fail(new Error("could not load " + src));
      document.head.appendChild(s);
    });
  }
  function hasWebGL() {
    try {
      const c = document.createElement("canvas");
      return !!(window.WebGLRenderingContext && (c.getContext("webgl2") || c.getContext("webgl")));
    } catch (e) { return false; }
  }
  const compact = (v) => (v >= 1e6 ? (v / 1e6).toFixed(1).replace(/\.0$/, "") + "M" : v >= 1e4 ? Math.round(v / 1e3) + "k" : Math.round(v).toLocaleString("en-US"));
  // Angle (degrees) between two places on the sphere: is a label on the side we see?
  function angle(a, b) {
    const r = Math.PI / 180;
    const c = Math.sin(a.lat * r) * Math.sin(b.lat * r) + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.cos((a.lng - b.lng) * r);
    return Math.acos(Math.min(1, Math.max(-1, c))) / r;
  }
  // Camera height that shows a country of this size (area in square degrees)
  const altFor = (f) => Math.min(2.2, Math.max(0.4, 0.35 + Math.sqrt(f.properties.area) / 18));

  function initGlobePicker({ button, getPlaces, getCurrent, onPick }) {
    const HS = window.HS;
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let modal, box, globe = null, feats = [], bySlug = new Map(), loading = null;
    let hover = null, found = null, lastFocus = null, labelKey = "", labelTimer = 0;
    const labelEls = new Map();
    let results = [], active = -1;
    let paint = () => {};          // re-colours the countries (set in makeGlobe)

    // ---------------------------------------------------------------- window
    function buildModal() {
      modal = document.createElement("div");
      modal.className = "gmodal";
      modal.hidden = true;
      modal.innerHTML = `
        <div class="gmodal-back" data-close></div>
        <div class="gmodal-box" role="dialog" aria-modal="true" aria-labelledby="globeTitle">
          <div class="gmodal-head">
            <h2 id="globeTitle">Find a place on the globe</h2>
            <div class="gsearch">
              <input id="globeSearch" type="text" placeholder="Search a country…" autocomplete="off" spellcheck="false"
                     role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="globeResults"
                     aria-label="Search a country: the globe turns to it">
              <ul id="globeResults" class="place-list gresults" role="listbox" aria-label="Matching countries"></ul>
            </div>
            <button type="button" class="ghost-btn" id="globeWorld">Whole world</button>
            <button type="button" class="icon-x" data-close aria-label="Close the globe">${X_ICON}</button>
          </div>
          <div class="gmodal-body">
            <div id="globeBox" class="globe-box"></div>
            <div class="globe-msg" id="globeMsg" role="status" aria-live="polite"></div>
            <div class="globe-found" id="globeFound" hidden>
              <span id="globeFoundName"></span>
              <button type="button" class="btn-ember" id="globeOpen">Open this country</button>
            </div>
          </div>
          <p class="gmodal-foot">Drag to turn · scroll or pinch to zoom · click a country to open it · Esc closes</p>
        </div>`;
      document.body.appendChild(modal);
      box = modal.querySelector("#globeBox");

      modal.addEventListener("click", (e) => { if (e.target.closest("[data-close]")) close(); });
      modal.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { e.preventDefault(); close(); }
        else if (e.key === "Tab") trapFocus(e);
      });
      modal.querySelector("#globeWorld").addEventListener("click", () => choose("world"));
      modal.querySelector("#globeOpen").addEventListener("click", () => found && choose(found.properties.slug));
      wireSearch();
      window.addEventListener("resize", () => { if (globe && !modal.hidden) sizeGlobe(); });
    }

    // Keep the keyboard inside the window while it is open
    function trapFocus(e) {
      const els = [...modal.querySelectorAll("button, input")].filter((el) => !el.hidden && el.offsetParent !== null);
      if (!els.length) return;
      const first = els[0], last = els[els.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }

    const msg = (html) => { modal.querySelector("#globeMsg").innerHTML = html; };

    function open() {
      if (!modal) buildModal();
      lastFocus = document.activeElement;
      modal.hidden = false;
      document.documentElement.classList.add("no-scroll");
      requestAnimationFrame(() => modal.classList.add("open"));
      const search = modal.querySelector("#globeSearch");
      search.value = "";
      showResults("");
      setTimeout(() => search.focus(), 30);
      if (!hasWebGL()) {
        msg(`Your browser can't show the 3D globe (WebGL is turned off or not supported).<br>
             <button type="button" class="ghost-btn" id="globeUseList">Use the list instead</button>`);
        modal.querySelector("#globeUseList").addEventListener("click", () => { close(); document.getElementById("countryInput").focus(); });
        return;
      }
      ensureGlobe().then(() => {
        sizeGlobe();
        globe.resumeAnimation();
        flyToCurrent(0);
      }).catch((err) => console.error(err));
    }

    function close() {
      if (!modal || modal.hidden) return;
      modal.classList.remove("open");
      document.documentElement.classList.remove("no-scroll");
      setTimeout(() => {
        modal.hidden = true;
        if (globe) globe.pauseAnimation();           // no drawing while closed
      }, reduce ? 0 : 200);
      if (lastFocus && lastFocus.focus) lastFocus.focus();
    }

    // Pick a place: close the window and load it on the page
    function choose(slug) {
      const place = getPlaces().find((p) => p.slug === slug);
      if (!place) {
        const f = bySlug.get(slug);
        msg(`No fire data for <b>${HS.escapeHTML(f ? f.properties.name : slug)}</b> in NASA FIRMS. Try another country.`);
        return;
      }
      close();
      const cur = getCurrent();
      if (!cur || cur.slug !== slug) onPick(slug);
    }

    // ---------------------------------------------------------------- globe
    function ensureGlobe() {
      if (globe) return Promise.resolve();
      if (!loading) {
        msg('<span class="spin" aria-hidden="true"></span>Loading the globe…');
        loading = Promise.all([
          window.Globe ? null : loadScript(GLOBE_JS),
          fetch(SHAPES).then((r) => { if (!r.ok) throw new Error(SHAPES + ": HTTP " + r.status); return r.json(); }),
        ]).then(([, shapes]) => {
          feats = shapes.features;
          bySlug = new Map(feats.map((f) => [f.properties.slug, f]));
          makeGlobe();
          msg("");
        }).catch((err) => {
          loading = null;
          msg("Could not load the globe. Check your internet connection, or use the list.");
          throw err;
        });
      }
      return loading;
    }

    function makeGlobe() {
      const fires = new Map(getPlaces().map((p) => [p.slug, p.total_H || 0]));
      const maxLog = Math.log10(Math.max(1, ...fires.values()) + 1);
      const capColor = (f) => {
        if (f === hover || f === found) return `rgba(${EMBER}, 0.78)`;
        const h = fires.get(f.properties.slug) || 0;
        if (!f.properties.has_data || !h) return "rgba(255, 255, 255, 0.02)";
        return `rgba(${EMBER}, ${(0.03 + 0.17 * Math.log10(h + 1) / maxLog).toFixed(3)})`;
      };
      const tip = (f) => {
        const p = f.properties, h = fires.get(p.slug);
        const line = !p.has_data ? "no fire data" : h ? `${compact(h)} fires in 2000–2025 (fair count)` : "no fires counted";
        return `<div class="globe-tip"><b>${HS.escapeHTML(p.name)}</b><span>${line}</span></div>`;
      };

      globe = window.Globe({ animateIn: !reduce })(box)
        .backgroundColor("rgba(0,0,0,0)")
        .globeImageUrl(IMG + "earth-blue-marble.jpg")
        .bumpImageUrl(IMG + "earth-topology.png")
        .showAtmosphere(true).atmosphereColor("#ffb27a").atmosphereAltitude(0.13)
        .polygonsData(feats)
        .polygonSideColor(() => "rgba(20, 18, 16, 0.35)")
        .polygonStrokeColor(() => "rgba(255, 245, 235, 0.45)")
        .polygonsTransitionDuration(reduce ? 0 : 200)
        .polygonLabel(tip)
        .onPolygonHover((f) => {
          hover = f;
          paint();
          box.style.cursor = f ? (f.properties.has_data ? "pointer" : "not-allowed") : "grab";
        })
        .onPolygonClick((f) => choose(f.properties.slug))
        .htmlElementsData([])
        .htmlLat((f) => f.properties.lat)
        .htmlLng((f) => f.properties.lng)
        .htmlAltitude(0.03)
        .htmlElement((f) => {
          let el = labelEls.get(f.properties.slug);
          if (!el) {
            el = document.createElement("div");
            el.className = "globe-label";
            el.textContent = f.properties.name;
            labelEls.set(f.properties.slug, el);
          }
          return el;
        })
        .onZoom(() => scheduleLabels());
      paint = () => globe.polygonCapColor((f) => capColor(f)).polygonAltitude((f) => (f === hover || f === found ? 0.03 : 0.006));
      paint();
      const ctl = globe.controls();
      ctl.autoRotate = !reduce;
      ctl.autoRotateSpeed = 0.35;
      ctl.enableDamping = true;
      box.addEventListener("pointerdown", () => { ctl.autoRotate = false; }, { once: true });
      box.style.cursor = "grab";
      sizeGlobe();
    }

    function sizeGlobe() {
      globe.width(box.clientWidth).height(box.clientHeight);
      scheduleLabels();
    }

    function flyToCurrent(ms) {
      const cur = getCurrent(), f = cur && bySlug.get(cur.slug);
      found = null;
      modal.querySelector("#globeFound").hidden = true;
      paint();
      globe.pointOfView(f ? { lat: f.properties.lat, lng: f.properties.lng, altitude: altFor(f) } : { lat: 22, lng: 20, altitude: 2.3 }, ms);
    }

    // ---------------------------------------------------------------- names by zoom
    function scheduleLabels() {
      if (labelTimer) return;
      labelTimer = setTimeout(() => { labelTimer = 0; placeLabels(); }, 120);
    }
    const byArea = () => feats.slice().sort((a, b) => b.properties.area - a.properties.area);
    let sorted = null;

    function placeLabels() {
      if (!globe || modal.hidden) return;
      sorted = sorted || byArea();
      const W = box.clientWidth, H = box.clientHeight, pov = globe.pointOfView();
      // pixels per degree at the middle of the view: how big things look now
      const a = globe.getScreenCoords(pov.lat, pov.lng, 0), b = globe.getScreenCoords(pov.lat, pov.lng + 1, 0);
      const pxPerDeg = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      // the part of the globe we can see shrinks as we zoom in: keep names
      // well inside it (not squeezed at the edge)
      const horizon = Math.acos(1 / (1 + pov.altitude)) * 180 / Math.PI;
      const bottom = modal.querySelector("#globeFound").hidden ? H : H - 70;   // keep clear of the "Open" bar
      const boxes = [], show = [];
      for (const f of sorted) {
        const p = f.properties;
        if (angle(pov, p) > horizon * 0.78) continue;           // far side or right at the edge
        if (Math.sqrt(p.area) * pxPerDeg < 30) continue;        // too small on screen to name
        const s = globe.getScreenCoords(p.lat, p.lng, 0.03);
        if (!s || s.x < 0 || s.y < 0 || s.x > W || s.y > bottom) continue;
        const w = p.name.length * 6.4 + 16, h = 22;          // a name + some room around it
        const r = { x1: s.x - w / 2, x2: s.x + w / 2, y1: s.y - h / 2, y2: s.y + h / 2 };
        if (boxes.some((q) => r.x1 < q.x2 && r.x2 > q.x1 && r.y1 < q.y2 && r.y2 > q.y1)) continue;   // would overlap
        boxes.push(r);
        show.push(f);
        if (show.length >= 70) break;
      }
      const key = show.map((f) => f.properties.slug).join();
      if (key !== labelKey) { labelKey = key; globe.htmlElementsData(show); }
    }

    // ---------------------------------------------------------------- search box
    function wireSearch() {
      const input = modal.querySelector("#globeSearch"), list = modal.querySelector("#globeResults");
      input.addEventListener("input", () => showResults(input.value));
      input.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          if (!results.length) return;
          setActive((active + (e.key === "ArrowDown" ? 1 : -1) + results.length) % results.length);
        } else if (e.key === "Enter") {
          e.preventDefault();
          if (results.length) goTo(results[Math.max(0, active)].place.slug);
        }
      });
      list.addEventListener("mousedown", (e) => {
        e.preventDefault();
        const li = e.target.closest(".place-opt");
        if (li) goTo(results[+li.dataset.i].place.slug);
      });
    }

    function showResults(q) {
      const input = modal.querySelector("#globeSearch"), list = modal.querySelector("#globeResults");
      if (!q.trim()) {
        results = []; active = -1;
        list.classList.remove("open"); list.innerHTML = "";
        input.setAttribute("aria-expanded", "false");
        return;
      }
      results = HS.searchPlaces(getPlaces(), q).slice(0, 7);
      list.innerHTML = results.length
        ? results.map((h, i) => `<li id="globeOpt${i}" class="place-opt" role="option" data-i="${i}">${HS.highlightHit(h)}${h.alias ? `<span class="place-alias">${HS.escapeHTML(h.alias.toUpperCase())}</span>` : ""}</li>`).join("")
        : `<li class="place-empty" role="option" aria-disabled="true">No country found</li>`;
      list.classList.add("open");
      input.setAttribute("aria-expanded", "true");
      setActive(results.length ? 0 : -1);
    }
    function setActive(i) {
      const input = modal.querySelector("#globeSearch"), list = modal.querySelector("#globeResults");
      list.querySelectorAll(".place-opt.active").forEach((el) => el.classList.remove("active"));
      active = i;
      const el = list.querySelector(`#globeOpt${i}`);
      if (el) { el.classList.add("active"); input.setAttribute("aria-activedescendant", el.id); }
      else input.removeAttribute("aria-activedescendant");
    }

    // Fly the camera to a country (World: pick it at once)
    function goTo(slug) {
      // World, no globe (no WebGL / still loading) or a place too small for
      // the globe map: open it directly.
      const f = bySlug.get(slug);
      showResults("");
      if (slug === "world" || !globe || !f) { choose(slug); return; }
      msg("");
      globe.controls().autoRotate = false;
      found = f;
      paint();
      globe.pointOfView({ lat: f.properties.lat, lng: f.properties.lng, altitude: altFor(f) }, reduce ? 0 : 1200);
      modal.querySelector("#globeFoundName").textContent = f.properties.name;
      modal.querySelector("#globeFound").hidden = false;
      modal.querySelector("#globeSearch").value = f.properties.name;
    }

    button.addEventListener("click", open);
    return { open, close };
  }

  window.HS = window.HS || {};
  window.HS.initGlobePicker = initGlobePicker;
})();
