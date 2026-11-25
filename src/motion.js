// Motion presets and the GLSL that animates each stitch and the cloth.
//
// Every stitch has two times on the 0..1 timeline:
//   start: the needle comes up and the thread is drawn out as a loose loop
//   taut:  the thread is pulled down and springs into its final, tight arch
// The shader works out each stitch's shape from those two times and the
// current timeline value, so playback can run forwards, backwards or be
// scrubbed by scroll with no simulation state to keep in sync.

export const MOTIONS = {
  // 1: closest to the reference. Loops pop up one after another and snap taut with a little bounce.
  spring: {
    name: '1 · Spring & settle',
    order: 'sequence', duration: 9,
    grow: 0.018, settle: 0.05, hold: 0,
    loop: 1.2, damp: 4.5, freq: 2.2, sway: 0.9, tug: 1.0,
    // Optional: extra loose loops that spring up ahead of the fill, then get combed flat.
    // Off for Spring & settle (Craig, 24 Nov): every loop stays on its own stitch, in stitch order.
    flourish: null,
    flourishLoose: {
      every: 16,                 // one loop per this many stitches
      lead: [0.05, 0.14],        // how far ahead of its stitch a loop appears (timeline units)
      height: [0.045, 0.11], width: [0.008, 0.026], sep: [0.006, 0.02],
      pop: 0.025, sweep: 0.03,   // spring-up and comb-down durations
      strays: 3, strayDelay: [0.01, 0.05], // per shape, loops that linger and whip in last
    },
  },
  // 2: calm and continuous. Long overlapping strokes, small loops, no bounce.
  flow: {
    name: '2 · Flowing thread',
    order: 'sequence', duration: 11,
    grow: 0.08, settle: 0.1, hold: 0,
    loop: 0.35, damp: 3.2, freq: 0.6, sway: 0.25, tug: 0.45,
  },
  // 3: each shape's loops spill out together, then get pulled tight around the shape.
  gather: {
    name: '3 · Scatter & gather',
    order: 'regions', duration: 10,
    grow: 0.05, settle: 0.06, hold: 0.25,
    loop: 0.85, damp: 5, freq: 1.6, sway: 0.9, tug: 0.8,
  },
};

// Start and taut times for every stitch (flat list sorted by engine t, each with .t and .region).
export function stitchTimes(flat, motion) {
  const n = flat.length;
  const times = new Float32Array(n * 2);
  const end = 1 - motion.settle;
  let seed = 11; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  if (motion.order === 'regions') {
    // Each region gets a slice of the timeline in proportion to its stitch count.
    const counts = new Map();
    for (const s of flat) counts.set(s.region, (counts.get(s.region) || 0) + 1);
    const slices = new Map(); let acc = 0;
    for (const [r, c] of counts) { slices.set(r, { from: acc / n, span: c / n, seen: 0, count: c }); acc += c; }
    flat.forEach((s, i) => {
      const sl = slices.get(s.region);
      const from = sl.from * end, span = sl.span * end;
      const k = sl.count > 1 ? sl.seen++ / (sl.count - 1) : 0;
      const start = from + rand() * motion.hold * span * 0.6;
      const taut = Math.max(start + motion.grow, from + motion.hold * span + k * (1 - motion.hold) * span - motion.grow);
      times[i * 2] = start; times[i * 2 + 1] = Math.min(taut, end);
    });
  } else {
    const span = end - motion.grow;
    flat.forEach((s, i) => {
      const start = s.t * span;
      times[i * 2] = start; times[i * 2 + 1] = start + motion.grow;
    });
  }
  return times;
}

