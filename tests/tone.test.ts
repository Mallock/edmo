/**
 * A different register each time, on top of the same voice.
 *
 * The pools are COMPOSED — a register is a mood crossed with a lean, an angle is
 * crossed with a lede rule — and the pool sizes are coprime, so consecutive
 * rotations walk the whole cross product instead of cycling a short list. The
 * user's bar was "at least 50"; these pin that the composition actually clears
 * it, that every part of every pool is reachable, and that no line anywhere in
 * them restricts what may be said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COMMS_MOMENT_CYCLE,
  COMMS_REGISTER_CYCLE,
  NEWS_ANGLE_CYCLE,
  TONE_POOLS,
  commsAnchorLean,
  commsRegister,
  newsAngle,
  operatorAngle,
  sceneEnergy,
} from '../src/engine/tone.ts';
import { buildSceneChat, type SceneRequest } from '../src/engine/chatter/llm.ts';
import { buildStoryChat } from '../src/engine/news.ts';
import { textureBrief } from '../src/engine/chatter/brief.ts';

const req = (rotate: number): SceneRequest => ({
  channel: 'LOCAL',
  func: 'texture',
  act: 'QUIET',
  brief: textureBrief('t'),
  speakers: ['hauler', 'hauler2'],
  speakerNames: { hauler: 'A', hauler2: 'B' },
  rotate,
});

test('the composed register clears fifty distinct variants by a wide margin', () => {
  const seen = new Set<string>();
  for (let i = 0; i < COMMS_REGISTER_CYCLE; i++) seen.add(commsRegister(i));
  assert.equal(seen.size, COMMS_REGISTER_CYCLE, 'every composition must be distinct');
  assert.ok(COMMS_REGISTER_CYCLE >= 50, 'the whole point of composing the pools');

  const angles = new Set<string>();
  for (let i = 0; i < NEWS_ANGLE_CYCLE; i++) angles.add(newsAngle(i));
  assert.equal(angles.size, NEWS_ANGLE_CYCLE);
  assert.ok(NEWS_ANGLE_CYCLE >= 50);
});

test('pool sizes stay coprime, or the cross product collapses', () => {
  // 12 moods × 8 leans would repeat after lcm(12,8)=24, not 96 — the silent
  // failure mode of this design. Guard the arithmetic, not just the intent.
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  assert.equal(gcd(TONE_POOLS.COMMS_MOOD.length, TONE_POOLS.COMMS_LEAN.length), 1);
  assert.equal(gcd(TONE_POOLS.NEWS_ANGLE.length, TONE_POOLS.NEWS_LEDE.length), 1);
  assert.equal(
    COMMS_REGISTER_CYCLE,
    TONE_POOLS.COMMS_MOOD.length * TONE_POOLS.COMMS_LEAN.length,
  );
  // The moment axis must drift against BOTH register pools, or the same
  // situation always arrives with the same energy.
  assert.equal(gcd(TONE_POOLS.SCENE_ENERGY.length, TONE_POOLS.COMMS_MOOD.length), 1);
  assert.equal(gcd(TONE_POOLS.SCENE_ENERGY.length, TONE_POOLS.COMMS_LEAN.length), 1);
  assert.equal(gcd(TONE_POOLS.SCENE_ENERGY.length, TONE_POOLS.COMMS_ANCHOR.length), 1);
  assert.equal(COMMS_MOMENT_CYCLE, COMMS_REGISTER_CYCLE * TONE_POOLS.SCENE_ENERGY.length / gcd(COMMS_REGISTER_CYCLE, TONE_POOLS.SCENE_ENERGY.length));
});

test('the register/moment pair does not recur inside the composed cycle', () => {
  const pairs = new Set<string>();
  for (let i = 0; i < COMMS_MOMENT_CYCLE; i++) pairs.add(`${commsRegister(i)}|${sceneEnergy(i)}`);
  assert.equal(pairs.size, COMMS_MOMENT_CYCLE);
});

test('every mood, lean, angle, lede and anchor is reachable', () => {
  const walk = (fn: (r: number) => string, over: number): Set<string> => {
    const out = new Set<string>();
    for (let i = 0; i < over; i++) out.add(fn(i));
    return out;
  };
  // Walking one full cycle must surface every part of both parent pools.
  const registers = [...walk(commsRegister, COMMS_REGISTER_CYCLE)];
  for (const mood of TONE_POOLS.COMMS_MOOD) {
    assert.ok(registers.some((r) => r.startsWith(mood)), mood);
  }
  for (const lean of TONE_POOLS.COMMS_LEAN) {
    assert.ok(registers.some((r) => r.endsWith(lean)), lean);
  }
  assert.equal(walk(commsAnchorLean, TONE_POOLS.COMMS_ANCHOR.length).size,
    TONE_POOLS.COMMS_ANCHOR.length);
});

test('the anchor lean rotates independently of the register', () => {
  // If anchor and lean shared a period they would arrive in fixed pairs, and a
  // listener would learn the pairing. 12 against 11 and 13 keeps them drifting.
  const pairs = new Set<string>();
  for (let i = 0; i < 100; i++) pairs.add(`${commsAnchorLean(i)}|${commsRegister(i)}`);
  assert.ok(pairs.size >= 99, 'anchor and register must not travel together');
});

test('two comms prompts for one channel differ in register AND anchor', () => {
  const a = buildSceneChat(req(0))[1].content;
  const b = buildSceneChat(req(1))[1].content;
  assert.notEqual(a, b);
  assert.match(a, /REGISTER/);
  assert.match(a, /This time, prefer/);
});

test('two stories from one desk differ in their instructions', () => {
  const brief = ['SYSTEM: HIP 71120.'];
  const a = buildStoryChat(brief, 'civic', [], 'wry', 0)[1].content;
  const b = buildStoryChat(brief, 'civic', [], 'wry', 1)[1].content;
  assert.notEqual(a, b);
  assert.match(a, /ANGLE:/);
});

test('tone never touches what may be said', () => {
  // A register that smuggled in a fact, or licensed one, would be a fence in
  // disguise. These only say how to pitch it and which real part leads.
  for (const [name, pool] of Object.entries(TONE_POOLS)) {
    // The moment axis is deliberately terse noun-phrases ("awkward"), so it
    // gets a lower floor than the instruction pools.
    const floor = name === 'SCENE_ENERGY' ? 4 : 12;
    for (const line of pool) {
      assert.doesNotMatch(line, /may not|never name|only name|fact list|allowed to name/i, line);
      assert.ok(line.length > floor && line.length < 160, line);
    }
  }
});

test('rotation is safe at zero and below', () => {
  for (const fn of [commsRegister, commsAnchorLean, newsAngle, operatorAngle, sceneEnergy]) {
    assert.ok(fn(0).length > 0);
    assert.ok(fn(-7).length > 0);
  }
});

test('the moment line rides the comms prompt and rotates', () => {
  const a = buildSceneChat(req(0))[1].content;
  const b = buildSceneChat(req(1))[1].content;
  assert.match(a, /THE MOMENT — what kind of exchange this is: /);
  const moment = (s: string): string => /THE MOMENT[^\n]*/.exec(s)![0];
  assert.notEqual(moment(a), moment(b));
});
