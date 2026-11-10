/**
 * The vocabulary handed to Whisper with every push-to-talk clip (GitHub
 * issue #2: "carrier" kept coming back as something else).
 *
 * What these defend: the game's words are always there, the names the
 * journal knows ride along in priority order without ever overflowing the
 * prompt, and a clip where Whisper merely read the prompt back is caught.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_PROMPT_CHARS,
  buildSttPrompt,
  isPromptEcho,
  splitVocabulary,
} from '../src/engine/voicevocab.ts';

test('with nothing known, the prompt is still the game words', () => {
  const p = buildSttPrompt([]);
  assert.match(p, /Fleet carrier/);
  assert.match(p, /Frame Shift Drive/);
  assert.doesNotMatch(p, /Names:/);
});

test('the names the journal knows ride along, deduplicated and cleaned', () => {
  const p = buildSttPrompt(['Shinrarta Dezhra', 'Jameson Memorial', 'X7Z-B2K', 'shinrarta dezhra', null, '', 'Unknown']);
  assert.match(p, /Names: Shinrarta Dezhra, Jameson Memorial, X7Z-B2K\.$/);
  assert.doesNotMatch(p, /Unknown/);
});

test('quotes and control characters never reach the command line', () => {
  const p = buildSttPrompt(['The "Bad"\nIdea']);
  assert.match(p, /Names: The Bad Idea\.$/);
});

test('the prompt never outgrows what Whisper reads, and the first names win', () => {
  const many = Array.from({ length: 80 }, (_, i) => `System Number ${i}`);
  const p = buildSttPrompt(many);
  assert.ok(p.length <= MAX_PROMPT_CHARS, `${p.length} > ${MAX_PROMPT_CHARS}`);
  assert.match(p, /System Number 0, System Number 1,/);
  assert.doesNotMatch(p, /System Number 79/);
});

test('one overlong name is skipped, not allowed to block the rest', () => {
  const p = buildSttPrompt(['x'.repeat(200), 'Colonia']);
  assert.match(p, /Names: Colonia\.$/);
});

test("the commander's own words split on commas and lines", () => {
  assert.deepEqual(splitVocabulary(' Colonia, Jaques ,\nHutton Orbital,, '), [
    'Colonia',
    'Jaques',
    'Hutton Orbital',
  ]);
  assert.deepEqual(splitVocabulary(undefined), []);
});

test('a clip that is just the prompt read back is an echo; a real question is not', () => {
  const p = buildSttPrompt(['Sol']);
  assert.ok(isPromptEcho('Fleet carrier, carrier jump, carrier market.', p));
  assert.ok(!isPromptEcho('How far is my fleet carrier?', p));
  assert.ok(!isPromptEcho('Fleet carrier', p), 'too short to call');
});
