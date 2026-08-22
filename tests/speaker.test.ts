/**
 * The Speaker's two buses, end to end.
 *
 * These are the assertions that pin down design.md D2 — the decision the whole
 * comms feature rests on. If de-duplication ever leaks onto the ambient bus,
 * traffic control stops being able to repeat itself and the channel dies. If
 * ambient ever shares the priority queue, a dock worker's joke can delay a
 * hull-breach callout.
 *
 * The Speaker is a UI module, so the handful of browser globals it touches are
 * shimmed here the same way tests/boot.test.ts shims them for the store. With
 * no Tauri present the Piper path is unreachable, so everything below runs
 * through the speechSynthesis fallback — which is exactly the path that has to
 * keep working when the sidecar is missing.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/** Every utterance the shimmed speechSynthesis was asked to say. */
let spoken: string[] = [];
/** Utterances still "sounding" — resolved by drain(). */
let pending: Array<() => void> = [];

before(() => {
  const g = globalThis as Record<string, unknown>;
  const bank = new Map<string, string>();
  g.localStorage = {
    getItem: (k: string) => (bank.has(k) ? bank.get(k)! : null),
    setItem: (k: string, v: string) => void bank.set(k, String(v)),
    removeItem: (k: string) => void bank.delete(k),
  };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.SpeechSynthesisUtterance = class {
    text: string;
    voice: unknown = null;
    rate = 1;
    volume = 1;
    onend: (() => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(text: string) {
      this.text = text;
    }
  };
  g.speechSynthesis = {
    getVoices: () => [{ name: 'Test Voice', lang: 'en-GB', localService: true }],
    cancel() {},
    speak(u: { text: string; onend: (() => void) | null }) {
      spoken.push(u.text);
      pending.push(() => u.onend?.());
    },
  };
  g.Audio = class {
    play() {
      return Promise.resolve();
    }
    pause() {}
  };
});

beforeEach(() => {
  spoken = [];
  pending = [];
});

/** Let the queues advance: finish whatever is sounding, then yield. */
async function drain(rounds = 8): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    const batch = pending;
    pending = [];
    for (const done of batch) done();
    await new Promise((r) => setTimeout(r, 0));
  }
}

const { Speaker } = await import('../src/ui/tts.ts');
const { DEFAULT_TTL_MS } = await import('../src/engine/chatter/bus.ts');

function makeSpeaker(): InstanceType<typeof Speaker> {
  const settings = {
    voice: {
      enabled: true,
      engine: 'system',
      piperVoice: null,
      systemVoice: null,
      localVoicesOnly: true,
      rate: 1,
      volume: 80,
    },
  };
  return new Speaker(() => settings as never);
}

test('priority de-duplicates a repeated line, as it always has', async () => {
  const sp = makeSpeaker();
  sp.speak('Hull integrity at twenty two percent.');
  sp.speak('Hull integrity at twenty two percent.');
  await drain();
  assert.equal(spoken.length, 1, 'the repeat must be swallowed on PRIORITY');
});

test('ambient does NOT de-duplicate — traffic control may repeat itself', async () => {
  const sp = makeSpeaker();
  const line = 'Inbound vessel, hold at the marker.';
  sp.speak(line, null, { bus: 'AMBIENT', channel: 'STATION' });
  await drain();
  sp.speak(line, null, { bus: 'AMBIENT', channel: 'STATION' });
  await drain();
  assert.equal(spoken.filter((t) => t === line).length, 2);
});