// Flourish loops: per-instance attributes for the loop shader.
export function flourishLoops(flat, times, motion) {
  const f = motion.flourish;
  if (!f) return null;
  let seed = 23; const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const lerp = ([a, b]) => a + (b - a) * rand();
  const end = 1 - f.sweep;
  // Last taut time of each shape, for the strays.
  const regionEnd = new Map();
  flat.forEach((s, i) => regionEnd.set(s.region, Math.max(regionEnd.get(s.region) || 0, times[i * 2 + 1])));
  const picks = [];
  for (let i = Math.floor(rand() * f.every); i < flat.length; i += Math.max(1, Math.round(f.every * (0.6 + rand() * 0.8)))) picks.push(i);
  // The last few picks in each shape become strays.
  const strays = new Set(), seen = new Map();
  for (let k = picks.length - 1; k >= 0; k--) {
    const r = flat[picks[k]].region, n = seen.get(r) || 0;
    if (n < f.strays) { strays.add(picks[k]); seen.set(r, n + 1); }
  }
  const n = picks.length;
  const base = new Float32Array(n * 4), shape = new Float32Array(n * 4), ftimes = new Float32Array(n * 3);
  picks.forEach((i, k) => {
    const s = flat[i];
    const u = rand();
    base.set([s.a[0] + (s.b[0] - s.a[0]) * u, s.a[1] + (s.b[1] - s.a[1]) * u, rand() * Math.PI * 2, lerp(f.sep)], k * 4);
    const lean = (rand() - 0.5) * 0.9;
    shape.set([lerp(f.height), lerp(f.width), Math.abs(lean) < 0.05 ? 0.05 : lean, rand()], k * 4);
    const spawn = Math.max(0, times[i * 2] - lerp(f.lead));
    let sweep = times[i * 2 + 1] + rand() * 0.01, dur = f.sweep;
    if (strays.has(i)) { sweep = regionEnd.get(s.region) + lerp(f.strayDelay); dur = f.sweep * 0.5; }
    ftimes.set([spawn, Math.min(sweep, end), dur], k * 3);
  });
  return { count: n, base, shape, times: ftimes, hosts: picks, pop: f.pop };
}

export const FLOURISH_GLSL = /* glsl */`
attribute vec4 aBase;   // x, z, base angle, leg separation
attribute vec4 aShape;  // height, width, lean (signed), seed
attribute vec3 aFTimes; // spawn, sweep, sweep duration
uniform float uPopDur, uFlourishR;
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c * p.x + s * p.z, p.y, -s * p.x + c * p.z); }
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c * p.y - s * p.z, s * p.y + c * p.z); }
struct LoopState { float pop; float lay; float pull; float visible; };
LoopState loopState() {
  LoopState st;
  float g = clamp((uTime - aFTimes.x) / uPopDur, 0.0, 1.0);
  float s = clamp((uTime - aFTimes.y) / aFTimes.z, 0.0, 1.0);
  st.pop = 1.0 - exp(-5.0 * g) * cos(10.0 * g);
  st.lay = smoothstep(0.0, 0.6, s);
  st.pull = smoothstep(0.3, 1.0, s);
  st.visible = (uTime > aFTimes.x && s < 1.0) ? 1.0 : 0.0;
  return st;
}
float loopAngle(LoopState st) {
  float seed = aShape.w;
  float wob = 0.12 * sin(uClock * (1.3 + seed) + seed * 17.0) * (1.0 - st.lay);
  return aShape.z + wob + sign(aShape.z) * st.lay * 1.35;
}
vec3 loopCurve(float u, LoopState st, float ang) {
  float seed = aShape.w;
  float H = aShape.x * st.pop * (1.0 - st.pull);
  float W = aShape.y * (0.6 + 0.4 * st.pop) * (1.0 - 0.7 * st.pull);
  float sep = aBase.w * (1.0 - 0.8 * st.pull);
  vec3 p = vec3(sep * (u - 0.5) - W * sin(6.2832 * u), H * pow(sin(3.14159 * u), 0.7), 0.35 * W * sin(3.14159 * u) * sin(seed * 31.0));
  p = rotX(p, ang);
  p.y = max(p.y, uFlourishR * 1.2); // lies on the cloth rather than through it
  p = rotY(p, aBase.z);
  return p + vec3(aBase.x, 0.0, aBase.y);
}
void flourishVertex(out vec3 pos, out vec3 nrm) {
  LoopState st = loopState();
  float ang = loopAngle(st);
  float u = position.x, v = position.y;
  float du = u < 0.99 ? 0.01 : -0.01;
  vec3 c0 = loopCurve(u, st, ang), c1 = loopCurve(u + du, st, ang);
  vec3 T = normalize((c1 - c0) * sign(du) + vec3(1e-6, 0.0, 0.0));
  vec3 ref = rotY(rotX(vec3(0.0, 0.0, 1.0), ang), aBase.z);
  vec3 N = normalize(cross(T, ref) + vec3(0.0, 1e-5, 0.0));
  vec3 B = cross(T, N);
  nrm = cos(v) * N + sin(v) * B;
  pos = (c0 + uFlourishR * nrm) * st.visible;
}
`;

