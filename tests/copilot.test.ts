/** Living copilot — the session conversation: ephemeral beats, clean silence,
 *  event carry-forward, alternation, trim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopilotConversation,
  buildCopilotSystem,
  copilotReactsTo,
  copilotReactionGapMs,
  copilotDensityGapMs,
  copilotSilenceGapMs,
  isNearDuplicate,
} from '../src/engine/copilot.ts';
import { stripFillerTics } from '../src/engine/glance.ts';
import { parseProspectTarget, matchesProspect } from '../src/engine/mining.ts';
import { extractPlaces, findFabricatedPlace } from '../src/engine/factcheck.ts';

test('copilot system prompt carries the persona and the event-stream contract', () => {
  const sys = buildCopilotSystem("M'allock");
  assert.match(sys, /Commander M'allock/);
  assert.match(sys, /NO_BEAT/);
  assert.match(sys, /brevity is the default/); // length distribution — short by default
  assert.match(sys, /Look FORWARD, not back/); // anti-echo: don't restate resolved events
  assert.match(sys, /authoritative ground truth|authoritative/);
  assert.match(sys, /STRICT grounding/); // from GROUNDING_RULES
  assert.match(sys, /only mention\s+fuel when it is explicitly LOW or below 25%/);
  // Partnership-not-narration voice + colour-grounded-in-logs + stay-present.
  assert.match(sys, /What you must NEVER do is NARRATE/);
  assert.match(sys, /Narration in ANY pronoun/);
  assert.match(sys, /never what you talk about/); // the screen-narration ban
  assert.match(sys, /colour must\s+hang on REAL facts/);
  assert.match(sys, /never a reason to fall silent/);
});

test('a beat request is ephemeral — nothing is committed until the operator speaks', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent("EVENT: Undocked from Bolden's Enterprise.");
  cp.recordEvent('EVENT: Entered supercruise.');
  const msgs = cp.messagesForBeat('in supercruise toward Dove Enigma, fuel 78%.', 'SCREEN: a ringed planet.');
  assert.equal(msgs[0].role, 'system');
  const last = msgs[msgs.length - 1];
  assert.equal(last.role, 'user');
  assert.match(last.content as string, /Undocked/);
  assert.match(last.content as string, /Entered supercruise/);
  assert.match(last.content as string, /NOW: in supercruise/);
  assert.match(last.content as string, /ringed planet/);
  // Nothing committed, pending intact — the beat hasn't happened yet.
  assert.equal(cp.transcript().length, 0);
  assert.equal(cp.pendingCount(), 2);
  // Speaking commits the durable EVENTS (not the transient NOW/SCREEN) + the beat.
  cp.recordSpoken("Dove Enigma ahead; those cabins aren't paying for the view.");
  const t = cp.transcript();
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant']);
  assert.match(t[0].content, /Undocked/);
  assert.doesNotMatch(t[0].content, /NOW:/);
  assert.doesNotMatch(t[0].content, /ringed planet/);
  assert.equal(cp.pendingCount(), 0);
});

test('silence leaves NO trace and its events carry forward to the next beat', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: A');
  cp.messagesForBeat('now1', null);
  cp.recordSilent();
  assert.equal(cp.transcript().length, 0); // no NO_BEAT turn — the silence spiral fix
  assert.equal(cp.pendingCount(), 1); // event A still pending
  cp.recordEvent('EVENT: B');
  const msgs = cp.messagesForBeat('now2', null);
  const u = msgs[msgs.length - 1].content as string;
  assert.match(u, /EVENT: A/);
  assert.match(u, /EVENT: B/);
  cp.recordSpoken('Beat.');
  assert.match(cp.transcript()[0].content, /EVENT: A/);
  assert.match(cp.transcript()[0].content, /EVENT: B/);
});

test('committed exchanges alternate; a silent beat folds its events into the next spoken one', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: 1'); cp.messagesForBeat('n1', null); cp.recordSpoken('one');
  cp.recordEvent('EVENT: 2'); cp.messagesForBeat('n2', null); cp.recordSilent();
  cp.recordEvent('EVENT: 3'); cp.messagesForBeat('n3', null); cp.recordSpoken('three');
  const t = cp.transcript();
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(t[1].content, 'one');
  assert.match(t[2].content, /EVENT: 2/); // the silent beat's event survived
  assert.match(t[2].content, /EVENT: 3/);
  assert.equal(t[3].content, 'three');
});

test('isEmpty guards one-time seeding through a silent first beat', () => {
  const cp = new CopilotConversation('SYS');
  assert.equal(cp.isEmpty(), true);
  cp.recordEvent('SESSION STATE: at Sais Starport.');
  assert.equal(cp.isEmpty(), false); // seed pending → would not re-seed
  cp.messagesForBeat('now', null);
  cp.recordSilent();
  assert.equal(cp.isEmpty(), false); // seed still pending after a silent first beat
  assert.equal(cp.pendingCount(), 1);
});

test('stripFillerTics removes the "certainly" crutch grammatically', () => {
  assert.equal(stripFillerTics('The Council certainly knows how to pack a payday.'), 'The Council knows how to pack a payday.');
  assert.equal(stripFillerTics('You certainly make the most of every run.'), 'You make the most of every run.');
  assert.equal(stripFillerTics('That is certainly one way to start.'), 'That is one way to start.');
  assert.equal(stripFillerTics('Nothing to strip here.'), 'Nothing to strip here.');
  // Hedging openers the prompt bans but the model still emits.
  assert.equal(stripFillerTics('Looks like Marigold City is ready for us.'), 'Marigold City is ready for us.');
  assert.equal(stripFillerTics('It seems like the rock is dry.'), 'The rock is dry.');
  assert.equal(stripFillerTics('Sounds like a light payday.'), 'A light payday.');
  // Mid-sentence "like" is untouched — only the opener is a tic.
  assert.equal(stripFillerTics('Feels like home, this ring.'), 'Feels like home, this ring.');
});

test('parseProspectTarget reads a spoken mining goal; matchesProspect flags rocks', () => {
  const t = parseProspectTarget("I'm looking for tritium asteroids with min 20% content");
  assert.deepEqual(t, { commodity: 'Tritium', key: 'tritium', minPct: 20 });
  assert.equal(parseProspectTarget('find me painite over 30%')?.minPct, 30);
  assert.equal(parseProspectTarget('want some low temperature diamonds')?.commodity, 'Low Temperature Diamonds');
  assert.equal(parseProspectTarget('hunting for LTDs')?.key, 'diamond');
  assert.equal(parseProspectTarget('looking for tritium')?.minPct, 15); // sensible default
  // Not a prospecting utterance / unknown commodity → null.
  assert.equal(parseProspectTarget('what should I do right now?'), null);
  assert.equal(parseProspectTarget('looking for a good station'), null);
  // Matching against prospected materials.
  assert.equal(matchesProspect('Tritium', 24, t!), true);
  assert.equal(matchesProspect('Tritium', 12, t!), false); // below the floor
  assert.equal(matchesProspect('Painite', 90, t!), false); // wrong commodity
});

test('density is not a metronome: tense runs speak closer, idle runs stretch out', () => {
  for (const inv of ['low', 'medium', 'high'] as const) {
    const idle = copilotDensityGapMs(inv, 0);
    const mid = copilotDensityGapMs(inv, 0.5);
    const tense = copilotDensityGapMs(inv, 1);
    assert.ok(tense < mid && mid < idle, `${inv}: gap must shrink as pressure rises`);
    // Idle stretches past the base cadence; full pressure collapses well under it.
    assert.ok(idle > copilotReactionGapMs(inv));
    assert.ok(tense < copilotReactionGapMs(inv) / 2);
  }
  // Out-of-range pressure is clamped, never inverted.
  assert.equal(copilotDensityGapMs('medium', 5), copilotDensityGapMs('medium', 1));
  assert.equal(copilotDensityGapMs('medium', -3), copilotDensityGapMs('medium', 0));
});

test('silence gap: a quiet stretch is minutes of nothing, tuned by involvement', () => {
  assert.ok(copilotSilenceGapMs('high') < copilotSilenceGapMs('medium'));
  assert.ok(copilotSilenceGapMs('medium') < copilotSilenceGapMs('low'));
  // Long enough that it never competes with ordinary event reactions.
  for (const inv of ['low', 'medium', 'high'] as const)
    assert.ok(copilotSilenceGapMs(inv) > copilotDensityGapMs(inv, 0));
});

test('the prompt licenses speaking into a quiet stretch', () => {
  const sys = buildCopilotSystem("M'allock");
  assert.match(sys, /QUIET STRETCH/);
  assert.match(sys, /needs no event behind it/);
});

test('fact fence: catches an invented station, passes ones it was told about', () => {
  assert.deepEqual(extractPlaces('Pad eight at Marigold City, then Colonia Hub after.'), ['Marigold City', 'Colonia Hub']);
  const allowed = ['Marigold City', 'Juniper', 'Colonia Hub', 'Whirling Station'];
  // Legit — every place is in the allowed set (callbacks included).
  assert.equal(findFabricatedPlace('Eighty souls into Marigold City.', allowed), null);
  assert.equal(findFabricatedPlace('Those tourists are still waiting at Whirling Station.', allowed), null);
  // No place named at all → nothing to check.
  assert.equal(findFabricatedPlace("That's our best haul yet.", allowed), null);
  // Confident fiction — a station that was never in the facts.
  assert.equal(findFabricatedPlace('They short you on fuel over at Kirk Dock.', allowed), 'Kirk Dock');
  // Loose match both ways — "Colonia" allowed covers "Colonia Hub" mention and vice versa.
  assert.equal(findFabricatedPlace('Docking at Colonia Hub.', ['Colonia']), null);
});

test('involvement tunes which events react and the cadence between beats', () => {
  // mission moments always land; arrivals from medium; travel only when chatty.
  for (const inv of ['low', 'medium', 'high'] as const) assert.equal(copilotReactsTo(inv, 'mission'), true);
  assert.equal(copilotReactsTo('low', 'arrival'), false);
  assert.equal(copilotReactsTo('medium', 'arrival'), true);
  assert.equal(copilotReactsTo('high', 'arrival'), true);
  assert.equal(copilotReactsTo('low', 'travel'), false);
  assert.equal(copilotReactsTo('medium', 'travel'), false);
  assert.equal(copilotReactsTo('high', 'travel'), true);
  // Higher involvement lets it speak more often (shorter gap).
  assert.ok(copilotReactionGapMs('high') < copilotReactionGapMs('medium'));
  assert.ok(copilotReactionGapMs('medium') < copilotReactionGapMs('low'));
});

test('trim keeps the session opener as an anchor and preserves alternation', () => {
  const cp = new CopilotConversation('SYS', 6); // keep 6 turns = 3 exchanges
  for (let i = 0; i < 10; i++) {
    cp.recordEvent(`EVENT: ${i}`);
    cp.messagesForBeat(`now${i}`, null);
    cp.recordSpoken(`beat ${i}`);
  }
  const t = cp.transcript();
  assert.ok(t.length <= 6);
  assert.match(t[0].content, /EVENT: 0/); // opener survives
  assert.equal(t[t.length - 1].content, 'beat 9'); // latest survives
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant', 'user', 'assistant', 'user', 'assistant']);
});

test('near-duplicate gate catches the same fact re-served in fresh words', () => {
  const spoken = [
    'Eight runs and over thirteen million credits banked. We are making good time.',
    'A mining shift, eh — let us see what this rock has for us.',
  ];
  // The exact failure from a live session: three beats, one fact.
  assert.equal(
    isNearDuplicate('Eight runs and over thirteen million credits stacked up. A smooth streak of hand-ins.', spoken),
    true,
  );
  assert.equal(
    isNearDuplicate('Eight hand-ins and over thirteen million credits banked. We are running a perfect haul.', spoken),
    true,
  );
  // A genuinely different observation still gets through.
  assert.equal(isNearDuplicate('Bio signals on that moon — Vista pays for those.', spoken), false);
  assert.equal(isNearDuplicate('Pad nine. Big berth for a crowd this size.', spoken), false);
  assert.equal(isNearDuplicate('anything', []), false);
});
