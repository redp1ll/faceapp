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

export function analyze(rgb, w, h, det) {
  const A = { w, h, rgb, face: null, hair: null };

  if (det.hair) {
    A.hair = blur(det.hair, w, h, Math.max(1, Math.min(w, h) / 600));
    A.hairMeanL = meanLum(rgb, A.hair, 0.6);
  }

  if (!det.landmarks) return A;
  const pts = det.landmarks;
  const pt = (i) => pts[i];
  const poly = (idx) => idx.map(pt);

  const fw = len(sub(pt(L.P.faceL), pt(L.P.faceR)));
  const down = norm(sub(pt(L.P.chin), pt(L.P.forehead)));
  const right = [down[1], -down[0]]; // perpendicular to the face axis
  const F = { pts, fw, down, right };

  // --- base regions --------------------------------------------------------
  const oval = polygonMask([poly(L.FACE_OVAL)], w, h, fw * 0.015);
  const eyesHard = polygonMask([poly(L.EYE_R), poly(L.EYE_L)], w, h, 0.6);
  const eyesDil = dilate(Float32Array.from(eyesHard), w, h, fw * 0.025);
  const browsDil = dilate(polygonMask([poly(L.BROW_R), poly(L.BROW_L)], w, h), w, h, fw * 0.02);
  const lipsOuter = polygonMask([poly(L.LIPS_OUTER)], w, h, fw * 0.004);
  const mouthInner = polygonMask([poly(L.LIPS_INNER)], w, h, fw * 0.003);
  const lipsDil = dilate(Float32Array.from(lipsOuter), w, h, fw * 0.02);
  const nostrils = dilate(
    circleMask([
      [...lerp(pt(L.P.noseWingR), pt(L.P.noseBottom), 0.45), fw * 0.025],
      [...lerp(pt(L.P.noseWingL), pt(L.P.noseBottom), 0.45), fw * 0.025],
    ], w, h), w, h, fw * 0.01);

  // Skin = face oval without eyes, brows, lips and nostrils; trimmed by the
  // segmenter's face-skin class so hair over the forehead stays untouched.
  const skin = new Float32Array(w * h);
  const fs = det.faceSkin ? blur(det.faceSkin, w, h, fw * 0.01) : null;
  for (let i = 0; i < skin.length; i++) {
    let m = oval[i] * (1 - eyesDil[i]) * (1 - browsDil[i]) * (1 - lipsDil[i]) * (1 - nostrils[i]);
    if (fs) m *= Math.min(1, fs[i] * 1.4);
    skin[i] = m;
  }
  F.skin = skin;

  F.lips = combine(Float32Array.from(lipsOuter), mouthInner, (a, b) => Math.max(0, a - b));
  F.lipsMeanL = meanLum(rgb, F.lips, 0.6);
  F.mouthInner = mouthInner;

  // --- irises: circle clipped by the eye opening, pupil kept dark ----------
  const irisCircles = [L.IRIS_R, L.IRIS_L].map((idx) => {
    const c = pt(idx[0]);
    const r = idx.slice(1).reduce((s, i) => s + len(sub(pt(i), c)), 0) / 4;
    return [c[0], c[1], r];
  });
  const iris = circleMask(irisCircles, w, h, 0.8);
  const pupils = circleMask(irisCircles.map(([x, y, r]) => [x, y, r * 0.38]), w, h, irisCircles[0][2] * 0.12);
  for (let i = 0; i < iris.length; i++) iris[i] *= eyesHard[i] * (1 - pupils[i]);
  F.iris = iris;
  F.irisMeanL = meanLum(rgb, iris, 0.5);
  F.irisCircles = irisCircles;

  // --- eyeshadow: band between upper lid and brow ---------------------------
  const shadowPolys = [[L.LID_R, L.BROW_LOWER_R], [L.LID_L, L.BROW_LOWER_L]].map(([lid, brow]) => {
    const lidPts = poly(lid), browPts = poly(brow);
    const top = lidPts.map((p, i) => lerp(p, polylineAt(browPts, i / (lidPts.length - 1)), 0.55));
    return [...lidPts, ...top.reverse()];
  });
  const shadow = polygonMask(shadowPolys, w, h, fw * 0.02);
  for (let i = 0; i < shadow.length; i++) shadow[i] *= 1 - eyesHard[i];
  F.shadow = shadow;

  // --- blush: soft discs on the cheek apples --------------------------------
  const cheekR = lerp(pt(L.P.cheekR), pt(L.P.faceR), 0.15);
  const cheekL = lerp(pt(L.P.cheekL), pt(L.P.faceL), 0.15);
  const blush = circleMask([[...cheekR, fw * 0.09], [...cheekL, fw * 0.09]], w, h, fw * 0.06);
  for (let i = 0; i < blush.length; i++) blush[i] *= skin[i];
  F.blush = blush;

  // --- beard region ---------------------------------------------------------
  const drop = mul(down, fw * 0.16);
  const beardPoly = [
    ...poly(L.LOWER_OVAL),
    add(lerp(pt(L.P.faceR), pt(L.P.noseWingR), 0.4), drop),
    pt(L.P.noseWingR),
    pt(L.P.noseBottom),
    pt(L.P.noseWingL),
    add(lerp(pt(L.P.faceL), pt(L.P.noseWingL), 0.4), drop),
  ];
  const beard = polygonMask([beardPoly], w, h, fw * 0.035);
  const lipsGap = dilate(Float32Array.from(lipsOuter), w, h, fw * 0.012);
  for (let i = 0; i < beard.length; i++) beard[i] *= 1 - lipsGap[i];
  F.beard = beard;
  F.beardLayer = buildBeard(F, w, h);

  // --- pre-blurred image for edge-aware smoothing ---------------------------
  const n = w * h;
  const chans = [0, 1, 2].map((c) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = rgb[i * 3 + c];
    return blur(a, w, h, Math.max(2, fw / 55));
  });
  const smooth = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    smooth[i * 3] = chans[0][i];
    smooth[i * 3 + 1] = chans[1][i];
    smooth[i * 3 + 2] = chans[2][i];
  }
  F.smooth = smooth;

  // Bounding box of everything the shape warps can touch.
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of pts) {
    x0 = Math.min(x0, x); x1 = Math.max(x1, x);
    y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const pad = fw * 0.35;
  F.box = [Math.max(0, Math.floor(x0 - pad)), Math.max(0, Math.floor(y0 - pad)),
    Math.min(w, Math.ceil(x1 + pad)), Math.min(h, Math.ceil(y1 + pad))];

  A.face = F;
  return A;
}
