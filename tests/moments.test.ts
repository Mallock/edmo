/** Moments — the journal events the copilot could not hear, and the fight told
 *  once it is over. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { momentOf, CombatStreak, COMBAT_QUIET_MS } from '../src/engine/moments.ts';
import type { JournalEvent } from '../src/engine/types.ts';

const ev = (o: Record<string, unknown>): JournalEvent =>
  ({ timestamp: '3312-01-01T00:00:00Z', ...o }) as unknown as JournalEvent;

test('interdictions always land, with the outcome and the aggressor', () => {
  const sub = momentOf(ev({ event: 'Interdicted', Submitted: true, Interdictor: 'Kane Reid' }))!;
  assert.equal(sub.tier, 'mission');
  assert.match(sub.line, /Interdicted by Kane Reid — submitted/);
  const escaped = momentOf(ev({ event: 'EscapeInterdiction', Interdictor: 'Kane Reid' }))!;
  assert.match(escaped.line, /Shook off an interdiction attempt by Kane Reid/);
  // A player aggressor is worth naming as one; a Thargoid pull is its own dread.
  const pvp = momentOf(ev({ event: 'Interdicted', Submitted: false, Interdictor: 'CMDR X', IsPlayer: true }))!;
  assert.match(pvp.line, /\(another commander\)/);
  const tharg = momentOf(ev({ event: 'Interdicted', Submitted: true, IsThargoid: true }))!;
  assert.match(tharg.line, /something not human/);
});

test('a neutron boost is a discovery moment with the multiplier', () => {
  const m = momentOf(ev({ event: 'JetConeBoost', BoostValue: 4.0 }))!;
  assert.equal(m.tier, 'discovery');
  assert.match(m.line, /neutron star's jet cone/);
  assert.match(m.line, /×4\.0/);
});

test('fuel scooping only speaks when the tank comes back to full', () => {
  // Mid-scoop: noise, even with capacity known.
  assert.equal(momentOf(ev({ event: 'FuelScoop', Scooped: 2.1, Total: 14 }), { fuelCapacity: 32 }), null);
  // Full tank: one line.
  const full = momentOf(ev({ event: 'FuelScoop', Scooped: 1.2, Total: 31.9 }), { fuelCapacity: 32 })!;
  assert.equal(full.tier, 'travel');
  assert.match(full.line, /tank full/);
  // Capacity unknown → stay quiet rather than guess.
  assert.equal(momentOf(ev({ event: 'FuelScoop', Scooped: 1.2, Total: 31.9 })), null);
});

test('a signal-source drop scales with its threat', () => {
  const calm = momentOf(ev({ event: 'USSDrop', USSType_Localised: 'Degraded emissions', USSThreat: 0 }))!;
  assert.equal(calm.tier, 'discovery');
  assert.doesNotMatch(calm.line, /threat/);
  const hot = momentOf(ev({ event: 'USSDrop', USSType_Localised: 'Encoded emissions', USSThreat: 3 }))!;
  assert.equal(hot.tier, 'mission');
  assert.match(hot.line, /threat level 3/);
});

test('promotions, deaths, wings and feet become moments', () => {
  const promo = momentOf(ev({ event: 'Promotion', Explore: 7 }))!;
  assert.equal(promo.tier, 'mission');
  assert.match(promo.line, /Explore rank/);
  assert.equal(momentOf(ev({ event: 'Promotion' })), null); // no track → nothing to say
  const died = momentOf(ev({ event: 'Died', KillerName_Localised: 'Kane Reid' }))!;
  assert.equal(died.tier, 'mission');
  assert.match(died.line, /destroyed by Kane Reid/);
  assert.equal(momentOf(ev({ event: 'WingJoin' }))!.tier, 'travel');
  const foot = momentOf(ev({ event: 'Disembark', StationName: 'Jaques Station' }))!;
  assert.equal(foot.tier, 'arrival');
  assert.match(foot.line, /On foot at Jaques Station/);
});

test('an autopilot touchdown is not the commander landing', () => {
  assert.equal(momentOf(ev({ event: 'Touchdown', PlayerControlled: false, Body: 'Colonia 5 a' })), null);
  assert.match(momentOf(ev({ event: 'Touchdown', PlayerControlled: true, Body: 'Colonia 5 a' }))!.line, /Set down on Colonia 5 a/);
});

test('the ordinary journal stays silent', () => {
  for (const e of ['FSDJump', 'ReceiveText', 'Music', 'Cargo', 'UnderAttack', 'Bounty', 'Shutdown']) {
    assert.equal(momentOf(ev({ event: e })), null, `${e} must not be a moment`);
  }
});

// --- the fight, told once ----------------------------------------------------

test('a fight accumulates silently and is told once, after the quiet window', () => {
  const s = new CombatStreak();
  const t0 = 1_000_000;
  assert.equal(s.apply(ev({ event: 'Bounty', TotalReward: 84_000, VictimFaction: 'Nova Imperium' }), t0), true);
  assert.equal(s.apply(ev({ event: 'Bounty', TotalReward: 100_000, VictimFaction: 'Nova Imperium' }), t0 + 30_000), true);
  // Still hot: nothing to tell.
  assert.equal(s.flush(t0 + 40_000), null);
  // Quiet long enough: one line, with the totals.
  const line = s.flush(t0 + 30_000 + COMBAT_QUIET_MS)!;
  assert.match(line, /2 ships of Nova Imperium destroyed/);
  assert.match(line, /184,000 cr in bounties/);
  // Told once — the streak resets.
  assert.equal(s.flush(t0 + 10 * COMBAT_QUIET_MS), null);
  assert.equal(s.active(), false);
});

test('taking fire extends the fight without scoring it', () => {
  const s = new CombatStreak();
  const t0 = 0;
  s.apply(ev({ event: 'Bounty', TotalReward: 50_000 }), t0);
  // Fire keeps coming with no kill — the aftermath must wait.
  s.apply(ev({ event: 'UnderAttack' }), t0 + 50_000);
  assert.equal(s.flush(t0 + COMBAT_QUIET_MS + 1), null);
  assert.match(String(s.flush(t0 + 50_000 + COMBAT_QUIET_MS)), /1 ship destroyed/);
  // ...but fire with NO kills yet never arms the streak at all.
  const fresh = new CombatStreak();
  assert.equal(fresh.apply(ev({ event: 'UnderAttack' }), t0), false);
  assert.equal(fresh.flush(t0 + 10 * COMBAT_QUIET_MS), null);
});

test('a jump or docking ends the fight immediately when forced', () => {
  const s = new CombatStreak();
  s.apply(ev({ event: 'FactionKillBond', Reward: 32_000, VictimFaction: 'Nova Imperium' }), 0);
  const line = s.flush(1_000, true)!; // forced: the commander jumped away
  assert.match(line, /1 ship of Nova Imperium destroyed/);
  assert.match(line, /32,000 cr/);
});

test('combat-zone bonds and bounties fold into one fight', () => {
  const s = new CombatStreak();
  s.apply(ev({ event: 'Bounty', TotalReward: 10_000, VictimFaction: 'A' }), 0);
  s.apply(ev({ event: 'FactionKillBond', Reward: 20_000, VictimFaction: 'B' }), 1_000);
  const line = s.flush(0, true)!;
  assert.match(line, /2 ships of B destroyed/); // latest faction wins the label
  assert.match(line, /30,000 cr/);
});

test('a fight with no payout is still a fight', () => {
  const s = new CombatStreak();
  s.apply(ev({ event: 'Bounty', VictimFaction: 'Nova Imperium' }), 0);
  const line = s.flush(0, true)!;
  assert.match(line, /1 ship of Nova Imperium destroyed\.$/);
  assert.doesNotMatch(line, /cr in bounties/);
});
