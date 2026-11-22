// Applies the current settings to the analysed photo and returns RGBA bytes.
// Face effects run per face inside that face's local box; hair colour and
// light are global.
import { clamp01, hexToRgb, lum, setLum, smoothstep } from './imageops.js';
import { applyWarps, buildWarps } from './warp.js';
import { applyPushes, areaMask } from './local.js';
import { applyFilter, skinness } from './filters.js';

export const FACE_DEFAULTS = {
  smooth: 0, glow: 0, underEye: 0, teeth: 0,
  eyesBright: 0,
  lip: 0, lipColor: '#b3263e',
  blush: 0, blushColor: '#e0707a',
  shadow: 0, shadowColor: '#7a5a8c',
  iris: 0, irisColor: '#3d8fd1',
  eyeSize: 0,
  hair: 0, hairColor: '#d9b26f',
  slim: 0, nose: 0, smile: 0, chin: 0,
};

export const GLOBAL_DEFAULTS = {
  hair: 0, hairColor: '#d9b26f',
  brightness: 0, contrast: 0, saturation: 0, warmth: 0,
  filter: null, filterStrength: 0,
};

export const isFaceKey = (k) => k in FACE_DEFAULTS;

// `areas[i]` holds the painted strokes that limit face i's effects,
// `pushes` the free warps from the "Verformen" tool (see local.js).
export function newState(A) {
  return {
    global: { ...GLOBAL_DEFAULTS },
    faces: A.faces.map(() => ({ ...FACE_DEFAULTS })),
    areas: A.faces.map(() => []),
    pushes: [],
  };
}

// Older saved edits predate local edits.
export function upgradeState(st, A) {
  st.global = { ...GLOBAL_DEFAULTS, ...st.global };
  // The beard tool was removed; drop its leftover settings.
  st.faces = st.faces.map(({ beard, beardColor, ...f }) => ({ ...FACE_DEFAULTS, ...f }));
  st.areas ??= A.faces.map(() => []);
  st.pushes ??= [];
  return st;
}

// Face effects limited to a painted area: render them, then blend back to
// the untouched pixels outside the area.
function renderFaceInArea(o, F, w, s, area) {
  const { box, bw, bh, m } = area;
  const before = new Float32Array(bw * bh * 3);
  for (let y = 0; y < bh; y++) {
    const g = ((y + box[1]) * w + box[0]) * 3;
    before.set(o.subarray(g, g + bw * 3), y * bw * 3);
  }
  renderFace(o, F, w, s);
  for (let y = 0; y < bh; y++) {
    const g = ((y + box[1]) * w + box[0]) * 3;
    for (let x = 0; x < bw; x++) {
      const k = m[y * bw + x];
      if (k >= 0.999) continue;
      const j = g + x * 3, b = (y * bw + x) * 3;
      for (let c = 0; c < 3; c++) o[j + c] = before[b + c] + (o[j + c] - before[b + c]) * k;
    }
  }
}

const tmp = [0, 0, 0];
const tmpC = [0, 0, 0];

// Index mapping from a local box (box, bw, bh) into the full image.
function eachInBox(F, w, fn) {
  const [bx, by] = F.box;
  for (let y = 0; y < F.bh; y++) {
    const row = y * F.bw, g = (y + by) * w + bx;
    for (let x = 0; x < F.bw; x++) fn(row + x, g + x);
  }
}

// Recolour a region while keeping its shading: luminance is remapped with a
// power curve so the region's average brightness moves toward the target's.
function recolorPx(o, j, m, col, gamma) {
  const l = Math.pow(clamp01(lum(o[j], o[j + 1], o[j + 2])), gamma);
  setLum(col, l, tmp);
  o[j] += (tmp[0] - o[j]) * m;
  o[j + 1] += (tmp[1] - o[j + 1]) * m;
  o[j + 2] += (tmp[2] - o[j + 2]) * m;
}

function recolorParams(hex, meanL, adapt) {
  const col = hexToRgb(hex);
  const targetL = lum(col[0], col[1], col[2]);
  const want = Math.min(0.92, Math.max(0.04, meanL + (targetL - meanL) * adapt));
  const m0 = Math.min(0.95, Math.max(0.03, meanL));
  return [col, Math.min(3, Math.max(0.3, Math.log(want) / Math.log(m0)))];
}

