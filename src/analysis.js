// Turns landmarks + segmentation into everything the renderer needs:
// soft region masks, a pre-blurred copy for skin smoothing, reference
// luminances and the geometry used by the face-shape warps.
import * as L from './landmarks.js';
import { blur, circleMask, dilate, meanLum, polygonMask } from './imageops.js';
import { buildBeard } from './beard.js';

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
  return A;
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

  // --- beard region ---------------------------------------------------------
  const drop = mul(down, fw * 0.16);
  const beardPoly = [
    ...poly(L.LOWER_OVAL),
    add(lerp(lpt(L.P.faceR), lpt(L.P.noseWingR), 0.4), drop),
    lpt(L.P.noseWingR),
    lpt(L.P.noseBottom),
    lpt(L.P.noseWingL),
    add(lerp(lpt(L.P.faceL), lpt(L.P.noseWingL), 0.4), drop),
  ];
  const beard = polygonMask([beardPoly], bw, bh, fw * 0.035);
  const lipsGap = dilate(Float32Array.from(lipsOuter), bw, bh, fw * 0.012);
  for (let i = 0; i < n; i++) beard[i] *= 1 - lipsGap[i];
  F.beard = beard;
  F.beardLayer = buildBeard({ beard, fw, down, pts: lp }, bw, bh);

  // --- pre-blurred crop for edge-aware smoothing ----------------------------
  const chans = [0, 1, 2].map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = crop[i * 3 + c];
    return blur(a, bw, bh, Math.max(2, fw / 55));
  });
  const smooth = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    smooth[i * 3] = chans[0][i];
    smooth[i * 3 + 1] = chans[1][i];
    smooth[i * 3 + 2] = chans[2][i];
  }
  F.smooth = smooth;
  return F;
}
