/** Living copilot — the session conversation: ephemeral beats, clean silence,
 *  event carry-forward, alternation, trim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CopilotConversation,
  buildCopilotSystem,
  buildBeatGateChat,
  parseBeatGate,
  pickBeatAngle,
  beatAngleHint,
  speakableCredits,
  roundCreditsForSpeech,
  copilotReactsTo,
  copilotReactionGapMs,
  copilotDensityGapMs,
  copilotSilenceGapMs,
  isNearDuplicate,
  isSilenceVerdict,
  stripVerdict,
  type BeatAngle,
} from '../src/engine/copilot.ts';
import { stripFillerTics, suppressRoutineCoaching } from '../src/engine/glance.ts';
import { parseProspectTarget, matchesProspect } from '../src/engine/mining.ts';
import {
  extractPlaces,
  findCollectivePronoun,
  findFabricatedPlace,
  findHabitualGenerality,
  findLiftedExample,
} from '../src/engine/factcheck.ts';
import { loreForSystem, UNIVERSAL_LORE } from '../src/engine/lore.ts';
import { stripThink } from '../src/engine/lmstudio.ts';
import { IDLE_ASK_SYSTEM } from '../src/engine/operator.ts';

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

test('epic mode adds purpose framing without dropping grounding', () => {
  const sys = buildCopilotSystem("M'allock", { epic: true });
  assert.match(sys, /EPIC REGISTER is enabled/);
  assert.match(sys, /larger frontier campaign/);
  assert.match(sys, /No grand lore inventions/);
  // Core guardrails still present in epic mode.
  assert.match(sys, /What you must NEVER do is NARRATE/);
  assert.match(sys, /STRICT grounding/);
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

test('the voice fence catches the operator slipping into "we"', () => {
  // Real slips from a live session — the exact lines that prompted this gate.
  assert.equal(findCollectivePronoun("Let's get us back to a proper dock soon."), "let's");
  assert.equal(findCollectivePronoun('Almost there on the samples. Keep us moving.'), 'us');
  assert.equal(findCollectivePronoun("We're docked at Kirk Dock."), "we're");
  assert.equal(findCollectivePronoun('That is our best haul yet.'), 'our');
});

test('the voice fence leaves own-voice beats alone', () => {
  assert.equal(findCollectivePronoun('You have two more genera down there.'), null);
  assert.equal(findCollectivePronoun("Pad eight. I'd take it slow."), null);
  // Words that merely contain the letters must not trip it.
  assert.equal(findCollectivePronoun('Weather is filthy down there.'), null);
  assert.equal(findCollectivePronoun('The bus run to Colonia pays well.'), null);
  assert.equal(findCollectivePronoun('Ourania is three jumps out.'), null);
  assert.equal(findCollectivePronoun('That outpost is a wreck.'), null);
});

test('the parrot fence catches phrasing lifted from the instructions', () => {
  // Observed live at an OUTPOST — the smallest berth there is — because the
  // model copied the example instead of looking at what it was told.
  assert.equal(findLiftedExample('Big berth for a big crowd, this one.'), 'big berth for a big crowd');
  assert.equal(findLiftedExample('Another quiet little outpost.'), 'quiet little outpost');
  assert.equal(findLiftedExample("Pad seven smells of synth-coffee."), 'smells of synth-coffee');
  // Punctuation and case must not let it through.
  assert.equal(findLiftedExample('big-berth, for a BIG crowd!'), 'big berth for a big crowd');
});

test('the parrot fence leaves the operator its own words', () => {
  assert.equal(findLiftedExample('Neugebauer Mines. Refinery dust on everything.'), null);
  assert.equal(findLiftedExample('Pad three. Tight little berth, that.'), null);
  assert.equal(findLiftedExample('Gallium to Valac. A steady run.'), null);
  assert.equal(findLiftedExample('That outpost is busy tonight.'), null);
});

test('filler stripping handles hedges and casing past the first sentence', () => {
  // The live slip: the hedge moved to sentence two, where the anchored rule
  // could not see it.
  assert.equal(
    stripFillerTics('Pad three at Neugebauer. Looks like a little mining spot.'),
    'Pad three at Neugebauer. A little mining spot.',
  );
  assert.equal(stripFillerTics('Looks like Kirk Dock is ready.'), 'Kirk Dock is ready.');
  // Sentence-start casing, which the model gets wrong on its own.
  assert.equal(
    stripFillerTics('Neugebauer Mines? some work in the cargo hold.'),
    'Neugebauer Mines? Some work in the cargo hold.',
  );
  // Decimals must survive untouched.
  assert.equal(stripFillerTics('Jump is 22.5 ly out.'), 'Jump is 22.5 ly out.');
});

// --- the speak/skip gate -----------------------------------------------------
// The operator will not stay quiet in character (measured: it spoke on 16/16
// events in a replayed session, and on 5/5 routine jumps even with an explicit
// "always NO_BEAT on a routine jump" rule in its prompt). Silence is therefore
// decided by a separate, personaless classification call — these tests cover
// the shape of that call and, above all, its failure mode.

test('beat gate is asked cold — no persona, no transcript, one event', () => {
  const msgs = buildBeatGateChat('EVENT: FSD jump to HIP 71120.');
  assert.equal(msgs.length, 2);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[1].content, 'EVENT: FSD jump to HIP 71120.');
  const sys = String(msgs[0].content);
  assert.match(sys, /SPEAK or SKIP/);
  assert.match(sys, /when in doubt, SKIP/i);
  // The operator's own voice rules must NOT leak in: being handed the persona
  // is exactly what stops the model reaching for silence.
  assert.doesNotMatch(sys, /NO_BEAT|dry, unhurried veteran|Commander/);
});

test('beat gate trims the event line it is handed', () => {
  const msgs = buildBeatGateChat('  EVENT: Mission FAILED: Transport Essence Emerson.  \n');
  assert.equal(msgs[1].content, 'EVENT: Mission FAILED: Transport Essence Emerson.');
});

test('beat gate reads a verdict in either direction', () => {
  assert.equal(parseBeatGate('SKIP'), false);
  assert.equal(parseBeatGate('skip'), false);
  assert.equal(parseBeatGate(' SKIP\n'), false);
  assert.equal(parseBeatGate('SPEAK'), true);
  assert.equal(parseBeatGate('speak'), true);
});

test('beat gate defaults to SPEAK when the model is unreachable or incoherent', () => {
  // A gate that cannot answer must never be able to mute the operator for a
  // whole session — the tier and density gates upstream still hold the line,
  // so falling open lands on the behaviour that shipped before the gate.
  assert.equal(parseBeatGate(''), true);
  assert.equal(parseBeatGate('   '), true);
  assert.equal(parseBeatGate('I think this one is worth a mention'), true);
  assert.equal(parseBeatGate('{"verdict": null}'), true);
});

test('beat gate does not read SKIP out of an unrelated word', () => {
  // Substring matching would turn "skipper"/"skipping" into silence.
  assert.equal(parseBeatGate('The skipper called it in'), true);
  assert.equal(parseBeatGate('Skipping the beacon'), true);
});

// --- what a beat is allowed to be about --------------------------------------
// Every ambient line came out about money because money was all the beat
// context held (7 of 8 lines over a replayed session). The angle picker exists
// to hand the model something else to be a person about — but only ever an
// angle we can actually feed, since an angle without facts is an invitation to
// invent them.

test('an angle is only ever offered when there is material for it', () => {
  const always = () => 0.99; // never takes the "leave it open" branch
  assert.equal(pickBeatAngle([], always), null);
  assert.equal(pickBeatAngle(['ship'], always), 'ship');
  assert.equal(pickBeatAngle(['clock'], always), 'clock');
});

test('roughly one beat in four is left open, with no angle at all', () => {
  // An angle on every beat would be its own formula.
  assert.equal(pickBeatAngle(['ship', 'clock'], () => 0.1), null);
  assert.notEqual(pickBeatAngle(['ship', 'clock'], () => 0.5), null);
});

test('the picker only ever returns an angle from the offered set', () => {
  const offered: BeatAngle[] = ['ship', 'client'];
  for (let i = 0; i < 40; i++) {
    const r = i / 40;
    const got = pickBeatAngle(offered, () => 0.3 + r * 0.69);
    if (got !== null) assert.ok(offered.includes(got), `${got} was never offered`);
  }
});

test('every angle carries an instruction; an open beat carries none', () => {
  assert.equal(beatAngleHint(null), '');
  for (const a of ['ship', 'clock', 'client', 'place', 'callback', 'ahead'] as const) {
    assert.match(beatAngleHint(a), /^ANGLE: /);
  }
  // The place angle must repeat the name-is-not-a-fact rule where it bites:
  // it is the one angle that invites a claim about somewhere.
  assert.match(beatAngleHint('place'), /ONLY from what you have actually been told/);
  assert.match(beatAngleHint('place'), /pick another angle/);
  // Looking forward, not restating what just happened.
  assert.match(beatAngleHint('ahead'), /not the one just finished/);
});

// --- credits the model can actually say --------------------------------------
// From a live session: a 971,646 cr hand-in was announced to the commander as
// "Ninety-seven grand for moving some VIPs" — an order of magnitude out. The
// NOW line was already rounded for exactly this reason, but EVENT lines are
// built from the feed's notice strings and still carried "971,646 cr".

test('speakableCredits rounds to something a 7.5B model reads correctly', () => {
  assert.equal(speakableCredits(971_646), '~972k cr'); // the live-session figure
  assert.equal(speakableCredits(561_646), '~562k cr');
  assert.equal(speakableCredits(2_424_592), '~2.4M cr'); // the figure in the old comment
  assert.equal(speakableCredits(1_564_280), '~1.6M cr');
  assert.equal(speakableCredits(12_500_000), '~13M cr'); // no decimal past 10M
  assert.equal(speakableCredits(10_000), '~10k cr');
  // Below 10k the exact figure is short enough to be safe.
  assert.equal(speakableCredits(9_999), '9999 cr');
  assert.equal(speakableCredits(0), '0 cr');
  assert.equal(speakableCredits(-50_000), '-~50k cr');
  assert.equal(speakableCredits(Number.NaN), '0 cr');
});

test('roundCreditsForSpeech rewrites the real notice lines that caused this', () => {
  assert.equal(
    roundCreditsForSpeech('EVENT: You\'ve arrived. You can hand in "Transport Tesla Santos" here for 971,646 cr.'),
    'EVENT: You\'ve arrived. You can hand in "Transport Tesla Santos" here for ~972k cr.',
  );
  assert.equal(
    roundCreditsForSpeech('EVENT: Mission complete: Transport Tesla Santos. 561,646 cr paid. You took a reduced package — 410,000 cr under the board price.'),
    'EVENT: Mission complete: Transport Tesla Santos. ~562k cr paid. You took a reduced package — ~410k cr under the board price.',
  );
  assert.equal(
    roundCreditsForSpeech("EVENT: Target eliminated. You're redirected — return to Malchiodi City to collect 1,564,280 cr."),
    "EVENT: Target eliminated. You're redirected — return to Malchiodi City to collect ~1.6M cr.",
  );
  assert.equal(
    roundCreditsForSpeech('EVENT: You\'ve arrived. 4 missions can be handed in here for 383,317 cr total.'),
    'EVENT: You\'ve arrived. 4 missions can be handed in here for ~383k cr total.',
  );
});

test('roundCreditsForSpeech touches ONLY credit figures', () => {
  // Tonnage, percentages, pad numbers, distances, body names, dates: all safe.
  const keep = 'EVENT: Prospected 24% Tritium on pad 15; 206 t refined, 55.9 ly run, body 1 a, in 3312.';
  assert.equal(roundCreditsForSpeech(keep), keep);
  // A figure under 10k is left exact even with the cr suffix.
  assert.equal(roundCreditsForSpeech('paid 9,500 cr'), 'paid 9,500 cr');
  // Nothing to do is a no-op, not a mangling.
  assert.equal(roundCreditsForSpeech('EVENT: FSD jump to HIP 71120.'), 'EVENT: FSD jump to HIP 71120.');
  assert.equal(roundCreditsForSpeech(''), '');
});

test('the NOW line and the event stream agree on how a figure is said', () => {
  // They used to have separate implementations; a figure must not be "~972k cr"
  // in one place and something else in the other, or the model sees a conflict.
  for (const n of [971_646, 2_424_592, 12_500_000, 45_000]) {
    assert.equal(roundCreditsForSpeech(`for ${n.toLocaleString('en-US')} cr.`), `for ${speakableCredits(n)}.`);
  }
});

// --- the atmosphere tic ------------------------------------------------------
// From a live session: "Jaques Station is always a good place to drop in." The
// prompt bans habitual claims twice over and even supplies "pad seven smells of
// synth-coffee" as the bad example — and the model reproduced that example's
// shape on 3 of 3 glance beats at one station. Instructions do not stop it, so
// a fence does.

test('habitual claims about a place are caught however they are phrased', () => {
  const caught = [
    'Jaques Station always smells like recycled air.',
    'Jaques Station is always a good place to drop in.',
    'Paxton Landing always has a decent flow to it.',
    "Pad seven always gets the traffic, doesn't it.",
    'The Forge of Vulcan. Always a good spot to catch your breath.',
    'Luchtaine always seems to have a payday lined up for you.',
    'Malchiodi City always pays the bills.',
    'Robardin Rock never disappoints.',
    // Smuggled mid-sentence after a comma, on top of TRUE lore — a live catch.
    "Jaques Station, built around a bartender's jump in 3302, always smells faintly of old synth-whiskey.",
  ];
  for (const b of caught) assert.ok(findHabitualGenerality(b), `should have flagged: ${b}`);
});

test('the fence leaves real observations alone', () => {
  // Every one of these is a line the model actually produced when its beat
  // context carried real material — none may be dropped.
  const kept = [
    'Better keep that Python running smooth.',
    'Three runs queued up.',
    'GR Virginis Dominion has kept its word on the payout this run.',
    'Five resource sites and a beacon. Everything out here is for sale or ready to blow up.',
    'Pad twenty-two. Quiet berth.',
    'Eighteen bodies. A proper sprawl.',
    'That history with HIP 71120 is something to keep clear of.',
    'Einheriar is running the smallest goal with just 601 pilots chipping in.',
    "You don't want another repeat of that lost ship run.",
    'The clock is ticking on three hauls for that one poster.',
  ];
  for (const b of kept) assert.equal(findHabitualGenerality(b), null, `false positive on: ${b}`);
});

test('the offending phrase is returned, so the log says what was dropped', () => {
  assert.match(String(findHabitualGenerality('Jaques Station always smells like recycled air.')), /always smells/i);
  assert.match(String(findHabitualGenerality('Always a good spot to rest.')), /^Always a good/i);
});

test('the "opening" angle voices a conclusion and is forbidden from reaching one', () => {
  // Asked to work out which of four goals was least contested, the model chose
  // the MOST contested on 6 of 6 beats. Ranking moved into rankCommunityGoals();
  // this angle must never invite the model back into doing it itself.
  const hint = beatAngleHint('opening');
  assert.match(hint, /^ANGLE: the opening/);
  assert.match(hint, /pass on the opportunity the facts have already picked out/);
  assert.match(hint, /never rank or compare anything yourself/);
});

// --- canonical lore ----------------------------------------------------------
// The grounding rules suppress invention, but they suppressed true knowledge
// with it: docked AT Jaques Station, the operator answered "the founder is not
// part of the current manifest data", and it claimed no intel on the Pilots
// Federation — the guild every commander belongs to. Canon is now curated in
// lore.ts and handed over as material, like every other fact.

test('loreForSystem knows the famous places and never guesses at the rest', () => {
  assert.match(String(loreForSystem('Colonia')), /Jaques/);
  assert.match(String(loreForSystem('Colonia')), /3302/);
  assert.match(String(loreForSystem('Colonia')), /22,000 light-years/);
  // The engineer systems from live sessions (Luchtaine and Asura both appeared).
  assert.match(String(loreForSystem('Luchtaine')), /Mel Brandon/);
  assert.match(String(loreForSystem('Asura')), /Petra Olmanova/);
  assert.match(String(loreForSystem('Carcosa')), /Robardin Rock/);
  // Case- and whitespace-insensitive, as journal names vary.
  assert.equal(loreForSystem(' COLONIA '), loreForSystem('Colonia'));
  // Unknown places return null — a gazetteer that guesses is worse than none.
  assert.equal(loreForSystem('HIP 71120'), null);
  assert.equal(loreForSystem(''), null);
  assert.equal(loreForSystem(null), null);
});

test('universal lore covers the two questions the operator got wrong', () => {
  assert.match(UNIVERSAL_LORE, /PILOTS FEDERATION/);
  assert.match(UNIVERSAL_LORE, /Harmless up to the coveted Elite/);
  assert.match(UNIVERSAL_LORE, /THARGOIDS/);
  // ...and stays in-fiction while doing it.
  assert.doesNotMatch(UNIVERSAL_LORE, /game|player|Frontier/i);
});

test('the ask prompts carry the universal lore', () => {
  assert.match(IDLE_ASK_SYSTEM, /PILOTS FEDERATION/);
});

// --- the babble session ------------------------------------------------------
// A live mining session surfaced three leaks at once: the raw-image fallback
// path skipped every fence ("We'll pick a bearing off those formations"), the
// analyst voice slipped through ("it's clear you're banking on..."), and the
// gate never saw screen sightings, so every glance at a rock field spoke.
// These pin the exact lines from that session.

test('the coaching suppressor removes the analyst clause from the live word-salad', () => {
  const salad =
    "Seeing that jump countdown to Tir, it's clear you're banking on the established work here at Paxton Landing for the next payday.";
  // The whole clause is analyst-speak; nothing worth keeping survives.
  assert.equal(stripFillerTics(suppressRoutineCoaching(salad)), '');
  assert.equal(suppressRoutineCoaching("You're clearly settling into the rhythm out here."), '');
  // A plain observation is untouched.
  assert.equal(
    suppressRoutineCoaching('That refiner is built for this kind of steady trickle.'),
    'That refiner is built for this kind of steady trickle.',
  );
});

test('the collective fence catches the live glance line', () => {
  assert.equal(findCollectivePronoun("Asteroid boulders scattered across the void. We'll pick a bearing off those formations."), "we'll");
});

test('the gate knows scenery is not news', () => {
  const sys = String(buildBeatGateChat('SCREEN SIGHTING: an asteroid field.')[0].content);
  assert.match(sys, /screen sighting/i);
  assert.match(sys, /ordinary scenery/);
  assert.match(sys, /rocks are not news/);
  assert.match(sys, /genuinely arresting sight/); // a real view can still earn a word
});

// --- the living operator ------------------------------------------------------
// A/B-tested (see arc.ts): persona licence alone produced ZERO self-reference
// in 17 beats; with the 'self' angle inviting it, the inner life landed
// reliably with no discipline cost. These pin the recipe's prompt half.

test('the system prompt gives the operator a life, a witness role, and the contracts', () => {
  const sys = buildCopilotSystem('Hadfield');
  assert.match(sys, /a PERSON with a post and a life/);
  assert.match(sys, /twenty years flying these lanes/);
  assert.match(sys, /plain small\s+truths about YOURSELF are yours to say/);
  assert.match(sys, /the only witness keeping the log/);
  assert.match(sys, /never flattery, never coaching/);
  assert.match(sys, /"ARC:"/);
  assert.match(sys, /never recite it back/);
  assert.match(sys, /"OPERATOR MOOD:"/);
  assert.match(sys, /never announce it/);
  assert.match(sys, /"EVENT: Chapter turn"/);
});

test("the 'self' angle invites the inner life and its backstory clears the fence", () => {
  const hint = beatAngleHint('self');
  assert.match(hint, /^ANGLE: yourself/);
  assert.match(hint, /Perseus Arm/);
  assert.match(hint, /Lave/);
  assert.match(hint, /tied back to their run/);
  // The place fence is suffix-scoped (Station/Dock/City…), so the operator's
  // own regions — "the Perseus Arm", "the old Lave lanes" — can never be
  // flagged as fabrications. A typical self-beat must pass it untouched.
  const beat = 'I remember a stretch like this near the Perseus Arm, back on the old Lave lanes.';
  assert.equal(findFabricatedPlace(beat, ['Jaques Station']), null);
});

// --- reasoning tags that arrive without their pair ---------------------------
// Capping thinking at the server (--reasoning-budget 0, how LM Studio does it)
// ends the thought without ever opening one, so the pair rule missed it and the
// reasoning was spoken. Observed on GLM-4.6V: the beat, a stray close tag, and
// the real verdict all in one string.

test('an orphan </think> takes the leaked reasoning with it', () => {
  assert.equal(
    stripThink("That's a good haul for a single run. Keep moving.</think>NO_BEAT"),
    'NO_BEAT',
  );
  assert.equal(stripThink('planning the line…</think>Pad seven.'), 'Pad seven.');
});

test('an orphan <think> drops everything after it', () => {
  assert.equal(stripThink('Pad seven.<think>now let me consider'), 'Pad seven.');
});

test('a well-formed pair still strips, and clean text is untouched', () => {
  assert.equal(stripThink('<think>reasoning here</think>Pad seven.'), 'Pad seven.');
  assert.equal(stripThink('Pad seven. Quiet berth.'), 'Pad seven. Quiet berth.');
  assert.equal(stripThink(''), '');
});

// --- a decline is only a decline when it IS the reply -------------------------
// Reported live on a hauling beat: the model produced "That's a good haul. Keep
// moving." and appended NO_BEAT, and the token matched anywhere in the string,
// so the whole line was dropped and the commander heard nothing — "I was
// hauling, why no beat?". A model that composed a remark and then second-
// guessed itself has still composed the remark.

test('a bare decline is silence', () => {
  assert.equal(isSilenceVerdict('NO_BEAT'), true);
  assert.equal(isSilenceVerdict('  NO_BEAT.  '), true);
  assert.equal(isSilenceVerdict('NOT_IN_GAME'), true);
  assert.equal(isSilenceVerdict(''), true);
  assert.equal(isSilenceVerdict('   '), true);
  // A couple of stray words around the token is still a refusal.
  assert.equal(isSilenceVerdict('NO_BEAT — nothing'), true);
});

test('a real beat with the token stuck on is a BEAT, not silence', () => {
  const live = "That's a good haul. Keep moving. NO_BEAT";
  assert.equal(isSilenceVerdict(live), false);
  assert.equal(stripVerdict(live), "That's a good haul. Keep moving.");
  // ...and the shape the server-side thinking cap produced.
  assert.equal(isSilenceVerdict('Pad seven. Quiet berth. NO_BEAT'), false);
  assert.equal(stripVerdict('Pad seven. Quiet berth. NO_BEAT'), 'Pad seven. Quiet berth.');
});

test('an ordinary beat is untouched by either helper', () => {
  const beat = "Einheriar's the quiet one, only 601 pilots on it.";
  assert.equal(isSilenceVerdict(beat), false);
  assert.equal(stripVerdict(beat), beat);
});

// --- one thread ---------------------------------------------------------------
// Reported live twice: the operator said "That old thing has seen some miles",
// the commander asked "what thing?", and the answer was about the market. The
// ask path was assembling its own conversation from a separate buffer, so the
// remark being asked about was never the previous assistant turn.

test('a spoken exchange joins the same transcript as the beats', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: Docking granted — pad 4 at Paxton Landing.');
  cp.messagesForBeat('now', null);
  cp.recordSpoken('That old thing has seen some miles.');
  cp.recordExchange('what thing?', 'The Python. Twenty-one runs and counting.');
  const t = cp.transcript();
  assert.deepEqual(t.map((x) => x.role), ['user', 'assistant', 'user', 'assistant']);
  assert.equal(t[1].content, 'That old thing has seen some miles.');
  assert.match(t[2].content, /COMMANDER SAID: what thing\?/);
  assert.equal(t[3].content, 'The Python. Twenty-one runs and counting.');
});

test('the thread hands back the beats as real turns for the ask path', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: A'); cp.messagesForBeat('n', null); cp.recordSpoken('first');
  cp.recordEvent('EVENT: B'); cp.messagesForBeat('n', null); cp.recordSpoken('second');
  const turns = cp.recentTurns(16);
  // The last thing the operator said must be the last assistant turn, so a
  // follow-up resolves against it.
  assert.equal(turns[turns.length - 1].role, 'assistant');
  assert.equal(turns[turns.length - 1].content, 'second');
  // Bounded, oldest first.
  assert.equal(cp.recentTurns(2).length, 2);
  assert.equal(cp.recentTurns(2)[1].content, 'second');
});

test('events still pending ride into the exchange as context', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: Docking granted — pad 38 at Jaques Station.');
  cp.recordExchange('yeah getting another load', 'Right — third run through today.');
  const t = cp.transcript();
  assert.match(t[0].content, /Docking granted — pad 38/);
  assert.match(t[0].content, /COMMANDER SAID: yeah getting another load/);
  assert.equal(cp.pendingCount(), 0); // consumed, not left to repeat
});

test('an empty answer never commits a half exchange', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: A');
  cp.recordExchange('hello', '   ');
  assert.equal(cp.transcript().length, 0);
  assert.equal(cp.pendingCount(), 1); // the event survives for the next beat
});