// Shared by the cloth and the thread so both move together:
// a dip and ripple where the needle is working, a press under the pointer, and a slow breath.
export const CLOTH_GLSL = /* glsl */`
uniform float uClock;
uniform float uTime;
uniform vec3 uNeedle;   // x, z, strength
uniform vec3 uPointer;  // x, z, strength
uniform float uBreath;
float clothOffset(vec2 p) {
  float d = distance(p, uNeedle.xy);
  float tug = uNeedle.z * (-0.0035 * exp(-d * d / 0.0022) + 0.0008 * sin(d * 95.0 - uClock * 7.0) * exp(-d * 10.0));
  float e = distance(p, uPointer.xy);
  float press = -uPointer.z * 0.0035 * exp(-e * e / 0.0045);
  float breath = uBreath * 0.0022 * sin(p.x * 2.3 + uClock * 0.7) * sin(p.y * 1.9 - uClock * 0.5);
  return tug + press + breath;
}
vec2 clothSlope(vec2 p) {
  const float h = 0.004;
  return vec2(clothOffset(p + vec2(h, 0.0)) - clothOffset(p - vec2(h, 0.0)),
              clothOffset(p + vec2(0.0, h)) - clothOffset(p - vec2(0.0, h))) / (2.0 * h);
}
`;

export const THREAD_GLSL = /* glsl */`
attribute vec4 aMotion; // 1/yScale, 1/zScale, stitch length, seed
attribute vec2 aTimes;  // start, taut
uniform float uGrowDur, uSettleDur, uDamp, uFreq, uLoop, uSway, uHover;
struct StitchMotion { float grow; float lift; float sway; float tear; float visible; };
StitchMotion stitchMotion() {
  StitchMotion m;
  float g = clamp((uTime - aTimes.x) / uGrowDur, 0.0, 1.0);
  float s = clamp((uTime - aTimes.y) / uSettleDur, 0.0, 1.0);
  m.visible = uTime > aTimes.x ? 1.0 : 0.0;
  float gE = 1.0 - pow(1.0 - g, 3.0);
  float spring = s <= 0.0 ? 1.0 : exp(-uDamp * s) * cos(uFreq * 6.2832 * s) * (1.0 - s * s);
  float amt = gE * spring;
  amt = amt < 0.0 ? amt * 0.3 : amt;              // overshoot pulls slightly into the cloth
  float seed = aMotion.w;
  // Loop height varies a lot between stitches: mostly medium, some small, the odd very tall one.
  float hvar = fract(seed * 7.13);
  float scale = 0.5 + 1.1 * hvar * hvar + (hvar > 0.92 ? 0.8 : 0.0);
  float H = uLoop * (0.45 * aMotion.z + 0.016) * scale;   // loop height in world units
  float wobble = 1.0 + 0.3 * sin(uClock * 3.5 + seed * 40.0) * step(0.001, amt);
  // Pointer loosens finished thread nearby.
  vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  float e = distance(ip, uPointer.xy);
  float hv = uPointer.z * uHover * s * exp(-e * e / 0.0025);
  float liftW = amt * H * wobble + hv * (0.003 + 0.2 * aMotion.z) * (0.85 + 0.15 * sin(uClock * 5.0 + seed * 20.0));
  float swayW = amt * uSway * H * (sin(seed * 43.0) + 0.45 * sin(uClock * 2.6 + seed * 9.0) * step(0.001, amt)) + hv * 0.0015 * sin(uClock * 3.0 + seed * 10.0);
  m.grow = gE;
  // Loose loops bulge into a teardrop, wider at the top than where the thread enters the cloth.
  m.tear = amt * 0.22 * H / max(aMotion.z, 0.004);
  m.lift = liftW * aMotion.x;
  m.sway = swayW * aMotion.y;
  return m;
}
`;
