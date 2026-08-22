/**
 * Piper recovery behaviour in the Speaker.
 *
 * Ambient comms should not stay silent for a whole session after one transient
 * Piper failure. This test pins the cooldown retry path in `Speaker.say`.
 */
import { beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';

const g = globalThis as Record<string, unknown>;

// `isTauri` is computed at module load from this marker.
g.window = {
  __TAURI_INTERNALS__: {},
  addEventListener() {},
  removeEventListener() {},
};
g.localStorage = {
  getItem: () => null,
  setItem() {},
  removeItem() {},
};

const { Speaker } = await import('../src/ui/tts.ts');

function makeSpeaker(): InstanceType<typeof Speaker> {
  const settings = {
    voice: {
      enabled: true,
      engine: 'piper',
      piperVoice: null,
      systemVoice: null,
      localVoicesOnly: true,
      rate: 1,
      volume: 80,
    },
    radio: {
      enabled: true,
      operatorProfile: 'clean',
      muted: false,
    },
    comms: {
      volume: 70,
    },
  };
  return new Speaker(() => settings as never);
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
}

beforeEach(() => {
  // Keep tests isolated from any browser-level speech globals.
  delete (g as { speechSynthesis?: unknown }).speechSynthesis;
  delete (g as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
});

test('piper is retried after cooldown instead of staying disabled forever', async () => {
  const sp = makeSpeaker() as unknown as {
    piperOk: boolean;
    piperRetryAt: number;
    speak: (text: string, voice?: string | null, opts?: Record<string, unknown>) => void;
    speakPiper: (...args: unknown[]) => Promise<void>;
    speakSystem: (...args: unknown[]) => Promise<void>;
  };

  let piperCalls = 0;
  let systemCalls = 0;

  sp.speakPiper = async () => {
    piperCalls += 1;
    throw new Error('transient piper failure');
  };
  sp.speakSystem = async () => {
    systemCalls += 1;
  };

  sp.speak('first', null, { bus: 'AMBIENT', channel: 'CREW' });
  await flush();

  assert.equal(piperCalls, 1, 'first line tries piper');
  assert.equal(systemCalls, 1, 'failed piper falls back to system');
  assert.equal(sp.piperOk, false, 'piper is marked unavailable during cooldown');

  // Force the retry window open and send another line.
  sp.piperRetryAt = Date.now() - 1;
  sp.speak('second', null, { bus: 'AMBIENT', channel: 'CREW' });
  await flush();

  assert.equal(piperCalls, 2, 'piper is retried after cooldown');
  assert.equal(systemCalls, 2, 'fallback still protects audibility');
});

