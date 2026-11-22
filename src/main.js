import { analyze } from './analysis.js';
import { FACE_DEFAULTS, GLOBAL_DEFAULTS, isFaceKey, newState, render, upgradeState } from './render.js';
import { areaMask } from './local.js';
import { createViewport } from './viewport.js';
import { detect, loadModels, resample } from './vision.js';
import { deleteEdit, getOriginal, listEdits, saveEdit, saveOriginal } from './gallery.js';
import { LOOKS, applyLook } from './presets.js';
import { FILTERS, applyFilter } from './filters.js';

// Editing happens on a preview of at most 1600 px so sliders react
// instantly; saving re-renders at full resolution (up to ~12.6 MP, which
// covers 12 MP iPhone photos at their native size).
const MAX_SIDE = 1600;
const EXPORT_MAX_SIDE = 4096;
const EXPORT_MAX_PIXELS = 12.6e6;

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
  { id: 'filter', label: 'Filter', controls: [] },
  { id: 'skin', label: 'Haut', face: true, controls: [
    { key: 'smooth', label: 'Glätten' },
    { key: 'underEye', label: 'Augenringe' },
    { key: 'glow', label: 'Strahlen' },
    { key: 'teeth', label: 'Zähne aufhellen' },
  ] },
  { id: 'makeup', label: 'Make-up', face: true, controls: [
    { key: 'lip', label: 'Lippenstift', color: 'lipColor' },
    { key: 'blush', label: 'Rouge', color: 'blushColor' },
    { key: 'shadow', label: 'Lidschatten', color: 'shadowColor' },
  ] },
  { id: 'eyes', label: 'Augen', face: true, controls: [
    { key: 'eyesBright', label: 'Leuchten' },
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
  { id: 'area', label: 'Bereich', face: true, controls: [] },
  { id: 'warp', label: 'Verformen', controls: [] },
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
let source = null; // decoded photo at its own resolution
let detection = null; // untouched detection result at preview size
let currentEdit = null; // gallery entry of the open photo
let editVersion = 0; // bumps on every change
let A = null; // analysis of the current photo
let sel = 0; // index of the face being edited
let highlightUntil = 0;

// Settings of the selected face, or the photo-wide ones (light; hair too
// when no face was found).
const perFace = (key) => isFaceKey(key) && A.faces.length > 0;
const bag = (key) => (perFace(key) ? state.faces[sel] : state.global);
const defaultOf = (key) => (perFace(key) ? FACE_DEFAULTS : GLOBAL_DEFAULTS)[key];
let activeTab = 'looks';
let lookThumbs = null; // { sel, urls } preview images for the selected face
let compare = false;
let brushSize = 44; // brush diameter in screen pixels
let areaErase = false;
let history = []; // undo stack of local edits: { type: 'area', face } | { type: 'push', n }
let cursor = null; // [x, y, r] brush outline in image pixels while drawing
let panelCollapsed = false;
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
    b.onclick = () => {
      // Tapping the open tab again folds the panel away to free the photo.
      setCollapsed(t.id === activeTab ? !panelCollapsed : false);
      activeTab = t.id;
      buildTabs();
      buildControls();
      draw();
    };
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
  if (tab.id === 'hair' && (A.faces.length ? !A.faces[sel].hair : !A.hair)) {
    box.innerHTML = `<p class="hint">${A.faces.length ? 'Bei dieser Person' : 'Auf diesem Foto'} wurden keine Haare erkannt.</p>`;
    return;
  }
  if (tab.id === 'looks') return buildLooks(box);
  if (tab.id === 'filter') return buildFilters(box);
  if (tab.id === 'area') return buildArea(box);
  if (tab.id === 'warp') return buildWarp(box);
  if (tab.face && state.areas[sel]?.length && !areaMask(A.faces[sel], state.areas[sel], A.w)?.empty) {
    box.insertAdjacentHTML('beforeend', '<p class="hint small area-note">Wirkt nur im markierten Bereich. Ändern unter „Bereich“.</p>');
  }
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

// ----------------------------------------------------------- local tools ---
function brushControl(box) {
  const wrap = document.createElement('div');
  wrap.className = 'control';
  wrap.innerHTML = `
    <div class="control-head"><label for="ctl-brush">Pinselgröße</label><output>${brushSize}</output></div>
    <input id="ctl-brush" type="range" min="12" max="140" step="1" value="${brushSize}" />`;
  const input = wrap.querySelector('input');
  input.addEventListener('input', () => {
    brushSize = Number(input.value);
    wrap.querySelector('output').textContent = input.value;
  });
  box.append(wrap);
}

function actionRow(box, buttons) {
  const row = document.createElement('div');
  row.className = 'tool-row';
  for (const [label, fn, disabled] of buttons) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ghost';
    b.textContent = label;
    b.disabled = !!disabled;
    b.onclick = fn;
    row.append(b);
  }
  box.append(row);
}

function buildArea(box) {
  const strokes = state.areas[sel];
  box.insertAdjacentHTML('beforeend', `<p class="hint small">Male mit einem Finger über die Stellen, an denen die Effekte wirken sollen,
    zum Beispiel nur die Stirn oder eine Wange. Ohne Markierung wirken sie im ganzen Gesicht. Zoomen mit zwei Fingern.</p>`);
  const seg = document.createElement('div');
  seg.className = 'segmented';
  for (const [label, erase] of [['Malen', false], ['Radieren', true]]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.setAttribute('aria-pressed', String(areaErase === erase));
    b.onclick = () => { areaErase = erase; buildControls(); };
    seg.append(b);
  }
  box.append(seg);
  brushControl(box);
  actionRow(box, [
    ['Rückgängig', undo, !history.some((h) => h.type === 'area' && h.face === sel)],
    ['Markierung löschen', () => {
      state.areas[sel] = [];
      history = history.filter((h) => !(h.type === 'area' && h.face === sel));
      buildControls();
      scheduleRender();
    }, !strokes.length],
  ]);
}

function buildWarp(box) {
  box.insertAdjacentHTML('beforeend', `<p class="hint small">Ziehe mit einem Finger, um Bildteile zu verschieben, etwa Kinn, Wangen oder Haare.
    Kleine Pinsel für feine Korrekturen. Zoomen mit zwei Fingern.</p>`);
  brushControl(box);
  actionRow(box, [
    ['Rückgängig', undo, !history.some((h) => h.type === 'push')],
    ['Alle Verformungen entfernen', () => {
      state.pushes = [];
      history = history.filter((h) => h.type !== 'push');
      buildControls();
      scheduleRender();
    }, !state.pushes.length],
  ]);
}

function undo() {
  const tab = activeTab === 'area' ? 'area' : 'push';
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    if (h.type !== tab || (tab === 'area' && h.face !== sel)) continue;
    history.splice(i, 1);
    if (h.type === 'area') state.areas[h.face].pop();
    else state.pushes.splice(state.pushes.length - h.n, h.n);
    break;
  }
  buildControls();
  scheduleRender();
}

