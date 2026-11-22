// One-tap looks: each is a combination of the regular face settings plus
// optional light settings for the whole photo. Values are at 100 % strength.
export const LOOKS = [
  { id: 'natural', name: 'Natürlich',
    face: { smooth: 35, glow: 15, teeth: 30, eyeSize: 8 },
    light: { brightness: 5, contrast: 6 } },
  { id: 'glamour', name: 'Glamour',
    face: { smooth: 60, glow: 30, teeth: 60, lip: 55, lipColor: '#a2263a', blush: 30, blushColor: '#e0707a',
      shadow: 35, shadowColor: '#8a6a4f', eyeSize: 15, slim: 30, nose: 20 },
    light: { contrast: 15, saturation: 10, warmth: 15 } },
  { id: 'sweet', name: 'Puppig',
    face: { smooth: 70, glow: 40, eyeSize: 45, nose: 35, slim: 35, chin: -20, blush: 45, blushColor: '#f08c7a',
      lip: 35, lipColor: '#e0806f' },
    light: { brightness: 10, saturation: 10 } },
  { id: 'bold', name: 'Intensiv',
    face: { smooth: 80, glow: 35, eyeSize: 35, slim: 60, nose: 45, smile: 30, teeth: 50, lip: 70, lipColor: '#8e1b2c',
      shadow: 60, shadowColor: '#4f5d75' },
    light: { contrast: 30, saturation: 25 } },
  { id: 'sunny', name: 'Sonnig',
    face: { smooth: 40, glow: 45, blush: 25, blushColor: '#f08c7a', teeth: 30 },
    light: { brightness: 8, saturation: 15, warmth: 40 } },
  { id: 'groomed', name: 'Gepflegt',
    face: { smooth: 40, teeth: 40, beard: 35, beardColor: '#3a2a20', slim: 20 },
    light: { contrast: 10, warmth: 5 } },
  { id: 'beard', name: 'Vollbart',
    face: { beard: 95, beardColor: '#2a1f19', smooth: 20 },
    light: { contrast: 8 } },
  { id: 'smile', name: 'Lächeln',
    face: { smile: 65, teeth: 50 },
    light: {} },
  { id: 'classic', name: 'Klassik',
    face: { smooth: 30 },
    light: { saturation: -100, contrast: 25 } },
];

const LIGHT_KEYS = ['brightness', 'contrast', 'saturation', 'warmth'];

// Writes a look at the given strength (0..100) into the face and global
// settings, starting from the defaults so looks don't stack on each other.
export function applyLook(look, strength, face, global, faceDefaults, globalDefaults) {
  const k = strength / 100;
  Object.assign(face, faceDefaults);
  for (const key of LIGHT_KEYS) global[key] = globalDefaults[key];
  for (const [key, v] of Object.entries(look.face)) face[key] = typeof v === 'number' ? Math.round(v * k) : v;
  for (const [key, v] of Object.entries(look.light)) global[key] = Math.round(v * k);
}
