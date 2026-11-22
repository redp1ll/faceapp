# Facette

Web-App zur Gesichtsbearbeitung. Läuft komplett im Browser (Smartphone und PC). Fotos verlassen das Gerät nicht.

## Funktionen

| Bereich | Was es macht |
|---|---|
| **Looks** | Fertige Filter mit einem Tipp: Natürlich, Glamour, Puppig, Intensiv, Sonnig, Gepflegt, Vollbart, Lächeln, Klassik (Schwarzweiß), jeweils mit Stärke-Regler |
| **Haut** | Glätten (kantenerhaltend, nur auf Hautflächen), Strahlen, Zähne aufhellen |
| **Make-up** | Lippenstift, Rouge, Lidschatten, jeweils mit Farbwahl |
| **Augen** | Augenfarbe (Pupille bleibt dunkel), Augen vergrößern |
| **Haare** | Haarfarbe ändern, Schattierung bleibt erhalten |
| **Bart** | Bartstoppeln bis Vollbart, folgt der Wuchsrichtung |
| **Form** | Gesicht schmaler, Nase schmaler, Lächeln, Kinnlänge |
| **Licht** | Helligkeit, Kontrast, Sättigung, Wärme |

**Mehrere Gesichter:** Auf Gruppenfotos wählst du das Gesicht über die Vorschauleiste oder tippst es im Bild an. Jedes Gesicht hat eigene Einstellungen, auch die Haarfarbe: Die Haare werden der nächstgelegenen Person zugeordnet. Nur das Licht gilt für das ganze Foto.

Dazu kommen ein Vorher/Nachher-Vergleich mit verschiebbarer Trennlinie, Drag & Drop und eine Kamera-Aufnahme.

**Speichern in voller Auflösung:** Bearbeitet wird zügig auf einer Vorschau mit höchstens 1600 px. Beim Speichern wird das Foto in Originalgröße neu berechnet, bis maximal 4096 px bzw. 12,6 Megapixel. Ein 12-MP-iPhone-Foto (4032 × 3024) bleibt dabei unverändert groß. Ausgabe als JPEG mit 92 % Qualität.

**Galerie:** Jede Bearbeitung wird automatisch auf dem Gerät gespeichert (IndexedDB): das Originalfoto, alle Einstellungen und ein Vorschaubild. Gespeichert werden die letzten 40 Bearbeitungen. Über „Galerie“ oder „Zuletzt bearbeitet“ lässt sich jede Bearbeitung wieder öffnen und weiterbearbeiten.

## Auf dem iPhone

Die App in Safari öffnen, dann **Teilen → Zum Home-Bildschirm**. Danach startet sie wie eine normale App, mit eigenem Symbol und ohne Safari-Leiste. **Speichern** öffnet das iOS-Teilen-Menü, und **„Bild sichern“** legt das Foto in der Fotos-App ab.

## Wie es funktioniert

- **Gesichtserkennung:** [MediaPipe Face Landmarker](https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker) findet 478 Punkte im Gesicht, inklusive Iris. Weil sein Detektor das Foto auf 128 × 128 px verkleinert, würde er kleine Gesichter auf Gruppenfotos übersehen. Deshalb wird das Foto zusätzlich in überlappenden Ausschnitten auf zwei feineren Stufen durchsucht. Jeder Treffer aus einem Ausschnitt wird vom MediaPipe Face Detector (`blaze_face_short_range`) noch einmal bewertet, um Fehltreffer wie Hände oder Bilder an der Wand auszusortieren (`src/vision.js`).
- **Haare und Gesichtshaut:** Der MediaPipe-Segmentierer `selfie_multiclass_256x256` trennt Haare, Gesichtshaut und Hintergrund.
- **Masken:** Aus den Punkten werden weiche Masken für Haut, Lippen, Iris, Lidschatten, Rouge und Bart berechnet (`src/analysis.js`).
- **Effekte:** Umfärben über die Luminanz, Multiplizieren oder Weichzeichnen (`src/render.js`). Gesichtsform über glatte lokale Verformungen (`src/warp.js`).

Alle Modelle stehen unter Apache-2.0. Es gibt keinen Server und keine Cloud-API.

## Entwicklung

```bash
npm install
npm run dev      # lädt beim ersten Start die Modelle nach public/models
npm run build    # statischer Build in dist/ (z. B. für GitHub Pages, Netlify, Vercel)
```

Die Modelle (~20 MB) und die WASM-Laufzeit werden von `scripts/fetch-models.mjs` nach `public/` gelegt und sind nicht eingecheckt.

## Ideen für später

KI-Effekte wie Alterung, Verjüngung oder eine neue Frisur brauchen ein generatives Modell auf einem GPU-Server oder einen KI-Dienst (z. B. Replicate oder fal.ai).
