/**
 * Boot smoke test — the HUD's store must survive being constructed.
 *
 * This exists because it didn't. A field added to the snapshot reached through
 * selectedMission(), which reads the LAST published snapshot — and the FIRST
 * build happens inside the constructor, where there is no last one. The
 * constructor threw, so the module-level `core` was never created, React never
 * mounted, and the app started as a window that painted nothing and answered
 * nothing. It type-checked, built, bundled and shipped into an installer,
 * because every one of those steps was happy: `this.snap` is typed non-optional
 * and the failure is purely an ordering one at runtime.
 *
 * Nothing here asserts behaviour. It asserts that the thing can exist, and that
 * the first snapshot — the one React renders before a single journal line has
 * been read — is coherent. That is the cheapest possible guard against an
 * entire class of "the app is frozen" bug.
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/** The handful of browser globals the store touches on the way up. */
before(() => {
  const bank = new Map<string, string>();
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
  // navigator is a getter-only global on modern Node.
  if (!('navigator' in globalThis)) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node' }, configurable: true });
  }
});

test('AppCore constructs and publishes a coherent first snapshot', async () => {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const snap = core.getSnapshot();

  // React reads this before anything has happened. Every field the HUD renders
  // unconditionally has to be present, or the first paint throws instead.
  assert.ok(snap, 'no snapshot');
  assert.deepEqual(snap.missions, []);
  assert.equal(snap.selectedId, null);
  assert.equal(snap.view, 'missions');
  assert.ok(snap.shipPanel, 'ship panel missing — it renders with no missions');
  assert.ok(snap.plotter, 'plotter view missing — the tab renders always');
  assert.equal(typeof snap.settings.voice.enabled, 'boolean');
});

test('the plotter opens empty, with a reason rather than a dead Plot button', async () => {
  const { AppCore } = await import('../src/ui/store.ts');
  const p = new AppCore().getSnapshot().plotter;
  assert.equal(p.route, null);
  assert.equal(p.idx, 0);
  assert.equal(p.busy, false);
  assert.equal(p.kind, 'ship');
  // No journal has been read, so there is no origin — and the card must say
  // why instead of offering a button that silently does nothing.
  assert.equal(p.from, null);
  assert.ok(p.fromNote && p.fromNote.length > 0, 'no explanation for the missing origin');
});

test('a snapshot survives being rebuilt — the constructor is not a special case', async () => {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const first = core.getSnapshot();
  // Any user action rebuilds it; the second build has a previous snapshot to
  // read, so it exercises the path the constructor could not.
  core.setPlotKind('carrier');
  const second = core.getSnapshot();
  assert.notEqual(first, second, 'snapshot identity must change or React will not re-render');
  assert.equal(second.plotter.kind, 'carrier');
  assert.equal(core.getSnapshot(), second, 'getSnapshot must be stable between emits');
});

// ---------------------------------------------------------------------------
// Comms defaults (tasks 12.3 / 12.4)
// ---------------------------------------------------------------------------

test('a fresh install transmits nothing until comms is enabled', async () => {
  const { DEFAULT_SETTINGS: DEFAULTS } = await import('../src/ui/settings.ts');
  assert.equal(DEFAULTS.comms.enabled, false, 'ambient traffic must be opt-in');
  assert.deepEqual(DEFAULTS.comms.mutedChannels, []);
});

test('the radio bus is on by default but changes nothing about WHETHER we speak', async () => {
  const { DEFAULT_SETTINGS: DEFAULTS } = await import('../src/ui/settings.ts');
  assert.equal(DEFAULTS.radio.enabled, true);
  assert.equal(DEFAULTS.radio.muted, false);
  // The operator's own voice stays unprocessed unless the commander picks a
  // channel for it — enabling the bus must not silently restyle the app.
  assert.equal(DEFAULTS.radio.operatorProfile, 'clean');
});

test('the flavor-story feature and comms traffic are separate settings', async () => {
  const { DEFAULT_SETTINGS: DEFAULTS } = await import('../src/ui/settings.ts');
  // Renaming `chatter` would silently reset existing users' preferences, so
  // the two live side by side and the docs disambiguate them.
  assert.equal(DEFAULTS.chatter.enabled, true, 'flavor stories are unchanged');
  assert.equal(DEFAULTS.comms.enabled, false, 'comms traffic is its own thing');
});
