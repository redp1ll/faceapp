// Procedural stubble: thousands of short strokes that follow the natural
// growth direction, clipped to the soft beard mask.
import { mulberry32 } from './imageops.js';
import { P } from './landmarks.js';

export function buildBeard(F, w, h) {
  const { beard, fw, down, pts } = F;
  const rnd = mulberry32(1337);

  let area = 0, x0 = w, y0 = h, x1 = 0, y1 = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const m = beard[y * w + x];
      if (m < 0.2) continue;
      area += m;
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    }
  }
  if (area < 50) return null;

  const mouth = [(pts[P.mouthR][0] + pts[P.mouthL][0]) / 2, (pts[P.mouthR][1] + pts[P.mouthL][1]) / 2];
  const spacing = Math.max(1.1, fw * 0.0045);
  const count = Math.min(60000, Math.round(area / (spacing * spacing)));
  const strokes = [];
  let tries = 0;
  while (strokes.length < count && tries < count * 6) {
    tries++;
    const x = x0 + rnd() * (x1 - x0), y = y0 + rnd() * (y1 - y0);
    const m = beard[(y | 0) * w + (x | 0)];
    if (rnd() > m) continue;
    const rx = x - mouth[0], ry = y - mouth[1];
    // Signed offset along the face's down axis: < 0 means above the mouth.
    const along = rx * down[0] + ry * down[1];
    const side = rx * down[1] - ry * down[0];
    let dx, dy;
    if (along < 0) {
      // Moustache: grows down and outwards from the philtrum.
      const s = Math.sign(side) * 0.7;
      dx = down[0] + s * down[1];
      dy = down[1] - s * down[0];
    } else {
      dx = rx * 0.6 + down[0] * fw * 0.5;
      dy = ry * 0.6 + down[1] * fw * 0.5;
    }
    const jitter = (rnd() - 0.5) * 0.7;
    const c = Math.cos(jitter), s2 = Math.sin(jitter);
    const l = Math.hypot(dx, dy) || 1;
    const ux = (dx * c - dy * s2) / l, uy = (dx * s2 + dy * c) / l;
    const length = fw * (0.006 + rnd() * 0.012);
    // Mix of darker and lighter hairs gives the stubble some depth.
    const shade = rnd() < 0.15 ? 'light' : 'dark';
    strokes.push({ x, y, ux, uy, length, shade, alpha: 0.25 + rnd() * 0.45, t: (rnd() * (1.15 - m)) / 1.15 });
  }

  // Mask as an alpha image to clip the strokes with.
  const maskCanvas = document.createElement('canvas');
  maskCanvas.width = w;
  maskCanvas.height = h;
  const mctx = maskCanvas.getContext('2d');
  const img = mctx.createImageData(w, h);
  for (let i = 0; i < beard.length; i++) {
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = 255;
    img.data[i * 4 + 3] = Math.round(beard[i] * 255);
  }
  mctx.putImageData(img, 0, 0);

  return { strokes, maskCanvas, lineWidth: Math.max(0.7, fw * 0.0022), cache: null };
}

function mixHex(a, b, t) {
  const pa = parseInt(a.slice(1), 16), pb = parseInt(b.slice(1), 16);
  const ch = (v, sh) => (v >> sh) & 255;
  const m = (sh) => Math.round(ch(pa, sh) + (ch(pb, sh) - ch(pa, sh)) * t);
  return `rgb(${m(16)}, ${m(8)}, ${m(0)})`;
}

// Returns premultiplied RGBA floats for the stubble at this density/colour.
export function beardLayer(layer, w, h, amount, color) {
  const key = `${amount}|${color}`;
  if (layer.cache && layer.cache.key === key) return layer.cache.data;

  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.lineWidth = layer.lineWidth;
  ctx.lineCap = 'round';
  const light = mixHex(color, '#ffffff', 0.15);
  const grow = 0.5 + amount * 0.8;
  for (const s of layer.strokes) {
    if (s.t > amount) continue;
    ctx.strokeStyle = s.shade === 'light' ? light : color;
    ctx.globalAlpha = s.alpha * (0.6 + 0.4 * amount);
    ctx.beginPath();
    ctx.moveTo(s.x, s.y);
    ctx.lineTo(s.x + s.ux * s.length * grow, s.y + s.uy * s.length * grow);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(layer.maskCanvas, 0, 0);

  const d = ctx.getImageData(0, 0, w, h).data;
  const out = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const a = d[i * 4 + 3] / 255;
    out[i * 4] = (d[i * 4] / 255) * a;
    out[i * 4 + 1] = (d[i * 4 + 1] / 255) * a;
    out[i * 4 + 2] = (d[i * 4 + 2] / 255) * a;
    out[i * 4 + 3] = a;
  }
  layer.cache = { key, data: out };
  return out;
}
