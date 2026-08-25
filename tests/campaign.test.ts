/**
 * The campaign spine — elected, never invented.
 *
 * These pin the constitution: threads are ELECTED from journal evidence
 * (threshold + distinct kinds), incumbents defend with hysteresis, old
 * grudges decay, clocks fill into one payoff per voice and then cool down,
 * the vow is derived and does not flap, and nothing the LLM writes ever
 * mutates state — on-air memory records lines verbatim by name match only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CampaignTracker } from '../src/engine/campaign.ts';
import type { CampaignCtx } from '../src/engine/campaign.ts';
import type { JournalEvent, Mission } from '../src/engine/types.ts';

const T0 = Date.parse('2026-08-01T12:00:00Z');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const iso = (offset: number): string => new Date(T0 + offset).toISOString();

const ev = (event: string, offset: number, fields: Record<string, unknown> = {}): JournalEvent =>
  ({ timestamp: iso(offset), event, ...fields }) as unknown as JournalEvent;

const interdicted = (offset: number, faction = 'Sirius Corp', pilot = 'Kowalczyk'): JournalEvent =>
  ev('Interdicted', offset, { Faction: faction, Interdictor: pilot, Submitted: true, IsPlayer: false });

const hostileCtx = (faction = 'Sirius Corp', reputation = -50): CampaignCtx => ({
  factions: [{ name: faction, influence: 0.3, reputation }],
});

const mission = (faction: string): Mission => ({ faction }) as unknown as Mission;

// --------------------------------------------------------------- elections

test('a single interdiction with no other evidence does not elect', () => {
  const c = new CampaignTracker();
  c.observe(interdicted(0), {});
  assert.equal(c.view().pursuer, null);
});

test('repeated interdictions plus unfriendly standing elect the pursuer', () => {
  const c = new CampaignTracker();
  c.observe(interdicted(0), hostileCtx());
  c.observe(interdicted(10 * HOUR), hostileCtx());
  assert.equal(c.view().pursuer?.faction, 'Sirius Corp');
});

test('sustained mission work elects the patron', () => {
  const c = new CampaignTracker();
  for (let i = 0; i < 3; i++) {
    c.observe(
      ev('MissionCompleted', i * HOUR, {
        Faction: 'Lyakhov Horizons',
        FactionEffects: [{ Faction: 'Lyakhov Horizons', Reputation: '++' }],
      }),
      {},
    );
  }
  assert.equal(c.view().patron?.faction, 'Lyakhov Horizons');
});

test('old grudges fade — two quiet weeks close the thread', () => {
  const c = new CampaignTracker();
  c.observe(interdicted(0), hostileCtx());
  c.observe(interdicted(HOUR), hostileCtx());
  assert.ok(c.view().pursuer);
  // Standing hostility alone (+2) cannot hold the thread once the events fade.
  c.observe(ev('Docked', 14 * DAY), {});
  assert.equal(c.view().pursuer, null);
});

test('the patron cannot be elected pursuer while it holds the role', () => {
  const c = new CampaignTracker();
  const friendly: CampaignCtx = { factions: [{ name: 'Lyakhov Horizons', influence: 0.4, reputation: 60 }] };
  for (let i = 0; i < 3; i++) {
    c.observe(
      ev('MissionCompleted', i * HOUR, {
        Faction: 'Lyakhov Horizons',
        FactionEffects: [{ Faction: 'Lyakhov Horizons', Reputation: '+' }],
      }),
      friendly,
    );
  }
  assert.equal(c.view().patron?.faction, 'Lyakhov Horizons');
  c.observe(interdicted(4 * HOUR, 'Lyakhov Horizons'), friendly);
  assert.equal(c.view().patron?.faction, 'Lyakhov Horizons');
  assert.equal(c.view().pursuer, null);
});

test('a marginally stronger challenger does not usurp; a dominant one does', () => {
  const c = new CampaignTracker();
  const both: CampaignCtx = {
    factions: [
      { name: 'Alpha Syndicate', influence: 0.3, reputation: -50 },
      { name: 'Beta Cartel', influence: 0.2, reputation: -50 },
    ],
  };
  c.observe(interdicted(0, 'Alpha Syndicate', 'Pilot A'), both);
  c.observe(interdicted(HOUR, 'Alpha Syndicate', 'Pilot A'), both);
  assert.equal(c.view().pursuer?.faction, 'Alpha Syndicate');
  // Beta pulls level (score ~8 vs ~8): not 1.5× — Alpha keeps the role.
  c.observe(interdicted(2 * HOUR, 'Beta Cartel', 'Pilot B'), both);
  c.observe(interdicted(3 * HOUR, 'Beta Cartel', 'Pilot B'), both);
  assert.equal(c.view().pursuer?.faction, 'Alpha Syndicate');
  // Two more put Beta at ~14 against ~12 needed — the role changes hands.
  c.observe(interdicted(4 * HOUR, 'Beta Cartel', 'Pilot B'), both);
  c.observe(interdicted(5 * HOUR, 'Beta Cartel', 'Pilot B'), both);
  assert.equal(c.view().pursuer?.faction, 'Beta Cartel');
});

// ------------------------------------------------------------------ clocks

/** Elect Sirius Corp with ONE interdiction under hostile standing (3 + 2 = 5,
 *  two kinds) — the thread opens with its clock at 0, because events from
 *  before the election never land on a thread that did not exist yet. */
