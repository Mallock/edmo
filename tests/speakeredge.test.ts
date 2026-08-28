/**
 * On the Edge engine, every character must sound like a different person.
 *
 * The live complaint: "ai voices are now always the same". They were, and
 * exactly: `speakEdge` read `settings.voice.edgeVoice` unconditionally and
 * never looked at `utt.voice`, which is the persona the cast system spent all
 * its effort assigning. Traffic control, both haulers, the crew and the
 * concourse PA all came out of one voice.
 *
 * The other half of the same fault lived in the store, which handed the cast
 * `piperVoiceList` whatever the engine was — so on Edge the personas named
 * voices the service has never heard of. Both halves are pinned: this file
 * covers the speaker, storevoices.test.ts covers the pool.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;

/**
 * The synthesiser is stubbed at the Tauri IPC seam.
 *
 * ES module bindings are read-only, so `bridge.edgeSpeak` cannot be swapped
 * out. It bottoms out in `invoke('edge_speak', ...)`, and @tauri-apps/api
 * dispatches that through this object — which is also the marker `isTauri`
 * reads, so one stub does both jobs.
 */
const edgeCalls: EdgeCall[] = [];
g.window = {
  __TAURI_INTERNALS__: {
    invoke: (cmd: string, args: Record<string, unknown>) => {
      if (cmd === 'edge_speak') {
        edgeCalls.push({ voice: args.voice as string, rate: args.rate as number });
        return Promise.resolve(new ArrayBuffer(0));
      }
      return Promise.reject(new Error(`unstubbed command ${cmd}`));
    },
    transformCallback: (cb: unknown) => cb,
  },
  addEventListener() {},
  removeEventListener() {},
};
g.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

interface EdgeCall {
  voice: string;
  rate: number;
}

const { Speaker } = await import('../src/ui/tts.ts');

function makeSpeaker(): InstanceType<typeof Speaker> {
  const settings = {
    voice: {
      enabled: true,
      engine: 'edge',
      edgeVoice: 'en-GB-SoniaNeural',
      edgeRate: 20,
      piperVoice: null,
      systemVoice: null,
      localVoicesOnly: false,
      rate: 1,
      volume: 80,
    },
    radio: { enabled: true, operatorProfile: 'clean', muted: false },
    comms: { volume: 70 },
  };
  return new Speaker(() => settings as never);
}

/** Drive speakEdge directly with a stubbed synthesiser. */
async function say(
  utt: Record<string, unknown>,
): Promise<EdgeCall> {
  const sp = makeSpeaker() as unknown as {
    speakEdge(u: unknown, s: unknown, bus: string): Promise<void>;
    wavCache: { get(k: string): unknown; set(k: string, v: unknown): void };
    radio: { available: boolean };
  };
  edgeCalls.length = 0;
  // The cache would hide a second call, and the radio bus needs an
  // AudioContext — neither is what this test is about.
  sp.wavCache = { get: () => undefined, set: () => undefined };
  sp.radio = { available: false } as never;
  try {
    const s = {
      voice: { edgeVoice: 'en-GB-SoniaNeural', edgeRate: 20, volume: 80 },
      comms: { volume: 70 },
    };
    await sp.speakEdge({ text: 'hello', profile: null, ...utt }, s, 'AMBIENT');
  } catch {
    // playBytes has no audio device here; the synth call is what matters and
    // it has already been recorded.
  }
  assert.equal(edgeCalls.length, 1, 'the synthesiser was called exactly once');
  return edgeCalls[0];
}

test('a comms speaker is voiced by their persona, not by the settings voice', async () => {
  const call = await say({ voice: 'en-AU-NatashaNeural' });
  assert.equal(
    call.voice,
    'en-AU-NatashaNeural',
    'the persona voice must reach the synthesiser — this is the bug',
  );
});

test('two different personas are two different voices', async () => {
  const a = await say({ voice: 'en-US-GuyNeural' });
  const b = await say({ voice: 'en-IE-ConnorNeural' });
  assert.notEqual(a.voice, b.voice, 'the cast must not collapse into one speaker');
});

test('the operator, which carries no persona, keeps the configured voice', async () => {
  const call = await say({ voice: undefined });
  assert.equal(call.voice, 'en-GB-SoniaNeural');
});

test('timbre survives the crossing from Piper to Edge', async () => {
  // Piper takes timbre as a length scale where ABOVE one is slower, so it has
  // to invert into Edge's rate percentage or the same character would speed up
  // on one engine and slow down on the other.
  const slow = await say({ voice: 'en-US-GuyNeural', timbre: 1.06 });
  const flat = await say({ voice: 'en-US-GuyNeural', timbre: 1.0 });
  const fast = await say({ voice: 'en-US-GuyNeural', timbre: 0.94 });
  assert.ok(slow.rate < flat.rate, 'a 1.06 timbre reads slower');
  assert.ok(fast.rate > flat.rate, 'a 0.94 timbre reads faster');
  assert.equal(flat.rate, 20, 'a neutral timbre is the configured rate exactly');
  // A nudge, not a costume.
  assert.ok(Math.abs(slow.rate - flat.rate) <= 10);
});

test('rate stays inside what the service accepts, whatever the timbre', async () => {
  const call = await say({ voice: 'en-US-GuyNeural', timbre: 3 });
  assert.ok(call.rate >= -50 && call.rate <= 100, `rate ${call.rate} is out of range`);
});
