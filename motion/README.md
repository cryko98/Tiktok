# Motion – kódból renderelt motion design TikTokra

Itt nincsenek sablonok, stock-elemek és licencelt zene. Minden képkocka WebGL2-ben készül
headless Chromiumban: 3D részecskék mélységélességgel (bokeh), bemozdulásos elmosással
(motion blur csíkok), HDR bloommal, kromatikus aberrációval és filmszemcsével. A hangsáv
numpy/scipy-jal szintetizált saját zene, a képhez képkockára szinkronizálva.

## 4,000 WEEKS (`weeks4000/`)

33,6 mp, 1080×1920, 30 fps, 100 BPM, D-moll. A vége pontosan az elejébe fut, így TikTokon
végtelenítve újra és újra lejátszódik.

| idő | jelenet |
|---|---|
| 0–2,4 | Egyetlen izzó pont: *THIS IS ONE WEEK of your life.* |
| 2,4–4,8 | *Your whole life?* – a por beszívódik a pontba, a pont összehúzódik… |
| 4,8 | robbanás: 4 160 pont (80 év × 52 hét), sugárirányú warp-csíkok |
| 5,6–7,2 | a rács soronként összeáll (0 → 80 év), mindegyik sor egy emelkedő hangot ad, a számláló felpörög |
| 9,6–14,4 | *If you're 25, 1,300 are already gone.* – az első 25 sor parázzsá ég |
| 14,4–19,2 | *You'll sleep through 953 more.* – kék bokeh, víz alatti hangzás, lélegzés |
| 19,2–23,6 | *Your phone takes 477 more.* – a pontok kitépődnek, telefonná állnak, a feed elgörgeti őket, swipe up |
| 23,6–26,4 | csend, szívverés: *So what's left?* |
| 26,4–30 | a megmaradt hetek örvényben a **1,430** számmá állnak: *weeks that are really yours. MAKE THEM COUNT.* |
| 30–33,6 | a szám egyetlen ponttá omlik: *THIS WEEK is one of them.* → loop |

A számok egy 80 éves életet feltételeznek (4 160 hét), 25 éves nézővel, napi 8 óra alvással
és napi 4 óra telefonnal: 4160 − 1300 − 953 − 477 = 1430.

## Gyártás

Kell hozzá Node 18+, Python 3 (`numpy`, `scipy`) és ffmpeg.

```bash
cd motion && npm install && npx playwright install chromium && cd ..
pip install numpy scipy
motion/build.sh weeks4000          # cue-lista -> hang -> képkockák -> output/weeks4000/weeks4000.mp4
```

Gyors próbaképek adott időpontokból (a `output/weeks4000/stills/` mappába):

```bash
node motion/render.js weeks4000 --stills 0.6,5.3,8.5,12,16,21.8,26.9,28.9,31.8
```

Böngészős előnézet (lassú, de élő): indíts egy statikus szervert a `motion/` mappában
(`python3 -m http.server`), majd nyisd meg: `http://localhost:8000/weeks4000/index.html?play`.

| fájl | szerep |
|---|---|
| `weeks4000/timeline.js` | közös idővonal és „életmodell”: melyik pont mikor ég el, alszik el, megy a telefonba (kép és hang is ebből dolgozik) |
| `weeks4000/scene.js` | a renderelő: kamera, részecskék, tipográfia, utómunka |
| `weeks4000/soundtrack.py` | a teljes hangsáv szintézise |
| `render.js` | képkocka-export headless Chromiumból |
| `encode.py` | kétmenetes hangosság-normalizálás (−14 LUFS) és H.264 kódolás |

Minden képkocka az idő tiszta függvénye, ezért bármelyik szakasz külön újrarenderelhető
(`--frames --from 300 --to 420 --force`).
