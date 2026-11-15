/*
  HotSync home page: earth.js
  The textured 3D Earth in the hero (Three.js), the faint stars, the entrance
  (GSAP: 7.5 s along a curve, growing to its final size), and the motion
  controls (Replay entrance, Pause/Resume motion, Escape = finish now).

  createEarth(...) builds ONE scene and returns { destroy }. destroy() stops
  everything and frees the GPU memory, so going to the map and back never
  leaves extra canvases, observers or listeners.
  If WebGL or the Earth picture fails: a static round Earth image is shown.
*/
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.min.js";

const POINTS = [[0.82, 0.69], [0.61, 0.73], [0.30, 0.57], [0.22, 0.22], [0.43, -0.32], [0.69, -0.22], [0.36, 0.00]];
const DURATION = 7.5;                                 // seconds

// fixed ("random looking") numbers for the stars: the same sky every time
function random(i) {
  const n = Math.sin(i * 127.1) * 43758.5453;
  return n - Math.floor(n);
}

export function createEarth({ hero, host, fallback, replayBtn, pauseBtn }) {
  const motionQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const cleanups = [];                                 // everything to undo in destroy()
  const on = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); cleanups.push(() => target.removeEventListener(type, fn, opts)); };

  let renderer, scene, camera, group, earth, stars, curve;
  let tween = null, raf = 0, last = 0, visible = true, paused = false, ready = false, failed = false, dead = false;
  const state = { progress: 0 };
  const textures = [];

  // ---------------------------------------------------------------- failure: static Earth
  function fail(why) {
    if (failed || dead) return;
    failed = true;
    console.warn("Earth: static picture instead of 3D:", why);
    stopTween();
    cancelAnimationFrame(raf);
    if (renderer) { renderer.domElement.remove(); }
    fallback.hidden = false;
    replayBtn.disabled = true;
    pauseBtn.disabled = true;
  }

  // ---------------------------------------------------------------- scene
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
  } catch (err) {
    fail(err);
    return { destroy() { dead = true; } };
  }
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.75));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  on(renderer.domElement, "webglcontextlost", (e) => { e.preventDefault(); fail("WebGL context lost"); });

  try {
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.z = 8;

    scene.add(new THREE.AmbientLight(0x7799bd, 1.7));
    const key = new THREE.DirectionalLight(0xe6f3ff, 2.8);
    key.position.set(-3, 4, 5);
    const rim = new THREE.DirectionalLight(0x3579c9, 0.65);
    rim.position.set(4, -1, -2);
    scene.add(key, rim);

    // the Earth: a sphere in a group (the group moves and grows; the sphere turns)
    const material = new THREE.MeshPhongMaterial({ shininess: 12, specular: 0x233449 });
    earth = new THREE.Mesh(new THREE.SphereGeometry(1, 80, 64), material);
    earth.rotation.set(0, 2.4, 0.12);
    group = new THREE.Group();
    group.add(earth);
    group.visible = false;                             // hidden until the picture is here
    scene.add(group);

    // faint stars behind the planet
    const pos = [];
    for (let i = 0; i < 260; i++) pos.push((random(i + 1) - 0.5) * 36, (random(i + 500) - 0.5) * 24, -10 - random(i + 900) * 10);
    const sg = new THREE.BufferGeometry();
    sg.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    stars = new THREE.Points(sg, new THREE.PointsMaterial({ color: 0x8cabc9, size: 0.018, transparent: true, opacity: 0.45 }));
    scene.add(stars);

    curve = new THREE.CatmullRomCurve3(POINTS.map(([x, y]) => new THREE.Vector3(x, y, 0)), false, "catmullrom", 0.5);

    // textures: colour first (the Earth waits for it), the normal map on its own
    const loader = new THREE.TextureLoader();
    loader.load("intro/earth.jpg", (tex) => {
      if (dead) { tex.dispose(); return; }
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
      textures.push(tex);
      material.map = tex;
      material.needsUpdate = true;
      group.visible = true;
      ready = true;
      play();
    }, undefined, () => fail("intro/earth.jpg did not load"));
    loader.load("intro/earth-normal.jpg", (tex) => {
      if (dead) { tex.dispose(); return; }
      textures.push(tex);
      material.normalMap = tex;
      material.normalScale = new THREE.Vector2(0.35, 0.35);
      material.needsUpdate = true;
    }, undefined, () => console.warn("Earth: the normal map did not load (the Earth stays smooth)"));
  } catch (err) {
    fail(err);
  }

  // ---------------------------------------------------------------- size + place
  let width = 1, height = 1;
  function place() {
    const mobile = width <= 700;
    const hh = Math.tan(THREE.MathUtils.degToRad(19)) * 8;
    const hw = (hh * width) / height;
    const t = state.progress, p = curve.getPoint(t);
    group.position.set((p.x - (mobile ? 0.36 : 0) * t) * hw, (p.y - (mobile ? 0.36 : 0) * t) * hh, 0);
    const radius = mobile ? Math.min(hw * 0.61, hh * 0.28) : Math.min(hh * 0.69, hw * 0.37);
    group.scale.setScalar(radius * (0.055 + 0.945 * Math.pow(t, 1.65)));
  }
  function resize() {
    if (failed || dead) return;
    const r = hero.getBoundingClientRect();
    width = Math.max(1, r.width); height = Math.max(1, r.height);
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    draw();
  }
  function draw() {
    if (failed || dead || !scene) return;
    place();
    renderer.render(scene, camera);
  }

  // ---------------------------------------------------------------- loop
  const still = () => motionQuery.matches;             // reduced motion: no turning
  function frame(now) {
    raf = 0;
    if (failed || dead) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0);
    last = now;
    if (!paused && !still() && !document.hidden && ready) earth.rotateY(dt * (0.055 + 0.8 * (1 - state.progress)));
    draw();
    if (visible && !paused && !still()) raf = requestAnimationFrame(frame);
  }
  function loop() {
    if (!raf && visible && !failed && !dead) { last = 0; raf = requestAnimationFrame(frame); }
  }
  function stopLoop() { cancelAnimationFrame(raf); raf = 0; }

  // ---------------------------------------------------------------- entrance
  function stopTween() { if (tween) { tween.kill(); tween = null; } }
  function finish() {                                   // Escape: final place now
    stopTween();
    state.progress = 1;
    draw();
  }
  function play() {
    stopTween();
    state.progress = 0;
    if (still() || !window.gsap) { finish(); loop(); return; }   // no motion (or no GSAP): final place
    tween = window.gsap.to(state, { progress: 1, duration: DURATION, ease: "power1.inOut", onUpdate: () => { if (!raf && visible) draw(); } });
    loop();
  }

  // ---------------------------------------------------------------- controls
  function setPaused(p) {
    paused = p;
    pauseBtn.textContent = p ? "Resume motion" : "Pause motion";
    pauseBtn.setAttribute("aria-pressed", String(p));
    if (tween) (p ? tween.pause() : tween.resume());
    if (p) stopLoop(); else loop();
  }
  on(replayBtn, "click", () => {
    if (!ready || failed) return;                       // only after the picture loaded
    setPaused(false);
    play();
  });
  on(pauseBtn, "click", () => { if (!failed) setPaused(!paused); });
  on(document, "keydown", (e) => { if (e.key === "Escape" && ready && !failed) { finish(); if (!paused) loop(); } });
  // reduced motion switched on while open: finish now, stop turning
  on(motionQuery, "change", () => { if (still()) { finish(); stopLoop(); } else loop(); });

  // stop drawing when the hero is scrolled away; start again when it is back
  const io = new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (visible) { draw(); loop(); } else stopLoop();
  });
  io.observe(hero);
  const ro = new ResizeObserver(resize);
  ro.observe(hero);
  cleanups.push(() => io.disconnect(), () => ro.disconnect());
  resize();

  // ---------------------------------------------------------------- lifecycle
  return {
    destroy() {
      if (dead) return;
      dead = true;
      stopTween();
      stopLoop();
      cleanups.forEach((fn) => fn());
      if (scene) {
        scene.traverse((o) => {
          if (o.geometry) o.geometry.dispose();
          if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
        });
      }
      textures.forEach((t) => t.dispose());
      if (renderer) { renderer.dispose(); renderer.forceContextLoss?.(); renderer.domElement.remove(); }
      fallback.hidden = true;
      replayBtn.disabled = false;
      pauseBtn.disabled = false;
      setPausedLabel();
    },
  };
  function setPausedLabel() { pauseBtn.textContent = "Pause motion"; pauseBtn.setAttribute("aria-pressed", "false"); }
}
