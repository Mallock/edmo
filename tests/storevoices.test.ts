/**
 * The cast must be built from voices the engine that will speak them can say.
 *
 * The second half of "ai voices are now always the same". `speakEdge` ignoring
 * the persona was the loud half; this is the quiet one — the store handed the
 * chatter engine `piperVoiceList` no matter which engine was selected, so on
 * Edge every character was assigned a Piper voice name (`en_GB-alba-medium`)
 * that Microsoft's service has never heard of. Even once the speaker started
 * honouring personas, there was nothing usable in them to honour.
 *
 * Piper's pool is whatever the commander has installed, and is often a single
 * voice. Edge's is the live en-* catalogue, around ninety of them — which is
 * where the variety actually comes from.
 */
import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const bank = new Map<string, string>();
beforeEach(() => bank.clear());

before(() => {
  const g = globalThis as Record<string, unknown>;
  g.localStorage = {
    getItem: (k: string) => (bank.has(k) ? bank.get(k)! : null),
    setItem: (k: string, v: string) => void bank.set(k, String(v)),
    removeItem: (k: string) => void bank.delete(k),
  };
  g.window = { addEventListener() {}, removeEventListener() {} };
  g.document = { addEventListener() {}, removeEventListener() {} };
  g.speechSynthesis = { getVoices: () => [], cancel() {}, speak() {} };
  g.SpeechSynthesisUtterance = class {};
  g.Audio = class {
    play() {
      return Promise.resolve();
    }
  };
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', {
      value: { userAgent: 'node' },
      configurable: true,
    });
  }
});

interface Innards {
  settings: { voice: { engine: string } };
  piperVoiceList: string[];
  edgeVoiceList: string[];
  castVoicePool(): string[];
}

async function core(): Promise<Innards> {
  const { AppCore } = await import('../src/ui/store.ts');
  return new AppCore() as unknown as Innards;
}

test('on Piper, the cast draws on the installed local voices', async () => {
  const c = await core();
  c.settings.voice.engine = 'piper';
  c.piperVoiceList = ['en_GB-alba-medium', 'en_US-amy-low'];
  c.edgeVoiceList = ['en-GB-SoniaNeural'];
  assert.deepEqual(c.castVoicePool(), ['en_GB-alba-medium', 'en_US-amy-low']);
});

test('on Edge, the cast draws on the online catalogue instead', async () => {
  const c = await core();
  c.settings.voice.engine = 'edge';
  c.piperVoiceList = ['en_GB-alba-medium'];
  c.edgeVoiceList = ['en-GB-SoniaNeural', 'en-US-GuyNeural', 'en-AU-NatashaNeural'];
  assert.deepEqual(c.castVoicePool(), [
    'en-GB-SoniaNeural',
    'en-US-GuyNeural',
    'en-AU-NatashaNeural',
  ]);
});

test('an Edge catalogue that never arrived falls back rather than emptying the cast', async () => {
  // Offline, or the fetch failed. An empty pool would make resolvePersona mark
  // every character substituted for no reason, so the Piper list stands in
  // until the catalogue turns up on a later pass.
  const c = await core();
  c.settings.voice.engine = 'edge';
  c.piperVoiceList = ['en_GB-alba-medium'];
  c.edgeVoiceList = [];
  assert.deepEqual(c.castVoicePool(), ['en_GB-alba-medium']);
});

test('a real Edge catalogue gives the cast far more people than Piper can', async () => {
  // The point of the whole change: one installed Piper voice is one voice for
  // the entire cast, and personas differ only by timbre and quirk. The en-*
  // catalogue is the variety.
  const { buildPersonaPool } = await import('../src/engine/chatter/cast.ts');
  const piper = buildPersonaPool(['en_GB-alba-medium']);
  const edge = buildPersonaPool([
    'en-GB-SoniaNeural',
    'en-GB-RyanNeural',
    'en-US-GuyNeural',
    'en-US-JennyNeural',
    'en-AU-NatashaNeural',
    'en-IE-ConnorNeural',
  ]);
  assert.equal(edge.length, piper.length * 6);
  assert.equal(new Set(edge.map((p) => p.voice)).size, 6, 'six distinct voices to cast from');
});
