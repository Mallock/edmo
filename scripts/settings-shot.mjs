/**
 * Look at the settings drawer, in every category and every phosphor.
 *
 * A settings panel is the one screen where a regression hides easily: fifteen
 * sections, and nobody scrolls all of them after a change. This drives the
 * real built UI, walks the category rail, checks that exactly one group is on
 * screen at a time and that the scroll height actually came down, then puts
 * each instrument colour on and photographs it.
 *
 *   npx vite preview --port 4173
 *   node scripts/settings-shot.mjs
 */
import { chromium } from 'playwright';

const OUT = 'scripts/.settings';
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 460, height: 820 }, deviceScaleFactor: 2 });
page.on('console', (m) => {
  if (m.type() === 'error') console.log('  page error:', m.text().slice(0, 140));
});

await page.goto('http://localhost:4173/');
await page.waitForTimeout(900);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);

const body = page.locator('.settings-body');
const totalSections = await page.locator('.settings-body > section').count();
console.log(`sections in the drawer: ${totalSections}`);

// What the single-column drawer used to cost, measured rather than asserted.
const fullHeight = await body.evaluate((el) => {
  const prev = el.getAttribute('data-cat');
  el.removeAttribute('data-cat');
  const h = el.scrollHeight;
  if (prev) el.setAttribute('data-cat', prev);
  return h;
});
console.log(`scroll height with every section shown: ${fullHeight}px`);

const cats = await page.locator('.settings-cat').allTextContents();
console.log(`categories: ${cats.join(' · ')}`);

let worst = 0;
for (const label of cats) {
  await page.locator('.settings-cat', { hasText: new RegExp(`^${label}$`, 'i') }).first().click();
  await page.waitForTimeout(250);
  const shown = await page.locator('.settings-body > section:visible').count();
  const heads = await page.locator('.settings-body > section:visible h3').allTextContents();
  const h = await body.evaluate((el) => el.scrollHeight);
  worst = Math.max(worst, h);
  console.log(`  ${label.padEnd(6)} ${String(shown).padStart(2)} sections · ${String(h).padStart(4)}px · ${heads.map((t) => t.trim().split('\n')[0]).join(', ')}`);
  await page.screenshot({ path: `${OUT}-${label.toLowerCase()}.png` });
}
console.log(`tallest category: ${worst}px (was ${fullHeight}px — ${Math.round((1 - worst / fullHeight) * 100)}% less scroll)`);

// The phosphors. Each one is set through the real control, then photographed
// on a real panel rather than on a swatch page.
await page.locator('.settings-cat', { hasText: /^HUD$/ }).first().click();
await page.waitForTimeout(250);
for (const tint of ['Amber', 'Green', 'Red', 'Grey']) {
  await page.locator('.tint', { hasText: tint }).first().click();
  await page.waitForTimeout(300);
  const applied = await page.evaluate(() => {
    const hud = document.querySelector('.hud');
    const cs = getComputedStyle(hud);
    return {
      attr: hud.getAttribute('data-tint'),
      phos: cs.getPropertyValue('--phos').trim(),
      title: getComputedStyle(document.querySelector('.settings-head')).color,
    };
  });
  console.log(`  ${tint.padEnd(6)} data-tint=${applied.attr} --phos=${applied.phos} head=${applied.title}`);
  await page.screenshot({ path: `${OUT}-tint-${tint.toLowerCase()}.png` });
}

// Back to amber, then photograph the panel proper (not the drawer) so the
// frame, tabs and footer can be judged together.
await page.locator('.tint', { hasText: 'Green' }).first().click();
await page.waitForTimeout(200);
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}-panel-green.png` });
await page.click('button[aria-label="Settings"]');
await page.waitForTimeout(300);
// Reopening must land back on HUD — the drawer remembers where it was left.
const remembered = await page.locator('.settings-cat.on').first().textContent();
console.log(`reopened on: ${remembered} (should be HUD, not AI)`);
await page.locator('.tint', { hasText: 'Amber' }).first().click();
await page.waitForTimeout(200);

console.log('saved ' + OUT + '-*.png');
await browser.close();
