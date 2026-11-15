/*
  PyroVision: js/place-search.js
  Finds places by name. Used by the place list (place-picker.js) and by the
  search box of the globe (globe-picker.js), so both find the same things.

  - case does not matter, accents do not matter ("Côte" = "Cote")
  - places whose name STARTS with the text come first, then names that
    CONTAIN it, each group A-Z
  - short names work too: USA, UK, UAE, Russia, DRC ... (ALIASES below)
  The names themselves come from data/countries.json (the NASA FIRMS names).
*/
(function () {
  "use strict";

  // Short / common name -> slug of the place in data/countries.json.
  // (An alias whose slug is not in the list is simply ignored.)
  const ALIASES = {
    "usa": "united-states", "us": "united-states", "u s": "united-states", "america": "united-states",
    "united states of america": "united-states",
    "uk": "united-kingdom", "britain": "united-kingdom", "great britain": "united-kingdom",
    "england": "united-kingdom", "scotland": "united-kingdom", "wales": "united-kingdom",
    "uae": "united-arab-emirates", "emirates": "united-arab-emirates",
    "russia": "russian-federation",
    "korea": "republic-of-korea", "south korea": "republic-of-korea",
    "north korea": "dem-rep-korea", "dprk": "dem-rep-korea",
    "drc": "democratic-republic-of-the-congo", "dr congo": "democratic-republic-of-the-congo",
    "congo kinshasa": "democratic-republic-of-the-congo",
    "congo brazzaville": "republic-of-congo",
    "ivory coast": "cote-d-ivoire",
    "laos": "lao-pdr",
    "eswatini": "swaziland",
    "north macedonia": "macedonia-former-yugoslav-republic-of", "macedonia": "macedonia-former-yugoslav-republic-of",
    "czechia": "czech-republic",
    "cabo verde": "cape-verde",
    "gambia": "the-gambia",
    "east timor": "timor-leste",
    "micronesia": "federated-states-of-micronesia",
    "brunei": "brunei-darussalam",
    "burma": "myanmar",
    "viet nam": "vietnam",
    "holland": "netherlands",
    "persia": "iran",
    "car": "central-african-republic",
    "png": "papua-new-guinea",
    "bosnia": "bosnia-and-herzegovina",
    "earth": "world", "globe": "world", "all": "world",
  };

  // Fold a text for comparing: no accents, lower case, any punctuation -> one
  // space. Also returns, for every folded letter, its place in the original
  // text, so the matching letters can be highlighted in the real name.
  function foldWithMap(text) {
    let out = "", map = [], space = true;
    for (let i = 0; i < text.length; i++) {
      const base = text[i].normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
      for (const ch of base) {
        if (/[a-z0-9]/.test(ch)) { out += ch; map.push(i); space = false; }
        else if (!space) { out += " "; map.push(i); space = true; }
      }
    }
    if (out.endsWith(" ")) { out = out.slice(0, -1); map.pop(); }
    return { text: out, map };
  }
  const fold = (t) => foldWithMap(t).text;

  /*
    search(places, query) -> list of hits, best first:
      { place, start, end, alias }
    start/end: the matching letters in place.name (end not included),
    or -1 when the place was found through a short name (alias).
  */
  function search(places, query) {
    const q = fold(query || "");
    if (!q) return places.map((place) => ({ place, start: -1, end: -1, alias: null }));
    const bySlug = new Map(places.map((p) => [p.slug, p]));
    const hits = [], seen = new Set();
    const add = (place, start, end, alias, rank) => {
      if (seen.has(place.slug)) return;
      seen.add(place.slug);
      hits.push({ place, start, end, alias, rank });
    };
    // 1) exact short name ("usa", "uk")  2) short names that start with the text
    for (const [alias, slug] of Object.entries(ALIASES)) {
      const p = bySlug.get(slug);
      if (!p) continue;
      if (alias === q) add(p, -1, -1, alias, 0);
    }
    const prepared = places.map((p) => ({ p, f: foldWithMap(p.name) }));
    // 3) names that START with the text, 4) a word that starts with it, 5) contain it
    for (const rank of [1, 2, 3]) {
      for (const { p, f } of prepared) {
        let k = -1;
        if (rank === 1 && f.text.startsWith(q)) k = 0;
        else if (rank === 2) { const w = f.text.indexOf(" " + q); if (w >= 0) k = w + 1; }
        else if (rank === 3) k = f.text.indexOf(q);
        if (k < 0) continue;
        const start = f.map[k], end = f.map[k + q.length - 1] + 1;
        add(p, start, end, null, rank);
      }
    }
    for (const [alias, slug] of Object.entries(ALIASES)) {
      const p = bySlug.get(slug);
      if (p && alias !== q && alias.startsWith(q) && q.length >= 2) add(p, -1, -1, alias, 4);
    }
    // Same rank: A-Z (World always first)
    hits.sort((a, b) => a.rank - b.rank || (a.place.slug === "world" ? -1 : b.place.slug === "world" ? 1 : a.place.name.localeCompare(b.place.name)));
    return hits;
  }

  // Safe HTML of a name with the matching letters in <mark>.
  const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function highlight(hit) {
    const n = hit.place.name;
    if (hit.start < 0) return esc(n);
    return esc(n.slice(0, hit.start)) + "<mark>" + esc(n.slice(hit.start, hit.end)) + "</mark>" + esc(n.slice(hit.end));
  }

  window.HS = window.HS || {};
  Object.assign(window.HS, { searchPlaces: search, highlightHit: highlight, foldName: fold, escapeHTML: esc });
})();
