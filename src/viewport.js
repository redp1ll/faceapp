// Fits the photo into the stage and handles zoom & pan:
// two-finger pinch, mouse wheel / trackpad, double tap, and one-finger
// panning while zoomed. One-finger gestures are routed by `mode()`:
//   'view'  tap selects, drag pans
//   'tool'  drag paints / pushes (handled by the caller)
//   'split' drag moves the before/after divider
export function createViewport({ stage, wrap, view, mode, onTap, onDoubleTap, tool, onSplit, onChange }) {
  const MAX = 8;
  let s = 1, tx = 0, ty = 0; // CSS transform on top of the fitted size
  let fw = 0, fh = 0; // fitted CSS size of the photo
  const ptrs = new Map();
  let g = null; // current gesture
  let lastTap = null;

  const apply = () => {
    view.style.transform = `translate(${tx}px, ${ty}px) scale(${s})`;
    onChange?.(s);
  };

  // Layout position of the untransformed photo, in client coordinates.
  function origin() {
    const r = wrap.getBoundingClientRect();
    return [r.left + view.offsetLeft, r.top + view.offsetTop];
  }

  // Keep the zoomed photo covering the stage (or centred when smaller).
  function clamp() {
    const V = stage.getBoundingClientRect();
    const [ox, oy] = origin();
    const w = fw * s, h = fh * s;
    tx = w <= V.width ? V.left + (V.width - w) / 2 - ox : Math.min(V.left - ox, Math.max(V.right - ox - w, tx));
    ty = h <= V.height ? V.top + (V.height - h) / 2 - oy : Math.min(V.top - oy, Math.max(V.bottom - oy - h, ty));
    if (s === 1) tx = ty = 0;
  }

  function zoomAt(cx, cy, ns, from = { s, tx, ty, cx, cy }) {
    ns = Math.min(MAX, Math.max(1, ns));
    const [ox, oy] = origin();
    const qx = (from.cx - ox - from.tx) / from.s, qy = (from.cy - oy - from.ty) / from.s;
    s = ns;
    tx = cx - ox - qx * s;
    ty = cy - oy - qy * s;
    clamp();
    apply();
  }

  function animate() {
    view.classList.add('zoom-anim');
    clearTimeout(animate.t);
    animate.t = setTimeout(() => view.classList.remove('zoom-anim'), 260);
  }

  function fit(w, h) {
    if (!w || !h) return;
    const W = wrap.clientWidth, H = wrap.clientHeight;
    const k = Math.min(W / w, H / h);
    fw = Math.max(1, Math.floor(w * k));
    fh = Math.max(1, Math.floor(h * k));
    view.style.width = `${fw}px`;
    view.style.height = `${fh}px`;
    clamp();
    apply();
  }

  const api = {
    get scale() { return s; },
    fit,
    reset(anim = true) {
      if (anim) animate();
      s = 1; tx = ty = 0;
      apply();
    },
    // Zoom so an image-pixel rect fills most of the stage.
    zoomToRect([x0, y0, x1, y1], imgW, anim = true) {
      const V = stage.getBoundingClientRect();
      const k = fw / imgW; // CSS px per image px at s = 1
      const ns = Math.min(MAX, Math.max(1, 0.7 * Math.min(V.width / ((x1 - x0) * k), V.height / ((y1 - y0) * k))));
      const [ox, oy] = origin();
      if (anim) animate();
      s = ns;
      tx = V.left + V.width / 2 - ox - ((x0 + x1) / 2) * k * s;
      ty = V.top + V.height / 2 - oy - ((y0 + y1) / 2) * k * s;
      clamp();
      apply();
    },
    refit() { clamp(); apply(); },
  };

  // ------------------------------------------------------------ pointers --
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => [(a.x + b.x) / 2, (a.y + b.y) / 2];

  function startPinch() {
    const [a, b] = [...ptrs.values()];
    const [cx, cy] = mid(a, b);
    if (g?.kind === 'tool') tool.cancel();
    g = { kind: 'pinch', d0: dist(a, b), from: { s, tx, ty, cx, cy } };
  }

  wrap.addEventListener('pointerdown', (e) => {
    if (wrap.hidden) return;
    try { wrap.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    ptrs.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.size === 2) return startPinch();
    if (ptrs.size > 2) return;
    const m = mode();
    g = { kind: m === 'view' ? 'pan' : m, x0: e.clientX, y0: e.clientY, t0: performance.now(), moved: false, tx0: tx, ty0: ty };
    if (m === 'tool') tool.start(e);
    else if (m === 'split') onSplit(e);
  });

  wrap.addEventListener('pointermove', (e) => {
    const p = ptrs.get(e.pointerId);
    if (!p || !g) return;
    p.x = e.clientX;
    p.y = e.clientY;
    if (g.kind === 'pinch') {
      if (ptrs.size < 2) return;
      const [a, b] = [...ptrs.values()];
      const [cx, cy] = mid(a, b);
      zoomAt(cx, cy, g.from.s * (dist(a, b) / g.d0), g.from);
      return;
    }
    if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > 8) g.moved = true;
    if (g.kind === 'tool') tool.move(e);
    else if (g.kind === 'split') onSplit(e);
    else if (g.kind === 'pan' && s > 1) {
      tx = g.tx0 + e.clientX - g.x0;
      ty = g.ty0 + e.clientY - g.y0;
      clamp();
      apply();
    }
  });

  function end(e) {
    if (!ptrs.delete(e.pointerId) || !g) return;
    if (g.kind === 'pinch') {
      // Lifting one finger ends the pinch; the other one doesn't start a stroke.
      if (ptrs.size === 0) g = null;
      return;
    }
    if (g.kind === 'tool') tool.end(e);
    if (g.kind === 'pan' && !g.moved && e.type === 'pointerup' && performance.now() - g.t0 < 350) {
      const now = performance.now();
      if (lastTap && now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 30) {
        lastTap = null;
        onDoubleTap(e);
      } else {
        lastTap = { t: now, x: e.clientX, y: e.clientY };
        onTap(e);
      }
    }
    g = null;
  }
  wrap.addEventListener('pointerup', end);
  wrap.addEventListener('pointercancel', end);

  wrap.addEventListener('wheel', (e) => {
    if (wrap.hidden) return;
    e.preventDefault();
    // Trackpad pinch arrives as wheel + ctrlKey with small deltas.
    const k = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    zoomAt(e.clientX, e.clientY, s * k);
  }, { passive: false });

  // Safari's own pinch-zoom of the page would fight ours.
  for (const t of ['gesturestart', 'gesturechange']) document.addEventListener(t, (e) => e.preventDefault());

  new ResizeObserver(() => onResize?.()).observe(wrap);
  let onResize = null;
  api.onResize = (fn) => { onResize = fn; };
  return api;
}
