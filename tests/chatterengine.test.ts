/**
 * The assembled engine.
 *
 * Everything below runs in a bare Node process with no DOM, no audio device
 * and no model — which is the point. This is the layer where the expensive
 * mistakes live (a line transmitted during a firefight, a voice that changes
 * between sessions, a fabricated price reaching the speaker), and none of them
 * should need a running app to catch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatterEngine, type ChatterSource, type TickInput } from '../src/engine/chatter/engine.ts';
import { parseGrammar } from '../src/engine/chatter/grammar.ts';
import { BUNDLED_GRAMMAR } from '../src/engine/chatter/bundled-grammar.ts';
import { textureBrief, verifyAgainstBrief, type Brief } from '../src/engine/chatter/brief.ts';
import { sceneText, type Scene } from '../src/engine/chatter/scenes.ts';
import { hourlyCeiling } from '../src/engine/chatter/channels.ts';
import type { ChannelId } from '../src/engine/chatter/types.ts';

const GRAMMAR = parseGrammar(BUNDLED_GRAMMAR, 'bundled');
const VOICES = ['en_GB-alba-medium', 'en_GB-northern_english_male-medium'];
const T = 1_700_000_000_000;

/** A deterministic sequence, so a failure is reproducible. */
function seeded(seed = 1): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Most of this file exercises the GRAMMAR tier, so it asks for it explicitly.
 *
 * The shipped default is 'llm': templates are a finite catalogue and audible as
 * a loop within one session, so fresh writing is the primary source and going
 * occasionally quiet is the accepted cost. These tests are about the fallback
 * path, which still has to be correct for anyone who turns it on.
 */
function engine(seed = 1, source: ChatterSource = 'grammar'): ChatterEngine {
  return new ChatterEngine({ grammar: GRAMMAR, rand: seeded(seed), source });
}

function input(over: Partial<TickInput> = {}): TickInput {
  return {
    nowMs: T,
    pressure: 0,
    inCrisis: false,
    density: 'normal',
    system: 'Ratraii',
    briefs: [],
    installedVoices: VOICES,
    context: {
      onFoot: false,
      resolvedPorts: 2,
      portSeparationLs: 40,
      carrierPresent: false,
      population: 1_000_000,
      hasCrew: true,
      mutedChannels: new Set<ChannelId>(),
      emergencyBriefReady: false,
    },
    ...over,
  };
}

/**
 * Run many ticks far enough apart to always be due.
 *
 * `from` matters: an engine remembers when it last spoke, so a second run that
 * restarted the clock at T would look like time travelling backwards and
 * almost nothing would be due.
 */
function runTicks(
  e: ChatterEngine,
  n: number,
  over: Partial<TickInput> = {},
  from = T,
) {
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(e.tick(input({ ...over, nowMs: from + i * 10 * 60_000 })));
  }
  return out;
}

/** Where a run of `n` ticks starting at `from` ends up. */
const after = (n: number, from = T): number => from + n * 10 * 60_000;

// ---------------------------------------------------------------------------
// It works at all, with nothing but the grammar
// ---------------------------------------------------------------------------

test('the engine transmits with no model and no facts', () => {
  const results = runTicks(engine(), 12);
  const spoken = results.filter((r) => r.transmission);
  assert.ok(spoken.length > 0, 'the grammar tier must be able to fill the air alone');
});

test('every transmission is structurally sound and free of token syntax', () => {
  for (const r of runTicks(engine(3), 40)) {
    if (!r.transmission) continue;
    const text = sceneText(r.transmission.scene);
    assert.ok(!/[<>]/.test(text), `token syntax reached the air: ${text}`);
    assert.ok(r.transmission.scene.turns.length >= 1);
    assert.ok(r.transmission.scene.turns.length <= 4);
  }
});

test('every transmission casts a speaker for every turn', () => {
  for (const r of runTicks(engine(5), 40)) {
    if (!r.transmission) continue;
    assert.equal(
      r.transmission.cast.length,
      r.transmission.scene.turns.length,
      'every turn needs a voice',
    );
    for (const c of r.transmission.cast) {
      assert.ok(c.name, 'a speaker must have a name');
      assert.ok(VOICES.includes(c.persona.voice), `unknown voice ${c.persona.voice}`);
    }
  }
});

