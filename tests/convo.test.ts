/** ConvoBuffer — dialogue memory — and whisper transcript cleaning. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConvoBuffer, cleanTranscript } from '../src/engine/convo.ts';

const M = 60_000;

test('thread keeps question/answer shape and survives into the next prompt', () => {
  const c = new ConvoBuffer();
  c.push('user', 'Where should I hunt?', 0);
  c.push('assistant', 'The Ratraii nav beacon — scan it first.', 5_000);
  c.push('user', 'And how far is that?', 60_000);
  c.push('assistant', 'One jump, commander.', 65_000);
  const msgs = c.recent(2 * M);
  assert.equal(msgs.length, 4);
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(msgs[1].content, /nav beacon/);
});

test('consecutive operator lines collapse to the newest — thread stays Q/A shaped', () => {
  const c = new ConvoBuffer();
  c.push('assistant', 'Trade lead: Grain.', 0);
  c.push('assistant', 'Contact: Deadly Fer-de-Lance. Stay sharp.', 10_000);
  const msgs = c.recent(M);
  assert.equal(msgs.length, 1);
  assert.match(msgs[0].content, /Fer-de-Lance/);
});

test('stale turns fall out; long stories are recalled as a gist', () => {
  const c = new ConvoBuffer();
  c.push('user', 'old question', 0);
  c.push('assistant', 'x'.repeat(500), 16 * M); // fresh but long
  const msgs = c.recent(17 * M);
  assert.equal(msgs.length, 1, 'the 17-min-old user turn is gone');
  assert.ok(msgs[0].content.length <= 301);
  assert.match(msgs[0].content, /…$/);
});

test('empty pushes are ignored and the buffer is bounded', () => {
  const c = new ConvoBuffer();
  c.push('user', '   ', 0);
  assert.equal(c.turns.length, 0);
  for (let i = 0; i < 30; i++) {
    c.push('user', `q${i}`, i * 2);
    c.push('assistant', `a${i}`, i * 2 + 1);
  }
  assert.ok(c.turns.length <= 10);
  assert.equal(c.turns.at(-1)?.content, 'a29');
});

test('cleanTranscript strips whisper noise annotations', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(wind blowing) Where should I hunt? [MUSIC]'), 'Where should I hunt?');
  assert.equal(cleanTranscript('  Operator,   status  report. '), 'Operator, status report.');
});
