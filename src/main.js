import { analyze } from './analysis.js';
import { DEFAULTS, render } from './render.js';
import { detect, loadModels } from './vision.js';

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

let state = { ...DEFAULTS };
let A = null; // analysis of the current photo
let activeTab = 'skin';
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
  if (tab.face && !A.face) {
    box.innerHTML = '<p class="hint">Auf diesem Foto wurde kein Gesicht erkannt. Haare und Licht lassen sich trotzdem bearbeiten.</p>';
    return;
  }
  if (tab.id === 'hair' && !A.hair) {
    box.innerHTML = '<p class="hint">Auf diesem Foto wurden keine Haare erkannt.</p>';
    return;
  }
  for (const c of tab.controls) {
    const wrap = document.createElement('div');
    wrap.className = 'control';
    const id = `ctl-${c.key}`;
    const min = c.min ?? 0;
    wrap.innerHTML = `
      <div class="control-head"><label for="${id}">${c.label}</label><output>${state[c.key]}</output></div>
      <input id="${id}" type="range" min="${min}" max="100" step="1" value="${state[c.key]}" />`;
    const input = wrap.querySelector('input');
    const out = wrap.querySelector('output');
    input.addEventListener('input', () => {
      state[c.key] = Number(input.value);
      out.textContent = input.value;
      scheduleRender();
    });
    input.addEventListener('dblclick', () => {
      input.value = DEFAULTS[c.key];
      input.dispatchEvent(new Event('input'));
    });

    if (c.color) {
      const sw = document.createElement('div');
      sw.className = 'swatches';
      const pick = (hex) => {
        state[c.color] = hex;
        // Picking a colour on an untouched slider should show something.
        if (!state[c.key]) {
          state[c.key] = 60;
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
        b.setAttribute('aria-pressed', String(state[c.color] === hex));
        b.onclick = () => pick(hex);
        sw.append(b);
      }
      const custom = document.createElement('label');
      custom.className = 'swatch swatch-custom';
      custom.title = 'Eigene Farbe';
      custom.innerHTML = `<input type="color" value="${state[c.color]}" aria-label="Eigene Farbe" />`;
      custom.querySelector('input').addEventListener('input', (e) => pick(e.target.value));
      sw.append(custom);
      wrap.append(sw);
    }
    box.append(wrap);
  }
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
  });
}

function draw() {
  if (!A) return;
  vctx.drawImage(result, 0, 0);
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
    state = { ...DEFAULTS };

    $('empty').hidden = true;
    $('canvas-wrap').hidden = false;
    for (const id of ['btn-save', 'btn-compare', 'btn-reset']) $(id).disabled = false;
    if (!A.face) toast('Kein Gesicht erkannt. Haare und Licht lassen sich trotzdem bearbeiten.');
    else if (det.faceCount > 1) toast('Mehrere Gesichter erkannt – bearbeitet wird das größte.');
    buildControls();
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
  state = { ...DEFAULTS };
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
  if (!compare) return;
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