// Image-pixel radius of the brush at the current zoom.
function brushRadius() {
  return (brushSize / 2) * (A.w / view.getBoundingClientRect().width);
}

let stroke = null; // the stroke or drag in progress
const tool = {
  start(e) {
    const [x, y] = toImage(e);
    const r = brushRadius();
    cursor = [x, y, r];
    if (activeTab === 'area') {
      const i = faceAt([x, y]);
      if (i >= 0 && i !== sel) selectFace(i);
      const st = { e: areaErase, r: r / A.w, p: [x / A.w, y / A.w] };
      state.areas[sel].push(st);
      stroke = { type: 'area', st };
    } else {
      stroke = { type: 'push', last: [x, y], R: r, n: 0 };
    }
    scheduleRender();
  },
  move(e) {
    if (!stroke) return;
    const [x, y] = toImage(e);
    cursor = [x, y, cursor[2]];
    if (stroke.type === 'area') {
      const p = stroke.st.p;
      const lx = p[p.length - 2] * A.w, ly = p[p.length - 1] * A.w;
      if (Math.hypot(x - lx, y - ly) < stroke.st.r * A.w * 0.15) return draw();
      p.push(x / A.w, y / A.w);
    } else {
      // Split the drag into small steps (< 0.4 R) so the warp never folds.
      const [lx, ly] = stroke.last, R = stroke.R;
      const d = Math.hypot(x - lx, y - ly);
      if (d < R * 0.08) return draw();
      const steps = Math.ceil(d / (R * 0.4));
      for (let k = 0; k < steps; k++) {
        const cx = lx + ((x - lx) * k) / steps, cy = ly + ((y - ly) * k) / steps;
        state.pushes.push({ c: [cx / A.w, cy / A.w], d: [(x - lx) / steps / A.w, (y - ly) / steps / A.w], R: R / A.w });
      }
      stroke.n += steps;
      stroke.last = [x, y];
    }
    scheduleRender();
  },
  end() {
    if (!stroke) return;
    if (stroke.type === 'area') history.push({ type: 'area', face: sel });
    else if (stroke.n) history.push({ type: 'push', n: stroke.n });
    stroke = null;
    cursor = null;
    buildControls();
    scheduleRender();
  },
  cancel() {
    if (!stroke) return;
    if (stroke.type === 'area') state.areas[sel].pop();
    else state.pushes.splice(state.pushes.length - stroke.n, stroke.n);
    stroke = null;
    cursor = null;
    scheduleRender();
  },
};

