/**
 * What the port memory makes of the commander's real docking history.
 *
 * The welcome is only as good as the record behind it, so this replays every
 * `Docked` event on disk and prints what a station would actually be able to
 * say — plus the carriers, which are the interesting case because they move.
 *
 *   npx tsx scripts/port-history.ts
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { PortMemory, portGreeting, carrierTravels, portLedger } from '../src/engine/ports.ts';

const DIR = join(homedir(), 'Saved Games', 'Frontier Developments', 'Elite Dangerous');
const files = readdirSync(DIR)
  .filter((f) => /^Journal\..*\.log$/.test(f))
  .sort();

const mem = new PortMemory();
let docked = 0;
let where: string | null = null;
for (const f of files) {
  let text: string;
  try {
    text = readFileSync(join(DIR, f), 'utf8');
  } catch {
    continue;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    // The ledger: trade and jobs belong to whatever we were docked at.
    if (e.event === 'MarketBuy') {
      mem.note(where, { bought: (e.Count as number) ?? 0, commodity: (e.Type_Localised as string) ?? null });
      continue;
    }
    if (e.event === 'MarketSell') {
      mem.note(where, {
        sold: (e.Count as number) ?? 0,
        credits: (e.TotalSale as number) ?? 0,
        commodity: (e.Type_Localised as string) ?? null,
      });
      continue;
    }
    if (e.event === 'MissionAccepted') { mem.note(where, { missionTaken: true }); continue; }
    if (e.event === 'MissionCompleted') {
      mem.note(where, { missionDone: true, credits: (e.Reward as number) ?? 0 });
      continue;
    }
    if (e.event === 'Undocked') { where = null; continue; }
    if (e.event !== 'Docked') continue;
    const name = e.StationName as string;
    if (!name) continue;
    docked++;
    mem.dock({
      name,
      system: (e.StarSystem as string) ?? 'unknown',
      type: (e.StationType as string) ?? null,
      faction: (e.StationFaction as { Name?: string } | undefined)?.Name ?? null,
      economy: (e.StationEconomy_Localised as string) ?? null,
      atIso: (e.timestamp as string) ?? '',
    });
    where = name;
  }
}

const now = Date.now();
console.log(`${docked} dockings across ${files.length} journals · ${mem.size()} distinct ports\n`);

const withLedger = mem.all().filter((p) => portLedger(p));
console.log(`ports with anything on the ledger: ${withLedger.length}
`);

console.log('THE HAUNTS — where this commander keeps going back to');
for (const p of mem.haunts(8)) {
  console.log(`  ${portGreeting(p, now, p.name)}`);
  const led = portLedger(p);
  if (led) console.log(`     ${led}`);
}

console.log('\nBUSIEST LEDGERS');
for (const p of withLedger.sort((a, b) => b.tonsBought + b.tonsSold - (a.tonsBought + a.tonsSold)).slice(0, 6)) {
  console.log(`  ${portLedger(p)}`);
}

const carriers = mem.all().filter((p) => p.carrier);
console.log(`\nCARRIERS (${carriers.length}) — places that move`);
for (const c of carriers.slice(0, 6)) {
  const travels = carrierTravels(c);
  console.log(`  ${c.name}: ${c.visits} visits · ${c.systems.length} system(s) · now ${c.system}`);
  if (travels) console.log(`     → ${travels}`);
}

console.log('\nMOST RECENT ARRIVALS, as the station would greet them');
for (const p of mem.all().slice(0, 6)) {
  console.log(`  ${portGreeting(p, now, p.name)}`);
}
