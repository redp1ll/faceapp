import { analyze } from './analysis.js';
import { FACE_DEFAULTS, GLOBAL_DEFAULTS, isFaceKey, newState, render } from './render.js';
import { detect, loadModels } from './vision.js';
import { LOOKS, applyLook } from './presets.js';

const MAX_SIDE = 1600;

const PALETTES = {
  lipColor: ['#b3263e', '#d9475c', '#8e1b2c', '#c9636b', '#a2455a', '#6d1f3a', '#e0806f'],
  blushColor: ['#e0707a', '#f08c7a', '#d4618a', '#c9776a'],
  shadowColor: ['#7a5a8c', '#8a6a4f', '#4f5d75', '#a07060', '#3c3c3c', '#5a7d6b'],
  irisColor: ['#3d8fd1', '#4fa36b', '#7a8f9e', '#8b5a2b', '#3fb4b0', '#6e5bb8'],
  hairColor: ['#d9b26f', '#f0dca6', '#8a5a34', '#2a1d16', '#b4442f', '#c8c8cc', '#e0758f', '#4466c4'],
  beardColor: ['#3a2a20', '#1d1917', '#6b4a32', '#9a6b3f', '#8a8580'],
};

const TABS = [
  { id: 'looks', label: 'Looks', face: true, controls: [] },
  { id: 'skin', label: 'Haut', face: true, controls: [
    { key: 'smooth', label: 'Glätten' },
    { key: 'glow', label: 'Strahlen' },
    { key: 'teeth', label: 'Zähne aufhellen' },
  ] },
  { id: 'makeup', label: 'Make-up', face: true, controls: [
    { key: 'lip', label: 'Lippenstift', color: 'lipColor' },
    { key: 'blush', label: 'Rouge', color: 'blushColor' },
    { key: 'shadow', label: 'Lidschatten', color: 'shadowColor' },
  ] },
  { id: 'eyes', label: 'Augen', face: true, controls: [
    { key: 'iris', label: 'Augenfarbe', color: 'irisColor' },
    { key: 'eyeSize', label: 'Größe' },
  ] },
  { id: 'hair', label: 'Haare', controls: [
    { key: 'hair', label: 'Haarfarbe', color: 'hairColor' },
  ] },
  { id: 'beard', label: 'Bart', face: true, controls: [
    { key: 'beard', label: 'Bartstoppeln', color: 'beardColor' },
  ] },
  { id: 'shape', label: 'Form', face: true, controls: [
    { key: 'slim', label: 'Gesicht schmaler' },
    { key: 'nose', label: 'Nase schmaler' },
    { key: 'smile', label: 'Lächeln' },
    { key: 'chin', label: 'Kinnlänge', min: -100 },
  ] },
  { id: 'light', label: 'Licht', controls: [
    { key: 'brightness', label: 'Helligkeit', min: -100 },
    { key: 'contrast', label: 'Kontrast', min: -100 },
    { key: 'saturation', label: 'Sättigung', min: -100 },
    { key: 'warmth', label: 'Wärme', min: -100 },
  ] },
];

const $ = (id) => document.getElementById(id);
const view = $('view');
const vctx = view.getContext('2d');
const original = document.createElement('canvas');
const result = document.createElement('canvas');

let state = null;
let A = null; // analysis of the current photo
let sel = 0; // index of the face being edited
let highlightUntil = 0;

// Settings of the selected face, or the photo-wide ones (hair, light).
const bag = (key) => (isFaceKey(key) ? state.faces[sel] : state.global);
const defaultOf = (key) => (isFaceKey(key) ? FACE_DEFAULTS : GLOBAL_DEFAULTS)[key];
let activeTab = 'looks';
let lookThumbs = null; // { sel, urls } preview images for the selected face
let compare = false;
let split = 0.5;
let renderQueued = false;

function toast(msg, ms = 3500) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), ms);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busy-text').textContent = text;
}

