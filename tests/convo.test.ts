/** ConvoBuffer — dialogue memory — and whisper transcript cleaning. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConvoBuffer, cleanTranscript, toolExchangeOf } from '../src/engine/convo.ts';

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
  // The gist keeps the END, not the start: a merged assistant turn runs
  // oldest→newest, and a follow-up ("what?") refers to the last thing said.
  assert.match(msgs[0].content, /^…/);
});

test('consecutive operator lines merge instead of overwriting each other', () => {
  // In live play the operator says several things between questions (hazard
  // calls, mission notices, copilot beats). Overwriting meant a follow-up could
  // only ever see the last one.
  const c = new ConvoBuffer();
  c.push('user', 'anything happening?', 0);
  c.push('assistant', 'Taking fire — watch your shields.', 1);
  c.push('assistant', 'Shields are down.', 2);
  const recalled = c.recent(1000).at(-1)!.content;
  assert.match(recalled, /Taking fire/);
  assert.match(recalled, /Shields are down/);
  // …but a long burst stays bounded rather than growing without limit.
  for (let i = 0; i < 50; i++) c.push('assistant', `line ${i} ${'y'.repeat(40)}`, 3 + i);
  assert.ok(c.turns.at(-1)!.content.length <= 600);
});

test('empty pushes are ignored and the buffer is bounded', () => {
  const c = new ConvoBuffer();
  c.push('user', '   ', 0);
  assert.equal(c.turns.length, 0);
  for (let i = 0; i < 30; i++) {
    c.push('user', `q${i}`, i * 2);
    c.push('assistant', `a${i}`, i * 2 + 1);
  }
  assert.ok(c.turns.length <= 16, 'the buffer stays bounded');
  assert.equal(c.turns.at(-1)?.content, 'a29');
});

test('cleanTranscript strips whisper noise annotations', () => {
  assert.equal(cleanTranscript(' [BLANK_AUDIO] '), '');
  assert.equal(cleanTranscript('(wind blowing) Where should I hunt? [MUSIC]'), 'Where should I hunt?');
  assert.equal(cleanTranscript('  Operator,   status  report. '), 'Operator, status report.');
});

test('the retained tool exchange cannot grow question after question', () => {
  // The bug this guards: a run's message list already carries the PREVIOUS
  // question's exchange, so harvesting all of it added a pair per question for
  // as long as the app stayed open.
  const call = (n: number) => ({
    role: 'assistant' as const,
    content: '',
    tool_calls: [{ id: `c${n}`, type: 'function' as const, function: { name: 'get_ship', arguments: '{}' } }],
  });
  const result = (n: number) => ({ role: 'tool' as const, tool_call_id: `c${n}`, content: `result ${n}` });

  let carried = toolExchangeOf([]);
  for (let q = 1; q <= 8; q++) {
    // Each question re-sends what was carried in, then adds its own pair.
    carried = toolExchangeOf([
      { role: 'system', content: 'sys' },
      ...carried,
      { role: 'user', content: `question ${q}` },
      call(q),
      result(q),
    ]);
    assert.ok(carried.length <= 4, `after ${q} questions it held ${carried.length} messages`);
  }
  // What survives is the most RECENT work, not the oldest.
  assert.match(carried.map((m) => m.content).join(' '), /result 8/);
  assert.doesNotMatch(carried.map((m) => m.content).join(' '), /result 1\b/);
});

test('an assistant tool call keeps its results directly behind it', () => {
  // The chat format rejects a tool message that does not follow its call.
  const msgs = [
    { role: 'user' as const, content: 'q' },
    { role: 'assistant' as const, content: '', tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'get_ship', arguments: '{}' } }] },
    { role: 'tool' as const, tool_call_id: 'c1', content: 'a' },
    { role: 'assistant' as const, content: 'prose that should not survive' },
  ];
  const out = toolExchangeOf(msgs);
  assert.deepEqual(out.map((m) => m.role), ['assistant', 'tool']);
  assert.equal(out[0].tool_calls?.[0].id, 'c1');
});

test('an oversized tool result is truncated, not carried whole', () => {
  const out = toolExchangeOf([
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'x'.repeat(50_000) },
  ]);
  assert.ok(out[1].content.length < 2000, `kept ${out[1].content.length} chars`);
});
