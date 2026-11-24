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
    grow: 0.014, settle: 0.04, hold: 0,
    loop: 1.0, damp: 4.5, freq: 2.2, sway: 0.5, tug: 1.0,
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
struct StitchMotion { float grow; float lift; float sway; float visible; };
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
  float H = uLoop * (0.35 * aMotion.z + 0.012);   // loop height in world units
  float wobble = 1.0 + 0.15 * sin(uClock * 4.0 + seed * 40.0) * step(0.001, amt);
  // Pointer loosens finished thread nearby.
  vec2 ip = vec2(instanceMatrix[3].x, instanceMatrix[3].z);
  float e = distance(ip, uPointer.xy);
  float hv = uPointer.z * uHover * s * exp(-e * e / 0.0025);
  float liftW = amt * H * wobble + hv * (0.003 + 0.2 * aMotion.z) * (0.85 + 0.15 * sin(uClock * 5.0 + seed * 20.0));
  float swayW = amt * uSway * H * sin(seed * 43.0 + uClock * 1.5 * step(0.001, amt)) + hv * 0.0015 * sin(uClock * 3.0 + seed * 10.0);
  m.grow = gE;
  m.lift = liftW * aMotion.x;
  m.sway = swayW * aMotion.y;
  return m;
}
`;
