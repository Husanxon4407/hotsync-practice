/*
  PyroVision: js/place-picker.js  (control box, step 1 "Place")
  A custom drop-down list for the place field (no library):
  - click / focus the field: the list opens (fade + slide) with "World" on
    top and then ALL countries A-Z, and the text is selected, so typing
    replaces it
  - typing filters the list (place-search.js), matching letters are marked
  - Arrow keys, Enter, Esc work; a click outside closes the list
  ARIA "combobox" pattern, so screen readers announce it as a list.

  HS.initPlacePicker({ input, getPlaces, getCurrent, onPick })
    getPlaces()  -> the list from countries.json
    getCurrent() -> the place shown now (or null)
    onPick(slug) -> load that place
*/
(function () {
  "use strict";

  function initPlacePicker({ input, getPlaces, getCurrent, onPick }) {
    const HS = window.HS;
    const list = document.createElement("ul");
    list.id = "placeList";
    list.className = "place-list";
    list.setAttribute("role", "listbox");
    list.setAttribute("aria-label", "Places");
    input.parentElement.appendChild(list);

    input.removeAttribute("list");                   // no browser list any more
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-expanded", "false");
    input.setAttribute("aria-controls", list.id);

    let hits = [], active = -1, isOpen = false;

    // Draw the list for the text in the field ("" = everything)
    function fill(query) {
      hits = HS.searchPlaces(getPlaces(), query);
      const pinned = !query.trim();                  // empty: World pinned on top
      if (!hits.length) {
        list.innerHTML = `<li class="place-empty" role="option" aria-disabled="true">No country found</li>`;
        active = -1;
        input.removeAttribute("aria-activedescendant");
        return;
      }
      const cur = getCurrent();
      list.innerHTML = hits.map((h, i) => {
        const sel = cur && h.place.slug === cur.slug;
        const sep = pinned && i === 1 ? " sep" : "";
        const alias = h.alias ? `<span class="place-alias">${HS.escapeHTML(h.alias.toUpperCase())}</span>` : "";
        return `<li id="placeOpt${i}" class="place-opt${sep}${h.place.slug === "world" ? " world" : ""}" role="option" aria-selected="${sel}" data-i="${i}">` +
          `<span>${HS.highlightHit(h)}</span>${alias}</li>`;
      }).join("");
      setActive(query.trim() ? 0 : Math.max(0, hits.findIndex((h) => cur && h.place.slug === cur.slug)));
    }

    function setActive(i) {
      const old = list.querySelector(".place-opt.active");
      if (old) old.classList.remove("active");
      active = i;
      const el = i >= 0 ? list.querySelector(`#placeOpt${i}`) : null;
      if (!el) { input.removeAttribute("aria-activedescendant"); return; }
      el.classList.add("active");
      input.setAttribute("aria-activedescendant", el.id);
      // keep the active line visible inside the scrolling list
      const top = el.offsetTop, bottom = top + el.offsetHeight;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight;
    }

    function open() {
      if (isOpen) return;
      isOpen = true;
      fill("");                                      // always the FULL list first
      list.classList.add("open");
      input.setAttribute("aria-expanded", "true");
      input.select();                                // typing replaces "World"
    }

    function close(restore = true) {
      if (!isOpen) return;
      isOpen = false;
      list.classList.remove("open");
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
      const cur = getCurrent();
      if (restore && cur) input.value = cur.name;    // nothing picked: show the place again
    }

    function pick(i) {
      const h = hits[i];
      if (!h) return;
      input.value = h.place.name;
      close(false);
      const cur = getCurrent();
      if (!cur || cur.slug !== h.place.slug) onPick(h.place.slug);
    }

    // Focus by mouse: the mouse-up after it would undo the selection; skip it once.
    let keepSelection = false;
    input.addEventListener("focus", () => { keepSelection = true; open(); });
    input.addEventListener("mouseup", (e) => { if (keepSelection) { e.preventDefault(); keepSelection = false; } });
    input.addEventListener("click", () => { keepSelection = false; if (!isOpen) open(); });
    input.addEventListener("input", () => {
      if (!isOpen) { isOpen = true; list.classList.add("open"); input.setAttribute("aria-expanded", "true"); }
      fill(input.value);
    });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (!isOpen) { open(); return; }
        if (!hits.length) return;
        const step = e.key === "ArrowDown" ? 1 : -1;
        setActive((active + step + hits.length) % hits.length);
      } else if (e.key === "Enter") {
        if (isOpen && active >= 0) { e.preventDefault(); pick(active); }
      } else if (e.key === "Escape") {
        if (isOpen) { e.preventDefault(); close(); input.select(); }
      } else if (e.key === "Tab") {
        close();
      } else if (e.key === "Home" && isOpen && !input.value) {
        setActive(0);
      }
    });
    // mousedown (not click): the field must not lose focus before we pick
    list.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const li = e.target.closest(".place-opt");
      if (li) pick(+li.dataset.i);
    });
    list.addEventListener("mousemove", (e) => {
      const li = e.target.closest(".place-opt");
      if (li && +li.dataset.i !== active) setActive(+li.dataset.i);
    });
    // a click anywhere else closes the list
    document.addEventListener("pointerdown", (e) => {
      if (isOpen && e.target !== input && !list.contains(e.target)) close();
    });
    input.addEventListener("blur", () => setTimeout(() => { if (document.activeElement !== input) close(); }, 0));

    return { open, close };
  }

  window.HS = window.HS || {};
  window.HS.initPlacePicker = initPlacePicker;
})();
