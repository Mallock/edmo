/**
 * Proof that the Radio tab's analyser is showing real audio.
 *
 * The bars are fed from a tap on the MUSIC bus, so the only honest way to
 * check them is to put actual sound through the actual graph. This drives the
 * REAL built UI in a browser and hands it REAL station bytes: a few hundred
 * kilobytes are pulled from SomaFM in Node first (with the app's own
 * User-Agent, which is the difference between 200 and 403), then served back
 * to the page with permissive CORS — exactly what the Rust relay does at
 * runtime. From the element onward, nothing is simulated.
 *
 * It then reads the canvas back and asserts the display is alive: lit cells
 * present, and the picture CHANGING between frames. A frozen analyser and a
 * broken one look identical in a screenshot, so the moving part is the test.
 *
 *   npx vite preview --port 4173
 *   node scripts/radio-shot.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const OUT = 'site/img/hud-radio.png';
const STREAM = 'https://ice1.somafm.com/groovesalad-128-mp3';
const TRACKS = 'https://somafm.com/songs/groovesalad.json';
const UA = 'EDMissionOperator/1.8.0 (+https://github.com/Mallock/edmo)';
const WANT_BYTES = 700_000; // ~40 s at 128 kbps — plenty of frames to watch

/** Pull a finite slice off an endless stream. */
async function grab(url, bytes) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${url} answered ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < bytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  return { buf: Buffer.concat(chunks), type: res.headers.get('content-type') ?? 'audio/mpeg' };
}

// Cached between runs on purpose: tuning the display against a different song
// each time is not measurement, it is guessing with extra steps. Delete the
// file to hear something else.
const CACHE = 'scripts/.radio-sample.mp3';
let audio;
if (existsSync(CACHE)) {
  audio = { buf: readFileSync(CACHE), type: 'audio/mpeg' };
  console.log(`station bytes: ${audio.buf.length} (cached — rm ${CACHE} to refetch)`);
} else {
  audio = await grab(STREAM, WANT_BYTES);
  writeFileSync(CACHE, audio.buf);
  console.log(`station bytes: ${audio.buf.length} (${audio.type}, fetched)`);
}

let tracks = null;
try {
  const res = await fetch(TRACKS, { headers: { 'User-Agent': UA } });
  if (res.ok) tracks = Buffer.from(await res.arrayBuffer());
} catch {
  /* the track name is a nicety */
}

const browser = await chromium.launch({
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 460, height: 760 }, deviceScaleFactor: 2 });

// Stand in for the Rust relay: app User-Agent already spent, CORS opened.
await page.route('**ice1.somafm.com/**', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' },
    body: audio.buf,
  }),
);
if (tracks) {
  await page.route('**somafm.com/songs/**', (route) =>
    route.fulfill({
      status: 200,
      headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
      body: tracks,
    }),
  );
}

page.on('console', (m) => {
  if (m.type() === 'error') console.log('  page error:', m.text());
});

await page.goto('http://localhost:4173/');
await page.waitForTimeout(1000);

const tab = page.locator('button[role="tab"]', { hasText: '📻' });
if (!(await tab.count())) {
  console.log('!! the radio tab did not appear');
  await browser.close();
  process.exit(1);
}
await tab.first().click();
await page.waitForTimeout(300);

const canvas = page.locator('canvas.radio-vis');
console.log(`analyser canvas present: ${(await canvas.count()) === 1}`);

// Switch it on the way a commander would.
const onBtn = page.locator('button', { hasText: 'On' }).first();
await onBtn.click();
await page.waitForTimeout(4000);

const state = await page.evaluate(() => {
  const led = document.querySelector('.radio-led');
  return {
    playing: !!led?.classList.contains('on'),
    line: document.querySelector('.radio-track')?.textContent ?? '',
    lit: document.querySelectorAll('.radio-station.on').length,
  };
});
console.log(`playing: ${state.playing} · line: "${state.line}" · station lit: ${state.lit}`);

/** Read the canvas back: how many cells are lit, and where the tops are. */
const sample = async () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.radio-vis');
    const g = c.getContext('2d');
    const { data } = g.getImageData(0, 0, c.width, c.height);
    let green = 0;
    let amber = 0;
    let red = 0;
    let dim = 0;
    let sig = 0;
    for (let i = 0; i < data.length; i += 4) {
      const [r, gg, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
      if (a < 40) continue;
      if (r > 200 && gg > 180) amber++;
      else if (r > 200) red++;
      else if (gg > 150) green++;
      else dim++;
      sig = (sig * 31 + r + gg * 3 + b * 7) % 1e9;
    }
    // Per-bar height, so a dead end of the spectrum is visible as a number
    // rather than as a shrug at a screenshot.
    const bars = [];
    const BARS = 24;
    const gap = 2;
    // The canvas draws in CSS pixels through a devicePixelRatio transform, so
    // walk the backing store in the same units the bars were laid out in.
    const dpr = c.width / c.clientWidth;
    const pitch = (c.clientWidth + gap) / BARS;
    for (let i = 0; i < BARS; i++) {
      const x = Math.round((i * pitch + (pitch - gap) / 2) * dpr);
      let top = c.height;
      for (let y = 0; y < c.height; y++) {
        const p = (y * c.width + x) * 4;
        const lum = data[p] + data[p + 1] + data[p + 2];
        if (data[p + 3] > 40 && lum > 200) {
          top = y;
          break;
        }
      }
      bars.push(Math.round(((c.height - top) / c.height) * 100));
    }
    return { green, amber, red, dim, sig, bars };
  });