test('the same speakerRef within a scene is the same person', () => {
  for (const r of runTicks(engine(7), 60)) {
    const t = r.transmission;
    if (!t || t.scene.turns.length < 2) continue;
    const byRef = new Map<string, string>();
    t.scene.turns.forEach((turn, i) => {
      const name = t.cast[i].name;
      const seen = byRef.get(turn.speakerRef);
      if (seen) assert.equal(name, seen, 'one ref answered by two different people');
      byRef.set(turn.speakerRef, name);
    });
  }
});

test('a transmission carries the channel profile and range degradation', () => {
  const r = runTicks(engine(2), 20).find((x) => x.transmission?.channel === 'STATION');
  if (!r?.transmission) return; // channel selection is weighted; not guaranteed
  assert.equal(r.transmission.profile, 'station');
  assert.ok(r.transmission.degrade >= 0 && r.transmission.degrade <= 1);
});

// ---------------------------------------------------------------------------
// Cadence and the ceiling
// ---------------------------------------------------------------------------

test('back-to-back ticks are not due', () => {
  const e = engine();
  e.tick(input());
  const second = e.tick(input({ nowMs: T + 100 }));
  assert.equal(second.transmission, null);
  assert.equal(second.quietBecause, 'not-due');
});

test('the hourly ceiling is never exceeded however many ticks run', () => {
  const e = engine(11);
  let spoken = 0;
  // One tick a minute for two hours, always "due".
  for (let i = 0; i < 120; i++) {
    if (e.tick(input({ nowMs: T + i * 60_000 })).transmission) spoken += 1;
  }
  // The window rolls, so two hours may exceed one hour's ceiling — but never
  // by more than a second window's worth.
  assert.ok(
    spoken <= hourlyCeiling('normal') * 2,
    `${spoken} transmissions in two hours breaks the ceiling`,
  );
});

// ---------------------------------------------------------------------------
// CRISIS
// ---------------------------------------------------------------------------

test('nothing is transmitted during CRISIS', () => {
  const e = engine(13);
  for (let i = 0; i < 40; i++) {
    const r = e.tick(
      input({
        nowMs: T + i * 10 * 60_000,
        inCrisis: true,
        pressure: 0.9,
        context: { ...input().context, onFoot: true, carrierPresent: true },
      }),
    );
    assert.equal(r.act, 'CRISIS');
    assert.equal(r.transmission, null, 'the channel must be silent in a firefight');
  }
});

test('CRISIS discards anything pre-generated', () => {
  const e = engine();
  e.sceneSlots.reserve('channel:STATION', T + 10 * 60_000);
  e.sceneSlots.fulfil(
    'channel:STATION',
    {
      id: 'pre',
      channel: 'STATION',
      func: 'establish',
      turns: [{ speakerRef: 'control', text: 'Cleared to pad four.' }],
      brief: textureBrief('pre'),
      ttlMs: 60_000,
      tier: 'llm',
    },
    T,
  );
  assert.equal(e.sceneSlots.size, 1);
  e.tick(input({ inCrisis: true, pressure: 0.9 }));
  assert.equal(e.sceneSlots.size, 0, 'a line written before the shooting must not survive it');
});

test('the world comes back after the fight', () => {
  const e = engine(17);
  e.tick(input({ inCrisis: true, pressure: 0.9 }));
  const after = e.tick(input({ nowMs: T + 60_000, inCrisis: false, pressure: 0.9 }));
  assert.equal(after.act, 'AFTERMATH');
});

// ---------------------------------------------------------------------------
// Grounding, end to end
// ---------------------------------------------------------------------------

const marketBrief = (): Brief => ({
  kind: 'market',
  nouns: [
    { value: 'Bertrandite', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } },
    { value: 'Hurston Ring', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } },
  ],
  figures: [{ value: '380', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } }],
  tokens: {
    commodity: 'Bertrandite',
    station: 'Hurston Ring',
    system: 'Ratraii',
    price: '380',
    direction: 'down',
  },
  subjectKey: 'price:bertrandite@hurston ring',
  summary: 'Bertrandite down 380 at Hurston Ring',
});

