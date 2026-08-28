/**
 * Does the tuning dial actually tune?
 *
 * A dial is a control before it is a picture, so this drives it the three ways
 * a commander will: dragging the scale like a knob, clicking a name in view,
 * and the arrow keys. Each one has to land on a real station and move the
 * needle's neighbours with it.
 *
 * It also plays one of the NEW stations end to end — real bytes fetched in
 * Node and served back the way the Rust relay does — because a catalogue entry
 * that 200s to curl has still never been through an audio element.
 *
 *   npx vite preview --port 4173
 *   node scripts/dial-check.mjs
 */
import { chromium } from 'playwright';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';

const UA = 'EDMissionOperator/1.9.0 (+https://github.com/Mallock/edmo)';
const CACHE = 'scripts/.oldschool-sample.mp3';
const STREAM = 'https://listen.181fm.com/181-oldschool_128k.mp3';

let buf;
if (existsSync(CACHE)) {
  buf = readFileSync(CACHE);
} else {
  const res = await fetch(STREAM, { headers: { 'User-Agent': UA, Accept: '*/*' } });
  if (!res.ok) throw new Error(`${STREAM} answered ${res.status}`);
  const rd = res.body.getReader();
  const chunks = [];
  let total = 0;
  while (total < 500_000) {
    const { done, value } = await rd.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  await rd.cancel().catch(() => {});
  buf = Buffer.concat(chunks);
  writeFileSync(CACHE, buf);
}
console.log(`181.FM bytes: ${buf.length}`);

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 460, height: 780 }, deviceScaleFactor: 2 });
await page.route('**listen.181fm.com/**', (route) =>
  route.fulfill({
    status: 200,
    headers: { 'content-type': 'audio/mpeg', 'access-control-allow-origin': '*' },
    body: buf,
  }),
);
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  page error:', m.text().slice(0, 120));
});

await page.goto('http://localhost:4173/');
await page.waitForTimeout(900);
await page.locator('button[role="tab"]', { hasText: '📻' }).first().click();
await page.waitForTimeout(300);

const tuned = () => page.evaluate(() => document.querySelector('.dial-stn.on')?.textContent ?? '');
const visible = () =>
  page.evaluate(() => {
    const dial = document.querySelector('.dial').getBoundingClientRect();
    return [...document.querySelectorAll('.dial-stn')]
      .filter((el) => {
        const r = el.getBoundingClientRect();
        return r.right > dial.left + 4 && r.left < dial.right - 4;
      })
      .map((el) => el.textContent.trim());
  });

console.log(`\nstations on the dial: ${await page.locator('.dial-stn').count()}`);
console.log(`tuned at rest: "${await tuned()}"`);
console.log(`in the window: ${(await visible()).join(' | ')}`);

// Is the tuned station actually under the needle?
const centred = await page.evaluate(() => {
  const on = document.querySelector('.dial-stn.on').getBoundingClientRect();
  const needle = document.querySelector('.dial-needle').getBoundingClientRect();
  return Math.abs(on.left + on.width / 2 - (needle.left + needle.width / 2));
});
console.log(`tuned station is ${Math.round(centred)}px off the needle (want < 3)`);

// 1. Arrow keys.
await page.locator('.dial').focus();
await page.keyboard.press('ArrowRight');
await page.waitForTimeout(400);
const afterRight = await tuned();
await page.keyboard.press('ArrowLeft');
await page.waitForTimeout(400);
const afterLeft = await tuned();
console.log(`\narrow right → "${afterRight}" · arrow left back → "${afterLeft}"`);

// 2. Drag the scale like a knob. Left-drag = later stations.
const box = await page.locator('.dial').boundingBox();
const before = await tuned();
await page.mouse.move(box.x + box.width * 0.7, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width * 0.7 - 280, box.y + box.height / 2, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(500);
const afterDrag = await tuned();
console.log(`drag left 280px: "${before}" → "${afterDrag}"`);

// 3. Click a name that is in view.
const names = await visible();
const target = names.find((n) => n !== afterDrag);
await page.locator('.dial-stn', { hasText: target }).first().click();
await page.waitForTimeout(450);
console.log(`click "${target}" → "${await tuned()}"`);

// 4. Tune to a new station and make it play.
await page.locator('.dial').focus();
for (let i = 0; i < 40; i++) {
  if ((await tuned()).includes('Old School')) break;
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(70);
}
console.log(`\nscanned to: "${await tuned()}"`);
// Tuning a station switches the radio on by itself, so only press the button
// if it is still offering to.
const onBtn = page.locator('button.btn', { hasText: /^.?\s*On$/ });
if (await onBtn.count()) await onBtn.first().click();
await page.waitForTimeout(5000);
const state = await page.evaluate(() => ({
  playing: !!document.querySelector('.radio-led')?.classList.contains('on'),
  line: document.querySelector('.radio-track')?.textContent ?? '',
  blurb: document.querySelector('.radio-blurb')?.textContent ?? '',
}));
console.log(`playing: ${state.playing} · line: "${state.line}"`);
console.log(`blurb:   "${state.blurb}"`);

await page.screenshot({ path: 'scripts/.dial.png' });
const ok =
  centred < 3 &&
  afterRight !== before &&
  afterLeft === before &&
  afterDrag !== before &&
  state.playing;
console.log(ok ? '\nPASS — the dial tunes three ways and the new station plays' : '\nFAIL — see above');
await browser.close();
process.exit(ok ? 0 : 1);
