// Turns landmarks + segmentation into everything the renderer needs:
// soft region masks, a pre-blurred copy for skin smoothing, reference
// luminances and the geometry used by the face-shape warps.
import * as L from './landmarks.js';
import { blur, circleMask, dilate, meanLum, polygonMask } from './imageops.js';

const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
const mul = (a, k) => [a[0] * k, a[1] * k];
const len = (a) => Math.hypot(a[0], a[1]);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const norm = (a) => mul(a, 1 / (len(a) || 1));

function polylineAt(pts, t) {
  const f = t * (pts.length - 1);
  const i = Math.min(pts.length - 2, Math.floor(f));
  return lerp(pts[i], pts[i + 1], f - i);
}

function combine(a, b, fn) {
  for (let i = 0; i < a.length; i++) a[i] = fn(a[i], b[i]);
  return a;
}

// Global analysis (hair) plus one entry per detected face.
export function analyze(rgb, w, h, det) {
  const A = { w, h, rgb, hair: null, faces: [] };
  if (det.hair) {
    A.hair = blur(det.hair, w, h, Math.max(1, Math.min(w, h) / 600));
    A.hairMeanL = meanLum(rgb, A.hair, 0.6);
  }
  A.faces = det.faces.map((lm) => analyzeFace(rgb, w, h, lm, det.faceSkin));
  if (A.hair && A.faces.length) {
    splitHair(A);
    A.hair = null; // only needed when no face was found; frees memory
  }
  return A;
}

// Give every face its own hair mask. Each hair pixel is shared between faces
// by inverse distance to the head (scaled by face size, raised to a high
// power), so touching hair of two people splits with a soft seam.
function splitHair(A) {
  const { w, h, rgb, hair } = A;
  const heads = A.faces.map((F) => {
    const [x0, y0, x1, y1] = F.tight;
    return [(x0 + x1) / 2 - F.down[0] * F.fw * 0.2, (y0 + y1) / 2 - F.down[1] * F.fw * 0.2, F.fw];
  });
  const weight = (x, y, i) => {
    let own = 0, sum = 0;
    for (let k = 0; k < heads.length; k++) {
      const [cx, cy, fw] = heads[k];
      const d = Math.max(0.05, Math.hypot(x - cx, y - cy) / fw);
      const v = d > 4 ? 0 : 1 / d ** 8;
      sum += v;
      if (k === i) own = v;
    }
    return sum ? own / sum : 0;
  };
  A.faces.forEach((F, i) => {
    const [x0, y0, x1, y1] = F.tight;
    const fw = F.fw;
    const box = [Math.max(0, Math.floor(x0 - fw * 1.2)), Math.max(0, Math.floor(y0 - fw * 1.0)),
      Math.min(w, Math.ceil(x1 + fw * 1.2)), Math.min(h, Math.ceil(y1 + fw * 2.5))];
    const bw = box[2] - box[0], bh = box[3] - box[1];
    const m = new Float32Array(bw * bh);
    let s = 0, n = 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        const gi = (y + box[1]) * w + x + box[0];
        const v = hair[gi];
        if (v < 0.02) continue;
        const k = v * weight(x + box[0], y + box[1], i);
        m[y * bw + x] = k;
        if (k > 0.6) { s += 0.3 * rgb[gi * 3] + 0.59 * rgb[gi * 3 + 1] + 0.11 * rgb[gi * 3 + 2]; n++; }
      }
    }
    F.hair = n > 30 ? { box, bw, bh, mask: m, meanL: s / n } : null;
  });
}

