/**
 * Personas, the persistent cast, and arcs.
 *
 * Continuity is the thing being protected here: a voice that changes between
 * sessions, or a regular who is evicted while a walk-on survives, breaks the
 * only mechanism that separates this from a quote generator.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ARC_STALE_MS,
  CastBook,
  MAX_PER_SYSTEM,
  MAX_PROMOTIONS_PER_SESSION,
  MAX_SYSTEMS,
  QUIRKS,
  TIMBRE_STEPS,
  appendBeat,
  buildPersonaPool,
  canPromote,
  inventName,
  isStale,
  promotionToMember,
  resolvePersona,
  type Arc,
  type CastMember,
  type Persona,
} from '../src/engine/chatter/cast.ts';

const VOICES = ['en_GB-alba-medium', 'en_GB-northern_english_male-medium'];
const T0 = Date.parse('2026-08-01T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: 'p1',
  voice: VOICES[0],
  timbre: 1,
  profile: null,
  quirk: 'clipped',
  ...over,
});

const member = (over: Partial<CastMember> = {}): CastMember => ({
  name: 'Ines Achebe',
  persona: persona(),
  homeSystem: 'Ratraii',
  channel: 'LOCAL',
  role: 'hauler',
  firstAt: iso(T0),
  lastAt: iso(T0),
  arcs: [],
  ...over,
});

const arc = (over: Partial<Arc> = {}): Arc => ({
  id: 'a1',
  subjectKind: 'price',
  subjectKey: 'Bertrandite@Hurston Ring',
  beats: [],
  state: 'open',
  lastSeenAt: iso(T0),
  ...over,
});

// ---------------------------------------------------------------------------
// Personas
// ---------------------------------------------------------------------------

test('the persona pool is voices x measured timbre steps x quirks', () => {
  const pool = buildPersonaPool(VOICES);
  assert.equal(pool.length, VOICES.length * TIMBRE_STEPS.length * QUIRKS.length);
  assert.equal(new Set(pool.map((p) => p.id)).size, pool.length, 'ids must be unique');
});

test('timbre steps stay inside the range the spike actually supports', () => {
  // Outside 0.94..1.06 the tempo cancellation breaks down (design D7a).
  for (const t of TIMBRE_STEPS) {
    assert.ok(t >= 0.94 && t <= 1.06, `${t} is outside the measured usable window`);
  }
});

test('personas carry no profile of their own', () => {
  // A persona that fixed its own profile would sound the same calling from a
  // station and from a drifting hulk, throwing away the range modelling.
  for (const p of buildPersonaPool(VOICES)) assert.equal(p.profile, null);
});

test('an installed voice resolves unchanged', () => {
  const p = persona({ voice: VOICES[1] });
  assert.equal(resolvePersona(p, VOICES), p);
  assert.equal(resolvePersona(p, VOICES).substituted, undefined);
});

test('a missing voice is substituted and the swap is recorded', () => {
  const p = persona({ voice: 'en_US-someone-removed' });
  const r = resolvePersona(p, VOICES);
  assert.ok(VOICES.includes(r.voice));
  assert.equal(r.substituted, true);
});

test('substitution is deterministic, so a character does not drift', () => {
  const p = persona({ voice: 'en_US-gone' });
  assert.equal(resolvePersona(p, VOICES).voice, resolvePersona(p, VOICES).voice);
});

test('substitution survives having no voices at all', () => {
  const r = resolvePersona(persona(), []);
  assert.equal(r.substituted, true);
});

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

test('a cast member survives a save and load cycle with the same persona', () => {
  const a = new CastBook();
  a.remember(member({ persona: persona({ voice: VOICES[1], timbre: 1.06, quirk: 'bored' }) }));

  const b = new CastBook();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));

  const found = b.find('Ratraii', 'Ines Achebe');
  assert.ok(found);
  assert.deepEqual(found.persona, {
    id: 'p1',
    voice: VOICES[1],
    timbre: 1.06,
    profile: null,
    quirk: 'bored',
  });
});

test('loading garbage leaves an empty book rather than throwing', () => {
  const b = new CastBook();
  assert.doesNotThrow(() => b.load(null));
  assert.doesNotThrow(() => b.load({ v: 99 }));
  assert.doesNotThrow(() => b.load({ v: 1, members: 'nope' }));
  assert.equal(b.size, 0);
});

test('loading drops malformed members but keeps good ones', () => {
  const b = new CastBook();
  b.load({ v: 1, members: [member(), { nope: true }, null] });
  assert.equal(b.size, 1);
});

// ---------------------------------------------------------------------------
// Returning to a system
// ---------------------------------------------------------------------------

test('returning to a system reuses its cast instead of inventing', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Regular One' }));
  b.remember(member({ name: 'Regular Two' }));

  for (let i = 0; i < 20; i++) {
    const got = b.castFor('Ratraii', 'hauler', 'LOCAL', () => i / 20);
    assert.ok(got, 'a known system must yield a known voice');
    assert.ok(['Regular One', 'Regular Two'].includes(got.name));
  }
});

test('an unknown system yields nobody, so a new character is invented', () => {
  const b = new CastBook();
  b.remember(member());
  assert.equal(b.castFor('Somewhere Else', 'hauler', 'LOCAL', () => 0.5), null);
});

test('castFor respects role and channel', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Tower', role: 'control', channel: 'STATION' }));
  assert.equal(b.castFor('Ratraii', 'hauler', 'LOCAL', () => 0.5), null);
  assert.equal(b.castFor('Ratraii', 'control', 'STATION', () => 0.5)?.name, 'Tower');
});

test('members with an open arc are favoured — they have somewhere to go', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Has Arc', arcs: [arc()] }));
  b.remember(member({ name: 'No Arc' }));

  let withArc = 0;
  for (let i = 0; i < 100; i++) {
    if (b.castFor('Ratraii', 'hauler', 'LOCAL', () => (i % 10) / 10)?.name === 'Has Arc') {
      withArc += 1;
    }
  }
  assert.ok(withArc > 50, `expected the arc-carrying member to dominate, got ${withArc}/100`);
});

test('remembering someone already known refreshes rather than duplicating', () => {
  const b = new CastBook();
  b.remember(member());
  b.remember(member({ lastAt: iso(T0 + 60_000) }));
  assert.equal(b.forSystem('Ratraii').length, 1);
  assert.equal(b.find('Ratraii', 'Ines Achebe')?.lastAt, iso(T0 + 60_000));
});

// ---------------------------------------------------------------------------
// Caps
// ---------------------------------------------------------------------------

test('a system is capped and keeps the most recently heard', () => {
  const b = new CastBook();
  for (let i = 0; i < MAX_PER_SYSTEM + 5; i++) {
    b.remember(member({ name: `Walkon ${i}`, lastAt: iso(T0 + i * 60_000) }));
  }
  b.prune(T0 + 100 * 60_000);
  const kept = b.forSystem('Ratraii');
  assert.equal(kept.length, MAX_PER_SYSTEM);
  assert.ok(kept.some((m) => m.name === `Walkon ${MAX_PER_SYSTEM + 4}`), 'newest must survive');
  assert.ok(!kept.some((m) => m.name === 'Walkon 0'), 'oldest must go');
});

test('a regular with an open arc outlives a more recent walk-on', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Regular', lastAt: iso(T0), arcs: [arc()] }));
  for (let i = 0; i < MAX_PER_SYSTEM + 2; i++) {
    b.remember(member({ name: `Walkon ${i}`, lastAt: iso(T0 + 60_000 + i * 1_000) }));
  }
  b.prune(T0 + 200_000);
  assert.ok(
    b.forSystem('Ratraii').some((m) => m.name === 'Regular'),
    'continuity should beat mere recency',
  );
});

test('a real promoted vessel is preferred over an invented walk-on', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Real Ship', lastAt: iso(T0), real: true }));
  for (let i = 0; i < MAX_PER_SYSTEM + 2; i++) {
    b.remember(member({ name: `Walkon ${i}`, lastAt: iso(T0 + 60_000 + i * 1_000) }));
  }
  b.prune(T0 + 200_000);
  assert.ok(b.forSystem('Ratraii').some((m) => m.name === 'Real Ship'));
});

test('the number of systems retained is bounded', () => {
  const b = new CastBook();
  for (let i = 0; i < MAX_SYSTEMS + 10; i++) {
    b.remember(member({ name: `Voice ${i}`, homeSystem: `System ${i}`, lastAt: iso(T0 + i * 1000) }));
  }
  b.prune(T0 + 999_999);
  const systems = new Set<string>();
  for (let i = 0; i < MAX_SYSTEMS + 10; i++) {
    for (const m of b.forSystem(`System ${i}`)) systems.add(m.homeSystem);
  }
  assert.ok(systems.size <= MAX_SYSTEMS, `retained ${systems.size} systems`);
  assert.ok(systems.has(`System ${MAX_SYSTEMS + 9}`), 'the newest system must survive');
});

// ---------------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------------

test('an arc accumulates beats', () => {
  let a = arc();
  a = appendBeat(a, { at: iso(T0), func: 'establish', summary: 'price complaint' });
  a = appendBeat(a, { at: iso(T0 + 1000), func: 'complicate', summary: 'it got worse' });
  assert.equal(a.beats.length, 2);
  assert.equal(a.state, 'open', 'setup and complication do not close it');
});

test('a reverse or aftermath beat pays the arc off', () => {
  for (const func of ['reverse', 'aftermath'] as const) {
    const a = appendBeat(arc(), { at: iso(T0), func, summary: 'turned' });
    assert.equal(a.state, 'paid', `${func} should close the arc`);
  }
});

test('a paid arc is no longer preferred for new scenes', () => {
  const b = new CastBook();
  b.remember(member({ name: 'Paid Off', arcs: [arc({ state: 'paid' })] }));
  assert.deepEqual(b.openArcs(), []);
});

test('beats are bounded so an arc cannot grow forever', () => {
  let a = arc();
  for (let i = 0; i < 30; i++) {
    a = appendBeat(a, { at: iso(T0 + i), func: 'complicate', summary: `beat ${i}` });
  }
  assert.ok(a.beats.length <= 8);
  assert.equal(a.beats[a.beats.length - 1].summary, 'beat 29', 'the newest beats are kept');
});

test('an arc whose subject has gone quiet is dropped', () => {
  const old = arc({ lastSeenAt: iso(T0 - ARC_STALE_MS - 1) });
  assert.equal(isStale(old, T0), true);
  assert.equal(isStale(arc({ lastSeenAt: iso(T0 - 1000) }), T0), false);

  const b = new CastBook();
  b.remember(member({ arcs: [old] }));
  assert.equal(b.dropStaleArcs(T0), 1);
  assert.deepEqual(b.openArcs(), []);
});

test('a dropped arc is not re-dropped', () => {
  const b = new CastBook();
  b.remember(member({ arcs: [arc({ lastSeenAt: iso(T0 - ARC_STALE_MS - 1) })] }));
  assert.equal(b.dropStaleArcs(T0), 1);
  assert.equal(b.dropStaleArcs(T0), 0);
});

test('arcs survive a restart', () => {
  const a = new CastBook();
  a.remember(member({ arcs: [arc({ beats: [{ at: iso(T0), func: 'establish', summary: 's' }] })] }));

  const b = new CastBook();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  const open = b.openArcs();
  assert.equal(open.length, 1);
  assert.equal(open[0].arc.beats.length, 1);
  assert.equal(open[0].member.name, 'Ines Achebe');
});

test('a character does not carry an unbounded number of open threads', () => {
  const b = new CastBook();
  b.remember(member());
  for (let i = 0; i < 10; i++) {
    b.upsertArc('Ratraii', 'Ines Achebe', arc({ id: `arc${i}`, subjectKey: `k${i}` }));
  }
  const m = b.find('Ratraii', 'Ines Achebe')!;
  assert.ok(m.arcs.filter((x) => x.state === 'open').length <= 3, 'not a soap opera');
});

test('upsertArc updates an existing arc rather than adding a twin', () => {
  const b = new CastBook();
  b.remember(member({ arcs: [arc()] }));
  b.upsertArc('Ratraii', 'Ines Achebe', appendBeat(arc(), {
    at: iso(T0 + 5),
    func: 'complicate',
    summary: 'worse',
  }));
  const m = b.find('Ratraii', 'Ines Achebe')!;
  assert.equal(m.arcs.filter((a) => a.id === 'a1').length, 1);
  assert.equal(m.arcs.find((a) => a.id === 'a1')?.beats.length, 1);
});

// ---------------------------------------------------------------------------
// Promotion from real transmissions
// ---------------------------------------------------------------------------

const req = (over: Partial<Parameters<typeof canPromote>[0]> = {}) => ({
  from: 'Iron Marlin',
  code: '$Trader_Greeting;',
  system: 'Ratraii',
  atIso: iso(T0),
  ...over,
});

test('a friendly named vessel may be promoted', () => {
  assert.equal(canPromote(req(), 0), true);
});

test('hostile senders are never promoted', () => {
  for (const code of [
    '$Pirate_Attack;',
    '$Interdiction_Threaten;',
    '$CargoHunter_Attack;',
    '$PassengerHunter_Attack;',
  ]) {
    assert.equal(canPromote(req({ code }), 0), false, `${code} should be excluded`);
  }
});

test('station plumbing is not a character', () => {
  for (const code of ['$COMMS_entered:#name=Foo;', '$STATION_docking_denied;', '$DockingChatter;']) {
    assert.equal(canPromote(req({ code }), 0), false, `${code} should be excluded`);
  }
});

test('an unnamed sender is not promoted', () => {
  assert.equal(canPromote(req({ from: '   ' }), 0), false);
});

test('promotion is capped per session', () => {
  assert.equal(canPromote(req(), MAX_PROMOTIONS_PER_SESSION - 1), true);
  assert.equal(canPromote(req(), MAX_PROMOTIONS_PER_SESSION), false);
});

test('a promoted vessel is marked real and lands in the right system', () => {
  const m = promotionToMember(req(), persona());
  assert.equal(m.real, true);
  assert.equal(m.name, 'Iron Marlin');
  assert.equal(m.homeSystem, 'Ratraii');
  assert.equal(m.channel, 'LOCAL');
});

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

test('institutions are named for the institution, not given a first name', () => {
  assert.equal(inventName('control', () => 0.5, 'Hurston Ring'), 'Hurston Ring');
  assert.equal(inventName('pa', () => 0.5, 'Hurston Ring'), 'Hurston Ring');
  assert.equal(inventName('carrier', () => 0.5, 'The Pearl of Donna'), 'The Pearl of Donna');
});

test('crew go by surname, strangers get a full name', () => {
  const crew = inventName('crew:engineering', () => 0.3, 'ctx');
  const stranger = inventName('hauler', () => 0.3, 'ctx');
  assert.ok(!crew.includes(' '), `crew name should be one word, got "${crew}"`);
  assert.ok(stranger.includes(' '), `stranger should have a full name, got "${stranger}"`);
});
