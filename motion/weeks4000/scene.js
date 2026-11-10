/* 4,000 WEEKS — renderer.
 *
 * Every frame is a pure function of time t (no simulation state), so frames
 * can be rendered in any order, in parallel, and the film loops perfectly.
 *
 *   SCENE.ready          Promise, resolves when fonts + GPU resources are set up
 *   SCENE.render(t)      draws the frame at time t (seconds) into #gl
 *
 * Pipeline: background -> 10k instanced particles (3D, depth of field,
 * motion-blur streaks, additive HDR) -> text glow -> bloom pyramid ->
 * lens (chromatic aberration, shockwave, glitch) -> ACES -> grade -> crisp
 * typography -> grain.
 */
(function () {
  'use strict';
  const TL = window.TL, T = TL.T;
  const W = 1080, H = 1920, ASPECT = W / H;
  const SHUTTER = 1 / 60;                       // 180-degree shutter at 30 fps

  // ================================================================ math
  const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
  const mix = (a, b, t) => a + (b - a) * t;
  const sstep = (e0, e1, x) => { const t = clamp((x - e0) / (e1 - e0)); return t * t * (3 - 2 * t); };
  const lin = (e0, e1, x) => clamp((x - e0) / (e1 - e0));
  const eio3 = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  const eoExpo = t => t >= 1 ? 1 : 1 - Math.pow(2, -10 * t);
  const eiCub = t => t * t * t;
  const eoCub = t => 1 - Math.pow(1 - t, 3);
  const pulse = (t, t0, k) => t < t0 ? 0 : Math.exp(-(t - t0) * k);
  const hash = TL.hash;
  const TAU = Math.PI * 2;
  const LOOP = TL.DURATION;
  const per = (k, t, ph = 0) => Math.sin(TAU * k * t / LOOP + ph);   // loop-periodic wobble

  const V3 = (x, y, z) => [x, y, z];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const scl = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = a => scl(a, 1 / Math.hypot(a[0], a[1], a[2]));

  function lookAt(eye, f, r, u) {   // column-major view matrix from basis
    return new Float32Array([
      r[0], u[0], -f[0], 0,
      r[1], u[1], -f[1], 0,
      r[2], u[2], -f[2], 0,
      -dot(r, eye), -dot(u, eye), dot(f, eye), 1]);
  }
  function perspective(fovy, aspect, n, f) {
    const k = 1 / Math.tan(fovy / 2);
    return new Float32Array([k / aspect, 0, 0, 0, 0, k, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  }
  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s;
    }
    return o;
  }

  // monotone cubic interpolation over keyframe tables [t, v0, v1, ...]
  function makeTrack(keys) {
    const n = keys.length, ch = keys[0].length - 1;
    const slopes = [];
    for (let c = 1; c <= ch; c++) {
      const d = [], m = new Array(n).fill(0);
      for (let k = 0; k < n - 1; k++) d.push((keys[k + 1][c] - keys[k][c]) / (keys[k + 1][0] - keys[k][0]));
      for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
      for (let k = 0; k < n - 1; k++) {
        if (d[k] === 0) { m[k] = 0; m[k + 1] = 0; continue; }
        const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
        if (s > 9) { const tt = 3 / Math.sqrt(s); m[k] = tt * a * d[k]; m[k + 1] = tt * b * d[k]; }
      }
      slopes.push(m);
    }
    return function (t) {
      const out = new Array(ch);
      if (t <= keys[0][0]) { for (let c = 0; c < ch; c++) out[c] = keys[0][c + 1]; return out; }
      if (t >= keys[n - 1][0]) { for (let c = 0; c < ch; c++) out[c] = keys[n - 1][c + 1]; return out; }
      let k = 0; while (keys[k + 1][0] < t) k++;
      const t0 = keys[k][0], t1 = keys[k + 1][0], h = t1 - t0, s = (t - t0) / h;
      const h00 = 2 * s ** 3 - 3 * s ** 2 + 1, h10 = s ** 3 - 2 * s ** 2 + s, h01 = -2 * s ** 3 + 3 * s ** 2, h11 = s ** 3 - s ** 2;
      for (let c = 0; c < ch; c++) {
        out[c] = h00 * keys[k][c + 1] + h10 * h * slopes[c][k] + h01 * keys[k + 1][c + 1] + h11 * h * slopes[c][k + 1];
      }
      return out;
    };
  }

  // ================================================================ camera
  //            t      tx     ty    tz   dist   yaw    pitch  roll   fov  focusOff  aperture(px)
  const camTrack = makeTrack([
    [0.0,      0,     0,    0,   22,    0,     0,     0,     35,   0,    5],
    [2.4,      0,     0,    0,   20.5,  0,     0,     0,     35,   0,    5],
    [4.55,     0,     0,    0,   16.5,  0,     0,     0.015, 34,   0,    5],
    [4.8,      0,     0,    0,   16,    0,     0,     0,     34,   0,    4],
    [4.95,     0,     0,    0,   34,    0.10, -0.03, -0.02,  36,   0,    5],
    [5.3,      0,    -1,    0,   78,    0.38, -0.14, -0.05,  38,   0,    8],
    [5.8,      0,    -2,    0,  118,    0.52, -0.30, -0.04,  38,   0,   16],
    [7.2,     -0.5,   1.5,  0,  190,    0.14, -0.66,  0,     36,   0,   30],
    [9.6,     -0.5,   2.5,  0,  204,    0.00, -0.75,  0,     35,   0,   34],
    [10.7,    -0.5,  14,    0,  128,   -0.08, -0.62,  0,     35,   0,   34],
    [13.3,    -0.5,  13,    0,  132,   -0.04, -0.58,  0,     35,   0,   34],
    [14.5,    -0.5, -17,    0,  178,    0.05, -0.66,  0,     35,   0,   40],
    [19.0,    -0.5, -17,    0,  168,    0.14, -0.60,  0,     35,   0,   44],
    [20.4,    -0.5, -18,    0,  165,    0.10, -0.56,  0,     35,   0,   44],
    [21.1,    -0.5, -18,    0,  163,    0.08, -0.54,  0,     35, -46,   30],
    [22.5,    -0.5, -18,    0,  160,    0.04, -0.52,  0,     35, -44,   30],
    [23.6,    -0.5, -17,    0,  172,    0.00, -0.64,  0,     35,   0,   36],
    [26.3,    -0.5, -15,    0,  150,   -0.06, -0.58,  0,     35,   0,   32],
    [27.6,     0,     7,    0,  196,    0.00, -0.02,  0,     35,   0,   14],
    [29.9,     0,     7,    0,  186,   -0.11,  0.03,  0,     35,   0,   14],
    [31.0,     0,     0,    0,   22,    0,     0,     0,     35,   0,    5],
    [33.6,     0,     0,    0,   22,    0,     0,     0,     35,   0,    5],
  ]);
  const SHAKES = [[T.boom, 1.0], [T.lockEnd, 0.22], [T.swipe, 0.25], [T.land, 0.55], [T.implode, 0.4]];

  function camAt(t) {
    const [tx, ty, tz, D, yaw0, pitch0, roll0, fovDeg, focusOff, aperture] = camTrack(t);
    let yaw = yaw0 + 0.006 * per(2, t) + 0.004 * per(5, t, 1.3);
    let pitch = pitch0 + 0.005 * per(3, t, 0.7) + 0.003 * per(7, t, 2.1);
    let roll = roll0 + 0.004 * per(4, t, 2.5);
    for (const [te, a] of SHAKES) {
      if (t < te) continue;
      const e = a * Math.exp(-(t - te) * 7);
      yaw += e * 0.012 * Math.sin(t * 61 + te);
      pitch += e * 0.012 * Math.sin(t * 47 + te * 2);
      roll += e * 0.010 * Math.sin(t * 37 + te * 3);
    }
    const target = [tx, ty, tz];
    const back = [Math.sin(yaw) * Math.cos(pitch), Math.sin(pitch), Math.cos(yaw) * Math.cos(pitch)];
    const eye = add(target, scl(back, D));
    const f = scl(back, -1);
    let r = norm(cross(f, [0, 1, 0]));
    let u = cross(r, f);
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const r2 = add(scl(r, cr), scl(u, sr)), u2 = add(scl(u, cr), scl(r, -sr));
    const fov = fovDeg * Math.PI / 180;
    const view = lookAt(eye, f, r2, u2);
    const proj = perspective(fov, ASPECT, 0.5, 4000);
    return { eye, target, f, r: r2, u: u2, fov, D, view, vp: mul(proj, view),
             focus: D + focusOff, aperture, pxPerUnit: (H / 2) / Math.tan(fov / 2) };
  }
  // world -> canvas pixel (y down); returns [x, y, depth]
  function project(cam, p) {
    const m = cam.vp;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [(x / w * 0.5 + 0.5) * W, (1 - (y / w * 0.5 + 0.5)) * H, w];
  }

  // ================================================================ palette (linear HDR)
  const BASE = [1.0, 0.88, 0.74], HEROC = [1.0, 0.74, 0.42], GOLD = [1.0, 0.64, 0.26];
  const BURSTC = [1.0, 0.82, 0.6];
  const EMBER_HOT = [3.3, 1.15, 0.30], EMBER_COOL = [1.0, 0.14, 0.03];
  const SLEEPC = [0.28, 0.38, 1.65];
  const PHONEC = [0.62, 1.35, 2.3];
  const FEED = [[2.2, 0.55, 1.2], [0.5, 1.7, 2.3], [2.3, 1.6, 0.5], [1.4, 0.7, 2.4], [0.7, 2.1, 1.1]];

  // ================================================================ particle groups
  const NW = TL.NW, COLS = TL.COLS, HERO = TL.HERO;
  const pastList = []; for (let i = 0; i < NW; i++) if (TL.cls[i] === TL.PAST) pastList.push(i);
  const G = { weeks: [0, NW] };
  let off = NW;
  G.burst = [off, off += 1400];
  G.spark = [off, off += pastList.length * 2];
  G.dust = [off, off += 1400];
  G.motes = [off, off += 520];
  const NP = off;
  const STRIDE = 12;
  const inst = new Float32Array(NP * STRIDE);

  // number targets ("1,430" in dots) and phone layout are built in setup()
  let numTarget = null;              // Float32Array(N_KEEP*3)
  let phoneBasis = null;
  const PP = 0.88, PH_COLS = 17, PH_ROWS = 28;

  const o = { x: 0, y: 0, z: 0, s: 0, a: 0, r: 0, g: 0, b: 0, h: 0 };
  function setCol(c, I) { o.r = c[0] * I; o.g = c[1] * I; o.b = c[2] * I; }
  function mixCol(c1, c2, k, I) { o.r = mix(c1[0], c2[0], k) * I; o.g = mix(c1[1], c2[1], k) * I; o.b = mix(c1[2], c2[2], k) * I; }

  function ripple(d, t, te, A, v = 42) {
    if (t < te) return 0;
    const dt = t - te, x = d - v * dt;
    return A * Math.exp(-x * x / 10) * Math.exp(-dt * 1.2);
  }

  function heartbeat(t) {
    let v = 0;
    for (const hb of T.heartbeats) v += pulse(t, hb, 9) + 0.6 * pulse(t, hb + 0.24, 9);
    return v;
  }

  // ---- the hero dot: "this week"
  function heroState(t) {
    o.h = 1;
    let x = 0, y = 0, z = 0, size = 0.28, I = 4.2;
    const breathe = 1 + 0.07 * Math.sin(TAU * t / 1.2);
    if (t < T.boom) {
      const flare = sstep(0, 0.08, t) * Math.exp(-t * 3);
      const g = eiCub(lin(T.gather, 4.55, t));
      const ct = sstep(4.5, 4.78, t);
      const j = 0.07 * g;
      x += (hash(Math.floor(t * 30), 5) - 0.5) * j;
      y += (hash(Math.floor(t * 30), 6) - 0.5) * j;
      size *= (1 + 0.18 * g) * (1 - 0.5 * ct);
      I *= breathe * (1 + 1.6 * flare) * (1 + 1.7 * g) * (1 - 0.6 * ct);
      setCol(HEROC, I);
    } else if (t < T.lift) {
      const k = sstep(T.boom, T.boom + 0.6, t);
      size = mix(0.14, 0.25, k);
      I = mix(6, 3.4, k) + 1.5 * pulse(t, T.boom, 4);
      I *= 1 + 0.9 * heartbeat(t) + 0.35 * pulse(t, T.hereMark, 2.5) * (t < 14.6 ? 1 : 0);
      z += ripple(0, t, T.lockEnd, 2.2);
      const gold = sstep(24.0, 24.6, t);
      mixCol(HEROC, GOLD, gold * 0.5, I);
    } else if (t < T.implode) {
      const E = numPos(TL.keepIndex[HERO]);
      let p = flyToNumber(HERO, t, [0, 0, 0], E);
      if (t >= T.collapse) p = collapse(t, E, 1, true);
      x = p[0]; y = p[1]; z = p[2];
      size = 0.22;
      I = 3.0 + 1.5 * pulse(t, T.land, 6) + 3 * eiCub(lin(T.collapse, T.implode, t));
      setCol(GOLD, I);
    } else {
      const k = sstep(T.implode, T.implode + 0.5, t);
      size = mix(0.2, 0.28, k);
      I = 4.2 * breathe * (1 + 2.2 * pulse(t, T.implode, 3.5));
      mixCol(GOLD, HEROC, k, I);
    }
    o.x = x; o.y = y; o.z = z; o.s = size; o.a = 1;
  }

  function numPos(k) { return [numTarget[k * 3], numTarget[k * 3 + 1], numTarget[k * 3 + 2]]; }

  // grid -> number flight (26.4 -> 27.6), returns position
  function flyToNumber(i, t, S, E) {
    const st = T.lift + 0.3 * hash(i, 21);
    const u = lin(st, T.land, t), e = eio3(u);
    const cx = 0, cy = 2;
    let x = mix(S[0], E[0], e) - cx, y = mix(S[1], E[1], e) - cy;
    const ang = Math.sin(Math.PI * e) * (0.9 + 0.5 * hash(i, 22)) * (hash(i, 23) < 0.5 ? 1 : -1) * 0.8;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    const z = mix(S[2], E[2], e) + Math.sin(Math.PI * e) * 14 * (0.5 + hash(i, 24));
    return [x * ca - y * sa + cx, x * sa + y * ca + cy, z];
  }
  const D_NUM = 186, D_END = 22;
  function collapseK(t) { return Math.pow(clamp((camTrack(t)[3] - D_END) / (D_NUM - D_END)), 1.5); }
  function collapse(t, E, k, isHero) {
    const sh = t < T.collapse ? 1 : collapseK(t);
    const ang = (1 - sh) * (1 - sh) * 3.0;
    const x = E[0] * sh, y = E[1] * sh;
    const ca = Math.cos(ang), sa = Math.sin(ang);
    return [x * ca - y * sa, x * sa + y * ca, E[2] * sh];
  }

  // phone layout (world space), with feed scroll + swipe
  function scrollAmt(t) {
    if (t < T.scroll) return 0;
    const d = t - T.scroll, ramp = 1.3;
    return d < ramp ? 9 * d * d / ramp : 9 * ramp + 18 * (d - ramp);
  }
  function phoneLocal(slot, t, res) {
    const notch = slot === PH_COLS * PH_ROWS;
    let lx, ly, rowF = 0, cr = 0, a = 1;
    if (notch) { lx = 0; ly = (PH_ROWS / 2 + 0.6) * PP; }
    else {
      const col = slot % PH_COLS, row = (slot / PH_COLS) | 0;
      const sc = scrollAmt(t);
      rowF = (((row - sc) % PH_ROWS) + PH_ROWS) % PH_ROWS;
      cr = rowF + sc;
      lx = (col - (PH_COLS - 1) / 2) * PP;
      ly = ((PH_ROWS - 1) / 2 - rowF) * PP - 0.4;
      a = sstep(-0.05, 0.9, rowF) * sstep(PH_ROWS - 0.05, PH_ROWS - 0.95, rowF);
      res.col = col; res.cr = cr;
    }
    const sw = eiCub(lin(T.swipe + 0.14 * (rowF / PH_ROWS), T.swipe + 0.14 * (rowF / PH_ROWS) + 0.72, t));
    ly += sw * 105;
    a *= 1 - sstep(0.5, 1.0, sw);
    res.a = a; res.notch = notch;
    const B = phoneBasis, ca = Math.cos(B.tilt), sa = Math.sin(B.tilt);
    const px = lx * ca, pz = lx * sa;
    return add(add(add(B.c, scl(B.r, px)), scl(B.u, ly)), scl(B.f, pz));
  }
  const phRes = {};

  // ---- one of the 4,160 weeks
  function weekState(i, t) {
    if (i === HERO) return heroState(t);
    o.h = 0.35;
    if (t < T.boom) { o.a = 0; return; }
    const r = (i / COLS) | 0, c = i % COLS;
    const gx = c - 26, gy = 25 - r;
    const d0 = Math.hypot(gx, gy);
    const h1 = hash(i, 11), h2 = hash(i, 12), h3 = hash(i, 13), h4 = hash(i, 14);
    let x = gx, y = gy, z = 0, size = 0.17, I = 1.1, a = 1;
    let col = BASE;
    const tl = TL.lockT[i];

    // idle life
    z += 0.18 * Math.sin(t * 1.7 + TAU * h1) + ripple(d0, t, T.lockEnd, 2.4)
      + ripple(d0, t, T.heartbeats[0], 1.2, 36) + ripple(d0, t, T.heartbeats[1], 1.2, 36);
    I *= 0.9 + 0.1 * Math.sin(t * 2.3 + TAU * h2);

    if (t < tl) {
      // burst out of the single dot, then fly home row by row
      const u = t - T.boom;
      const th = TAU * h1, cz = 2 * h2 - 1, sz = Math.sqrt(1 - cz * cz);
      const R = (10 + 44 * Math.sqrt(h3)) * (1 - Math.exp(-3.2 * u));
      let bx = Math.cos(th) * R, by = Math.sin(th) * R * 1.25, bz = cz * R * 0.12;
      const spin = 1.25 * (1 - Math.exp(-1.4 * u));
      const cs = Math.cos(spin), sn = Math.sin(spin);
      [bx, bz] = [bx * cs - bz * sn, bx * sn + bz * cs];
      const s = eio3(lin(tl - 0.9, tl, t));
      x = mix(bx, gx, s); y = mix(by, gy, s); z = mix(bz, z, s);
      I = mix(1.25, 1.1, s);
      col = BURSTC;
      a = sstep(0, 0.05, u) * (0.4 + 0.6 * sstep(0.12, 0.7, u));
      size = mix(0.09, 0.17, s);
      mixCol(BURSTC, BASE, s, I * a);
      o.x = x; o.y = y; o.z = z; o.s = size; o.a = a;
      return;
    }
    I += 2.0 * pulse(t, tl, 7);

    const cl = TL.cls[i];
    if (cl !== TL.PHONE) I *= 1 - 0.55 * sstep(20.6, 21.3, t) * (1 - sstep(T.swipe, T.swipeEnd, t));
    if (cl === TL.PAST) {
      const u = t - TL.burnT[i];
      if (u < -0.4) setCol(BASE, I);
      else if (u < 0) {
        const k = (u + 0.4) / 0.4;
        mixCol(BASE, EMBER_HOT, k, I * (1 + 1.2 * k) / mix(1.45, 2.4, k));
        x += (hash(i, Math.floor(t * 30)) - 0.5) * 0.12 * k;
      } else {
        x += Math.sin(u * 2.1 + TAU * h3) * 0.8 * u + (h4 - 0.5) * 2.2 * u;
        y += 1.6 * u + 2.4 * u * u;
        z += (3 + 6 * h1) * u + 1.2 * u * u;
        size *= 1 - 0.55 * clamp(u / 2);
        a = 1 - sstep(0.5, 2.0 + 0.7 * h2, u);
        const fl = 0.75 + 0.25 * Math.sin(u * 23 + h4 * 40);
        mixCol(EMBER_HOT, EMBER_COOL, clamp(u / 1.3), a * fl * 0.9);
      }
      if (t > T.burn + 4.5) a = 0;
    } else if (cl === TL.SLEEP) {
      const u = t - TL.sleepT[i];
      const dim = 1 - 0.12 * sstep(15, 16, t);
      if (u < -0.5) setCol(BASE, I * dim);
      else {
        const k = clamp((u + 0.5) / 0.6);
        if (u > 0) {
          const e = clamp(u / 3.0);
          z -= 34 * e * e * (0.7 + 0.6 * h1);
          y -= 2.4 * u;
          x += Math.sin(u * 1.2 + TAU * h3) * 0.8;
          size *= 1 + 0.5 * clamp(u / 2);
          a = 1 - sstep(0.3, 3.0, u);
        }
        mixCol(BASE, SLEEPC, k, I * dim * a * mix(1, 0.9, k));
      }
    } else if (cl === TL.PHONE) {
      const dim = 1 - 0.12 * sstep(15, 16, t) + 0.12 * sstep(18.5, 19.5, t);
      const tf = TL.flyT[i];
      const P = phoneLocal(TL.phoneSlot[i], t, phRes);
      if (t < T.glitch) setCol(BASE, I * dim);
      else if (t < tf) {
        const q = Math.floor(t * 15);
        const on = hash(i, q * 3) > 0.72;
        if (on) { x += (hash(i, q * 3 + 1) - 0.5) * 1.2; y += (hash(i, q * 3 + 2) - 0.5) * 0.5; }
        mixCol(BASE, PHONEC, on ? 1 : 0.35 * lin(T.glitch, tf, t), I * (on ? 1.6 : 1));
      } else {
        const u = lin(tf, tf + 0.85, t), e = eio3(u);
        // quadratic bezier: grid -> lifted toward camera -> phone slot
        const S = [x, y, z];
        const M = add(scl(add(S, P), 0.5), [ (h2 - 0.5) * 18, 6 + 6 * h3, 26 ]);
        const k1 = (1 - e) * (1 - e), k2 = 2 * (1 - e) * e, k3 = e * e;
        x = k1 * S[0] + k2 * M[0] + k3 * P[0];
        y = k1 * S[1] + k2 * M[1] + k3 * P[1];
        z = k1 * S[2] + k2 * M[2] + k3 * P[2];
        a = mix(1, phRes.a, e);
        // feed content pattern once docked
        let fc = PHONEC, fI = 1.9;
        if (!phRes.notch && e > 0.5) {
          const blk = Math.floor((phRes.cr + 0.5) / 9), rr = ((Math.floor(phRes.cr + 0.5) % 9) + 9) % 9;
          if (rr < 6) { fc = FEED[Math.floor(hash(blk, 31) * FEED.length)]; fI = 0.85; }
          else if (rr < 8) { fI = phRes.col < (rr === 6 ? 12 : 8) ? 0.75 : 0.12; fc = PHONEC; }
          else { fI = 0.08; }
          // scanline sweeping down the screen every beat
          const sy = ((t - T.scroll) / TL.BEAT) % 1;
          fI = mix(1.9, fI, sstep(0.5, 1, e) * sstep(T.scroll - 0.4, T.scroll + 0.1, t));
          fI *= 1 + 0.35 * Math.exp(-Math.pow(((P[1] - phoneBasis.c[1]) / 14 + 1 - 2 * sy) * 6, 2));
        }
        if (phRes.notch) fI = 1.2;
        size = mix(0.21, 0.24, e);
        mixCol(PHONEC, fc, sstep(0.5, 1, e), fI * a * (1 + 1.5 * pulse(t, tf + 0.85, 6)));
      }
    } else { // KEEP — the weeks that are really yours
      const tg = 24.0 + d0 / 70;
      const g = sstep(tg, tg + 0.6, t);
      const dim = 1 - 0.12 * sstep(15, 16, t) + 0.12 * sstep(18.5, 19.5, t);
      const hb = heartbeat(t - d0 / 36);
      I *= dim * (1 + 0.25 * g + 0.8 * hb);
      if (t >= T.lift) {
        const E = numPos(TL.keepIndex[i]);
        let p = flyToNumber(i, t, [x, y, z], E);
        if (t >= T.land) {
          const dl = Math.hypot(E[0], E[1] - 2);
          p = [E[0], E[1], E[2] + ripple(dl, t, T.land, 1.6, 40) + 0.12 * Math.sin(t * 2 + TAU * h1)];
        }
        if (t >= T.collapse) {
          p = collapse(t, E, 1, false);
          const sh = collapseK(t);
          a = sstep(0.0, 0.3, sh);
        }
        x = p[0]; y = p[1]; z = p[2];
        I *= 1 + 1.1 * pulse(t, T.land - 0.05 * hash(i, 25), 7);
        mixCol(GOLD, [1, 0.8, 0.55], sstep(T.collapse, T.implode, t), I * 1.15 * a);
      } else mixCol(BASE, GOLD, g, I);
    }
    o.x = x; o.y = y; o.z = z; o.s = size; o.a = a;
  }

  function burstState(j, t) {
    o.h = 0.4;
    const u = t - T.boom, life = 0.55 + 1.1 * hash(j, 41);
    if (u < 0 || u > life) { o.a = 0; return; }
    const th = TAU * hash(j, 42), cz = 2 * hash(j, 43) - 1, sz = Math.sqrt(1 - cz * cz);
    const R = (22 + 70 * hash(j, 44)) * (1 - Math.exp(-3.2 * u));
    o.x = sz * Math.cos(th) * R; o.y = sz * Math.sin(th) * R; o.z = cz * R * 0.7;
    const k = u / life;
    o.s = 0.035 + 0.04 * hash(j, 45);
    o.a = 1;
    mixCol([3.0, 2.3, 1.5], [2.0, 0.5, 0.12], k, (1 - k) * (1 - k) * 1.0);
  }

  function sparkState(j, t) {
    o.h = 0.3;
    const i = pastList[j >> 1], k = j & 1;
    const sp = TL.burnT[i] + 0.03 + 0.3 * k * hash(j, 51);
    const life = 0.7 + 0.9 * hash(j, 52), u = t - sp;
    if (u < 0 || u > life) { o.a = 0; return; }
    const r = (i / COLS) | 0, c = i % COLS;
    const vx = (hash(j, 53) - 0.5) * 4, vy = 3 + 5 * hash(j, 54), vz = 2 + 7 * hash(j, 55);
    o.x = c - 26 + vx * u + Math.sin(u * 5 + j) * 0.35;
    o.y = 25 - r + vy * u + 2.6 * u * u;
    o.z = vz * u;
    o.s = 0.05 + 0.05 * hash(j, 56);
    o.a = 1;
    const q = u / life, fl = 0.6 + 0.4 * Math.sin(u * 40 + j);
    mixCol(EMBER_HOT, EMBER_COOL, q, (1 - q) * fl * 1.3);
  }

  let dustTint = [1, 1, 1];
  function dustState(j, t) {
    o.h = 0;
    const vis = sstep(4.85, 5.8, t) * (1 - sstep(29.9, 30.7, t));
    if (vis <= 0) { o.a = 0; return; }
    const bx = (hash(j, 61) - 0.5) * 150, by = -100 + 160 * hash(j, 62), bz = -170 + 260 * hash(j, 63);
    o.x = bx + 3 * per(1 + (j % 3), t, TAU * hash(j, 64));
    o.y = by + 2.5 * per(1 + (j % 2), t, TAU * hash(j, 65)) + 0.6 * Math.sin(t * 0.7 + j);
    o.z = bz + 3 * per(2, t, TAU * hash(j, 66));
    o.s = 0.1 + 0.22 * hash(j, 67);
    o.a = 1;
    const I = 0.26 * (0.3 + hash(j, 68)) * vis;
    setCol(dustTint, I);
  }

  function moteState(j, t) {
    o.h = 0.2;
    const vis = 1 - sstep(4.6, 4.8, t) + sstep(31.3, 32.8, t);
    if (t > 4.8 && t < 31.3) { o.a = 0; return; }
    const rad0 = 2.6 + 9 * Math.sqrt(hash(j, 71));
    const ang = TAU * hash(j, 72) + TAU * (1 + (j % 3)) * t / LOOP * (hash(j, 73) < 0.5 ? 1 : -1);
    let rad = rad0, I = 0.55 * (0.3 + hash(j, 74));
    let zz = (hash(j, 75) - 0.5) * 12;
    if (t < 4.8) {
      const ts = T.gather + 2.1 * hash(j, 76);
      const p = clamp((t - ts) / (4.72 - ts));
      const e = eiCub(p);
      rad *= 1 - e; zz *= 1 - e;
      I *= (1 + 4 * e) * (1 - sstep(0.9, 1, p));
    }
    const a2 = ang + (t < 4.8 ? 2.5 * eiCub(clamp((t - T.gather) / 2.4)) : 0);
    o.x = Math.cos(a2) * rad; o.y = Math.sin(a2) * rad * 1.1; o.z = zz;
    o.s = 0.010 + 0.016 * hash(j, 77);
    o.a = j < 300 ? 1 : 0;
    setCol([1.0, 0.8, 0.55], I * vis * 1.6);
  }

  function evalAll(t, posOnly) {
    let p = 0;
    const put = (idx) => {
      const b = idx * STRIDE;
      if (posOnly) { inst[b + 4] = o.x; inst[b + 5] = o.y; inst[b + 6] = o.z; return; }
      inst[b] = o.x; inst[b + 1] = o.y; inst[b + 2] = o.z; inst[b + 3] = o.s;
      inst[b + 7] = o.a > 0.002 ? 1 : 0;
      inst[b + 8] = o.r; inst[b + 9] = o.g; inst[b + 10] = o.b; inst[b + 11] = o.h;
    };
    for (let i = 0; i < NW; i++) { o.a = 1; weekState(i, t); put(G.weeks[0] + i); }
    for (let j = 0; j < 1400; j++) { burstState(j, t); put(G.burst[0] + j); }
    for (let j = 0; j < pastList.length * 2; j++) { sparkState(j, t); put(G.spark[0] + j); }
    for (let j = 0; j < 1400; j++) { dustState(j, t); put(G.dust[0] + j); }
    for (let j = 0; j < 520; j++) { moteState(j, t); put(G.motes[0] + j); }
  }

  // ================================================================ look (per-time grading)
  //               t     bgTop                 bgBot                  nebula                 dust tint
  const lookTrack = makeTrack([
    [0.0,   0.004, 0.004, 0.007,  0.006, 0.005, 0.006,  0.020, 0.012, 0.006,  1.0, 0.8, 0.6],
    [4.6,   0.004, 0.004, 0.007,  0.006, 0.005, 0.006,  0.030, 0.018, 0.010,  1.0, 0.8, 0.6],
    [5.4,   0.005, 0.006, 0.012,  0.007, 0.006, 0.010,  0.030, 0.028, 0.040,  0.9, 0.85, 1.0],
    [9.6,   0.004, 0.005, 0.010,  0.006, 0.005, 0.008,  0.020, 0.022, 0.035,  0.9, 0.85, 1.0],
    [11.0,  0.008, 0.004, 0.003,  0.010, 0.005, 0.004,  0.060, 0.018, 0.006,  1.3, 0.55, 0.3],
    [14.0,  0.007, 0.004, 0.003,  0.009, 0.005, 0.004,  0.050, 0.016, 0.006,  1.2, 0.6, 0.35],
    [15.2,  0.003, 0.004, 0.014,  0.004, 0.005, 0.016,  0.012, 0.018, 0.070,  0.5, 0.6, 1.4],
    [18.8,  0.003, 0.004, 0.014,  0.004, 0.005, 0.016,  0.012, 0.018, 0.070,  0.5, 0.6, 1.4],
    [20.0,  0.003, 0.007, 0.011,  0.003, 0.006, 0.010,  0.006, 0.040, 0.055,  0.5, 1.0, 1.3],
    [23.4,  0.003, 0.007, 0.011,  0.003, 0.006, 0.010,  0.006, 0.040, 0.055,  0.5, 1.0, 1.3],
    [24.2,  0.003, 0.003, 0.004,  0.004, 0.003, 0.004,  0.010, 0.008, 0.006,  1.0, 0.8, 0.6],
    [26.4,  0.004, 0.003, 0.003,  0.006, 0.004, 0.003,  0.040, 0.026, 0.010,  1.2, 0.85, 0.5],
    [28.0,  0.006, 0.004, 0.003,  0.008, 0.005, 0.003,  0.070, 0.040, 0.012,  1.2, 0.85, 0.5],
    [30.5,  0.004, 0.004, 0.006,  0.006, 0.005, 0.006,  0.030, 0.018, 0.008,  1.0, 0.8, 0.6],
    [33.6,  0.004, 0.004, 0.007,  0.006, 0.005, 0.006,  0.020, 0.012, 0.006,  1.0, 0.8, 0.6],
  ]);
  //              t     exposure bloom  ca     vignette sat   gainR gainG gainB
  const postTrack = makeTrack([
    [0.0,   1.00,  0.20,  0.0016, 0.95, 1.00,  1.00, 1.00, 1.00],
    [4.6,   1.05,  0.24,  0.0040, 1.05, 1.00,  1.00, 1.00, 1.00],
    [5.2,   1.00,  0.20,  0.0022, 0.95, 1.00,  1.00, 1.00, 1.00],
    [10.8,  1.00,  0.22,  0.0020, 0.95, 1.05,  1.04, 0.99, 0.95],
    [14.6,  1.00,  0.24,  0.0024, 1.05, 0.92,  0.94, 0.98, 1.06],
    [19.2,  1.00,  0.22,  0.0024, 0.95, 1.00,  0.97, 1.00, 1.04],
    [23.6,  0.95,  0.20,  0.0020, 1.10, 0.95,  1.00, 1.00, 1.00],
    [26.4,  1.00,  0.24,  0.0020, 1.00, 1.05,  1.04, 1.00, 0.96],
    [30.0,  1.00,  0.24,  0.0020, 0.95, 1.05,  1.04, 1.00, 0.96],
    [31.2,  1.00,  0.22,  0.0016, 0.95, 1.00,  1.00, 1.00, 1.00],
    [33.6,  1.00,  0.20,  0.0016, 0.95, 1.00,  1.00, 1.00, 1.00],
  ]);
  function fxAt(t) {
    const [exposure, bloom, ca, vig, sat, gr, gg, gb] = postTrack(t);
    let flash = 0.6 * pulse(t, T.boom, 32) + 0.10 * pulse(t, T.lockEnd, 28) + 0.10 * pulse(t, T.land, 30) + 0.35 * pulse(t, T.implode, 30);
    let caK = ca + 0.010 * pulse(t, T.boom, 5) + 0.004 * pulse(t, T.land, 6) + 0.006 * pulse(t, T.implode, 5)
      + 0.004 * sstep(T.gather, 4.78, t) * (t < T.boom ? 1 : 0);
    let glitch = 0;
    if (t > T.glitch && t < T.fly + 0.3) glitch = 0.35 * (hash(Math.floor(t * 15), 81) > 0.6 ? 1 : 0.15);
    glitch += 0.9 * sstep(T.swipe, T.swipe + 0.15, t) * (1 - sstep(T.swipe + 0.4, T.swipeEnd + 0.1, t));
    const shock = [
      [T.boom, 0.5, 0.5], [T.land, 0.5, 0.58], [T.implode, 0.5, 0.5],
    ].map(([te, cx, cy]) => t >= te && t < te + 1.2 ? [cx, cy, (t - te) * 1.1, 0.03 * Math.exp(-(t - te) * 3.5)] : null).filter(Boolean)[0] || [0.5, 0.5, 0, 0];
    return { exposure, bloom, ca: caK, vig, sat, gain: [gr, gg, gb], flash, glitch, shock };
  }

  // ================================================================ WebGL
  const canvas = document.getElementById('gl');
  const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) throw new Error('WebGL2 required');
  gl.getExtension('EXT_color_buffer_float');
  gl.getExtension('OES_texture_float_linear');

  function shader(type, src) {
    const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) + '\n' + src);
    return s;
  }
  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, shader(gl.VERTEX_SHADER, vs)); gl.attachShader(p, shader(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const u = {}; const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) { const info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p, u };
  }
  function tex(w, h, internal, format, type, filter = gl.LINEAR) {
    const t = gl.createTexture(); gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }
  function target(w, h) {
    const t = tex(w, h, gl.RGBA16F, gl.RGBA, gl.HALF_FLOAT);
    const f = gl.createFramebuffer(); gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    return { t, f, w, h };
  }

  const FS_VS = `#version 300 es
  out vec2 vUv;
  void main(){ vec2 p = vec2((gl_VertexID << 1) & 2, gl_VertexID & 2); vUv = p; gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0); }`;

  const BG_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform vec3 uTop, uBot, uNeb; uniform vec2 uOff;
  float h(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float n(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(h(i), h(i+vec2(1,0)), f.x), mix(h(i+vec2(0,1)), h(i+1.0), f.x), f.y); }
  void main(){
    vec2 p = vUv * vec2(1.7, 3.0) + uOff;
    float v = 0.5*n(p) + 0.25*n(p*2.03+3.1) + 0.125*n(p*4.01+7.7);
    float neb = pow(smoothstep(0.35, 0.9, v), 2.0);
    float r = length((vUv - vec2(0.5, 0.55)) * vec2(1.0, 1.6));
    vec3 c = mix(uBot, uTop, vUv.y) + uNeb * neb * (1.0 - 0.6 * r);
    o = vec4(c, 1.0);
  }`;

  const P_VS = `#version 300 es
  precision highp float;
  layout(location=0) in vec2 aCorner;
  layout(location=1) in vec4 aA;      // pos, size
  layout(location=2) in vec4 aB;      // prev pos, visible
  layout(location=3) in vec4 aC;      // rgb, halo
  uniform mat4 uVP, uVPprev, uV;
  uniform vec2 uRes; uniform float uPx, uFocus, uAperture, uMaxCoc;
  out vec2 vP; flat out vec2 vA; flat out vec2 vB; flat out float vR; flat out float vCore; flat out float vBlur; flat out float vHalo; flat out vec3 vCol; flat out float vExt;
  void main(){
    vec4 ca = uVP * vec4(aA.xyz, 1.0);
    vec4 cb = uVPprev * vec4(aB.xyz, 1.0);
    float depth = -(uV * vec4(aA.xyz, 1.0)).z;
    if (aB.w < 0.5 || depth < 1.0 || dot(aC.rgb, vec3(1.0)) < 1e-4) { gl_Position = vec4(3.0, 3.0, 3.0, 1.0); return; }
    if (cb.w < 1.0) cb = ca;
    vec2 sa = (ca.xy / ca.w * 0.5 + 0.5) * uRes;
    vec2 sb = (cb.xy / cb.w * 0.5 + 0.5) * uRes;
    float r = aA.w * uPx / depth;
    float coc = min(uAperture * abs(1.0 - uFocus / depth), uMaxCoc);
    float R = sqrt(r * r + coc * coc);
    float energy = 1.0;
    if (R < 0.8) { energy = (R * R) / 0.64; R = 0.8; }
    float halo = aC.w;
    float hs = max(r, 0.8) * 1.7;
    float ext = max(R + 2.0, halo > 0.0 ? hs * 2.4 : 0.0);
    vec2 ax = sa - sb; float L = length(ax);
    vec2 dir = L > 0.01 ? ax / L : vec2(1.0, 0.0);
    vec2 nr = vec2(-dir.y, dir.x);
    vec2 c = 0.5 * (sa + sb);
    vec2 p = c + dir * aCorner.x * (0.5 * L + ext) + nr * aCorner.y * ext;
    gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
    vP = p; vA = sa; vB = sb; vR = R; vCore = max(r, 0.8); vExt = ext;
    vBlur = clamp(coc / R, 0.0, 1.0);
    float area = (r * r + 0.7) / (R * R + 0.7);
    energy *= mix(area, pow(area, 0.62), vBlur);
    energy *= (2.0 * R + 1.0) / (2.0 * R + 1.0 + L);
    vCol = aC.rgb * energy;
    vHalo = halo * (1.0 - vBlur);
  }`;

  const P_FS = `#version 300 es
  precision highp float;
  in vec2 vP; flat in vec2 vA; flat in vec2 vB; flat in float vR; flat in float vCore; flat in float vBlur; flat in float vHalo; flat in vec3 vCol; flat in float vExt;
  out vec4 o;
  void main(){
    vec2 ab = vB - vA; float l2 = dot(ab, ab);
    float hh = l2 > 1e-4 ? clamp(dot(vP - vA, ab) / l2, 0.0, 1.0) : 0.0;
    float d = length(vP - (vA + ab * hh));
    float disc = clamp(vR - d + 0.5, 0.0, 1.0);
    float core = exp(-d * d / (vCore * vCore * 0.45));
    float rim = smoothstep(vR * 0.55, vR, d) * disc;
    float bokeh = disc * (0.8 + 0.45 * rim);
    float sharp = 0.55 * disc + 0.9 * core;
    float v = mix(sharp, bokeh, vBlur);
    float hs = vCore * 1.7;
    float win = 1.0 - (d / vExt) * (d / vExt);
    v += vHalo * 0.3 * exp(-d * d / (hs * hs)) * max(win, 0.0) * max(win, 0.0);
    o = vec4(vCol * v, 1.0);
  }`;

  const TEXTGLOW_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uText; uniform float uGain;
  void main(){ vec4 t = texture(uText, vec2(vUv.x, 1.0 - vUv.y)); o = vec4(pow(t.rgb, vec3(2.2)) * uGain, 1.0); }`;

  const DOWN_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc; uniform vec2 uTexel; uniform int uKaris;
  vec3 s(vec2 d){ return texture(uSrc, vUv + d * uTexel).rgb; }
  float w(vec3 c){ return 1.0 / (1.0 + dot(c, vec3(0.2126, 0.7152, 0.0722))); }
  void main(){
    vec3 a=s(vec2(-2,2)), b=s(vec2(0,2)), c=s(vec2(2,2)), d=s(vec2(-2,0)), e=s(vec2(0,0)), f=s(vec2(2,0));
    vec3 g=s(vec2(-2,-2)), h=s(vec2(0,-2)), i=s(vec2(2,-2)), j=s(vec2(-1,1)), k=s(vec2(1,1)), l=s(vec2(-1,-1)), m=s(vec2(1,-1));
    vec3 col;
    if (uKaris == 1) {
      vec3 g0=(a+b+d+e)*0.25, g1=(b+c+e+f)*0.25, g2=(d+e+g+h)*0.25, g3=(e+f+h+i)*0.25, g4=(j+k+l+m)*0.25;
      float w0=w(g0), w1=w(g1), w2=w(g2), w3=w(g3), w4=w(g4);
      col = (g0*w0*0.125 + g1*w1*0.125 + g2*w2*0.125 + g3*w3*0.125 + g4*w4*0.5) / (w0*0.125 + w1*0.125 + w2*0.125 + w3*0.125 + w4*0.5);
    } else {
      col = e*0.125 + (a+c+g+i)*0.03125 + (b+d+f+h)*0.0625 + (j+k+l+m)*0.125;
    }
    o = vec4(col, 1.0);
  }`;

  const UP_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uSrc; uniform vec2 uTexel; uniform float uRad, uMix;
  vec3 s(vec2 d){ return texture(uSrc, vUv + d * uTexel * uRad).rgb; }
  void main(){
    vec3 c = s(vec2(0))*4.0 + (s(vec2(-1,0))+s(vec2(1,0))+s(vec2(0,1))+s(vec2(0,-1)))*2.0
           + s(vec2(-1,-1))+s(vec2(1,-1))+s(vec2(-1,1))+s(vec2(1,1));
    o = vec4(c / 16.0 * uMix, 1.0);
  }`;

  const FINAL_FS = `#version 300 es
  precision highp float; in vec2 vUv; out vec4 o;
  uniform sampler2D uHdr, uBloom, uText;
  uniform vec2 uRes; uniform float uExposure, uBloomStr, uCA, uVig, uSat, uFlash, uGlitch, uFrame, uGrain;
  uniform vec3 uGain; uniform vec4 uShock;
  float hsh(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
  vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14), 0.0, 1.0); }
  vec3 scene(vec2 uv){ return texture(uHdr, uv).rgb + texture(uBloom, uv).rgb * uBloomStr; }
  void main(){
    vec2 uv = vUv;
    // shockwave ring
    if (uShock.w > 0.0) {
      vec2 d = (uv - uShock.xy) * vec2(1.0, uRes.y / uRes.x);
      float r = length(d), x = r - uShock.z;
      uv -= normalize(d + 1e-6) * uShock.w * exp(-x * x * 400.0) * vec2(1.0, uRes.x / uRes.y);
    }
    // digital glitch: displaced horizontal slices
    if (uGlitch > 0.0) {
      float band = floor(uv.y * 48.0);
      float rnd = hsh(vec2(band, floor(uFrame * 0.5)));
      if (rnd > 1.0 - 0.35 * uGlitch) uv.x += (hsh(vec2(band, uFrame)) - 0.5) * 0.08 * uGlitch;
    }
    vec2 dc = uv - 0.5;
    vec2 off = dc * (uCA + 0.012 * uGlitch);
    vec3 col = vec3(scene(uv + off).r, scene(uv).g, scene(uv - off).b);
    col = col * uExposure + uFlash * vec3(1.0, 0.92, 0.8);
    col = aces(col) * uGain;
    float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(l), col, uSat);
    float v = length(dc * vec2(1.0, 1.25));
    col *= mix(1.0, smoothstep(0.95, 0.25, v), 0.55 * uVig);
    col = pow(max(col, 0.0), vec3(1.0 / 2.2));
    vec4 tx = texture(uText, vec2(vUv.x, 1.0 - vUv.y));
    col = col * (1.0 - tx.a) + tx.rgb;
    float g = hsh(gl_FragCoord.xy + vec2(uFrame * 37.0, uFrame * 17.0)) - 0.5;
    col += g * uGrain * (0.55 + 0.45 * (1.0 - l));
    col += (hsh(gl_FragCoord.yx + uFrame) - 0.5) / 255.0;
    o = vec4(col, 1.0);
  }`;

  const progBg = program(FS_VS, BG_FS);
  const progP = program(P_VS, P_FS);
  const progTG = program(FS_VS, TEXTGLOW_FS);
  const progDown = program(FS_VS, DOWN_FS);
  const progUp = program(FS_VS, UP_FS);
  const progFinal = program(FS_VS, FINAL_FS);

  const hdr = target(W, H);
  const mips = [];
  for (let i = 1, w = W >> 1, h = H >> 1; i <= 7; i++, w >>= 1, h >>= 1) mips.push(target(Math.max(w, 2), Math.max(h, 2)));

  const emptyVao = gl.createVertexArray();
  const pVao = gl.createVertexArray();
  gl.bindVertexArray(pVao);
  const quad = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, quad);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  const ibuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
  gl.bufferData(gl.ARRAY_BUFFER, inst.byteLength, gl.DYNAMIC_DRAW);
  for (let k = 0; k < 3; k++) {
    gl.enableVertexAttribArray(1 + k);
    gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, STRIDE * 4, k * 16);
    gl.vertexAttribDivisor(1 + k, 1);
  }
  gl.bindVertexArray(null);

  const textCanvas = document.createElement('canvas');
  textCanvas.width = W; textCanvas.height = H;
  const ctx = textCanvas.getContext('2d');
  const textTex = tex(W, H, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);

  function fsPass(prog, fb, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb); gl.viewport(0, 0, w, h);
    gl.useProgram(prog.p); gl.bindVertexArray(emptyVao);
  }
  function bindTex(prog, name, unit, t) {
    gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t); gl.uniform1i(prog.u[name], unit);
  }

  // ================================================================ typography
  const SERIF = 'italic 400 {s}px ISerif';
  const SANS = (w) => `${w} {s}px IDisp`;
  const MONO = '500 {s}px JBM';
  const font = (f, s) => f.replace('{s}', s);
  const ACC = { ember: '#FF8A3D', sleep: '#9AA8FF', phone: '#7FE3FF', gold: '#FFC56B' };

  // t0/t1: in/out times. in: rise|mask|type, out: up|fade|mask|glitch
  const TEXTS = [
    { t0: 0.25, t1: 2.15, y: 640, text: 'THIS IS', f: SANS(500), s: 40, track: 16, color: 'rgba(255,255,255,0.78)', in: 'rise', out: 'up' },
    { t0: 0.40, t1: 2.15, y: 790, text: 'ONE WEEK', f: SANS(900), s: 156, track: -2, in: 'mask', out: 'up' },
    { t0: 0.85, t1: 2.15, y: 880, text: 'of your life.', f: SERIF, s: 96, in: 'rise', out: 'up' },
    { t0: 2.55, t1: 4.45, y: 820, text: 'Your whole life?', f: SERIF, s: 110, in: 'rise', out: 'up', stagger: 0.035 },

    { t0: 7.35, t1: 9.25, y: 300, text: 'if you make it to 80.', f: SERIF, s: 78, color: 'rgba(255,255,255,0.88)', in: 'rise', out: 'up' },

    { t0: 9.6, t1: 14.05, y: 255, text: "If you're 25,", f: SERIF, s: 84, in: 'rise', out: 'up' },
    { t0: 10.15, t1: 14.05, y: 345, text: '1,300 ARE ALREADY GONE.', f: SANS(800), s: 64, track: 1, in: 'mask', out: 'up', accent: [0, 5, ACC.ember] },

    { t0: 14.4, t1: 18.95, y: 255, text: "You'll sleep through", f: SERIF, s: 84, in: 'rise', out: 'up' },
    { t0: 14.9, t1: 18.95, y: 345, text: '953 MORE.', f: SANS(800), s: 64, track: 1, in: 'mask', out: 'up', accent: [0, 3, ACC.sleep] },
    { t0: 15.5, t1: 18.95, y: 395, text: '8 HRS A NIGHT', f: MONO, s: 24, track: 6, color: 'rgba(190,200,255,0.75)', in: 'type', out: 'fade' },

    { t0: 19.2, t1: 23.15, y: 255, text: 'Your phone takes', f: SERIF, s: 84, in: 'rise', out: 'glitch' },
    { t0: 19.7, t1: 23.15, y: 345, text: '477 MORE.', f: SANS(800), s: 64, track: 1, in: 'mask', out: 'glitch', accent: [0, 3, ACC.phone] },
    { t0: 20.3, t1: 23.15, y: 395, text: '4 HRS OF SCREEN A DAY', f: MONO, s: 24, track: 6, color: 'rgba(170,240,255,0.75)', in: 'type', out: 'glitch' },

    { t0: 24.05, t1: 26.15, y: 330, text: "So what's left?", f: SERIF, s: 118, in: 'rise', out: 'up', stagger: 0.04 },

    { t0: 27.75, t1: 29.85, y: 1190, text: 'weeks that are really yours.', f: SERIF, s: 70, color: 'rgba(255,255,255,0.9)', in: 'rise', out: 'up' },
    { t0: 28.5, t1: 29.85, y: 1295, text: 'MAKE THEM COUNT.', f: SANS(900), s: 76, track: 2, color: ACC.gold, in: 'mask', out: 'up', glow: 'rgba(255,170,60,0.55)' },

    { t0: 31.3, t1: 32.85, y: 790, text: 'THIS WEEK', f: SANS(900), s: 156, track: -2, in: 'mask', out: 'up' },
    { t0: 31.75, t1: 32.85, y: 880, text: 'is one of them.', f: SERIF, s: 96, in: 'rise', out: 'up' },
  ];
  const layoutCache = new Map();
  function layout(s) {
    if (layoutCache.has(s)) return layoutCache.get(s);
    ctx.font = font(s.f, s.s);
    const chars = [...s.text], xs = [];
    for (let i = 0; i < chars.length; i++) xs.push(ctx.measureText(s.text.slice(0, i)).width + i * (s.track || 0));
    const width = ctx.measureText(s.text).width + (chars.length - 1) * (s.track || 0);
    const L = { chars, xs, width, ws: chars.map(ch => ctx.measureText(ch).width) };
    layoutCache.set(s, L);
    return L;
  }

  function drawText(s, t) {
    const L = layout(s), n = L.chars.length;
    const st = s.stagger ?? (s.in === 'type' ? 0.028 : 0.022);
    const din = s.in === 'mask' ? 0.55 : s.in === 'type' ? 0.05 : 0.7;
    const dout = 0.38, stOut = 0.012;
    if (t < s.t0 || t > s.t1 + dout + n * stOut + 0.05) return;
    const x0 = (s.x ?? W / 2) - L.width / 2;
    ctx.font = font(s.f, s.s);
    ctx.textBaseline = 'alphabetic';
    for (let i = 0; i < n; i++) {
      const ch = L.chars[i];
      if (ch === ' ') continue;
      let pin = clamp((t - s.t0 - i * st) / din);
      let pout = clamp((t - s.t1 - i * stOut) / dout);
      if (pin <= 0) continue;
      let dx = 0, dy = 0, alpha = 1, blur = 0, clip = false;
      if (s.in === 'rise') { const e = eoExpo(pin); dy += (1 - e) * s.s * 0.45; alpha *= e; blur += (1 - e) * 14; }
      else if (s.in === 'mask') { const e = eoExpo(pin); dy += (1 - e) * s.s * 1.05; clip = true; }
      else if (s.in === 'type') { alpha *= pin > 0 ? 1 : 0; }
      if (pout > 0) {
        if (s.out === 'up') { const e = eiCub(pout); dy -= e * s.s * 0.5; alpha *= 1 - e; blur += e * 16; }
        else if (s.out === 'mask') { const e = eiCub(pout); dy -= e * s.s * 1.05; clip = true; }
        else if (s.out === 'fade') { alpha *= 1 - pout; }
        else if (s.out === 'glitch') {
          const q = Math.floor(t * 30);
          alpha *= (1 - pout) * (hash(i * 7 + q, 91) > pout * 0.8 ? 1 : 0);
          dx += (hash(i + q * 13, 92) - 0.5) * 60 * pout;
        }
      }
      if (alpha <= 0.003) continue;
      let color = s.color || '#ffffff';
      if (s.accent && i >= s.accent[0] && i < s.accent[1]) color = s.accent[2];
      const x = x0 + L.xs[i] + dx, y = s.y + dy;
      ctx.save();
      if (clip) { ctx.beginPath(); ctx.rect(x - s.s * 0.2, s.y - s.s * 1.0, L.ws[i] + s.s * 0.4, s.s * 1.28); ctx.clip(); }
      ctx.globalAlpha = alpha;
      if (blur > 0.4) ctx.filter = `blur(${blur.toFixed(1)}px)`;
      const glow = s.glow || (s.accent && i >= s.accent[0] && i < s.accent[1] ? hexA(s.accent[2], 0.55) : null);
      ctx.shadowColor = glow || 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = glow ? 28 : 22;
      ctx.fillStyle = color;
      ctx.fillText(ch, x, y);
      ctx.restore();
    }
    // typewriter cursor
    if (s.in === 'type' && t < s.t1) {
      const k = clamp((t - s.t0) / (n * st)), shown = Math.floor(k * n);
      if (k < 1 || Math.floor(t * 3) % 2 === 0) {
        const cx = x0 + (shown < n ? L.xs[shown] : L.width + (s.track || 0));
        ctx.fillStyle = s.color || '#fff';
        ctx.fillRect(cx, s.y - s.s * 0.8, s.s * 0.55, s.s * 0.95);
      }
    }
  }
  function hexA(hex, a) {
    const v = parseInt(hex.slice(1), 16);
    return `rgba(${v >> 16},${(v >> 8) & 255},${v & 255},${a})`;
  }

  // odometer counter
  const CNT = { y: 590, s: 220 };
  function counterDigits(v) {
    // classic odometer: digit k rolls only while the lower digits pass 9 -> 0
    const out = [];
    for (let k = 3; k >= 0; k--) {
      const p = Math.pow(10, k);
      const lower = v % p;
      const base = Math.floor(v / p);
      const roll = k === 0 ? v % 1 : clamp(lower - (p - 1));
      out.push((base % 10) + roll);
    }
    return out;
  }
  const cntCanvas = document.createElement('canvas');
  cntCanvas.width = W; cntCanvas.height = 300;
  const cctx = cntCanvas.getContext('2d');
  function drawCounter(t) {
    const tIn = T.boom, tOut = 22.75;
    if (t < tIn || t > tOut + 0.5) return;
    const a = sstep(tIn, tIn + 0.25, t) * (1 - lin(tOut, tOut + 0.45, t));
    if (a <= 0) return;
    const pop = 1 + 0.35 * Math.exp(-(t - tIn) * 9) + 0.06 * pulse(t, T.lockEnd, 10);
    const glitching = t > tOut;
    // digits with real motion blur: accumulate shutter samples additively, white on transparent
    const BY = 240;                       // baseline inside the counter canvas
    cctx.clearRect(0, 0, W, 300);
    cctx.font = font(SANS(900), CNT.s);
    cctx.textBaseline = 'alphabetic';
    const cw = cctx.measureText('0').width * 1.02, comma = cctx.measureText(',').width;
    const total = cw * 4 + comma, x0 = W / 2 - total / 2;
    const samples = 8, lineH = CNT.s;
    const vNow = Math.max(0, TL.counterValue(t));
    for (let k = 0; k < 4; k++) {
      const cellX = x0 + (k >= 1 ? comma : 0) + k * cw;
      const lead = vNow < Math.pow(10, 3 - k) && k < 3;
      cctx.save();
      cctx.beginPath(); cctx.rect(cellX - 6, BY - CNT.s * 0.9, cw + 12, CNT.s * 1.0); cctx.clip();
      cctx.globalCompositeOperation = 'lighter';
      const gx = glitching ? (hash(k * 3 + Math.floor(t * 30), 94) - 0.5) * 50 : 0;
      const rate = Math.abs(TL.counterValue(t) - TL.counterValue(t - 1 / 30)) * 30 / Math.pow(10, 3 - k);
      if (rate > 5) {
        cctx.globalAlpha = lead ? 0.25 : 1;
        cctx.fillStyle = '#fff';
        const digit = String(Math.floor(vNow / Math.pow(10, 3 - k)) % 10);
        cctx.fillText(digit, cellX + (cw - cctx.measureText(digit).width) / 2 + gx, BY);
        cctx.restore();
        continue;
      }
      for (let sIdx = 0; sIdx < samples; sIdx++) {
        const v = Math.max(0, TL.counterValue(t - SHUTTER * 1.5 * sIdx / samples));
        const dpos = counterDigits(v)[k];
        const dbase = Math.floor(dpos), fr = dpos - dbase;
        cctx.globalAlpha = (lead ? 0.25 : 1) / samples;
        cctx.fillStyle = '#fff';
        for (let q = 0; q < 2; q++) {
          const digit = String((dbase + q) % 10);
          if (q === 1 && fr < 1e-3) continue;
          cctx.fillText(digit, cellX + (cw - cctx.measureText(digit).width) / 2 + gx, BY + (fr - q) * lineH);
        }
      }
      cctx.restore();
    }
    cctx.globalAlpha = vNow < 1000 ? 0.25 : 1;
    cctx.fillStyle = '#fff';
    cctx.fillText(',', x0 + cw, BY);
    cctx.globalAlpha = 1;

    ctx.save();
    ctx.globalAlpha = a * (glitching ? (hash(Math.floor(t * 30), 93) > 0.4 ? 1 : 0.25) : 1);
    const cy = CNT.y - CNT.s * 0.36;
    ctx.translate(W / 2, cy); ctx.scale(pop, pop); ctx.translate(-W / 2, -cy);
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 30;
    ctx.drawImage(cntCanvas, 0, CNT.y - BY);
    ctx.restore();

    // label
    const label = t < 9.85 ? 'WEEKS' : 'WEEKS LEFT';
    ctx.save();
    ctx.globalAlpha = a * 0.8 * (t > 9.6 && t < 9.85 ? 1 - lin(9.6, 9.75, t) : 1) * (t >= 9.85 ? lin(9.85, 10.0, t) : 1);
    ctx.font = font(MONO, 26);
    ctx.fillStyle = '#fff';
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 16;
    const lab = [...label].join('\u200A\u200A\u200A');
    const lw = ctx.measureText(lab).width;
    ctx.fillText(lab, W / 2 - lw / 2, CNT.y + 62);
    ctx.restore();
  }

  // HUD: age scale + "you are here" + phone frame
  function drawHUD(t, cam) {
    // age ruler on the left edge of the grid
    const aIn = sstep(7.3, 7.9, t) * (1 - sstep(13.9, 14.4, t));
    if (aIn > 0) {
      ctx.save();
      ctx.font = font(MONO, 20);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(255,255,255,0.5)';
      ctx.lineWidth = 1.5;
      for (let age = 0; age <= 80; age += 10) {
        const k = clamp((t - 7.3 - age * 0.006) / 0.3);
        if (k <= 0) continue;
        const row = Math.min(age, 79);
        const p = project(cam, [-27.4, 25 - row + (age === 80 ? -0.6 : 0), 0]);
        const q = project(cam, [-26.6, 25 - row + (age === 80 ? -0.6 : 0), 0]);
        if (p[2] < 1) continue;
        ctx.globalAlpha = aIn * k * 0.7 * (age === TL.AGE ? 1 : 1);
        const txt = age === 0 ? 'AGE 0' : String(age);
        const tw = ctx.measureText(txt).width;
        ctx.fillText(txt, p[0] - tw - 10, p[1] + 7);
        ctx.beginPath(); ctx.moveTo(p[0] - 4, p[1]); ctx.lineTo(q[0], q[1]); ctx.stroke();
      }
      ctx.restore();
    }
    // YOU ARE HERE
    const yIn = lin(T.hereMark, T.hereMark + 0.45, t) * (1 - sstep(14.2, 14.55, t));
    if (yIn > 0) {
      const hp = project(cam, [0, 0, 0]);
      const e = eoCub(yIn);
      ctx.save();
      ctx.strokeStyle = 'rgba(255,215,150,0.95)';
      ctx.fillStyle = 'rgba(255,225,170,1)';
      ctx.lineWidth = 2;
      ctx.shadowColor = 'rgba(255,160,60,0.8)'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(hp[0], hp[1], 16 + 8 * (1 - e), 0, TAU * e); ctx.stroke();
      const lx = hp[0] + 18, ly = hp[1] - 18, ex = lx + 90 * e, ey = ly - 90 * e;
      ctx.beginPath(); ctx.moveTo(lx, ly); ctx.lineTo(ex, ey); ctx.lineTo(ex + 40 * e, ey); ctx.stroke();
      ctx.font = font(MONO, 24);
      const txt = 'YOU ARE HERE';
      const shown = txt.slice(0, Math.floor(clamp((t - T.hereMark - 0.25) / 0.35) * txt.length));
      ctx.fillText(shown, ex + 50, ey + 8);
      ctx.restore();
    }
    // phone frame
    const fIn = lin(20.85, 21.35, t) * (1 - sstep(T.swipe + 0.3, T.swipe + 0.65, t));
    if (fIn > 0 && phoneBasis) {
      const sw = eiCub(lin(T.swipe, T.swipe + 0.72, t)) * 105;
      const B = phoneBasis, ca = Math.cos(B.tilt), sa = Math.sin(B.tilt);
      const hw = (PH_COLS - 1) / 2 * PP + 1.6, hh = PH_ROWS / 2 * PP + 2.0, rad = 3.2;
      const pts = [];
      const corner = (cx, cy, a0) => { for (let k = 0; k <= 8; k++) { const a = a0 + k / 8 * Math.PI / 2; pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]); } };
      corner(hw - rad, hh - rad, 0); corner(-hw + rad, hh - rad, Math.PI / 2);
      corner(-hw + rad, -hh + rad, Math.PI); corner(hw - rad, -hh + rad, Math.PI * 1.5);
      const sp = pts.map(([lx, ly]) => project(cam, add(add(add(B.c, scl(B.r, lx * ca)), scl(B.u, ly + sw - 0.2)), scl(B.f, lx * sa))));
      // perimeter draw-on
      let per = 0; const seg = [];
      for (let k = 0; k < sp.length; k++) { const a = sp[k], b = sp[(k + 1) % sp.length]; const l = Math.hypot(b[0] - a[0], b[1] - a[1]); seg.push(l); per += l; }
      ctx.save();
      ctx.strokeStyle = 'rgba(160,235,255,0.85)';
      ctx.lineWidth = 3;
      ctx.shadowColor = 'rgba(90,200,255,0.9)'; ctx.shadowBlur = 18;
      ctx.globalAlpha = sstep(0, 0.2, fIn) * (glitchFlicker(t));
      ctx.setLineDash([per * eoCub(fIn), per]);
      ctx.beginPath(); ctx.moveTo(sp[0][0], sp[0][1]);
      for (let k = 1; k <= sp.length; k++) ctx.lineTo(sp[k % sp.length][0], sp[k % sp.length][1]);
      ctx.stroke();
      ctx.restore();
    }
  }
  function glitchFlicker(t) { return t > T.swipe ? (hash(Math.floor(t * 30), 95) > 0.3 ? 1 : 0.3) : 1; }

  function drawOverlay(t, cam) {
    ctx.clearRect(0, 0, W, H);
    drawHUD(t, cam);
    drawCounter(t);
    for (const s of TEXTS) drawText(s, t);
  }

  // ================================================================ setup
  async function setup() {
    await Promise.all([
      '300 20px IDisp', '500 20px IDisp', '800 20px IDisp', '900 20px IDisp',
      'italic 400 20px ISerif', '400 20px JBM', '500 20px JBM',
    ].map(f => document.fonts.load(f)));
    await document.fonts.ready;

    // ---- "1,430" as 1,430 dots
    const oc = document.createElement('canvas'); oc.width = 1500; oc.height = 560;
    const c2 = oc.getContext('2d');
    c2.fillStyle = '#fff'; c2.font = '900 430px IDisp'; c2.textBaseline = 'alphabetic';
    const label = '1,430';
    const tw = c2.measureText(label).width;
    c2.fillText(label, (oc.width - tw) / 2, 460);
    const img = c2.getImageData(0, 0, oc.width, oc.height).data;
    const inside = (x, y) => { x = Math.round(x); y = Math.round(y); return x >= 0 && y >= 0 && x < oc.width && y < oc.height && img[(y * oc.width + x) * 4 + 3] > 140; };
    const sampleAt = (sp) => {
      const pts = [];
      for (let row = 0, y = 0; y < oc.height; row++, y += sp * 0.866) for (let x = (row % 2) * sp / 2; x < oc.width; x += sp) if (inside(x, y)) pts.push([x, y]);
      return pts;
    };
    let lo = 4, hi = 40;
    for (let it = 0; it < 30; it++) { const m = (lo + hi) / 2; if (sampleAt(m).length >= TL.N_KEEP) lo = m; else hi = m; }
    let pts = sampleAt(lo);
    pts.sort((a, b) => hash(Math.round(a[0] * 7 + a[1] * 13), 3) - hash(Math.round(b[0] * 7 + b[1] * 13), 3));
    pts = pts.slice(0, TL.N_KEEP);
    const widthU = 58, s = widthU / tw;
    pts = pts.map(([x, y]) => [(x - oc.width / 2) * s, (300 - y) * s + 7.0]);
    // assign: sort both sets by x so the weeks rise up into the digits
    const keep = []; for (let i = 0; i < NW; i++) if (TL.cls[i] === TL.KEEP) keep.push(i);
    const keepByX = keep.slice().sort((a, b) => ((a % COLS) + hash(a, 9) * 0.9) - ((b % COLS) + hash(b, 9) * 0.9));
    const ptsByX = pts.map((p, k) => [p, k]).sort((a, b) => a[0][0] - b[0][0]);
    numTarget = new Float32Array(TL.N_KEEP * 3);
    keepByX.forEach((i, k) => {
      const p = ptsByX[k][0];
      const ki = TL.keepIndex[i];
      numTarget[ki * 3] = p[0]; numTarget[ki * 3 + 1] = p[1]; numTarget[ki * 3 + 2] = (hash(i, 26) - 0.5) * 1.6;
    });

    // ---- phone frame: faces the camera as it is at 21.0 s, floating 46 units in front of the grid
    const cam = camAt(21.0);
    const back = scl(cam.f, -1);
    phoneBasis = { c: add(add(cam.target, scl(back, 46)), scl(cam.u, -8.5)), r: cam.r, u: cam.u, f: back, tilt: 0.17 };
  }

  // ================================================================ render
  let frameNo = 0;
  function render(t) {
    const cam = camAt(t), camPrev = camAt(t - SHUTTER);
    const lk = lookTrack(t);
    dustTint = [lk[9], lk[10], lk[11]];
    evalAll(t, false);
    evalAll(t - SHUTTER, true);
    const fx = fxAt(t);
    frameNo++;

    // overlay canvas (text + HUD) -> texture
    drawOverlay(t, cam);
    gl.bindTexture(gl.TEXTURE_2D, textTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, textCanvas);

    // background
    gl.disable(gl.BLEND);
    fsPass(progBg, hdr.f, W, H);
    gl.uniform3f(progBg.u.uTop, lk[0], lk[1], lk[2]);
    gl.uniform3f(progBg.u.uBot, lk[3], lk[4], lk[5]);
    gl.uniform3f(progBg.u.uNeb, lk[6], lk[7], lk[8]);
    gl.uniform2f(progBg.u.uOff, 0.3 * Math.sin(TAU * t / LOOP), 0.25 * Math.cos(TAU * t / LOOP) - cam.target[1] * 0.004);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // particles
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(progP.p);
    gl.uniformMatrix4fv(progP.u.uVP, false, cam.vp);
    gl.uniformMatrix4fv(progP.u.uVPprev, false, camPrev.vp);
    gl.uniformMatrix4fv(progP.u.uV, false, cam.view);
    gl.uniform2f(progP.u.uRes, W, H);
    gl.uniform1f(progP.u.uPx, cam.pxPerUnit);
    gl.uniform1f(progP.u.uFocus, cam.focus);
    gl.uniform1f(progP.u.uAperture, cam.aperture);
    gl.uniform1f(progP.u.uMaxCoc, 56);
    gl.bindVertexArray(pVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, ibuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, NP);

    // text glow into the HDR scene (so the bloom catches it)
    fsPass(progTG, hdr.f, W, H);
    bindTex(progTG, 'uText', 0, textTex);
    gl.uniform1f(progTG.u.uGain, 0.22);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // bloom pyramid
    gl.disable(gl.BLEND);
    let src = hdr;
    mips.forEach((m, i) => {
      fsPass(progDown, m.f, m.w, m.h);
      bindTex(progDown, 'uSrc', 0, src.t);
      gl.uniform2f(progDown.u.uTexel, 1 / src.w, 1 / src.h);
      gl.uniform1i(progDown.u.uKaris, i === 0 ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      src = m;
    });
    gl.enable(gl.BLEND); gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = mips.length - 1; i > 0; i--) {
      const from = mips[i], to = mips[i - 1];
      fsPass(progUp, to.f, to.w, to.h);
      bindTex(progUp, 'uSrc', 0, from.t);
      gl.uniform2f(progUp.u.uTexel, 1 / from.w, 1 / from.h);
      gl.uniform1f(progUp.u.uRad, 1.0);
      gl.uniform1f(progUp.u.uMix, i >= 4 ? 0.5 : 0.8);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.BLEND);

    // final composite
    fsPass(progFinal, null, W, H);
    bindTex(progFinal, 'uHdr', 0, hdr.t);
    bindTex(progFinal, 'uBloom', 1, mips[0].t);
    bindTex(progFinal, 'uText', 2, textTex);
    const u = progFinal.u;
    gl.uniform2f(u.uRes, W, H);
    gl.uniform1f(u.uExposure, fx.exposure);
    gl.uniform1f(u.uBloomStr, fx.bloom);
    gl.uniform1f(u.uCA, fx.ca);
    gl.uniform1f(u.uVig, fx.vig);
    gl.uniform1f(u.uSat, fx.sat);
    gl.uniform1f(u.uFlash, fx.flash);
    gl.uniform1f(u.uGlitch, fx.glitch);
    gl.uniform1f(u.uFrame, Math.round(t * TL.FPS));
    gl.uniform1f(u.uGrain, 0.035);
    gl.uniform3f(u.uGain, fx.gain[0], fx.gain[1], fx.gain[2]);
    gl.uniform4f(u.uShock, fx.shock[0], fx.shock[1], fx.shock[2], fx.shock[3]);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.finish();
  }

  window.SCENE = { ready: setup(), render, W, H, camAt, project };
})();