function recolorFace(o, F, w, mask, hex, amount, meanL, adapt) {
  if (!amount) return;
  const [col, gamma] = recolorParams(hex, meanL, adapt);
  eachInBox(F, w, (li, gi) => {
    const m = mask[li] * amount;
    if (m >= 0.004) recolorPx(o, gi * 3, m, col, gamma);
  });
}

// Tint by multiplying with the colour (darkens like real pigment).
function tintFace(o, F, w, mask, hex, amount) {
  if (!amount) return;
  const c = hexToRgb(hex);
  eachInBox(F, w, (li, gi) => {
    const m = mask[li] * amount;
    if (m < 0.004) return;
    const j = gi * 3;
    o[j] *= 1 - m * (1 - c[0]);
    o[j + 1] *= 1 - m * (1 - c[1]);
    o[j + 2] *= 1 - m * (1 - c[2]);
  });
}

function scale(settings) {
  const s = {};
  for (const [k, v] of Object.entries(settings)) s[k] = typeof v === 'number' ? v / 100 : v;
  return s;
}

function renderFace(o, F, w, s) {
  // Frequency separation: blemishes and blotches (mid band) are flattened,
  // pores and fine texture (high band) stay, so skin doesn't turn to wax.
  // Strong mid-band edges (nostrils, deep shadows) are protected.
  if (s.smooth) {
    const S = F.blurS, Lg = F.blurL;
    eachInBox(F, w, (li, gi) => {
      const m = F.skin[li];
      if (m < 0.004) return;
      const j = gi * 3, k3 = li * 3;
      const a = m * s.smooth;
      const mr = S[k3] - Lg[k3], mg = S[k3 + 1] - Lg[k3 + 1], mb = S[k3 + 2] - Lg[k3 + 2];
      const ml = lum(mr, mg, mb);
      const guard = Math.exp(-(ml * ml) / 0.012);
      const kMid = a * 0.92 * guard, kFine = a * 0.18;
      o[j] -= mr * kMid + (o[j] - S[k3]) * kFine;
      o[j + 1] -= mg * kMid + (o[j + 1] - S[k3 + 1]) * kFine;
      o[j + 2] -= mb * kMid + (o[j + 2] - S[k3 + 2]) * kFine;
    });
  }
  // Under-eye: lift the low-frequency darkness toward the cheek brightness;
  // texture rides along untouched.
  if (s.underEye) {
    const Lg = F.blurL, ref = F.cheekL;
    eachInBox(F, w, (li, gi) => {
      const m = F.underEye[li];
      if (m < 0.004) return;
      const k3 = li * 3, j = gi * 3;
      const l = lum(Lg[k3], Lg[k3 + 1], Lg[k3 + 2]);
      if (l >= ref || l <= 0.01) return;
      const k = Math.min(1.6, ref / l) - 1;
      const a = m * s.underEye * 0.85 * k;
      // Also pull the bluish/purple cast toward neutral skin.
      const avg = (Lg[k3] + Lg[k3 + 1] + Lg[k3 + 2]) / 3;
      o[j] += Lg[k3] * a;
      o[j + 1] += Lg[k3 + 1] * a;
      o[j + 2] += Lg[k3 + 2] * a - Math.max(0, Lg[k3 + 2] - avg) * m * s.underEye * 0.5;
    });
  }
  // Glow: luminance-only highlight lift, so skin gets brighter without
  // shifting toward orange.
  if (s.glow) {
    eachInBox(F, w, (li, gi) => {
      const m = F.skin[li];
      if (m < 0.004) return;
      const j = gi * 3;
      const l = lum(o[j], o[j + 1], o[j + 2]);
      if (l <= 0.01) return;
      const lift = m * s.glow * 0.16 * (1 - l) * smoothstep(0.1, 0.65, l);
      const k = (l + lift) / l;
      o[j] *= k;
      o[j + 1] *= k;
      o[j + 2] *= k;
    });
  }
  // Eyes: brighten and slightly neutralise the whites, add crispness to the iris.
  if (s.eyesBright) {
    const S = F.blurS;
    eachInBox(F, w, (li, gi) => {
      const e = F.eyes[li];
      if (e < 0.01) return;
      const j = gi * 3, k3 = li * 3;
      const a = e * s.eyesBright;
      const ir = F.iris[li];
      // Gentle local contrast on the iris only; lashes and lids stay as they are.
      const sh = a * ir * 0.45;
      if (sh > 0.002) for (let c = 0; c < 3; c++) o[j + c] += (o[j + c] - S[k3 + c]) * sh;
      const l = lum(o[j], o[j + 1], o[j + 2]);
      const white = a * (1 - ir) * smoothstep(0.28, 0.6, l);
      for (let c = 0; c < 3; c++) {
        const v = l + (o[j + c] - l) * (1 - 0.5 * white);
        o[j + c] = v + (1 - v) * 0.22 * white;
      }
    });
  }
  if (s.teeth) {
    eachInBox(F, w, (li, gi) => {
      const mi = F.mouthInner[li];
      if (mi < 0.01) return;
      const j = gi * 3;
      const l = lum(o[j], o[j + 1], o[j + 2]);
      const m = mi * s.teeth * smoothstep(0.25, 0.5, l);
      for (let c = 0; c < 3; c++) {
        const v = l + (o[j + c] - l) * (1 - 0.75 * m);
        o[j + c] = v + (1 - v) * 0.18 * m;
      }
    });
  }
  tintFace(o, F, w, F.shadow, s.shadowColor, s.shadow * 0.75);
  tintFace(o, F, w, F.blush, s.blushColor, s.blush * 0.55);
  recolorFace(o, F, w, F.lips, s.lipColor, s.lip * 0.9, F.lipsMeanL, 0.55);
  recolorFace(o, F, w, F.iris, s.irisColor, s.iris * 0.85, F.irisMeanL, 0.6);

  if (F.hair && s.hair) recolorFace(o, F.hair, w, F.hair.mask, s.hairColor, s.hair * 0.9, F.hair.meanL, 0.85);
}

