/* 4,000 WEEKS — shared timeline + data model.
 *
 * Everything that has to be in sync between picture and sound lives here:
 * the musical grid (100 BPM, 14 bars = 33.6 s, loops seamlessly), the story
 * beats, and the per-week "life model" (which dot burns, sleeps, gets eaten
 * by the phone, and when). Works in the browser (window.TL) and in node:
 *
 *     node motion/weeks4000/timeline.js > cues.json     # for the soundtrack
 */
(function (root) {
  'use strict';

  const BPM = 100;
  const BEAT = 60 / BPM;          // 0.6 s
  const BAR = 4 * BEAT;           // 2.4 s
  const FPS = 30;
  const DURATION = 14 * BAR;      // 33.6 s, end state == start state (loop)

  const COLS = 52, ROWS = 80, NW = COLS * ROWS;   // 4,160 weeks = 80 years
  const AGE = 25;
  const HERO = AGE * COLS + 26;                   // "this week" for a 25-year-old

  const N_PAST = AGE * COLS;                      // 1,300
  const LEFT_AFTER_PAST = NW - N_PAST;            // 2,860
  const N_SLEEP = Math.round(LEFT_AFTER_PAST / 3);   // 8 h of 24 -> 953
  const N_PHONE = Math.round(LEFT_AFTER_PAST / 6);   // 4 h of 24 -> 477
  const N_KEEP = LEFT_AFTER_PAST - N_SLEEP - N_PHONE; // 1,430

  // story beats (seconds)
  const T = {
    hookText: 0.25,
    gather: 1 * BAR,        // 2.4  energy gathers into the dot
    boom: 2 * BAR,          // 4.8  explosion -> 4,160 dots
    lockStart: 5.6,         // grid assembles row by row (age 0 -> 80)
    lockEnd: 3 * BAR,       // 7.2  last row locks, downbeat
    pastText: 4 * BAR,      // 9.6  "If you're 25,"
    burn: 4.5 * BAR,        // 10.8 rows 0-24 burn away
    hereMark: 13.0,
    sleepText: 6 * BAR,     // 14.4 "You'll sleep through"
    sleep: 15.0,
    phoneText: 8 * BAR,     // 19.2 "Your phone takes"
    glitch: 19.5,
    fly: 20.2,              // dots rip out and become a phone
    scroll: 21.3,           // the phone starts scrolling them away
    swipe: 22.6,            // swipe up: gone
    swipeEnd: 23.4,
    cut: 23.6,              // music cuts to silence
    left: 10 * BAR,         // 24.0 "So what's left?"
    heartbeats: [24.6, 25.8],
    lift: 11 * BAR,         // 26.4 the remaining weeks lift off
    land: 11.5 * BAR,       // 27.6 ...and land as the number 1,430
    collapse: 12.5 * BAR,   // 30.0 the number implodes
    implode: 31.0,          // ...into one single week
    endText: 31.3,          // "THIS WEEK is one of them."
    end: DURATION,
  };

  // ---------------------------------------------------------------- helpers
  function hash(i, s) {
    let x = (Math.imul(i | 0, 374761393) + Math.imul((s | 0) + 1, 668265263)) | 0;
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    x ^= x >>> 16;
    return (x >>> 0) / 4294967296;
  }
  function smooth(t) { return t * t * (3 - 2 * t); }
  function vnoise(x, y) {
    const ix = Math.floor(x), iy = Math.floor(y), fx = smooth(x - ix), fy = smooth(y - iy);
    const h = (a, b) => hash(a * 7919 + b * 104729, 99);
    const a = h(ix, iy), b = h(ix + 1, iy), c = h(ix, iy + 1), d = h(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  // ---------------------------------------------------------------- model
  const PAST = 0, SLEEP = 1, PHONE = 2, KEEP = 3;
  const cls = new Uint8Array(NW);
  const phoneSlot = new Int16Array(NW).fill(-1);
  const keepIndex = new Int16Array(NW).fill(-1);
  const lockT = new Float32Array(NW), burnT = new Float32Array(NW), sleepT = new Float32Array(NW), flyT = new Float32Array(NW);

  const cand = [];
  for (let i = 0; i < NW; i++) {
    const r = (i / COLS) | 0, c = i % COLS;
    lockT[i] = T.lockStart + 1.44 * (r / (ROWS - 1)) + 0.12 * (c / (COLS - 1)) + 0.04 * hash(i, 1);
    if (r < AGE) {
      cls[i] = PAST;
      burnT[i] = T.burn + 2.1 * (r / (AGE - 1)) + 0.35 * vnoise(c * 0.22, r * 0.35) + 0.12 * hash(i, 2);
    } else if (i !== HERO) cand.push(i);
  }
  cand.sort((a, b) => hash(a, 7) - hash(b, 7));
  cand.forEach((i, k) => {
    const r = (i / COLS) | 0;
    if (k < N_SLEEP) {
      cls[i] = SLEEP;
      sleepT[i] = T.sleep + 2.3 * hash(i, 3) + 0.25 * ((r - AGE) / (ROWS - AGE - 1));
    } else if (k < N_SLEEP + N_PHONE) {
      cls[i] = PHONE;
      flyT[i] = T.fly + 0.45 * hash(i, 4);
    } else cls[i] = KEEP;
  });
  cls[HERO] = KEEP;
  // phone slots in reading order of the original grid (top-left first)
  let ps = 0, ks = 0;
  for (let i = 0; i < NW; i++) {
    if (cls[i] === PHONE) phoneSlot[i] = ps++;
    if (cls[i] === KEEP) keepIndex[i] = ks++;
  }

  function sortedTimes(arr, which) {
    const out = [];
    for (let i = 0; i < NW; i++) if (which(i)) out.push(arr[i]);
    return Float64Array.from(out).sort();
  }
  const lockSorted = sortedTimes(lockT, () => true);
  const burnSorted = sortedTimes(burnT, i => cls[i] === PAST);
  const sleepSorted = sortedTimes(sleepT, i => cls[i] === SLEEP);

  // continuous "how many events happened by t" (for the rolling counter)
  function countBy(sorted, t) {
    let lo = 0, hi = sorted.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sorted[m] <= t) lo = m + 1; else hi = m; }
    if (lo === 0 || lo === sorted.length) return lo;
    const a = sorted[lo - 1], b = sorted[lo];
    return lo - 1 + Math.min(1, (t - a) / Math.max(1e-6, b - a)) * 1;
  }
  function counterValue(t) {
    if (t < T.boom) return 0;
    let v = countBy(lockSorted, t);
    v -= countBy(burnSorted, t);
    v -= countBy(sleepSorted, t);
    const s = Math.min(1, Math.max(0, (t - T.swipe) / (T.swipeEnd - T.swipe)));
    v -= N_PHONE * smooth(s);
    return v;
  }

  const TL = {
    BPM, BEAT, BAR, FPS, DURATION, COLS, ROWS, NW, AGE, HERO,
    N_PAST, N_SLEEP, N_PHONE, N_KEEP, LEFT_AFTER_PAST,
    PAST, SLEEP, PHONE, KEEP,
    T, cls, phoneSlot, keepIndex, lockT, burnT, sleepT, flyT,
    hash, vnoise, counterValue,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = TL;
    if (require.main === module) {
      // cue sheet for the soundtrack
      const rowLock = [];
      for (let r = 0; r < ROWS; r++) rowLock.push(+(T.lockStart + 1.44 * (r / (ROWS - 1)) + 0.06).toFixed(4));
      const pick = (arr, f) => { const o = []; for (let i = 0; i < NW; i++) if (f(i)) o.push(+arr[i].toFixed(4)); return o.sort((a, b) => a - b); };
      process.stdout.write(JSON.stringify({
        bpm: BPM, beat: BEAT, bar: BAR, fps: FPS, duration: DURATION, T,
        counts: { total: NW, past: N_PAST, sleep: N_SLEEP, phone: N_PHONE, keep: N_KEEP },
        rowLock,
        burn: pick(burnT, i => cls[i] === PAST),
        sleep: pick(sleepT, i => cls[i] === SLEEP),
        fly: pick(flyT, i => cls[i] === PHONE),
      }, null, 1));
    }
  } else {
    root.TL = TL;
  }
})(typeof window !== 'undefined' ? window : this);