function elected(): CampaignTracker {
  const c = new CampaignTracker();
  c.observe(interdicted(0), hostileCtx());
  assert.equal(c.view().pursuer?.faction, 'Sirius Corp');
  assert.equal(c.view().pursuer?.clock, 0);
  return c;
}

test('the clock fills into one payoff per voice, then resets into cooldown', () => {
  const c = elected();
  c.observe(interdicted(1 * HOUR), hostileCtx());
  c.observe(interdicted(2 * HOUR), hostileCtx());
  assert.equal(c.view().pursuer?.clock, 4);
  c.observe(interdicted(3 * HOUR), hostileCtx());
  const v = c.view();
  assert.equal(v.pursuer?.clock, 0);
  assert.ok(v.pursuer?.cooldownUntil);
  for (const voice of ['operator', 'news', 'comms'] as const) {
    assert.equal(v.payoffs[voice]?.faction, 'Sirius Corp');
  }
});

test('the cooldown freezes the clock — no machine-gun payoffs', () => {
  const c = elected();
  for (const h of [1, 2, 3]) c.observe(interdicted(h * HOUR), hostileCtx());
  assert.equal(c.view().pursuer?.clock, 0);
  c.observe(interdicted(4 * HOUR), hostileCtx());
  assert.equal(c.view().pursuer?.clock, 0);
});

test('consuming a payoff spends it for that voice only', () => {
  const c = elected();
  for (const h of [1, 2, 3]) c.observe(interdicted(h * HOUR), hostileCtx());
  assert.equal(c.consumePayoff('comms'), true);
  assert.equal(c.consumePayoff('comms'), false);
  const v = c.view();
  assert.equal(v.payoffs.comms, undefined);
  assert.ok(v.payoffs.news);
  assert.ok(v.payoffs.operator);
});

test('unconsumed payoffs expire with the cooldown', () => {
  const c = elected();
  for (const h of [1, 2, 3]) c.observe(interdicted(h * HOUR), hostileCtx());
  c.sweep(T0 + 3 * HOUR + 25 * HOUR);
  const v = c.view();
  assert.equal(v.payoffs.comms, undefined);
  assert.equal(v.payoffs.news, undefined);
  assert.equal(v.payoffs.operator, undefined);
});

test('a quiet week bleeds a segment off the clock', () => {
  const c = elected();
  c.observe(interdicted(1 * HOUR), hostileCtx());
  assert.equal(c.view().pursuer?.clock, 2);
  // sweep() is the decay mechanic on its own. A full observe() at +8 days
  // would ALSO close this young thread outright (its evidence has decayed
  // below the election bar by then) — which is the previous test, not this one.
  c.sweep(T0 + 1 * HOUR + 8 * DAY);
  assert.equal(c.view().pursuer?.clock, 1);
});

test('advance a threat moves one segment but can never fill the last', () => {
  const c = elected();
  const t1 = c.advanceThreat(T0 + 5 * HOUR);
  assert.equal(t1?.clock, 1);
  for (let i = 0; i < 10; i++) c.advanceThreat(T0 + 6 * HOUR);
  assert.equal(c.view().pursuer?.clock, 5);
  assert.equal(c.view().payoffs.comms, undefined);
});

test('advance a threat with nothing elected changes nothing', () => {
  const c = new CampaignTracker();
  assert.equal(c.advanceThreat(T0), null);
});

// --------------------------------------------------------------------- vow

