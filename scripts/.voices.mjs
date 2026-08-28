import { chromium } from 'playwright';
const b = await chromium.launch();
const p = await b.newPage();
await p.goto('about:blank');
const voices = await p.evaluate(async () => {
  const wait = () => new Promise((r) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return r(v);
    speechSynthesis.onvoiceschanged = () => r(speechSynthesis.getVoices());
    setTimeout(() => r(speechSynthesis.getVoices()), 3000);
  });
  const all = await wait();
  return all.map((v) => ({ name: v.name, lang: v.lang, local: v.localService }));
});
console.log(`total voices: ${voices.length}`);
const en = voices.filter((v) => /^en/i.test(v.lang));
console.log(`english: ${en.length}  ·  local ${en.filter((v)=>v.local).length}  ·  online ${en.filter((v)=>!v.local).length}\n`);
for (const v of en.slice(0, 20)) console.log(`  ${v.local ? 'local ' : 'ONLINE'}  ${v.lang.padEnd(6)} ${v.name}`);
await b.close();
