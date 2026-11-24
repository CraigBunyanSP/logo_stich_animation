// Embroidery renderer: draws the stitch engine's output as real 3D thread on canvas.
//
//   const scene = new EmbroideryScene(container, { preset: LOOKS.window, motion: MOTIONS.spring });
//   await scene.setSVG(svgText);
//   scene.setMode('play');     // or 'scroll' (drive with scrubTo), 'hover', 'manual'
//   scene.setProgress(0.5);    // jump the timeline (switches to manual)
//
// Each stitch is one instance of a shared arched-tube mesh, so thousands of
// stitches render in a single draw call.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { VignetteShader } from 'three/addons/shaders/VignetteShader.js';
import { svgToStitches } from './stitch-engine.js';
import { weaveTextures, threadTwistNormal } from './textures.js';
import { MOTIONS, stitchTimes, CLOTH_GLSL, THREAD_GLSL } from './motion.js';

export { MOTIONS };

export const LOOKS = {
  // A: matched to the Z1 art-direction still.
  studio: {
    name: 'A · Studio daylight',
    fabric: '#e3e5e9', thread: '#1e1f23', threadEnv: 0.5,
    threadRoughness: 0.22, threadSheen: 0.9, threadClearcoat: 0.35,
    threadRadius: 1.0, padHeight: 1.0,
    light: { colour: '#f4f7ff', intensity: 4.2, azimuth: 0, elevation: 17 },
    fill: 0.25, env: 0.9,
    camera: { elevation: 36, azimuth: -8, distance: 1.38, fov: 32 },
    dof: { aperture: 0.045, maxblur: 0.012 },
    weave: { cells: 16, repeat: 40, slub: 0.2 },
    pucker: 0.006,
  },
  // B: warmer, lower, more cinematic.
  window: {
    name: 'B · Golden window',
    fabric: '#e8e2d8', thread: '#1c1c20', threadEnv: 0.45,
    threadRoughness: 0.18, threadSheen: 0.95, threadClearcoat: 0.45,
    threadRadius: 1.0, padHeight: 1.2,
    light: { colour: '#ffd9a8', intensity: 4.6, azimuth: 10, elevation: 11 },
    fill: 0.15, env: 0.7,
    camera: { elevation: 27, azimuth: -14, distance: 1.4, fov: 30 },
    dof: { aperture: 0.07, maxblur: 0.018 },
    weave: { cells: 16, repeat: 32, slub: 0.45 },
    pucker: 0.009,
  },
};


const LOGO_SIZE = 1.0;     // world units across the stitched artwork
const ENGINE_RES = 512;    // stitch-engine raster size
const RHO = 0.02;          // thread radius in the unit stitch geometry

// Add the cloth / thread motion GLSL to a built-in three.js material.
function injectCloth(shader, uniforms) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = CLOTH_GLSL + shader.vertexShader;
}
function injectThread(shader, uniforms, withNormals) {
  Object.assign(shader.uniforms, uniforms);
  shader.vertexShader = CLOTH_GLSL + THREAD_GLSL + shader.vertexShader;
  if (withNormals) {
    shader.vertexShader = shader.vertexShader.replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      {
        StitchMotion smN = stitchMotion();
        float slope = smN.lift * 3.14159 * cos(3.14159 * position.x);
        float c = inversesqrt(1.0 + slope * slope), sn = slope * c;
        objectNormal = vec3(c * objectNormal.x - sn * objectNormal.y, sn * objectNormal.x + c * objectNormal.y, objectNormal.z);
      }`);
  }
  shader.vertexShader = shader.vertexShader
    .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        StitchMotion sm = stitchMotion();
        transformed.x *= sm.grow;
        float arc = sin(3.14159 * position.x);
        transformed.y += sm.lift * arc;
        transformed.z += sm.sway * arc;
        transformed *= sm.visible;
      }`)
    .replace('#include <project_vertex>', `
      vec4 mvPosition = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        mvPosition = instanceMatrix * mvPosition;
      #endif
      mvPosition.y += clothOffset(mvPosition.xz);
      mvPosition = modelViewMatrix * mvPosition;
      gl_Position = projectionMatrix * mvPosition;`);
}

