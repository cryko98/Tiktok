# Grubb – TikTok animációs sorozat-gyár

Egy saját 3D karakter (**Grubb**, *„...still here.”*) rövid epizódjait gyártja le
egy JSON forgatókönyvből: felolvasás → szájmozgás → Blender-animáció → feliratos 1080×1920 MP4.

```
grubb/character.py   a karakter, egyszerű formákból (saját szellemi tulajdon)
grubb/stage.py       sziget-díszlet, fények, kamera
grubb/animate.py     forgatókönyv-idővonal -> animált képkockák (Blenderben fut)
make_episode.py      az egész folyamat egy paranccsal
episodes/            epizód-forgatókönyvek (JSON)
vilag/grubb.md       világleírás – ezt olvassa Claude új rész előtt
tortenet/naplo.md    eddigi epizódok
.claude/commands/    /uj-epizod parancs Claude Code-hoz
```

## Telepítés a laptopon (egyszer)

1. [Blender](https://www.blender.org/download/) (4.2 vagy újabb) és [ffmpeg](https://ffmpeg.org/download.html) telepítése,
   mindkettő legyen elérhető parancssorból (`blender`, `ffmpeg`), vagy add meg a Blender útját
   a `BLENDER` környezeti változóban.
2. Python csomagok és a hang letöltése:
   ```bash
   python -m venv .venv
   source .venv/bin/activate          # Windows: .venv\Scripts\activate
   pip install -r requirements.txt
   python setup_voice.py
   ```

## Epizód gyártása

```bash
python make_episode.py episodes/ep000_hello.json
```

A kész videó: `output/ep000_hello.mp4`. Ha nincs rendes videókártya, a lassabb, de mindenhol működő mód:

```bash
python make_episode.py episodes/ep000_hello.json --engine CYCLES --scale 0.5
```

## Claude Code-dal

A repó mappájában indítsd a `claude`-ot, és írd be:

```
/uj-epizod
```

vagy témával: `/uj-epizod Grubb dobozban csempészi vissza magát`. Claude megírja a forgatókönyvet,
legyártja a videót, és megadja a TikTok-leírást.

## Feltöltés

Egyelőre kézzel (telefonról vagy a TikTok Studio-ban ütemezve, amerikai esti idősávra).
Mindig kapcsold be az **AI-generated content** címkét. Licencek: lásd `CREDITS.md`.
