/**
 * The topic roll and the regulars — the part that makes the channel a place.
 *
 * The property these tests defend is that the air is NOT about the commander
 * most of the time, that the same category cannot come straight back, and
 * that a running gag has somewhere to run: a recurring voice keeps its name,
 * its quirk and its bit, and only what was actually heard enters its ledger.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FRAGMENT_SHARE,
  NO_REPEAT_WINDOW,
  TOPICS,
  TOPIC_CATEGORIES,
  TopicLedger,
  categoriesFor,
  linesForShape,
  relevanceShare,
  topicSubjectKey,
  type Relevance,
  type TopicCategory,
} from '../src/engine/chatter/topics.ts';
import {
  LEDGER_DEPTH,
  MAX_REGULARS_PER_CATEGORY,
  REGULAR_STALE_MS,
  RETIRE_AFTER,
  RegularsBook,
} from '../src/engine/chatter/regulars.ts';
import { buildPersonaPool } from '../src/engine/chatter/cast.ts';
import { CHANNEL_IDS } from '../src/engine/chatter/types.ts';

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

const VOICES = ['en_GB-alba-medium', 'en_GB-northern_english_male-medium', 'en_US-lessac-medium'];
const ISO = '2026-09-05T10:00:00.000Z';

/** Roll and note `n` beats on one channel, returning what the ledger saw. */
function run(ledger: TopicLedger, n: number, relevance: Relevance, rand: () => number, channel = 'LOCAL' as const): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = ledger.roll({ channel, relevance, rand });
    const what = r.kind === 'ambient' ? r.category : 'relevant';
    ledger.note(what);
    out.push(what);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

test('every category has a brief, seeds to draw on, channels and a voice', () => {
  for (const id of TOPIC_CATEGORIES) {
    const def = TOPICS[id];
    assert.equal(def.id, id);
    assert.ok(def.label.length > 2, id);
    assert.ok(def.brief.length > 40, `${id} brief`);
    assert.ok(def.seeds.length >= 6, `${id} needs seeds to rotate through`);
    assert.ok(def.channels.length >= 3, `${id} channels`);
    assert.ok(def.voice.character.length > 20, `${id} voice`);
    for (const seed of def.seeds) {
      // Seeds are ideas, not lines: nothing quotable, nothing in first person.
      assert.doesNotMatch(seed, /^["“]/, `${id}: ${seed}`);
      assert.doesNotMatch(seed, /\bI\b/, `${id}: ${seed}`);
    }
  }
});

test('the tower and the emergency channel never carry comedy', () => {
  assert.deepEqual(categoriesFor('TOWER'), []);
  assert.deepEqual(categoriesFor('EMERGENCY'), []);
  for (const ch of CHANNEL_IDS) {
    if (ch === 'TOWER' || ch === 'EMERGENCY') continue;
    // Enough choice that the no-repeat window can always find something.
    assert.ok(categoriesFor(ch).length > NO_REPEAT_WINDOW, ch);
  }
});

test('a roll on a channel with no categories is relevant by construction', () => {
  const ledger = new TopicLedger();
  const rand = seeded(3);
  for (let i = 0; i < 50; i++) {
    assert.equal(ledger.roll({ channel: 'TOWER', relevance: 'low', rand }).kind, 'relevant');
    assert.equal(ledger.roll({ channel: 'EMERGENCY', relevance: 'low', rand }).kind, 'relevant');
  }
});

test('nothing in the catalogue breaks the frame', () => {
  const text = JSON.stringify(TOPICS);
  // In-fiction only: no meta, no vocabulary from outside the universe.
  assert.doesNotMatch(text, /\b(AI|LLM|prompt|simulation|video ?game|gamer|Frontier)\b/);
});

// ---------------------------------------------------------------------------
// The roll
// ---------------------------------------------------------------------------

test('most beats are not about the commander — the share tracks the dial', () => {
  for (const level of ['low', 'medium'] as const) {
    const ledger = new TopicLedger();
    const seen = run(ledger, 6000, level, seeded(11));
    const share = seen.filter((s) => s === 'relevant').length / seen.length;
    const target = relevanceShare(level);
    assert.ok(Math.abs(share - target) < 0.04, `${level}: ${share.toFixed(3)} vs ${target}`);
  }
  // High is the old behaviour, mostly — but still not all of it.
  const ledger = new TopicLedger();
  const seen = run(ledger, 6000, 'high', seeded(12));
  const share = seen.filter((s) => s === 'relevant').length / seen.length;
  assert.ok(share > 0.45 && share < 0.7, `high: ${share.toFixed(3)}`);
});

test('the default dial lands at roughly a third', () => {
  assert.equal(relevanceShare('medium'), 0.3);
  assert.ok(relevanceShare('low') < relevanceShare('medium'));
  assert.ok(relevanceShare('high') > relevanceShare('medium'));
});

test('a relevant beat never follows a relevant beat below high', () => {
  for (const level of ['low', 'medium'] as const) {
    const seen = run(new TopicLedger(), 3000, level, seeded(21));
    for (let i = 1; i < seen.length; i++) {
      assert.ok(!(seen[i] === 'relevant' && seen[i - 1] === 'relevant'), `${level} at ${i}`);
    }
  }
});

test('a category cannot fire twice inside the no-repeat window', () => {
  const seen = run(new TopicLedger(), 4000, 'low', seeded(31));
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] === 'relevant') continue;
    const window = seen.slice(Math.max(0, i - NO_REPEAT_WINDOW), i);
    assert.ok(!window.includes(seen[i]), `${seen[i]} repeated at ${i}: ${window.join(',')}`);
  }
});