test('NOTHING transmitted by the grammar tier can fail its own brief', () => {
  // The structural guarantee: grammar scenes bind tokens from the brief, so
  // they cannot assert anything it does not contain. Verified end to end
  // rather than assumed.
  const e = engine(23);
  let checked = 0;
  for (const r of runTicks(e, 60, { briefs: [marketBrief()] })) {
    const t = r.transmission;
    if (!t) continue;
    const verdict = verifyAgainstBrief(sceneText(t.scene), t.scene.brief);
    assert.equal(
      verdict.ok,
      true,
      `grammar scene asserted something unbriefed (${verdict.offending}): ${sceneText(t.scene)}`,
    );
    checked += 1;
  }
  assert.ok(checked > 0, 'nothing was transmitted, so nothing was proven');
});

test('a system with no resolved ports never names a station', () => {
  const e = engine(29);
  for (const r of runTicks(e, 30, {
    context: {
      ...input().context,
      resolvedPorts: 0,
      portSeparationLs: null,
      population: 0,
      carrierPresent: false,
    },
  })) {
    if (r.transmission) {
      assert.notEqual(r.transmission.channel, 'STATION');
      assert.notEqual(r.transmission.channel, 'CONCOURSE');
    }
  }
});

// ---------------------------------------------------------------------------
// Continuity
// ---------------------------------------------------------------------------

test('a voice heard in a system comes back with the same persona', () => {
  const e = engine(31);
  const first = runTicks(e, 30).find((r) => r.transmission);
  assert.ok(first?.transmission, 'needed at least one transmission');
  const known = first.transmission.cast[0];

  // Later transmissions in the same system should reuse recorded members.
  const later = runTicks(e, 40, {}, after(30)).filter((r) => r.transmission);
  const returning = later.flatMap((r) => r.transmission!.cast).filter((c) => c.returning);
  assert.ok(returning.length > 0, 'nobody ever came back');
  for (const c of returning) {
    if (c.name === known.name) assert.deepEqual(c.persona, known.persona);
  }
});

test('the cast and repetition ring survive a restart', () => {
  const a = engine(37);
  runTicks(a, 20);
  const saved = JSON.parse(JSON.stringify(a.toJSON()));

  const b = engine(37);
  b.load(saved);
  assert.equal(b.cast.size, a.cast.size);
  assert.ok(b.cast.size > 0, 'nothing was persisted to check');
});

test('maintain prunes without throwing', () => {
  const e = engine(41);
  runTicks(e, 20);
  assert.doesNotThrow(() => e.maintain(T + 40 * 86_400_000));
});

// ---------------------------------------------------------------------------
// Repetition
// ---------------------------------------------------------------------------

test('a long run does not keep saying the same thing', () => {
  const e = engine(43);
  const texts = runTicks(e, 60)
    .filter((r) => r.transmission)
    .map((r) => sceneText(r.transmission!.scene));
  assert.ok(texts.length >= 40, `only ${texts.length} transmissions to judge`);

  // Measured across four seeds with and without facts to hand: 59-77% of
  // transmissions in a sixty-beat run are distinct. That is a property of the
  // bundled template count, and the user's own grammar file is the designed
  // answer for anyone who wants more — so the bar is set at what the shipped
  // set actually delivers, not at an aspiration.
  const unique = new Set(texts).size;
  assert.ok(unique / texts.length > 0.55, `only ${unique}/${texts.length} were distinct`);
});

test('the same line never lands twice in a row', () => {
  // Far more noticeable than the overall ratio: an immediate repeat is the
  // thing that reads as broken.
  for (const seed of [43, 7, 101, 999]) {
    const texts = runTicks(engine(seed), 60)
      .filter((r) => r.transmission)
      .map((r) => sceneText(r.transmission!.scene));
    for (let i = 1; i < texts.length; i++) {
      assert.notEqual(texts[i], texts[i - 1], `seed ${seed} repeated itself back to back`);
    }
  }
});

