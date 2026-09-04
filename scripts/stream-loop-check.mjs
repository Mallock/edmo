/**
 * Is a station actually broadcasting, or looping a notice?
 *
 * stations-check.ts asks whether a stream is UP. music-probe.mjs asks whether
 * it makes a SOUND. Neither could tell that Bauer's old mounts were serving a
 * "jatka kuuntelua osoitteessa Radioplay" announcement on repeat: 200,
 * audio/mpeg, bytes flowing, a healthy waveform — and wrong. Byte comparison
 * missed it too, because the notice was re-encoded live, so no two passes
 * shared a frame.
 *
 * What does tell: decode ninety seconds and autocorrelate the loudness
 * envelope. A looped notice repeats its envelope exactly at the loop period
 * (the old mounts scored r = 1.00 at 92.5 s); live music has no strong
 * long-lag peak (SomaFM scored 0.42). A second tell is reported alongside —
 * the fraction of near-silent frames — because an announcement pauses
 * between sentences (0.15) and a music stream barely does (0.01).
 *
 * Decoding happens in Edge, since the app's WebView2 is the same engine and
 * Playwright's own Chromium lacks AAC; MP3 works in either.
 *
 * Bauer's stations left the dial over exactly this (see the note in
 * stations.ts), which is why the default set is the Finnish block that
 * remains — the stations most likely to be gated or withdrawn next.
 *
 *   node scripts/stream-loop-check.mjs                 # the Finnish block
 *   node scripts/stream-loop-check.mjs ylex groovesalad # any station ids
 *   node scripts/stream-loop-check.mjs --seconds 120 … # longer capture, longer loops
 */
import { chromium } from 'playwright';
import https from 'node:https';
import http from 'node:http';
import {
  ADSWIZZ_REGISTER_URL,
  STATIONS,
  adswizzUrl,
  parseAdswizzListenerId,
} from '../src/engine/stations.ts';

const UA = 'EDMissionOperator/1.9.4 (+https://github.com/Mallock/edmo)';
const args = process.argv.slice(2);
const secIdx = args.indexOf('--seconds');
const SECONDS = secIdx >= 0 ? Number(args[secIdx + 1]) : 90;
// The value after --seconds is not a station id; nothing else is skipped.
// (With no --seconds, secIdx is -1 and a naive `i !== secIdx + 1` would drop
// the FIRST id on the command line — it did, once, and hid a station.)
const ids = args.filter((a, i) => !a.startsWith('--') && !(secIdx >= 0 && i === secIdx + 1));
const picks = ids.length
  ? ids.map((id) => STATIONS.find((s) => s.id === id) ?? { id, url: id, label: id })
  : STATIONS.filter((s) =>
      ['Bauer Media Finland', 'Yle', 'Radio Helsinki', 'Järviradio'].includes(s.source),
    );

/** Register with AdsWizz the way music.ts does, for the gated stations. */
function registerListener() {
  return new Promise((resolve) => {
    https.get(ADSWIZZ_REGISTER_URL, { headers: { 'user-agent': UA } }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(parseAdswizzListenerId(body)));
    }).on('error', () => resolve(null));
  });
}

function capture(url, seconds) {
  return new Promise((resolve) => {
    const chunks = [];
    const mod = url.startsWith('https:') ? https : http;
    const req = mod.get(url, { headers: { 'user-agent': UA, accept: '*/*' } }, (res) => {
      res.on('data', (c) => chunks.push(c));
      setTimeout(() => { req.destroy(); resolve(Buffer.concat(chunks)); }, seconds * 1000);
    });
    req.on('error', () => resolve(Buffer.concat(chunks)));
  });
}

const browser = await chromium.launch({ channel: 'msedge' }).catch(() => chromium.launch());
const page = await browser.newPage();
await page.setContent('<!doctype html><meta charset="utf-8">');

// The gated stations play a notice without a session — the exact failure
// this script exists to catch — so they are checked the way the app plays
// them: registered, and with the session on the URL.
const listenerId = picks.some((s) => s.adswizz) ? await registerListener() : null;
if (picks.some((s) => s.adswizz)) console.log(`AdsWizz listener id: ${listenerId ?? 'REGISTRATION FAILED'}`);
const playUrl = (s) => (s.adswizz && listenerId ? adswizzUrl(s, listenerId) : s.url);

console.log(`capturing ${SECONDS}s from ${picks.length} station(s)…`);
const buffers = await Promise.all(picks.map((s) => capture(playUrl(s), SECONDS)));

let bad = 0;
for (let i = 0; i < picks.length; i++) {
  const s = picks[i];
  const b64 = buffers[i].toString('base64');
  const r = await page.evaluate(async (b64) => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let k = 0; k < bin.length; k++) bytes[k] = bin.charCodeAt(k);
    const ctx = new OfflineAudioContext(1, 44100, 44100);
    let audio;
    try { audio = await ctx.decodeAudioData(bytes.buffer); } catch (e) { return { error: String(e).slice(0, 60) }; }
    const pcm = audio.getChannelData(0);
    const STEP = Math.round(audio.sampleRate * 0.05);
    const env = [];
    for (let k = 0; k + STEP <= pcm.length; k += STEP) {
      let acc = 0; for (let j = k; j < k + STEP; j++) acc += pcm[j] * pcm[j];
      env.push(Math.sqrt(acc / STEP));
    }
    const e = env.slice(100); // skip the connect burst
    const m = e.reduce((a, v) => a + v, 0) / e.length;
    const sd = Math.sqrt(e.reduce((a, v) => a + (v - m) ** 2, 0) / e.length) || 1;
    const z = e.map((v) => (v - m) / sd);
    const quiet = e.filter((v) => v < m * 0.15).length / e.length;
    let best = { lag: 0, r: -1 };
    for (let lag = 60; lag < Math.floor(z.length * 0.6); lag++) {
      let acc = 0; const n = z.length - lag;
      for (let k = 0; k < n; k++) acc += z[k] * z[k + lag];
      const r = acc / n;
      if (r > best.r) best = { lag, r };
    }
    return { seconds: pcm.length / audio.sampleRate, meanRms: m, quiet, lagS: best.lag * 0.05, r: best.r };
  }, b64);

  let verdict;
  if (r.error) verdict = `DECODE FAILED (${r.error})`;
  else if (r.meanRms < 0.003) verdict = 'SILENT';
  else if (r.r > 0.6) verdict = `LOOP — period ≈ ${r.lagS.toFixed(1)}s`;
  else verdict = 'broadcast';
  if (!/^broadcast$/.test(verdict)) bad++;
  const stats = r.error ? '' : `${r.seconds.toFixed(0)}s  rms ${r.meanRms.toFixed(3)}  quiet ${r.quiet.toFixed(2)}  r ${r.r.toFixed(2)} @ ${r.lagS.toFixed(1)}s`;
  console.log(`${s.id.padEnd(16)} ${stats.padEnd(52)} → ${verdict}`);
}

await browser.close();
console.log(bad ? `\n${bad} station(s) are not broadcasting.` : '\nEvery station is broadcasting.');
process.exit(bad ? 1 : 0);
