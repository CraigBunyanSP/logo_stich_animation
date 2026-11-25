// Stitch engine: turns any SVG into an ordered list of embroidery stitches.
//
// Pipeline (all in the browser, no dependencies):
//   1. Rasterise the SVG to a square mask and split it into colour layers.
//   2. For each layer, split into connected regions (ring, letters, ...).
//   3. Per region: distance transform -> skeleton (medial axis) -> traced spine
//      polylines. Satin stitches are thrown across the stroke, perpendicular to
//      the spine, reaching the shape edge on both sides.
//   4. Regions too wide for satin stitch fall back to tatami fill rows.
//   5. Everything is ordered (layer, then region, then along the spine) so an
//      animation can play it back as a 0..1 timeline.
//
// Output coordinates are normalised to [-0.5, 0.5] with y up, centred on the
// artwork, so the renderer can place the logo on the fabric directly.

const DEFAULTS = {
  resolution: 512,        // raster size used for analysis
  padding: 0.08,          // fraction of the raster kept clear around the art
  stitchSpacing: 1.6,     // px (at analysis resolution) between satin stitches
  maxSatinWidth: 60,      // px; wider strokes use tatami fill instead
  tatamiSpacing: 2.2,     // px between tatami rows
  tatamiStitchLen: 14,    // px max length of one tatami stitch
  minRegionArea: 30,      // px; specks below this are ignored
  colourTolerance: 48,    // RGB distance for grouping fills into layers
};

// `input` is SVG text, or a File / Blob (SVG, PNG, JPEG or WebP).
export async function svgToStitches(input, options = {}) {
  const o = { ...DEFAULTS, ...options };
  const { data, size } = await rasterise(input, o);
  const layers = splitLayers(data, size, o);
  const out = { size, layers: [] };
  for (const layer of layers) {
    const regions = connectedRegions(layer.mask, size, o.minRegionArea);
    // Order regions: largest enclosing shapes first (e.g. a ring), then left to right.
    regions.sort((a, b) => regionOrderKey(a, size) - regionOrderKey(b, size));
    const stitchedRegions = [];
    for (const region of regions) {
      const stitches = stitchRegion(region, size, o);
      if (stitches.length) stitchedRegions.push({ bbox: region.bbox, stitches });
    }
    out.layers.push({ colour: layer.colour, regions: stitchedRegions });
  }
  normalise(out, size);
  return out;
}

// ---------- 1. rasterise ----------

// Accepts SVG text, or a File / Blob (SVG, PNG, JPEG, WebP).
async function rasterise(input, o) {
  const size = o.resolution;
  const isSVG = typeof input === 'string' || input.type === 'image/svg+xml' || /\.svg$/i.test(input.name || '');
  const img = isSVG
    ? await loadSVGImage(prepareSVG(typeof input === 'string' ? input : await input.text()))
    : await createImageBitmap(input).catch(() => { throw new Error('This file could not be read as an image.'); });
  try {
    const w = img.naturalWidth || img.width || 1024, h = img.naturalHeight || img.height || 1024;
    const inner = size * (1 - 2 * o.padding);
    const scale = inner / Math.max(w, h);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    const draw = (sc, x0, y0) => {
      ctx.clearRect(0, 0, size, size);
      ctx.drawImage(img, x0, y0, w * sc, h * sc);
      let imageData;
      try { imageData = ctx.getImageData(0, 0, size, size); }
      catch { throw new Error('The browser would not let the page read this image.'); }
      removeBackground(imageData.data, size, Math.round(x0), Math.round(y0), Math.round(w * sc), Math.round(h * sc));
      return imageData;
    };
    let imageData = draw(scale, (size - w * scale) / 2, (size - h * scale) / 2);
    // Logos with lots of empty space in their viewBox: redraw so the artwork itself fills the frame.
    const box = artworkBounds(imageData.data, size);
    if (!box) throw new Error('No shapes were found in this file.');
    const span = Math.max(box.w, box.h);
    if (span < inner * 0.97) {
      const k = inner / span, sc = scale * k;
      const cx = box.x + box.w / 2, cy = box.y + box.h / 2;            // artwork centre in raster px
      const x0 = (size - w * scale) / 2, y0 = (size - h * scale) / 2;
      imageData = draw(sc, size / 2 - (cx - x0) * k, size / 2 - (cy - y0) * k);
    }
    return { data: imageData.data, size };
  } finally {
    img.close?.();
  }
}