test('the window holds across channels, not per channel', () => {
  const ledger = new TopicLedger();
  const rand = seeded(41);
  for (let i = 0; i < 2000; i++) {
    const channel = (['LOCAL', 'STATION', 'CONCOURSE', 'CREW'] as const)[i % 4];
    const r = ledger.roll({ channel, relevance: 'low', rand });
    const what = r.kind === 'ambient' ? r.category : 'relevant';
    if (r.kind === 'ambient') {
      assert.ok(!ledger.barred().has(r.category), `${r.category} was barred`);
      assert.ok(TOPICS[r.category].channels.includes(channel), `${r.category} does not fit ${channel}`);
    }
    ledger.note(what);
  }
});

test('with the window full, only the categories that fired longest ago are open', () => {
  // Fire every category the carrier channel fits, oldest first. The last
  // NO_REPEAT_WINDOW of them are barred; the earlier ones are the only
  // candidates, whatever the dice say.
  const fits = categoriesFor('CARRIER');
  assert.ok(fits.length > NO_REPEAT_WINDOW);
  const ledger = new TopicLedger();
  for (const c of fits) ledger.note(c);
  const open = new Set(fits.slice(0, fits.length - NO_REPEAT_WINDOW));
  assert.deepEqual([...ledger.barred()].sort(), fits.slice(-NO_REPEAT_WINDOW).sort());
  let ambient = 0;
  for (let i = 0; i < 40; i++) {
    const r = ledger.roll({ channel: 'CARRIER', relevance: 'low', rand: seeded(100 + i) });
    if (r.kind !== 'ambient') continue;
    ambient += 1;
    assert.ok(open.has(r.category), `${r.category} was barred`);
  }
  assert.ok(ambient > 20);
});

test('every ambient roll carries a seed from its own category', () => {
  const ledger = new TopicLedger();
  const rand = seeded(51);
  for (let i = 0; i < 500; i++) {
    const r = ledger.roll({ channel: 'LOCAL', relevance: 'low', rand });
    if (r.kind !== 'ambient') continue;
    assert.ok(TOPICS[r.category].seeds.includes(r.seed), r.seed);
    assert.equal(TOPICS[r.category].seeds[r.seedIndex], r.seed);
  }
});

test('about a third of ambient beats are fragments, and each shape sets its line count', () => {
  const ledger = new TopicLedger();
  const rand = seeded(61);
  let ambient = 0;
  let fragments = 0;
  for (let i = 0; i < 6000; i++) {
    const r = ledger.roll({ channel: 'LOCAL', relevance: 'low', rand });
    if (r.kind !== 'ambient') continue;
    ambient += 1;
    if (r.shape !== 'exchange') fragments += 1;
    assert.equal(r.lines, linesForShape(r.shape));
  }
  const share = fragments / ambient;
  assert.ok(Math.abs(share - FRAGMENT_SHARE) < 0.04, share.toFixed(3));
  assert.equal(linesForShape('reply-unheard'), 1);
  assert.equal(linesForShape('punchline'), 1);
  assert.equal(linesForShape('mid-argument'), 2);
  assert.equal(linesForShape('exchange'), undefined);
});