test('having facts to hand makes the world MORE talkative, not less', () => {
  // This was a real bug: one factual brief has one subject key, so every
  // retry reused it, the same-subject gate rejected them all, and giving the
  // engine something real to say dropped it from 60 transmissions to 4.
  const geo: Brief = {
    kind: 'geography',
    nouns: [
      { value: 'Kepler Landing', source: { kind: 'geography', system: 'Ratraii' } },
      { value: 'Ratraii', source: { kind: 'geography', system: 'Ratraii' } },
    ],
    figures: [],
    tokens: { station: 'Kepler Landing', system: 'Ratraii', callsign: 'Kepler Landing' },
    subjectKey: 'geo:kepler landing',
    summary: 'Kepler Landing in Ratraii',
  };
  const without = runTicks(engine(43), 60).filter((r) => r.transmission).length;
  const with_ = runTicks(engine(43), 60, { briefs: [geo] }).filter((r) => r.transmission).length;
  assert.ok(
    with_ >= without * 0.9,
    `facts made it quieter: ${with_} with vs ${without} without`,
  );
});

test('exhausted material yields silence rather than repetition', () => {
  // A muted galaxy: every channel shut. The engine must report why and say
  // nothing, not fall back to something it already said.
  const e = engine(47);
  const r = e.tick(
    input({
      context: {
        ...input().context,
        mutedChannels: new Set<ChannelId>([
          'STATION', 'LOCAL', 'CREW', 'DEEP', 'EMERGENCY', 'CARRIER', 'CONCOURSE',
        ]),
      },
    }),
  );
  assert.equal(r.transmission, null);
  assert.equal(r.quietBecause, 'no-channel');
});

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

test('every tick reports the state of every channel for the panel', () => {
  const r = engine().tick(input());
  assert.equal(r.channels.length, 7);
  for (const c of r.channels) {
    if (!c.open) assert.ok(c.reason, `${c.id} closed with no reason`);
  }
});

test('act transitions are reported once', () => {
  const e = engine();
  const first = e.tick(input({ inCrisis: true, pressure: 0.9 }));
  assert.deepEqual(
    first.transitions.map((t) => `${t.from}->${t.to}`),
    ['QUIET->CRISIS'],
  );
  const second = e.tick(input({ nowMs: T + 1000, inCrisis: true, pressure: 0.9 }));
  assert.deepEqual(second.transitions, []);
});

// ---------------------------------------------------------------------------
// The LLM tier's entry points
// ---------------------------------------------------------------------------

const preScene = (over: Partial<Scene> = {}): Scene => ({
  id: 'pre',
  channel: 'LOCAL',
  func: 'aftermath',
  turns: [
    { speakerRef: 'hauler', text: 'Whatever went off out there, it is finished.' },
    { speakerRef: 'hauler2', text: 'Somebody is having a very bad day.' },
  ],
  brief: textureBrief('combat:1'),
  ttlMs: 90_000,
  tier: 'llm',
  ...over,
});

test('a pre-rendered scene is preferred over the grammar tier', () => {
  const e = engine(3);
  e.sceneSlots.reserve('channel:LOCAL', T + 10 * 60_000);
  e.sceneSlots.fulfil('channel:LOCAL', preScene(), T);

  // Force LOCAL to be the only channel that can open.
  const r = e.tick(
    input({
      context: {
        ...input().context,
        mutedChannels: new Set<ChannelId>(['STATION', 'CREW', 'DEEP', 'EMERGENCY', 'CARRIER', 'CONCOURSE']),
      },
    }),
  );
  assert.equal(r.transmission?.scene.tier, 'llm');
});

