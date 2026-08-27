/**
 * The LLM tier: prompt, parse, and the pre-render slots.
 *
 * The assertion that carries the most weight is that a non-empty reply always
 * yields a playable scene. The tier this replaces asked the model for a
 * `[speakerRef]` tag on every line and discarded anything it could not map, and
 * that contract failed in a way no single test would have caught: accepted
 * output was replayed into the model's own transcript with the tags stripped,
 * the model learned the house style had no tags, and every subsequent reply
 * parsed to nothing. So the tests here pin BOTH halves — that the parser needs
 * no tags, and that what gets recorded is the shape the prompt asks for.
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
import { sceneTranscript, type Scene } from '../src/engine/chatter/scenes.ts';

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

test('no channel, act or function reintroduces a fence', () => {
  // The fence cost roughly nine scenes in ten and caught fabrications that were
  // never doing any harm. Nothing downstream reads comms, so there is nothing to
  // protect — this asserts the whole vocabulary of restriction is gone, on every
  // combination, not just the one the last edit happened to look at.
  const channels = ['STATION', 'LOCAL', 'CREW', 'DEEP', 'EMERGENCY', 'CARRIER', 'CONCOURSE'] as const;
  const funcs = ['establish', 'complicate', 'reverse', 'aftermath', 'texture'] as const;
  const acts = ['QUIET', 'BUILDING', 'CRISIS', 'AFTERMATH'] as const;

  for (const channel of channels) {
    for (const func of funcs) {
      for (const act of acts) {
        const all = buildSceneChat(req({ channel, func, act })).map((m) => m.content).join('\n');
        const where = `${channel}/${func}/${act}`;
        assert.doesNotMatch(all, /may not name/i, where);
        assert.doesNotMatch(all, /THE FENCE/i, where);
        assert.doesNotMatch(all, /^\s*names:/im, where);
        assert.doesNotMatch(all, /^\s*numbers:/im, where);
        assert.doesNotMatch(all, /never invent/i, where);
        assert.doesNotMatch(all, /STRICT grounding/i, where);
        assert.doesNotMatch(all, /name nothing outside/i, where);
        assert.doesNotMatch(all, /that appear in the provided facts/i, where);
        // The anti-name-dropping STYLE rule must survive — it is about not
        // reciting facts like labels, not a restriction on what may be named.
        // Matched loosely on purpose: this pins the rule, not its wording.
        assert.match(all, /name nothing at all|no proper noun at all/i, where);
      }
    }
  }
});

test('the prompt tells the model to build the scene on the briefing', () => {
  // Supplying the dossier is not enough. Measured against a live engine over
  // real journals: briefing present but no instruction to use it, 2 scenes in 9
  // touched it; with this line, 9 in 9. Without it the tier reverts to ambience
  // that would fit any system, which the system prompt calls failure and does
  // not prevent on its own.
  const user = buildSceneChat(req())[1].content;
  const at = user.search(/ANCHOR IT|GROUND THE SCENE/i);
  assert.ok(at >= 0, 'the prompt must tell the model to build on the briefing');
  // It belongs in the trailing instructions, after the material it refers to —
  // the last thing read is the thing obeyed. Pinned against the setup sections
  // rather than a character ratio: the block itself is long, so "where it
  // starts" as a fraction of the prompt measures its length, not its position.
  assert.ok(
    at > user.search(/WHO IS SPEAKING/i),
    'the grounding instruction must come after the setup, not before it',
  );
  assert.ok(
    user.slice(at).length < user.length * 0.75,
    'it must not be the whole back half of the prompt',
  );
});

test('the prompt tells the model it may invent', () => {
  const all = buildSceneChat(req()).map((m) => m.content).join('\n');
  assert.match(all, /invent/i);
});

test('the dossier rides in as background, not as a permission list', () => {
  const dossier = 'System: Kaine — Low security, Democracy\nStations: Wood’s Pride';
  const user = buildSceneChat(req({ dossier }))[1].content;
  assert.match(user, /Wood’s Pride/);
  assert.match(user, /the world these people live in/i);
});

test('with no dossier the brief summary still sets the scene', () => {
  const user = buildSceneChat(req({ dossier: undefined }))[1].content;
  assert.match(user, /Bertrandite at Hurston Ring/);
});

test('the prompt names the speakers, in the order lines will be assigned', () => {
  const user = buildSceneChat(req())[1].content;
  assert.match(user, /1\. Marla Brandt/);
  assert.match(user, /2\. Otto Petrov/);
  // The model is told the order matters, because that IS the speaker protocol.
  // Matched loosely: the wording changed once already (to add "names are for
  // YOU, not for the lines") and the contract is order-attribution, not prose.
  assert.match(user, /in this order|line 1 is spoken by the first/i);
});

test('the prompt asks for bare lines and never demonstrates a tag', () => {
  // The invariant the parser depends on: one utterance per line, no speaker
  // labels. The exact phrasing is the author's business — a worked [tag]
  // example is not, because the model copies demonstrated shapes and the
  // transcript then teaches it the same shape back.
  const system = buildSceneChat(req())[0].content;
  assert.match(system, /per line/i);
  assert.match(system, /only the spoken words|no labels|no speaker names/i);
  assert.doesNotMatch(system, /\[speakerRef\]/i);
  assert.doesNotMatch(system, /\[control\]|\[hauler\]/i);
});

test('the prompt asks for live conversational back-and-forth', () => {
  const system = buildSceneChat(req())[0].content;
  assert.match(system, /react in real time/i);
  assert.match(system, /contractions/i);

  const user = buildSceneChat(req())[1].content;
  assert.match(user, /live back-and-forth/i);
  assert.match(user, /not read like separate mini-monologues/i);
});

test('the line count asked for follows the roster', () => {
  assert.match(buildSceneChat(req({ speakers: ['hauler'] }))[0].content, /exactly 1 line\b/);
  assert.match(buildSceneChat(req())[0].content, /exactly 2 lines\b/);
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
  // The situation must REACH the model — under whatever heading. Dropping it
  // silently would make the store's least-recently-used rotation a no-op and
  // hand the model byte-identical input for every texture beat on a channel.
  assert.match(a[1].content, /a pad reassignment nobody is happy about/);
  assert.match(b[1].content, /a customs check/);
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

test('what goes into the transcript is what the prompt asks for', () => {
  // The bug this whole tier was rewritten around. The transcript is replayed to
  // the model as its OWN prior output, so if it is recorded in a shape the
  // prompt never asked for, the model imitates the recorded shape and drifts off
  // contract. Because rejected scenes are never recorded, that drift is one-way
  // and permanent. Round-tripping the recorded text back through the parser is
  // the check: whatever we store must still parse as a scene.
  const out = acceptSceneReply('Hold at the marker.\nHolding. Again.', req(), 'id', 60_000);
  assert.equal(out.ok, true);

  const recorded = sceneTranscript((out as { ok: true; scene: Scene }).scene);
  assert.doesNotMatch(recorded, /[[\]]/, 'no speaker tags may reach the transcript');
  assert.equal(recorded, 'Hold at the marker.\nHolding. Again.');

  const reparsed = parseSceneReply(recorded, ['hauler', 'hauler2']);
  assert.equal(reparsed.length, 2, 'the recorded shape must still parse');
  assert.deepEqual(
    reparsed.map((t) => t.text),
    ['Hold at the marker.', 'Holding. Again.'],
  );
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
  // The 2026-08-25 expansion took the table well past a hundred situations —
  // the floor pins that nobody quietly trims it back to five conversations.
  const total = Object.values(SITUATIONS).reduce((n, xs) => n + xs.length, 0);
  assert.ok(total >= 150, `the situation table has thinned: ${total}`);
  for (const ch of Object.keys(SITUATIONS)) {
    assert.ok(SITUATIONS[ch as keyof typeof SITUATIONS].length >= 12, `${ch} is thin`);
  }
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a scene can ask for more lines than speakers — radio runs past two turns', () => {
  const chat = buildSceneChat({
    channel: 'STATION',
    func: 'texture',
    act: 'QUIET',
    brief: textureBrief('t'),
    speakers: ['control', 'ship'],
    speakerNames: { control: 'Traffic Control', ship: 'Inbound Traffic' },
    lines: 4,
  });
  const user = chat.at(-1)!.content;
  assert.match(user, /Write the 4 lines now/);
  const system = chat[0].content;
  assert.match(system, /exactly 4 lines/);
});

test('plain lines parse, one turn each', () => {
  const turns = parseSceneReply(
    'They have taken 380 off Bertrandite.\nThird time this month.',
    ['hauler', 'hauler2'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'hauler');
  assert.equal(turns[1].text, 'Third time this month.');
});

test('speakers come from position, wrapping past the end of the roster', () => {
  const turns = parseSceneReply('One.\nTwo.\nThree.', ['hauler', 'hauler2']);
  assert.deepEqual(
    turns.map((t) => t.speakerRef),
    ['hauler', 'hauler2', 'hauler'],
  );
});

test('a single line is a single turn', () => {
  const turns = parseSceneReply('Hold at the marker.', ['control', 'ship']);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].speakerRef, 'control');
});

test('speech-verb narration is stripped, the quoted dialogue kept', () => {
  // Observed in one prompt-tuning round: the model novelising its own radio.
  const turns = parseSceneReply(
    'Control says, "Pad four has been held ten minutes too long."\n' +
      'Ship replies, "Transfer fee talks are still going."',
    ['control', 'ship'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'Pad four has been held ten minutes too long.');
  assert.equal(turns[1].text, 'Transfer fee talks are still going.');
});

test('curly wrapping quotes come off like straight ones', () => {
  const turns = parseSceneReply('“Fiore, we’re holding departure clearance.”', ['carrier']);
  assert.equal(turns[0].text, 'Fiore, we’re holding departure clearance.');
});

test('single-asterisk emphasis comes off invented ship names', () => {
  const turns = parseSceneReply('Copy that, *Wanderlust*; hold pattern three.', ['control']);
  assert.equal(turns[0].text, 'Copy that, Wanderlust; hold pattern three.');
});

test('second-person narration is not a turn', () => {
  // "You hear a faint beep under the chatter" is scene description aimed at
  // the listener, not speech on a channel — observed once in style testing.
  const turns = parseSceneReply(
    'You hear a faint, repetitive beep under the comms chatter.\nCycle the proximity alerts before the thoroughfare.',
    ['pa', 'traveller'],
  );
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /proximity alerts/);
  // Speech ABOUT what somebody heard is still speech.
  const fine = parseSceneReply('Did you hear that beep on the lower deck?', ['crew:ops']);
  assert.equal(fine.length, 1);
});

test('a bare script label is not a turn', () => {
  // "Line 1:" spoken aloud as dialogue shunted every later line onto the
  // wrong speaker — the label is dropped, the dialogue keeps its seats.
  const turns = parseSceneReply(
    'Line 1:\nAll outbound traffic is delayed.\nLine 2:\nI was told it was only the haulers.',
    ['pa', 'traveller'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].speakerRef, 'pa');
  assert.match(turns[0].text, /outbound traffic/);
  assert.equal(turns[1].speakerRef, 'traveller');
});

test('a degeneration loop is rejected, honest repetition is not', () => {
  // Verbatim shape from a candidate model on the bench: one clause repeated
  // until the token budget ran out, and every existing guard passed it.
  const stuck =
    'I have been doing the work. ' +
    Array.from({ length: 20 }, () => "I've been doing the whole thing.").join(' ');
  const req = {
    channel: 'CREW', func: 'texture', act: 'QUIET',
    brief: { kind: 'texture', nouns: [], figures: [], tokens: {}, ageMs: 0, subjectKey: 't', summary: 'atmosphere' },
    speakers: ['crew:ops', 'crew:engineering'],
    speakerNames: { 'crew:ops': 'Ops', 'crew:engineering': 'Engineering' },
  } as unknown as Parameters<typeof acceptSceneReply>[1];
  const out = acceptSceneReply(`Get the ship back to the warehouse.\n${stuck}`, req, 'x', 60_000);
  assert.equal(out.ok, false);
  if (!out.ok) assert.match(String(out.why === 'invalid' ? out.detail : out.why), /degenerate/);
  // Saying a thing twice for effect is speech, not a stuck record.
  const fine = acceptSceneReply(
    'Hold the pad. Hold the pad, I said — they are two minutes out.\nCopy that, holding.',
    req, 'y', 60_000,
  );
  assert.equal(fine.ok, true);
});

test('a mid-sentence speech verb does not eat the line', () => {
  const turns = parseSceneReply('Tell them what control says, and mean it.', ['hauler', 'hauler2']);
  assert.equal(turns[0].text, 'Tell them what control says, and mean it.');
});

test('parsing stops at the turn cap', () => {
  const many = Array.from({ length: 9 }, (_, i) => `Line ${i}.`);
  assert.equal(parseSceneReply(many.join('\n'), ['hauler', 'hauler2']).length, 4);
});

test('blank lines between turns are not turns', () => {
  const turns = parseSceneReply('One.\n\n\nTwo.\n', ['hauler', 'hauler2']);
  assert.equal(turns.length, 2);
});

test('an empty reply parses to nothing', () => {
  assert.deepEqual(parseSceneReply('', ['hauler']), []);
  assert.deepEqual(parseSceneReply('   \n\n  ', ['hauler']), []);
});

test('a reply that is only markup parses to nothing', () => {
  assert.deepEqual(parseSceneReply('- \n**\n[]', ['hauler']), []);
});

test('an empty roster yields nothing rather than throwing', () => {
  assert.deepEqual(parseSceneReply('One.', []), []);
});

// ---------------------------------------------------------------------------
// Acceptance — the gate before synthesis
// ---------------------------------------------------------------------------

test('a plain reply is accepted', () => {
  const out = acceptSceneReply(
    'They have taken 380 off Bertrandite at Hurston Ring.\nThird time this month.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, true);
  assert.equal(out.ok && out.scene.tier, 'llm');
});

test('a reply naming an unbriefed faction is accepted', () => {
  const out = acceptSceneReply(
    'They took 380 off Bertrandite at Hurston Ring.\nThe Sirius Corporation again.',
    req(),
    'id',
    60_000,
  );
  assert.equal(out.ok, true, 'comms invents by design — nothing downstream reads it');
});

test('a reply stating an unbriefed figure is accepted', () => {
  const out = acceptSceneReply('They took 9000 off it.\nBrutal.', req(), 'id', 60_000);
  assert.equal(out.ok, true);
});

test('an entirely invented scene is accepted', () => {
  // Nothing in this reply appears in the brief. Under the old fence every noun
  // and figure here was grounds for discarding the whole scene.
  const out = acceptSceneReply(
    'Kepler Landing says the Iron Marlin is four hours late again.\nThat is Vance for you.',
    req({ brief: textureBrief('t') }),
    'id',
    60_000,
  );
  assert.equal(out.ok, true, `rejected: ${JSON.stringify(out)}`);
});

test('a reply with no usable turns is rejected', () => {
  const out = acceptSceneReply('   ', req(), 'id', 60_000);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'no-turns');
  assert.ok(!('scene' in out));
});

test('the two rejection reasons the writer can produce stay distinct', () => {
  // The panel tallies drops by reason, and the whole value of that tally is
  // that the reasons do not collapse into each other — a writer that cannot
  // parse and one that emits a broken token want opposite fixes.
  const empty = acceptSceneReply('', req(), 'id', 60_000);
  const broken = acceptSceneReply('Cleared to pad <padnum>.', req(), 'id', 60_000);
  assert.equal(!empty.ok && empty.why, 'no-turns');
  assert.equal(!broken.ok && broken.why, 'invalid');
  assert.notEqual(!empty.ok && empty.why, !broken.ok && broken.why);
});

test('an unbound template token is still rejected', () => {
  // The one structural check that genuinely protects immersion: a scene spoken
  // with literal angle brackets in it is the worst thing this feature can do.
  const out = acceptSceneReply('Cleared to pad <padnum>.\nOn approach.', req(), 'id', 60_000);
  assert.equal(out.ok, false);
  assert.equal(!out.ok && out.why, 'invalid');
});

test('prose the model refuses with is still a scene, not a rejection', () => {
  // Deliberate. Under the old parser "I cannot help with that." mapped to no
  // known speaker and vanished; now it becomes one turn and the structural
  // checks pass. This is the accepted cost of never dropping real dialogue —
  // and in practice the prompt does not trip refusals.
  const out = acceptSceneReply('I cannot help with that.', req(), 'id', 60_000);
  assert.equal(out.ok, true);
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

// Everything below is markup the model VOLUNTEERS out of screenplay habit. None
// of it is trusted — the speaker is always positional — it is simply removed so
// it is never spoken aloud.

test('a volunteered bracket tag is stripped, not obeyed', () => {
  const turns = parseSceneReply(
    '[control] The pad reassignment is confirmed.\n[hauler] Understood.',
    ['control', 'hauler'],
  );
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'The pad reassignment is confirmed.');
  assert.equal(turns[1].text, 'Understood.');
});

test('a tag naming the WRONG speaker does not move the line', () => {
  // The tag is ornament. Position decides, so a model that mislabels its own
  // lines cannot scramble the cast.
  const turns = parseSceneReply('[hauler] Hold.\n[control] Holding.', ['control', 'hauler']);
  assert.deepEqual(
    turns.map((t) => t.speakerRef),
    ['control', 'hauler'],
  );
});

test('ordered-list numbering never reaches the air', () => {
  // Straight from a live panel. Asking for "exactly 2 lines" invites numbering,
  // and the number blocked the name strip as well — both the index and the
  // speaker's own name were being spoken next to the name already on screen.
  const turns = parseSceneReply(
    '1. HIP 71120: The Explorer on Tour is pushing the expansion too quickly.\n' +
      '2. Dmitri Sarkis: The committee is demanding faster expansion.',
    ['control', 'ship'],
  );
  assert.deepEqual(
    turns.map((t) => t.text),
    [
      'The Explorer on Tour is pushing the expansion too quickly.',
      'The committee is demanding faster expansion.',
    ],
  );
  assert.deepEqual(
    turns.map((t) => t.speakerRef),
    ['control', 'ship'],
  );
});

test('numbering in other shapes is stripped too', () => {
  const turns = parseSceneReply('1) Hold at the marker.\n2] Holding.', ['control', 'ship']);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['Hold at the marker.', 'Holding.'],
  );
});

test('a number that is part of the line survives', () => {
  // "957 ls out" must not lose its figure to the numbering strip. The rule
  // needs a delimiter and a space, which ordinary speech does not have.
  const turns = parseSceneReply('957 ls out and climbing.\n40 tonnes short.', ['a', 'b']);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['957 ls out and climbing.', '40 tonnes short.'],
  );
});

test('a volunteered name prefix is stripped', () => {
  const turns = parseSceneReply(
    'Yusuf Fiore: Holding. Again.\nControl: Acknowledged.',
    ['hauler', 'control'],
  );
  assert.equal(turns[0].text, 'Holding. Again.');
  assert.equal(turns[1].text, 'Acknowledged.');
});

test('a colon inside real dialogue survives', () => {
  // The prefix strip is capped at four words, or "Told you: it never works"
  // loses half its line.
  const turns = parseSceneReply(
    'I told you last week and I will say it again: it never works.',
    ['hauler'],
  );
  assert.match(turns[0].text, /^I told you last week/);
});

test('bullets, dashes and emphasis are stripped', () => {
  const turns = parseSceneReply('- **Pad four is gone.**\n* Take seven.\n> Understood.', [
    'control',
    'ship',
  ]);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['Pad four is gone.', 'Take seven.', 'Understood.'],
  );
});

test('quotes wrapping a whole line are stripped', () => {
  const turns = parseSceneReply('"One."\n\'Two.\'', ['hauler', 'hauler2']);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['One.', 'Two.'],
  );
});

test('a quoted phrase inside a line is left alone', () => {
  const turns = parseSceneReply('He said "clear" and then went quiet.', ['hauler']);
  assert.equal(turns[0].text, 'He said "clear" and then went quiet.');
});

test('a bracketed tag and a colon together are both stripped', () => {
  const turns = parseSceneReply('[control]: Hold at the marker.', ['control']);
  assert.equal(turns[0].text, 'Hold at the marker.');
});

test('curly and round tags are stripped like square ones', () => {
  const turns = parseSceneReply('{hauler} One.\n(hauler2) Two.', ['hauler', 'hauler2']);
  assert.deepEqual(
    turns.map((t) => t.text),
    ['One.', 'Two.'],
  );
});

test('unstructured prose is a turn, not a rejection', () => {
  // This is the regression that mattered. Untagged prose is exactly what the
  // model produced once its own transcript had taught it the house style, and
  // the old parser mapped every line of it to nothing.
  const turns = parseSceneReply(
    'Anyone else hear about the lane closure? Third time this week.',
    ['hauler'],
  );
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /lane closure/);
});

test('a speaker name alone on a line is not a spoken turn', () => {
  // Verbatim shape from a live panel. Screenplay habit, and it survived every
  // other guard because it is not ornament attached to a line — it IS the line.
  // Four lines became four turns, so "HIP 71120" and "Dmitri Sarkis" were
  // spoken aloud beside the very same names already printed next to them.
  const turns = parseSceneReply(
    "HIP 71120\nWood's Pride, you're cleared for departure.\nDmitri Sarkis\nJust be careful.",
    ['control', 'ship'],
    { control: 'HIP 71120', ship: 'Dmitri Sarkis' },
  );
  assert.deepEqual(
    turns.map((t) => t.text),
    ["Wood's Pride, you're cleared for departure.", 'Just be careful.'],
  );
  assert.deepEqual(
    turns.map((t) => t.speakerRef),
    ['control', 'ship'],
  );
});

test('a first name alone on a line goes too', () => {
  const turns = parseSceneReply('Dmitri\nHolding.\nYusuf\nAgain.', ['a', 'b'], {
    a: 'Dmitri Sarkis',
    b: 'Yusuf Fiore',
  });
  assert.deepEqual(turns.map((t) => t.text), ['Holding.', 'Again.']);
});

test('a name used INSIDE a line is left alone', () => {
  // The guard must not eat dialogue that happens to address somebody.
  const turns = parseSceneReply('Dmitri Sarkis, hold at the marker.', ['a', 'b'], {
    a: 'HIP 71120',
    b: 'Dmitri Sarkis',
  });
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Dmitri Sarkis, hold at the marker.');
});

test('two turns merged onto one line split at the known-name boundary', () => {
  // Verbatim shape from the first live scene after the length cap was relaxed:
  // the model ran both turns together with an inline label, and positional
  // assignment glued the second speaker's dialogue into the first turn.
  const turns = parseSceneReply(
    "You're still on the pad? If you don't roll, you're holding the slot for everyone else. " +
      "Inbound Traffic: I'm already in the bay. Wait for my clearance.",
    ['control', 'ship'],
    { control: 'Traffic Control', ship: 'Inbound Traffic' },
  );
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /holding the slot/);
  assert.equal(turns[0].speakerRef, 'control');
  assert.match(turns[1].text, /^I'm already in the bay/);
  assert.equal(turns[1].speakerRef, 'ship');
  assert.doesNotMatch(turns[1].text, /Inbound Traffic/);
});

test('addressing someone by name with a comma does NOT split the line', () => {
  const turns = parseSceneReply(
    'Inbound Traffic, hold at the marker until the lane clears.',
    ['control', 'ship'],
    { control: 'Traffic Control', ship: 'Inbound Traffic' },
  );
  assert.equal(turns.length, 1);
  assert.match(turns[0].text, /^Inbound Traffic, hold/);
});

test('a speaker never says their own name — leading self-name stripped', () => {
  // Verbatim failure from a live panel: "Ines Sarkis: Ines Sarkis, just keep
  // the Henry Beacon clear". The model labels lines with the speaker's own
  // name, comma-style. Position already says whose line it is, so the SELF
  // name is ornament — but only the self name.
  const turns = parseSceneReply(
    'Amara Brandt, stick to the main approach; the Dark Wheel is watching.\n' +
      'Hollis Mbeki, No, cut through Dickens Point instead.',
    ['hauler', 'hauler2'],
    { hauler: 'Amara Brandt', hauler2: 'Hollis Mbeki' },
  );
  assert.match(turns[0].text, /^stick to the main approach/);
  assert.match(turns[1].text, /^No, cut through Dickens Point/);
});

test('a surname alone works as a self-label too', () => {
  const turns = parseSceneReply('Sarkis: the relay is frying my scope.', ['a'], {
    a: 'Ines Sarkis',
  });
  assert.equal(turns[0].text, 'the relay is frying my scope.');
});

test('addressing the OTHER speaker by name is dialogue, never stripped', () => {
  // The collision the position rule resolves: the same comma shape is
  // legitimate when the name is not the speaker's own.
  const turns = parseSceneReply(
    'Kowalczyk, the Lyakhov Horizons signal is bleeding again.\n' +
      "I'm on it, but the relay's been frying my scope.",
    ['crew:ops', 'crew:engineering'],
    { 'crew:ops': 'Ines Sarkis', 'crew:engineering': 'Anna Kowalczyk' },
  );
  assert.match(turns[0].text, /^Kowalczyk, the Lyakhov/);
  assert.equal(turns[0].speakerRef, 'crew:ops');
});

test('the prompt says names are attribution, not dialogue', () => {
  const system = buildSceneChat(req())[0].content;
  assert.match(system, /never says their own name/i);
  const user = buildSceneChat(req())[1].content;
  assert.match(user, /names are for YOU, not for the lines/i);
});
