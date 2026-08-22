/**
 * The grounding contract.
 *
 * These are the assertions that decide whether ambient chatter is worth
 * listening to or is decoration. A scene that states a price the app never
 * observed teaches the commander — correctly, and permanently — that nothing
 * on the channel can be trusted, at which point the whole feature is worth
 * less than silence.
 *
 * So the bias is explicit and tested in both directions: an invented SPEAKER
 * is fine, an invented FACT is fatal.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRESH_MAX_MS,
  STALE_MAX_MS,
  figuresIn,
  freshnessOf,
  isFactual,
  mergeBriefs,
  normaliseFigure,
  properNouns,
  textureBrief,
  verifyAgainstBrief,
  type Brief,
} from '../src/engine/chatter/brief.ts';
import {
  MIN_MOVE_PCT,
  PriceWatch,
  constructionBrief,
  eventBrief,
  factionBrief,
  framingFor,
  geographyBrief,
  hedgeToken,
  marketMoveBrief,
  marketPriceBrief,
  factionPolitics,
  systemBrief,
} from '../src/engine/chatter/briefs.ts';
import type { MarketRecord } from '../src/engine/trade.ts';
import type { DepotState } from '../src/engine/architect.ts';
import type { OrrerySystem, OrreryPort } from '../src/engine/orrery.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const NOW = Date.parse('2026-08-22T12:00:00Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const pick0 = (): number => 0;

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

test('proper nouns are found mid-sentence', () => {
  const found = properNouns('They have knocked another 380 off Bertrandite at Hurston Ring.');
  assert.ok(found.includes('Bertrandite'));
  assert.ok(found.includes('Hurston Ring'));
  assert.ok(found.includes('Hurston'));
});

test('a sentence-initial ordinary word is not mistaken for a name', () => {
  assert.deepEqual(properNouns('Prices are down again. Nobody is happy.'), []);
});

test('a name at the start of a sentence is still caught when it runs on', () => {
  assert.ok(properNouns('Hurston Ring control, hold at the marker.').includes('Hurston Ring'));
});

test('radio procedure words are not treated as claims', () => {
  assert.deepEqual(properNouns('Copy. Roger. Standby. Acknowledged.'), []);
  assert.deepEqual(properNouns('I am holding, Commander.'), []);
});

test('figures are found and normalised', () => {
  assert.deepEqual(figuresIn('They took 1,240 off it.').sort(), ['1240']);
  assert.equal(normaliseFigure('1,240'), '1240');
  assert.equal(normaliseFigure('380.0'), '380');
});

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

const brief = (over: Partial<Brief> = {}): Brief => ({
  kind: 'market',
  nouns: [
    { value: 'Bertrandite', source: { kind: 'market', station: 'Hurston Ring', observedAt: iso(NOW) } },
    { value: 'Hurston Ring', source: { kind: 'market', station: 'Hurston Ring', observedAt: iso(NOW) } },
  ],
  figures: [
    { value: '380', source: { kind: 'market', station: 'Hurston Ring', observedAt: iso(NOW) } },
  ],
  tokens: {},
  subjectKey: 'price:bertrandite@hurston ring',
  summary: 'test',
  ...over,
});

test('a scene using only briefed facts passes', () => {
  const r = verifyAgainstBrief(
    'They have taken another 380 off Bertrandite at Hurston Ring. Third time this month.',
    brief(),
  );
  assert.equal(r.ok, true, `unexpectedly rejected: ${r.offending}`);
});

test('an unbriefed faction name drops the whole scene', () => {
  const r = verifyAgainstBrief(
    'Bertrandite is down 380 at Hurston Ring, and the Sirius Corporation is behind it.',
    brief(),
  );
  assert.equal(r.ok, false);
  assert.ok(r.offending.some((o) => o.includes('Sirius')));
});

test('an unbriefed figure drops the whole scene', () => {
  const r = verifyAgainstBrief('They have taken 999 off Bertrandite at Hurston Ring.', brief());
  assert.equal(r.ok, false);
  assert.ok(r.offending.includes('999'));
});

test('a briefed figure written with separators still passes', () => {
  const b = brief({
    figures: [{ value: '1240', source: { kind: 'market', station: 'X', observedAt: iso(NOW) } }],
  });
  assert.equal(verifyAgainstBrief('Down 1,240 at Hurston Ring.', b).ok, true);
});

test('licensing a phrase licenses its parts', () => {
  // A brief that allows "Hurston Ring" allows a line that says "Hurston".
  assert.equal(verifyAgainstBrief('Hurston is quiet tonight.', brief()).ok, true);
});

test('an invented SPEAKER with a true fact is permitted', () => {
  // The haulier does not exist. The price does. That is the whole design.
  const b = brief({
    nouns: [
      ...brief().nouns,
      { value: 'Marla Brandt', source: { kind: 'cast' } },
    ],
  });
  const r = verifyAgainstBrief(
    'Marla Brandt here. They have taken 380 off Bertrandite at Hurston Ring.',
    b,
  );
  assert.equal(r.ok, true, `rejected: ${r.offending}`);
});

test('a REAL speaker with an invented fact is rejected', () => {
  const b = brief({
    nouns: [...brief().nouns, { value: 'Iron Marlin', source: { kind: 'cast' } }],
  });
  const r = verifyAgainstBrief('Iron Marlin here. Bertrandite is down 4200 at Hurston Ring.', b);
  assert.equal(r.ok, false);
  assert.ok(r.offending.includes('4200'));
});

test('a texture brief permits no facts at all', () => {
  const t = textureBrief('t');
  assert.equal(isFactual(t), false);
  assert.equal(verifyAgainstBrief('Somebody has moved the loading schedule again.', t).ok, true);
  assert.equal(verifyAgainstBrief('Bertrandite is down 380.', t).ok, false);
});

test('merging briefs unions what may be said', () => {
  const merged = mergeBriefs(brief(), {
    ...textureBrief('other'),
    nouns: [{ value: 'Ratraii', source: { kind: 'geography', system: 'Ratraii' } }],
  });
  assert.equal(verifyAgainstBrief('Ratraii is quiet. Bertrandite down 380.', merged).ok, true);
});

// ---------------------------------------------------------------------------
// Freshness
// ---------------------------------------------------------------------------

test('freshness tiers follow the thresholds', () => {
  assert.equal(freshnessOf(undefined), 'fresh', 'timeless facts are always fresh');
  assert.equal(freshnessOf(0), 'fresh');
  assert.equal(freshnessOf(FRESH_MAX_MS), 'fresh');
  assert.equal(freshnessOf(FRESH_MAX_MS + 1), 'stale');
  assert.equal(freshnessOf(STALE_MAX_MS), 'stale');
  assert.equal(freshnessOf(STALE_MAX_MS + 1), 'expired');
});

test('a fresh figure may be stated plainly', () => {
  const b = brief({ ageMs: 1000 });
  assert.equal(framingFor(b), 'current');
  assert.equal(hedgeToken(b), '');
});

test('a stale figure is framed as hearsay', () => {
  const b = brief({ ageMs: FRESH_MAX_MS + 3 * 86_400_000 });
  assert.equal(framingFor(b), 'hearsay');
  assert.match(hedgeToken(b), /last I looked/);
  assert.match(hedgeToken(b), /days back/);
});

// ---------------------------------------------------------------------------
// Price watch
// ---------------------------------------------------------------------------

const market = (over: Partial<MarketRecord> = {}): MarketRecord => ({
  marketId: 1,
  station: 'Hurston Ring',
  system: 'Ratraii',
  at: iso(NOW),
  items: [{ name: 'Bertrandite', buy: 0, sell: 1000, stock: 0, demand: 500 }],
  ...over,
});

test('the first observation of a price reports no movement', () => {
  const w = new PriceWatch();
  assert.deepEqual(w.observe(market()), []);
});

test('a significant movement is reported with both endpoints', () => {
  const w = new PriceWatch();
  w.observe(market());
  const moves = w.observe(
    market({
      at: iso(NOW + 3_600_000),
      items: [{ name: 'Bertrandite', buy: 0, sell: 620, stock: 0, demand: 500 }],
    }),
  );
  assert.equal(moves.length, 1);
  assert.equal(moves[0].price, 620);
  assert.equal(moves[0].was, 1000);
  assert.equal(moves[0].commodity, 'Bertrandite');
});

test('noise below the threshold is not news', () => {
  const w = new PriceWatch();
  w.observe(market());
  const tiny = Math.round(1000 * (1 + (MIN_MOVE_PCT - 1) / 100));
  const moves = w.observe(
    market({
      at: iso(NOW + 3_600_000),
      items: [{ name: 'Bertrandite', buy: 0, sell: tiny, stock: 0, demand: 500 }],
    }),
  );
  assert.deepEqual(moves, []);
});

test('re-observing the same snapshot is not a movement', () => {
  const w = new PriceWatch();
  w.observe(market());
  assert.deepEqual(w.observe(market()), []);
});

test('the price watch survives a save and load', () => {
  const a = new PriceWatch();
  a.observe(market());
  const b = new PriceWatch();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  const moves = b.observe(
    market({
      at: iso(NOW + 3_600_000),
      items: [{ name: 'Bertrandite', buy: 0, sell: 500, stock: 0, demand: 500 }],
    }),
  );
  assert.equal(moves.length, 1, 'history must survive a restart');
});

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

test('a market move brief licenses exactly what it states', () => {
  const b = marketMoveBrief(
    {
      commodity: 'Bertrandite',
      station: 'Hurston Ring',
      system: 'Ratraii',
      price: 620,
      was: 1000,
      sinceIso: iso(NOW - 3_600_000),
      atIso: iso(NOW),
      side: 'sell',
    },
    NOW,
  );
  assert.ok(b);
  assert.equal(b.tokens.price, '380', 'the delta is how a person says it');
  assert.equal(b.tokens.direction, 'down');
  assert.equal(verifyAgainstBrief('They took 380 off Bertrandite at Hurston Ring.', b).ok, true);
  assert.equal(verifyAgainstBrief('They took 500 off Bertrandite.', b).ok, false);
});

test('an expired market observation builds nothing at all', () => {
  const b = marketMoveBrief(
    {
      commodity: 'Bertrandite',
      station: 'Hurston Ring',
      system: 'Ratraii',
      price: 620,
      was: 1000,
      sinceIso: iso(NOW - STALE_MAX_MS * 2),
      atIso: iso(NOW - STALE_MAX_MS - 86_400_000),
      side: 'sell',
    },
    NOW,
  );
  assert.equal(b, null, 'too old to be worth saying at all');
});

test('a market price brief matches the record exactly', () => {
  const b = marketPriceBrief(market(), 'Bertrandite', NOW);
  assert.ok(b);
  assert.equal(b.tokens.price, '1000');
  assert.equal(verifyAgainstBrief('Bertrandite is 1000 at Hurston Ring.', b).ok, true);
});

test('a market price brief for an absent commodity is null', () => {
  assert.equal(marketPriceBrief(market(), 'Painite', NOW), null);
});

const intel = (over: Partial<SystemIntel> = {}): SystemIntel => ({
  signals: [],
  factions: [
    { name: 'Explorer on Tour', influence: 0.427, state: 'Expansion' },
    { name: 'HIP 71462 Council', influence: 0.306 },
  ],
  ...over,
});

test('a faction brief names only journal-reported factions', () => {
  const b = factionBrief(intel(), 'Ratraii', pick0);
  assert.ok(b);
  assert.equal(b.tokens.faction, 'Explorer on Tour', 'a faction in an active state is preferred');
  assert.equal(b.tokens.influence, '42.7');
  assert.equal(verifyAgainstBrief('Explorer on Tour is at 42.7 percent.', b).ok, true);
  assert.equal(verifyAgainstBrief('The Sirius Corporation is at 42.7 percent.', b).ok, false);
});

test('no faction board means no faction is ever named', () => {
  assert.equal(factionBrief(undefined, 'Ratraii', pick0), null);
  assert.equal(factionBrief(intel({ factions: [] }), 'Ratraii', pick0), null);
});

const depot = (over: Partial<DepotState> = {}): DepotState => ({
  marketId: 9,
  station: 'Kepler Landing',
  system: 'Ratraii',
  progress: 0.31,
  complete: false,
  failed: false,
  at: iso(NOW),
  resources: [
    { key: 'steel', name: 'Steel', required: 2542, provided: 1000, remaining: 1542, payment: 0 },
    { key: 'titanium', name: 'Titanium', required: 1525, provided: 1525, remaining: 0, payment: 0 },
  ],
  ...over,
});

test('a construction brief reports the biggest shortfall', () => {
  const b = constructionBrief(depot());
  assert.ok(b);
  assert.equal(b.tokens.commodity, 'Steel');
  assert.equal(b.tokens.qty, '1542');
  assert.equal(verifyAgainstBrief('Kepler Landing still wants 1542 of Steel.', b).ok, true);
});

test('a finished or failed build reports nothing', () => {
  assert.equal(constructionBrief(depot({ complete: true })), null);
  assert.equal(constructionBrief(depot({ failed: true })), null);
  assert.equal(
    constructionBrief(depot({ resources: [{ key: 'a', name: 'A', required: 1, provided: 1, remaining: 0, payment: 0 }] })),
    null,
  );
  assert.equal(constructionBrief(null), null);
});

const port = (over: Partial<OrreryPort> = {}): OrreryPort => ({
  id: 1,
  name: 'Kepler Landing',
  type: 'Coriolis',
  distanceLs: 812.4,
  ...over,
});

const orrery = (ports: OrreryPort[]): OrrerySystem => ({
  address: '1',
  name: 'Ratraii',
  bodies: new Map(),
  ports: new Map(ports.map((p) => [p.id, p])),
  lastScanMs: NOW,
});

test('a geography brief names only ports the orrery resolved', () => {
  const b = geographyBrief(orrery([port()]), 'Ratraii', 'Colonia', pick0);
  assert.ok(b);
  assert.equal(b.tokens.station, 'Kepler Landing');
  assert.equal(b.tokens.origin, 'Colonia', 'the real previous system, not a random one');
  assert.equal(b.tokens.distanceLs, '812');
  assert.equal(
    verifyAgainstBrief('Kepler Landing, inbound from Colonia, 812 out.', b).ok,
    true,
  );
});

test('a system with no resolved ports yields no geography scene', () => {
  assert.equal(geographyBrief(orrery([]), 'Ratraii', 'Colonia', pick0), null);
  assert.equal(geographyBrief(null, 'Ratraii', 'Colonia', pick0), null);
});

test('a geography brief without an origin does not invent one', () => {
  const b = geographyBrief(orrery([port()]), 'Ratraii', null, pick0);
  assert.ok(b);
  assert.equal(b.tokens.origin, undefined);
  assert.equal(verifyAgainstBrief('Inbound from Sol.', b).ok, false);
});

test('an event brief licenses what the caller actually said', () => {
  const b = eventBrief(
    {
      summary: 'The fight is over: 3 ships of Brian’s Thugs destroyed',
      atIso: iso(NOW),
      nouns: ['Brian’s Thugs'],
      figures: [3],
      subjectKey: 'combat:1',
    },
    NOW,
  );
  assert.ok(b);
  assert.equal(verifyAgainstBrief('Three down. 3 of Brian’s Thugs, they say.', b).ok, true);
  // Digits are always policed.
  assert.equal(verifyAgainstBrief('9 of them, apparently.', b).ok, false);
});

test('an ancient event builds no brief', () => {
  assert.equal(
    eventBrief({ summary: 'x', atIso: iso(NOW - STALE_MAX_MS - 1), subjectKey: 'k' }, NOW),
    null,
  );
});

test('every builder produces a subject key for arcs and repetition gating', () => {
  const briefs = [
    marketPriceBrief(market(), 'Bertrandite', NOW),
    factionBrief(intel(), 'Ratraii', pick0),
    constructionBrief(depot()),
    geographyBrief(orrery([port()]), 'Ratraii', null, pick0),
    eventBrief({ summary: 'x', atIso: iso(NOW), subjectKey: 'ev:1' }, NOW),
  ];
  for (const b of briefs) {
    assert.ok(b, 'builder returned null unexpectedly');
    assert.ok(b.subjectKey.length > 0);
    assert.ok(b.summary.length > 0);
  }
});

// ---------------------------------------------------------------------------
// Spelled-out numbers (a deliberate, bounded compromise)
// ---------------------------------------------------------------------------

test('a spelled-out unbriefed quantity is caught from twenty upward', () => {
  // The floor sits at twenty plus the multipliers. A live run dropped
  // "Two signatures just popped up" — a good line asserting nothing checkable
  // — because "two" resolved to a figure nobody had licensed. What actually
  // needs policing is a fabricated price or tonnage, and those are digits or
  // built from hundred/thousand.
  const b = brief({ figures: [{ value: '3', source: { kind: 'event', at: iso(NOW) } }] });
  assert.equal(verifyAgainstBrief('Fifty of them, apparently.', b).ok, false);
  assert.equal(verifyAgainstBrief('Nine hundred off the price.', b).ok, false);
  // Small counts in casual speech are not claims worth defending against.
  assert.equal(verifyAgainstBrief('Two signatures just popped up.', b).ok, true);
  assert.equal(verifyAgainstBrief('Give me three minutes.', b).ok, true);
});

test('digits and words for the same briefed figure both pass', () => {
  const b = brief({ figures: [{ value: '50', source: { kind: 'event', at: iso(NOW) } }] });
  assert.equal(verifyAgainstBrief('Fifty pads.', b).ok, true);
  assert.equal(verifyAgainstBrief('50 pads.', b).ok, true);
});

test('small counts are deliberately NOT treated as figures', () => {
  // "one of the crew", "two signatures", "give me three minutes" — ordinary
  // speech that asserts nothing checkable. The hole is bounded and known:
  // anything from twenty up, and anything in digits, is still policed.
  const t = textureBrief('t');
  assert.equal(verifyAgainstBrief('One of the crew is still on ship time.', t).ok, true);
  assert.equal(verifyAgainstBrief('Two signatures just popped up.', t).ok, true);
  assert.equal(verifyAgainstBrief('Fifty tons of it.', t).ok, false);
});

test('a sentence boundary breaks a capitalised run', () => {
  // "…at Hurston Ring. Third time this month." must not read as one name.
  const found = properNouns('They took 380 off it at Hurston Ring. Third time this month.');
  assert.ok(found.includes('Hurston Ring'));
  assert.ok(!found.some((n) => n.includes('Third')), `leaked across the boundary: ${found}`);
});

// ---------------------------------------------------------------------------
// The rich system brief — why one system should not sound like the next
// ---------------------------------------------------------------------------

const sysIntel = (over: Partial<SystemIntel> = {}): SystemIntel => ({
  signals: [
    { name: 'Resource Extraction Site [Hazardous]', type: 'ResourceExtraction', isStation: false },
    { name: 'Nav Beacon', type: 'NavBeacon', isStation: false },
  ],
  economy: 'Extraction',
  government: 'Anarchy',
  security: 'Low Security',
  allegiance: 'Independent',
  population: 480_000,
  controllingFaction: 'HIP 71462 Council',
  factions: [
    { name: 'HIP 71462 Council', influence: 0.427, state: 'Expansion' },
    { name: 'Explorer on Tour', influence: 0.306 },
  ],
  ...over,
});

test('the system brief carries what people here actually DO', () => {
  const b = systemBrief('Ratraii', sysIntel(), orrery([port()]), 'Colonia');
  assert.ok(b);
  // Signals are the most system-specific thing the journal gives us, and were
  // being discarded entirely — which is why every system sounded the same.
  assert.match(b.summary, /Resource Extraction Site \[Hazardous\]/);
  assert.match(b.summary, /Nav Beacon/);
  assert.match(b.summary, /Extraction/);
  assert.match(b.summary, /Anarchy/);
  assert.match(b.summary, /Low Security/);
});

test('everything the brief mentions is also licensed to be said', () => {
  // A fact in the summary the model may not name is a trap: it reads it,
  // uses it, and the verifier drops the scene.
  const b = systemBrief('Ratraii', sysIntel(), orrery([port()]), 'Colonia');
  assert.ok(b);
  for (const name of [
    'Resource Extraction Site [Hazardous]',
    'Nav Beacon',
    'Extraction',
    'Anarchy',
    'Low Security',
    'HIP 71462 Council',
    'Explorer on Tour',
    'Kepler Landing',
    'Colonia',
    'Ratraii',
  ]) {
    assert.equal(
      verifyAgainstBrief(`Something about ${name}.`, b).ok,
      true,
      `${name} appears in the brief but is not licensed`,
    );
  }
});

test('two different systems produce genuinely different briefs', () => {
  const mining = systemBrief('Ratraii', sysIntel(), orrery([port()]), null);
  const hiTech = systemBrief(
    'Sol',
    sysIntel({
      economy: 'High Tech',
      government: 'Democracy',
      security: 'High Security',
      signals: [{ name: 'Nav Beacon', type: 'NavBeacon', isStation: false }],
      factions: [{ name: 'Sol Workers', influence: 0.6, state: 'Boom' }],
      controllingFaction: 'Sol Workers',
    }),
    orrery([port({ name: 'Abraham Lincoln' })]),
    null,
  );
  assert.ok(mining && hiTech);
  assert.notEqual(mining.summary, hiTech.summary);
  assert.match(hiTech.summary, /High Tech/);
  assert.ok(!/Hazardous/.test(hiTech.summary), 'a quiet system must not inherit hazards');
});

test('an unknown system yields no brief rather than an empty one', () => {
  assert.equal(systemBrief('', sysIntel(), null, null), null);
  assert.equal(systemBrief('unknown', sysIntel(), null, null), null);
  // Nothing but a name teaches the model nothing.
  assert.equal(systemBrief('Nowhere', undefined, null, null), null);
});

test('station signals are not listed as things people do', () => {
  const b = systemBrief(
    'Ratraii',
    sysIntel({ signals: [{ name: 'Kepler Landing', isStation: true }] }),
    orrery([port()]),
    null,
  );
  // isStation entries are ports, already covered by the port list.
  if (b) assert.ok(!/Signal sources detected/.test(b.summary));
});

test('being docked is stated, because it changes who would be talking', () => {
  const b = systemBrief('Ratraii', sysIntel(), orrery([port()]), null, {
    docked: true,
    stationName: 'Kepler Landing',
  });
  assert.ok(b);
  assert.match(b.summary, /docked at Kepler Landing/);
});

test('a name containing digits licenses those digits', () => {
  // Elite is full of these: "HIP 71462 Council", "LHS 3447", "Col 285 Sector".
  // Without this the figure check rejected a number that was part of a
  // faction the brief had explicitly allowed.
  const b = brief({
    nouns: [{ value: 'HIP 71462 Council', source: { kind: 'faction', system: 'Ratraii' } }],
    figures: [],
  });
  assert.equal(verifyAgainstBrief('HIP 71462 Council is expanding.', b).ok, true);
  // An unrelated number is still rejected.
  assert.equal(verifyAgainstBrief('HIP 71462 Council holds 88 percent.', b).ok, false);
});

test('bracketed signal names survive the round trip', () => {
  const b = brief({
    nouns: [
      {
        value: 'Resource Extraction Site [Hazardous]',
        source: { kind: 'geography', system: 'Ratraii' },
      },
    ],
    figures: [],
  });
  assert.equal(
    verifyAgainstBrief('Somebody is working the Resource Extraction Site [Hazardous].', b).ok,
    true,
  );
  // A small spelled-out count is allowed through; a large one is not.
  assert.equal(
    verifyAgainstBrief('Two rigs on the Resource Extraction Site [Hazardous].', b).ok,
    true,
  );
  assert.equal(
    verifyAgainstBrief('Fifty rigs on the Resource Extraction Site [Hazardous].', b).ok,
    false,
  );
});

// ---------------------------------------------------------------------------
// Faction politics — the agenda, not the percentages
// ---------------------------------------------------------------------------

const board = (over: Partial<SystemIntel> = {}): SystemIntel => ({
  signals: [],
  factions: [
    {
      name: 'Explorer on Tour',
      influence: 0.446,
      state: 'Expansion',
      allegiance: 'Independent',
      government: 'Democracy',
      happiness: 'Happy',
    },
    {
      name: 'HIP 71462 Council',
      influence: 0.302,
      allegiance: 'Empire',
      government: 'Corporate',
      happiness: 'Discontented',
    },
  ],
  ...over,
});

test('a BGS state becomes something a person would actually say', () => {
  // "Expansion" is a word on a panel. What a haulier notices is the hiring.
  const lines = factionPolitics(board()).join(' ');
  assert.match(lines, /hiring haulers/);
  assert.ok(!/Expansion is a state/.test(lines));
});

test('the margin changes the story, not just the number', () => {
  const knife = factionPolitics(
    board({
      factions: [
        { name: 'A', influence: 0.44 },
        { name: 'B', influence: 0.43 },
      ],
    }),
  ).join(' ');
  const walkover = factionPolitics(
    board({
      factions: [
        { name: 'A', influence: 0.7 },
        { name: 'B', influence: 0.1 },
      ],
    }),
  ).join(' ');
  assert.match(knife, /could turn/);
  assert.match(walkover, /not seriously contesting/);
});

test('two superpowers in one system is stated as the wider thing it is', () => {
  assert.match(factionPolitics(board()).join(' '), /different powers/);
  // ...and a system where everyone is independent is not dressed up as one.
  const calm = factionPolitics(
    board({
      factions: [
        { name: 'A', influence: 0.6, allegiance: 'Independent' },
        { name: 'B', influence: 0.3, allegiance: 'Independent' },
      ],
    }),
  ).join(' ');
  assert.ok(!/different powers/.test(calm));
});

test('independent factions are not "aligned to the Independent"', () => {
  const lines = factionPolitics(
    board({ factions: [{ name: 'A', influence: 0.6, allegiance: 'Independent' }] }),
  ).join(' ');
  assert.match(lines, /independent/);
  assert.ok(!/aligned to the Independent/.test(lines));
});

test('what is coming and what has just passed are different things', () => {
  const lines = factionPolitics(
    board({
      factions: [
        { name: 'A', influence: 0.6, pending: ['War'] },
        { name: 'B', influence: 0.3, recovering: ['Lockdown'] },
      ],
    }),
  ).join(' ');
  assert.match(lines, /has War coming/);
  assert.match(lines, /still coming out of Lockdown/);
});

test('unhappy populations are worth mentioning; happy ones are not news', () => {
  const lines = factionPolitics(board()).join(' ');
  assert.match(lines, /discontented/i);
});

test('a system with no faction board yields nothing rather than filler', () => {
  assert.deepEqual(factionPolitics(undefined), []);
  assert.deepEqual(factionPolitics({ signals: [], factions: [] }), []);
});

test('every faction detail the politics mention is licensed by the brief', () => {
  const b = systemBrief('Ratraii', board(), orrery([port()]), null);
  assert.ok(b);
  for (const name of ['Explorer on Tour', 'HIP 71462 Council', 'Empire', 'Democracy', 'Corporate']) {
    assert.equal(
      verifyAgainstBrief(`Something about ${name}.`, b).ok,
      true,
      `${name} is in the politics but not licensed`,
    );
  }
});
