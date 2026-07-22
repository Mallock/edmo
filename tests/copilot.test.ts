/** Living copilot — the session conversation: alternation, flushing, trim. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CopilotConversation, buildCopilotSystem } from '../src/engine/copilot.ts';

test('copilot system prompt carries the persona and the event-stream contract', () => {
  const sys = buildCopilotSystem("M'allock");
  assert.match(sys, /Commander M'allock/);
  assert.match(sys, /NO_BEAT/);
  assert.match(sys, /35 words/);
  assert.match(sys, /authoritative ground truth|authoritative/);
  assert.match(sys, /STRICT grounding/); // from GROUNDING_RULES
  assert.match(sys, /only mention\s+fuel when it is explicitly LOW or below 25%/);
});

test('a beat request flushes pending events into one user turn with NOW + SCREEN', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: Undocked from Bolden\'s Enterprise.');
  cp.recordEvent('EVENT: Entered supercruise.');
  assert.equal(cp.pendingCount(), 2);
  const msgs = cp.messagesForBeat('in supercruise toward Dove Enigma, fuel 78%.', 'SCREEN READING: a ringed planet.');
  assert.equal(cp.pendingCount(), 0); // flushed
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[0].content, 'SYS');
  assert.equal(msgs[1].role, 'user');
  const turn = msgs[1].content as string;
  assert.match(turn, /Undocked/);
  assert.match(turn, /Entered supercruise/);
  assert.match(turn, /NOW: in supercruise toward Dove Enigma/);
  assert.match(turn, /SCREEN READING: a ringed planet/);
});

test('turns stay strictly alternating across events, beats and silences', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: A');
  cp.messagesForBeat('now1', null);
  cp.recordSpoken('Beat one.');
  cp.recordEvent('EVENT: B');
  cp.recordEvent('EVENT: C');
  cp.messagesForBeat('now2', 'SCREEN X');
  cp.recordSilent();
  const roles = cp.transcript().map((t) => t.role);
  assert.deepEqual(roles, ['user', 'assistant', 'user', 'assistant']);
  // The two events between beats collapsed into the single second user turn.
  const secondUser = cp.transcript()[2].content;
  assert.match(secondUser, /EVENT: B/);
  assert.match(secondUser, /EVENT: C/);
  assert.equal(cp.transcript()[3].content, 'NO_BEAT');
});

test('an unanswered beat request is folded back in, never lost or doubled', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordEvent('EVENT: interdiction');
  cp.messagesForBeat('now1', 'SCREEN 1'); // request fired…
  // …superseded before any record; next request must not create two user turns.
  cp.recordEvent('EVENT: evaded');
  const msgs = cp.messagesForBeat('now2', 'SCREEN 2');
  const roles = cp.transcript().map((t) => t.role);
  assert.deepEqual(roles, ['user']); // single, merged user turn
  const merged = msgs[msgs.length - 1].content as string;
  assert.match(merged, /interdiction/);
  assert.match(merged, /evaded/);
  assert.match(merged, /NOW: now2/);
});

test('recordSilent only appends after a user turn (never doubles assistants)', () => {
  const cp = new CopilotConversation('SYS');
  cp.recordSilent(); // nothing pending → no-op
  assert.equal(cp.transcript().length, 0);
  cp.messagesForBeat('now', null);
  cp.recordSilent();
  cp.recordSilent(); // second is a no-op — last turn is already assistant
  assert.deepEqual(cp.transcript().map((t) => t.role), ['user', 'assistant']);
});

test('trim caps the window but keeps the session opener as an anchor', () => {
  const cp = new CopilotConversation('SYS', 6); // keep 6 turns
  for (let i = 0; i < 10; i++) {
    cp.recordEvent(`EVENT: ${i}`);
    cp.messagesForBeat(`now${i}`, null);
    cp.recordSpoken(`beat ${i}`);
  }
  const turns = cp.transcript();
  assert.ok(turns.length <= 6);
  // Opener (turn 0) survives as the anchor.
  assert.match(turns[0].content as string, /EVENT: 0/);
  // Most recent beat is retained.
  assert.equal(turns[turns.length - 1].content, 'beat 9');
  // Alternation preserved across the trim seam.
  assert.deepEqual(
    turns.map((t) => t.role),
    ['user', 'assistant', 'user', 'assistant', 'user', 'assistant'],
  );
});
