import { FilesetResolver, FaceLandmarker, FaceDetector, ImageSegmenter } from '@mediapipe/tasks-vision';

// Everything runs locally in the browser; no image ever leaves the device.
let loading = null;

export function loadModels() {
  if (!loading) {
    loading = (async () => {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe-wasm', base).href);
      const [landmarker, detector, segmenter] = await Promise.all([
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href, delegate: 'CPU' },
          runningMode: 'IMAGE',
          numFaces: 8,
          minFaceDetectionConfidence: 0.5,
          minFacePresenceConfidence: 0.6,
        }),
        FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: new URL('models/blaze_face_short_range.tflite', base).href, delegate: 'CPU' },
          runningMode: 'IMAGE',
          minDetectionConfidence: 0.3,
        }),
        ImageSegmenter.createFromOptions(fileset, {
          baseOptions: {
            modelAssetPath: new URL('models/selfie_multiclass_256x256.tflite', base).href,
            delegate: 'CPU',
          },
          runningMode: 'IMAGE',
          outputConfidenceMasks: true,
          outputCategoryMask: false,
        }),
      ]);
      return { landmarker, detector, segmenter };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

export function resample(src, sw, sh, w, h) {
  if (sw === w && sh === h) return Float32Array.from(src);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(sh - 1, ((y + 0.5) * sh) / h - 0.5);
    const y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), ty = Math.max(0, fy - y0);
    for (let x = 0; x < w; x++) {
      const fx = Math.min(sw - 1, ((x + 0.5) * sw) / w - 0.5);
      const x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), tx = Math.max(0, fx - x0);
      const a = src[y0 * sw + x0] * (1 - tx) + src[y0 * sw + x1] * tx;
      const b = src[y1 * sw + x0] * (1 - tx) + src[y1 * sw + x1] * tx;
      out[y * w + x] = a * (1 - ty) + b * ty;
    }
  }
  return out;
}

// MediaPipe's face detector sees the whole input squeezed to 128 x 128 px, so
// faces smaller than roughly a fifth of the photo are missed (group photos).
// We therefore also scan overlapping square tiles at two finer scales; every
// face smaller than half a tile lies completely inside at least one tile.
function* tiles(w, h) {
  yield [0, 0, w, h];
  const short = Math.min(w, h);
  for (const div of [1.6, 3.2]) {
    const s = Math.round(short / div);
    if (s < 96) continue;
    const step = s / 2;
    const nx = Math.max(1, Math.ceil((w - s) / step) + 1), ny = Math.max(1, Math.ceil((h - s) / step) + 1);
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) {
        const x = nx === 1 ? 0 : Math.round(((w - s) * i) / (nx - 1));
        const y = ny === 1 ? 0 : Math.round(((h - s) * j) / (ny - 1));
        yield [x, y, s, s];
      }
    }
  }
}

const bounds = (f) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of f) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
};

function overlaps(a, b) {
  const ix = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const iy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  if (ix <= 0 || iy <= 0) return false;
  const inter = ix * iy;
  const area = (r) => (r[2] - r[0]) * (r[3] - r[1]);
  return inter / Math.min(area(a), area(b)) > 0.4;
}

// Tile hits are checked once more: the face detector scores a crop showing
// the face with some surroundings. Hands, clocks or posters that fooled the
// landmarker inside a small tile score low there.
// Real faces scored 0.79-1.0 on test photos, false hits 0.5-0.68.
const CONFIRM_SCORE = 0.75;
function faceScore(detector, canvas, box, tile, tctx) {
  const side = Math.max(box[2] - box[0], box[3] - box[1]) * 2.4;
  const cx = (box[0] + box[2]) / 2, cy = (box[1] + box[3]) / 2;
  const n = 256, k = side / n, ox = cx - side / 2, oy = cy - side / 2;
  tile.width = tile.height = n;
  tctx.fillStyle = '#000';
  tctx.fillRect(0, 0, n, n);
  tctx.drawImage(canvas, ox, oy, side, side, 0, 0, n, n);
  let best = 0;
  for (const d of detector.detect(tile).detections || []) {
    const bb = d.boundingBox;
    const r = [ox + bb.originX * k, oy + bb.originY * k, ox + (bb.originX + bb.width) * k, oy + (bb.originY + bb.height) * k];
    if (overlaps(r, box)) best = Math.max(best, d.categories[0]?.score ?? 0);
  }
  return best;
}

function findFaces({ landmarker, detector }, canvas) {
  const w = canvas.width, h = canvas.height;
  const tile = document.createElement('canvas');
  const tctx = tile.getContext('2d', { willReadFrequently: true });
  const found = []; // { pts, box }
  for (const [tx, ty, tw, th] of tiles(w, h)) {
    const whole = tw === w && th === h;
    let input = canvas;
    if (!whole) {
      tile.width = tw; tile.height = th;
      tctx.drawImage(canvas, tx, ty, tw, th, 0, 0, tw, th);
      input = tile;
    }
    for (const f of landmarker.detect(input).faceLandmarks || []) {
      const pts = f.map((p) => [tx + p.x * tw, ty + p.y * th]);
      const box = bounds(pts);
      // A face cut by an inner tile edge gets unreliable points; an
      // overlapping tile contains it whole.
      const m = 0.01 * tw;
      if (!whole && ((box[0] < tx + m && tx > 0) || (box[1] < ty + m && ty > 0) ||
          (box[2] > tx + tw - m && tx + tw < w) || (box[3] > ty + th - m && ty + th < h))) continue;
      if (found.some((g) => overlaps(g.box, box))) continue;
      if (!whole && faceScore(detector, canvas, box, tile, tctx) < CONFIRM_SCORE) continue;
      found.push({ pts, box });
    }
  }
  return found.map((g) => g.pts);
}

// Returns landmarks (pixels) of every face, ordered left to right, plus
// hair / face-skin masks.
export async function detect(canvas) {
  const models = await loadModels();
  const { segmenter } = models;
  const w = canvas.width, h = canvas.height;

  const faces = findFaces(models, canvas).sort((a, b) => a[1][0] - b[1][0]);

  // selfie_multiclass classes: 0 background, 1 hair, 2 body skin, 3 face skin, 4 clothes, 5 other
  const seg = segmenter.segment(canvas);
  const masks = seg.confidenceMasks || [];
  const take = (i) => {
    const m = masks[i];
    return m ? resample(m.getAsFloat32Array(), m.width, m.height, w, h) : null;
  };
  const hair = take(1);
  const faceSkin = take(3);
  masks.forEach((m) => m.close());

  return { faces, hair, faceSkin };
}
