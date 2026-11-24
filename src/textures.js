// Procedural textures: no image assets needed, so any colourway can be generated.
import * as THREE from 'three';

// Convert a height field (Float32Array, size x size, 0..1) to a tangent-space normal map.
function heightToNormal(h, size, strength) {
  const data = new Uint8Array(size * size * 4);
  const at = (x, y) => h[((y + size) % size) * size + ((x + size) % size)];
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const dx = (at(x + 1, y) - at(x - 1, y)) * strength;
    const dy = (at(x, y + 1) - at(x, y - 1)) * strength;
    let nx = -dx, ny = -dy, nz = 1;
    const l = Math.hypot(nx, ny, nz);
    nx /= l; ny /= l; nz /= l;
    const i = (y * size + x) * 4;
    data[i] = (nx * 0.5 + 0.5) * 255;
    data[i + 1] = (ny * 0.5 + 0.5) * 255;
    data[i + 2] = (nz * 0.5 + 0.5) * 255;
    data[i + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}

// Plain-weave canvas: warp and weft threads alternating over / under.
// `cells` is the number of weave crossings across the tile.
export function weaveTextures({ size = 512, cells = 16, slub = 0.25, seed = 1 } = {}) {
  const h = new Float32Array(size * size);
  const rough = new Uint8Array(size * size * 4);
  let s = seed;
  const rand = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  // Per-thread thickness variation gives a natural, slightly irregular canvas.
  const warpVar = Array.from({ length: cells }, () => 1 - slub * 0.5 + rand() * slub);
  const weftVar = Array.from({ length: cells }, () => 1 - slub * 0.5 + rand() * slub);
  const cell = size / cells;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell);
    const fx = (x % cell) / cell, fy = (y % cell) / cell; // 0..1 within cell
    const warpOnTop = (cx + cy) % 2 === 0;
    // Thread profile across its width (rounded) and along its length (dips where it goes under).
    const warpProfile = Math.sqrt(Math.max(0, 1 - ((fx - 0.5) / (0.46 * warpVar[cx])) ** 2));
    const weftProfile = Math.sqrt(Math.max(0, 1 - ((fy - 0.5) / (0.46 * weftVar[cy])) ** 2));
    const warpH = warpProfile * (warpOnTop ? 0.65 + 0.35 * Math.sin(Math.PI * fy) : 0.35 * (1 - Math.sin(Math.PI * fy)));
    const weftH = weftProfile * (!warpOnTop ? 0.65 + 0.35 * Math.sin(Math.PI * fx) : 0.35 * (1 - Math.sin(Math.PI * fx)));
    // Fine fibre noise.
    const fibre = (Math.sin(x * 1.7 + y * 0.3) * Math.sin(y * 2.3 - x * 0.2)) * 0.04;
    h[y * size + x] = Math.max(warpH, weftH) + fibre;
    const i = (y * size + x) * 4;
    const r = 200 - Math.max(warpH, weftH) * 60; // tops of threads slightly less rough
    rough[i] = rough[i + 1] = rough[i + 2] = r; rough[i + 3] = 255;
  }
  const normal = heightToNormal(h, size, 3.0);
  const roughness = new THREE.DataTexture(rough, size, size, THREE.RGBAFormat);
  roughness.wrapS = roughness.wrapT = THREE.RepeatWrapping;
  roughness.generateMipmaps = true;
  roughness.minFilter = THREE.LinearMipmapLinearFilter;
  roughness.needsUpdate = true;
  return { normal, roughness };
}

// Twisted-ply thread: diagonal ridges along the thread (u) around its circumference (v).
export function threadTwistNormal({ size = 256, plies = 4, twist = 3 } = {}) {
  const h = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const u = x / size, v = y / size;
    const phase = (v * plies + u * twist * plies) % 1;
    const ridge = Math.sin(Math.PI * phase) ** 0.6;
    const fibre = Math.sin((u * 90 + v * 7) * Math.PI * 2) * 0.05;
    h[y * size + x] = ridge + fibre;
  }
  return heightToNormal(h, size, 2.2);
}