// ---------------------------------------------------------------- controls --
function buildTabs() {
  const nav = $('tabs');
  nav.innerHTML = '';
  for (const t of TABS) {
    const b = document.createElement('button');
    b.className = 'tab';
    b.type = 'button';
    b.role = 'tab';
    b.textContent = t.label;
    b.setAttribute('aria-selected', String(t.id === activeTab));
    b.onclick = () => { activeTab = t.id; buildTabs(); buildControls(); };
    nav.append(b);
  }
}

function buildControls() {
  const box = $('controls');
  box.innerHTML = '';
  const tab = TABS.find((t) => t.id === activeTab);
  if (!A) {
    box.innerHTML = '<p class="hint">Wähle zuerst ein Foto aus.</p>';
    return;
  }
  if (tab.face && !A.faces.length) {
    box.innerHTML = '<p class="hint">Auf diesem Foto wurde kein Gesicht erkannt. Haare und Licht lassen sich trotzdem bearbeiten.</p>';
    return;
  }
  if (tab.id === 'hair' && !A.hair) {
    box.innerHTML = '<p class="hint">Auf diesem Foto wurden keine Haare erkannt.</p>';
    return;
  }
  if (tab.id === 'looks') return buildLooks(box);
  for (const c of tab.controls) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const id = `ctl-${c.key}`;
    const min = c.min ?? 0;
    wrap.innerHTML = `
      <div class="control-head"><label for="${id}">${c.label}</label><output>${bag(c.key)[c.key]}</output></div>
      <input id="${id}" type="range" min="${min}" max="100" step="1" value="${bag(c.key)[c.key]}" />`;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    input.addEventListener('input', () => {
      bag(c.key)[c.key] = Number(input.value);
      out.textContent = input.value;
      scheduleRender();
    });
    input.addEventListener('dblclick', () => {
      input.value = defaultOf(c.key);
      input.dispatchEvent(new Event('input'));
    });

    if (c.color) {
      const sw = document.createElement('div');
      sw.className = 'swatches';
      const pick = (hex) => {
        bag(c.key)[c.color] = hex;
        // Picking a colour on an untouched slider should show something.
        if (!bag(c.key)[c.key]) {
          bag(c.key)[c.key] = 60;
          input.value = 60;
          out.textContent = '60';
        }
        sw.querySelectorAll('.swatch').forEach((el) => el.setAttribute('aria-pressed', String(el.dataset.hex === hex)));
        scheduleRender();
      };
      for (const hex of PALETTES[c.color]) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'swatch';
        b.style.background = hex;
        b.dataset.hex = hex;
        b.setAttribute('aria-label', `Farbe ${hex}`);
        b.setAttribute('aria-pressed', String(bag(c.key)[c.color] === hex));
        b.onclick = () => pick(hex);
        sw.append(b);
      }
      const custom = document.createElement('label');
      custom.className = 'swatch swatch-custom';
      custom.title = 'Eigene Farbe';
      custom.innerHTML = `<input type="color" value="${bag(c.key)[c.color]}" aria-label="Eigene Farbe" />`;
      custom.querySelector('input').addEventListener('input', (e) => pick(e.target.value));
      sw.append(custom);
      wrap.append(sw);
    }
    box.append(wrap);
  }
}

// ------------------------------------------------------------------ looks ---
function cropFace(canvas, F, size) {
  const [x0, y0, x1, y1] = F.tight;
  const side = Math.max(x1 - x0, y1 - y0) * 1.15;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const c = document.createElement('canvas');
  c.width = c.height = size;
  c.getContext('2d').drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, size, size);
  return c;
}

