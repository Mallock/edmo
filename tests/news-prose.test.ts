/**
 * The prose wire — one story per call, no JSON.
 *
 * The edition used to come back as a JSON array, which made the paper only as
 * reliable as the model's grasp of punctuation. Measured: Llama 3.1 8B writes
 * livelier prose than the model this app ships and answered `{"civic","..."}`,
 * which is not valid JSON and has no keys — so a perfectly readable edition was
 * thrown away whole. Nothing in that array was ever news. The desk, the count
 * and the assembly all belong to the caller; only the words belong to the model.
 *
 * These tests pin that split, and they pin the parser's forgiveness, because
 * the failure mode being replaced was total rather than partial.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptNews, buildNewsBrief, buildStoryChat, parseStory } from '../src/engine/news.ts';
import type { SystemIntel } from '../src/engine/types.ts';

const NOW = '3311-01-02T03:04:05Z';

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
  ],
  signals: [
    { name: 'Anders City', isStation: true },
    { name: 'Resource Extraction Site [High]', type: 'ResourceExtraction', isStation: false },
  ],
};

/** The real builder, so `allowedNames` sees the shape it actually parses. */
const brief = (): string[] => buildNewsBrief('HIP 71120', INTEL);

test('the scenery beat: scanned worlds reach the news brief', () => {
  const lines = buildNewsBrief('HIP 71120', INTEL, {
    worlds: ['5 a — an icy moon, 0.08 G, nobody has ever set foot there'],
  });
  assert.ok(lines.some((l) => l.startsWith('WORLD: 5 a — an icy moon')));
});

test('the news brief explains a beacon as the navigation stop', () => {
  const withBeacon: SystemIntel = {
    ...INTEL,
    signals: [...(INTEL.signals ?? []), { name: 'Henry Beacon', type: 'Installation', isStation: false }],
  };
  const lines = buildNewsBrief('HIP 71120', withBeacon);
  const sig = lines.find((l) => l.includes('Henry Beacon'))!;
  assert.match(sig, /the routine navigation stop/);
  // Non-beacon signals stay bare.
  const res = lines.find((l) => l.includes('Resource Extraction Site'))!;
  assert.doesNotMatch(res, /navigation stop/);
});

test('a story prompt asks for prose, never for a data structure', () => {
  const all = buildStoryChat(brief(), 'civic', [], 'wry')
    .map((m) => m.content)
    .join(' ');
  assert.doesNotMatch(all, /JSON/i);
  assert.doesNotMatch(all, /"desk"/);
  assert.match(all, /HEADLINE on the first line/i);
  assert.match(all, /blank line/i);
});

test('a story prompt carries only its own desk', () => {
  const civic = buildStoryChat(brief(), 'civic')[1].content;
  const sport = buildStoryChat(brief(), 'sport')[1].content;
  assert.match(civic, /Civic desk/);
  assert.match(sport, /Sport desk/);
  assert.notEqual(civic, sport);
});

test('headline, blank line, body', () => {
  const out = parseStory(
    `Explorer Tightens Its Grip

Influence held at 42.7% this week.`,
    'civic',
  );
  assert.deepEqual(out, {
    headline: 'Explorer Tightens Its Grip',
    body: 'Influence held at 42.7% this week.',
    desk: 'civic',
  });
});

test('volunteered labels, bullets and emphasis are stripped', () => {
  const out = parseStory(
    `**Headline:** Docks Grind On

- Body: The lifts failed again.`,
  );
  assert.equal(out?.headline, 'Docks Grind On');
  assert.equal(out?.body, 'The lifts failed again.');
});

test('a single run-together paragraph still yields a story', () => {
  // A headline IS the first sentence. Rejecting this shape would throw away a
  // story that reads perfectly well — the exact mistake the JSON wire made.
  const out = parseStory('Lifts Fail Again. Dock crews report the third outage this week.');
  assert.equal(out?.headline, 'Lifts Fail Again');
  assert.match(out?.body ?? '', /third outage/);
});

test('several body lines become one paragraph', () => {
  const out = parseStory(
    `A Quiet Week

Nothing moved on the board.
Nobody expected it to.`,
  );
  assert.equal(out?.body, 'Nothing moved on the board. Nobody expected it to.');
});

test('a markdown fence does not defeat it', () => {
  const out = parseStory(
    '```\nDocks Grind On\n\nThe lifts failed again.\n```',
  );
  assert.equal(out?.headline, 'Docks Grind On');
});

test('empty and headline-only replies are rejected', () => {
  assert.equal(parseStory(''), null);
  assert.equal(parseStory('   \n\n  '), null);
  assert.equal(parseStory('Just A Headline'), null);
});

test('accepting pre-parsed stories runs the same checks as raw text', () => {
  // The verification is the point of acceptNews; the wire format is not. A
  // story handed over already parsed must still be spiked for inventing a
  // faction on a reported desk.
  // Headlines are three words or more: below that `isTitleCase` reads them as
  // prose and scans them for invented names, which is existing behaviour and
  // nothing to do with the wire format.
  const { items, rejected } = acceptNews(
    [
      { headline: 'Faction Board Holds Steady', body: 'Explorer on Tour holds 42.7%.', desk: 'civic' },
      { headline: 'Newcomer Rises On The Docks', body: 'The Vega Combine moved in.', desk: 'civic' },
    ],
    { brief: brief(), system: 'HIP 71120', at: NOW, max: 3, desks: ['civic', 'civic'] },
  );
  assert.equal(items.length, 1);
  assert.equal(items[0].headline, 'Faction Board Holds Steady');
  assert.match(rejected[0], /Vega Combine/);
});
