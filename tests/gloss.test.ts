/**
 * The model is not a crystal ball — the data explains its own nouns.
 *
 * These pin the glossary layer every voice shares: signals carry a note
 * saying what the thing IS (with the ORDER that keeps a tourist beacon from
 * being called the nav stop), unknown kinds stay bare rather than guessed
 * at, and the faction-state gloss normalises the journal's code words,
 * dedupes, caps, and stays silent when nothing on the board needs a note.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeSignal, stateGlossary } from '../src/engine/gloss.ts';

const sig = (name: string, type?: string) => ({ name, type, isStation: false });

test('a beacon is the navigation stop, described as boring on purpose', () => {
  // Salience is an attractor: a vivid note made the model break the beacon
  // for drama. The note is as short and dull as it can be.
  assert.match(describeSignal(sig('Henry Beacon')), /routine navigation stop/);
  assert.match(describeSignal(sig('Nav Beacon')), /routine navigation stop/);
});

test('the note order tells beacons apart', () => {
  assert.match(describeSignal(sig('Tourist Beacon 0711')), /sightseeing plaque/);
  assert.doesNotMatch(describeSignal(sig('Tourist Beacon 0711')), /navigation stop/);
  assert.match(describeSignal(sig('Compromised Nav Beacon')), /overrun by pirates/);
});

test('extraction sites split by hazard', () => {
  assert.match(describeSignal(sig('Resource Extraction Site [Hazardous]')), /no security patrols/);
  assert.match(describeSignal(sig('Resource Extraction Site [High]')), /patrolled mining spot/);
});

test('a nameless signal falls back to its journal type', () => {
  assert.match(describeSignal(sig('Unregistered Comms Buoy', 'NavBeacon')), /navigation stop/);
  assert.match(describeSignal(sig('Sightseer Marker', 'TouristBeacon')), /sightseeing plaque/);
});

test('an unknown signal stays bare — no guessed notes', () => {
  assert.equal(describeSignal(sig('Ancient Ruins')), 'Ancient Ruins');
  assert.equal(describeSignal(sig('Odd Thing', 'SomeNewType')), 'Odd Thing');
});

test('state gloss explains only what is present, once each, capped', () => {
  const g = stateGlossary(['Expansion', 'expansion', 'CivilUnrest', 'Civil unrest', 'None', undefined]);
  assert.ok(g);
  assert.match(g!, /^\(state meanings: /);
  assert.equal(g!.match(/Expansion/g)?.length, 1);
  assert.equal(g!.match(/pushing into a neighbouring system/g)?.length, 1);
  assert.match(g!, /protests and crime/);
  assert.doesNotMatch(g!, /None/);
  const capped = stateGlossary(['Boom', 'Bust', 'War', 'Election', 'Famine', 'Drought']);
  assert.equal(capped!.split(';').length, 4);
});

test('a board with no notable states gets no line at all', () => {
  assert.equal(stateGlossary([]), null);
  assert.equal(stateGlossary(['None', undefined, 'SomethingUnheardOf']), null);
});