// Render each look on the selected face, one per frame so the UI stays responsive.
function makeLookThumbs() {
  const forSel = sel, forA = A;
  lookThumbs = { sel, A, urls: {} };
  const tmpCanvas = document.createElement('canvas');
  tmpCanvas.width = A.w;
  tmpCanvas.height = A.h;
  const queue = [...LOOKS];
  const step = () => {
    if (!lookThumbs || lookThumbs.sel !== forSel || lookThumbs.A !== forA || !queue.length) return;
    const look = queue.shift();
    const st = structuredClone(state);
    applyLook(look, 100, st.faces[forSel], st.global, FACE_DEFAULTS, GLOBAL_DEFAULTS);
    tmpCanvas.getContext('2d').putImageData(new ImageData(render(A, st), A.w, A.h), 0, 0);
    lookThumbs.urls[look.id] = cropFace(tmpCanvas, A.faces[forSel], 160).toDataURL('image/jpeg', 0.85);
    const img = document.querySelector(`.look[data-id="${look.id}"] img`);
    if (img) img.src = lookThumbs.urls[look.id];
    setTimeout(step, 0);
  };
  setTimeout(step, 30);
}

function buildLooks(box) {
  if (!lookThumbs || lookThumbs.sel !== sel || lookThumbs.A !== A) makeLookThumbs();
  const face = state.faces[sel];
  const grid = document.createElement('div');
  grid.className = 'looks';
  const origUrl = cropFace(original, A.faces[sel], 160).toDataURL('image/jpeg', 0.85);
  const items = [{ id: null, name: 'Original' }, ...LOOKS];
  for (const look of items) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look';
    if (look.id) b.dataset.id = look.id;
    b.setAttribute('aria-pressed', String((face.look ?? null) === look.id));
    const src = look.id ? lookThumbs.urls[look.id] || '' : origUrl;
    b.innerHTML = `<span class="look-img"><img alt="" ${src ? `src="${src}"` : ''} /></span><span class="look-name">${look.name}</span>`;
    b.onclick = () => {
      if (look.id) {
        applyLook(look, 100, face, state.global, FACE_DEFAULTS, GLOBAL_DEFAULTS);
        face.look = look.id;
        face.lookStrength = 100;
      } else {
        Object.assign(face, FACE_DEFAULTS, { look: null });
        for (const k of ['brightness', 'contrast', 'saturation', 'warmth']) state.global[k] = GLOBAL_DEFAULTS[k];
      }
      buildControls();
      scheduleRender();
    };
    grid.append(b);
  }
  box.append(grid);

  if (face.look) {
    const look = LOOKS.find((l) => l.id === face.look);
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `
      <div class="control-head"><label for="ctl-lookStrength">Stärke: ${look.name}</label><output>${face.lookStrength}</output></div>
      <input id="ctl-lookStrength" type="range" min="0" max="100" step="1" value="${face.lookStrength}" />
      <p class="hint small">Feinschliff geht in den anderen Reitern.</p>`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => {
      face.lookStrength = Number(input.value);
      wrap.querySelector('output').textContent = input.value;
      applyLook(look, face.lookStrength, face, state.global, FACE_DEFAULTS, GLOBAL_DEFAULTS);
      face.look = look.id;
      scheduleRender();
    });
    box.append(wrap);
  }
}

// ------------------------------------------------------------ face picker ---
function hasEdits(i) {
  return Object.keys(FACE_DEFAULTS).some((k) => typeof FACE_DEFAULTS[k] === 'number' && state.faces[i][k] !== FACE_DEFAULTS[k]);
}

function buildFaces() {
  const strip = $('faces');
  strip.innerHTML = '';
  strip.hidden = !A || A.faces.length < 2;
  if (strip.hidden) return;
  const label = document.createElement('span');
  label.className = 'faces-label';
  label.textContent = 'Gesicht';
  strip.append(label);
  A.faces.forEach((F, i) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'face-thumb';
    b.setAttribute('aria-pressed', String(i === sel));
    b.setAttribute('aria-label', `Gesicht ${i + 1} bearbeiten`);
    if (hasEdits(i)) b.classList.add('edited');
    const c = document.createElement('canvas');
    const [x0, y0, x1, y1] = F.tight;
    const side = Math.max(x1 - x0, y1 - y0) * 1.15;
    const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
    c.width = c.height = 96;
    c.getContext('2d').drawImage(result, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
    b.append(c);
    b.onclick = () => selectFace(i);
    strip.append(b);
  });
}

