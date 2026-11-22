import { FilesetResolver, FaceLandmarker, ImageSegmenter } from '@mediapipe/tasks-vision';

// Everything runs locally in the browser; no image ever leaves the device.
let loading = null;

export function loadModels() {
  if (!loading) {
    loading = (async () => {
      const base = new URL(import.meta.env.BASE_URL, document.baseURI);
      const fileset = await FilesetResolver.forVisionTasks(new URL('mediapipe-wasm', base).href);
      const [landmarker, segmenter] = await Promise.all([
        FaceLandmarker.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: new URL('models/face_landmarker.task', base).href, delegate: 'CPU' },
          runningMode: 'IMAGE',
          numFaces: 4,
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
      return { landmarker, segmenter };
    })().catch((err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

function resample(src, sw, sh, w, h) {
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

// Returns landmarks (pixels) of the largest face plus hair / face-skin masks.
export async function detect(canvas) {
  const { landmarker, segmenter } = await loadModels();
  const w = canvas.width, h = canvas.height;

  const faces = landmarker.detect(canvas).faceLandmarks || [];
  let best = null, bestArea = 0;
  for (const f of faces) {
    let x0 = 1, x1 = 0, y0 = 1, y1 = 0;
    for (const p of f) {
      x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x);
      y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y);
    }
    const area = (x1 - x0) * (y1 - y0);
    if (area > bestArea) { bestArea = area; best = f; }
  }
  const landmarks = best ? best.map((p) => [p.x * w, p.y * h]) : null;

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

  return { landmarks, faceCount: faces.length, hair, faceSkin };
}
