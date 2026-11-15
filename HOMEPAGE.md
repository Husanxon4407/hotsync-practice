# HotSync Home Page — Full Plan

This file describes the new **home page** for HotSync. Read all of it before you write code.

## 0. Goal and Rules

### What we want

Right now, when someone opens the website, they see the full data dashboard right away. That is too much at the start.

The new flow:

1. **Home page (top):** a full-screen space hero with a 3D Earth, our topic, and a button to the main page (the fire map).
2. **Home page (scroll down):** a short, simple **summary** of world fire data: a few big numbers, one small chart, the top countries, and a simple "why fair count" explanation.
3. **Main page (the map):** all the detailed data, exactly like now.

### Rules for Claude Code

- **Read the existing code first** (the `web/` folder). Understand how the map page loads its data, its URL hash (`#c=...&from=...&to=...`), and its file paths.
- Build the home page with **HTML, CSS, and vanilla JavaScript. Do not use React, JSX, ReactDOM, or any UI framework.** Three.js renders the Earth. GSAP animates the Earth entrance. Load both as pinned versions, the same way the project already loads its other libraries (CDN or a local vendor folder).
- **Do not change how any number is calculated** on the main page.
- **Do not break old share links.** Any link with `#c=...` must still open the map with the same view.
- **Do not hard-code data numbers** in the home page. All numbers come from data files, so they update when the data updates.
- This file is only about the home page. The main page redesign is a separate task.
- When something in this plan doesn't fit the existing code, choose the simplest working option, and tell me what you chose.

### Page order (top to bottom)

```
┌─────────────────────────────────────┐
│ 1. Hero (100svh): text + 3D Earth   │
├─────────────────────────────────────┤
│ 2. Transition (dark → white)        │
├─────────────────────────────────────┤
│ 3. Summary "Fire on Earth, in short"│
│    - 4 big numbers                  │
│    - Every year since 2001 (chart)  │
│    - Top 5 countries                │
│    - Why "fair count"? (3 steps)    │
├─────────────────────────────────────┤
│ 4. Final button → open the map      │
│ 5. Page footer (data, update time)  │
└─────────────────────────────────────┘
```

---

## 1. Full-Screen Space Hero

The home page starts with HotSync on a dark space background: large text on the left, a textured 3D Earth on the right, and faint stars behind the planet.

- Hero height: `100svh`; minimum height: `560px`.
- Position: relative, with hidden overflow and isolated stacking (`isolation: isolate`).
- The canvas fills the hero. Text and controls stay above it and stay clickable.
- The hero scrolls with the document (it is not fixed).
- Font: Manrope, weights 400, 500, 600, 700, and 800; fallback: sans-serif. The whole home page uses Manrope.

```css
background: radial-gradient(
  ellipse at 65% 40%,
  #10243c 0%,
  #050f20 45%,
  #020914 80%
);
```

| Element | Color |
| --- | --- |
| Deep space | `#020914` |
| Navy background | `#050f20` |
| Blue background glow | `#10243c` |
| Main text | `#edf3fa` |
| Supporting text | `#9eafc4` |
| Muted footer detail | `#8598b0` |
| Accent and focus | `#a9d9ff` |
| Primary button | `#e5effa` |
| Primary button text | `#101e30` |
| Primary button hover | `#baddf9` |

Put all colors (hero colors and the summary colors in section 11) in CSS variables at the top of the home page CSS.

## 2. Header

The header shows the HotSync wordmark on the left and a map button on the right.

- Absolute position across the top of the hero.
- Padding: `30px 4.5%`.
- Flex layout, vertically centered, with space between the two items.
- Wordmark: `HotSync.`; the final dot uses the accent color.
- Wordmark font: `29px`, weight `800`, letter spacing `-1.5px`.
- The wordmark links to the home page.
- Right button text: **Open fire map ↗**.
- Button background: transparent; font size: `13px`; minimum height: `44px`.
- Hover text color: `#a9d9ff`.

## 3. Headline and Supporting Copy

Keep this exact wording and these line breaks:

```html
<h1>Harmonization<br>of VIIRS and<br>MODIS<br>hot spots.</h1>
<p>Two satellite perspectives.<br>One clearer view of fire on Earth.</p>
```

Desktop text container:

- Absolute position: left `7%`, top `50%`.
- Transform: `translateY(-47%)`.
- Width: `35%`; maximum width: `560px`.
- No extra padding or margin.

Headline:

