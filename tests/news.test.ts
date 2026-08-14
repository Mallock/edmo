/**
 * Local system news — grounded in the journal, or not printed.
 *
 * The brief below is the real HIP 71120 board from 2026-08-12: four factions,
 * "Explorer on Tour" controlling on 42.7% and expanding, 99.3M people, Low
 * Security, High Tech, plus the construction sites the commander is supplying.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptNews,
  allowedNames,
  buildNewsBrief,
  buildNewsChat,
  desksFor,
  looksLikeGamePlace,
  marketPulse,
  trimCast,
  findInvention,
  findInventions,
  isTitleCase,
  newsDue,
  newsMaxTokens,
  newsIntervalLabel,
  parseNewsItems,
} from '../src/engine/news.ts';
import type { SystemIntel } from '../src/engine/types.ts';
import type { MarketRecord } from '../src/engine/trade.ts';

const INTEL: SystemIntel = {
  population: 99_298_561,
  economy: 'High Tech',
  government: 'Democracy',
  security: 'Low Security',
  allegiance: 'Independent',
  controllingFaction: 'Explorer on Tour',
  factions: [
    { name: 'Explorer on Tour', influence: 0.427, state: 'Expansion', allegiance: 'Independent' },
    { name: 'HIP 71462 Council', influence: 0.306, allegiance: 'Independent' },
    { name: 'The Dark Wheel', influence: 0.165, allegiance: 'Independent' },
    { name: 'GR Virginis Dominion', influence: 0.101, allegiance: 'Independent' },
  ],
  signals: [
    { name: 'Anders City', isStation: true },
    { name: 'Benyovszky Gateway', isStation: true },
    { name: 'Niinimäki', isStation: true },
    { name: 'Resource Extraction Site [High]', type: 'ResourceExtraction', isStation: false },
  ],
};

const brief = () =>
  buildNewsBrief('HIP 71120', INTEL, {
    construction: [{ station: "Bawa Hospitality Site", remaining: 2598, pct: 56.8, top: ['Aluminium', 'Steel'] }],
    markets: [{ station: 'Niinimäki', sells: ['Steel', 'Titanium'] }],
    commanderDid: ['delivered 477 t of Aluminium to the site today'],
  });

// ------------------------------------------------------------------ the brief

test('the brief states the board, strongest faction first', () => {
  const b = brief();
  assert.match(b[0], /SYSTEM: HIP 71120 — population 99,298,561, High Tech economy, Democracy, Low Security/);
  assert.ok(b.includes('CONTROLLING FACTION: Explorer on Tour.'));
  const factions = b.filter((l) => l.startsWith('FACTION:'));
  assert.equal(factions.length, 4);
  assert.match(factions[0], /Explorer on Tour — 42.7% influence, in Expansion/);
  assert.match(factions[1], /HIP 71462 Council — 30.6% influence/); // no state, no comma dangle
  assert.ok(b.some((l) => l.startsWith('CONSTRUCTION: Bawa Hospitality Site is 57% built')));
  assert.ok(b.some((l) => l.startsWith('STATION: Anders City')));
  assert.ok(b.some((l) => l.startsWith('SIGNAL: Resource Extraction Site')));
  assert.ok(b.some((l) => l.startsWith('LOCAL TRADER: delivered 477 t')));
});

test('an unknown system has no paper', () => {
  assert.deepEqual(buildNewsBrief('unknown', INTEL), []);
  assert.deepEqual(buildNewsBrief('', undefined), []);
  // A system we know nothing about still gets a masthead, not a crash.
  assert.deepEqual(buildNewsBrief('Sol', undefined), ['SYSTEM: Sol.']);
});

test('the prompt carries the brief and what not to repeat', () => {
  const chat = buildNewsChat(brief(), 3, ['Explorer on Tour tightens grip']);
  assert.equal(chat[0].role, 'system');
  assert.match(chat[0].content, /never invent a faction, station, system or commodity/);
  assert.match(chat[1].content, /Write 3 short stories/);
  assert.match(chat[1].content, /Explorer on Tour tightens grip/);
});

// -------------------------------------------------------------- the fact check

test('names in the brief are printable; anything else is an invention', () => {
  const allowed = allowedNames(brief());
  assert.ok(allowed.has('explorer on tour'));
  assert.ok(allowed.has('anders city'));
  assert.equal(
    findInvention({ headline: 'Explorer on Tour expands', body: 'Anders City reports steady traffic.' }, allowed),
    null,
  );
  // The failure this guard exists for: a plausible faction nobody has heard of.
  assert.equal(
    findInvention({ headline: 'Vega Combine moves in', body: 'Trouble at Kessler Terminal.' }, allowed),
    'Vega Combine',
  );
});

test('a Title Cased headline is not mistaken for an invented name', () => {
  // Three real editions were thrown away over exactly these, while the stories
  // under them were entirely grounded.
  const allowed = allowedNames(brief());
  for (const headline of [
    'Bawa Site Construction Continues',
    'Resource Signal Detected Near HIP 71120',
    'Steel, Titanium, Polymers Available at Niinimäki',
  ]) {
    assert.equal(isTitleCase(headline), true, headline);
    assert.equal(findInvention({ headline, body: 'The site reports steady progress.' }, allowed), null, headline);
  }
  // A sentence-case headline is still checked, because it reads as prose.
  assert.equal(isTitleCase('Vega Combine moves in'), false);
  assert.equal(
    findInvention({ headline: 'Vega Combine moves in', body: 'Quiet week otherwise.' }, allowed),
    'Vega Combine',
  );
  // ...and an invention in the body is caught however the headline is written.
  // Reported with the article it was printed with — that is the run we saw.
  assert.equal(
    findInvention(
      { headline: 'Trouble On The Lanes Again', body: 'The Vega Combine has claimed two hauliers.' },
      allowed,
    ),
    // Reported without the article: "The Meridian Hawks" and "Meridian Hawks"
    // must be one name, or the cast grows a duplicate for every mention.
    'Vega Combine',
  );
});

test('invented sources are dropped, grounded ones survive', () => {
  const raw = JSON.stringify([
    { headline: 'Explorer on Tour widens lead', body: 'The controlling faction sits on 42.7% as expansion continues.' },
    { headline: 'Vega Combine eyes the lanes', body: 'A new player, apparently.' },
    { headline: 'Bawa site past halfway', body: 'Aluminium remains the bottleneck at 57% built.' },
  ]);
  const { items, rejected } = acceptNews(raw, { brief: brief(), system: 'HIP 71120', at: '2026-08-13T20:00:00Z' });
  assert.deepEqual(items.map((i) => i.headline), ['Explorer on Tour widens lead', 'Bawa site past halfway']);
  assert.equal(rejected.length, 1);
  assert.match(rejected[0], /invented "Vega Combine"/);
  assert.equal(items[0].system, 'HIP 71120');
  assert.equal(items[0].at, '2026-08-13T20:00:00Z');
});

test('yesterday’s headline does not run again today', () => {
  const raw = JSON.stringify([
    { headline: 'Explorer on Tour widens lead', body: 'Still expanding.' },
    { headline: 'Niinimäki steel keeps the sites fed', body: 'Stock holding at the crater outpost.' },
  ]);
  const { items, rejected } = acceptNews(raw, {
    brief: brief(),
    system: 'HIP 71120',
    at: '2026-08-13T21:00:00Z',
    recentHeadlines: ['Explorer on Tour widens lead'],
  });
  assert.deepEqual(items.map((i) => i.headline), ['Niinimäki steel keeps the sites fed']);
  assert.match(rejected[0], /repeat of/);
});

test('the wire is allowed to be thin rather than padded', () => {
  const { items } = acceptNews('[]', { brief: brief(), system: 'HIP 71120', at: 'x' });
  assert.deepEqual(items, []);
  const distinct = [
    { headline: 'Anders City traffic holds steady', body: 'Docking queues unchanged.' },
    { headline: 'Expansion pushes influence past forty percent', body: 'The board shifts again.' },
    { headline: 'Crater outpost keeps steel flowing', body: 'Stock remains deep.' },
    { headline: 'Low security bites on the lanes', body: 'Hauliers report interdictions.' },
    { headline: 'Bawa bottleneck eases', body: 'Aluminium arrivals up.' },
  ];
  const capped = acceptNews(JSON.stringify(distinct), {
    brief: brief(),
    system: 'HIP 71120',
    at: 'x',
    max: 2,
  });
  assert.equal(capped.items.length, 2);
});

// ------------------------------------------------------- what models actually send

test('JSON survives markdown fences and chatty preambles', () => {
  const fenced = 'Here are the stories:\n```json\n[{"headline":"A","body":"B"}]\n```\nHope that helps!';
  assert.deepEqual(parseNewsItems(fenced), [{ headline: 'A', body: 'B' }]);
  // One object per line, no array at all.
  const loose = '{"headline":"One","body":"First."}\n{"headline":"Two","body":"Second."}';
  assert.deepEqual(parseNewsItems(loose).map((i) => i.headline), ['One', 'Two']);
  // title/text instead of headline/body, and quoted junk trimmed.
  assert.deepEqual(parseNewsItems('[{"title":"  \\"T\\" ","text":"Body."}]'), [{ headline: 'T', body: 'Body.' }]);
  assert.deepEqual(parseNewsItems('not json at all'), []);
  assert.deepEqual(parseNewsItems('[{"headline":"only a headline"}]'), []); // half a story is no story
});

// ---------------------------------------------------------------- the schedule

test('the wire runs on its own clock, and Off means off', () => {
  const t0 = Date.parse('2026-08-13T20:00:00Z');
  assert.equal(newsDue(null, 30, t0), true); // never run: publish at once
  assert.equal(newsDue(t0, 0, t0 + 9e6), false); // Off stays off however long
  assert.equal(newsDue(t0, 30, t0 + 29 * 60_000), false);
  assert.equal(newsDue(t0, 30, t0 + 30 * 60_000), true);
  assert.equal(newsIntervalLabel(0), 'Off');
  assert.equal(newsIntervalLabel(20), 'Every 20 min');
  assert.equal(newsIntervalLabel(60), 'Hourly');
});

// ------------------------------------------------- desks, invention and continuity

test('desks are offered only when the brief can support them, and they rotate', () => {
  const b = brief();
  assert.deepEqual(desksFor(b, 0), ['civic', 'industry', 'crime', 'sport', 'life']);
  // Rotation means the same desk does not lead every edition.
  assert.equal(desksFor(b, 1)[0], 'industry');
  assert.equal(desksFor(b, 2)[0], 'crime');
  // A system with nothing but a masthead has no politics or industry to report,
  // but the invented desks still run — that is the point of them.
  assert.deepEqual(desksFor(['SYSTEM: Sol.'], 0), ['crime', 'sport', 'life']);
  assert.deepEqual(desksFor([], 0), ['sport', 'life']);
});

test('the sport desk may invent a team; the civic desk may not invent a faction', () => {
  const raw = JSON.stringify([
    { desk: 'sport', headline: 'Perga Drifters take the dock league', body: 'The Perga Drifters held on in the final heat.' },
    { desk: 'civic', headline: 'Vega Combine claims a seat', body: 'The Vega Combine says it will contest the next ballot.' },
  ]);
  const { items, rejected, cast } = acceptNews(raw, {
    brief: brief(),
    system: 'HIP 71120',
    at: '2026-08-13T20:00:00Z',
    desks: ['sport', 'civic'],
  });
  assert.deepEqual(items.map((i) => i.desk), ['sport']);
  assert.match(rejected[0], /invented "Vega Combine" on the civic desk/);
  // The team is now canon, and carries its desk with it.
  assert.deepEqual(cast.map((c) => [c.name, c.desk, c.mentions]), [['Perga Drifters', 'sport', 1]]);
});

test('an invented name may not be shaped like a station', () => {
  const raw = JSON.stringify([
    { desk: 'life', headline: 'A new bar opens', body: 'Regulars are drifting to Kessler Terminal for the cheaper beer.' },
  ]);
  const { items, rejected } = acceptNews(raw, {
    brief: brief(),
    system: 'HIP 71120',
    at: 'x',
    desks: ['life'],
  });
  assert.deepEqual(items, []);
  assert.match(rejected[0], /invented a place, "Kessler Terminal"/);
  assert.equal(looksLikeGamePlace('Perga Drifters'), false);
  for (const p of ['Kessler Terminal', 'Bawa Hub', 'HIP 90210', 'Rowe Orbital']) {
    assert.equal(looksLikeGamePlace(p), true, p);
  }
});

test('both teams in a fixture are registered, not just the first', () => {
  // The continuity bug: only the first invented name was ever recorded, so the
  // second team was forgotten and reinvented under a new name next edition.
  // Four live editions produced six different teams for one dock-crew league.
  const raw = JSON.stringify([
    {
      desk: 'sport',
      headline: 'Hawks edge the Drifters at the line',
      body: 'The Meridian Hawks beat the Stellar Drifters by a length in the dock-crew final.',
    },
  ]);
  const { items, cast } = acceptNews(raw, {
    brief: brief(),
    system: 'HIP 71120',
    at: '2026-08-13T20:00:00Z',
    desks: ['sport'],
  });
  assert.equal(items.length, 1);
  assert.deepEqual(cast.map((c) => c.name).sort(), ['Meridian Hawks', 'Stellar Drifters']);
});

test('a fourth new name is one too many for one edition', () => {
  const raw = JSON.stringify([
    {
      desk: 'life',
      headline: 'Concourse round-up',
      body: 'The Rusty Coupling, the Void Bean, the Lamplight Rooms and Sal Vance all report a quiet cycle.',
    },
  ]);
  const { items, rejected } = acceptNews(raw, {
    brief: brief(),
    system: 'HIP 71120',
    at: 'x',
    desks: ['life'],
  });
  assert.equal(items.length, 0);
  assert.match(rejected[0], /too many new names/);
});

test('a cast member returns without being reinvented, and the count rises', () => {
  const cast = [
    { name: 'Perga Drifters', desk: 'sport' as const, firstAt: '2026-08-13T20:00:00Z', lastAt: '2026-08-13T20:00:00Z', mentions: 1 },
  ];
  const raw = JSON.stringify([
    { desk: 'sport', headline: 'Drifters drop the return leg', body: 'The Perga Drifters lost by two lengths this cycle.' },
  ]);
  const out = acceptNews(raw, {
    brief: buildNewsBrief('HIP 71120', INTEL, { cast }),
    system: 'HIP 71120',
    at: '2026-08-13T21:00:00Z',
    desks: ['sport'],
    cast,
  });
  assert.equal(out.rejected.length, 0); // known name, not an invention
  assert.equal(out.cast[0].mentions, 2);
  assert.equal(out.cast[0].firstAt, '2026-08-13T20:00:00Z'); // still their debut
  assert.equal(out.cast[0].lastAt, '2026-08-13T21:00:00Z');
});

test('the brief carries the paper’s own continuity', () => {
  const b = buildNewsBrief('HIP 71120', INTEL, {
    denials: ['V6W-TTJ'],
    cast: [{ name: 'Perga Drifters', desk: 'sport', firstAt: 'a', lastAt: 'b', mentions: 3 }],
    previously: ['Drifters take the dock league'],
  });
  assert.ok(b.some((l) => l === 'DENIED: V6W-TTJ has refused hauliers docking.'));
  assert.ok(b.some((l) => l === 'RECURRING: Perga Drifters (Sport), mentioned 3× before.'));
  assert.ok(b.some((l) => l === 'PREVIOUSLY: Drifters take the dock league'));
  // ...and the prompt tells each story which desk it is filing from.
  const chat = buildNewsChat(b, 2, [], ['crime', 'sport']);
  assert.match(chat[1].content, /1\. desk "crime"/);
  assert.match(chat[1].content, /2\. desk "sport"/);
  assert.match(chat[0].content, /at most three new names/);
});

test('the cast is capped at the most recently used', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    name: `Person ${i}`,
    desk: 'life' as const,
    firstAt: '2026-01-01T00:00:00Z',
    lastAt: new Date(Date.parse('2026-01-01T00:00:00Z') + i * 60_000).toISOString(),
    mentions: 1,
  }));
  const kept = trimCast(many);
  assert.equal(kept.length, 12);
  assert.equal(kept[0].name, 'Person 19'); // newest first
});

// ------------------------------------------------------------- the economy desk

const mkt = (station: string, at: string, items: Array<[string, number, number, number, number]>): MarketRecord => ({
  marketId: station.length,
  station,
  system: 'HIP 71120',
  at,
  items: items.map(([name, buy, stock, sell, demand]) => ({ name, buy, sell, stock, demand })),
});

test('a price with nothing to compare it to is a listing, not news', () => {
  const now = [mkt('Niinimäki', 'day1', [['Steel', 3456, 371_309, 0, 0]])];
  const first = marketPulse(now, {});
  assert.deepEqual(first.lines, []); // nothing to move against yet
  assert.equal(first.next['niinimäki|steel'].price, 3456);
});

test('a move is reported once there is a previous price', () => {
  const before = marketPulse([mkt('Niinimäki', 'day1', [['Steel', 3456, 371_309, 0, 0]])], {}).next;
  const { lines } = marketPulse([mkt('Niinimäki', 'day2', [['Steel', 3900, 371_309, 0, 0]])], before);
  assert.match(lines[0], /MOVE: Steel at Niinimäki is 3,900 cr, up 13% since it was last read/);
  // A wobble is not a story.
  const quiet = marketPulse([mkt('Niinimäki', 'day3', [['Steel', 3500, 371_309, 0, 0]])], before);
  assert.deepEqual(quiet.lines.filter((l) => l.startsWith('MOVE:')), []);
  // Nor is a re-read of the very same snapshot.
  const same = marketPulse([mkt('Niinimäki', 'day1', [['Steel', 3456, 1, 0, 0]])], before);
  assert.deepEqual(same.lines.filter((l) => l.startsWith('MOVE:')), []);
});

test('the spread between two stations is the story a hauler wants', () => {
  const { lines } = marketPulse(
    [
      mkt('Niinimäki', 'd', [['Steel', 3456, 371_309, 0, 0]]),
      mkt('Benyovszky Gateway', 'd', [['Steel', 4124, 120_698, 0, 0]]),
    ],
    {},
  );
  assert.match(lines[0], /SPREAD: Steel runs 3,456 cr at Niinimäki to 4,124 cr at Benyovszky Gateway — 668 cr apart/);
  // Two stations a few credits apart is not a spread.
  const flat = marketPulse(
    [mkt('A', 'd', [['Steel', 3456, 10, 0, 0]]), mkt('B', 'd', [['Steel', 3500, 10, 0, 0]])],
    {},
  );
  assert.deepEqual(flat.lines, []);
});

test('who is paying, and how badly', () => {
  const { lines } = marketPulse([mkt('Anders City', 'd', [['Gold', 0, 0, 9120, 41_000]])], {});
  assert.match(lines[0], /DEMAND: Anders City is paying 9,120 cr for Gold, wanting 41,000 t/);
  // Thin demand is not a market report.
  assert.deepEqual(marketPulse([mkt('Anders City', 'd', [['Gold', 0, 0, 9120, 12]])], {}).lines, []);
});

test('the economy desk opens only when there is a price story', () => {
  const quiet = buildNewsBrief('HIP 71120', INTEL, {});
  assert.equal(desksFor(quiet).includes('economy'), false);
  const loud = buildNewsBrief('HIP 71120', INTEL, {
    pulse: ['MOVE: Steel at Niinimäki is 3,900 cr, up 13% since it was last read.'],
  });
  assert.equal(desksFor(loud).includes('economy'), true);
  assert.ok(loud.some((l) => l.startsWith('MOVE: Steel')));
});

test('an edition is budgeted for prose, not for a one-word verdict', () => {
  // The bug this exists to prevent: the store reached for llmQuick, whose
  // maxTokens defaults to 8 — enough for "```json\n[\n  {" and nothing more.
  // Every edition came back unparseable and the tab said "nothing printable".
  // Three stories measured ~940 characters against the real model.
  assert.ok(newsMaxTokens(3) >= 700, 'three stories need room for ~940 chars');
  assert.ok(newsMaxTokens(1) > 8 * 20, 'even one story dwarfs the llmQuick default');
  assert.equal(newsMaxTokens(5) > newsMaxTokens(3), true);
  assert.equal(newsMaxTokens(0), newsMaxTokens(1)); // never budget nothing
});

// ---------------------------------------------------------------- house style

test('the tone changes the writer, never the rules', () => {
  const b = brief();
  const wry = buildNewsChat(b, 3, [], ['civic'], 'wry')[0].content;
  const straight = buildNewsChat(b, 3, [], ['civic'], 'straight')[0].content;
  // The voice differs...
  assert.match(wry, /deadpan/i);
  // A character with a history, not a list of adjectives — the difference
  // between "the machinery moves where the permissions allow" and a bulletin.
  assert.match(wry, /still at eighty percent/i);
  assert.match(wry, /never the crews/i); // punches upwards, not down
  assert.doesNotMatch(straight, /deadpan|cynicism/i);
  // ...and every guard-rail survives both, verbatim.
  for (const prompt of [wry, straight]) {
    assert.match(prompt, /never invent a faction, station, system or commodity/);
    assert.match(prompt, /never change a number/);
    assert.match(prompt, /at most three new names/);
    assert.match(prompt, /Return only the array/);
  }
  // Wry is the default, because a flat wire is the thing nobody opens twice.
  assert.equal(buildNewsChat(b, 3)[0].content, wry);
});

test('the brief still rides in the user message, not the system one', () => {
  // The facts are data, not persona: the wire is asked to READ them, and the
  // rules that govern reading them live in a message the brief cannot edit.
  const chat = buildNewsChat(brief(), 2, [], ['civic', 'sport'], 'wry');
  assert.equal(chat.length, 2);
  assert.equal(chat[0].role, 'system');
  assert.equal(chat[1].role, 'user');
  assert.doesNotMatch(chat[0].content, /HIP 71120/); // no facts in the persona
  assert.match(chat[1].content, /FACTION: Explorer on Tour/);
  assert.match(chat[1].content, /desk "civic"/);
});
