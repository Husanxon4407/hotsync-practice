/*
  PyroVision map page: bg-scene.js
  A quiet 3D background about our topic, behind the whole page:
  - the Earth (the same NASA picture as the home page), turning slowly
  - glowing fire points: one per country, bigger and brighter where more
    fires were counted (real numbers: data/countries.json)
  - two satellites on polar orbits, like the real ones: MODIS (orange) and
    VIIRS (purple), the same colours as in the charts
  - a soft ember glow behind the planet
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
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, powerPreference: "low-power" });
  } catch (e) { return; }                                   // no WebGL: the page stays as it is
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.25));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);

  let raf = 0, last = 0, t = 0, ready = false;       // (declared first: a cached picture can arrive at once)
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(36, 1, 0.1, 100);
  camera.position.z = 9;
  scene.add(new THREE.AmbientLight(0x8fa6c4, 1.25));
  const sun = new THREE.DirectionalLight(0xfff1e0, 2.2);
  sun.position.set(-4, 3, 5);
  scene.add(sun);

  // everything that turns with the Earth is in "world"; the orbits are separate
  const planet = new THREE.Group();
  planet.rotation.z = deg(-18);                             // a little tilt looks natural
  scene.add(planet);
  const world = new THREE.Group();
  planet.add(world);

  // the ember glow behind the planet ("prism" of warm light)
  const glow = new THREE.Sprite(new THREE.SpriteMaterial({
    map: glowTexture("rgba(255,138,61,0.55)", "rgba(255,106,31,0.18)"), transparent: true, depthWrite: false,
    blending: THREE.AdditiveBlending,
  }));
  glow.scale.setScalar(4.6);
  glow.position.z = -1.2;
  planet.add(glow);

  // the Earth
  const mat = new THREE.MeshPhongMaterial({ shininess: 10, specular: 0x1d2a3a, color: 0xc9d3de });
  const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), mat);
  world.add(earth);
  const loader = new THREE.TextureLoader();
  loader.load("intro/earth.jpg", (t) => { t.colorSpace = THREE.SRGBColorSpace; mat.map = t; mat.needsUpdate = true; draw(); });
  loader.load("intro/earth-normal.jpg", (t) => { mat.normalMap = t; mat.normalScale = new THREE.Vector2(0.3, 0.3); mat.needsUpdate = true; });

  // thin blue rim (atmosphere): a slightly bigger sphere, seen from inside
  const rim = new THREE.Mesh(new THREE.SphereGeometry(1.06, 48, 32), new THREE.ShaderMaterial({
    transparent: true, side: THREE.BackSide, depthWrite: false, blending: THREE.AdditiveBlending,
    vertexShader: "varying vec3 n; void main(){ n = normalize(normalMatrix * normal); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }",
    fragmentShader: "varying vec3 n; void main(){ float a = pow(0.72 - dot(n, vec3(0.0,0.0,1.0)), 3.0); gl_FragColor = vec4(0.45,0.7,1.0,1.0) * a; }",
  }));
  planet.add(rim);

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
    // the planet sits to the right (on phones: lower, smaller), partly off screen
    const hh = Math.tan(deg(18)) * 9, hw = hh * camera.aspect, phone = w < 760;
    planet.position.set(phone ? hw * 0.35 : hw * 0.62, phone ? -hh * 0.55 : -hh * 0.05, 0);
    planet.scale.setScalar(phone ? hh * 0.42 : Math.min(hh * 0.62, hw * 0.4));
    fireMat.uniforms.scale.value = h / 2;
    draw();
  }

  // ---------------------------------------------------------------- loop (max 30 fps)
  const paused = () => document.hidden || motion.matches ||
    document.documentElement.classList.contains("report") || !!document.querySelector(".map-wrap.is-full");
  function draw() {
    if (!ready) return;                                      // not set up yet
    world.rotation.y = 0.9 + t * 0.035;
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
  new MutationObserver(wake).observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
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