test('a priority line is never queued behind ambient traffic', async () => {
  const sp = makeSpeaker();
  // Fill ambient, then raise a hazard before letting anything finish.
  sp.speak('Chatter one.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  sp.speak('Chatter two.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  sp.speak('Chatter three.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  await new Promise((r) => setTimeout(r, 0));

  sp.speak('Hull breach.');
  await new Promise((r) => setTimeout(r, 0));

  assert.ok(
    spoken.includes('Hull breach.'),
    'the hazard callout must start without waiting for ambient to drain',
  );
  await drain();
});

test('ambient drops the oldest rather than growing without bound', async () => {
  const sp = makeSpeaker();
  const dropped: string[] = [];
  // The first push starts the pump synchronously, so 'one' is already out of
  // the queue and sounding. 'two'..'four' then fill it to the cap of three,
  // and 'five' is what tips it over — evicting 'two', the oldest still WAITING.
  for (const n of ['one', 'two', 'three', 'four', 'five']) {
    sp.speak(`Line ${n}.`, null, {
      bus: 'AMBIENT',
      channel: 'LOCAL',
      onDrop: (reason) => dropped.push(`${n}:${reason}`),
    });
  }
  await drain();
  assert.deepEqual(dropped, ['two:backlog'], 'the oldest waiting line should be the one dropped');
  assert.ok(!spoken.includes('Line two.'), 'a dropped line must never be spoken');
  assert.ok(spoken.includes('Line five.'), 'the newest line describes the situation — keep it');
});

test('a stale ambient line is dropped, not spoken late', async () => {
  const sp = makeSpeaker();
  let reason = '';
  sp.speak('Docking clearance granted.', null, {
    bus: 'AMBIENT',
    channel: 'STATION',
    ttlMs: 0, // already expired at the moment the pump looks at it
    onDrop: (r) => {
      reason = r;
    },
  });
  await drain();
  assert.equal(reason, 'stale');
  assert.equal(spoken.length, 0);
});

test('muting a channel drops its queued traffic and leaves others alone', async () => {
  const sp = makeSpeaker();
  const dropped: string[] = [];
  // The first line is already sounding; the two behind it are what a squelch
  // has to discard selectively.
  sp.speak('Station traffic, sounding.', null, { bus: 'AMBIENT', channel: 'STATION' });
  sp.speak('Concourse ad.', null, {
    bus: 'AMBIENT',
    channel: 'CONCOURSE',
    onDrop: (r) => dropped.push(`concourse:${r}`),
  });
  sp.speak('More station traffic.', null, {
    bus: 'AMBIENT',
    channel: 'STATION',
    onDrop: (r) => dropped.push(`station:${r}`),
  });

  sp.muteChannel('CONCOURSE');
  await drain();

  assert.deepEqual(dropped, ['concourse:muted']);
  assert.ok(!spoken.includes('Concourse ad.'), 'the muted channel must go quiet');
  assert.ok(spoken.includes('More station traffic.'), 'other channels keep transmitting');
});

test('muting a channel does not cut off a line sounding on another channel', async () => {
  const sp = makeSpeaker();
  sp.speak('Station traffic, sounding.', null, { bus: 'AMBIENT', channel: 'STATION' });
  sp.speak('Queued behind it.', null, { bus: 'AMBIENT', channel: 'STATION' });
  // Squelching a channel that is NOT the one currently sounding must not
  // abort it — that was a real bug: the abort fired regardless of channel.
  sp.muteChannel('CONCOURSE');
  await drain();
  assert.ok(spoken.includes('Station traffic.'.replace('.', ', sounding.')));
  assert.ok(spoken.includes('Queued behind it.'), 'the station queue must keep draining');
});

test('stop clears what has not started yet on both buses', async () => {
  const sp = makeSpeaker();
  sp.speak('Ambient first.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  sp.speak('Ambient queued.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  sp.speak('Priority first.');
  sp.speak('Priority queued.');
  // The two "first" lines are already sounding and cannot be un-said; the two
  // behind them must never start.
  sp.stop();
  await drain();
  assert.ok(!spoken.includes('Ambient queued.'));
  assert.ok(!spoken.includes('Priority queued.'));
});

test('voice disabled silences both buses', async () => {
  const settings = {
    voice: {
      enabled: false,
      engine: 'system',
      piperVoice: null,
      systemVoice: null,
      localVoicesOnly: true,
      rate: 1,
      volume: 80,
    },
  };
  const sp = new Speaker(() => settings as never);
  sp.speak('Nothing.');
  sp.speak('Also nothing.', null, { bus: 'AMBIENT', channel: 'LOCAL' });
  await drain();
  assert.equal(spoken.length, 0);
});

test('an unknown profile name does not stop the line being spoken', async () => {
  const sp = makeSpeaker();
  sp.speak('Still audible.', null, { bus: 'AMBIENT', channel: 'LOCAL', profile: 'nonsense' });
  await drain();
  assert.ok(spoken.includes('Still audible.'));
});

test('the default ttl is long enough to survive a normal queue wait', () => {
  assert.ok(DEFAULT_TTL_MS >= 30_000);
});

// ---------------------------------------------------------------------------
// Task 10.4: measure it, do not assume it
// ---------------------------------------------------------------------------

test('a hazard callout starts immediately under a heavy chatter load', async () => {
  const sp = makeSpeaker();

  // Saturate the ambient bus the way a busy station approach would: far more
  // traffic than the queue will hold, arriving faster than it can be spoken.
  for (let i = 0; i < 40; i++) {
    sp.speak(`Ambient filler line number ${i}.`, null, {
      bus: 'AMBIENT',
      channel: i % 2 ? 'STATION' : 'LOCAL',
    });
  }

  const before = spoken.length;
  sp.speak('Hull integrity critical.');
  // No drain() — nothing is allowed to finish. The callout must already have
  // been handed to the speech engine synchronously.
  assert.ok(
    spoken.slice(before).includes('Hull integrity critical.'),
    'the hazard callout was queued behind ambient traffic',
  );
  await drain(24);
});

test('ambient saturation is bounded — it never grows with the load', async () => {
  const sp = makeSpeaker();
  let dropped = 0;
  for (let i = 0; i < 200; i++) {
    sp.speak(`Line ${i}.`, null, {
      bus: 'AMBIENT',
      channel: 'LOCAL',
      onDrop: () => {
        dropped += 1;
      },
    });
  }
  await drain(30);
  // 200 in, a cap of 3 waiting: the overwhelming majority must be discarded
  // rather than played, and none of it may still be pending afterwards.
  assert.ok(dropped > 150, `only ${dropped} of 200 were dropped`);
});