test('seeds cycle rather than cluster', () => {
  const ledger = new TopicLedger();
  const rand = seeded(71);
  const picks = Array.from({ length: 10 }, () => ledger.pickSeed('conspiracy', rand).seedIndex);
  // Least-recently-used among the coldest three: a seed cannot come back
  // until seven others have been used since, so ten picks hold at least eight
  // distinct ideas.
  assert.ok(new Set(picks).size >= 8, picks.join(','));
});

test('a seed can be excluded — a newcomer does not take a bit somebody already has', () => {
  const ledger = new TopicLedger();
  const taken = new Set(TOPICS.grievance.seeds.slice(0, 9));
  for (let i = 0; i < 20; i++) {
    const { seed } = ledger.pickSeed('grievance', seeded(80 + i), taken);
    assert.equal(seed, TOPICS.grievance.seeds[9]);
  }
});

test('the ledger survives a restart', () => {
  const a = new TopicLedger();
  run(a, 40, 'medium', seeded(91));
  const b = new TopicLedger();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  assert.deepEqual(b.history(), a.history());
  assert.deepEqual([...b.barred()], [...a.barred()]);
  assert.equal(b.relevantShare(), a.relevantShare());
});

test('loading garbage into the ledger is survivable', () => {
  const l = new TopicLedger();
  l.load(null);
  l.load('nonsense');
  l.load({ recent: [1, 2, { x: 1 }], seedUse: { 'a:0': 'no', 'b:1': 3 } });
  assert.deepEqual(l.history(), []);
  const r = l.roll({ channel: 'LOCAL', relevance: 'low', rand: seeded(1) });
  assert.ok(r.kind === 'relevant' || r.kind === 'ambient');
});

test('an ambient beat is written against a subject the engine will not open an arc on', () => {
  assert.match(topicSubjectKey('bureaucracy', 3), /^topic:bureaucracy:3$/);
});

// ---------------------------------------------------------------------------
// The regulars
// ---------------------------------------------------------------------------

test('a regular is born with the archetype’s quirk, a fitting voice and the rolled bit', () => {
  const book = new RegularsBook();
  const pool = buildPersonaPool(VOICES);
  const r = book.cast('conspiracy', 'the station rotates to hide something', seeded(5), pool, ISO);
  assert.equal(r.category, 'conspiracy');
  assert.equal(r.persona.quirk, TOPICS.conspiracy.voice.quirk);
  assert.ok(VOICES.includes(r.persona.voice));
  assert.equal(r.character, TOPICS.conspiracy.voice.character);
  assert.equal(r.bit, 'the station rotates to hide something');
  assert.deepEqual(r.ledger, []);
  assert.equal(r.heard, 0);
  assert.match(r.name, /^\S+ \S+$/);
});

test('a returning regular keeps their bit and ignores the new seed', () => {
  const book = new RegularsBook();
  const pool = buildPersonaPool(VOICES);
  const first = book.cast('grievance', 'pad seven', seeded(5), pool, ISO);
  // rand under REGULAR_SHARE — come back rather than invent.
  const again = book.cast('grievance', 'the mug', () => 0.1, pool, ISO);
  assert.equal(again.id, first.id);
  assert.equal(again.bit, 'pad seven');
  assert.equal(again.persona.voice, first.persona.voice);
  assert.equal(book.size, 1);
});

test('a category holds at most two regulars, then always returns one of them', () => {
  const book = new RegularsBook();
  const pool = buildPersonaPool(VOICES);
  // rand above REGULAR_SHARE — always try to invent.
  const invent = () => 0.95;
  const a = book.cast('mic-open', 'the cat', invent, pool, ISO);
  const b = book.cast('mic-open', 'the plant', invent, pool, ISO);
  assert.notEqual(a.id, b.id);
  assert.equal(book.forCategory('mic-open').length, MAX_REGULARS_PER_CATEGORY);
  const c = book.cast('mic-open', 'the vending machine', invent, pool, ISO);
  assert.ok([a.id, b.id].includes(c.id));
  assert.equal(book.size, 2);
  assert.deepEqual([...book.takenBits('mic-open')].sort(), ['the cat', 'the plant']);
});

test('two regulars do not share a voice while another is free', () => {
  const book = new RegularsBook();
  const pool = buildPersonaPool(VOICES);
  const invent = () => 0.95;
  const a = book.cast('mic-open', 'x', invent, pool, ISO);
  const b = book.cast('mic-open', 'y', invent, pool, ISO);
  assert.notEqual(a.persona.voice, b.persona.voice);
});

