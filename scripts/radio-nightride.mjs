/**
 * Does the cyberpunk end of the dial actually work in a browser?
 *
 * Two things here cannot be settled by asking the host with curl:
 *
 *   1. The stream has to play THROUGH the app's audio graph. Real station
 *      bytes are fetched in Node and served back to the page, the way the
 *      Rust relay does at runtime, so everything from the audio element
 *      onward is the real thing.
 *   2. The metadata is an EventSource, and EventSource obeys CORS from the
 *      PAGE's origin. curl never sends an Origin header, so a station could
 *      answer curl happily and still refuse the app. That request is
 *      deliberately NOT intercepted — it goes to the live endpoint, from a
 *      real browser origin, and either the track appears in the HUD or the
 *      catalogue is making a promise it cannot keep.
 *
 *   npx vite preview --port 4173
 *   node scripts/radio-nightride.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = 'EDMissionOperator/1.8.0 (+https://github.com/Mallock/edmo)';
const STREAM = 'https://stream.nightride.fm/darksynth.mp3';
const CACHE = 'scripts/.nightride-sample.mp3';
const CHIP = 'Darksynth';
const CHANNEL = 'darksynth';

let buf;
if (existsSync(CACHE)) {
  buf = readFileSync(CACHE);
} else {
  const res = await fetch(STREAM, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${STREAM} answered ${res.status}`);
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < 500_000) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await reader.cancel().catch(() => {});
  buf = Buffer.concat(chunks);
  writeFileSync(CACHE, buf);
}
console.log(`station bytes: ${buf.length}`);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 460, height: 760 }, deviceScaleFactor: 2 });

await page.route('**stream.nightride.fm/**', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' },
    body: buf,
  }),
);

let sseBlocked = false;
page.on('console', (m) => {
  const t = m.text();
  if (/nightride\.fm\/meta/i.test(t) && /CORS|blocked|Access-Control/i.test(t)) sseBlocked = true;
  if (m.type() === 'error') console.log('  page error:', t.slice(0, 160));
});

await page.goto('http://localhost:4173/');
await page.waitForTimeout(900);
await page.locator('button[role="tab"]', { hasText: '📻' }).first().click();
await page.waitForTimeout(250);
await page.locator('button', { hasText: 'On' }).first().click();
await page.waitForTimeout(1500);

// Tune to the cyberpunk channel from the dial, as a commander would.
const chip = page.locator('button.radio-station', { hasText: CHIP }).first();
if (!(await chip.count())) {
  console.log(`!! no "${CHIP}" chip on the dial`);
  await browser.close();
  process.exit(1);
}
// What the HUD said BEFORE the retune. If that string is still on screen
// afterwards, the panel is showing the previous station's song under the new
// station's name — which reads exactly like success and is not.
const before = await page.evaluate(
  () => document.querySelector('.radio-track')?.textContent ?? '',
);
console.log(`before retune, HUD said: "${before}"`);

await chip.click();
// The event stream speaks when a track changes, and on connect. Give it a
// window rather than a single guess, and stop as soon as it names something.
let state = { playing: false, line: '', lit: '' };
for (let i = 0; i < 20; i++) {
  await page.waitForTimeout(1000);
  state = await page.evaluate(() => ({
    playing: !!document.querySelector('.radio-led')?.classList.contains('on'),
    line: document.querySelector('.radio-track')?.textContent ?? '',
    lit: document.querySelector('.radio-station.on')?.textContent ?? '',
  }));
  if (state.line.includes('—') && state.line !== before) break;
}
console.log(`lit chip: "${state.lit}" · playing: ${state.playing}`);
console.log(`HUD track line: "${state.line}"`);

// What the endpoint says right now, read independently of the app.
const truth = await (async () => {
  const ctl = new AbortController();
  setTimeout(() => ctl.abort(), 12_000);
  try {
    const res = await fetch('https://nightride.fm/meta', {
      headers: { Accept: 'text/event-stream', 'User-Agent': UA },
      signal: ctl.signal,
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let acc = '';
    for (let i = 0; i < 40; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      for (const l of acc.split('\n')) {
        if (!l.startsWith('data:')) continue;
        try {
          const row = JSON.parse(l.slice(5).trim()).find((r) => r.station === CHANNEL);
          if (row) {
            await reader.cancel().catch(() => {});
            return [row.artist, row.title].filter(Boolean).join(' — ');
          }
        } catch {
          /* partial frame */
        }
      }
    }
  } catch {
    /* fall through */
  }
  return '';
})();
console.log(`endpoint says:  "${truth}"`);

// The bar the line has to clear: it names a track, it is NOT the previous
// station's track, and it agrees with what the endpoint reports for this
// channel. Songs are minutes long, so disagreement means the wrong row was
// picked — not that the record turned over mid-test.
const named = state.line.includes('—') && !/did not|would not|Tuning/.test(state.line);
const notStale = state.line !== before;
const agrees = truth ? state.line === truth : named;
console.log(
  `names a track: ${named} · not the previous station's: ${notStale} · ` +
    `agrees with the endpoint: ${agrees}`,
);
console.log(`EventSource blocked by CORS: ${sseBlocked}`);

await page.screenshot({ path: 'scripts/.nightride.png' });
const ok = state.playing && state.lit.includes(CHIP) && named && notStale && agrees && !sseBlocked;
console.log(ok ? 'PASS — plays, and names the track from the live event stream' : 'FAIL — see above');
await browser.close();
process.exit(ok ? 0 : 1);