test('a pre-rendered scene still has to clear anti-repetition', () => {
  // It was written minutes ago against a world that has moved on. Skipping the
  // guard here was a real hole — the LLM tier is worth MORE than a template,
  // which makes letting it repeat itself worse, not better.
  const e = engine(3);
  const onlyLocal = {
    ...input().context,
    mutedChannels: new Set<ChannelId>(['STATION', 'CREW', 'DEEP', 'EMERGENCY', 'CARRIER', 'CONCOURSE']),
  };

  e.sceneSlots.reserve('channel:LOCAL', T + 10 * 60_000);
  e.sceneSlots.fulfil('channel:LOCAL', preScene(), T);
  const first = e.tick(input({ context: onlyLocal }));
  assert.equal(first.transmission?.scene.tier, 'llm');

  // The identical scene again: it must NOT go out a second time.
  e.sceneSlots.reserve('channel:LOCAL', T + 20 * 60_000);
  e.sceneSlots.fulfil('channel:LOCAL', preScene({ id: 'pre2' }), T + 10 * 60_000);
  const second = e.tick(input({ nowMs: T + 10 * 60_000, context: onlyLocal }));
  assert.notEqual(
    second.transmission?.scene.id,
    'pre2',
    'a duplicate pre-rendered scene was transmitted',
  );
});

test('payoffDue names only arcs whose next beat the act will accept', () => {
  const e = engine();
  const at = new Date(T).toISOString();
  e.cast.remember({
    name: 'Marla Brandt',
    persona: { id: 'p', voice: 'a', timbre: 1, profile: null, quirk: 'clipped' },
    homeSystem: 'Ratraii',
    channel: 'LOCAL',
    role: 'hauler',
    firstAt: at,
    lastAt: at,
    arcs: [
      {
        id: 'arc1',
        subjectKind: 'price',
        subjectKey: 'price:bertrandite@hurston ring',
        // Two complications: the thread must turn next.
        beats: [
          { at, func: 'establish', summary: 's' },
          { at, func: 'complicate', summary: 'c' },
          { at, func: 'complicate', summary: 'c' },
        ],
        state: 'open',
        lastSeenAt: at,
      },
    ],
  });

  // BUILDING accepts a reverse.
  const building = e.payoffDue('BUILDING');
  assert.equal(building.length, 1);
  assert.equal(building[0].arcId, 'arc1');
  assert.equal(building[0].channel, 'LOCAL');
  assert.equal(building[0].speaker, 'hauler');

  // QUIET does not — offering one there just buys a scene that gets rejected.
  assert.deepEqual(e.payoffDue('QUIET'), []);
  // And CRISIS accepts nothing at all.
  assert.deepEqual(e.payoffDue('CRISIS'), []);
});

test('payoffDue ignores arcs that are still building', () => {
  const e = engine();
  const at = new Date(T).toISOString();
  e.cast.remember({
    name: 'Otto Petrov',
    persona: { id: 'p', voice: 'a', timbre: 1, profile: null, quirk: 'clipped' },
    homeSystem: 'Ratraii',
    channel: 'LOCAL',
    role: 'hauler',
    firstAt: at,
    lastAt: at,
    arcs: [
      {
        id: 'fresh',
        subjectKind: 'price',
        subjectKey: 'k',
        beats: [], // wants 'establish' next, not a payoff
        state: 'open',
        lastSeenAt: at,
      },
    ],
  });
  assert.deepEqual(e.payoffDue('BUILDING'), []);
});

test('noteArcBeat advances the thread and can close it', () => {
  const e = engine();
  const at = new Date(T).toISOString();
  e.cast.remember({
    name: 'Marla Brandt',
    persona: { id: 'p', voice: 'a', timbre: 1, profile: null, quirk: 'clipped' },
    homeSystem: 'Ratraii',
    channel: 'LOCAL',
    role: 'hauler',
    firstAt: at,
    lastAt: at,
    arcs: [
      {
        id: 'arc1',
        subjectKind: 'price',
        subjectKey: 'k',
        beats: [{ at, func: 'establish', summary: 's' }],
        state: 'open',
        lastSeenAt: at,
      },
    ],
  });

  e.noteArcBeat('Ratraii', 'arc1', 'complicate', 'it got worse', at);
  assert.equal(e.cast.openArcs()[0].arc.beats.length, 2);

  e.noteArcBeat('Ratraii', 'arc1', 'reverse', 'it turned', at);
  assert.deepEqual(e.cast.openArcs(), [], 'a paid arc is no longer open');
});

test('noteArcBeat on an unknown arc is a no-op, not a throw', () => {
  const e = engine();
  assert.doesNotThrow(() => e.noteArcBeat('Ratraii', 'nope', 'reverse', 's', new Date(T).toISOString()));
});