// All masks of a face live in a local box around it (`F.box`, size bw×bh),
// so group photos stay cheap in memory and rendering only touches that area.
function analyzeFace(rgb, w, h, pts, faceSkin) {
  const pt = (i) => pts[i];
  const fw = len(sub(pt(L.P.faceL), pt(L.P.faceR)));
  const down = norm(sub(pt(L.P.chin), pt(L.P.forehead)));
  const right = [down[1], -down[0]]; // perpendicular to the face axis

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const tight = [x0, y0, x1, y1];
  const pad = fw * 0.35;
  const box = [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)),
    Math.min(w, Math.ceil(x1 + pad)), Math.min(h, Math.ceil(y1 + pad))];
  const [bx, by] = box;
  const bw = box[2] - bx, bh = box[3] - by;

  // Local copies: landmarks, pixels and face-skin confidence.
  const lp = pts.map(([x, y]) => [x - bx, y - by]);
  const lpt = (i) => lp[i];
  const poly = (idx) => idx.map(lpt);
  const n = bw * bh;
  const crop = new Float32Array(n * 3);
  const fs = faceSkin ? new Float32Array(n) : null;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      const li = y * bw + x, gi = (y + by) * w + x + bx;
      crop[li * 3] = rgb[gi * 3];
      crop[li * 3 + 1] = rgb[gi * 3 + 1];
      crop[li * 3 + 2] = rgb[gi * 3 + 2];
      if (fs) fs[li] = faceSkin[gi];
    }
  }

  const F = { pts, fw, down, right, box, bw, bh, tight };

  // --- base regions --------------------------------------------------------
  const oval = polygonMask([poly(L.FACE_OVAL)], bw, bh, fw * 0.015);
  F.ovalPoly = L.FACE_OVAL.map(pt);
  const eyesHard = polygonMask([poly(L.EYE_R), poly(L.EYE_L)], bw, bh, 0.6);
  const eyesDil = dilate(Float32Array.from(eyesHard), bw, bh, fw * 0.025);
  const browsDil = dilate(polygonMask([poly(L.BROW_R), poly(L.BROW_L)], bw, bh), bw, bh, fw * 0.02);
  const lipsOuter = polygonMask([poly(L.LIPS_OUTER)], bw, bh, fw * 0.004);
  const mouthInner = polygonMask([poly(L.LIPS_INNER)], bw, bh, fw * 0.003);
  const lipsDil = dilate(Float32Array.from(lipsOuter), bw, bh, fw * 0.02);
  const nostrils = dilate(
    circleMask([
      [...lerp(lpt(L.P.noseWingR), lpt(L.P.noseBottom), 0.45), fw * 0.025],
      [...lerp(lpt(L.P.noseWingL), lpt(L.P.noseBottom), 0.45), fw * 0.025],
    ], bw, bh), bw, bh, fw * 0.01);

  // Skin = face oval without eyes, brows, lips and nostrils; trimmed by the
  // segmenter's face-skin class so hair over the forehead stays untouched.
  const skin = new Float32Array(n);
  if (fs) blur(fs, bw, bh, fw * 0.01);
  for (let i = 0; i < n; i++) {
    let m = oval[i] * (1 - eyesDil[i]) * (1 - browsDil[i]) * (1 - lipsDil[i]) * (1 - nostrils[i]);
    if (fs) m *= Math.min(1, fs[i] * 1.4);
    skin[i] = m;
  }
  F.skin = skin;

  F.lips = combine(Float32Array.from(lipsOuter), mouthInner, (a, b) => Math.max(0, a - b));
  F.lipsMeanL = meanLum(crop, F.lips, 0.6);
  F.mouthInner = mouthInner;

  // --- irises: circle clipped by the eye opening, pupil kept dark ----------
  const irisLocal = [L.IRIS_R, L.IRIS_L].map((idx) => {
    const c = lpt(idx[0]);
    const r = idx.slice(1).reduce((s, i) => s + len(sub(lpt(i), c)), 0) / 4;
    return [c[0], c[1], r];
  });
  const iris = circleMask(irisLocal, bw, bh, 0.8);
  const pupils = circleMask(irisLocal.map(([x, y, r]) => [x, y, r * 0.38]), bw, bh, irisLocal[0][2] * 0.12);
  for (let i = 0; i < n; i++) iris[i] *= eyesHard[i] * (1 - pupils[i]);
  F.iris = iris;
  F.irisMeanL = meanLum(crop, iris, 0.5);
  F.irisCircles = irisLocal.map(([x, y, r]) => [x + bx, y + by, r]); // image coords for warps

  // --- eyeshadow: band between upper lid and brow ---------------------------
  const shadowPolys = [[L.LID_R, L.BROW_LOWER_R], [L.LID_L, L.BROW_LOWER_L]].map(([lid, brow]) => {
    const lidPts = poly(lid), browPts = poly(brow);
    const top = lidPts.map((p, i) => lerp(p, polylineAt(browPts, i / (lidPts.length - 1)), 0.55));
    return [...lidPts, ...top.reverse()];
  });
  const shadow = polygonMask(shadowPolys, bw, bh, fw * 0.02);
  for (let i = 0; i < n; i++) shadow[i] *= 1 - eyesHard[i];
  F.shadow = shadow;

  // --- blush: soft discs on the cheek apples --------------------------------
  const cheekR = lerp(lpt(L.P.cheekR), lpt(L.P.faceR), 0.15);
  const cheekL = lerp(lpt(L.P.cheekL), lpt(L.P.faceL), 0.15);
  const blush = circleMask([[...cheekR, fw * 0.09], [...cheekL, fw * 0.09]], bw, bh, fw * 0.06);
  for (let i = 0; i < n; i++) blush[i] *= skin[i];
  F.blush = blush;

  // --- eyes: whites and irises for "Leuchten" ------------------------------
  F.eyes = eyesHard;
  F.cheekL = meanLum(crop, blush, 0.3) || meanLum(crop, skin, 0.6);

  // --- under-eye band for "Augenringe" --------------------------------------
  const underPolys = [L.LOWER_LID_R, L.LOWER_LID_L].map((idx) => {
    const lid = poly(idx);
    const k = lid.length - 1;
    const low = lid.map((p, i) => add(p, mul(down, fw * (0.03 + 0.11 * Math.sin((Math.PI * i) / k)))));
    return [...lid, ...low.reverse()];
  });
  const under = polygonMask(underPolys, bw, bh, fw * 0.03);
  for (let i = 0; i < n; i++) under[i] *= skin[i];
  F.underEye = under;

  // --- frequency bands for texture-preserving smoothing ---------------------
  // blurS keeps pores and fine texture (img - blurS), blurL holds the shape
  // and shading; blemishes and unevenness live in between (blurS - blurL).
  const bands = (radius) => {
    const chans = [0, 1, 2].map((c) => {
      const a = new Float32Array(n);
      for (let i = 0; i < n; i++) a[i] = crop[i * 3 + c];
      return blur(a, bw, bh, radius);
    });
    const out = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      out[i * 3] = chans[0][i];
      out[i * 3 + 1] = chans[1][i];
      out[i * 3 + 2] = chans[2][i];
    }
    return out;
  };
  F.blurS = bands(Math.max(1, fw / 220));
  F.blurL = bands(Math.max(3, fw / 26));
  return F;
}