const toolMode = () => A && (activeTab === 'warp' || (activeTab === 'area' && A.faces.length > 0));

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
        for (const k of ['brightness', 'contrast', 'saturation', 'warmth', 'filter', 'filterStrength']) state.global[k] = GLOBAL_DEFAULTS[k];
      }
      buildControls();
      scheduleRender();
    };
    grid.append(b);
  }
  box.append(grid);

  const look = face.look && LOOKS.find((l) => l.id === face.look);
  if (look) {
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

// ---------------------------------------------------------------- filters ---
// Thumbnails: the filter applied to a small crop of the photo (the selected
// face, or the centre when there is none).
let filterThumbs = null; // { A, sel, urls }
function filterThumb(f) {
  const size = 160;
  let c;
  if (A.faces.length) c = cropFace(original, A.faces[sel], size);
  else {
    c = document.createElement('canvas');
    c.width = c.height = size;
    const side = Math.min(A.w, A.h);
    c.getContext('2d').drawImage(original, (A.w - side) / 2, (A.h - side) / 2, side, side, 0, 0, size, size);
  }
  if (!f) return c.toDataURL('image/jpeg', 0.85);
  const ctx = c.getContext('2d');
  const img = ctx.getImageData(0, 0, size, size);
  const n = size * size, rgb = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) rgb[i * 3 + k] = img.data[i * 4 + k] / 255;
  applyFilter(rgb, size, size, f.id, 1);
  for (let i = 0; i < n; i++) for (let k = 0; k < 3; k++) img.data[i * 4 + k] = rgb[i * 3 + k] * 255;
  ctx.putImageData(img, 0, 0);
  return c.toDataURL('image/jpeg', 0.85);
}

