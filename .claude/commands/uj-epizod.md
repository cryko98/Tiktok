---
description: Új Grubb epizód megírása és legyártása
---

1. Olvasd el a `vilag/grubb.md` fájlt és a `tortenet/naplo.md` végét (eddigi epizódok).
2. Írd meg a következő epizódot `episodes/epNNN_rovid_nev.json` néven, ugyanabban a formátumban,
   mint `episodes/ep000_hello.json` (csak a világleírásban felsorolt `expr` / `action` értékeket használd).
   Ha a felhasználó adott témát: $ARGUMENTS
3. Gyártsd le: `python make_episode.py episodes/epNNN_....json`
   (GPU nélkül: `--engine CYCLES --scale 0.5`).
4. Írd hozzá a `tortenet/naplo.md` végéhez az epizód 1–2 mondatos összefoglalóját.
5. Add meg a felhasználónak: a kész MP4 útját, a TikTok-leírást hashtagekkel, és emlékeztesd,
   hogy feltöltéskor kapcsolja be az „AI-generated content” címkét.
