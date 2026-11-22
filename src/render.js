// Applies the current settings to the analysed photo and returns RGBA bytes.
import { clamp01, hexToRgb, lum, setLum, smoothstep } from './imageops.js';
import { beardLayer } from './beard.js';
import { applyWarps, buildWarps } from './warp.js';

const tmp = [0, 0, 0];
const tmpC = [0, 0, 0];

// Recolour a region while keeping its shading: luminance is remapped with a
// power curve so the region's average brightness moves toward the target's.
function recolor(o, mask, hex, amount, meanL, adapt) {
  if (!amount || !mask) return;
  const col = hexToRgb(hex);
  const targetL = lum(col[0], col[1], col[2]);
  const want = Math.min(0.92, Math.max(0.04, meanL + (targetL - meanL) * adapt));
  const m0 = Math.min(0.95, Math.max(0.03, meanL));
  const gamma = Math.min(3, Math.max(0.3, Math.log(want) / Math.log(m0)));
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] * amount;
    if (m < 0.004) continue;
    const j = i * 3;
    const l = Math.pow(clamp01(lum(o[j], o[j + 1], o[j + 2])), gamma);
    setLum(col, l, tmp);
    o[j] += (tmp[0] - o[j]) * m;
    o[j + 1] += (tmp[1] - o[j + 1]) * m;
    o[j + 2] += (tmp[2] - o[j + 2]) * m;
  }
}

// Tint by multiplying with the colour (darkens like real pigment).
function multiplyTint(o, mask, hex, amount) {
  if (!amount || !mask) return;
  const c = hexToRgb(hex);
  for (let i = 0; i < mask.length; i++) {
    const m = mask[i] * amount;
    if (m < 0.004) continue;
    const j = i * 3;
    o[j] *= 1 - m * (1 - c[0]);
    o[j + 1] *= 1 - m * (1 - c[1]);
    o[j + 2] *= 1 - m * (1 - c[2]);
  }
}

export const DEFAULTS = {
  smooth: 0, glow: 0, teeth: 0,
  lip: 0, lipColor: '#b3263e',
  blush: 0, blushColor: '#e0707a',
  shadow: 0, shadowColor: '#7a5a8c',
  iris: 0, irisColor: '#3d8fd1',
  eyeSize: 0,
  hair: 0, hairColor: '#d9b26f',
  beard: 0, beardColor: '#3a2a20',
  slim: 0, nose: 0, smile: 0, chin: 0,
  brightness: 0, contrast: 0, saturation: 0, warmth: 0,
};

export function render(A, settings) {
  const s = {};
  for (const [k, v] of Object.entries(settings)) s[k] = typeof v === 'number' ? v / 100 : v;
  const { w, h } = A;
  const n = w * h;
  const o = Float32Array.from(A.rgb);
  const F = A.face;

  if (F) {
    // Skin: edge-aware smoothing toward the pre-blurred copy.
    if (s.smooth) {
      const b = F.smooth;
      for (let i = 0; i < n; i++) {
        const m = F.skin[i];
        if (m < 0.004) continue;
        const j = i * 3;
        const dr = b[j] - o[j], dg = b[j + 1] - o[j + 1], db = b[j + 2] - o[j + 2];
        const d = Math.abs(lum(dr, dg, db));
        const k = m * s.smooth * 0.95 * Math.exp(-(d * d) / 0.006);
        o[j] += dr * k;
        o[j + 1] += dg * k;
        o[j + 2] += db * k;
      }
    }
    if (s.glow) {
      for (let i = 0; i < n; i++) {
        const m = F.skin[i] * s.glow * 0.22;
        if (m < 0.002) continue;
        const j = i * 3;
        o[j] += (1 - o[j]) * m;
        o[j + 1] += (1 - o[j + 1]) * m * 0.97;
        o[j + 2] += (1 - o[j + 2]) * m * 0.95;
      }
    }
    if (s.teeth) {
      for (let i = 0; i < n; i++) {
        const mi = F.mouthInner[i];
        if (mi < 0.01) continue;
        const j = i * 3;
        const l = lum(o[j], o[j + 1], o[j + 2]);
        const m = mi * s.teeth * smoothstep(0.25, 0.5, l);
        for (let c = 0; c < 3; c++) {
          let v = l + (o[j + c] - l) * (1 - 0.75 * m);
          o[j + c] = v + (1 - v) * 0.18 * m;
        }
      }
    }
    multiplyTint(o, F.shadow, s.shadowColor, s.shadow * 0.75);
    multiplyTint(o, F.blush, s.blushColor, s.blush * 0.55);
    recolor(o, F.lips, s.lipColor, s.lip * 0.9, F.lipsMeanL, 0.55);
    recolor(o, F.iris, s.irisColor, s.iris * 0.85, F.irisMeanL, 0.6);
  }

  recolor(o, A.hair, s.hairColor, s.hair * 0.9, A.hairMeanL ?? 0.3, 0.85);

  if (F && F.beardLayer && s.beard) {
    // Darker skin under the stubble, then the hairs themselves.
    multiplyTint(o, F.beard, s.beardColor, s.beard * s.beard * 0.18);
    const layer = beardLayer(F.beardLayer, w, h, s.beard, s.beardColor);
    for (let i = 0; i < n; i++) {
      const a = layer[i * 4 + 3];
      if (!a) continue;
      const j = i * 3;
      o[j] = o[j] * (1 - a) + layer[i * 4];
      o[j + 1] = o[j + 1] * (1 - a) + layer[i * 4 + 1];
      o[j + 2] = o[j + 2] * (1 - a) + layer[i * 4 + 2];
    }
  }

  // Global light & colour.
  if (s.brightness || s.contrast || s.saturation || s.warmth) {
    const b = s.brightness * 0.2, k = 1 + s.contrast * 0.6, sat = 1 + s.saturation, t = s.warmth * 0.07;
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

  if (F) {
    const ops = buildWarps(F, s);
    if (ops.length) out = applyWarps(out, w, h, ops, F.box);
  }
  return out;
}