// SVG goes in as a data: URL, not a blob: URL. Firefox treats blob: URLs made inside a
// sandboxed frame (as on an embed or an artifact page) as another origin, which locks
// the canvas against reading pixels back. Waits on load rather than decode(), which
// Firefox does not always resolve for SVG.
function loadSVGImage(svgText) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('This SVG could not be drawn. It may use features browsers do not support in images, such as external fonts or linked files.'));
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgText);
  });
}

// Make SVG text safe to rasterise: needs an xmlns, and an explicit size that
// keeps the viewBox's aspect (browsers otherwise fall back to 300 x 150).
function prepareSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('This doesn\'t look like a valid SVG file.');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  let w = parseFloat(svg.getAttribute('width')), h = parseFloat(svg.getAttribute('height'));
  const pct = /%/.test(svg.getAttribute('width') || '') || /%/.test(svg.getAttribute('height') || '');
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0 && (!(w > 0) || !(h > 0) || pct)) { w = vb[2]; h = vb[3]; }
  if (!(w > 0) || !(h > 0)) { w = 1024; h = 1024; }
  // Rasterise large so thin details survive.
  const k = 2048 / Math.max(w, h);
  svg.setAttribute('width', String(w * k));
  svg.setAttribute('height', String(h * k));
  if (vb.length !== 4) svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  return new XMLSerializer().serializeToString(svg);
}

// A solid background (a full-bleed rect, or a JPEG's paper colour) would be
// stitched as one huge block. If the four corners of the artwork share one
// opaque colour, treat that colour as the background and clear it.
function removeBackground(d, size, x0, y0, w, h) {
  const at = (x, y) => (Math.min(size - 1, Math.max(0, y)) * size + Math.min(size - 1, Math.max(0, x))) * 4;
  const corners = [at(x0 + 1, y0 + 1), at(x0 + w - 2, y0 + 1), at(x0 + 1, y0 + h - 2), at(x0 + w - 2, y0 + h - 2)];
  if (corners.some(i => d[i + 3] < 200)) return;
  const [r, g, b] = [d[corners[0]], d[corners[0] + 1], d[corners[0] + 2]];
  const same = i => d[i + 3] > 0 && Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) < 60;
  if (!corners.every(same)) return;
  // Clear every pixel of the background colour, including holes it shows through
  // (letter counters, the inside of a ring), which would otherwise be stitched.
  for (let i = 0; i < d.length; i += 4) if (same(i)) d[i + 3] = 0;
}

function artworkBounds(d, size) {
  let minX = size, minY = size, maxX = -1, maxY = -1;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    if (d[(y * size + x) * 4 + 3] > 40) { if (x < minX) minX = x; if (x > maxX) maxX = x; if (y < minY) minY = y; if (y > maxY) maxY = y; }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

// ---------- 2. colour layers ----------

function splitLayers(data, size, o) {
  const clusters = []; // {r,g,b,count,mask}
  const n = size * size;
  const owner = new Int16Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    if (a < 128) continue;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    let best = -1, bestD = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const k = clusters[c];
      const d = Math.hypot(r - k.r, g - k.g, b - k.b);
      if (d < bestD) { bestD = d; best = c; }
    }
    if (best < 0 || bestD > o.colourTolerance) {
      clusters.push({ r, g, b, count: 0 });
      best = clusters.length - 1;
    }
    clusters[best].count++;
    owner[i] = best;
  }
  // Anti-aliased edges create tiny in-between colours: fold any cluster under
  // 1.5% of the inked area into the nearest large one.
  const totalInk = clusters.reduce((s, k) => s + k.count, 0);
  const big = clusters.map((k, c) => (k.count >= totalInk * 0.015 ? c : -1)).filter(c => c >= 0);
  const remap = clusters.map((k, c) => {
    if (big.includes(c)) return c;
    let best = big[0], bestD = Infinity;
    for (const b of big) {
      const d = Math.hypot(k.r - clusters[b].r, k.g - clusters[b].g, k.b - clusters[b].b);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  });
  for (let i = 0; i < n; i++) if (owner[i] >= 0) owner[i] = remap[owner[i]];
  for (let c = 0; c < clusters.length; c++) clusters[c].count = 0;
  for (let i = 0; i < n; i++) if (owner[i] >= 0) clusters[owner[i]].count++;
  return clusters
    .map((k, c) => {
      const mask = new Uint8Array(n);
      for (let i = 0; i < n; i++) if (owner[i] === c) mask[i] = 1;
      const hex = '#' + [k.r, k.g, k.b].map(v => v.toString(16).padStart(2, '0')).join('');
      return { colour: hex, mask, count: k.count };
    })
    .filter(l => l.count >= o.minRegionArea)
    .sort((a, b) => b.count - a.count); // biggest colour area stitched first
}