// ---------------------------------------------------------------------------
// Repetition, measured the way a listener hears it
// ---------------------------------------------------------------------------

/**
 * A full hour of real 15-second heartbeats at the shipped density.
 *
 * The metric is DISTINCT TEMPLATES, not distinct strings. Two renderings of one
 * template differ by a ship name — two strings, two cache entries, and the same
 * line twice to anyone actually flying. Measuring text was how a channel that
 * scored 70% "unique" got reported as repetitive.
 */
function hourOfTraffic(seed: number, hours = 1): string[] {
  const e = engine(seed);
  const geo: Brief = {
    kind: 'geography',
    nouns: [{ value: 'Kepler Landing', source: { kind: 'geography', system: 'Ratraii' } }],
    figures: [],
    tokens: { station: 'Kepler Landing', system: 'Ratraii', callsign: 'K', origin: 'Colonia' },
    subjectKey: 'geo:kepler',
    summary: 'Kepler Landing',
  };
  const ids: string[] = [];
  for (let i = 0; i < 240 * hours; i++) {
    const r = e.tick(
      input({
        nowMs: T + i * 15_000,
        pressure: 0.1,
        density: 'busy',
        briefs: [geo],
        context: { ...input().context, resolvedPorts: 3, portSeparationLs: 900 },
      }),
    );
    if (r.transmission) ids.push(r.transmission.scene.templateId ?? 'llm');
  }
  return ids;
}

test('an hour of traffic is mostly distinct LINES, not just distinct strings', () => {
  for (const seed of [9, 31, 77]) {
    const ids = hourOfTraffic(seed);
    assert.ok(ids.length > 60, `only ${ids.length} transmissions in an hour`);
    const ratio = new Set(ids).size / ids.length;
    assert.ok(ratio > 0.8, `seed ${seed}: only ${Math.round(ratio * 100)}% distinct lines`);
  }
});

test('no line comes back inside ten minutes', () => {
  // Measured before the fix: the minimum gap was seven transmissions — exactly
  // the depth of the text ring, which was setting the repeat rate rather than
  // guarding against it. At ~40s a transmission, ten minutes is 15.
  for (const seed of [9, 31, 77]) {
    const ids = hourOfTraffic(seed);
    const last = new Map<string, number>();
    let minGap = Infinity;
    ids.forEach((id, i) => {
      const prev = last.get(id);
      if (prev !== undefined) minGap = Math.min(minGap, i - prev);
      last.set(id, i);
    });
    if (minGap !== Infinity) {
      assert.ok(minGap >= 15, `seed ${seed}: a line returned after only ${minGap} transmissions`);
    }
  }
});

test('no single line dominates an hour', () => {
  for (const seed of [9, 31, 77]) {
    const counts = new Map<string, number>();
    for (const id of hourOfTraffic(seed)) counts.set(id, (counts.get(id) ?? 0) + 1);
    const worst = Math.max(...counts.values());
    assert.ok(worst <= 3, `seed ${seed}: one line played ${worst} times in an hour`);
  }
});

test('a long session cycles the catalogue rather than favouring a few lines', () => {
  // Three hours. With a finite grammar some repetition is arithmetic — the
  // point is that it spreads across everything available instead of hammering
  // a handful, which is what random-pick-and-reject used to do.
  const ids = hourOfTraffic(9, 3);
  const distinct = new Set(ids).size;
  assert.ok(distinct > 90, `only ${distinct} distinct lines across three hours`);
});

test('the least-recently-used ordering survives a restart', () => {
  // Otherwise every session opens with the same handful of lines.
  const a = engine(9);
  runTicks(a, 20);
  const saved = JSON.parse(JSON.stringify(a.toJSON()));
  const b = engine(9);
  b.load(saved);
  const seen = [...new Set(runTicks(a, 10, {}, after(20)).flatMap((r) => r.transmission?.scene.templateId ?? []))];
  for (const id of seen) {
    assert.ok(b.guard.templateAge(id) >= 0, 'template ages must load');
  }
  assert.ok(b.guard.useCounter > 0, 'the use counter must survive a restart');
});