const frames = [];
for (let i = 0; i < 8; i++) {
  frames.push(await sample());
  await page.waitForTimeout(220);
}
const distinct = new Set(frames.map((f) => f.sig)).size;
const peakGreen = Math.max(...frames.map((f) => f.green));
const peakAmber = Math.max(...frames.map((f) => f.amber));
const peakRed = Math.max(...frames.map((f) => f.red));
console.log(
  `frames: ${frames.length} · distinct pictures: ${distinct} · ` +
    `lit cells peak — green ${peakGreen}, amber ${peakAmber}, red ${peakRed}`,
);
const perBar = frames[0].bars.map((_, i) => Math.max(...frames.map((f) => f.bars[i])));
console.log(`bar heights (% of display, peak over ${frames.length} frames):`);
console.log('  ' + perBar.map((v, i) => `${String(i).padStart(2)}:${String(v).padStart(3)}`).join(' '));
const dead = perBar.filter((v) => v < 6).length;
console.log(`  bars never rising above 6%: ${dead}`);

// Retune, and check the dial actually moves the selection.
const drone = page.locator('button.radio-station', { hasText: 'Deep Space One' }).first();
if (await drone.count()) {
  await drone.click();
  await page.waitForTimeout(2500);
  const now = await page.evaluate(
    () => document.querySelector('.radio-station.on')?.textContent ?? '',
  );
  console.log(`after retune, lit station: "${now}"`);
}

// The strip that stays. Leave the radio tab the way the HUD leaves it on its
// own — for the orrery, for a market — and the analyser must follow you down
// to the bottom of the window and still be moving.
const away = page.locator('button[role="tab"]', { hasText: '🧭' }).first();
let stripOk = false;
if (await away.count()) {
  await away.click();
  await page.waitForTimeout(500);
  const strip = page.locator('.radio-mini');
  const shown = (await strip.count()) === 1;
  const full = await page.locator('canvas.radio-vis:not(.mini)').count();
  const a = await sample();
  await page.waitForTimeout(400);
  const b = await sample();
  const track = await page.evaluate(
    () => document.querySelector('.radio-mini .radio-track')?.textContent ?? '',
  );
  const box = await page.locator('.radio-mini canvas').boundingBox();
  console.log(
    `off the radio tab — strip shown: ${shown} · full analyser gone: ${full === 0} · ` +
      `strip moving: ${a.sig !== b.sig} · height: ${Math.round(box?.height ?? 0)}px · track: "${track}"`,
  );
  await page.screenshot({ path: 'scripts/.radio-strip.png' });
  // And it is the way back.
  await strip.click();
  await page.waitForTimeout(400);
  const backOnTab = (await page.locator('canvas.radio-vis:not(.mini)').count()) === 1;
  console.log(`clicking the strip opens the radio tab: ${backOnTab}`);
  stripOk = shown && full === 0 && a.sig !== b.sig && backOnTab && track.length > 0;
}

// Switched off, the panel must still look switched ON — a dead rectangle
// reads as a broken tab. Check the idle sweep moves and nothing throws.
await page.locator('button', { hasText: 'Off' }).first().click();
await page.waitForTimeout(600);
const idleA = await sample();
await page.waitForTimeout(400);
const idleB = await sample();
console.log(
  `switched off: led ${await page.evaluate(() => document.querySelector('.radio-led')?.className)} · ` +
    `idle sweep moving: ${idleA.sig !== idleB.sig}`,
);
await page.locator('button', { hasText: 'On' }).first().click();
await page.waitForTimeout(2500);

await page.screenshot({ path: OUT });
writeFileSync(
  'scripts/.radio-shot.json',
  JSON.stringify({ frames, distinct, peakGreen, peakAmber, peakRed }, null, 1),
);
console.log('saved ' + OUT);

const ok = state.playing && distinct >= 5 && peakGreen > 200 && stripOk;
console.log(ok ? 'PASS — the analyser is live, and the strip follows you off the tab' : 'FAIL — see numbers above');
await browser.close();
process.exit(ok ? 0 : 1);