- Size: `clamp(38px, 4.6vw, 78px)`.
- Weight: `500`.
- Line height: `1.08`.
- Letter spacing: `-.065em`.
- Margin: `0`.

Supporting paragraph:

- Size: `15px`.
- Line height: `1.8`.
- Color: `#9eafc4`.
- Margin: `26px 0 30px`.

Text entrance: when the page loads, the headline, paragraph, and button fade in and move up `16px`, one after another (stagger `120ms`, duration `.7s`). Skip this with reduced motion.

## 4. Explore Button

Place **Explore the map ↗** below the paragraph.

- Background: `#e5effa`; text: `#101e30`.
- No border; border radius: `40px`.
- Padding: `17px 22px`.
- Font: `13px`, weight `700`.
- Inline flex layout with centered items and a `35px` gap.
- Arrow size: `21px`; line height: `1`.
- Hover: background `#baddf9`, upward translation of `2px`.
- Background and transform transitions: `.2s`.

Both map buttons (header and Explore) do the same thing (see section 13). They must work during the Earth entrance too.

## 5. Textured 3D Earth

Render a real sphere using local Earth color and normal textures.

### Renderer and Camera

```js
const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
renderer.outputColorSpace = THREE.SRGBColorSpace;
const camera = new THREE.PerspectiveCamera(38, width / height, 0.1, 100);
camera.position.z = 8;
```

### Sphere

- Geometry: `SphereGeometry(1, 80, 64)`.
- Material: `MeshPhongMaterial({ shininess: 12, specular: 0x233449 })`.
- Initial rotation: Z `0.12`, Y `2.4` radians.
- Put the sphere inside a group, so the entrance position and scale are controlled separately from the rotation.
- Color texture: `intro/earth.jpg`, using SRGB color space.
- Texture anisotropy: the smaller of `8` and the renderer maximum.
- Normal texture: `intro/earth-normal.jpg`.
- Normal scale: `(0.35, 0.35)`.
- Keep the Earth hidden until the color texture loads, then start the entrance.
- Load the normal texture separately (the Earth must not wait for it).
- If `intro/earth.jpg` or `intro/earth-normal.jpg` is missing from the project, tell me. Do not download random images.

### Lighting

| Light | Color | Intensity | Position |
| --- | --- | --- | --- |
| Ambient | `0x7799bd` | `1.7` | — |
| Main directional | `0xe6f3ff` | `2.8` | `(-3, 4, 5)` |
| Rim directional | `0x3579c9` | `0.65` | `(4, -1, -2)` |

The lighting and the radial background make the blue space look. There is no separate atmosphere shell.

## 6. Faint Star Field

Add 260 points behind the Earth.

- Color: `0x8cabc9`.
- Point size: `.018`.
- Opacity: `.45`, with transparency on.
- Approximate ranges: X `-18..18`, Y `-12..12`, Z `-10..-20`.

Use fixed (deterministic) positions:

```js
function random(i) {
  const n = Math.sin(i * 127.1) * 43758.5453;
  return n - Math.floor(n);
}
for (let i = 0; i < 260; i++) {
  positions.push(
    (random(i + 1) - 0.5) * 36,
    (random(i + 500) - 0.5) * 24,
    -10 - random(i + 900) * 10
  );
}
```

## 7. Earth Entrance Animation

The Earth starts small in the upper right, arcs left, goes down, sweeps right, and settles beside the headline while growing to its final size.

- Duration: **7.5 seconds**.
- Easing: `power1.inOut` (GSAP).
- Progress: `0` to `1`.
- Curve: `CatmullRomCurve3`, not closed, type `catmullrom`, tension `.5`.

Convert these points to `Vector3(x, y, 0)`:

```js
const points = [
  [0.82, 0.69],
  [0.61, 0.73],
  [0.30, 0.57],
  [0.22, 0.22],
  [0.43, -0.32],
  [0.69, -0.22],
  [0.36, 0.00]
];
```

Compute position and scale from the hero size:

```js
const mobile = width <= 700;
const hh = Math.tan(THREE.MathUtils.degToRad(19)) * 8;
const hw = hh * width / height;
const p = curve.getPoint(progress);

globe.position.set(
  (p.x - (mobile ? 0.36 : 0) * progress) * hw,
  (p.y - (mobile ? 0.36 : 0) * progress) * hh,
  0
);

const radius = mobile
  ? Math.min(hw * 0.61, hh * 0.28)
  : Math.min(hh * 0.69, hw * 0.37);

globe.scale.setScalar(
  radius * (0.055 + 0.945 * Math.pow(progress, 1.65))
);
```

