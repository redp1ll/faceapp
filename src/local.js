// Local edits: a painted area per face that limits that face's effects, and
// free "push" warps that move pixels where the user drags.
//
// Coordinates are stored divided by the image width so the same edits apply
// to the preview and to the full-resolution export.
import { blur } from './imageops.js';

// ------------------------------------------------------------ area masks ---
// A stroke is { e: erase?, r: radius, p: [x0, y0, x1, y1, ...] }.

// Box covering everything a face's effects can touch (face box plus hair).
function effectBox(F) {
  const b = [...F.box];
  if (F.hair) {
    b[0] = Math.min(b[0], F.hair.box[0]); b[1] = Math.min(b[1], F.hair.box[1]);
    b[2] = Math.max(b[2], F.hair.box[2]); b[3] = Math.max(b[3], F.hair.box[3]);
  }
  return b;
}

function strokeKey(strokes, w) {
  const last = strokes[strokes.length - 1];
  return `${w}:${strokes.length}:${last ? last.p.length : 0}:${last?.e ? 1 : 0}`;
}

function paint(ctx, strokes, w, ox, oy) {
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = ctx.fillStyle = '#fff';
  for (const s of strokes) {
    ctx.globalCompositeOperation = s.e ? 'destination-out' : 'source-over';
    const r = s.r * w;
    const p = s.p;
    if (p.length === 2) {
      ctx.beginPath();
      ctx.arc(p[0] * w - ox, p[1] * w - oy, r, 0, Math.PI * 2);
      ctx.fill();
      continue;
    }
    ctx.lineWidth = r * 2;
    ctx.beginPath();
    ctx.moveTo(p[0] * w - ox, p[1] * w - oy);
    for (let i = 2; i < p.length; i += 2) ctx.lineTo(p[i] * w - ox, p[i + 1] * w - oy);
    ctx.stroke();
  }
  ctx.globalCompositeOperation = 'source-over';
}

const masks = new WeakMap(); // F -> { key, box, bw, bh, m, canvas }

// Soft 0..1 mask over the face's effect box, or null when nothing is painted.
export function areaMask(F, strokes, w) {
  if (!strokes?.length) return null;
  const key = strokeKey(strokes, w);
  const hit = masks.get(F);
  if (hit && hit.key === key) return hit;
  const box = effectBox(F);
  const bw = box[2] - box[0], bh = box[3] - box[1];
  const canvas = hit?.canvas ?? document.createElement('canvas');
  canvas.width = bw;
  canvas.height = bh;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, bw, bh);
  paint(ctx, strokes, w, box[0], box[1]);
  const px = ctx.getImageData(0, 0, bw, bh).data;
  const m = new Float32Array(bw * bh);
  let any = false;
  for (let i = 0; i < m.length; i++) if ((m[i] = px[i * 4 + 3] / 255) > 0) any = true;
  // Feather the edge so effects fade out instead of ending in a hard line.
  if (any) blur(m, bw, bh, Math.max(1.5, F.fw * 0.015));
  const res = { key, box, bw, bh, m, canvas, empty: !any };
  masks.set(F, res);
  return res;
}

// --------------------------------------------------------------- pushes ---
// A push is { c: [x, y], d: [dx, dy], R } (all divided by the image width).
// Each one is applied as its own pass, so a long drag composes like real
// dragging instead of summing up and folding the image.
export function applyPushes(px, w, h, pushes) {
  if (!pushes?.length) return px;
  let tmp = null;
  for (const p of pushes) {
    const cx = p.c[0] * w, cy = p.c[1] * w, dx = p.d[0] * w, dy = p.d[1] * w, R = p.R * w;
    const x0 = Math.max(0, Math.floor(cx - R)), y0 = Math.max(0, Math.floor(cy - R));
    const x1 = Math.min(w, Math.ceil(cx + R) + 1), y1 = Math.min(h, Math.ceil(cy + R) + 1);
    const bw = x1 - x0, bh = y1 - y0;
    if (bw < 2 || bh < 2) continue;
    // Copy the affected box so the pass reads unmodified pixels.
    const need = bw * bh * 4;
    if (!tmp || tmp.length < need) tmp = new Uint8ClampedArray(need * 2);
    for (let y = 0; y < bh; y++) tmp.set(px.subarray(((y + y0) * w + x0) * 4, ((y + y0) * w + x1) * 4), y * bw * 4);
    const R2 = R * R;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const qx = x - cx, qy = y - cy;
        const u = (qx * qx + qy * qy) / R2;
        if (u >= 1) continue;
        const k = (1 - u) * (1 - u);
        const sx = Math.min(bw - 1.001, Math.max(0, x - k * dx - x0));
        const sy = Math.min(bh - 1.001, Math.max(0, y - k * dy - y0));
        const ix = sx | 0, iy = sy | 0, tx = sx - ix, ty = sy - iy;
        const i00 = (iy * bw + ix) * 4, i10 = i00 + 4, i01 = i00 + bw * 4, i11 = i01 + 4;
        const o = (y * w + x) * 4;
        for (let c = 0; c < 3; c++) {
          const a = tmp[i00 + c] + (tmp[i10 + c] - tmp[i00 + c]) * tx;
          const b = tmp[i01 + c] + (tmp[i11 + c] - tmp[i01 + c]) * tx;
          px[o + c] = a + (b - a) * ty;
        }
      }
    }
  }
  return px;
}
