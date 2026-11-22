// Low-level pixel helpers. Colours are handled as floats in 0..1.

export const lum = (r, g, b) => 0.3 * r + 0.59 * g + 0.11 * b;

export function hexToRgb(hex) {
  const v = parseInt(hex.replace('#', ''), 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255];
}

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

export function smoothstep(a, b, x) {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}

// W3C "color" blend helper: give colour c the luminance l, then clip into gamut.
export function setLum(c, l, out) {
  const d = l - lum(c[0], c[1], c[2]);
  let r = c[0] + d, g = c[1] + d, b = c[2] + d;
  const L = lum(r, g, b);
  const n = Math.min(r, g, b), x = Math.max(r, g, b);
  if (n < 0) {
    const k = L / (L - n);
    r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
  }
  if (x > 1) {
    const k = (1 - L) / (x - L);
    r = L + (r - L) * k; g = L + (g - L) * k; b = L + (b - L) * k;
  }
  out[0] = r; out[1] = g; out[2] = b;
  return out;
}

function boxH(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[row + Math.min(w - 1, Math.max(0, i))];
    for (let x = 0; x < w; x++) {
      dst[row + x] = sum * inv;
      sum += src[row + Math.min(w - 1, x + r + 1)] - src[row + Math.max(0, x - r)];
    }
  }
}

function boxV(src, dst, w, h, r) {
  const inv = 1 / (2 * r + 1);
  for (let x = 0; x < w; x++) {
    let sum = 0;
    for (let i = -r; i <= r; i++) sum += src[Math.min(h - 1, Math.max(0, i)) * w + x];
    for (let y = 0; y < h; y++) {
      dst[y * w + x] = sum * inv;
      sum += src[Math.min(h - 1, y + r + 1) * w + x] - src[Math.max(0, y - r) * w + x];
    }
  }
}

// Approximate Gaussian blur (three box passes) of a single-channel float image, in place.
export function blur(a, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const tmp = new Float32Array(a.length);
  for (let i = 0; i < 3; i++) {
    boxH(a, tmp, w, h, r);
    boxV(tmp, a, w, h, r);
  }
  return a;
}

// Grow a hard mask by roughly `radius` pixels with a soft edge.
export function dilate(a, w, h, radius) {
  blur(a, w, h, radius);
  for (let i = 0; i < a.length; i++) a[i] = Math.min(1, a[i] * 2);
  return a;
}

let scratch;
function scratchCtx(w, h) {
  if (!scratch) scratch = document.createElement('canvas');
  if (scratch.width !== w || scratch.height !== h) {
    scratch.width = w;
    scratch.height = h;
  }
  const ctx = scratch.getContext('2d', { willReadFrequently: true });
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#fff';
  return ctx;
}

function readAlpha(ctx, w, h) {
  const d = ctx.getImageData(0, 0, w, h).data;
  const m = new Float32Array(w * h);
  for (let i = 0; i < m.length; i++) m[i] = d[i * 4 + 3] / 255;
  return m;
}

// Rasterise one or more closed polygons ([[x,y],...]) to a float mask.
export function polygonMask(polys, w, h, feather = 0) {
  const ctx = scratchCtx(w, h);
  ctx.beginPath();
  for (const poly of polys) {
    poly.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
  }
  ctx.fill();
  const m = readAlpha(ctx, w, h);
  return feather > 0 ? blur(m, w, h, feather) : m;
}

export function circleMask(circles, w, h, feather = 0) {
  const ctx = scratchCtx(w, h);
  ctx.beginPath();
  for (const [x, y, r] of circles) {
    ctx.moveTo(x + r, y);
    ctx.arc(x, y, r, 0, Math.PI * 2);
  }
  ctx.fill();
  const m = readAlpha(ctx, w, h);
  return feather > 0 ? blur(m, w, h, feather) : m;
}

// Mean luminance of the pixels where the mask is mostly on.
export function meanLum(rgb, mask, threshold = 0.5) {
  let s = 0, n = 0;
  for (let i = 0; i < mask.length; i++) {
    if (mask[i] < threshold) continue;
    s += lum(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    n++;
  }
  return n ? s / n : 0.4;
}

// Deterministic PRNG so the generated stubble stays put between renders.
export function mulberry32(seed) {
  return function () {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