Final position:

- Desktop: X `.36 * hw`, Y `0`.
- Mobile: X `0`, Y `-.36 * hh`, under the text.

Rotate the sphere every frame:

```js
earth.rotateY(dt * (0.055 + 0.8 * (1 - progress)));
```

`dt` is in seconds, capped at `.05`. Rotation is faster during the entrance and continues at about `.055` radians per second afterwards.

Render with `requestAnimationFrame`. Use `ResizeObserver` to update the renderer size, camera aspect, globe position, and scale when the hero changes size.

**Performance:** use an `IntersectionObserver` on the hero. When the hero is fully scrolled out of view (the user is reading the summary), stop rendering frames. Start again when the hero comes back. The entrance tween continues by time; when rendering resumes, draw the correct current state.

## 8. Hero Footer and Motion Controls

The hero footer has satellite labels on the left, a scroll hint in the middle, and two motion controls on the right.

Left text: **VIIRS + MODIS / Satellite fire observations**.

- Absolute position: left and right `4.5%`, bottom `22px`.
- Flex layout, vertically centered, space between, gap `16px`.
- Font size: `11px`; color: `#9eafc4`.
- Satellite description: `#8598b0`, with `14px` left margin.
- Controls gap: `20px`.
- Buttons: transparent, minimum height `44px`, padding `4px`, text size `11px`.
- Hover text: white.

### Scroll hint (new)

In the middle: a small button **Scroll for the summary ↓** (`11px`, color `#9eafc4`, hover white). Clicking it smoothly scrolls to the summary section (section 11). The arrow moves gently up and down (`translateY` 0 → 4px, 1.6s loop). No arrow animation with reduced motion. Hide this hint on screens `700px` wide or less (no space).

### Replay entrance

Stop the current tween, reset progress to zero, clear the paused state, and play the entrance again. Restore the label `Pause motion`. Keep the sphere's rotation as it is. Replay only works after the main texture has loaded.

### Pause motion / Resume motion

Pause stops both the globe rotation and the entrance tween. Show `Resume motion` with `aria-pressed="true"`. Resume continues from the same point and restores `Pause motion` with `aria-pressed="false"`.

### Escape key

Escape finishes the entrance right away: stop the tween, set progress to `1`, and put the Earth at its final position. The home page stays open. Rotation continues if motion is on and the scene is not paused.

## 9. Hero Mobile Layout

At widths of `700px` or less:

- Header padding: `18px 6%`.
- Wordmark: `25px`.
- Text container: top `14%`, left `7%`, width `86%`, no transform.
- Headline: `32px`, line height `1.02`, keeping all four lines.
- Paragraph: `12px`, line height `1.6`, margin `14px 0 18px`.
- Explore button: padding `12px 19px`, minimum height `44px`.
- The Earth settles under the text (mobile formula in section 7).
- Footer: left and right `6%`, bottom `12px`, text size `10px`.
- Hide `/ Satellite fire observations`.
- Controls gap: `10px`; control text: `10px`.
- No horizontal scrolling.

At widths above `700px` and heights of `600px` or less:

- Headline: `40px`.
- Paragraph: `12px`, margin `14px 0`.
- Header top padding: `15px`.

## 10. Scroll Transition Below the Hero

Right under the hero, add a section that slowly changes from dark space to white. It leads into the summary.

```css
body.home-active {
  margin: 0;
  overflow-x: hidden;
  overflow-y: auto;
  background: #fff;
}
.earth-page {
  width: 100%;
  margin: 0;
  background: #fff;
}
.earth-next {
  position: relative;
  display: block;
  width: 100%;
  height: 60svh;
  min-height: 360px;
  margin: 0;
  padding: 0;
  border: 0;
  background: linear-gradient(to bottom,
    #020914 0%,
    #252b37 18%,
    #656a73 40%,
    #b9bbc0 66%,
    #ededee 85%,
    #fff 100%
  );
}
```

- The height is shorter than the old plan (was `120svh`), so people reach the summary faster.
- The gradient section stays empty (no text).
- The Earth leaves the screen with the hero by normal scrolling. The entrance animation stays time-based.

---

## 11. Summary Section — "Fire on Earth, in short" (NEW)

This is the new part. It sits right after the transition, on a white background. It gives **simple world numbers only**. Every detail stays on the main page.

