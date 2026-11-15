/*
  PyroVision home page: home.js
  Home <-> map navigation.
  - Every link with data-map opens the map: the address gets ?view=explore
    (a top-5 row also gets its #c=... view), a new history entry is added,
    the 3D Earth is freed, and the map (map.html) opens in a full-screen iframe.
  - An address with ?view=explore OR a hash starting with #c= opens the map
    at once, so old share links (/web/#c=...) still work.
  - Back returns home; Refresh keeps the view.
  - The map tells us its view (postMessage), so the visible address is always
    the exact view people can share.
*/
import { createEarth } from "./earth.js?v=20261115h4";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
let earthScene = null, frame = null;

const wantsMap = (url = location) => new URLSearchParams(url.search).get("view") === "explore" || url.hash.startsWith("#c=");

// ---------------------------------------------------------------- home
function showHome() {
  root.classList.remove("map-open");
  document.title = "PyroVision · Fire on Earth, counted fairly";
  $("homeRoot").inert = false;
  if (frame) { frame.remove(); frame = null; }          // free the map
  if (!earthScene) {
    try {
      earthScene = createEarth({ hero: $("hero"), host: $("earthCanvas"), fallback: $("earthFallback"),
        replayBtn: $("replayBtn"), pauseBtn: $("pauseBtn") });
    } catch (err) {
      console.warn("Earth:", err);
      $("earthFallback").hidden = false;
    }
  }
}

// ---------------------------------------------------------------- map
function showMap() {
  if (earthScene) { earthScene.destroy(); earthScene = null; }   // release the 3D scene
  root.classList.add("map-open");
  $("homeRoot").inert = true;                           // hidden from Tab and screen readers
  document.title = "PyroVision · Fire map";
  const src = "map.html" + (location.hash.startsWith("#c=") ? location.hash : "");
  if (!frame) {
    frame = document.createElement("iframe");
    frame.className = "map-frame";
    frame.title = "PyroVision fire map and satellite dashboard";
    frame.allow = "clipboard-write; fullscreen";        // Share copies the link; map full screen
    frame.setAttribute("allowfullscreen", "");
    frame.src = src;
    document.body.appendChild(frame);
  } else if (frame.contentWindow && location.hash !== frame.contentWindow.location.hash) {
    frame.contentWindow.location.replace(src);          // a different view: the map reloads it
  }
  frame.focus();
  window.scrollTo(0, 0);
}

// Open the map from a link (keeps other query parameters; adds history)
function openMap(hash) {
  const url = new URL(location.href);
  url.searchParams.set("view", "explore");
  if (hash) url.hash = hash;
  history.pushState({ view: "explore" }, "", url);
  showMap();
}

document.addEventListener("click", (e) => {
  const a = e.target.closest("[data-map]");
  if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;   // new tab: let the browser do it
  e.preventDefault();
  openMap(a.dataset.hash ? "#" + a.dataset.hash : "");
});

// Back / Forward
addEventListener("popstate", () => (wantsMap() ? showMap() : showHome()));

// The map's own view changes: keep the visible address in sync (no new history)
addEventListener("message", (e) => {
  if (!frame || e.source !== frame.contentWindow || e.origin !== location.origin) return;
  const d = e.data;
  if (d && d.type === "hotsync-hash" && typeof d.hash === "string" && d.hash.startsWith("#")) {
    const url = new URL(location.href);
    url.searchParams.set("view", "explore");
    url.hash = d.hash;
    if (url.href !== location.href) history.replaceState(history.state, "", url);
  }
});

// A new link pasted while the map is open (#c=... changed): show that view
addEventListener("hashchange", () => { if (wantsMap()) showMap(); });

// "Scroll for the summary"
$("scrollHint").addEventListener("click", () => {
  $("summary").scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
});

// ---------------------------------------------------------------- start
if (wantsMap()) showMap(); else showHome();