test('with no voice for the quirk the quirk still holds; with no voices at all the cast substitutes later', () => {
  const book = new RegularsBook();
  const onlyOther = buildPersonaPool(VOICES).filter((p) => p.quirk === 'clipped');
  const a = book.cast('bureaucracy', 'form 6-C', seeded(2), onlyOther, ISO);
  assert.equal(a.persona.quirk, 'formal');
  assert.ok(VOICES.includes(a.persona.voice));
  const b = book.cast('wrong-lane', 'sideways', seeded(2), [], ISO);
  assert.equal(b.persona.voice, '');
  assert.equal(b.persona.quirk, 'veteran');
});

test('only what went on the air enters the ledger, and it escalates in order', () => {
  const book = new RegularsBook();
  const r = book.cast('small-tragedy', 'the insurance claim', seeded(9), buildPersonaPool(VOICES), ISO);
  book.noteAired(r.id, ['The adjuster quit.', ''], '2026-09-05T11:00:00.000Z');
  assert.deepEqual(r.ledger, ['The adjuster quit.']);
  assert.equal(r.heard, 1);
  assert.equal(r.lastAt, '2026-09-05T11:00:00.000Z');
  book.noteAired(r.id, ['The second adjuster quit.'], '2026-09-05T11:30:00.000Z');
  assert.deepEqual(r.ledger, ['The adjuster quit.', 'The second adjuster quit.']);
  // Nothing said, nothing learned.
  book.noteAired(r.id, ['   '], '2026-09-05T11:40:00.000Z');
  assert.equal(r.heard, 2);
  book.noteAired('nobody', ['x'], ISO);
});

test('the ledger is capped, and a regular who has escalated all the way retires', () => {
  const book = new RegularsBook();
  const r = book.cast('conspiracy', 'x', seeded(9), buildPersonaPool(VOICES), ISO);
  for (let i = 1; i < RETIRE_AFTER; i++) {
    book.noteAired(r.id, [`Evidence number ${i}.`, `And ${i} more.`], ISO);
  }
  assert.equal(r.ledger.length, LEDGER_DEPTH);
  assert.equal(r.ledger[r.ledger.length - 1], `And ${RETIRE_AFTER - 1} more.`);
  assert.ok(book.find(r.id), 'still here one short of retirement');
  book.noteAired(r.id, ['The final proof.'], ISO);
  assert.equal(book.find(r.id), undefined);
  assert.equal(book.size, 0);
});

test('a regular nobody has heard in days is forgotten', () => {
  const book = new RegularsBook();
  const r = book.cast('wrong-channel', 'the dog', seeded(3), buildPersonaPool(VOICES), ISO);
  const at = Date.parse(ISO);
  assert.equal(book.prune(at + REGULAR_STALE_MS - 1), 0);
  assert.ok(book.find(r.id));
  assert.equal(book.prune(at + REGULAR_STALE_MS + 1), 1);
  assert.equal(book.size, 0);
});

test('the regulars survive a restart with voice, quirk, bit and ledger intact', () => {
  const a = new RegularsBook();
  const r = a.cast('station-advert', 'one chair', seeded(4), buildPersonaPool(VOICES), ISO);
  a.noteAired(r.id, ['Seating for one, reservations essential.'], ISO);
  const b = new RegularsBook();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  const back = b.find(r.id);
  assert.ok(back);
  assert.equal(back.name, r.name);
  assert.equal(back.persona.voice, r.persona.voice);
  assert.equal(back.persona.quirk, r.persona.quirk);
  assert.equal(back.bit, 'one chair');
  assert.deepEqual(back.ledger, ['Seating for one, reservations essential.']);
  assert.equal(back.heard, 1);
});

test('loading garbage into the regulars is survivable', () => {
  const book = new RegularsBook();
  book.load(null);
  book.load({ v: 2, members: [] });
  book.load({ v: 1, members: [null, { id: 'x' }, { id: 'y', name: 'n', category: 'nope', persona: { voice: '' } }] });
  assert.equal(book.size, 0);
  book.load({
    v: 1,
    members: [
      { id: 'ok', name: 'A B', category: 'conspiracy' as TopicCategory, persona: { voice: 'v', quirk: 'anxious' }, ledger: 'no', heard: 'x' },
    ],
  });
  assert.equal(book.size, 1);
  assert.deepEqual(book.find('ok')?.ledger, []);
  assert.equal(book.find('ok')?.heard, 0);
});
