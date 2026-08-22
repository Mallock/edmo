/**
 * The LLM tier: prompt, parse, verify, and the pre-render slots.
 *
 * The assertion that carries the most weight is that verification happens
 * BEFORE anything is handed back as transmittable — a fabricated figure must
 * never reach the point where somebody synthesizes it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ChatterConversation,
  SITUATIONS,
  SceneSlots,
  acceptSceneReply,
  buildSceneChat,
  parseSceneReply,
  type SceneRequest,
} from '../src/engine/chatter/llm.ts';
import { FRESH_MAX_MS, textureBrief, type Brief } from '../src/engine/chatter/brief.ts';
import type { Scene } from '../src/engine/chatter/scenes.ts';

const NOW = 1_700_000_000_000;

const marketBrief = (over: Partial<Brief> = {}): Brief => ({
  kind: 'market',
  nouns: [
    { value: 'Bertrandite', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } },
    { value: 'Hurston Ring', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } },
  ],
  figures: [{ value: '380', source: { kind: 'market', station: 'Hurston Ring', observedAt: 'x' } }],
  tokens: {},
  subjectKey: 'price:bertrandite@hurston ring',
  summary: 'Bertrandite at Hurston Ring down 380',
  ...over,
});

const req = (over: Partial<SceneRequest> = {}): SceneRequest => ({
  channel: 'LOCAL',
  func: 'complicate',
  act: 'QUIET',
  brief: marketBrief(),
  speakers: ['hauler', 'hauler2'],
  speakerNames: { hauler: 'Marla Brandt', hauler2: 'Otto Petrov' },
  ...over,
});

// ---------------------------------------------------------------------------
// The prompt
// ---------------------------------------------------------------------------

test('the prompt states the fact fence explicitly', () => {
  const chat = buildSceneChat(req());
  const user = chat[1].content;
  assert.match(user, /Bertrandite/);
  assert.match(user, /Hurston Ring/);
  assert.match(user, /380/);
  assert.match(user, /names:/);
  assert.match(user, /numbers:/);
  // The fence is framed as a limit, not a word bank — a small model handed a
  // list of nouns splices them into sentences instead of writing dialogue.
  assert.match(user, /you need not use any of it/);
});

test('fiction mode softens the fence wording', () => {
  const chat = buildSceneChat(req({ allowFiction: true }));
  const user = chat[1].content;
  assert.match(user, /FACTS YOU CAN USE/i);
  assert.match(user, /invention is allowed/i);
  assert.doesNotMatch(user, /you may not name anything outside this/i);
});

test('an empty brief tells the model to name nothing', () => {
  const chat = buildSceneChat(req({ brief: textureBrief('t') }));
  assert.match(chat[1].content, /name nothing/);
  assert.match(chat[1].content, /state no numbers/);
});

test('the prompt names the speakers it expects', () => {
  const chat = buildSceneChat(req());
  assert.match(chat[1].content, /hauler: Marla Brandt/);
  assert.match(chat[1].content, /hauler2: Otto Petrov/);
});

test('the channel changes the register the model is asked for', () => {
  const station = buildSceneChat(req({ channel: 'STATION' }))[0].content;
  const crew = buildSceneChat(req({ channel: 'CREW' }))[0].content;
  assert.notEqual(station, crew);
  assert.match(station, /traffic control/i);
  assert.match(crew, /intercom/i);
});

test('a stale brief instructs the model to hedge', () => {
  const chat = buildSceneChat(
    req({ brief: marketBrief({ ageMs: FRESH_MAX_MS + 3 * 86_400_000 }) }),
  );
  assert.match(chat[1].content, /this information is OLD/);
  assert.match(chat[1].content, /last I looked/);
});

test('a fresh brief does not tell the model to hedge', () => {
  assert.ok(!/this information is OLD/.test(buildSceneChat(req()) [1].content));
});

test('the situation varies the ask, not just the temperature', () => {
  // Without this, every STATION/texture request is byte-identical input and a
  // model returns its favourite answer however hot the sampling is.
  const a = buildSceneChat(req({ situation: 'a pad reassignment nobody is happy about' }));
  const b = buildSceneChat(req({ situation: 'a customs check' }));
  assert.match(a[1].content, /WHAT IS HAPPENING: a pad reassignment/);
  assert.notEqual(a[1].content, b[1].content);
});

test('prior transmissions ride in as conversation turns', () => {
  // The model's own mechanism for not repeating itself is its transcript.
  const convo = new ChatterConversation();
  convo.record('LOCAL', 'a complaint', 'They have taken another 380 off it.');
  const chat = buildSceneChat(req(), convo.history());

  assert.equal(chat[0].role, 'system');
  assert.equal(chat[1].role, 'user', 'history must open on a user turn');
  assert.equal(chat[2].role, 'assistant');
  assert.match(chat[2].content, /380 off it/);
  assert.equal(chat[chat.length - 1].role, 'user', 'the new request comes last');
  assert.match(chat[0].content, /already written this session/i);
});

test('the transcript trims on exchange boundaries, never mid-pair', () => {
  const convo = new ChatterConversation(120);
  for (let i = 0; i < 40; i++) {
    convo.record('LOCAL', `situation ${i}`, `A reasonably long line of dialogue number ${i}.`);
  }
  const h = convo.history();
  assert.ok(h.length >= 2, 'something must survive');
  assert.equal(h.length % 2, 0, 'turns must stay paired');
  assert.equal(h[0].role, 'user', 'history must never open on an assistant reply');
});

test('the transcript survives a restart', () => {
  const a = new ChatterConversation();
  a.record('STATION', 'a delay', 'Hold at the marker.');
  const b = new ChatterConversation();
  b.load(JSON.parse(JSON.stringify(a.toJSON())));
  assert.deepEqual(b.history(), a.history());
});

test('loading garbage into the transcript is survivable', () => {
  const c = new ChatterConversation();
  assert.doesNotThrow(() => c.load(null));
  assert.doesNotThrow(() => c.load('nope'));
  assert.doesNotThrow(() => c.load([{ role: 'system', content: 'x' }, null, 42]));
  assert.deepEqual(c.history(), []);
});

test('every channel has situations to draw on', () => {
  for (const ch of Object.keys(SITUATIONS)) {
    assert.ok(SITUATIONS[ch as keyof typeof SITUATIONS].length >= 3, `${ch} is thin`);
  }
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('well-formed turns parse', () => {
  const turns = parseSceneReply(
    '[hauler] They have taken 380 off Bertrandite.\n[hauler2] Third time this month.',
    ['hauler', 'hauler2'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'hauler');
  assert.equal(turns[1].text, 'Third time this month.');
});

test('markdown bullets and stray punctuation are tolerated', () => {
  const turns = parseSceneReply(
    '- [hauler]: "One."\n* {hauler2} Two.\n(hauler) Three.',
    ['hauler', 'hauler2'],
  );
  assert.equal(turns.length, 3);
  assert.equal(turns[0].text, 'One.', 'surrounding quotes should be stripped');
});

test('unknown speakers are dropped rather than guessed at', () => {
  const turns = parseSceneReply('[narrator] Space is vast.\n[hauler] One.', ['hauler']);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speakerRef, 'hauler');
});

test('preamble lines are ignored', () => {
  const turns = parseSceneReply(
    "Here is the scene you asked for:\n\n[hauler] One.\n[hauler2] Two.",
    ['hauler', 'hauler2'],
  );
  assert.equal(turns.length, 2);
});

test('parsing stops at the turn cap', () => {
  const many = Array.from({ length: 9 }, (_, i) => `[hauler${i % 2 === 0 ? '' : '2'}] Line ${i}.`);
  assert.ok(parseSceneReply(many.join('\n'), ['hauler', 'hauler2']).length <= 4);
});

test('an empty reply parses to nothing', () => {
  assert.deepEqual(parseSceneReply('', ['hauler']), []);
  assert.deepEqual(parseSceneReply('I cannot help with that.', ['hauler']), []);
});

// ---------------------------------------------------------------------------
// Acceptance — the gate before synthesis
// ---------------------------------------------------------------------------

test('a grounded reply is accepted', () => {
  const out = acceptSceneReply(
    '[hauler] They have taken 380 off Bertrandite at Hurston Ring.\n[hauler2] Third time this month.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.scene.tier, 'llm');
});

test('a reply naming an unbriefed faction is rejected whole', () => {
  const out = acceptSceneReply(
    '[hauler] They took 380 off Bertrandite at Hurston Ring.\n[hauler2] The Sirius Corporation again.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'unverified');
  assert.ok(!out.ok && out.why === 'unverified' && out.offending.some((o) => /Sirius/.test(o)));
});

test('a reply stating an unbriefed figure is rejected whole', () => {
  const out = acceptSceneReply(
    '[hauler] They took 9000 off Bertrandite.\n[hauler2] Brutal.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'unverified');
});

test('fiction mode accepts a reply that would fail strict verification', () => {
  const out = acceptSceneReply(
    '[hauler] They took 9000 off Bertrandite.\n[hauler2] Brutal.',
    req({ allowFiction: true }),
    'id',
    60_000,
    undefined,
    { verifyAgainstBrief: false },
  );
  assert.equal(out.ok, true);
});

test('rejection discards the ENTIRE scene, not the offending line', () => {
  // Editing out one turn would leave a scene written to lead somewhere it no
  // longer goes. The contract is not negotiable.
  const out = acceptSceneReply(
    '[hauler] They took 380 off Bertrandite at Hurston Ring.\n[hauler2] The Sirius Corporation again.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, false);
  assert.ok(!('scene' in out));
});

test('a reply with no usable turns is rejected', () => {
  const out = acceptSceneReply('Sorry, I cannot do that.', req(), 'id', 60_000);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'no-turns');
});

test('a structurally invalid reply is rejected before verification', () => {
  const out = acceptSceneReply(
    '[hauler] One.\n[hauler] Two.',
    req({ speakers: ['hauler'] }),
    'id',
    60_000,
  );
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'invalid');
});

test('an invented speaker with a true fact is accepted', () => {
  const b = marketBrief({
    nouns: [...marketBrief().nouns, { value: 'Marla Brandt', source: { kind: 'cast' } }],
  });
  const out = acceptSceneReply(
    '[hauler] Marla Brandt here. 380 off Bertrandite at Hurston Ring.\n[hauler2] Noted.',
    req({ brief: b }),
    'id',
    60_000,
  );
  assert.equal(out.ok, true, `rejected: ${JSON.stringify(out)}`);
});

// ---------------------------------------------------------------------------
// Pre-rendering
// ---------------------------------------------------------------------------

const scene = (): Scene => ({
  id: 's',
  channel: 'STATION',
  func: 'establish',
  turns: [{ speakerRef: 'control', text: 'Cleared to pad.' }],
  brief: textureBrief('arrival'),
  ttlMs: 60_000,
  tier: 'llm',
});

test('a reserved slot is not requested twice', () => {
  const s = new SceneSlots();
  assert.equal(s.has('arrival:Kepler'), false);
  s.reserve('arrival:Kepler', NOW + 60_000);
  assert.equal(s.has('arrival:Kepler'), true);
});

test('a scene ready in time is taken at its moment', () => {
  const s = new SceneSlots();
  s.reserve('arrival:Kepler', NOW + 60_000);
  assert.equal(s.fulfil('arrival:Kepler', scene(), NOW + 10_000), true);
  assert.ok(s.take('arrival:Kepler', NOW + 20_000));
});

test('a scene generated after its moment is discarded, not stored', () => {
  const s = new SceneSlots();
  s.reserve('arrival:Kepler', NOW + 60_000);
  assert.equal(
    s.fulfil('arrival:Kepler', scene(), NOW + 61_000),
    false,
    'a docking exchange written after docking is litter',
  );
  assert.equal(s.take('arrival:Kepler', NOW + 61_000), null);
});

test('a slot still generating yields nothing — the caller falls back', () => {
  const s = new SceneSlots();
  s.reserve('arrival:Kepler', NOW + 60_000);
  assert.equal(s.take('arrival:Kepler', NOW + 1_000), null);
});

test('a failed generation frees the slot so it can be retried', () => {
  const s = new SceneSlots();
  s.reserve('arrival:Kepler', NOW + 60_000);
  s.fulfil('arrival:Kepler', null, NOW + 1_000);
  assert.equal(s.has('arrival:Kepler'), false);
});

test('taking a slot consumes it', () => {
  const s = new SceneSlots();
  s.reserve('k', NOW + 60_000);
  s.fulfil('k', scene(), NOW);
  assert.ok(s.take('k', NOW + 1));
  assert.equal(s.take('k', NOW + 2), null, 'a scene is transmitted once');
});

test('taking a scene past its moment yields nothing', () => {
  const s = new SceneSlots();
  s.reserve('k', NOW + 10_000);
  s.fulfil('k', scene(), NOW);
  assert.equal(s.take('k', NOW + 10_001), null);
});

test('sweeping clears slots whose moment has passed', () => {
  const s = new SceneSlots();
  s.reserve('a', NOW + 1_000);
  s.reserve('b', NOW + 100_000);
  assert.equal(s.sweep(NOW + 5_000), 1);
  assert.equal(s.size, 1);
});

test('fulfilling an unreserved slot is a no-op', () => {
  assert.equal(new SceneSlots().fulfil('never-reserved', scene(), NOW), false);
});

// ---------------------------------------------------------------------------
// Parsing what models actually return
// ---------------------------------------------------------------------------

test('a bare speaker prefix parses — models drop the brackets', () => {
  // Measured against a local gemma-4-e4b: brackets were omitted on roughly
  // three replies in four. Insisting on them threw away most of the model's
  // perfectly good output and reported it as "wrote nothing parseable".
  const turns = parseSceneReply(
    'control The pad reassignment is confirmed.\nhauler Understood.',
    ['control', 'hauler'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'control');
  assert.equal(turns[0].text, 'The pad reassignment is confirmed.');
});

test('a bare prefix with a colon parses', () => {
  const turns = parseSceneReply('control: Hold at the marker.', ['control', 'hauler']);
  assert.equal(turns[0]?.text, 'Hold at the marker.');
});

test('speaker refs containing a colon still work bare', () => {
  const turns = parseSceneReply(
    'crew:ops Everyone is accounted for.\ncrew:engineering Then I will start the list.',
    ['crew:ops', 'crew:engineering'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[1].speakerRef, 'crew:engineering');
});

test('markdown bold around a speaker is tolerated', () => {
  const turns = parseSceneReply('**control** Hold.\n**hauler** Holding.', ['control', 'hauler']);
  assert.equal(turns.length, 2);
});

test('case differences in the speaker label are tolerated', () => {
  const turns = parseSceneReply('[Control] Hold.\n[HAULER] Holding.', ['control', 'hauler']);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'control', 'the canonical ref is what comes back');
});

test('a bare line that is not a known speaker is still ignored', () => {
  // Tolerance must not become "treat any prose as a turn".
  assert.deepEqual(parseSceneReply('Space is vast and full of wonder.', ['control']), []);
  assert.deepEqual(parseSceneReply('narrator Something happened.', ['control']), []);
});

test('the prompt carries a worked example', () => {
  // A small model with thinking disabled follows a demonstrated shape far more
  // reliably than a described one.
  const chat = buildSceneChat(req());
  assert.match(chat[0].content, /\[control\] Hold at the marker/);
  assert.match(chat[0].content, /names nothing and is still worth overhearing/);
});

test('an entire exchange on ONE line still parses as two turns', () => {
  // Observed from a live gemma-4-e4b. A line-based parser swallows the second
  // label into the first turn's text, and the verifier then flags the stray
  // capital as an unlicensed name and drops a perfectly good scene.
  const turns = parseSceneReply(
    '[crew:ops] The beacon signal is stable enough. [crew:engineering] Barely. Watch the angle.',
    ['crew:ops', 'crew:engineering'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'The beacon signal is stable enough.');
  assert.equal(turns[1].text, 'Barely. Watch the angle.');
  assert.ok(!turns[0].text.includes('crew:engineering'), 'the label must not leak into the text');
});

test('a label in the middle of a line does not corrupt the turn before it', () => {
  const turns = parseSceneReply('[control] Hold. [hauler] Holding.', ['control', 'hauler']);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['Hold.', 'Holding.'],
  );
});

test('a leading colon after a bracketed label is stripped', () => {
  const turns = parseSceneReply('[control]: Hold at the marker.', ['control']);
  assert.equal(turns[0].text, 'Hold at the marker.');
});

test('a shortened or named speaker label still resolves', () => {
  // Observed live: asked for `crew:ops` the model answered `[ops]`, and asked
  // for `crew:engineering` — shown as "Halloran" — it answered `[Halloran]`.
  // Both are reasonable readings of the roster it was handed.
  const turns = parseSceneReply(
    '[ops] Quiet now. Too quiet.\n[Halloran] The drive is steady.',
    ['crew:ops', 'crew:engineering'],
    { 'crew:ops': 'Okonjo', 'crew:engineering': 'Halloran' },
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'crew:ops');
  assert.equal(turns[1].speakerRef, 'crew:engineering');
});

test('a first name resolves to its speaker', () => {
  const turns = parseSceneReply('[Priya] On approach.', ['hauler'], { hauler: 'Priya Achebe' });
  assert.equal(turns[0]?.speakerRef, 'hauler');
});

test('the longest matching label wins', () => {
  // `crew:ops` must not be shadowed by the `ops` alias.
  const turns = parseSceneReply(
    '[crew:ops] Mine.\n[crew:engineering] Also mine.',
    ['crew:ops', 'crew:engineering'],
  );
  assert.deepEqual(turns.map((t) => t.speakerRef), ['crew:ops', 'crew:engineering']);
});
