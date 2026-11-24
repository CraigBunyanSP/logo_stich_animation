// Renders the scene several times per frame and averages the results:
//  - each sub-frame is jittered by a fraction of a pixel (supersampled anti-aliasing)
//  - each sub-frame is shifted back in time across the shutter (motion blur)
// Every motion in the scene is a function of the timeline and clock uniforms,
// so a sub-frame at an earlier time is exact, with no velocity buffer needed.
import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { CopyShader } from 'three/addons/shaders/CopyShader.js';

// Halton (2,3) offsets in -0.5..0.5 pixels.
function halton(i, b) { let f = 1, r = 0; while (i > 0) { f /= b; r += f * (i % b); i = Math.floor(i / b); } return r; }
const JITTER = Array.from({ length: 16 }, (_, i) => [halton(i + 1, 2) - 0.5, halton(i + 1, 3) - 0.5]);

export class AccumulatePass extends Pass {
  // setSubframe(fraction) is called before each sub-frame: 0 = start of the shutter, 1 = now.
  constructor(scene, camera, { samples = 4, msaa = 4, setSubframe = () => {} } = {}) {
    super();
    this.scene = scene; this.camera = camera;
    this.samples = samples;
    this.setSubframe = setSubframe;
    this.needsSwap = false;
    this.sampleTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: msaa });
    this.copy = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.clone(CopyShader.uniforms),
      vertexShader: CopyShader.vertexShader, fragmentShader: CopyShader.fragmentShader,
      transparent: true, depthTest: false, depthWrite: false, premultipliedAlpha: true, blending: THREE.AdditiveBlending,
    });
    this.quad = new FullScreenQuad(this.copy);
    this.width = 1; this.height = 1;
  }

  setSize(w, h) { this.width = w; this.height = h; this.sampleTarget.setSize(w, h); }

  render(renderer, writeBuffer, readBuffer) {
    const n = Math.max(1, Math.round(this.samples));
    const autoClear = renderer.autoClear, shadowAuto = renderer.shadowMap.autoUpdate;
    renderer.autoClear = false;
    renderer.shadowMap.autoUpdate = false;
    const cam = this.camera;
    for (let i = 0; i < n; i++) {
      const [jx, jy] = n > 1 ? JITTER[i % JITTER.length] : [0, 0];
      cam.setViewOffset(this.width, this.height, jx, jy, this.width, this.height);
      this.setSubframe(n > 1 ? (i + 0.5) / n : 1);
      renderer.shadowMap.needsUpdate = i === 0; // one shadow map per frame keeps the cost down
      renderer.setRenderTarget(this.sampleTarget);
      renderer.clear();
      renderer.render(this.scene, cam);
      this.copy.uniforms.tDiffuse.value = this.sampleTarget.texture;
      this.copy.uniforms.opacity.value = 1 / n;
      renderer.setRenderTarget(this.renderToScreen ? null : readBuffer);
      if (i === 0) renderer.clear();
      this.quad.render(renderer);
    }
    cam.clearViewOffset();
    this.setSubframe(1);
    renderer.autoClear = autoClear;
    renderer.shadowMap.autoUpdate = shadowAuto;
  }

  dispose() { this.sampleTarget.dispose(); this.copy.dispose(); this.quad.dispose(); }
}
