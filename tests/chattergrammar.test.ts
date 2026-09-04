/**
 * The grammar tier.
 *
 * The single most important assertion in this file is that a literal `<token>`
 * can never reach the air. Everything else is recoverable; broadcasting
 * "<stationname> control to <callsign>" is not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canBind,
  candidates,
  mergeGrammar,
  parseGrammar,
  render,
  tokensOf,
} from '../src/engine/chatter/grammar.ts';
import { BUNDLED_GRAMMAR } from '../src/engine/chatter/bundled-grammar.ts';
import { textureBrief, type Brief } from '../src/engine/chatter/brief.ts';
import { validateScene, sceneText, functionsForAct } from '../src/engine/chatter/scenes.ts';
import { CHANNEL_IDS, DRAMATIC_FUNCTIONS } from '../src/engine/chatter/types.ts';

const brief = (tokens: Record<string, string>, kind = 'texture'): Brief => ({
  ...textureBrief('test', tokens),
  kind: kind as Brief['kind'],
});

// ---------------------------------------------------------------------------
// The bundled grammar
// ---------------------------------------------------------------------------

const bundled = parseGrammar(BUNDLED_GRAMMAR, 'bundled');

test('the bundled grammar parses with no errors', () => {
  assert.deepEqual(bundled.errors, []);
  assert.ok(bundled.templates.length >= 50, `only ${bundled.templates.length} templates`);
});

test('the bundled grammar covers every channel', () => {
  for (const ch of CHANNEL_IDS) {
    const n = bundled.templates.filter((t) => t.channel === ch).length;
    assert.ok(n > 0, `no templates for channel ${ch}`);
  }
});

test('the bundled grammar covers every dramatic function', () => {
  for (const fn of DRAMATIC_FUNCTIONS) {
    const n = bundled.templates.filter((t) => t.func === fn).length;
    assert.ok(n > 0, `no templates with function ${fn}`);
  }
});

test('every act with functions has bundled templates to draw on', () => {
  for (const act of ['QUIET', 'BUILDING', 'AFTERMATH'] as const) {
    for (const fn of functionsForAct(act)) {
      assert.ok(
        bundled.templates.some((t) => t.func === fn),
        `act ${act} allows ${fn} but nothing provides it`,
      );
    }
  }
  assert.deepEqual(functionsForAct('CRISIS'), [], 'CRISIS must allow nothing');
});

test('the bundled pools are populated', () => {
  for (const name of ['ShipNamePool', 'GripePool', 'ShiftPool', 'CrewNamePool']) {
    assert.ok((bundled.pools[name]?.length ?? 0) > 2, `pool ${name} is thin`);
  }
});

test('every bundled multi-turn template uses at least two speakers', () => {
  for (const t of bundled.templates) {
    if (t.turns.length > 1) {
      assert.ok(
        new Set(t.turns.map((x) => x.speakerRef)).size >= 2,
        `line ${t.line}: one speaker across ${t.turns.length} turns`,
      );
    }
    assert.ok(t.turns.length <= 4, `line ${t.line}: too many turns`);
  }
});

test('texture templates never demand a factual token', () => {
  // A texture scene has no brief facts, so it must be fillable from pools
  // alone — otherwise the quiet channels have nothing to say.
  const empty = textureBrief('t');
  const texture = bundled.templates.filter((t) => t.func === 'texture' && !t.kinds.length);
  const fillable = texture.filter((t) => canBind(t, empty, bundled.pools));
  assert.ok(
    fillable.length >= 10,
    `only ${fillable.length} of ${texture.length} texture templates work with no facts`,
  );
});

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

test('a pool declaration collects its members', () => {
  const g = parseGrammar('@Names\nAlpha\nBeta\n', 'user');
  assert.deepEqual(g.pools.Names, ['Alpha', 'Beta']);
  assert.deepEqual(g.errors, []);
});

test('comments and blank lines are ignored', () => {
  const g = parseGrammar('# a comment\n\n@Names\nAlpha\n\n# another\n', 'user');
  assert.deepEqual(g.pools.Names, ['Alpha']);
  assert.deepEqual(g.errors, []);
});

test('a scene header with turns becomes a template', () => {
  const g = parseGrammar('LOCAL texture\n[a] One.\n[b] Two.\n', 'user');
  assert.equal(g.templates.length, 1);
  assert.equal(g.templates[0].channel, 'LOCAL');
  assert.equal(g.templates[0].func, 'texture');
  assert.equal(g.templates[0].turns.length, 2);
});

test('brief kinds can be declared on a header', () => {
  const g = parseGrammar('LOCAL complicate (market, faction)\n[a] One.\n', 'user');
  assert.deepEqual(g.templates[0].kinds, ['market', 'faction']);
});

// ---------------------------------------------------------------------------
// Malformed user files (task 5.5)
// ---------------------------------------------------------------------------

test('an unknown channel is reported and skipped, not fatal', () => {
  const g = parseGrammar('WIRELESS texture\n[a] Hello.\nLOCAL texture\n[b] Fine.\n', 'user');
  assert.equal(g.templates.length, 1, 'the good template must survive');
  assert.match(g.errors.join(' '), /unknown channel/);
});

test('an unknown dramatic function is reported and skipped', () => {
  const g = parseGrammar('LOCAL banter\n[a] Hello.\n', 'user');
  assert.equal(g.templates.length, 0);
  assert.match(g.errors.join(' '), /unknown dramatic function/);
});

test('a turn outside a scene header is reported', () => {
  const g = parseGrammar('[a] Orphaned line.\n', 'user');
  assert.match(g.errors.join(' '), /outside any scene header/);
});

test('a header with no turns is reported', () => {
  const g = parseGrammar('LOCAL texture\nLOCAL texture\n[a] Fine.\n', 'user');
  assert.match(g.errors.join(' '), /has no turns/);
  assert.equal(g.templates.length, 1);
});

test('a multi-turn template with one speaker is rejected', () => {
  const g = parseGrammar('LOCAL texture\n[a] One.\n[a] Two.\n', 'user');
  assert.equal(g.templates.length, 0);
  assert.match(g.errors.join(' '), /one speaker/);
});

test('a template with too many turns is rejected', () => {
  const g = parseGrammar('LOCAL texture\n[a] 1.\n[b] 2.\n[a] 3.\n[b] 4.\n[a] 5.\n', 'user');
  assert.equal(g.templates.length, 0);
  assert.match(g.errors.join(' '), /max 4/);
});

test('a malformed user file never stops the bundled grammar loading', () => {
  const broken = parseGrammar('!!! nonsense !!!\nWIRELESS whatever\n', 'user');
  const merged = mergeGrammar(bundled, broken);
  assert.ok(merged.templates.length >= bundled.templates.length);
  assert.ok(merged.errors.length > 0, 'errors must be surfaced, not swallowed');
});

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

test('user templates are added to the bundled set, not swapped for it', () => {
  const user = parseGrammar('LOCAL texture\n[a] Mine.\n', 'user');
  const merged = mergeGrammar(bundled, user);
  assert.equal(merged.templates.length, bundled.templates.length + 1);
});

test('a user pool of the same name extends rather than clobbers', () => {
  const user = parseGrammar('@ShipNamePool\nMy Own Ship\n', 'user');
  const merged = mergeGrammar(bundled, user);
  assert.ok(merged.pools.ShipNamePool.includes('My Own Ship'));
  assert.ok(merged.pools.ShipNamePool.includes('Iron Marlin'), 'bundled names must survive');
});

test('merging with no user grammar is a no-op', () => {
  assert.equal(mergeGrammar(bundled, null), bundled);
});

// ---------------------------------------------------------------------------
// Binding and rendering
// ---------------------------------------------------------------------------

test('tokensOf finds every token across turns', () => {
  const g = parseGrammar('LOCAL texture\n[a] <one> and <two>.\n[b] <three>.\n', 'user');
  assert.deepEqual(tokensOf(g.templates[0]).sort(), ['one', 'three', 'two']);
});

test('a template needing an unavailable token cannot bind', () => {
  const g = parseGrammar('LOCAL texture\n[a] Hello <station>.\n', 'user');
  assert.equal(canBind(g.templates[0], brief({}), {}), false);
  assert.equal(canBind(g.templates[0], brief({ station: 'Hurston Ring' }), {}), true);
});

test('a template whose kind does not match the brief cannot bind', () => {
  const g = parseGrammar('LOCAL complicate (market)\n[a] Hello.\n', 'user');
  assert.equal(canBind(g.templates[0], brief({}, 'faction'), {}), false);
  assert.equal(canBind(g.templates[0], brief({}, 'market'), {}), true);
});

test('rendering substitutes brief values', () => {
  const g = parseGrammar('LOCAL texture\n[a] <station> here.\n[b] Copy, <station>.\n', 'user');
  const scene = render(
    g.templates[0],
    brief({ station: 'Hurston Ring' }),
    {},
    () => 0,
    'id',
    60_000,
  );
  assert.ok(scene);
  assert.equal(scene.turns[0].text, 'Hurston Ring here.');
  assert.equal(scene.turns[1].text, 'Copy, Hurston Ring.');
});

test('a pool token resolves to the SAME value across a scene', () => {
  // Two ships answering the same hail with different names is worse than
  // no scene at all — this was a real bug in the first cut.
  const g = parseGrammar('LOCAL texture\n[a] This is <Ship>.\n[b] Copy, <Ship>.\n', 'user');
  const pools = { Ship: ['Alpha', 'Beta', 'Gamma', 'Delta'] };
  let calls = 0;
  const rand = (): number => {
    calls += 1;
    return calls / 10; // deliberately different on each call
  };
  const scene = render(g.templates[0], brief({}), pools, rand, 'id', 60_000);
  assert.ok(scene);
  const a = /This is (\w+)\./.exec(scene.turns[0].text)?.[1];
  const b = /Copy, (\w+)\./.exec(scene.turns[1].text)?.[1];
  assert.equal(a, b, 'the same token must name the same ship twice');
});

test('render returns null rather than emitting a literal token', () => {
  const g = parseGrammar('LOCAL texture\n[a] Hello <nothingHasThis>.\n', 'user');
  assert.equal(render(g.templates[0], brief({}), {}, () => 0, 'id', 60_000), null);
});

test('NO bundled template can ever render a literal token', () => {
  // The load-bearing assertion of the whole tier. Every bundled template, with
  // every token it declares supplied, must produce a scene that validates —
  // and validateScene rejects any residual <token>.
  let rendered = 0;
  for (const t of bundled.templates) {
    const tokens: Record<string, string> = {};
    for (const name of tokensOf(t)) {
      if (!bundled.pools[name]) tokens[name] = `Value${name}`;
    }
    const scene = render(
      t,
      brief(tokens, t.kinds[0] ?? 'texture'),
      bundled.pools,
      () => 0.5,
      `t${t.line}`,
      60_000,
    );
    assert.ok(scene, `line ${t.line} failed to render with all tokens supplied`);
    assert.equal(validateScene(scene), null, `line ${t.line}: ${validateScene(scene)}`);
    assert.ok(!/[<>]/.test(sceneText(scene)), `line ${t.line} leaked bracket syntax`);
    rendered += 1;
  }
  assert.equal(rendered, bundled.templates.length);
});

test('candidates filters by channel, function and brief', () => {
  const found = candidates(bundled, 'CREW', 'texture', textureBrief('t'));
  assert.ok(found.length > 0);
  assert.ok(found.every((t) => t.channel === 'CREW' && t.func === 'texture'));
});

test('candidates returns nothing when the brief cannot fill anything', () => {
  // A market-only function on a channel that has no market templates.
  const found = candidates(bundled, 'DEEP', 'reverse', textureBrief('t'));
  assert.deepEqual(found, []);
});

// ---------------------------------------------------------------------------
// Manifest and contract templates — the commander's business, overheard
// ---------------------------------------------------------------------------

import { contractBrief, manifestBrief } from '../src/engine/chatter/briefs.ts';
import type { Mission } from '../src/engine/types.ts';

const paxMission = (over: Partial<Mission> = {}): Mission => ({
  id: 7,
  internalName: 'Mission_PassengerBulk',
  title: '80 Tourists Seeking Transport',
  category: 'PassengerBulk',
  faction: 'Explorer on Tour',
  destination: { system: 'HIP 71120', station: "Wood's Pride" },
  reward: 1_837_840,
  wing: false,
  expiry: '2026-08-31T12:00:00Z',
  acceptedAt: '2026-08-30T10:00:00Z',
  passengers: { count: 80, type: 'Tourist', vip: false, wanted: false },
  steps: [],
  state: 'ACTIVE',
  redirected: false,
  killProgress: 0,
  raw: { timestamp: '2026-08-30T10:00:00Z', event: 'MissionAccepted' },
  ...over,
});

test('manifest templates exist for STATION, CONCOURSE and CREW and bind a real brief', () => {
  const b = manifestBrief([paxMission()])!;
  for (const ch of ['STATION', 'CONCOURSE', 'CREW'] as const) {
    const fit = bundled.templates.filter(
      (t) => t.channel === ch && t.kinds.includes('manifest') && canBind(t, b, bundled.pools),
    );
    assert.ok(fit.length > 0, `no bindable manifest template for ${ch}`);
    const scene = render(fit[0], b, bundled.pools, () => 0.5, 't', 60_000);
    assert.ok(scene);
    assert.match(sceneText(scene!), /80 Tourists/);
  }
});

test('contract templates exist for TOWER and LOCAL and bind a real brief', () => {
  const atDest = { location: { system: 'HIP 71120', station: "Wood's Pride" }, docked: true };
  const b = contractBrief(paxMission(), atDest, Date.parse('2026-08-30T12:00:00Z'))!;
  for (const ch of ['TOWER', 'LOCAL'] as const) {
    const fit = bundled.templates.filter(
      (t) => t.channel === ch && t.kinds.includes('contract') && canBind(t, b, bundled.pools),
    );
    assert.ok(fit.length > 0, `no bindable contract template for ${ch}`);
    const scene = render(fit[0], b, bundled.pools, () => 0.5, 't', 60_000);
    assert.ok(scene);
    assert.match(sceneText(scene!), /Explorer on Tour/);
  }
});

test('VIP- and WANTED-gated templates are skipped for an ordinary charter', () => {
  const plain = manifestBrief([paxMission()])!;
  const gated = bundled.templates.filter((t) =>
    tokensOf(t).some((n) => n === 'paxvip' || n === 'paxwanted'),
  );
  assert.ok(gated.length >= 2, 'expected gated templates in the bundle');
  for (const t of gated) {
    assert.equal(canBind(t, plain, bundled.pools), false, `line ${t.line} bound without the flag`);
  }
  const hot = manifestBrief([
    paxMission({ passengers: { count: 4, type: 'Refugee', vip: true, wanted: true } }),
  ])!;
  assert.ok(gated.some((t) => canBind(t, hot, bundled.pools)));
});

test('the local grievance line binds only when a target faction exists', () => {
  const atDest = { location: { system: 'HIP 71120' }, docked: false };
  const now = Date.parse('2026-08-30T12:00:00Z');
  const courier = contractBrief(paxMission(), atDest, now)!;
  const massacre = contractBrief(
    paxMission({ category: 'Massacre', targetFaction: "Brian's Thugs" }),
    atDest,
    now,
  )!;
  const grievance = bundled.templates.filter((t) => tokensOf(t).includes('targetfaction'));
  assert.ok(grievance.length > 0);
  for (const t of grievance) assert.equal(canBind(t, courier, bundled.pools), false);
  assert.ok(grievance.some((t) => canBind(t, massacre, bundled.pools)));
});