// ---------------------------------------------------------------------------
// Source policy
// ---------------------------------------------------------------------------

test('llm-only stays silent rather than falling back to a template', () => {
  // The whole point of the default: a finite catalogue is recognisable however
  // well it is shuffled, so silence is preferred to a line you have heard.
  const e = engine(5, 'llm');
  const spoke = runTicks(e, 20).filter((r) => r.transmission);
  assert.equal(spoke.length, 0, 'llm-only must not reach for the grammar tier');
});

test('llm-only transmits whatever was written ahead', () => {
  const e = engine(5, 'llm');
  e.sceneSlots.reserve('channel:CREW', T + 60 * 60_000);
  e.sceneSlots.fulfil(
    'channel:CREW',
    {
      id: 'w',
      channel: 'CREW',
      func: 'texture',
      turns: [
        { speakerRef: 'crew:ops', text: 'Written by the model, not a template.' },
        { speakerRef: 'crew:engineering', text: 'Quite so.' },
      ],
      brief: textureBrief('w'),
      ttlMs: 90_000,
      tier: 'llm',
    },
    T,
  );
  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission?.scene.tier, 'llm');
});

test('hybrid falls back to templates rather than going quiet', () => {
  const e = engine(5, 'hybrid');
  assert.ok(runTicks(e, 20).some((r) => r.transmission), 'hybrid must fill the air');
});

test('the source policy can be switched at runtime', () => {
  const e = engine(5, 'llm');
  assert.equal(runTicks(e, 10).filter((r) => r.transmission).length, 0);
  e.setSource('grammar');
  assert.ok(runTicks(e, 10, {}, after(10)).some((r) => r.transmission));
});

// ---------------------------------------------------------------------------
// The buffer
// ---------------------------------------------------------------------------

test('a channel buffers several written-ahead scenes', () => {
  // One slot per channel could never keep ahead of the cadence: a transmission
  // leaves every ~40s and a generation takes seconds, so the buffer has to
  // hold a queue rather than a single item.
  const e = engine(1, 'llm');
  const key = 'channel:LOCAL';
  assert.equal(e.sceneSlots.full(key), false);
  for (let i = 0; i < 5; i++) e.sceneSlots.reserve(key, T + 60_000);
  assert.ok(e.sceneSlots.count(key) >= 2, 'must hold more than one');
  assert.equal(e.sceneSlots.full(key), true, 'and must stop asking once full');
});

test('buffered scenes come out in the order they were asked for', () => {
  const e = engine(1, 'llm');
  const key = 'channel:LOCAL';
  const mk = (id: string): Scene => ({
    id,
    channel: 'LOCAL',
    func: 'texture',
    turns: [{ speakerRef: 'hauler', text: `Line ${id}.` }],
    brief: textureBrief(id),
    ttlMs: 90_000,
    tier: 'llm',
  });
  e.sceneSlots.reserve(key, T + 60_000);
  e.sceneSlots.reserve(key, T + 60_000);
  e.sceneSlots.fulfil(key, mk('first'), T);
  e.sceneSlots.fulfil(key, mk('second'), T);
  assert.equal(e.sceneSlots.take(key, T + 1)?.id, 'first');
  assert.equal(e.sceneSlots.take(key, T + 2)?.id, 'second');
  assert.equal(e.sceneSlots.take(key, T + 3), null);
});

// ---------------------------------------------------------------------------
// Written scenes must actually reach the air
// ---------------------------------------------------------------------------

/**
 * A written scene. The turns are deliberately UNLIKE each other across ids —
 * three scenes that all end "Acknowledged." are genuine near-duplicates and
 * the repetition guard is right to reject them.
 */
const WRITTEN_LINES: Record<string, [string, string]> = {
  a: ['Smells like stale coolant down here.', 'Just the usual dampness, nothing more.'],
  b: ['This run barely covers the jump fees.', 'It pays enough, I suppose.'],
  c: ['Reduce approach speed, hold your vector.', 'Slowing now, understood.'],
};