export class EmbroideryScene {
  constructor(container, { preset = LOOKS.window, motion = MOTIONS.spring, controls = true } = {}) {
    this.container = container;
    this.look = preset;
    this.motion = motion;
    this.mode = 'manual';
    this.T = 1; this.target = 1;
    this.clock = new THREE.Clock();
    this.uniforms = {
      uClock: { value: 0 }, uTime: { value: 1 },
      uNeedle: { value: new THREE.Vector3(0, 0, 0) }, uPointer: { value: new THREE.Vector3(0, 0, 0) },
      uBreath: { value: 1 }, uHover: { value: 1 },
      uGrowDur: { value: 0.01 }, uSettleDur: { value: 0.04 }, uDamp: { value: 4 }, uFreq: { value: 2 },
      uLoop: { value: 1 }, uSway: { value: 0.5 },
    };
    this.pointerTarget = 0;
    this.needleXZ = new THREE.Vector2();

    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(32, 1, 0.01, 20);

    const pmrem = new THREE.PMREMGenerator(renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.key = new THREE.DirectionalLight(0xffffff, 3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(4096, 4096);
    const sc = this.key.shadow.camera;
    sc.left = sc.bottom = -0.8; sc.right = sc.top = 0.8; sc.near = 0.1; sc.far = 6;
    this.key.shadow.bias = -0.0002;
    this.key.shadow.normalBias = 0.002;
    this.key.shadow.radius = 3;
    this.scene.add(this.key, this.key.target);
    this.hemi = new THREE.HemisphereLight(0xffffff, 0xdddddd, 0.4);
    this.scene.add(this.hemi);

    this.#buildFabric();
    this.#buildThreadMesh();

    this.composer = new EffectComposer(renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bokeh = new BokehPass(this.scene, this.camera, { focus: 1.5, aperture: 0.004, maxblur: 0.01 });
    this.composer.addPass(this.bokeh);
    this.composer.addPass(new OutputPass());
    this.vignette = new ShaderPass(VignetteShader);
    this.vignette.uniforms.offset.value = 1.0;
    this.vignette.uniforms.darkness.value = 1.1;
    this.composer.addPass(this.vignette);

    if (controls) {
      this.controls = new OrbitControls(this.camera, renderer.domElement);
      this.controls.enableDamping = true;
      this.controls.maxPolarAngle = Math.PI * 0.47;
      this.controls.minDistance = 0.6; this.controls.maxDistance = 3;
    }

    // Pointer over the cloth: presses the fabric and loosens nearby thread.
    this.raycaster = new THREE.Raycaster();
    const el = renderer.domElement, plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), hit = new THREE.Vector3();
    el.addEventListener('pointermove', e => {
      const r = el.getBoundingClientRect();
      this.raycaster.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), this.camera);
      if (this.raycaster.ray.intersectPlane(plane, hit)) {
        this.uniforms.uPointer.value.x = hit.x; this.uniforms.uPointer.value.y = hit.z;
        this.pointerTarget = e.pointerType === 'mouse' || e.buttons === 0 ? 1 : 0;
      }
    });
    el.addEventListener('pointerleave', () => { this.pointerTarget = 0; });

    this.applyMotion(motion);
    this.applyLook(preset);
    this.#resize();
    new ResizeObserver(() => this.#resize()).observe(container);
    renderer.setAnimationLoop(() => this.render());
  }

  // ---------- public API ----------

  async setSVG(svgText, engineOptions = {}) {
    this.stitches = await svgToStitches(svgText, { resolution: ENGINE_RES, stitchSpacing: 1.15, ...engineOptions });
    this.#layoutStitches();
    this.#updatePucker();
    this.#layoutStitches(); // again, now that stitches can sit on the puckered cloth
    this.#applyTimes();
    return this.stitches;
  }

  // Jump straight to a point on the 0..1 timeline.
  setProgress(t) { this.mode = 'manual'; this.T = this.target = t; this.playState = null; }
  // Ease towards a point on the timeline (use for scroll-driven playback).
  scrubTo(t) { this.target = Math.min(1, Math.max(0, t)); }
  get progress() { return this.T; }
  // World x / z of the stitch being pulled taut at timeline t.
  needleAt(t) {
    const order = this.tautOrder, times = this.times;
    let lo = 0, hi = order.length - 1, idx = 0;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (times[order[mid] * 2 + 1] <= t) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    const b = this.flat[order[idx]].b;
    return { x: b[0], y: b[1] };
  }

  // 'play': loops stitch, hold, unpick. 'scroll': follows scrubTo(). 'hover': finished piece reacting to the pointer.
  setMode(mode) {
    this.mode = mode;
    if (mode === 'play') this.playState = { phase: 'stitch', wait: 0 };
    if (mode === 'hover') this.target = 1;
    if (mode === 'scroll') this.target = this.T;
    if (this.controls) this.controls.enableZoom = this.controls.enableRotate = mode !== 'scroll';
  }

  applyMotion(motion) {
    this.motion = motion;
    const u = this.uniforms;
    u.uGrowDur.value = motion.grow; u.uSettleDur.value = motion.settle;
    u.uDamp.value = motion.damp; u.uFreq.value = motion.freq;
    u.uLoop.value = motion.loop; u.uSway.value = motion.sway;
    if (this.flat) this.#applyTimes();
  }

  applyLook(look) {
    this.look = look;
    const L = look.light;
    const az = THREE.MathUtils.degToRad(L.azimuth), el = THREE.MathUtils.degToRad(L.elevation);
    this.key.position.set(Math.cos(el) * Math.cos(az) * 3, Math.sin(el) * 3, Math.cos(el) * Math.sin(az) * 3);
    this.key.color.set(L.colour);
    this.key.intensity = L.intensity;
    this.hemi.intensity = look.fill;
    this.scene.environmentIntensity = look.env;

    this.fabricMat.color.set(look.fabric);
    const { normal, roughness } = weaveTextures({ cells: look.weave.cells, slub: look.weave.slub });
    for (const tex of [normal, roughness]) tex.repeat.set(look.weave.repeat, look.weave.repeat);
    this.fabricMat.normalMap = normal;
    this.fabricMat.roughnessMap = roughness;
    this.fabricMat.needsUpdate = true;

    const m = this.threadMat;
    m.color.set(look.thread);
    m.roughness = look.threadRoughness;
    m.anisotropy = look.threadSheen;
    m.clearcoat = look.threadClearcoat;
    // Thread gets its own env intensity so it stays dark; highlights come from the key light.
    m.envMap = this.scene.environment;
    m.envMapIntensity = look.threadEnv ?? 0.25;
    m.needsUpdate = true;

    const C = look.camera;
    const caz = THREE.MathUtils.degToRad(C.azimuth), cel = THREE.MathUtils.degToRad(C.elevation);
    this.camera.fov = C.fov;
    this.camera.position.set(Math.sin(caz) * Math.cos(cel) * C.distance, Math.sin(cel) * C.distance, Math.cos(caz) * Math.cos(cel) * C.distance);
    this.camera.lookAt(0, 0, 0);
    this.camera.updateProjectionMatrix();
    if (this.controls) { this.controls.target.set(0, 0, 0); this.controls.update(); }

    this.bokeh.uniforms.aperture.value = look.dof.aperture;
    this.bokeh.uniforms.maxblur.value = look.dof.maxblur;

    if (this.flat) { this.#updatePucker(); this.#layoutStitches(); this.#applyTimes(); }
  }

  render() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    this.#advance(dt);
    const u = this.uniforms;
    u.uClock.value += dt;
    u.uTime.value = this.T;
    u.uPointer.value.z += (this.pointerTarget - u.uPointer.value.z) * (1 - Math.exp(-dt * 5));
    this.#updateNeedle(dt);
    this.controls?.update();
    this.bokeh.uniforms.focus.value = this.camera.position.length();
    this.composer.render();
  }

  // ---------- timeline ----------

  #advance(dt) {
    if (this.mode === 'play') {
      const p = this.playState, dur = this.motion.duration;
      if (p.phase === 'stitch') { this.T = Math.min(1, this.T + dt / dur); if (this.T >= 1) { p.phase = 'hold'; p.wait = 3; } }
      else if (p.phase === 'hold') { p.wait -= dt; if (p.wait <= 0) p.phase = 'unpick'; }
      else if (p.phase === 'unpick') { this.T = Math.max(0, this.T - dt / (dur * 0.3)); if (this.T <= 0) { p.phase = 'rest'; p.wait = 0.8; } }
      else if (p.phase === 'rest') { p.wait -= dt; if (p.wait <= 0) p.phase = 'stitch'; }
      this.target = this.T;
    } else if (this.mode === 'scroll' || this.mode === 'hover') {
      this.T += (this.target - this.T) * (1 - Math.exp(-dt * (this.mode === 'scroll' ? 5 : 1.5)));
      if (Math.abs(this.target - this.T) < 1e-4) this.T = this.target;
    }
  }

