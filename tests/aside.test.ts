/**
 * The model's note to the author, cut out of the thing it wrote.
 *
 * These are guards in both directions, and the second one matters more: it is
 * easy to write a rule that eats a real parenthetical or a legitimate closing
 * sentence, and a wire that quietly truncates its own stories is worse than one
 * that occasionally admits it followed instructions.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isModelAside, stripModelAside } from '../src/engine/aside.ts';
import { parseStory } from '../src/engine/news.ts';
import { parseSceneReply } from '../src/engine/chatter/llm.ts';

// Verbatim from a live gossip story.
const REAL = `Rumours are swirling that Chief Engineer Elara Vonn and Dock Foreman Jaxon Rahl got into a heated argument over a shipment of spare parts. And everyone knows that the contract with Stein's Garrison is on the verge of collapse, but nobody's talking. (Note: As per your instructions, I've created new people for the gossip section, while reusing recurring names from previous briefs. The story is entirely fictional and not based on any actual events or facts.)`;

test('the real thing, cut where it should be', () => {
  const out = stripModelAside(REAL);
  assert.match(out, /Chief Engineer Elara Vonn/);
  assert.match(out, /nobody's talking\.$/);
  assert.doesNotMatch(out, /as per your instructions/i);
  assert.doesNotMatch(out, /entirely fictional/i);
  assert.doesNotMatch(out, /Note:/);
});

test('a bracketed aside goes whether or not it says "Note"', () => {
  assert.equal(
    stripModelAside('The lifts failed again. (I have reused the names from the brief.)'),
    'The lifts failed again.',
  );
  assert.equal(
    stripModelAside('The lifts failed again. [Note: this is purely fictional.]'),
    'The lifts failed again.',
  );
});

test('an unbracketed tail goes too', () => {
  assert.equal(
    stripModelAside('Dock crews are unhappy. Note: this story is fictional.'),
    'Dock crews are unhappy.',
  );
});

test('a closing sentence about the task goes, one about the world stays', () => {
  assert.equal(
    stripModelAside('Prices held all week. Let me know if you want another angle.'),
    'Prices held all week.',
  );
  // The guard that matters: this is a real closing line, not an aside.
  const kept = 'Prices held all week. Nobody expects that to last.';
  assert.equal(stripModelAside(kept), kept);
});

test('a legitimate parenthetical is never eaten', () => {
  const keep =
    'The board shifted again (the third time this month) and nobody at the dock seemed surprised.';
  assert.equal(stripModelAside(keep), keep);
  const trailing = 'Steel is up eight percent (from 412 to 445).';
  assert.equal(stripModelAside(trailing), trailing);
});

test('prose that merely uses the word "I" survives', () => {
  // First person alone is not an aside — a quoted haulier says "I" constantly.
  const quote = '"I told them the lift was going," said the foreman. Nobody listened.';
  assert.equal(stripModelAside(quote), quote);
});

test('a story that is nothing BUT an aside is not rescued into nonsense', () => {
  // Better to return something short than to invent a story out of a disclaimer.
  const out = stripModelAside('(Note: as per your instructions, this is fictional.)');
  assert.equal(out, '');
});

test('whole-line asides are recognised', () => {
  assert.equal(isModelAside('(Note: as per your instructions, I have reused names.)'), true);
  assert.equal(isModelAside('Note: this story is entirely fictional.'), true);
  assert.equal(isModelAside('Hope this helps!'), true);
  assert.equal(isModelAside('The lifts failed again.'), false);
  assert.equal(isModelAside('Docks Grind On'), false);
  assert.equal(isModelAside(''), false);
});

// ------------------------------------------------------- through the parsers

test('a news story loses its aside and keeps its body', () => {
  const story = parseStory(`Dockside Drama\n\n${REAL}`, 'gossip');
  assert.equal(story?.headline, 'Dockside Drama');
  assert.match(story?.body ?? '', /Elara Vonn/);
  assert.doesNotMatch(story?.body ?? '', /instructions|fictional/i);
});

test('an aside never becomes a spoken comms turn', () => {
  // It would be read aloud, in a voice, on a radio channel.
  const turns = parseSceneReply(
    'Hold at the marker.\nHolding. Again.\n(Note: I have kept both speakers consistent.)',
    ['control', 'ship'],
  );
  assert.deepEqual(
    turns.map((t) => t.text),
    ['Hold at the marker.', 'Holding. Again.'],
  );
});