const written = (channel: ChannelId, id: string): Scene => ({
  id,
  channel,
  func: 'texture',
  turns: (WRITTEN_LINES[id] ?? [`Written line ${id}.`, 'Fine.']).map((text, i) => ({
    speakerRef: i ? 'b' : 'a',
    text,
  })),
  brief: textureBrief(`w:${id}`),
  ttlMs: 150_000,
  tier: 'llm',
});

test('a written scene is transmitted even when the lottery favours another channel', () => {
  // The old order picked a channel at random and THEN asked whether anything
  // had been written for it. With several channels open that coincided about a
  // third of the time, and the rest of the model's work expired unheard — the
  // panel reporting "6 written" while the air stayed silent.
  const e = engine(1, 'llm');
  e.sceneSlots.reserve('channel:CREW', T + 60 * 60_000);
  e.sceneSlots.fulfil('channel:CREW', written('CREW', 'only-one'), T);

  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission?.scene.id, 'only-one');
  assert.equal(r.transmission?.channel, 'CREW');
});

test('written scenes go out ahead of anything the grammar tier could offer', () => {
  const e = engine(1, 'hybrid');
  e.sceneSlots.reserve('channel:LOCAL', T + 60 * 60_000);
  e.sceneSlots.fulfil('channel:LOCAL', written('LOCAL', 'model'), T);
  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission?.scene.tier, 'llm', 'paid-for writing comes first');
});

test('llm-only skips a repetitive written scene and can still transmit the next one', () => {
  const e = engine(1, 'llm');
  const first = written('CREW', 'a');
  const second = written('CREW', 'b');

  // The first queued scene would be rejected by the repetition guard.
  e.guard.remember(first);

  e.sceneSlots.reserve('channel:CREW', T + 60 * 60_000);
  e.sceneSlots.reserve('channel:CREW', T + 60 * 60_000);
  e.sceneSlots.fulfil('channel:CREW', first, T);
  e.sceneSlots.fulfil('channel:CREW', second, T);

  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission?.scene.id, 'b');
  assert.equal(r.transmission?.channel, 'CREW');
});

test('the whole buffer drains rather than one scene per channel forever', () => {
  const e = engine(1, 'llm');
  for (const [ch, id] of [
    ['CREW', 'a'],
    ['LOCAL', 'b'],
    ['STATION', 'c'],
  ] as Array<[ChannelId, string]>) {
    e.sceneSlots.reserve(`channel:${ch}`, T + 60 * 60_000);
    e.sceneSlots.fulfil(`channel:${ch}`, written(ch, id), T);
  }
  assert.equal(e.readyCount(), 3);

  const spoken = runTicks(e, 6, { density: 'busy' })
    .filter((r) => r.transmission)
    .map((r) => r.transmission!.scene.id);
  assert.deepEqual(spoken.sort(), ['a', 'b', 'c'], 'every written scene should be heard');
  assert.equal(e.readyCount(), 0);
});

test('"nothing written" is reported differently from "nothing to say"', () => {
  // They are different problems — the writer has not caught up, versus there
  // was nothing worth writing about — and conflating them sent an entire round
  // of debugging in the wrong direction.
  const e = engine(1, 'llm');
  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission, null);
  assert.equal(r.quietBecause, 'nothing-written');
});

test('llm-only reports repetition when ready scenes are rejected by the guard', () => {
  const e = engine(1, 'llm');
  const s = written('CREW', 'a');
  e.guard.remember(s);
  e.sceneSlots.reserve('channel:CREW', T + 60 * 60_000);
  e.sceneSlots.fulfil('channel:CREW', s, T);

  const r = e.tick(input({ density: 'busy' }));
  assert.equal(r.transmission, null);
  assert.equal(r.quietBecause, 'repetition');
});

test('readyCount counts only scenes that are actually finished', () => {
  const e = engine(1, 'llm');
  e.sceneSlots.reserve('channel:LOCAL', T + 60 * 60_000);
  assert.equal(e.readyCount(), 0, 'a reservation in flight is not ready');
  e.sceneSlots.fulfil('channel:LOCAL', written('LOCAL', 'x'), T);
  assert.equal(e.readyCount(), 1);
});