function buildFilters(box) {
  if (!filterThumbs || filterThumbs.A !== A || filterThumbs.sel !== sel) {
    filterThumbs = { A, sel, urls: { none: filterThumb(null) } };
    for (const f of FILTERS) filterThumbs.urls[f.id] = filterThumb(f);
  }
  const g = state.global;
  const grid = document.createElement('div');
  grid.className = 'looks';
  for (const f of [{ id: null, name: 'Ohne' }, ...FILTERS]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'look';
    b.setAttribute('aria-pressed', String((g.filter ?? null) === f.id));
    b.innerHTML = `<span class="look-img"><img alt="" src="${filterThumbs.urls[f.id ?? 'none']}" /></span><span class="look-name">${f.name}</span>`;
    b.onclick = () => {
      g.filter = f.id;
      g.filterStrength = f.id ? (g.filterStrength || 80) : 0;
      buildControls();
      scheduleRender();
    };
    grid.append(b);
  }
  box.append(grid);
  const f = FILTERS.find((x) => x.id === g.filter);
  if (f) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    wrap.innerHTML = `
      <div class="control-head"><label for="ctl-filterStrength">Stärke: ${f.name}</label><output>${g.filterStrength}</output></div>
      <input id="ctl-filterStrength" type="range" min="0" max="100" step="1" value="${g.filterStrength}" />`;
    const input = wrap.querySelector('input');
    input.addEventListener('input', () => {
      g.filterStrength = Number(input.value);
      wrap.querySelector('output').textContent = input.value;
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
    editVersion++;
    queueAutosave();
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

function outlineFace(alpha) {
  const poly = A.faces[sel].ovalPoly;
  vctx.save();
  vctx.globalAlpha = alpha;
  vctx.lineWidth = Math.max(2, A.w / view.getBoundingClientRect().width * 2);
  vctx.setLineDash([vctx.lineWidth * 3, vctx.lineWidth * 2]);
  vctx.strokeStyle = '#ff7a59';
  vctx.beginPath();
  poly.forEach(([x, y], i) => (i ? vctx.lineTo(x, y) : vctx.moveTo(x, y)));
  vctx.closePath();
  vctx.stroke();
  vctx.restore();
}

// Orange copy of a white mask canvas (cached per source canvas).
const tintCache = new WeakMap();
function tinted(src) {
  let t = tintCache.get(src);
  if (!t) { t = { c: document.createElement('canvas'), key: '' }; tintCache.set(src, t); }
  const key = `${src.width}x${src.height}:${areaMask(A.faces[sel], state.areas[sel], A.w).key}`;
  if (t.key !== key) {
    t.c.width = src.width;
    t.c.height = src.height;
    const ctx = t.c.getContext('2d');
    ctx.drawImage(src, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#ff5a2a';
    ctx.fillRect(0, 0, src.width, src.height);
    t.key = key;
  }
  return t.c;
}

function draw() {
  if (!A) return;
  vctx.drawImage(result, 0, 0);
  if (!compare && A.faces.length > 1 && performance.now() < highlightUntil) outlineFace(1);
  if (!compare && activeTab === 'area' && A.faces.length) {
    // Show the painted area as a tinted overlay.
    const area = areaMask(A.faces[sel], state.areas[sel], A.w);
    if (area && !area.empty) {
      vctx.save();
      vctx.globalAlpha = 0.38;
      vctx.drawImage(tinted(area.canvas), area.box[0], area.box[1]);
      vctx.restore();
    } else {
      outlineFace(0.5);
    }
  }
  if (cursor && !compare) {
    vctx.save();
    vctx.lineWidth = Math.max(1.5, A.w / view.getBoundingClientRect().width * 1.5);
    vctx.strokeStyle = 'rgb(255 255 255 / 0.9)';
    vctx.beginPath();
    vctx.arc(cursor[0], cursor[1], cursor[2], 0, Math.PI * 2);
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

async function openFile(file, restore = null) {
  if (!file) return;
  if (!file.type.startsWith('image/')) return toast('Bitte wähle eine Bilddatei aus.');
  busy('Foto wird geladen …');
  try {
    const img = await decode(file);
    const iw = img.width, ih = img.height;
    const k = Math.min(1, MAX_SIDE / Math.max(iw, ih));
    const w = Math.round(iw * k), h = Math.round(ih * k);
    for (const c of [original, result, view]) { c.width = w; c.height = h; }
    history = [];
    cursor = stroke = null;
    const octx = original.getContext('2d', { willReadFrequently: true });
    octx.drawImage(img, 0, 0, w, h);

    busy('Modelle werden geladen …');
    await loadModels();
    busy('Gesicht wird analysiert …');
    await new Promise((r) => setTimeout(r, 30)); // let the overlay paint
    const det = await detect(original);
    // Keep a pristine copy for the full-resolution export (analysis blurs masks in place).
    detection = { faces: det.faces, hair: det.hair?.slice() ?? null, faceSkin: det.faceSkin?.slice() ?? null };
    source = img;

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
    if (restore && restore.state.faces.length === A.faces.length) {
      state = upgradeState(structuredClone(restore.state), A);
      sel = Math.min(restore.sel ?? sel, Math.max(0, A.faces.length - 1));
      currentEdit = { id: restore.id, created: restore.created, stored: true, file };
    } else {
      if (restore) toast('Die gespeicherten Einstellungen passten nicht mehr zum Foto und wurden zurückgesetzt.');
      currentEdit = { id: newId(), created: Date.now(), stored: false, file };
    }
    exportCache = null;
    lookThumbs = null;

    $('empty').hidden = true;
    document.querySelector('.layout').classList.add('has-photo');
    $('canvas-wrap').hidden = false;
    vp.fit(w, h);
    vp.reset(false);
    for (const id of ['btn-save', 'btn-compare', 'btn-reset']) $(id).disabled = false;
    closeGallery();
    if (restore) { /* no hints when reopening */ } else if (!A.faces.length) toast('Kein Gesicht erkannt. Haare und Licht lassen sich trotzdem bearbeiten.');
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

// ------------------------------------------------------------------- save ---
let exportCache = null; // { version, file, w, h }

function newId() {
  return crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const nextFrame = () => new Promise((r) => setTimeout(r, 30));

function canvasToFile(canvas) {
  return new Promise((resolve, reject) => canvas.toBlob((blob) => {
    if (!blob) return reject(new Error('Export fehlgeschlagen'));
    const name = `facette-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.jpg`;
    resolve(new File([blob], name, { type: 'image/jpeg' }));
  }, 'image/jpeg', 0.92));
}

// Re-run analysis and rendering on the photo at (up to) full resolution.
// Landmarks and masks come from the preview detection, scaled up.
async function renderFullSize() {
  const iw = source.width, ih = source.height;
  const k = Math.min(1, EXPORT_MAX_SIDE / Math.max(iw, ih), Math.sqrt(EXPORT_MAX_PIXELS / (iw * ih)));
  const W = Math.round(iw * k), H = Math.round(ih * k);
  if (W <= A.w && H <= A.h) return result;

  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, W, H);
  let rgb = new Float32Array(W * H * 3);
  {
    const px = ctx.getImageData(0, 0, W, H).data;
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = px[i * 4] / 255;
      rgb[i * 3 + 1] = px[i * 4 + 1] / 255;
      rgb[i * 3 + 2] = px[i * 4 + 2] / 255;
    }
  }
  await nextFrame();
  const sx = W / A.w, sy = H / A.h;
  const det = {
    faces: detection.faces.map((f) => f.map(([x, y]) => [x * sx, y * sy])),
    hair: detection.hair ? resample(detection.hair, A.w, A.h, W, H) : null,
    faceSkin: detection.faceSkin ? resample(detection.faceSkin, A.w, A.h, W, H) : null,
  };
  let full = analyze(rgb, W, H, det);
  await nextFrame();
  const out = render(full, state);
  full = rgb = null;
  ctx.putImageData(new ImageData(out, W, H), 0, 0);
  return c;
}

async function buildExport() {
  if (exportCache && exportCache.version === editVersion) return exportCache;
  const version = editVersion;
  busy('Bild wird in voller Auflösung erstellt …');
  await nextFrame();
  let canvas;
  try {
    canvas = await renderFullSize();
  } catch (err) {
    // Out of memory on very large photos: fall back to the preview size.
    console.error(err);
    canvas = result;
    toast('Für volle Auflösung reicht der Speicher nicht – gespeichert wird in Vorschaugröße.');
  }
  const file = await canvasToFile(canvas);
  exportCache = { version, file, w: canvas.width, h: canvas.height };
  return exportCache;
}

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

const isMobile = () => matchMedia('(pointer: coarse)').matches;

async function save() {
  if (!A) return;
  let exp;
  try {
    exp = await buildExport();
  } catch (err) {
    console.error(err);
    toast('Das Bild konnte nicht gespeichert werden.');
    return;
  } finally {
    busy(null);
  }
  saveNow(); // make sure the gallery has the latest state
  if (!(isMobile() && navigator.canShare?.({ files: [exp.file] }))) {
    download(exp.file);
    toast(`Gespeichert: ${exp.w} × ${exp.h} Pixel`);
    return;
  }
  // iOS only opens the share sheet from a fresh tap, so ask for one.
  const sheet = $('export-sheet');
  const img = sheet.querySelector('img');
  URL.revokeObjectURL(img.src);
  img.src = URL.createObjectURL(exp.file);
  $('export-info').textContent = `${exp.w} × ${exp.h} Pixel`;
  sheet.hidden = false;
  $('btn-share').onclick = () => {
    navigator.share({ files: [exp.file] })
      .then(() => { sheet.hidden = true; })
      .catch((e) => { if (e.name !== 'AbortError') download(exp.file); });
  };
}

// ---------------------------------------------------------------- gallery ---
let autosaveTimer = 0;

function anyEdits() {
  if (!state) return false;
  if (Object.keys(GLOBAL_DEFAULTS).some((k) => state.global[k] !== GLOBAL_DEFAULTS[k])) return true;
  return state.pushes.length > 0 || state.faces.some((_, i) => hasEdits(i));
}

function queueAutosave() {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(saveNow, 900);
}

async function saveNow() {
  clearTimeout(autosaveTimer);
  const entry = currentEdit;
  if (!entry || !A || !anyEdits()) return;
  try {
    if (!entry.stored) {
      await saveOriginal(entry.id, entry.file);
      entry.stored = true;
    }
    const t = document.createElement('canvas');
    const k = 360 / Math.max(A.w, A.h);
    t.width = Math.round(A.w * k);
    t.height = Math.round(A.h * k);
    t.getContext('2d').drawImage(result, 0, 0, t.width, t.height);
    const thumb = await new Promise((r) => t.toBlob(r, 'image/jpeg', 0.8));
    await saveEdit({ id: entry.id, created: entry.created, updated: Date.now(), state: structuredClone(state), sel, thumb });
  } catch (err) {
    console.warn('Galerie: Speichern fehlgeschlagen', err);
  }
}

function when(ts) {
  const min = Math.round((Date.now() - ts) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  const d = new Date(ts), today = new Date();
  const time = d.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === today.toDateString()) return `heute, ${time}`;
  return d.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) + `, ${time}`;
}

const thumbUrls = [];
function tile(entry, onDeleted) {
  const el = document.createElement('div');
  el.className = 'g-tile';
  const url = URL.createObjectURL(entry.thumb);
  thumbUrls.push(url);
  el.innerHTML = `<button type="button" class="g-open" aria-label="Bearbeitung öffnen"><img alt="" src="${url}" /></button>
    <span class="g-date">${when(entry.updated)}</span>
    <button type="button" class="g-del" aria-label="Löschen">×</button>`;
  el.querySelector('.g-open').onclick = () => reopen(entry);
  el.querySelector('.g-del').onclick = async () => {
    if (!confirm('Diese Bearbeitung aus der Galerie löschen?')) return;
    await deleteEdit(entry.id);
    if (currentEdit?.id === entry.id) currentEdit = { ...currentEdit, id: newId(), created: Date.now(), stored: false };
    onDeleted();
  };
  return el;
}

async function reopen(entry) {
  await saveNow();
  const blob = await getOriginal(entry.id);
  if (!blob) return toast('Das Originalfoto ist nicht mehr vorhanden.');
  await openFile(blob, entry);
}

async function openGallery() {
  await saveNow();
  thumbUrls.splice(0).forEach((u) => URL.revokeObjectURL(u));
  const grid = $('gallery-grid');
  grid.innerHTML = '';
  const edits = await listEdits();
  $('gallery-empty').hidden = edits.length > 0;
  for (const e of edits) grid.append(tile(e, openGallery));
  $('gallery').hidden = false;
}

function closeGallery() {
  $('gallery').hidden = true;
  renderRecent();
}

// "Recently edited" row on the start screen.
async function renderRecent() {
  const box = $('recent');
  const edits = await listEdits();
  box.hidden = !edits.length;
  const row = box.querySelector('.recent-row');
  row.innerHTML = '';
  for (const e of edits.slice(0, 4)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'recent-item';
    const url = URL.createObjectURL(e.thumb);
    thumbUrls.push(url);
    b.innerHTML = `<img alt="Bearbeitung vom ${when(e.updated)}" src="${url}" />`;
    b.onclick = () => reopen(e);
    row.append(b);
  }
}

// ----------------------------------------------------------------- wiring ---
$('btn-open').onclick = $('btn-pick').onclick = () => $('file').click();
$('btn-camera').onclick = () => $('camera').click();
for (const id of ['file', 'camera']) {
  $(id).addEventListener('change', async (e) => {
    await saveNow();
    openFile(e.target.files[0]);
    e.target.value = '';
  });
}
$('btn-save').onclick = save;
$('btn-gallery').onclick = openGallery;
$('btn-gallery-close').onclick = closeGallery;
$('btn-recent-all').onclick = openGallery;
$('btn-sheet-close').onclick = () => ($('export-sheet').hidden = true);
document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
$('btn-reset').onclick = () => {
  state = newState(A);
  history = [];
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

// ------------------------------------------------------------- zoom & pan ---
const vp = createViewport({
  stage: $('stage'),
  wrap: $('canvas-wrap'),
  view,
  mode: () => (compare ? 'split' : toolMode() ? 'tool' : 'view'),
  tool,
  onSplit: moveSplit,
  onTap: (e) => {
    if (!A) return;
    const i = faceAt(toImage(e));
    if (i >= 0) selectFace(i);
  },
  onDoubleTap: (e) => {
    if (!A) return;
    if (vp.scale > 1.05) return vp.reset();
    const pt = toImage(e);
    const i = faceAt(pt);
    if (i >= 0) {
      const [x0, y0, x1, y1] = A.faces[i].tight;
      const m = (x1 - x0) * 0.25;
      vp.zoomToRect([x0 - m, y0 - m, x1 + m, y1 + m], A.w);
    } else {
      const r = Math.min(A.w, A.h) / 5;
      vp.zoomToRect([pt[0] - r, pt[1] - r, pt[0] + r, pt[1] + r], A.w);
    }
  },
  onChange: (sc) => {
    $('btn-zoom-face').hidden = sc > 1.01 || !A?.faces.length;
    $('btn-zoom-reset').hidden = sc <= 1.01;
    $('btn-zoom-reset').textContent = `${Math.round(sc * 100)} %  ·  Ganzes Bild`;
  },
});
vp.onResize(() => { if (A) vp.fit(A.w, A.h); });
$('btn-zoom-reset').onclick = () => vp.reset();
$('btn-zoom-face').onclick = () => {
  if (!A?.faces.length) return;
  const [x0, y0, x1, y1] = A.faces[sel].tight;
  const m = (x1 - x0) * 0.25;
  vp.zoomToRect([x0 - m, y0 - m, x1 + m, y1 + m], A.w);
};

function setCollapsed(v) {
  panelCollapsed = v;
  $('panel').classList.toggle('collapsed', v);
  $('btn-panel').setAttribute('aria-expanded', String(!v));
  $('btn-panel').setAttribute('aria-label', v ? 'Menü ausklappen' : 'Menü einklappen');
}
$('btn-panel').onclick = () => setCollapsed(!panelCollapsed);

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
renderRecent();
// Warm the models up in the background so the first photo opens faster.
loadModels().catch(() => {});
