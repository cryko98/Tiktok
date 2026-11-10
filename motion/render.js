#!/usr/bin/env node
/* Renders a motion piece to PNG frames with headless Chromium (WebGL2), in parallel.
 *
 *   node motion/render.js weeks4000 --stills 0.5,5.2,8          # quick look at a few moments
 *   node motion/render.js weeks4000 --frames [--from 0 --to 1008] [--workers 3]
 *
 * Frames land in output/<piece>/frames/f_00000.png; stills in output/<piece>/stills/.
 * Each frame is a pure function of time, so workers just take every Nth frame.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = __dirname;
const args = process.argv.slice(2);
const piece = args[0];
const opt = (name, def) => { const i = args.indexOf('--' + name); return i < 0 ? def : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
if (!piece || !fs.existsSync(path.join(ROOT, piece, 'index.html'))) {
  console.error('usage: node motion/render.js <piece> --stills t1,t2 | --frames [--from N --to M] [--workers K]');
  process.exit(1);
}
const OUT = path.join(ROOT, '..', 'output', piece);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.otf': 'font/otf', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.json': 'application/json' };
function serve() {
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      const p = path.normalize(path.join(ROOT, decodeURIComponent(req.url.split('?')[0])));
      if (!p.startsWith(ROOT) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { rsp.writeHead(404); return rsp.end(); }
      rsp.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(rsp);
    });
    srv.listen(0, '127.0.0.1', () => res(srv));
  });
}

async function openPage(port) {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--disable-gpu-vsync'] });
  const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') console.log('[page]', m.text()); });
  page.on('pageerror', e => console.log('[page error]', e.message));
  await page.goto(`http://127.0.0.1:${port}/${piece}/index.html`);
  await page.evaluate(() => window.SCENE.ready);
  const meta = await page.evaluate(() => ({ fps: TL.FPS, duration: TL.DURATION }));
  return { browser, page, meta };
}

async function grab(page, t) {
  const b64 = await page.evaluate((t) => {
    SCENE.render(t);
    return document.getElementById('gl').toDataURL('image/png').split(',')[1];
  }, t);
  return Buffer.from(b64, 'base64');
}

(async () => {
  const srv = await serve();
  const port = srv.address().port;
  if (opt('stills')) {
    const times = String(opt('stills')).split(',').map(Number);
    fs.mkdirSync(path.join(OUT, 'stills'), { recursive: true });
    const { browser, page } = await openPage(port);
    for (const t of times) {
      const t0 = Date.now();
      const png = await grab(page, t);
      const f = path.join(OUT, 'stills', `t_${t.toFixed(2).padStart(6, '0')}.png`);
      fs.writeFileSync(f, png);
      console.log(f, `${Date.now() - t0} ms`);
    }
    await browser.close();
  } else if (opt('frames')) {
    const workers = +opt('workers', 1);
    const dir = path.join(OUT, 'frames');
    fs.mkdirSync(dir, { recursive: true });
    const probe = await openPage(port);
    const total = Math.round(probe.meta.duration * probe.meta.fps);
    const fps = probe.meta.fps;
    await probe.browser.close();
    const from = +opt('from', 0), to = Math.min(+opt('to', total), total);
    const todo = [];
    for (let f = from; f < to; f++) if (opt('force') || !fs.existsSync(path.join(dir, `f_${String(f).padStart(5, '0')}.png`))) todo.push(f);
    console.log(`rendering ${todo.length} frames (${from}..${to - 1} of ${total}) with ${workers} workers`);
    let done = 0; const start = Date.now();
    await Promise.all([...Array(workers)].map(async (_, w) => {
      const { browser, page } = await openPage(port);
      for (let k = w; k < todo.length; k += workers) {
        const f = todo[k];
        const png = await grab(page, f / fps);
        fs.writeFileSync(path.join(dir, `f_${String(f).padStart(5, '0')}.png`), png);
        done++;
        if (done % 25 === 0 || done === todo.length) {
          const el = (Date.now() - start) / 1000;
          console.log(`${done}/${todo.length}  ${(el / done).toFixed(2)} s/frame  eta ${((todo.length - done) * el / done / 60).toFixed(1)} min`);
        }
      }
      await browser.close();
    }));
  }
  srv.close();
})().catch(e => { console.error(e); process.exit(1); });
