// Embroidery renderer: draws the stitch engine's output as real 3D thread on canvas.
//
//   const scene = new EmbroideryScene(container, { preset: LOOKS.studio });
//   await scene.setSVG(svgText);
//   scene.setProgress(1);      // 0..1 timeline (animated in step 3)
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
  // C: higher, crisper, more graphic, chunkier thread.
  graphic: {
    name: 'C · Graphic overhead',
    fabric: '#ebebeb', thread: '#222428', threadEnv: 0.55,
    threadRoughness: 0.34, threadSheen: 0.8, threadClearcoat: 0.25,
    threadRadius: 1.25, padHeight: 0.8,
    light: { colour: '#ffffff', intensity: 3.6, azimuth: -5, elevation: 32 },
    fill: 0.4, env: 1.0,
    camera: { elevation: 62, azimuth: 0, distance: 1.35, fov: 32 },
    dof: { aperture: 0.02, maxblur: 0.006 },
    weave: { cells: 16, repeat: 48, slub: 0.1 },
    pucker: 0.006,
  },
};

const LOGO_SIZE = 1.0;     // world units across the stitched artwork
const ENGINE_RES = 512;    // stitch-engine raster size
const RHO = 0.02;          // thread radius in the unit stitch geometry

export class EmbroideryScene {
  constructor(container, { preset = LOOKS.studio, controls = true } = {}) {
    this.container = container;
    this.look = preset;
    this.progress = 1;

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
    this.setProgress(this.progress);
    return this.stitches;
  }

  setProgress(t) {
    this.progress = t;
    if (!this.flat) return;
    // Step 2 shows the finished piece; step 3 replaces this with the loop / pull-taut motion.
    let n = 0;
    while (n < this.flat.length && this.flat[n].t <= t) n++;
    this.threads.count = n;
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

    if (this.flat) { this.#updatePucker(); this.#layoutStitches(); this.setProgress(this.progress); }
  }

  render() {
    this.controls?.update();
    this.bokeh.uniforms.focus.value = this.camera.position.length();
    this.composer.render();
  }

  // ---------- fabric ----------

  #buildFabric() {
    const geo = new THREE.PlaneGeometry(6, 6, 384, 384);
    geo.rotateX(-Math.PI / 2);
    this.fabricMat = new THREE.MeshPhysicalMaterial({
      color: '#f3f4f6', roughness: 0.9, sheen: 0.6, sheenRoughness: 0.8, sheenColor: new THREE.Color('#ffffff'),
      normalScale: new THREE.Vector2(1.5, 1.5),
    });
    this.fabric = new THREE.Mesh(geo, this.fabricMat);
    this.fabric.receiveShadow = true;
    this.basePositions = geo.attributes.position.array.slice();
    this.scene.add(this.fabric);
  }

  // Gentle fabric undulation plus pucker around the stitched area.
  #updatePucker() {
    const geo = this.fabric.geometry, pos = geo.attributes.position;
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
    const sample = (g, x, z) => {
      const gx = (x / LOGO_SIZE + 0.5) * (N - 1), gz = (z / LOGO_SIZE + 0.5) * (N - 1);
      if (gx < 0 || gz < 0 || gx > N - 1 || gz > N - 1) return 0;
      return g[Math.round(gz) * N + Math.round(gx)];
    };
    const P = this.look.pucker;
    for (let i = 0; i < pos.count; i++) {
      const x = this.basePositions[i * 3], z = this.basePositions[i * 3 + 2];
      const r = Math.hypot(x, z);
      // Broad soft folds in the cloth.
      let y = Math.sin(x * 2.1 + 0.7) * Math.sin(z * 1.7 - 0.4) * 0.012 + Math.sin(x * 4.3 - z * 3.1) * 0.003;
      y *= Math.min(1, r / 0.9);
      // Stitched area is pulled tight and slightly raised; the cloth just outside ripples.
      const n = sample(near, x, z), f = sample(far, x, z);
      const angle = Math.atan2(z, x);
      y += n * P * 0.35 + (f - n) * P * Math.sin(angle * 9 + r * 40) * 0.8;
      pos.setY(i, y);
    }
    pos.needsUpdate = true;
    geo.computeVertexNormals();
    this.heightAt = (x, z) => {
      const r = Math.hypot(x, z);
      let y = (Math.sin(x * 2.1 + 0.7) * Math.sin(z * 1.7 - 0.4) * 0.012 + Math.sin(x * 4.3 - z * 3.1) * 0.003) * Math.min(1, r / 0.9);
      const n = sample(near, x, z), f = sample(far, x, z);
      return y + n * P * 0.35 + (f - n) * P * Math.sin(Math.atan2(z, x) * 9 + r * 40) * 0.8;
    };
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
    this.threads = new THREE.InstancedMesh(geo, this.threadMat, 1);
    this.threads.castShadow = true;
    this.threads.receiveShadow = true;
    this.threads.count = 0;
    this.scene.add(this.threads);
  }

  #layoutStitches() {
    const flat = [];
    for (const layer of this.stitches.layers) for (const region of layer.regions) for (const s of region.stitches) {
      // Engine is x right / y up; world is x right / z towards camera.
      flat.push({ a: [s.a[0] * LOGO_SIZE, -s.a[1] * LOGO_SIZE], b: [s.b[0] * LOGO_SIZE, -s.b[1] * LOGO_SIZE], t: s.t, colour: layer.colour });
    }
    flat.sort((p, q) => p.t - q.t);
    this.flat = flat;

    if (this.threads.instanceMatrix.count < flat.length) {
      const old = this.threads;
      this.threads = new THREE.InstancedMesh(old.geometry, this.threadMat, flat.length);
      this.threads.castShadow = this.threads.receiveShadow = true;
      this.scene.remove(old);
      this.scene.add(this.threads);
    }
    // Thread radius is tied to stitch spacing so neighbouring stitches just overlap.
    const spacing = (1.15 / ENGINE_RES) * LOGO_SIZE;
    const radius = spacing * 0.85 * this.look.threadRadius;
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0);
    const colour = new THREE.Color(), base = new THREE.Color(this.look.thread);
    let seed = 7; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const multi = this.stitches.layers.length > 1;
    flat.forEach((s, i) => {
      const dx = s.b[0] - s.a[0], dz = s.b[1] - s.a[1];
      const len = Math.hypot(dx, dz);
      q.setFromAxisAngle(up, -Math.atan2(dz, dx));
      const midY = this.heightAt ? this.heightAt((s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2) : 0;
      m.compose(new THREE.Vector3(s.a[0], midY + radius * 0.2, s.a[1]), q,
        // Height follows the stitch length, so wide satin columns dome up like padded embroidery.
        new THREE.Vector3(len, Math.max(radius * 1.8, len * 0.16 * this.look.padHeight) / RHO, radius / RHO));
      this.threads.setMatrixAt(i, m);
      // Tiny per-stitch tone variation reads as real thread.
      // Single-colour artwork uses the look's thread colour; multi-colour keeps the SVG's fills.
      const tone = 1 + (rand() - 0.5) * 0.12;
      if (multi) colour.set(s.colour).multiplyScalar(tone); else colour.setRGB(tone, tone, tone);
      this.threads.setColorAt(i, colour);
    });
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
