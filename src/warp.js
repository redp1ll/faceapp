// Face-shape edits as a sum of smooth local warps, applied by inverse
// mapping with bilinear sampling (only inside the face's bounding box).
import * as L from './landmarks.js';

export function buildWarps(F, s) {
  const { pts, fw, down, right } = F;
  const ops = [];
  const pt = (i) => pts[i];

  if (s.slim) {
    const top = pt(L.P.forehead);
    for (const i of [...L.JAW_R, ...L.JAW_L]) {
      const p = pt(i);
      // Closest point on the face's centre line at the same height.
      const t = (p[0] - top[0]) * down[0] + (p[1] - top[1]) * down[1];
      const mid = [top[0] + down[0] * t, top[1] + down[1] * t];
      const k = s.slim * 0.16;
      ops.push({ type: 'move', group: 'jaw', c: p, d: [(mid[0] - p[0]) * k, (mid[1] - p[1]) * k], R: fw * 0.22 });
    }
  }

  if (s.eyeSize) {
    for (const [x, y, r] of F.irisCircles) {
      ops.push({ type: 'scale', c: [x, y], a: s.eyeSize * 0.22, R: r * 3.2 });
    }
  }

  if (s.nose) {
    const c = [(pt(L.P.noseWingR)[0] + pt(L.P.noseWingL)[0]) / 2, (pt(L.P.noseWingR)[1] + pt(L.P.noseWingL)[1]) / 2];
    const wing = Math.hypot(pt(L.P.noseWingL)[0] - pt(L.P.noseWingR)[0], pt(L.P.noseWingL)[1] - pt(L.P.noseWingR)[1]);
    const bridge = Math.hypot(pt(L.P.noseBridge)[0] - c[0], pt(L.P.noseBridge)[1] - c[1]);
    ops.push({ type: 'squeeze', c, u: right, v: down, a: s.nose * 0.35, Ru: wing * 1.1, Rv: bridge * 1.15 });
  }

  if (s.smile) {
    const mw = Math.hypot(pt(L.P.mouthL)[0] - pt(L.P.mouthR)[0], pt(L.P.mouthL)[1] - pt(L.P.mouthR)[1]);
    for (const [i, side] of [[L.P.mouthR, -1], [L.P.mouthL, 1]]) {
      const k = s.smile * mw * 0.09;
      ops.push({
        type: 'move',
        c: pt(i),
        d: [-down[0] * k + right[0] * side * k * 0.35, -down[1] * k + right[1] * side * k * 0.35],
        R: mw * 0.45,
      });
    }
  }

  if (s.chin) {
    const k = s.chin * fw * 0.07;
    ops.push({ type: 'move', c: pt(L.P.chin), d: [down[0] * k, down[1] * k], R: fw * 0.4 });
  }
  return ops;
}

// Each warp uses a C1-smooth falloff (1 - r²/R²)². Moves are kept below
// ~0.6 R so the mapping never folds. Moves sharing a `group` are averaged
// rather than summed, so overlapping jaw points don't add up.
export function applyWarps(src, w, h, ops, box) {
  const out = new Uint8ClampedArray(src);
  const [bx0, by0, bx1, by1] = box;
  for (let y = by0; y < by1; y++) {
    for (let x = bx0; x < bx1; x++) {
      let sx = x, sy = y;
      let gk = 0, gx = 0, gy = 0;
      for (const o of ops) {
        const px = x - o.c[0], py = y - o.c[1];
        if (o.type === 'move') {
          const u = (px * px + py * py) / (o.R * o.R);
          if (u >= 1) continue;
          const k = (1 - u) * (1 - u);
          if (o.group) {
            gk += k; gx += k * o.d[0]; gy += k * o.d[1];
          } else {
            sx -= k * o.d[0];
            sy -= k * o.d[1];
          }
        } else if (o.type === 'scale') {
          const r2 = (px * px + py * py) / (o.R * o.R);
          if (r2 >= 1) continue;
          const f = o.a * (1 - r2) * (1 - r2);
          sx -= px * f;
          sy -= py * f;
        } else {
          const su = px * o.u[0] + py * o.u[1];
          const sv = px * o.v[0] + py * o.v[1];
          const e = (su / o.Ru) ** 2 + (sv / o.Rv) ** 2;
          if (e >= 1) continue;
          const f = o.a * (1 - e) * (1 - e);
          sx += o.u[0] * su * f;
          sy += o.u[1] * su * f;
        }
      }
      if (gk > 0) {
        const norm = Math.max(1, gk);
        sx -= gx / norm;
        sy -= gy / norm;
      }
      if (sx === x && sy === y) continue;
      sx = Math.min(w - 1.001, Math.max(0, sx));
      sy = Math.min(h - 1.001, Math.max(0, sy));
      const x0 = sx | 0, y0 = sy | 0, tx = sx - x0, ty = sy - y0;
      const i00 = (y0 * w + x0) * 4, i10 = i00 + 4, i01 = i00 + w * 4, i11 = i01 + 4;
      const o = (y * w + x) * 4;
      for (let c = 0; c < 3; c++) {
        const a = src[i00 + c] + (src[i10 + c] - src[i00 + c]) * tx;
        const b = src[i01 + c] + (src[i11 + c] - src[i01 + c]) * tx;
        out[o + c] = a + (b - a) * ty;
      }
    }
  }
  return out;
}