  // The cloth dips and ripples where the latest stitch is being pulled taut.
  #updateNeedle(dt) {
    const u = this.uniforms.uNeedle.value;
    let strength = 0;
    if (this.tautOrder && this.T > 0 && this.T < 1) {
      const T = this.T, order = this.tautOrder, times = this.times;
      const n = this.needleAt(T);
      const k = 1 - Math.exp(-dt * 10);
      this.needleXZ.x += (n.x - this.needleXZ.x) * k;
      this.needleXZ.y += (n.y - this.needleXZ.y) * k;
      const lastTaut = times[order[order.length - 1] * 2 + 1];
      strength = this.motion.tug * Math.min(1, T / 0.02) * Math.min(1, Math.max(0, (lastTaut + this.motion.settle - T) / 0.03));
    }
    u.x = this.needleXZ.x; u.y = this.needleXZ.y;
    u.z += (strength - u.z) * (1 - Math.exp(-dt * 6));
  }

  #applyTimes() {
    const times = this.times = stitchTimes(this.flat, this.motion);
    const attr = this.threads.geometry.getAttribute('aTimes');
    if (attr && attr.array.length === times.length) { attr.array.set(times); attr.needsUpdate = true; }
    else this.threads.geometry.setAttribute('aTimes', new THREE.InstancedBufferAttribute(times, 2));
    this.tautOrder = Array.from(this.flat.keys()).sort((a, b) => times[a * 2 + 1] - times[b * 2 + 1]);
    // The cloth puckers as the stitches over it are pulled taut.
    const geo = this.fabric.geometry, reveal = geo.getAttribute('aReveal');
    if (reveal && this.revealCell) {
      const N = this.revealN, cell = this.revealCell, minT = new Float32Array(N * N).fill(2);
      this.flat.forEach((s, i) => {
        const gx = Math.round((s.b[0] / LOGO_SIZE + 0.5) * (N - 1)), gz = Math.round((s.b[1] / LOGO_SIZE + 0.5) * (N - 1));
        if (gx >= 0 && gz >= 0 && gx < N && gz < N) minT[gz * N + gx] = Math.min(minT[gz * N + gx], times[i * 2 + 1]);
      });
      const grown = minFilter(minFilter(minT, N, 8), N, 8);
      for (let i = 0; i < reveal.count; i++) {
        const c = cell[i];
        reveal.array[i] = c < 0 ? 0 : Math.min(1, grown[c]);
      }
      reveal.needsUpdate = true;
    }
  }

  // ---------- fabric ----------

  #buildFabric() {
    const geo = new THREE.PlaneGeometry(6, 6, 512, 512);
    geo.rotateX(-Math.PI / 2);
    geo.setAttribute('aPucker', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
    geo.setAttribute('aReveal', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
    this.fabricMat = new THREE.MeshPhysicalMaterial({
      color: '#f3f4f6', roughness: 0.9, sheen: 0.6, sheenRoughness: 0.8, sheenColor: new THREE.Color('#ffffff'),
      normalScale: new THREE.Vector2(1.5, 1.5),
    });
    this.fabricMat.onBeforeCompile = shader => {
      injectCloth(shader, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float aPucker;\nattribute float aReveal;')
        .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
          { vec2 g = clothSlope(position.xz); objectNormal = normalize(objectNormal + vec3(-g.x, 0.0, -g.y)); }`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          transformed.y += clothOffset(position.xz) - aPucker * (1.0 - smoothstep(aReveal - 0.02, aReveal + 0.06, uTime));`);
    };
    this.fabric = new THREE.Mesh(geo, this.fabricMat);
    this.fabric.receiveShadow = true;
    this.basePositions = geo.attributes.position.array.slice();
    this.scene.add(this.fabric);
  }

  // Gentle fabric undulation plus pucker around the stitched area.
  #updatePucker() {
    const geo = this.fabric.geometry, pos = geo.attributes.position, puckerAttr = geo.getAttribute('aPucker');
    const N = 256, cover = new Float32Array(N * N);
    // Rasterise stitch coverage into a small grid over the logo area.
    for (const s of this.flat) {
      const steps = 6;
      for (let k = 0; k <= steps; k++) {
        const x = s.a[0] + (s.b[0] - s.a[0]) * k / steps, z = s.a[1] + (s.b[1] - s.a[1]) * k / steps;
        const gx = Math.round((x / LOGO_SIZE + 0.5) * (N - 1)), gz = Math.round((z / LOGO_SIZE + 0.5) * (N - 1));
        if (gx >= 0 && gz >= 0 && gx < N && gz < N) cover[gz * N + gx] = 1;
      }
    }
    const blur = (src, r) => { // separable box blur, twice ~ gaussian
      let a = src;
      for (let it = 0; it < 2; it++) {
        const b = new Float32Array(N * N), c = new Float32Array(N * N);
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          let sum = 0, n = 0; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < N) { sum += a[y * N + xx]; n++; } } b[y * N + x] = sum / n;
        }
        for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
          let sum = 0, n = 0; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < N) { sum += b[yy * N + x]; n++; } } c[y * N + x] = sum / n;
        }
        a = c;
      }
      return a;
    };
    const near = blur(cover, 3), far = blur(cover, 14);
    const cellOf = (x, z) => {
      const gx = (x / LOGO_SIZE + 0.5) * (N - 1), gz = (z / LOGO_SIZE + 0.5) * (N - 1);
      if (gx < 0 || gz < 0 || gx > N - 1 || gz > N - 1) return -1;
      return Math.round(gz) * N + Math.round(gx);
    };
    const sample = (g, x, z) => { const c = cellOf(x, z); return c < 0 ? 0 : g[c]; };
    const P = this.look.pucker;
    const folds = (x, z) => (Math.sin(x * 2.1 + 0.7) * Math.sin(z * 1.7 - 0.4) * 0.012 + Math.sin(x * 4.3 - z * 3.1) * 0.003) * Math.min(1, Math.hypot(x, z) / 0.9);
    const pucker = (x, z) => {
      const n = sample(near, x, z), f = sample(far, x, z), r = Math.hypot(x, z);
      // Stitched area is pulled tight and slightly raised; the cloth just outside ripples.
      return n * P * 0.35 + (f - n) * P * Math.sin(Math.atan2(z, x) * 9 + r * 40) * 0.8;
    };
    this.revealN = N;
    this.revealCell = new Int32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = this.basePositions[i * 3], z = this.basePositions[i * 3 + 2];
      const pk = pucker(x, z);
      pos.setY(i, folds(x, z) + pk);
      puckerAttr.array[i] = pk;
      this.revealCell[i] = cellOf(x, z);
    }
    pos.needsUpdate = true;
    puckerAttr.needsUpdate = true;
    geo.computeVertexNormals();
    this.heightAt = (x, z) => folds(x, z) + pucker(x, z);
  }

  // ---------- thread ----------

  #buildThreadMesh() {
    // Unit stitch: x from 0..1, arched in y, round cross-section of radius 1 (scaled per instance).
    // Built with a small radius (RHO) so the tube's end caps don't stretch with
    // the per-instance length scale; instances rescale y/z by radius / RHO.
    const pts = [];
    for (let i = 0; i <= 16; i++) {
      const u = i / 16;
      pts.push(new THREE.Vector3(u, (Math.pow(Math.sin(Math.PI * u), 0.35) - 0.55) * RHO, 0));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 24, RHO, 10, false);
    geo.computeTangents();
    this.threadMat = new THREE.MeshPhysicalMaterial({
      color: '#2b2d31', roughness: 0.34, metalness: 0,
      anisotropy: 0.85, anisotropyRotation: 0,
      clearcoat: 0.25, clearcoatRoughness: 0.18,
      sheen: 0.12, sheenRoughness: 0.5, sheenColor: new THREE.Color('#5a5e66'),
      normalMap: threadTwistNormal(), normalScale: new THREE.Vector2(0.35, 0.35),
    });
    this.threadMat.normalMap.repeat.set(1.5, 1);
    this.threadMat.onBeforeCompile = shader => injectThread(shader, this.uniforms, true);
    this.threadMat.customProgramCacheKey = () => 'stitch-thread';
    // Shadows use the same motion so loops cast moving shadows on the cloth.
    this.threadDepth = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.threadDepth.onBeforeCompile = shader => injectThread(shader, this.uniforms, false);
    this.threadDepth.customProgramCacheKey = () => 'stitch-thread-depth';
    this.threads = this.#makeThreads(geo, 1);
    this.threads.count = 0;
  }

  #makeThreads(geo, n) {
    const mesh = new THREE.InstancedMesh(geo, this.threadMat, n);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.customDepthMaterial = this.threadDepth;
    mesh.frustumCulled = false; // loops move outside the static bounds
    this.scene.add(mesh);
    return mesh;
  }

  #layoutStitches() {
    const flat = [];
    let region = 0;
    for (const layer of this.stitches.layers) for (const reg of layer.regions) {
      for (const s of reg.stitches) {
        // Engine is x right / y up; world is x right / z towards camera.
        flat.push({ a: [s.a[0] * LOGO_SIZE, -s.a[1] * LOGO_SIZE], b: [s.b[0] * LOGO_SIZE, -s.b[1] * LOGO_SIZE], t: s.t, colour: layer.colour, region });
      }
      region++;
    }
    flat.sort((p, q) => p.t - q.t);
    this.flat = flat;

    if (this.threads.instanceMatrix.count < flat.length) {
      const old = this.threads;
      this.scene.remove(old);
      this.threads = this.#makeThreads(old.geometry, flat.length);
    }
    this.threads.count = flat.length;
    // Thread radius is tied to stitch spacing so neighbouring stitches just overlap.
    const spacing = (1.15 / ENGINE_RES) * LOGO_SIZE;
    const radius = spacing * 0.85 * this.look.threadRadius;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color();
    const motionAttr = new Float32Array(flat.length * 4);
    let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const multi = this.stitches.layers.length > 1;
    flat.forEach((s, i) => {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dz);
      q.setFromAxisAngle(up, -Math.atan2(dz, dx));
      const midY = this.heightAt ? this.heightAt((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2) : 0;
      // Height follows the stitch length, so wide satin columns dome up like padded embroidery.
      const ySc = Math.max(radius * 1.8, len * 0.16 * this.look.padHeight) / RHO, zSc = radius / RHO;
      m.compose(new THREE.Vector3(s.a[0], midY + radius * 0.2, s.a[1]), q, new THREE.Vector3(len, ySc, zSc));
      this.threads.setMatrixAt(i, m);
      motionAttr.set([1 / ySc, 1 / zSc, len, rand()], i * 4);
      // Tiny per-stitch tone variation reads as real thread.
      // Single-colour artwork uses the look's thread colour; multi-colour keeps the SVG's fills.
      const tone = 1 + (rand() - 0.5) * 0.12;
      if (multi) colour.set(s.colour).multiplyScalar(tone); else colour.setRGB(tone, tone, tone);
      this.threads.setColorAt(i, colour);
    });
    this.threads.geometry.setAttribute('aMotion', new THREE.InstancedBufferAttribute(motionAttr, 4));
    if (!this.threads.geometry.getAttribute('aTimes') || this.threads.geometry.getAttribute('aTimes').count !== flat.length) {
      this.threads.geometry.setAttribute('aTimes', new THREE.InstancedBufferAttribute(new Float32Array(flat.length * 2), 2));
    }
    this.threads.instanceMatrix.needsUpdate = true;
    if (this.threads.instanceColor) this.threads.instanceColor.needsUpdate = true;
    this.threadMat.color.set(multi ? '#ffffff' : this.look.thread);
    this.threadMat.needsUpdate = true; // instance colours were just added: recompile
  }

  #resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

// Separable min filter (radius r cells) on an N x N grid.
function minFilter(src, N, r) {
  const a = new Float32Array(N * N), b = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let m = Infinity; for (let k = -r; k <= r; k++) { const xx = x + k; if (xx >= 0 && xx < N) m = Math.min(m, src[y * N + xx]); } a[y * N + x] = m;
  }
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    let m = Infinity; for (let k = -r; k <= r; k++) { const yy = y + k; if (yy >= 0 && yy < N) m = Math.min(m, a[yy * N + x]); } b[y * N + x] = m;
  }
  return b;
}