**Writing style for all text here:** short, simple English. One idea per line. No long paragraphs. No hard words.

### 11.1 Section header

- Small label above (uppercase, `11px`, weight `700`, letter spacing `.12em`, muted color): **IN SHORT**
- Title (`clamp(28px, 3.4vw, 48px)`, weight `600`, letter spacing `-.04em`): **Fire on Earth, 2001 to today**
- One line under it (`15px`, muted): **What two NASA satellites saw, in a few simple numbers.**

### 11.2 Block A — 4 big numbers (world)

A row of 4 cards. Each card has: a small label, one big number, and one short line.

| Card | Label | Big number | Short line |
| --- | --- | --- | --- |
| 1 | Fires since 2001 | total world fair count, short format (for example `98.4M`) | `fair count, 2001–2025` (years from the data) |
| 2 | Busiest year | the year (for example `2004`) | `X fires (fair count)` |
| 3 | Busiest month | month name (for example `August`) | `on average, every year` |
| 4 | This year so far | `+X%` or `−X%` | `vs the same days of 2001–2025` |

- Card 4: color the number orange/red when above normal and blue when below normal. Also write "above normal" or "below normal" in the short line, so color is not the only signal.
- Mark Terra-only years (before July 2002) with `*` like the main page does, with a small note: `* only one satellite (less certain)`.
- Big numbers: monospace font (IBM Plex Mono, like the main page), `clamp(32px, 3.6vw, 48px)`, weight `600`.
- Each card has a small `?` tooltip with one short sentence (for example, Fires since 2001: "Old MODIS counts are converted, so every year can be compared.").

### 11.3 Block B — "Every year since 2001" (one simple chart)

- Title: **Every year since 2001**. One line: **Fair count of fires on Earth, per year.**
- A simple vertical bar chart: one bar per year, 2001 → current year.
- Build it with **plain SVG or CSS** (no chart library on the home page).
- Highlight the busiest year bar (stronger color + label above it).
- The current year bar is lighter / striped, with the label `so far`.
- Terra-only years have a `*` under the year label.
- Hover (or tap) on a bar shows a small tooltip: `2019 · 5.2M fires (fair count)`.
- Year labels: show every 5th year on mobile, so they don't overlap.
- Under the chart, one small link: **See any country, month by month → open the map**.

### 11.4 Block C — "Top 5 countries"

