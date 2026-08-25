/**
 * The campaign, played theoretically — synthetic commanders, real engine.
 *
 * campaign-replay.ts answers "what would MY journals have told?"; this answers
 * "does the DRAMA work?" — because a peaceful history never fires the pursuer
 * path, the payoff cycle, an usurpation, or the oracle interplay. Each
 * scenario below drives the real CampaignTracker through a plausible stretch
 * of play at realistic timestamps and prints the timeline plus what each
 * voice's prompt would actually receive at the dramatic peak. Deterministic;
 * no engine, no LLM — this is the code layer the fiction stands on.
 *
 *   npx tsx scripts/campaign-sim.ts
 */
import { CampaignTracker, SPINE_VOICES } from '../src/engine/campaign.ts';
import type { CampaignCtx } from '../src/engine/campaign.ts';
import { spineLines } from '../src/engine/spine.ts';
import type { JournalEvent, Mission } from '../src/engine/types.ts';

const T0 = Date.parse('2026-09-01T18:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const iso = (t: number): string => new Date(T0 + t).toISOString();
const stamp = (t: number): string => `day ${(t / DAY).toFixed(1).padStart(4)}`;

const ev = (event: string, t: number, fields: Record<string, unknown> = {}): JournalEvent =>
  ({ timestamp: iso(t), event, ...fields }) as unknown as JournalEvent;

const mission = (faction: string): Mission => ({ faction }) as unknown as Mission;

/** A faction board where the commander's standings are what the story needs. */
const ctx = (...factions: Array<[string, number]>): CampaignCtx => ({
  factions: factions.map(([name, reputation]) => ({ name, influence: 0.2, reputation })),
});

interface Step {
  t: number;
  note: string;
  ev?: JournalEvent;
  ctx?: CampaignCtx;
  run?: (c: CampaignTracker, t: number) => void;
}

function play(title: string, steps: Step[], peekAt?: string): CampaignTracker {
  console.log(`\n${'='.repeat(74)}\n${title}\n${'='.repeat(74)}`);
  const c = new CampaignTracker();
  let last = '';
  for (const s of steps) {
    if (s.ev) c.observe(s.ev, s.ctx ?? {});
    if (s.run) s.run(c, s.t);
    const v = c.view();
    const line =
      `pursuer ${v.pursuer ? `${v.pursuer.faction} ${v.pursuer.clock}/6` : '—'}` +
      ` · patron ${v.patron ? `${v.patron.faction} ${v.patron.clock}/6` : '—'}` +
      ` · vow ${v.vow ? `"${v.vow}"` : '—'}` +
      (Object.keys(v.payoffs).length ? ` · PAYOFF PENDING (${Object.keys(v.payoffs).length} voices)` : '');
    const changed = line !== last ? '  <<' : '';
    console.log(`${stamp(s.t)}  ${s.note.padEnd(46)} ${line}${changed}`);
    last = line;
    if (peekAt && s.note === peekAt) {
      for (const voice of SPINE_VOICES) {
        console.log(`         [${voice}]`);
        for (const l of spineLines(c.view(), voice)) console.log(`           ${l}`);
      }
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// 1. THE HUNTED COURIER — full pursuer lifecycle: election, clock, payoff,
//    cooldown, quiet decay, and the thread finally going cold.
// ---------------------------------------------------------------------------
const KUMO = ctx(['Kumo Crew', -60]);
play(
  'SCENARIO 1 — the hunted courier (pursuer: elect → fill → payoff → fade)',
  [
    { t: 0, note: 'interdicted by Kumo Crew (hostile standing)', ev: ev('Interdicted', 0, { Faction: 'Kumo Crew', Interdictor: 'Voss', Submitted: true }), ctx: KUMO },
    { t: 5 * HOUR, note: 'escaped a second interdiction (same pilot)', ev: ev('EscapeInterdiction', 5 * HOUR, { Interdictor: 'Voss' }), ctx: KUMO },
    { t: DAY, note: 'fined in their space', ev: ev('CommitCrime', DAY, { Faction: 'Kumo Crew', CrimeType: 'dockingMinorTresspass', Fine: 400 }), ctx: KUMO },
    { t: 2 * DAY, note: 'interdicted again', ev: ev('Interdicted', 2 * DAY, { Faction: 'Kumo Crew', Interdictor: 'Voss', Submitted: false }), ctx: KUMO },
    { t: 3 * DAY, note: 'and again — the clock fills', ev: ev('Interdicted', 3 * DAY, { Faction: 'Kumo Crew', Interdictor: 'Reyes', Submitted: true }), ctx: KUMO },
    { t: 3 * DAY + HOUR, note: 'comms scene airs about them', run: (c, t) => c.recordOnAir(['Word is Kumo Crew has a bounty book with your hull number in it'], iso(t)) },
    { t: 3 * DAY + 2 * HOUR, note: 'AT THE PEAK', run: () => {} },
    { t: 3 * DAY + 3 * HOUR, note: 'comms speaks its payoff beat', run: (c) => c.consumePayoff('comms') },
    { t: 3 * DAY + 4 * HOUR, note: 'interdicted during cooldown (clock frozen)', ev: ev('Interdicted', 3 * DAY + 4 * HOUR, { Faction: 'Kumo Crew', Interdictor: 'Reyes', Submitted: true }), ctx: KUMO },
    { t: 5 * DAY, note: 'unconsumed payoffs have expired', run: (c, t) => c.sweep(T0 + t) },
    { t: 12 * DAY, note: 'a quiet week — clock bleeds', ev: ev('Docked', 12 * DAY), ctx: KUMO },
    { t: 19 * DAY, note: 'two quiet weeks — the grudge goes cold', ev: ev('Docked', 19 * DAY) },
  ],
  'AT THE PEAK',
);

// ---------------------------------------------------------------------------
// 2. THE COMPANY MAN — patron lifecycle at a working hauler's pace.
// ---------------------------------------------------------------------------
const SIRIUS = ctx(['Sirius Corp', 40]);
const completed = (t: number) =>
  ev('MissionCompleted', t, { Faction: 'Sirius Corp', FactionEffects: [{ Faction: 'Sirius Corp', Reputation: '+' }] });
play(
  'SCENARIO 2 — the company man (patron: contracts build toward recognition)',
  [
    { t: 0, note: 'first contract completed', ev: completed(0), ctx: SIRIUS },
    { t: 2 * HOUR, note: 'second — elected on the spot', ev: completed(2 * HOUR), ctx: SIRIUS },
    { t: 4 * HOUR, note: 'third (clock starts moving)', ev: completed(4 * HOUR), ctx: SIRIUS },
    { t: DAY, note: 'vouchers cashed with them', ev: ev('RedeemVoucher', DAY, { Type: 'bounty', Factions: [{ Faction: 'Sirius Corp' }] }), ctx: SIRIUS },
    { t: DAY + 2 * HOUR, note: 'fourth contract', ev: completed(DAY + 2 * HOUR), ctx: SIRIUS },
    { t: 2 * DAY, note: 'fifth', ev: completed(2 * DAY), ctx: SIRIUS },
    { t: 2 * DAY + 2 * HOUR, note: 'sixth', ev: completed(2 * DAY + 2 * HOUR), ctx: SIRIUS },
    { t: 3 * DAY, note: 'seventh — recognition due', ev: completed(3 * DAY), ctx: SIRIUS },
    { t: 3 * DAY + HOUR, note: 'AT THE PEAK', run: () => {} },
  ],
  'AT THE PEAK',
);

// ---------------------------------------------------------------------------
// 3. THE WANDERER — evidence scattered thin: no thread may open.
// ---------------------------------------------------------------------------
play('SCENARIO 3 — the wanderer (thin evidence must NOT force drama)', [
  { t: 0, note: 'one interdiction from A', ev: ev('Interdicted', 0, { Faction: 'Faction A', Interdictor: 'X' }) },
  { t: 2 * DAY, note: 'one fine from B', ev: ev('CommitCrime', 2 * DAY, { Faction: 'Faction B', Fine: 200 }) },
  { t: 4 * DAY, note: 'one contract for C', ev: ev('MissionCompleted', 4 * DAY, { Faction: 'Faction C' }) },
  { t: 6 * DAY, note: 'one contract for D', ev: ev('MissionCompleted', 6 * DAY, { Faction: 'Faction D' }) },
]);

// ---------------------------------------------------------------------------
// 4. THE BETRAYAL — an incumbent pursuer usurped by a worse enemy.
// ---------------------------------------------------------------------------
const BOTH = ctx(['Archon Syndicate', -50], ['Void Reapers', -50]);
const raid = (t: number, faction: string, pilot: string) =>
  ev('Interdicted', t, { Faction: faction, Interdictor: pilot, Submitted: true });
play('SCENARIO 4 — the betrayal (usurpation needs 1.5×, then hands over)', [
  { t: 0, note: 'Archon interdiction — elected', ev: raid(0, 'Archon Syndicate', 'Kade'), ctx: BOTH },
  { t: HOUR, note: 'Archon again (clock 2)', ev: raid(HOUR, 'Archon Syndicate', 'Kade'), ctx: BOTH },
  { t: DAY, note: 'Reapers appear (level score — no usurp)', ev: raid(DAY, 'Void Reapers', 'Null'), ctx: BOTH },
  { t: DAY + HOUR, note: 'Reapers again (still not 1.5×)', ev: raid(DAY + HOUR, 'Void Reapers', 'Null'), ctx: BOTH },
  { t: DAY + 5 * HOUR, note: 'Reapers third', ev: raid(DAY + 5 * HOUR, 'Void Reapers', 'Null'), ctx: BOTH },
  { t: DAY + 9 * HOUR, note: 'Reapers fourth — the role changes hands', ev: raid(DAY + 9 * HOUR, 'Void Reapers', 'Null'), ctx: BOTH },
]);

// ---------------------------------------------------------------------------
// 5. THE ORACLE — the player leans on the fiction, reality lands the blow.
// ---------------------------------------------------------------------------
play('SCENARIO 5 — the oracle (advance-a-threat caps at 5/6; a REAL event pays off)', [
  { t: 0, note: 'pursuer elected', ev: raid(0, 'Kumo Crew', 'Voss'), ctx: KUMO },
  { t: HOUR, note: 'player: "advance a threat"', run: (c, t) => c.advanceThreat(T0 + t) },
  { t: HOUR + 1, note: 'again', run: (c, t) => c.advanceThreat(T0 + t) },
  { t: HOUR + 2, note: 'again', run: (c, t) => c.advanceThreat(T0 + t) },
  { t: HOUR + 3, note: 'again', run: (c, t) => c.advanceThreat(T0 + t) },
  { t: HOUR + 4, note: 'again — pinned at 5/6, never the last', run: (c, t) => c.advanceThreat(T0 + t) },
  { t: 2 * HOUR, note: 'a REAL interdiction fills it', ev: raid(2 * HOUR, 'Kumo Crew', 'Voss'), ctx: KUMO },
]);

// ---------------------------------------------------------------------------
// 6. THE VOW — contracts carry it, the chapter catches it.
// ---------------------------------------------------------------------------
play('SCENARIO 6 — the vow (missions → count tracks → chapter fallback)', [
  { t: 0, note: '3 contracts open for Sirius', run: (c) => c.updateVow([mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp')], null) },
  { t: HOUR, note: 'one stray contract for another faction', run: (c) => c.updateVow([mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp'), mission('Other')], null) },
  { t: 5 * HOUR, note: 'two handed in', run: (c) => c.updateVow([mission('Sirius Corp'), mission('Other')], 'mining') },
  { t: 8 * HOUR, note: 'all done — a mining shift carries it', run: (c) => c.updateVow([], 'mining') },
]);

console.log('\nDone — deterministic, engine-free, the layer the fiction stands on.');
