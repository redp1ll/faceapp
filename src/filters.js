// Colour-grading filters in the style of photo apps: a tone curve per
// channel, split toning (tint shadows and highlights separately), faded
// blacks, saturation / vibrance, black & white and a vignette.
// Every filter is blended with the unfiltered photo by its strength.
import { clamp01, lum } from './imageops.js';

// Curves are control points [x, y] in 0..1 (monotone cubic through them).
// Tints are RGB offsets added in shadows / highlights.
export const FILTERS = [
  { id: 'clear', name: 'Klar',
    all: [[0, 0], [0.25, 0.22], [0.5, 0.5], [0.75, 0.79], [1, 1]], vibrance: 0.25 },
  { id: 'golden', name: 'Golden',
    all: [[0, 0.02], [0.5, 0.53], [1, 1]], hi: [0.05, 0.025, -0.04], lo: [0.02, 0.0, -0.02], vibrance: 0.15 },
  { id: 'film', name: 'Film',
    all: [[0, 0.06], [0.25, 0.25], [0.6, 0.63], [1, 0.96]],
    r: [[0, 0], [0.5, 0.52], [1, 1]], b: [[0, 0.04], [0.5, 0.49], [1, 0.95]],
    lo: [-0.02, 0.01, 0.03], hi: [0.03, 0.015, -0.02], sat: -0.08, skin: 0.6 },
  { id: 'cinema', name: 'Kino',
    all: [[0, 0.02], [0.25, 0.2], [0.75, 0.8], [1, 0.98]],
    lo: [-0.04, 0.02, 0.05], hi: [0.05, 0.02, -0.04], vibrance: 0.1, skin: 0.8, vignette: 0.25 },
  { id: 'pastel', name: 'Pastell',
    all: [[0, 0.1], [0.5, 0.55], [1, 0.97]], hi: [0.03, 0.0, 0.02], lo: [0.0, 0.01, 0.03], sat: -0.2 },
  { id: 'cool', name: 'Kühl',
    all: [[0, 0.01], [0.5, 0.5], [1, 1]], b: [[0, 0.03], [0.5, 0.54], [1, 1]], r: [[0, 0], [0.5, 0.48], [1, 0.98]],
    hi: [-0.01, 0.005, 0.03], sat: -0.05, skin: 0.7 },
  { id: 'matte', name: 'Matt',
    all: [[0, 0.12], [0.3, 0.3], [0.7, 0.7], [1, 0.92]], sat: -0.12 },
  { id: 'vintage', name: 'Vintage',
    all: [[0, 0.08], [0.5, 0.52], [1, 0.93]], r: [[0, 0.02], [0.5, 0.53], [1, 1]], b: [[0, 0.06], [0.5, 0.45], [1, 0.85]],
    lo: [0.0, 0.02, 0.0], sat: -0.25, vignette: 0.3 },
  { id: 'noir', name: 'Noir',
    mono: true, all: [[0, 0], [0.2, 0.12], [0.5, 0.5], [0.8, 0.88], [1, 1]], vignette: 0.35 },
  { id: 'mono', name: 'S/W weich',
    mono: true, all: [[0, 0.07], [0.5, 0.53], [1, 0.96]] },
];

// Monotone cubic (Fritsch–Carlson) curve sampled into a 1024-entry table.
const N = 1024;
function curveTable(pts) {
  const t = new Float32Array(N);
  if (!pts) { for (let i = 0; i < N; i++) t[i] = i / (N - 1); return t; }
  const n = pts.length, xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const d = [], m = new Array(n);
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (!d[i]) { m[i] = m[i + 1] = 0; continue; }
    const a = m[i] / d[i], b = m[i + 1] / d[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * d[i]; m[i + 1] = k * b * d[i]; }
  }
  let seg = 0;
  for (let j = 0; j < N; j++) {
    const x = j / (N - 1);
    while (seg < n - 2 && x > xs[seg + 1]) seg++;
    const h = xs[seg + 1] - xs[seg], u = (x - xs[seg]) / h;
    const h00 = 2 * u ** 3 - 3 * u ** 2 + 1, h10 = u ** 3 - 2 * u ** 2 + u, h01 = -2 * u ** 3 + 3 * u ** 2, h11 = u ** 3 - u ** 2;
    t[j] = clamp01(h00 * ys[seg] + h10 * h * m[seg] + h01 * ys[seg + 1] + h11 * h * m[seg + 1]);
  }
  return t;
}

const compiled = new Map();
function compile(f) {
  let c = compiled.get(f.id);
  if (!c) {
    const all = curveTable(f.all);
    const ch = [f.r, f.g, f.b].map(curveTable);
    // Fold the master curve into each channel's table.
    c = ch.map((t) => { const o = new Float32Array(N); for (let i = 0; i < N; i++) o[i] = t[Math.round(all[i] * (N - 1))]; return o; });
    compiled.set(f.id, c);
  }
  return c;
}

const lut = (t, v) => t[Math.max(0, Math.min(N - 1, Math.round(v * (N - 1))))];

// How skin-like a colour is (warm, moderately saturated), 0..1.
export function skinness(r, g, b) {
  if (!(r > g && g > b)) return 0;
  const sat = (r - b) / (r + 1e-4);
  return Math.max(0, 1 - Math.abs(sat - 0.4) / 0.45) * Math.min(1, ((r - g) / ((g - b) + 1e-4)) * 0.8);
}

// Applies filter `id` at `amount` (0..1) to the float RGB buffer in place.
export function applyFilter(o, w, h, id, amount) {
  const f = FILTERS.find((x) => x.id === id);
  if (!f || amount <= 0) return;
  const [tr, tg, tb] = compile(f);
  const lo = f.lo ?? [0, 0, 0], hi = f.hi ?? [0, 0, 0];
  const sat = f.sat ?? 0, vib = f.vibrance ?? 0, skinKeep = f.skin ?? 0, vig = f.vignette ?? 0;
  const cx = w / 2, cy = h / 2, rr = 1 / Math.hypot(cx, cy);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const j = (y * w + x) * 3;
      const r0 = clamp01(o[j]), g0 = clamp01(o[j + 1]), b0 = clamp01(o[j + 2]);
      let r = lut(tr, r0), g = lut(tg, g0), b = lut(tb, b0);
      const l = lum(r, g, b);
      if (f.mono) {
        r = g = b = l;
      } else {
        // Split toning, eased off on skin so faces keep a natural colour.
        const keep = skinKeep ? 1 - skinKeep * skinness(r0, g0, b0) : 1;
        const ws = (1 - l) * (1 - l) * keep, wh = l * l * keep;
        r += lo[0] * ws + hi[0] * wh;
        g += lo[1] * ws + hi[1] * wh;
        b += lo[2] * ws + hi[2] * wh;
        const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
        // Vibrance boosts dull colours more than saturated ones and spares skin.
        const k = 1 + sat + vib * (1 - Math.min(1, (mx - mn) * 2.2)) * (1 - 0.8 * skinness(r0, g0, b0));
        const l2 = lum(r, g, b);
        r = l2 + (r - l2) * k; g = l2 + (g - l2) * k; b = l2 + (b - l2) * k;
      }
      if (vig) {
        const d = Math.hypot(x - cx, y - cy) * rr;
        const v = 1 - vig * Math.min(1, Math.max(0, (d - 0.45) / 0.6)) ** 2;
        r *= v; g *= v; b *= v;
      }
      o[j] = r0 + (r - r0) * amount;
      o[j + 1] = g0 + (g - g0) * amount;
      o[j + 2] = b0 + (b - b0) * amount;
    }
  }
}
