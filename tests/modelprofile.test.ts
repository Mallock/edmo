/** Automatic per-model tuning. Every value here is a measurement from a
 *  benchmark run, not a preference — see modelprofile.ts for the numbers. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  profileFor,
  suppressThinkingFor,
  reasoningBudgetFor,
  suppressThinkingForGate,
} from '../src/engine/modelprofile.ts';

test('a model is recognised however the engine happens to name it', () => {
  // Bundled engine reports a full path; LM Studio reports a publisher key.
  const paths = [
    'C:\\Users\\x\\AppData\\Roaming\\ai.laiton.edmissionoperator\\engine\\models\\gemma-4-e4b.gguf',
    'gemma-4-e2b',
    'lmstudio-community/gemma-4-E4B-it-GGUF',
    'google/gemma-4-e4b',
  ];
  for (const p of paths) assert.equal(profileFor(p).family, 'Gemma 4', p);
  assert.equal(profileFor('zai-org/glm-4.6v-flash').family, 'GLM 4.6V');
  assert.equal(profileFor('.../models/glm-4-6v-flash-9b.gguf').family, 'GLM 4.6V');
  assert.equal(profileFor('lmstudio-community/Qwen3.5-4B-GGUF').family, 'Qwen 3.5');
  assert.equal(profileFor('Qwen3-VL-8B-Instruct-Q4_K_M.gguf').family, 'Qwen 3 VL');
});

test('an unknown model gets the conservative default, never a guess', () => {
  // A model nobody has benchmarked must behave like the one the app is tuned
  // around, not like whichever quirk happened to be hardcoded last.
  for (const id of ['some-new-model-2027', '', null, undefined]) {
    assert.equal(profileFor(id as string).family, 'Gemma 4');
  }
});

test('gemma keeps reasoning on every path, including ambient beats', () => {
  const p = profileFor('gemma-4-e4b');
  // Switching it off for chatter was right on a bare beat context and wrong
  // once the beat carried an arc, a mood, an angle and lore: engagement with
  // the actual event went 6/10 -> 8/10 at ~1.5 s rather than the old 5.1 s.
  assert.equal(suppressThinkingFor(p, 'chatter'), false);
  assert.equal(suppressThinkingFor(p, 'ask'), false);
  assert.equal(suppressThinkingFor(p, 'json'), false);
  // Nothing to cap at the engine — it is controlled per request.
  assert.equal(reasoningBudgetFor(p), null);
});

test('the per-path map is what decides, not the mechanism', () => {
  // A family that wants reasoning only for plans must be expressible.
  const askOnly = {
    ...profileFor('gemma-4-e4b'),
    thinkingFor: { chatter: false, ask: true, json: false },
  };
  assert.equal(suppressThinkingFor(askOnly, 'chatter'), true);
  assert.equal(suppressThinkingFor(askOnly, 'ask'), false);
  assert.equal(suppressThinkingFor(askOnly, 'json'), true);
});

test('Qwen3.5 also loses reasoning on JSON, where gemma keeps it', () => {
  const p = profileFor('Qwen3.5-4B');
  // With reasoning on, schema calls burned 3,000 tokens / 23 s and returned
  // nothing — so this family differs from gemma exactly here.
  assert.equal(suppressThinkingFor(p, 'json'), true);
  assert.equal(suppressThinkingFor(p, 'ask'), true);
  assert.equal(suppressThinkingFor(p, 'chatter'), true);
});

test('GLM is never sent the flag that crashes the driver', () => {
  const p = profileFor('glm-4-6v-flash-9b');
  // The per-request kwarg faults amdvlk64.dll (3/3). Not on any path.
  assert.equal(suppressThinkingFor(p, 'chatter'), false);
  assert.equal(suppressThinkingFor(p, 'ask'), false);
  assert.equal(suppressThinkingFor(p, 'json'), false);
  // ...and NOT capped at the engine either: --reasoning-budget 0 is stable but
  // emits the beat followed by a stray </think> and NO_BEAT, which reads as a
  // refusal — 6/6 beats lost. Reasoning stays on: slower, but it speaks.
  assert.equal(reasoningBudgetFor(p), null);
});

test('the server-side reasoning cap is still supported for models that need it', () => {
  // No shipped profile uses it today (GLM's output is malformed under it), but
  // the control exists and must keep working for the next model that does.
  const capped = { ...profileFor('gemma-4-e4b'), thinking: 'server' as const };
  assert.equal(reasoningBudgetFor(capped), 0);
  assert.equal(suppressThinkingFor(capped, 'chatter'), false); // never both
});

test('echo-prone families are filtered harder, and the order is deliberate', () => {
  const gemma = profileFor('gemma-4-e4b');
  const glm = profileFor('glm-4.6v-flash');
  const qwenVl = profileFor('qwen3-vl-8b');
  // gemma: 0-1 duplicates in 16. GLM: 8/8 identical openers. Qwen3-VL: 13/16.
  assert.ok(glm.penalties.presence > gemma.penalties.presence);
  assert.ok(qwenVl.penalties.presence > gemma.penalties.presence);
  // A resample follows a beat that already tripped a fence — always firmer.
  for (const p of [gemma, glm, qwenVl]) {
    assert.ok(p.resamplePenalties.presence > p.penalties.presence, p.family);
    assert.ok(p.resamplePenalties.frequency > p.penalties.frequency, p.family);
  }
});

test('every profile carries sane values the API will accept', () => {
  for (const id of ['gemma-4-e4b', 'glm-4.6v-flash', 'Qwen3.5-4B', 'qwen3-vl-8b', 'unknown']) {
    const p = profileFor(id);
    for (const pen of [p.penalties, p.resamplePenalties]) {
      assert.ok(pen.presence >= 0 && pen.presence <= 2, `${id} presence`);
      assert.ok(pen.frequency >= 0 && pen.frequency <= 2, `${id} frequency`);
    }
    assert.ok(p.family.length > 0);
    // A note is either absent or actually says something.
    assert.ok(p.note === null || p.note.length > 20, `${id} note`);
  }
});

test('the models with caveats explain them in plain language', () => {
  // These strings reach the settings panel, so they must read like a sentence
  // to a player, not like a changelog entry.
  const glm = profileFor('glm-4.6v-flash').note!;
  assert.match(glm, /crashes/i);
  assert.doesNotMatch(glm, /amdvlk64|chat_template_kwargs|3\/3/);
  const qwen = profileFor('Qwen3.5-4B').note!;
  assert.match(qwen, /return nothing|returns nothing/i);
  assert.equal(profileFor('gemma-4-e4b').note, null); // nothing to warn about
});

test('the gate optimises for speed, not for what the beats want', () => {
  // Once gemma's beats kept reasoning, reusing the chatter rule for the gate
  // would have turned a 92 ms yes/no into a multi-second one before EVERY beat.
  const gemma = profileFor('gemma-4-e4b');
  assert.equal(suppressThinkingFor(gemma, 'chatter'), false); // beats think
  assert.equal(suppressThinkingForGate(gemma), true); // the gate does not
  // ...but never at the cost of safety: GLM must not see this flag anywhere.
  assert.equal(suppressThinkingForGate(profileFor('glm-4.6v-flash')), false);
});
