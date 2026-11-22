// Applies the current settings to the analysed photo and returns RGBA bytes.
// Face effects run per face inside that face's local box; hair colour and
// light are global.
import { clamp01, hexToRgb, lum, setLum, smoothstep } from './imageops.js';
import { beardLayer } from './beard.js';
import { applyWarps, buildWarps } from './warp.js';
import { applyPushes, areaMask } from './local.js';

export const FACE_DEFAULTS = {
  smooth: 0, glow: 0, teeth: 0,
  lip: 0, lipColor: '#b3263e',
  blush: 0, blushColor: '#e0707a',
  shadow: 0, shadowColor: '#7a5a8c',
  iris: 0, irisColor: '#3d8fd1',
  eyeSize: 0,
  hair: 0, hairColor: '#d9b26f',
  beard: 0, beardColor: '#3a2a20',
  slim: 0, nose: 0, smile: 0, chin: 0,
};

export const GLOBAL_DEFAULTS = {
  hair: 0, hairColor: '#d9b26f',
  brightness: 0, contrast: 0, saturation: 0, warmth: 0,
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
  if (s.smooth) {
    const b = F.smooth;
    eachInBox(F, w, (li, gi) => {
      const m = F.skin[li];
      if (m < 0.004) return;
      const j = gi * 3, k3 = li * 3;
      const dr = b[k3] - o[j], dg = b[k3 + 1] - o[j + 1], db = b[k3 + 2] - o[j + 2];
      const d = Math.abs(lum(dr, dg, db));
      const k = m * s.smooth * 0.95 * Math.exp(-(d * d) / 0.006);
      o[j] += dr * k;
      o[j + 1] += dg * k;
      o[j + 2] += db * k;
    });
  }
  if (s.glow) {
    eachInBox(F, w, (li, gi) => {
      const m = F.skin[li] * s.glow * 0.22;
      if (m < 0.002) return;
      const j = gi * 3;
      o[j] += (1 - o[j]) * m;
      o[j + 1] += (1 - o[j + 1]) * m * 0.97;
      o[j + 2] += (1 - o[j + 2]) * m * 0.95;
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

  if (F.beardLayer && s.beard) {
    // Darker skin under the stubble, then the hairs themselves.
    tintFace(o, F, w, F.beard, s.beardColor, s.beard * s.beard * 0.18);
    const layer = beardLayer(F.beardLayer, F.bw, F.bh, s.beard, s.beardColor);
    eachInBox(F, w, (li, gi) => {
      const a = layer[li * 4 + 3];
      if (!a) return;
      const j = gi * 3;
      o[j] = o[j] * (1 - a) + layer[li * 4];
      o[j + 1] = o[j + 1] * (1 - a) + layer[li * 4 + 1];
      o[j + 2] = o[j + 2] * (1 - a) + layer[li * 4 + 2];
    });
  }
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

  // Global light & colour.
  if (g.brightness || g.contrast || g.saturation || g.warmth) {
    const b = g.brightness * 0.2, k = 1 + g.contrast * 0.6, sat = 1 + g.saturation, t = g.warmth * 0.07;
    for (let i = 0; i < n; i++) {
      const j = i * 3;
      tmpC[0] = o[j] + b + t;
      tmpC[1] = o[j + 1] + b + t * 0.15;
      tmpC[2] = o[j + 2] + b - t;
      const l = lum(tmpC[0], tmpC[1], tmpC[2]);
      for (let c = 0; c < 3; c++) o[j + c] = (l + (tmpC[c] - l) * sat - 0.5) * k + 0.5;
    }
  }

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
