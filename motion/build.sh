#!/usr/bin/env bash
# Full pipeline for one motion piece: cue sheet -> soundtrack -> frames -> MP4.
#   motion/build.sh weeks4000            (WORKERS=2 to use two browsers on a big machine)
set -euo pipefail
PIECE=${1:-weeks4000}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="$ROOT/output/$PIECE"
mkdir -p "$OUT"

node "$ROOT/motion/$PIECE/timeline.js" > "$OUT/cues.json"
python3 "$ROOT/motion/$PIECE/soundtrack.py" "$OUT/cues.json" "$OUT/soundtrack.wav"
node "$ROOT/motion/render.js" "$PIECE" --frames --workers "${WORKERS:-1}"
python3 "$ROOT/motion/encode.py" "$OUT"