export function render(A, state) {
  const { w, h } = A;
  const n = w * h;
  const o = Float32Array.from(A.rgb);
  const g = scale(state.global);
  const faces = state.faces.map(scale);

  A.faces.forEach((F, i) => {
    const area = areaMask(F, state.areas?.[i], w);
    if (area && !area.empty) renderFaceInArea(o, F, w, faces[i], area);
    else renderFace(o, F, w, faces[i]);
  });

  // Without any detected face, hair colour applies to the whole photo.
  if (!A.faces.length && A.hair && g.hair) {
    const [col, gamma] = recolorParams(g.hairColor, A.hairMeanL ?? 0.3, 0.85);
    const amount = g.hair * 0.9;
    for (let i = 0; i < n; i++) {
      const m = A.hair[i] * amount;
      if (m >= 0.004) recolorPx(o, i * 3, m, col, gamma);
    }
  }

  // Global light & colour. Warmth is a white-balance shift (multiplies
  // channels), brightness a gamma lift, contrast a gentle S-curve and positive
  // saturation acts like vibrance; none of them clip hard.
  if (g.brightness || g.contrast || g.saturation || g.warmth) {
    const gamma = Math.pow(2, -g.brightness * 0.6);
    const c = g.contrast * 0.9;
    const wr = 1 + g.warmth * 0.1, wg = 1 + g.warmth * 0.015, wb = 1 - g.warmth * 0.12;
    const sat = g.saturation;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      for (let k = 0; k < 3; k++) {
        let x = clamp01(o[j + k] * (k === 0 ? wr : k === 1 ? wg : wb));
        if (gamma !== 1) x = Math.pow(x, gamma);
        if (c) x += c * 2 * x * (1 - x) * (x - 0.5) * (c > 0 ? 1 : 1.6);
        o[j + k] = x;
      }
      if (sat) {
        const r = o[j], gg = o[j + 1], b = o[j + 2];
        const l = lum(r, gg, b);
        const chroma = Math.max(r, gg, b) - Math.min(r, gg, b);
        const k = sat > 0 ? 1 + sat * (1 - Math.min(1, chroma * 1.8)) * (1 - 0.7 * skinness(r, gg, b)) : 1 + sat;
        o[j] = l + (r - l) * k;
        o[j + 1] = l + (gg - l) * k;
        o[j + 2] = l + (b - l) * k;
      }
    }
  }

  if (g.filter && g.filterStrength) applyFilter(o, w, h, g.filter, g.filterStrength);

  let out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    out[i * 4] = o[i * 3] * 255;
    out[i * 4 + 1] = o[i * 3 + 1] * 255;
    out[i * 4 + 2] = o[i * 3 + 2] * 255;
    out[i * 4 + 3] = 255;
  }

  A.faces.forEach((F, i) => {
    const ops = buildWarps(F, faces[i]);
    if (ops.length) out = applyWarps(out, w, h, ops, F.box);
  });
  return applyPushes(out, w, h, state.pushes);
}