function selectFace(i) {
  if (!A || i === sel) return;
  sel = i;
  highlightUntil = performance.now() + 1400;
  buildFaces();
  buildControls();
  draw();
  setTimeout(draw, 1450);
}

// Image coordinates of a pointer event on the view canvas.
function toImage(e) {
  const r = view.getBoundingClientRect();
  return [((e.clientX - r.left) / r.width) * A.w, ((e.clientY - r.top) / r.height) * A.h];
}

function faceAt([x, y]) {
  let best = -1, bestArea = Infinity;
  A.faces.forEach((F, i) => {
    const [x0, y0, x1, y1] = F.tight;
    const area = (x1 - x0) * (y1 - y0);
    if (x >= x0 && x <= x1 && y >= y0 && y <= y1 && area < bestArea) { best = i; bestArea = area; }
  });
  return best;
}

// ----------------------------------------------------------------- render ---
function scheduleRender() {
  if (renderQueued || !A) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const px = render(A, state);
    result.getContext('2d').putImageData(new ImageData(px, A.w, A.h), 0, 0);
    draw();
    refreshThumb();
  });
}

// Keep the selected face's thumbnail (and its "edited" dot) up to date.
function refreshThumb() {
  const b = $('faces').querySelectorAll('.face-thumb')[sel];
  if (!b) return;
  const F = A.faces[sel];
  const [x0, y0, x1, y1] = F.tight;
  const side = Math.max(x1 - x0, y1 - y0) * 1.15;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const ctx = b.querySelector('canvas').getContext('2d');
  ctx.drawImage(result, cx - side / 2, cy - side / 2, side, side, 0, 0, 96, 96);
  b.classList.toggle('edited', hasEdits(sel));
}

function draw() {
  if (!A) return;
  vctx.drawImage(result, 0, 0);
  if (!compare && A.faces.length > 1 && performance.now() < highlightUntil) {
    const poly = A.faces[sel].ovalPoly;
    vctx.save();
    vctx.lineWidth = Math.max(2, A.w / 300);
    vctx.setLineDash([vctx.lineWidth * 3, vctx.lineWidth * 2]);
    vctx.strokeStyle = '#ff7a59';
    vctx.beginPath();
    poly.forEach(([x, y], i) => (i ? vctx.lineTo(x, y) : vctx.moveTo(x, y)));
    vctx.closePath();
    vctx.stroke();
    vctx.restore();
  }
  if (compare) {
    const x = Math.round(split * A.w);
    vctx.drawImage(original, 0, 0, x, A.h, 0, 0, x, A.h);
    const lw = Math.max(2, A.w / 400);
    vctx.fillStyle = '#fff';
    vctx.fillRect(x - lw / 2, 0, lw, A.h);
    const r = Math.max(14, A.w / 45);
    vctx.beginPath();
    vctx.arc(x, A.h / 2, r, 0, Math.PI * 2);
    vctx.fill();
    vctx.fillStyle = '#222';
    vctx.font = `600 ${r * 0.8}px system-ui, sans-serif`;
    vctx.textAlign = 'center';
    vctx.textBaseline = 'middle';
    vctx.fillText('↔', x, A.h / 2 + 1);
  }
}

// ------------------------------------------------------------------ photo ---
async function decode(file) {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const url = URL.createObjectURL(file);
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      return img;
    } finally {
      URL.revokeObjectURL(url);
    }
  }
}

