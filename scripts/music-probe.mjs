/**
 * Does the radio actually make a sound? Ask a real browser.
 *
 * The player was declared fixed on reasoning alone and was not, so this stops
 * guessing: it drives a real Chromium (the same engine as the app's WebView2),
 * plays the real stream, and MEASURES the waveform coming out of the graph. A
 * station that "plays" but produces silence — exactly what a suspended context
 * or a blocked CORS route gives you — is caught here, not in your headphones.
 *
 * Plain .mjs on purpose: the page-side code must reach the browser untouched,
 * and a TypeScript transform injects helpers (`__name`) that do not exist there.
 *
 *   node scripts/music-probe.mjs
 */
import { chromium } from 'playwright';
import { createServer } from 'node:http';

const ROUTABLE = 'https://ice1.somafm.com/spacestation-128-mp3';
const DIRECT = 'http://fallout.fm:8000/falloutfm1.ogg';

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'text/html');
  res.end('<!doctype html><meta charset="utf-8"><title>music probe</title>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const { port } = server.address();

// The same flag the app now passes to its own webview.
const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => {
  if (m.type() === 'error') console.log('   [console]', m.text().slice(0, 140));
});
await page.goto(`http://127.0.0.1:${port}/`);

const results = await page.evaluate(async ([routable, direct]) => {
  const out = [];

  async function tryPlay(el) {
    try {
      await el.play();
      return 'play() resolved';
    } catch (e) {
      return (e && e.name ? e.name : 'Error') + ': ' + String(e && e.message).slice(0, 90);
    }
  }

  async function advanced(el, ms) {
    const start = el.currentTime;
    await new Promise((r) => setTimeout(r, ms));
    return el.currentTime > start + 0.05;
  }

  // A: the sequence the app uses today — stop() (pause + removeAttribute +
  // load) immediately followed by a new src and play().
  {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'none';
    try {
      el.pause();
      el.removeAttribute('src');
      el.load();
    } catch (e) { /* ignore */ }
    el.src = routable;
    const verdict = await tryPlay(el);
    const moving = await advanced(el, 2500);
    out.push({ name: 'A. app sequence (stop -> load -> src -> play)', verdict, detail: moving ? 'audio advancing' : 'NOT advancing' });
    el.pause();
  }

  // B: a clean start with no load() in front of it.
  {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'none';
    el.src = routable;
    const verdict = await tryPlay(el);
    const moving = await advanced(el, 2500);
    out.push({ name: 'B. clean start (src -> play)', verdict, detail: moving ? 'audio advancing' : 'NOT advancing' });
    el.pause();
  }

  // C: routed through the graph the app uses, and MEASURED.
  {
    const el = new Audio();
    el.crossOrigin = 'anonymous';
    el.preload = 'none';
    el.src = routable;
    const ctx = new AudioContext();
    const src = ctx.createMediaElementSource(el);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    analyser.connect(ctx.destination);
    ctx.resume();
    const verdict = await tryPlay(el);
    await new Promise((r) => setTimeout(r, 3000));
    const buf = new Uint8Array(analyser.fftSize);
    let peak = 0;
    for (let i = 0; i < 6; i++) {
      analyser.getByteTimeDomainData(buf);
      for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
      await new Promise((r) => setTimeout(r, 120));
    }
    out.push({
      name: 'C. routed through AudioContext + analyser',
      verdict,
      detail: 'ctx=' + ctx.state + ' peak=' + peak + (peak > 2 ? ' (SOUND)' : ' (SILENCE)'),
    });
    el.pause();
  }

  // D: the direct, no-CORS station.
  {
    const el = new Audio();
    el.preload = 'none';
    el.src = direct;
    const verdict = await tryPlay(el);
    const moving = await advanced(el, 3000);
    out.push({ name: 'D. direct station, no crossOrigin', verdict, detail: moving ? 'audio advancing' : 'NOT advancing' });
    el.pause();
  }

  return out;
}, [ROUTABLE, DIRECT]);

for (const r of results) console.log('\n' + r.name + '\n   ' + r.verdict + '\n   ' + r.detail);

await browser.close();
server.close();
