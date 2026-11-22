// Copies the MediaPipe WASM runtime into public/ and downloads the three
// open-source models (Apache-2.0, published by Google) the app uses.
// Runs automatically before `npm run dev` and `npm run build`.
import { mkdir, copyFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pub = join(root, 'public');

const MODELS = {
  'face_landmarker.task':
    'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task',
  'blaze_face_short_range.tflite':
    'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
  'selfie_multiclass_256x256.tflite':
    'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite',
};

async function exists(p) {
  try { return (await stat(p)).size > 0; } catch { return false; }
}

const wasmSrc = join(root, 'node_modules/@mediapipe/tasks-vision/wasm');
const wasmDst = join(pub, 'mediapipe-wasm');
await mkdir(wasmDst, { recursive: true });
for (const f of await readdir(wasmSrc)) await copyFile(join(wasmSrc, f), join(wasmDst, f));

const modelDir = join(pub, 'models');
await mkdir(modelDir, { recursive: true });
for (const [name, url] of Object.entries(MODELS)) {
  const dst = join(modelDir, name);
  if (await exists(dst)) continue;
  console.log(`Lade Modell ${name} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download fehlgeschlagen (${res.status}): ${url}`);
  await writeFile(dst, Buffer.from(await res.arrayBuffer()));
}
console.log('Modelle bereit.');
