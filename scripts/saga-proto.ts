/**
 * The Saga from the terminal — narrate recent days as space-opera episodes.
 * Uses the same engine module as the HUD. Run: node scripts/saga-proto.ts [--days N]
 */
import { defaultJournalDir, listJournals, readJournalFile } from '../src/engine/journal.ts';
import { SagaTracker, buildEpisodeChat } from '../src/engine/saga.ts';
import { LmStudioClient } from '../src/engine/lmstudio.ts';

const daysArg = process.argv.indexOf('--days');
const wantDays = daysArg >= 0 ? Number(process.argv[daysArg + 1]) || 2 : 2;

const saga = new SagaTracker();
for (const f of listJournals(defaultJournalDir()).slice(-10)) {
  for (const ev of readJournalFile(f)) saga.apply(ev);
}

const byDay = new Map<string, number>();
for (const b of saga.beats) byDay.set(b.t.slice(0, 10), (byDay.get(b.t.slice(0, 10)) ?? 0) + 1);
const days = [...byDay.entries()].filter(([, n]) => n >= 3).map(([d]) => d).slice(-wantDays);

console.log(`Commander: ${saga.cmdr} · Ship: ${saga.ship || 'unknown'}`);
console.log(`Episodes to narrate: ${days.join(', ')}\n`);

const client = new LmStudioClient({ timeoutMs: 180_000, temperature: 0.85, maxTokens: 3072 });
let storySoFar = '';
for (let i = 0; i < days.length; i++) {
  const day = days[i];
  console.log(`═══ EPISODE ${i + 1} — ${day} ═══`);
  const text = await client.chat(
    buildEpisodeChat({
      episodeNumber: i + 1,
      day,
      beats: saga.beatsForDay(day),
      cmdr: saga.cmdr,
      ship: saga.ship,
      storySoFar,
    }),
  );
  console.log(text ?? '(LM unavailable/empty)');
  console.log();
  if (text) storySoFar = text;
}