// ---------- 3. regions ----------

function connectedRegions(mask, size, minArea) {
  const label = new Int32Array(size * size).fill(-1);
  const regions = [];
  const stack = [];
  for (let start = 0; start < mask.length; start++) {
    if (!mask[start] || label[start] >= 0) continue;
    const id = regions.length;
    const pixels = [];
    let minX = size, minY = size, maxX = 0, maxY = 0;
    stack.push(start);
    label[start] = id;
    while (stack.length) {
      const p = stack.pop();
      pixels.push(p);
      const x = p % size, y = (p / size) | 0;
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      for (const q of [p - 1, p + 1, p - size, p + size]) {
        if (q < 0 || q >= mask.length) continue;
        if (Math.abs((q % size) - x) > 1) continue;
        if (mask[q] && label[q] < 0) { label[q] = id; stack.push(q); }
      }
    }
    if (pixels.length >= minArea) {
      const m = new Uint8Array(size * size);
      for (const p of pixels) m[p] = 1;
      regions.push({ mask: m, area: pixels.length, bbox: [minX, minY, maxX, maxY] });
    }
  }
  return regions;
}

function regionOrderKey(r, size) {
  const [x0, y0, x1, y1] = r.bbox;
  const extent = Math.max(x1 - x0, y1 - y0) / size; // 0..1
  // Large enclosing shapes first, then by left edge.
  return (extent > 0.6 ? 0 : 1) * 10 + x0 / size;
}

// ---------- 4. per-region stitching ----------

function stitchRegion(region, size, o) {
  const dist = distanceTransform(region.mask, size);
  const skel = skeletonise(region.mask, size);
  const spines = traceSkeleton(skel, size, dist);
  let maxR = 0;
  for (const s of spines) for (const p of s) maxR = Math.max(maxR, p.r);
  if (!spines.length || maxR * 2 > o.maxSatinWidth) return tatami(region, size, o);
  const stitches = [];
  for (const spine of orderSpines(spines)) satinAlong(spine, region.mask, size, o, stitches);
  return stitches;
}

// Exact Euclidean distance transform (Felzenszwalb & Huttenlocher), distance to background.
function distanceTransform(mask, size) {
  const INF = 1e12;
  const f = new Float64Array(size * size);
  for (let i = 0; i < f.length; i++) f[i] = mask[i] ? INF : 0;
  const tmp = new Float64Array(size), d = new Float64Array(size);
  const v = new Int32Array(size), z = new Float64Array(size + 1);
  const pass = (get, set) => {
    for (let q = 0; q < size; q++) tmp[q] = get(q);
    let k = 0; v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < size; q++) {
      let s;
      do {
        const p = v[k];
        s = ((tmp[q] + q * q) - (tmp[p] + p * p)) / (2 * q - 2 * p);
      } while (s <= z[k] && --k >= 0);
      k++; v[k] = q; z[k] = s; z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < size; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) ** 2 + tmp[v[k]];
    }
    for (let q = 0; q < size; q++) set(q, d[q]);
  };
  for (let x = 0; x < size; x++) pass(y => f[y * size + x], (y, val) => { f[y * size + x] = val; });
  for (let y = 0; y < size; y++) pass(x => f[y * size + x], (x, val) => { f[y * size + x] = val; });
  for (let i = 0; i < f.length; i++) f[i] = Math.sqrt(f[i]);
  return f;
}

// Zhang-Suen thinning.
function skeletonise(mask, size) {
  const img = Uint8Array.from(mask);
  const idx = (x, y) => y * size + x;
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 1; y < size - 1; y++) for (let x = 1; x < size - 1; x++) {
        if (!img[idx(x, y)]) continue;
        const p2 = img[idx(x, y - 1)], p3 = img[idx(x + 1, y - 1)], p4 = img[idx(x + 1, y)],
          p5 = img[idx(x + 1, y + 1)], p6 = img[idx(x, y + 1)], p7 = img[idx(x - 1, y + 1)],
          p8 = img[idx(x - 1, y)], p9 = img[idx(x - 1, y - 1)];
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0;
        for (let i = 0; i < 8; i++) if (!seq[i] && seq[i + 1]) A++;
        if (A !== 1) continue;
        if (step === 0 ? (p2 * p4 * p6 || p4 * p6 * p8) : (p2 * p4 * p8 || p2 * p6 * p8)) continue;
        del.push(idx(x, y));
      }
      if (del.length) changed = true;
      for (const i of del) img[i] = 0;
    }
  }
  return img;
}