test('the vow names the dominant mission faction and tracks its count', () => {
  const c = new CampaignTracker();
  c.updateVow([mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp'), mission('Other')], null);
  assert.match(c.view().vow ?? '', /Sirius Corp/);
  assert.match(c.view().vow ?? '', /3 contracts/);
  c.updateVow([mission('Sirius Corp'), mission('Sirius Corp')], null);
  assert.match(c.view().vow ?? '', /2 contracts/);
});

test('one stray mission does not flap the vow', () => {
  const c = new CampaignTracker();
  c.updateVow([mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp')], null);
  const before = c.view().vow;
  c.updateVow(
    [mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp'), mission('Other')],
    null,
  );
  assert.equal(c.view().vow, before);
});

test('a single contract is an errand, not a vow', () => {
  const c = new CampaignTracker();
  c.updateVow([mission('Sirius Corp')], null);
  assert.equal(c.view().vow, null);
  c.updateVow([mission('Sirius Corp')], 'mining');
  assert.match(c.view().vow ?? '', /rings/);
});

test('a faction already named The keeps a single article in the vow', () => {
  const c = new CampaignTracker();
  c.updateVow([mission('The Dark Wheel'), mission('The Dark Wheel')], null);
  assert.match(c.view().vow ?? '', /See the Dark Wheel work/);
  assert.ok(!/the The/i.test(c.view().vow ?? ''));
});

test('repeated identical beats keep one copy but still wind the clock', () => {
  const c = elected();
  c.observe(interdicted(1 * HOUR), hostileCtx());
  c.observe(interdicted(2 * HOUR), hostileCtx());
  const t = c.view().pursuer;
  assert.equal(t?.clock, 4);
  assert.equal(t?.beats.length, 1);
});

test('with no contracts the chapter carries the vow', () => {
  const c = new CampaignTracker();
  c.updateVow([], 'mining');
  assert.match(c.view().vow ?? '', /rings/);
});

test('a vow whose contracts are all handed in yields instead of going stale', () => {
  const c = new CampaignTracker();
  c.updateVow([mission('Sirius Corp'), mission('Sirius Corp'), mission('Sirius Corp')], null);
  c.updateVow([], 'mining');
  assert.match(c.view().vow ?? '', /rings/);
});

// ------------------------------------------------------------ on-air memory

test('on-air lines naming the faction are stored verbatim, best line first', () => {
  const c = elected();
  const changed = c.recordOnAir(
    ['Word on the lane is quiet tonight', 'They say Sirius Corp pays double for silence out here'],
    iso(6 * HOUR),
  );
  assert.equal(changed, true);
  assert.equal(c.view().pursuer?.onAir[0]?.text, 'They say Sirius Corp pays double for silence out here');
});

test('a name inside a longer word does not match', () => {
  const c = elected();
  const changed = c.recordOnAir(['The Sirius Corporation annual review is out'], iso(6 * HOUR));
  assert.equal(changed, false);
  assert.equal(c.view().pursuer?.onAir.length, 0);
});

test('on-air memory keeps the last three lines', () => {
  const c = elected();
  for (let i = 0; i < 5; i++) {
    c.recordOnAir([`Sirius Corp line number ${i}`], iso((6 + i) * HOUR));
  }
  const onAir = c.view().pursuer?.onAir ?? [];
  assert.equal(onAir.length, 3);
  assert.equal(onAir[0]?.text, 'Sirius Corp line number 4');
});

// ------------------------------------------------- persistence and identity

test('toJSON/load round-trips the whole campaign', () => {
  const c = elected();
  c.observe(interdicted(2 * HOUR), hostileCtx());
  c.updateVow([mission('Sirius Corp')], null);
  c.recordOnAir(['Sirius Corp again'], iso(3 * HOUR));
  const revived = new CampaignTracker();
  revived.load(JSON.parse(JSON.stringify(c.toJSON())));
  assert.deepEqual(revived.view(), c.view());
  assert.equal(revived.commander, c.commander);
});

test('a relaunch replay skips events older than the watermark', () => {
  const c = new CampaignTracker();
  c.observe(ev('Docked', HOUR), {});
  const revived = new CampaignTracker();
  revived.load(JSON.parse(JSON.stringify(c.toJSON())));
  // Would elect if folded (3 + 2 standing, two kinds) — the watermark says no.
  revived.observe(interdicted(0), hostileCtx(), true);
  assert.equal(revived.view().pursuer, null);
});

const mcAt = (offset: number): JournalEvent =>
  ev('MissionCompleted', offset, { Faction: 'Lyakhov Horizons' });
const rvAt = (offset: number): JournalEvent =>
  ev('RedeemVoucher', offset, { Type: 'bounty', Factions: [{ Faction: 'Lyakhov Horizons' }] });

test('a same-second burst replays without loss', () => {
  // Journal stamps are seconds-resolution and hand-in bursts share one; a bare
  // timestamp watermark would fold only the first sibling.
  const c = new CampaignTracker();
  for (const e of [mcAt(0), mcAt(0), rvAt(0)]) c.observe(e, {}, true);
  assert.equal(c.view().patron?.faction, 'Lyakhov Horizons');
});

test('a relaunch replay of the same burst never double-counts', () => {
  const c = new CampaignTracker();
  const burst = [mcAt(0), rvAt(0)];
  for (const e of burst) c.observe(e, {}, true);
  assert.equal(c.view().patron, null); // 3 points — below the bar
  // Next launch: fresh tracker, stored state, same journal replayed.
  const revived = new CampaignTracker();
  revived.load(JSON.parse(JSON.stringify(c.toJSON())));
  for (const e of burst) revived.observe(e, {}, true);
  assert.equal(revived.view().patron, null); // still 3, not 6
});

test('a different commander starts a fresh campaign', () => {
  const c = new CampaignTracker();
  c.observe(ev('LoadGame', 0, { Commander: 'Jaenelle' }), {});
  c.observe(interdicted(HOUR), hostileCtx());
  c.observe(interdicted(2 * HOUR), hostileCtx());
  assert.ok(c.view().pursuer);
  c.observe(ev('LoadGame', 3 * HOUR, { Commander: 'Thorn' }), {});
  assert.equal(c.view().pursuer, null);
  assert.equal(c.commander, 'Thorn');
});

test('corrupt storage falls back to a fresh campaign', () => {
  const c = new CampaignTracker();
  c.load('not an object');
  c.load({ evidence: 7, pursuer: null });
  assert.equal(c.view().pursuer, null);
  assert.equal(c.view().vow, null);
});