- Title: **Most fires in {last full year}** (for example "Most fires in 2025").
- A list of 5 rows. Each row: rank, country name, a horizontal bar (length relative to #1), and the short number (for example `1.2M`).
- Each row is a link. Clicking it opens the map for that country and that year:
  `#c={country-slug}&from={year}-01&to={year}-12` (use the same slug format the map page already uses).
- Small line under the list: **Click a country to see its full map and calendar.**

### 11.5 Block D — "Why 'fair count'?" (3 simple steps)

Three small cards in a row, numbered 1–2–3, each with a simple icon (inline SVG) and one or two short lines:

1. **Two satellites.** MODIS has watched fires since 2000. VIIRS joined in 2012.
2. **VIIRS sees more.** Its pixels are smaller, so it sees about **{world exchange rate}× more** fires.
3. **We make it fair.** We convert the old MODIS counts, so every year from 2001 can be compared.

Add one small badge next to or under the steps: **1 MODIS fire ≈ {X} VIIRS fires** (world value from the data).

### 11.6 Final call to action (section 12 on the page)

A centered block at the end of the summary:

- Title: **Want the full story?**
- One line: **Pick any country and dates. See the map, the fire calendar, and every number.**
- Button: **Explore the full map ↗** (same style as the hero Explore button, but dark: background `#101e30`, text `#edf3fa`, hover `#1d3350`, lift `2px`).

### 11.7 Page footer

A simple footer at the very bottom (small text, muted, top border):

- **Data:** NASA FIRMS (MODIS + VIIRS)
- **Updated:** `{time ago}` · data to `{last data date}` (from the data, the same values the main page shows)
- **Made by team Capella**
- A link to the map.

### 11.8 Where the data comes from

- **No hard-coded numbers.** Load everything at runtime with `fetch`.
- First, look at the data files the map page already uses (world view, yearly/monthly totals, top countries, exchange rates, update time).
- **Preferred:** add one small step to the existing Python processing that writes a small file, `web/data/home-summary.json`, so the home page loads fast and doesn't download big files. Shape:

```json
{
  "updated": "2026-11-14T22:10:00Z",
  "dataTo": "2026-11-14",
  "world": {
    "fromYear": 2001,
    "lastFullYear": 2025,
    "totalFair": 0,
    "busiestYear": { "year": 0, "fair": 0, "terraOnly": false },
    "busiestMonthOfYear": { "month": 8, "avgFair": 0 },
    "thisYear": { "year": 2026, "fairSoFar": 0, "normalSameDays": 0, "pct": 0, "toDate": "2026-11-14" },
    "exchangeRate": 4.0,
    "years": [
      { "year": 2001, "fair": 0, "terraOnly": true, "partial": false }
    ]
  },
  "topCountries": {
    "year": 2025,
    "items": [ { "slug": "brazil", "name": "Brazil", "fair": 0 } ]
  }
}
```

- The values must use **the same method as the main page** (same cleaning, same fair count, same "normal" = middle value of 2001–2025). If the main page shows a world number, the home page must show the same number.
- If making the JSON in Python is not possible, compute the values in JavaScript from the existing files, but only if those files are small.
- Make sure the daily update (GitHub Actions or whatever the project uses) also updates `home-summary.json`.
- **If loading fails:** hide the number blocks and show one simple line: **Numbers could not load right now.** plus the "Explore the full map" button. The rest of the page must still work.
- While loading: show light grey skeleton blocks (same size as the real cards), so the page doesn't jump.

### 11.9 Number format

- Short format for big numbers: `98.4M`, `174k`, `5.2k`. Put the full number in a `title` attribute and in the accessible label (for example `aria-label="98,412,330 fires"`).
- Percent: always show the sign: `+7%`, `−12%` (real minus sign).
- Month names in full English: `August`.

### 11.10 Summary design

- Background: `#fff`. Main text: `#101e30`. Muted text: `#5b6b80`. Card border: `#e6ebf1`. Card background: `#f7f9fc`.
- Fire accent (bars, "above normal"): `#e8590c`; lighter fire: `#ffa94d`. "Below normal": `#3579c9`.
- Content width: max `1120px`, centered, side padding `5%`.
- Space between blocks: `clamp(56px, 8vw, 96px)`. Section top padding: `clamp(48px, 7vw, 88px)`.
- Cards: radius `18px`, padding `24px`, soft shadow `0 1px 2px #101e300d, 0 8px 24px #101e300a`.
- Card hover (desktop only): lift `3px`, slightly bigger shadow, `.2s`.
- Grids: Block A = 4 columns on desktop, 2 on tablet (`≤ 1000px`), 1 on mobile (`≤ 560px`). Block D = 3 columns on desktop, 1 on mobile.
- Focus outline everywhere: `2px solid #3579c9`, offset `4px` (on the white background; the hero keeps `#a9d9ff`).

### 11.11 Summary animations

Use CSS transitions and `IntersectionObserver` only (no GSAP needed here).

- **Scroll reveal:** each block fades in and moves up `24px` when it comes into view (`.6s`, ease-out). Cards inside a block appear one after another (stagger `90ms`). Only the first time.
- **Count-up:** big numbers count from 0 to their value in `.9s` (ease-out) when they appear. Short format during counting too.
- **Year chart:** bars grow from the bottom (`transform: scaleY(0 → 1)`, `transform-origin: bottom`), left to right, stagger `25ms`.
- **Top 5 bars:** grow from the left (`scaleX(0 → 1)`, `transform-origin: left`), stagger `80ms`.
- **3 steps:** step numbers pop in (scale `.8 → 1` + fade), stagger `120ms`.
- Only animate `transform` and `opacity`.
- **Reduced motion:** no reveal, no count-up, no bar growth. Show the final state right away.

---

## 13. Map Navigation

All map links (header button, Explore button, chart link, Top 5 rows, final button, footer link):

1. Set `view=explore` in the URL, keeping other query parameters and the hash. (Top 5 rows also set their `#c=...` hash.)
2. Add the navigation with `history.pushState`.
3. Release the home scene resources (section 16).
4. Open the map view and scroll to the top.

- A URL with `?view=explore` **or** a hash that starts with `#c=` opens the map directly (so old share links still work).
- Browser Back returns to the home page. Refresh keeps the current view.

### How the map is opened

- Move the current map page to its own file (for example `web/index.html` → `web/map.html`). The new home page becomes `web/index.html`. **Check that all relative paths in the map page still work** after the move (CSS, JS, data, images).
- The map opens in a full-viewport iframe, created only when needed:
  - Title: `HotSync fire map and satellite dashboard`.
  - Fixed position, inset `0`, width and height `100%`, border `0`.
  - Keep the parent and iframe hashes in sync, so map choices show in the visible URL.
  - The map page's **Share** button must share the parent URL (the visible one), not the iframe URL. If that is hard, make sure `map.html#c=...` links also open correctly.
  - Keep home styles separate from the map document (no CSS leaking either way).
- When the map is open, hide the home page content (not just cover it), so screen readers and Tab don't reach it.

## 14. Accessibility and Reduced Motion

- Use semantic `header`, `main`, `section`, `footer`, headings, links, and buttons. One `h1` (the hero headline). The summary uses `h2` and `h3`.
- Hero accessible label: `HotSync introduction`.
- Transition section accessible label: `Upcoming content`.
- Summary section accessible label: `Fire on Earth summary`.
- Decorative canvas, fallback image, and icons: `aria-hidden="true"`.
- The year chart has a text alternative: a visually hidden table (year + fair count), or an `aria-label` that says the busiest year and the current year.
- Real buttons with keyboard activation. Tooltips also open on keyboard focus.
- Hero focus outline: `2px solid #a9d9ff`, offset `6px`.
- The pause toggle shows its state with `aria-pressed`.
- Respect `prefers-reduced-motion: reduce`: skip the entrance, show the final Earth position, stop continuous rotation, remove CSS transitions, and turn off all summary animations.
- If reduced motion turns on while the page is open, finish the entrance right away.
- Skip rotation updates when `document.hidden` is true.
- Color contrast: all text meets WCAG AA.

## 15. Static Earth Fallback

Show a round static Earth image if WebGL fails to start, the main texture fails, scene setup fails, or the WebGL context is lost.

Desktop fallback:

- Absolute position: left `46%`, top `20%`.
- Width: `min(48vw, 65vh)`.
- Aspect ratio: `1`; border radius: `50%`.
- Background position: center; background size: cover.
- No box shadow.

```css
background-image:
  linear-gradient(110deg, transparent, #000c),
  url("intro/earth.jpg");
```

Mobile fallback: left `22%`, top `53%`, width `56%`.

In the failure state, disable Replay and Pause (opacity `.4`). All map buttons still work. If the image itself is missing, keep the background, text, summary, and working navigation.

## 16. Home Scene Lifecycle

Create one scene when entering the home page. When leaving:

- stop the tween,
- cancel animation frames,
- disconnect the resize observer and intersection observers,
- remove event listeners,
- dispose of geometry, materials, textures, and the renderer,
- remove the canvas.

Coming back home creates a fresh scene with no duplicate canvases, observers, or event listeners. Summary data can be kept in memory (no need to fetch it again).

## 17. Files

Suggested structure (adjust to the existing project if needed):

```
web/
  index.html          ← new home page
  map.html            ← the current map page (moved)
  home/
    home.css          ← hero + transition + summary styles
    home.js           ← navigation, iframe, lifecycle
    earth.js          ← Three.js scene, stars, entrance, controls
    summary.js        ← load home-summary.json, render cards/chart/top 5, animations
  intro/
    earth.jpg
    earth-normal.jpg
  data/
    home-summary.json ← made by the Python processing step
```

## 18. Done Checklist

Test all of these, fix problems, then give me a short list of what you changed and which files:

- [ ] Opening the site shows the hero; the Earth entrance plays; Replay, Pause/Resume, and Escape work.
- [ ] Scrolling shows the transition, then the summary with real numbers (no hard-coded values).
- [ ] Home page numbers match the main page World view.
- [ ] Every map link opens the map; Top 5 rows open the right country and year.
- [ ] Old share links (`/web/#c=...`) open the map directly with the same view.
- [ ] Back returns home; Refresh keeps the view; no duplicate canvases after going back and forth.
- [ ] The map's Share button gives a working link.
- [ ] Data load failure shows the simple message, and the page still works.
- [ ] WebGL off → static Earth fallback, and everything else works.
- [ ] Reduced motion → no animations at all, everything visible.
- [ ] Mobile (375px) and desktop look good; no horizontal scrolling.
- [ ] Keyboard: Tab reaches everything in order; focus is always visible.
- [ ] No errors in the console. Scrolling is smooth; the Earth stops rendering when off screen.
- [ ] The daily data update also updates `home-summary.json`.