const N8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];

// Walk the skeleton into polylines, splitting at junctions. Short spurs are dropped.
function traceSkeleton(skel, size, dist) {
  const at = (x, y) => (x >= 0 && y >= 0 && x < size && y < size) ? skel[y * size + x] : 0;
  const degree = (x, y) => N8.reduce((n, [dx, dy]) => n + at(x + dx, y + dy), 0);
  const visited = new Uint8Array(size * size);
  const lines = [];
  // Walk greedily, preferring the neighbour that keeps the current heading.
  // Staircase pixels from thinning look like junctions, so we never stop at
  // them; real branches are picked up later as separate lines.
  const walk = (sx, sy) => {
    const pts = [{ x: sx, y: sy }];
    visited[sy * size + sx] = 1;
    let x = sx, y = sy, hx = 0, hy = 0;
    for (;;) {
      let next = null, best = -Infinity;
      for (const [dx, dy] of N8) {
        const nx = x + dx, ny = y + dy;
        if (!at(nx, ny) || visited[ny * size + nx]) continue;
        const score = (dx * hx + dy * hy) / Math.hypot(dx, dy) - (dx && dy ? 0.05 : 0);
        if (score > best) { best = score; next = [nx, ny, dx, dy]; }
      }
      if (!next) break;
      const [nx, ny, dx, dy] = next;
      // Mark the other unvisited neighbours of the current pixel as visited
      // when they are just the thick side of a staircase step.
      x = nx; y = ny;
      const l = Math.hypot(dx, dy);
      hx = hx * 0.6 + (dx / l) * 0.4; hy = hy * 0.6 + (dy / l) * 0.4;
      visited[y * size + x] = 1;
      pts.push({ x, y });
    }
    return pts;
  };
  // Start from endpoints first, then junction neighbours, then loops.
  for (const pass of [d => d === 1, d => d > 2, () => true]) {
    for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
      if (!at(x, y) || visited[y * size + x] || !pass(degree(x, y))) continue;
      const line = walk(x, y);
      // Close loops (e.g. a ring) so there's no gap where the walk began.
      if (line.length > 8) {
        const a = line[0], b = line.at(-1);
        if (Math.hypot(a.x - b.x, a.y - b.y) < 10) { line.push({ x: a.x, y: a.y }); line.closed = true; }
      }
      if (line.length > 1) lines.push(line);
    }
  }
  // Attach radius, drop spurs shorter than the local stroke width, smooth.
  return lines
    .map(line => Object.assign(line.map(p => ({ ...p, r: dist[p.y * size + p.x] })), { closed: line.closed }))
    .filter(line => {
      const meanR = line.reduce((s, p) => s + p.r, 0) / line.length;
      return line.length > Math.max(3, meanR * 0.9);
    })
    .map(line => Object.assign(smooth(line, 3, line.closed), { closed: line.closed }));
}

function smooth(line, k, closed) {
  const L = closed ? line.length - 1 : line.length; // closed loops repeat the first point at the end
  return line.map((p, i) => {
    let sx = 0, sy = 0, sr = 0, n = 0;
    const lo = closed ? i - k : Math.max(0, i - k), hi = closed ? i + k : Math.min(line.length - 1, i + k);
    for (let jj = lo; jj <= hi; jj++) {
      const j = closed ? ((jj % L) + L) % L : jj;
      sx += line[j].x; sy += line[j].y; sr += line[j].r; n++;
    }
    return { x: sx / n, y: sy / n, r: sr / n };
  });
}

// Chain spines greedily so the needle travels the shortest jumps.
function orderSpines(spines) {
  const left = spines.slice().sort((a, b) => Math.min(a[0].x, a.at(-1).x) - Math.min(b[0].x, b.at(-1).x));
  const out = [left.shift()];
  while (left.length) {
    const end = out.at(-1).at(-1);
    let best = 0, bestD = Infinity, flip = false;
    left.forEach((s, i) => {
      const d0 = Math.hypot(s[0].x - end.x, s[0].y - end.y);
      const d1 = Math.hypot(s.at(-1).x - end.x, s.at(-1).y - end.y);
      if (d0 < bestD) { bestD = d0; best = i; flip = false; }
      if (d1 < bestD) { bestD = d1; best = i; flip = true; }
    });
    const s = left.splice(best, 1)[0];
    out.push(flip ? Object.assign(s.slice().reverse(), { closed: s.closed }) : s);
  }
  return out;
}

