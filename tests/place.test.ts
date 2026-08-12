/**
 * Where the commander is — and so who the operator is.
 *
 * The persona hardcoded two things in every prompt: that the commander
 * "operates in the COLONIA REGION", and that the operator sits in "a cramped
 * comms office on Jaques Station — twenty years flying these lanes". Both were
 * true of the machine they were written on. Both were also the ONLY concrete
 * place-nouns the model ever received, so it kept reaching for them; the
 * commander's report was that it "just babbles about only one thing, station
 * and lanes".
 *
 * Coordinates were available the whole time — FSDJump, Location and CarrierJump
 * all carry StarPos — and were being discarded.
 *
 * Anchor coordinates below are verified against live system data, not memory.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  COLONIA,
  MAIA,
  SOL,
  distanceLy,
  loreForPlace,
  operatorPost,
  placeFacts,
  placeOf,
  postPlaces,
  regionChanged,
  type Coords,
} from '../src/engine/place.ts';

// Real coordinates, from the commander's own run and live market data.
const TIR: Coords = { x: -9532.9375, y: -923.4375, z: 19799.125 };
const EOL_PROU: Coords = { x: -9528.84375, y: -913.25, z: 19809.3125 };
const DEEP: Coords = { x: -5000, y: 200, z: 40000 }; // out past everything
const BEAGLE: Coords = { x: -1111.5625, y: -134.21875, z: 65269.75 };

// ------------------------------------------------------------------ geometry

test('distance is plain Euclidean light-years', () => {
  assert.equal(Math.round(distanceLy(SOL, SOL)), 0);
  assert.equal(Math.round(distanceLy(SOL, COLONIA)), 22000);
  // Tir really is a near neighbour of Colonia.
  assert.equal(Math.round(distanceLy(TIR, COLONIA)), 16);
});

// ---------------------------------------------------------------- the region

test("the commander's actual systems classify as Colonia", () => {
  assert.equal(placeOf('Tir', TIR).region, 'colonia');
  assert.equal(placeOf('Eol Prou LW-L c8-127', EOL_PROU).region, 'colonia');
  assert.equal(placeOf('Colonia', COLONIA).regionName, 'the Colonia Region');
});

test('the Bubble and the Pleiades are their own places', () => {
  assert.equal(placeOf('Sol', SOL).region, 'bubble');
  assert.equal(placeOf('Deciat', { x: 122.6, y: -0.8, z: -47.1 }).region, 'bubble');
  assert.equal(placeOf('Maia', MAIA).region, 'pleiades');
});

test('everything else is deep space, with the nearest anchor named', () => {
  const deep = placeOf('Somewhere', DEEP);
  assert.equal(deep.region, 'deep');
  assert.ok(deep.nearest);
  assert.ok(deep.lyFromSol! > 1000);
  // Deep space is its own place. Naming it after the nearest anchor announced
  // Beagle Point as "in the Colonia Region", 46,000 ly from Colonia.
  assert.equal(deep.regionName, 'deep space');
  assert.equal(placeOf('Beagle Point', BEAGLE).regionName, 'deep space');
  assert.doesNotMatch(placeFacts(placeOf('Beagle Point', BEAGLE))!, /Beagle Point, in the Colonia/);

  const beagle = placeOf('Beagle Point', BEAGLE);
  assert.equal(beagle.region, 'deep');
  assert.equal(Math.round(beagle.lyFromSol!), 65279);
});

test('without coordinates nothing is assumed — the old bug in one assertion', () => {
  const p = placeOf('Tir', null);
  assert.equal(p.region, 'unknown');
  assert.equal(p.lyFromSol, null);
  // It must NOT claim Colonia, which is exactly what the hardcoded primer did.
  assert.doesNotMatch(loreForPlace(p), /COLONIA REGION/);
  assert.match(loreForPlace(p), /has not been established yet/);
});

// ---------------------------------------------------------- what it produces

test('the setting primer follows the commander', () => {
  assert.match(loreForPlace(placeOf('Tir', TIR)), /COLONIA REGION/);
  assert.match(loreForPlace(placeOf('Sol', SOL)), /CORE SYSTEMS/);
  assert.match(loreForPlace(placeOf('Maia', MAIA)), /PLEIADES/);
  const deep = loreForPlace(placeOf('Somewhere', DEEP));
  assert.match(deep, /DEEP SPACE/);
  assert.match(deep, /No stations, no factions/);
});

test("the operator's post follows the region, and never invents a station", () => {
  assert.match(operatorPost(placeOf('Tir', TIR)), /Jaques Station/);
  // Away from Colonia it must NOT still be sitting on Jaques Station.
  const bubble = operatorPost(placeOf('Sol', SOL));
  assert.doesNotMatch(bubble, /Jaques/);
  assert.match(bubble, /a station in the core systems/);
  // Deep space keeps the operator put and makes the distance the point.
  const deep = operatorPost(placeOf('Somewhere', DEEP));
  assert.doesNotMatch(deep, /Jaques/);
  assert.match(deep, /only voice reaching them/);
});

test('only real landmarks are declared to the fabrication guard', () => {
  assert.deepEqual(postPlaces(placeOf('Tir', TIR)), ['Jaques Station']);
  assert.deepEqual(postPlaces(placeOf('Sol', SOL)), []);
  assert.deepEqual(postPlaces(placeOf('Somewhere', DEEP)), []);
});

test('the per-beat facts give it something concrete that is not the office', () => {
  const facts = placeFacts(placeOf('Tir', TIR))!;
  assert.match(facts, /WHERE THIS RUN IS: Tir, in the Colonia Region/);
  assert.match(facts, /21,994 ly from Sol/);
  const deep = placeFacts(placeOf('Somewhere', DEEP))!;
  assert.match(deep, /nearest inhabited space is/);
  // Nothing is claimed when position is unknown.
  assert.equal(placeFacts(placeOf('Tir', null)), null);
});

test('Colonia does not report its distance to itself', () => {
  assert.doesNotMatch(placeFacts(placeOf('Colonia', COLONIA))!, /from Colonia/);
});

// ------------------------------------------------------- prompt rebuild rule

test('only crossing a region boundary rebuilds the persona', () => {
  const tir = placeOf('Tir', TIR);
  const eol = placeOf('Eol Prou LW-L c8-127', EOL_PROU);
  // Two systems, same region: 44 carrier jumps inside Colonia must not churn
  // the prompt (and throw away the conversation) on every hop.
  assert.equal(regionChanged(tir, eol), false);
  assert.equal(regionChanged(tir, placeOf('Sol', SOL)), true);
  assert.equal(regionChanged(null, tir), true); // first fix of the session
});
