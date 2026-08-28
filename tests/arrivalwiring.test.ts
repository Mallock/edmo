/**
 * Docking has to actually put something on the air.
 *
 * ports.test.ts proves the memory and the greeting; this proves the store
 * fires them, which is the half that was missing. The port memory shipped
 * without a trigger and the result was exactly nothing on air: scenes are
 * chosen by a round-robin over whichever channels are open, so the greeting
 * sat in the briefing waiting for a STATION scene that had no particular
 * reason to arrive. Two real dockings produced no welcome at all.
 *
 * Departures were not handled anywhere.
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

const line = (ts: string, o: Record<string, unknown>) =>
  JSON.stringify({ timestamp: `3312-08-27T${ts}Z`, ...o });

const dockedAt = (ts: string, station: string) =>
  line(ts, {
    event: 'Docked',
    StationName: station,
    StarSystem: 'HIP 71120',
    StationType: 'Coriolis',
    StationFaction: { Name: 'Explorer on Tour' },
  });

interface Innards {
  bootstrapped: boolean;
  onLines(lines: string[], live: boolean): void;
  pendingArrival: { kind: string; station: string; at: number } | null;
  arrivalGreeting: string | null;
  pendingTower: { moment: string; station: string; pad: number | null; reason: string | null } | null;
  ownShipName(): string;
  ports: { get(name: string): { visits: number } | null };
}

async function bootedCore(history: string[]) {
  const { AppCore } = await import('../src/ui/store.ts');
  const core = new AppCore();
  const c = core as unknown as Innards;
  c.onLines(history, false);
  c.bootstrapped = true;
  return c;
}

test('docking claims a scene instead of hoping one turns up', async () => {
  const c = await bootedCore([]);
  c.onLines([dockedAt('20:00:00', 'Benyovszky Gateway')], true);
  assert.ok(c.pendingArrival, 'a docking must claim the next station scene');
  assert.equal(c.pendingArrival!.kind, 'arrive');
  assert.equal(c.pendingArrival!.station, 'Benyovszky Gateway');
});

test('undocking claims one too — departures were handled nowhere', async () => {
  const c = await bootedCore([]);
  c.onLines([dockedAt('20:00:00', 'Mikels Town')], true);
  c.onLines([line('20:10:00', { event: 'Undocked', StationName: 'Mikels Town' })], true);
  assert.equal(c.pendingArrival?.kind, 'depart');
  assert.equal(c.pendingArrival?.station, 'Mikels Town');
});

test('the greeting knows a first arrival from a return', async () => {
  const c = await bootedCore([]);
  c.onLines([dockedAt('20:00:00', 'Joy Vista')], true);
  assert.match(c.arrivalGreeting!, /never docked here before/);

  // Second time at the same port, the record is no longer empty — and it is
  // read BEFORE this arrival is counted, so it says "once", not "twice".
  c.onLines([line('21:00:00', { event: 'Undocked', StationName: 'Joy Vista' })], true);
  c.onLines([dockedAt('22:00:00', 'Joy Vista')], true);
  assert.match(c.arrivalGreeting!, /once before/);
  assert.equal(c.ports.get('Joy Vista')?.visits, 2, 'both dockings are on file');
});

test('the visit history survives a restart', async () => {
  const first = await bootedCore([]);
  first.onLines([dockedAt('20:00:00', 'Anders City')], true);
  first.onLines([dockedAt('21:00:00', 'Anders City')], true);
  // A new store, same storage — the whole point of persisting the memory.
  const again = await bootedCore([]);
  assert.equal(again.ports.get('Anders City')?.visits, 2);
});

test('the tower calls this ship by name when the game clears it', async () => {
  // The complaint that started this: station comms were talking to OTHER
  // ships. The tower channel is the one that addresses the commander, and it
  // fires on the real docking events rather than on a cadence — a clearance
  // is a reply to something you just did.
  const c = await bootedCore([]);
  c.onLines(
    [
      line('19:59:00', {
        event: 'Loadout',
        Ship: 'type8',
        ShipName: 'Stardust Runner',
        ShipIdent: 'MA-22P',
        CargoCapacity: 400,
      }),
      line('20:00:00', {
        event: 'DockingGranted',
        StationName: 'Benyovszky Gateway',
        LandingPad: 24,
      }),
    ],
    true,
  );
  assert.equal(c.pendingTower?.moment, 'granted');
  assert.equal(c.pendingTower?.pad, 24, 'the pad is the one the game assigned, never invented');
  assert.equal(c.pendingTower?.station, 'Benyovszky Gateway');
  assert.equal(c.ownShipName(), 'Stardust Runner', 'the tower needs a name to call');
});

test('a refusal is the tower speaking too, with the reason', async () => {
  const c = await bootedCore([]);
  c.onLines(
    [line('20:00:00', { event: 'DockingDenied', StationName: 'V6W-TTJ', Reason: 'RestrictedAccess' })],
    true,
  );
  assert.equal(c.pendingTower?.moment, 'denied');
  assert.ok(c.pendingTower?.reason, 'a refusal without a reason is no use to anybody');
});

test('the tower is silent unless the commander gave it something to answer', async () => {
  // The live fault: the tower hailed a ship in open space about a pad it had
  // invented. Weight 0 did not stop it, because the scheduler picks the open
  // channel with the fewest scenes in flight — and an idle tower always won
  // that comparison. It must be SHUT until a docking event opens it.
  const { evaluateChannel } = await import('../src/engine/chatter/channels.ts');
  const base = {
    nowMs: 1_000_000,
    act: 'BUILDING' as const,
    density: 'normal' as const,
    pressure: 0.5,
    onFoot: false,
    resolvedPorts: 4,
    portSeparationLs: 50,
    carrierPresent: false,
    population: 38_000_000,
    hasCrew: true,
    lastTransmitAt: {},
    mutedChannels: new Set<never>(),
    emergencyBriefReady: false,
    towerCallPending: false,
  };
  const quiet = evaluateChannel('TOWER', base as never);
  assert.equal(quiet.open, false, 'an idle tower must not hail anybody');
  if (!quiet.open) assert.equal(quiet.reason, 'nothing-to-say');

  // And it opens the moment there is a clearance to give.
  const called = evaluateChannel('TOWER', { ...base, towerCallPending: true } as never);
  assert.equal(called.open, true);
});

test('an open tower actually wins the lottery, rather than being unpickable', async () => {
  // The second half of the live fault. selectChannel picks by weighted
  // lottery; TOWER shipped with weight 0, so `roll -= 0` never fired and it
  // could never be chosen to transmit. A clearance could be written and then
  // sit in its slot unheard — which is exactly what a docking at a
  // construction site produced: the journal had DockingGranted with pad 3,
  // and the air had nothing.
  const { selectChannel } = await import('../src/engine/chatter/channels.ts');
  const ctx = {
    nowMs: 1_000_000,
    act: 'BUILDING' as const,
    density: 'normal' as const,
    pressure: 0.5,
    onFoot: false,
    resolvedPorts: 4,
    portSeparationLs: 50,
    carrierPresent: false,
    population: 38_000_000,
    hasCrew: true,
    lastTransmitAt: {},
    mutedChannels: new Set<never>(),
    emergencyBriefReady: false,
    towerCallPending: true,
  };
  // Deterministic rolls across the whole range: the tower should dominate,
  // because when it is open it is answering the commander directly.
  let towerWins = 0;
  for (let i = 0; i < 20; i++) {
    const r = () => i / 20;
    if (selectChannel(ctx as never, r)?.id === 'TOWER') towerWins++;
  }
  assert.ok(towerWins > 10, `tower won only ${towerWins}/20 rolls`);

  // With nothing pending it is shut, so it can never be picked.
  let quietWins = 0;
  for (let i = 0; i < 20; i++) {
    const r = () => i / 20;
    if (selectChannel({ ...ctx, towerCallPending: false } as never, r)?.id === 'TOWER') quietWins++;
  }
  assert.equal(quietWins, 0, 'a silent tower must be unpickable');
});

test('the write claim must not close the tower before the scene is heard', async () => {
  // THE LIVE FAULT this pins: the tower went quiet again, and not the way
  // 1.9.2 did. The clearance is written perfectly well and then has nowhere to
  // go, because writing it is what closes the channel.
  //
  // TOWER is the only channel whose openness is a property of the STORE rather
  // than of the world: `towerCallPending` is just "is pendingTower still set".
  // maybeWriteComms spends that claim the instant it hands the scene to the
  // writer — deliberately, so a scene that never arrives cannot hold the
  // channel hostage for ninety seconds. That is right for STATION, which is
  // open whether or not anybody docked. For TOWER it is fatal: the writer takes
  // seconds, the scene lands in its slot on a LATER tick, and by then the
  // channel is shut and selectChannel only ever picks from open ones. The
  // scene then rots in its slot for its full 150 s TTL.
  //
  // The observable that gives it away on the air: the tower is always one
  // docking behind, because the next clearance is what reopens the channel and
  // the stale scene is sitting there ready to go.
  const { evaluateChannel, selectChannel } = await import('../src/engine/chatter/channels.ts');
  const ctx = {
    nowMs: 1_000_000,
    act: 'BUILDING' as const,
    density: 'normal' as const,
    pressure: 0.5,
    onFoot: false,
    resolvedPorts: 4,
    portSeparationLs: 50,
    carrierPresent: false,
    population: 38_000_000,
    hasCrew: true,
    lastTransmitAt: {},
    mutedChannels: new Set<never>(),
    emergencyBriefReady: false,
    towerCallPending: true,
    towerWrittenOnly: false,
  };

  // 1. A clearance claims the tower, and the channel opens.
  const c = await bootedCore([]);
  c.onLines(
    [
      line('19:59:00', { event: 'Loadout', Ship: 'type8', ShipName: 'Stardust Runner' }),
      line('20:00:00', {
        event: 'DockingGranted',
        StationName: 'Benyovszky Gateway',
        LandingPad: 24,
      }),
    ],
    true,
  );
  assert.ok(c.pendingTower, 'a clearance claims the tower');
  const store = c as unknown as {
    pendingTower: { writing?: boolean } | null;
    commsContext(): { towerCallPending: boolean };
    maybeWriteComms(n: number, act: string, ch: unknown[], briefs: unknown[]): void;
    speakComms(t: unknown): void;
  };
  assert.equal(store.commsContext().towerCallPending, true);

  // 2. THE REGRESSION. Drive the REAL write path — not a simulation of it —
  //    and require the channel to still be open afterwards, because the scene
  //    it just started writing has not arrived yet, let alone been heard.
  //    Before the fix this asserted false: maybeWriteComms nulled the claim on
  //    the way in, and `towerCallPending` is nothing but "is that claim set".
  const guts = c as unknown as {
    lmOk: boolean;
    activeModel(): string | null;
    runCommsWrite(plan: unknown): Promise<void>;
    maybeWriteComms(n: number, act: string, ch: unknown[], briefs: unknown[]): void;
  };
  guts.lmOk = true;
  guts.activeModel = () => 'gemma-4-e4b';
  // Stop at the point of dispatch: the claim decision is all this is testing,
  // and a real generation needs an engine.
  guts.runCommsWrite = () => Promise.resolve();

  const towerOpen = { id: 'TOWER', open: true, strength: 1, degrade: 0 };
  guts.maybeWriteComms(Date.now(), 'BUILDING', [towerOpen], []);

  assert.ok(store.pendingTower, 'the writer must not throw the call away');
  assert.equal(store.pendingTower!.writing, true, 'it is marked as being written');
  assert.equal(
    store.commsContext().towerCallPending,
    true,
    'writing the clearance must not shut the channel it is written for',
  );
  assert.equal(
    evaluateChannel('TOWER', { ...ctx, towerCallPending: true } as never).open,
    true,
    'the scene now in flight must have an open channel to arrive on',
  );

  // 3. And a shut tower really is unreachable, which is why step 2 matters:
  //    there is no second chance once the channel closes.
  const afterWrite = evaluateChannel('TOWER', { ...ctx, towerCallPending: false } as never);
  assert.equal(afterWrite.open, false);
  let picked = 0;
  for (let i = 0; i < 40; i++) {
    const r = () => (i + 0.5) / 40;
    if (selectChannel({ ...ctx, towerCallPending: false } as never, r)?.id === 'TOWER') picked++;
  }
  assert.equal(picked, 0, 'a shut tower can never transmit the scene it just wrote');

  // The invariant the fix has to restore: the commander is still on approach
  // and still waiting to be told which pad, so the tower must stay reachable
  // until the scene has actually been heard.
  assert.equal(
    evaluateChannel('TOWER', ctx as never).open,
    true,
    'a tower with something still unsaid must be open',
  );
});

test('undocking does not speak the arrival line that was still in the slot', async () => {
  // THE LIVE FAULT, from a screenshot: the commander undocked and the tower
  // said "O7 to the commander, welcome back to Heisenberg Depot; watch the
  // last bit of traffic clear, you're cleared to approach now."
  //
  // The undock was read correctly — it sets a 'departure' call, and always
  // did. What went out was the PREVIOUS scene: a tower slot holds a written
  // clearance for 150 s, so docking and undocking inside that window leaves
  // the arrival line sitting ready when the departure opens the channel, and
  // `buildScene` takes whatever is ready. The clock cannot catch it; the scene
  // is seconds old. Only the event that changed the moment knows.
  const c = await bootedCore([]);
  const store = c as unknown as {
    pendingTower: { moment: string; station: string } | null;
    comms: { sceneSlots: { reserve(k: string, by: number): void; count(k: string): number } };
  };
  const slots = store.comms.sceneSlots;

  c.onLines(
    [
      line('19:59:00', { event: 'Loadout', Ship: 'type8', ShipName: 'Stardust Runner' }),
      line('20:00:00', {
        event: 'DockingGranted',
        StationName: 'Heisenberg Depot',
        LandingPad: 12,
      }),
    ],
    true,
  );
  assert.equal(store.pendingTower?.moment, 'granted');

  // The arrival clearance gets written and is sitting ready to speak.
  slots.reserve('channel:TOWER', Date.now() + 150_000);
  assert.equal(slots.count('channel:TOWER'), 1, 'an arrival line is held');

  // Now the commander leaves, well inside the slot's life.
  c.onLines([line('20:01:00', { event: 'Undocked', StationName: 'Heisenberg Depot' })], true);

  assert.equal(store.pendingTower?.moment, 'departure', 'the undock is what the tower is about');
  assert.equal(
    slots.count('channel:TOWER'),
    0,
    'the arrival line must be binned, not spoken to a departing ship',
  );
});

test('a second clearance for the same moment and port keeps what is already written', async () => {
  // The discard is for a CHANGED moment. Re-stating the same call must not
  // throw away the scene being written for it, or a repeated event would keep
  // the tower permanently starting over and it would never say anything.
  const c = await bootedCore([]);
  const store = c as unknown as {
    comms: { sceneSlots: { reserve(k: string, by: number): void; count(k: string): number } };
  };
  const slots = store.comms.sceneSlots;
  c.onLines(
    [line('20:00:00', { event: 'DockingGranted', StationName: 'Joy Vista', LandingPad: 4 })],
    true,
  );
  slots.reserve('channel:TOWER', Date.now() + 150_000);
  c.onLines(
    [line('20:00:10', { event: 'DockingGranted', StationName: 'Joy Vista', LandingPad: 4 })],
    true,
  );
  assert.equal(slots.count('channel:TOWER'), 1, 'the same call keeps its scene');
});