// Throw satin stitches across the stroke along one spine.
function satinAlong(spine, mask, size, o, out) {
  const inside = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < size && yi < size && mask[yi * size + xi];
  };
  // Resample the spine at even arc length.
  const pts = [];
  let carry = 0;
  for (let i = 1; i < spine.length; i++) {
    const a = spine[i - 1], b = spine[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    let t = carry;
    while (t < seg) {
      const u = t / seg;
      pts.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u, i });
      t += o.stitchSpacing;
    }
    carry = t - seg;
  }
  let flip = false;
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k];
    const L = spine.length - 1;
    const a = spine.closed ? spine[((p.i - 3) % L + L) % L] : spine[Math.max(0, p.i - 3)];
    const b = spine.closed ? spine[(p.i + 2) % L] : spine[Math.min(spine.length - 1, p.i + 2)];
    let tx = b.x - a.x, ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1; tx /= tl; ty /= tl;
    const nx = -ty, ny = tx;
    // March to the edge on both sides.
    // Cap the reach to the local stroke half-width so stitches at junctions
    // don't shoot down a crossing stroke.
    const sp = spine[Math.min(spine.length - 1, p.i)];
    const cap = Math.min(o.maxSatinWidth, sp.r * 1.35 + 1);
    const reach = (sx) => {
      let d = 0;
      while (d < cap && inside(p.x + nx * sx * (d + 0.5), p.y + ny * sx * (d + 0.5))) d += 0.5;
      return d;
    };
    const d1 = reach(1), d2 = reach(-1);
    if (d1 + d2 < 1) continue;
    // Slight lean along the stroke gives the classic satin sheen direction.
    const lean = 0.35;
    let A = [p.x + nx * d1 + tx * lean, p.y + ny * d1 + ty * lean];
    let B = [p.x - nx * d2 - tx * lean, p.y - ny * d2 - ty * lean];
    if (flip) [A, B] = [B, A];
    flip = !flip;
    out.push({ a: A, b: B });
  }
}

// Tatami fill for wide areas: parallel rows of short running stitches, brick offset.
function tatami(region, size, o) {
  const out = [];
  const [x0, y0, x1, y1] = region.bbox;
  const angle = Math.PI / 4;
  const ca = Math.cos(angle), sa = Math.sin(angle);
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const R = Math.hypot(x1 - x0, y1 - y0) / 2 + 2;
  const inside = (x, y) => {
    const xi = Math.round(x), yi = Math.round(y);
    return xi >= 0 && yi >= 0 && xi < size && yi < size && region.mask[yi * size + xi];
  };
  let row = 0;
  for (let v = -R; v <= R; v += o.tatamiSpacing, row++) {
    const dir = row % 2 ? -1 : 1;
    const offset = (row % 3) / 3 * o.tatamiStitchLen;
    let runStart = null;
    for (let u0 = -R; u0 <= R + 1; u0 += 0.5) {
      const u = dir > 0 ? u0 : -u0;
      const x = cx + u * ca - v * sa, y = cy + u * sa + v * ca;
      const isIn = inside(x, y);
      if (isIn && !runStart) runStart = u;
      if ((!isIn || u0 > R) && runStart !== null) {
        const uEnd = u - dir * 0.5;
        const len = Math.abs(uEnd - runStart);
        const n = Math.max(1, Math.ceil((len + offset) / o.tatamiStitchLen));
        for (let k = 0; k < n; k++) {
          const s0 = Math.max(0, k * o.tatamiStitchLen - offset);
          const s1 = Math.min(len, (k + 1) * o.tatamiStitchLen - offset);
          if (s1 - s0 < 1) continue;
          const ua = runStart + dir * s0, ub = runStart + dir * s1;
          out.push({ a: [cx + ua * ca - v * sa, cy + ua * sa + v * ca], b: [cx + ub * ca - v * sa, cy + ub * sa + v * ca] });
        }
        runStart = null;
      }
    }
  }
  return out;
}

// ---------- 5. normalise ----------

function normalise(out, size) {
  let total = 0;
  for (const layer of out.layers) for (const r of layer.regions) total += r.stitches.length;
  let k = 0;
  const conv = ([x, y]) => [x / size - 0.5, 0.5 - y / size];
  for (const layer of out.layers) for (const r of layer.regions) for (const s of r.stitches) {
    s.a = conv(s.a); s.b = conv(s.b);
    s.t = total > 1 ? k / (total - 1) : 0; // playback position 0..1
    k++;
  }
  out.count = total;
}