async function openFile(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Bitte wähle eine Bilddatei aus.');
  busy('Foto wird geladen …');
  try {
    const img = await decode(file);
    const iw = img.width, ih = img.height;
    const k = Math.min(1, MAX_SIDE / Math.max(iw, ih));
    const w = Math.round(iw * k), h = Math.round(ih * k);
    for (const c of [original, result, view]) { c.width = w; c.height = h; }
    const octx = original.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, w, h);

    busy('Modelle werden geladen …');
    await loadModels();
    busy('Gesicht wird analysiert …');
    await new Promise((r) => setTimeout(r, 30)); // let the overlay paint
    const det = await detect(original);

    const px = octx.getImageData(0, 0, w, h).data;
    const rgb = new Float32Array(w * h * 3);
    for (let i = 0; i < w * h; i++) {
      rgb[i * 3] = px[i * 4] / 255;
      rgb[i * 3 + 1] = px[i * 4 + 1] / 255;
      rgb[i * 3 + 2] = px[i * 4 + 2] / 255;
    }
    A = analyze(rgb, w, h, det);
    state = newState(A);
    // Start with the largest face selected.
    sel = 0;
    A.faces.forEach((F, i) => {
      const area = (F.tight[2] - F.tight[0]) * (F.tight[3] - F.tight[1]);
      const best = A.faces[sel].tight;
      if (area > (best[2] - best[0]) * (best[3] - best[1])) sel = i;
    });

    $('empty').hidden = true;
    $('canvas-wrap').hidden = false;
    for (const id of ['btn-save', 'btn-compare', 'btn-reset']) $(id).disabled = false;
    if (!A.faces.length) toast('Kein Gesicht erkannt. Haare und Licht lassen sich trotzdem bearbeiten.');
    else if (A.faces.length > 1) {
      toast(`${A.faces.length} Gesichter erkannt. Tippe auf ein Gesicht, um es auszuwählen.`);
      highlightUntil = performance.now() + 1800;
      setTimeout(draw, 1850);
    }
    buildControls();
    result.getContext('2d').drawImage(original, 0, 0);
    buildFaces();
    scheduleRender();
  } catch (err) {
    console.error(err);
    toast('Das Foto konnte nicht verarbeitet werden. Bitte versuche es erneut.');
  } finally {
    busy(null);
  }
}

async function save() {
  if (!A) return;
  const blob = await new Promise((r) => result.toBlob(r, 'image/jpeg', 0.92));
  const name = `facette-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
  const file = new File([blob], name, { type: 'image/jpeg' });
  if (navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file] });
      return;
    } catch (e) {
      if (e.name === 'AbortError') return;
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

// ----------------------------------------------------------------- wiring ---
$('btn-open').onclick = $('btn-pick').onclick = () => $('file').click();
$('btn-camera').onclick = () => $('camera').click();
for (const id of ['file', 'camera']) {
  $(id).addEventListener('change', (e) => {
    openFile(e.target.files[0]);
    e.target.value = '';
  });
}
$('btn-save').onclick = save;
$('btn-reset').onclick = () => {
  state = newState(A);
  buildFaces();
  buildControls();
  scheduleRender();
};
$('btn-compare').onclick = () => {
  compare = !compare;
  $('btn-compare').setAttribute('aria-pressed', String(compare));
  view.classList.toggle('splitting', compare);
  draw();
};

function moveSplit(e) {
  const r = view.getBoundingClientRect();
  split = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  draw();
}
view.addEventListener('pointerdown', (e) => {
  if (!compare) {
    const i = faceAt(toImage(e));
    if (i >= 0) selectFace(i);
    return;
  }
  view.setPointerCapture(e.pointerId);
  moveSplit(e);
});
view.addEventListener('pointermove', (e) => {
  if (compare && view.hasPointerCapture(e.pointerId)) moveSplit(e);
});

const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('drag'); });
stage.addEventListener('dragleave', () => stage.classList.remove('drag'));
stage.addEventListener('drop', (e) => {
  e.preventDefault();
  stage.classList.remove('drag');
  openFile(e.dataTransfer.files[0]);
});

buildTabs();
buildControls();
// Warm the models up in the background so the first photo opens faster.
loadModels().catch(() => {});
