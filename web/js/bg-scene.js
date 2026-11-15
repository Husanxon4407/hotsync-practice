/*
  PyroVision map page: bg-scene.js
  A quiet 3D background about our topic, behind the whole page:
  - the Earth (the same NASA picture as the home page), turning slowly
  - glowing fire points: one per country, bigger and brighter where more
    fires were counted (real numbers: data/countries.json)
  - two satellites on polar orbits, like the real ones: MODIS (orange) and
    VIIRS (purple), the same colours as in the charts
  - the same space look as the home page: stars, lights, size and place
  It starts after the map has loaded, draws at most 30 frames a second, and
  stops when the tab is hidden, when the map is full screen or while printing.
  "Reduce motion": one still picture. No WebGL: nothing (the page is the same).
*/
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js";

const host = document.getElementById("bgScene");
const motion = matchMedia("(prefers-reduced-motion: reduce)");
const deg = THREE.MathUtils.degToRad;

// lat/lon (degrees) -> point on a sphere of radius r (same layout as the Earth picture)
function onSphere(lat, lon, r) {
  const phi = deg(90 - lat), theta = deg(lon + 180);
  return new THREE.Vector3(-r * Math.sin(phi) * Math.cos(theta), r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
}

// a soft round glow (drawn once on a small canvas)
function glowTexture(inner, outer) {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d"), grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, inner);
  grd.addColorStop(0.35, outer);
  grd.addColorStop(1, "rgba(0,0,0,0)");
  g.fillStyle = grd;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

async function start() {
  if (!host) return;
  let renderer;
  try {
    // Opaque canvas with its own sky/space gradient (a see-through canvas was
    // blended wrongly by the browser behind some cards: a pale disc on the Earth)
    renderer = new THREE.WebGLRenderer({ alpha: false, antialias: true, powerPreference: "low-power" });
  } catch (e) { return; }                                   // no WebGL: the page stays as it is
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  let raf = 0, last = 0, t = 0, ready = false;       // (declared first: a cached picture can arrive at once)
  const scene = new THREE.Scene();
  // the page background, painted in the scene: deep space (dark) or a daytime sky (light)
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  };
  let skyDark = null;
  function paintSky() {
    const dark = isDark();
    if (dark === skyDark) return;
    skyDark = dark;
    const c = document.createElement("canvas");
    c.width = 1024; c.height = 640;
    const g = c.getContext("2d");
    const grd = g.createRadialGradient(0.65 * 1024, 0.4 * 640, 0, 0.65 * 1024, 0.4 * 640, 900);
    const stops = dark ? [[0, "#10243c"], [0.45, "#050f20"], [0.8, "#020914"], [1, "#020914"]]
      : [[0, "#ffffff"], [0.45, "#e6f0fa"], [0.85, "#cfe0f1"], [1, "#cfe0f1"]];
    stops.forEach(([k, col]) => grd.addColorStop(k, col));
    g.fillStyle = grd;
    g.fillRect(0, 0, c.width, c.height);
    if (scene.background) scene.background.dispose();
    scene.background = new THREE.CanvasTexture(c);
    scene.background.colorSpace = THREE.SRGBColorSpace;
  }
  paintSky();
  // the same camera and lights as the home page Earth (home/earth.js)
  const camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
  camera.position.z = 8;
  scene.add(new THREE.AmbientLight(0x7799bd, 1.7));
  const key = new THREE.DirectionalLight(0xe6f3ff, 2.8);
  key.position.set(-3, 4, 5);
  const rimLight = new THREE.DirectionalLight(0x3579c9, 0.65);
  rimLight.position.set(4, -1, -2);
  scene.add(key, rimLight);

  // faint stars, the same sky as on the home page
  const starPos = [];
  const rnd = (i) => { const n = Math.sin(i * 127.1) * 43758.5453; return n - Math.floor(n); };
  for (let i = 0; i < 260; i++) starPos.push((rnd(i + 1) - 0.5) * 36, (rnd(i + 500) - 0.5) * 24, -10 - rnd(i + 900) * 10);
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute("position", new THREE.Float32BufferAttribute(starPos, 3));
  scene.add(new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x8cabc9, size: 0.018, transparent: true, opacity: 0.45 })));

  // everything that turns with the Earth is in "world"; the orbits are separate
  const planet = new THREE.Group();
  planet.rotation.z = 0.12;                                  // the same tilt as the home page
  scene.add(planet);
  const world = new THREE.Group();
  planet.add(world);

  // the Earth
  const mat = new THREE.MeshPhongMaterial({ shininess: 12, specular: 0x233449 });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 80, 64), mat);
  world.add(earth);
  const loader = new THREE.TextureLoader();
  loader.load("intro/earth.jpg", (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; draw(); });
  loader.load("intro/earth-normal.jpg", (t) => { mat.normalMap = t; mat.normalScale = new THREE.Vector2(0.35, 0.35); mat.needsUpdate = true; });

  // fire points: one per country, size + brightness from its real fire total
  const fireTex = glowTexture("rgba(255,236,200,1)", "rgba(255,106,31,0.65)");
  const fireMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { map: { value: fireTex }, time: { value: 0 }, scale: { value: 1 } },
    vertexShader: `
      attribute float size; attribute float seed; uniform float time; uniform float scale;
      varying float vA; varying float vFacing;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        vec3 nrm = normalize(normalMatrix * normalize(position));
        vFacing = smoothstep(-0.05, 0.25, dot(nrm, normalize(-mv.xyz)));   // hide points on the far side
        vA = 0.65 + 0.35 * sin(time * (1.3 + seed) + seed * 40.0);          // a gentle flicker
        gl_PointSize = size * scale * (0.85 + 0.15 * vA) / -mv.z;
        gl_Position = projectionMatrix * mv;
      }`,
    fragmentShader: `
      uniform sampler2D map; varying float vA; varying float vFacing;
      void main() { vec4 c = texture2D(map, gl_PointCoord); gl_FragColor = vec4(c.rgb, c.a * vA * vFacing); }`,
  });
  const fires = new THREE.Points(new THREE.BufferGeometry(), fireMat);
  world.add(fires);
  try {
    const [shapes, list] = await Promise.all([
      fetch("data/globe_countries.json").then((r) => r.json()),
      fetch("data/countries.json").then((r) => r.json()),
    ]);
    const total = new Map(list.map((c) => [c.slug, c.total_H || 0]));
    const max = Math.log10(Math.max(...list.filter((c) => c.slug !== "world").map((c) => c.total_H || 0)) + 1);
    const pos = [], size = [], seed = [];
    for (const f of shapes.features) {
      const p = f.properties, t = total.get(p.slug) || 0;
      if (!p.has_data || t < 50 || !Number.isFinite(p.lat)) continue;
      const k = Math.log10(t + 1) / max;                   // 0..1
      const v = onSphere(p.lat, p.lng, 1.005);
      pos.push(v.x, v.y, v.z);
      size.push(0.12 + 0.95 * Math.pow(k, 3));            // glow size (pixels = size x screen height / distance)
      seed.push(Math.random());
    }
    fires.geometry.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    fires.geometry.setAttribute("size", new THREE.Float32BufferAttribute(size, 1));
    fires.geometry.setAttribute("seed", new THREE.Float32BufferAttribute(seed, 1));
  } catch (e) { /* no fire points: the Earth still turns */ }

  // two satellites on polar orbits (about 98°, like MODIS and VIIRS)
  const sats = [];
  function orbit(color, tilt, node, speed, phase) {
    const g = new THREE.Group();
    g.rotation.set(deg(tilt), deg(node), 0);
    const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 160 }, (_, i) => { const a = (i / 160) * Math.PI * 2; return new THREE.Vector3(Math.cos(a) * 1.32, 0, Math.sin(a) * 1.32); })),
      new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.28 }));
    const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture("rgba(255,255,255,1)", color), transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    dot.scale.setScalar(0.16);
    g.add(ring, dot);
    planet.add(g);
    sats.push({ dot, speed, phase });
  }
  orbit("#ff8a3d", 98, 25, 0.21, 0);        // MODIS
  orbit("#a58be0", 98, -35, 0.17, 2.4);     // VIIRS

  // ---------------------------------------------------------------- size + place
  let w = 1, h = 1;
  function resize() {
    w = innerWidth; h = innerHeight;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const hh = Math.tan(deg(19)) * 8, hw = hh * camera.aspect, phone = w <= 700;
    // Bigger than on the home page (asked by the user), partly off the right
    // edge, so the cards and their numbers stay in front and in focus.
    planet.position.set(phone ? hw * 0.25 : hw * 0.62, phone ? -hh * 0.3 : -hh * 0.08, 0);
    planet.scale.setScalar(phone ? Math.min(hw * 0.95, hh * 0.5) : Math.min(hh * 1.05, hw * 0.62));
    fireMat.uniforms.scale.value = h / 2;
    draw();
  }

  // ---------------------------------------------------------------- loop (max 30 fps)
  const paused = () => document.hidden || motion.matches ||
    document.documentElement.classList.contains("report") || !!document.querySelector(".map-wrap.is-full");
  function draw() {
    if (!ready) return;                                      // not set up yet
    world.rotation.y = 2.4 + t * 0.055;                     // the home page's speed
    fireMat.uniforms.time.value = t;
    for (const s of sats) {
      const a = s.phase + t * s.speed;
      s.dot.position.set(Math.cos(a) * 1.32, 0, Math.sin(a) * 1.32);
    }
    renderer.render(scene, camera);
  }
  function frame(now) {
    raf = 0;
    if (paused()) return;
    const dt = Math.min(0.1, last ? (now - last) / 1000 : 0);
    if (dt === 0 || dt >= 1 / 31) { t += dt; last = now; draw(); }
    else if (!last) last = now;
    raf = requestAnimationFrame(frame);
  }
  const wake = () => { if (!raf && !paused()) { last = 0; raf = requestAnimationFrame(frame); } else if (paused()) draw(); };
  addEventListener("resize", resize);
  document.addEventListener("visibilitychange", wake);
  motion.addEventListener("change", wake);
  // printing / full screen map: stop; back: go on (both change a class)
  // theme switch: new sky; printing / full screen map: stop (both change attributes on <html>)
  new MutationObserver(() => { paintSky(); wake(); draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { paintSky(); draw(); });
  document.addEventListener("fullscreenchange", wake);
  document.addEventListener("click", () => setTimeout(wake, 50));     // the map's full-screen button
  renderer.domElement.addEventListener("webglcontextlost", (e) => { e.preventDefault(); cancelAnimationFrame(raf); host.hidden = true; });

  ready = true;
  resize();
  host.classList.add("on");                                  // fade in
  wake();
}

// Start after the page and the map are ready (the background is never in the way)
const go = () => setTimeout(start, 900);
if (document.readyState === "complete") go(); else addEventListener("load", go);
