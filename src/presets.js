// One-tap looks: each is a combination of the regular face settings plus
// optional light settings for the whole photo. Values are at 100 % strength.
// Kept subtle and unisex: retouching that real photo apps use (texture-
// preserving smoothing, under-eye, eyes, teeth) plus a colour filter.
export const LOOKS = [
  { id: 'natural', name: 'Natürlich',
    face: { smooth: 40, glow: 15, underEye: 45, eyesBright: 30, teeth: 25 },
    light: { filter: 'clear', filterStrength: 45 } },
  { id: 'fresh', name: 'Frisch',
    face: { smooth: 50, glow: 30, underEye: 55, eyesBright: 40, teeth: 35, blush: 12, blushColor: '#e88a80' },
    light: { filter: 'golden', filterStrength: 40, brightness: 6 } },
  { id: 'soft', name: 'Weich',
    face: { smooth: 65, glow: 35, underEye: 60, eyesBright: 25, teeth: 25 },
    light: { filter: 'pastel', filterStrength: 55 } },
  { id: 'glamour', name: 'Glamour',
    face: { smooth: 60, glow: 30, underEye: 60, eyesBright: 50, teeth: 45, lip: 40, lipColor: '#a8323f',
      blush: 18, blushColor: '#e0707a', shadow: 28, shadowColor: '#8a6a4f', slim: 12 },
    light: { filter: 'golden', filterStrength: 30, contrast: 8 } },
  { id: 'film', name: 'Film',
    face: { smooth: 30, underEye: 35, eyesBright: 20 },
    light: { filter: 'film', filterStrength: 85 } },
  { id: 'cinema', name: 'Kino',
    face: { smooth: 30, underEye: 35, eyesBright: 30 },
    light: { filter: 'cinema', filterStrength: 80 } },
  { id: 'groomed', name: 'Gepflegt',
    face: { smooth: 35, underEye: 45, eyesBright: 35, teeth: 35 },
    light: { filter: 'clear', filterStrength: 40 } },
  { id: 'smile', name: 'Lächeln',
    face: { smile: 55, teeth: 40, eyesBright: 20 },
    light: {} },
  { id: 'classic', name: 'Schwarzweiß',
    face: { smooth: 30, underEye: 35, eyesBright: 30 },
    light: { filter: 'noir', filterStrength: 100 } },
];

const LIGHT_KEYS = ['brightness', 'contrast', 'saturation', 'warmth', 'filter', 'filterStrength'];

// Writes a look at the given strength (0..100) into the face and global
// settings, starting from the defaults so looks don't stack on each other.
export function applyLook(look, strength, face, global, faceDefaults, globalDefaults) {
  const k = strength / 100;
  // Hair colour is not part of any look, so keep it.
  const { hair, hairColor } = face;
  Object.assign(face, faceDefaults, { hair, hairColor });
  for (const key of LIGHT_KEYS) global[key] = globalDefaults[key];
  for (const [key, v] of Object.entries(look.face)) face[key] = typeof v === 'number' ? Math.round(v * k) : v;
  for (const [key, v] of Object.entries(look.light)) global[key] = typeof v === 'number' ? Math.round(v * k) : v;
}
