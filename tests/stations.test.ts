/**
 * The dial: the station list and what the work puts on.
 *
 * Every URL here was checked live when it was added; these tests pin the
 * things that rot silently — a station with no stream, an id that stopped
 * matching the now-playing endpoint, a chapter that falls off the mapping and
 * leaves the radio playing whatever was on before.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_STATION,
  STATIONS,
  stationById,
  stationForChapter,
} from '../src/engine/stations.ts';
import type { ChapterKind } from '../src/engine/arc.ts';
import { musicGainDb, MUSIC_DUCK_PRIORITY_DB, MUSIC_DUCK_AMBIENT_DB } from '../src/engine/chatter/bus.ts';

test('every station is playable and credited', () => {
  assert.ok(STATIONS.length >= 8, 'a dial worth having');
  const ids = new Set<string>();
  for (const s of STATIONS) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.url, /^https?:\/\//, s.id);
    assert.ok(s.label.length > 2 && s.blurb.length > 8, s.id);
    assert.ok(
      ['SomaFM', 'Fallout.FM', 'Nightride FM', 'Radio Paradise', '181.FM'].includes(s.source),
      `${s.id} has no credited source`,
    );
    // A routable station is one we can duck properly; it must be HTTPS, since
    // the CORS routing that makes it routable rides on the secure origin.
    if (s.routable) assert.match(s.url, /^https:/, s.id);
  }
});

test('the SomaFM now-playing endpoint matches the stream id', () => {
  // The two are derived from one id on purpose — a mismatch would show the
  // wrong song under the right station, which is worse than showing none.
  for (const s of STATIONS.filter((x) => x.source === 'SomaFM')) {
    assert.equal(s.track?.kind, 'somafm', `${s.id} lost its now-playing endpoint`);
    assert.match(s.track!.url, new RegExp(`/songs/${s.id}\\.json$`), s.id);
    assert.match(s.url, new RegExp(`/${s.id}-`), s.id);
  }
});

test('every Nightride station names the channel its metadata arrives under', () => {
  // One event stream carries all of them, so the channel is what picks the
  // right row out. Get it wrong and the HUD shows a real track from the wrong
  // station — the failure that looks like it is working.
  const ride = STATIONS.filter((x) => x.source === 'Nightride FM');
  assert.ok(ride.length >= 4, 'the cyberpunk end of the dial');
  for (const s of ride) {
    assert.equal(s.track?.kind, 'nightride', s.id);
    assert.equal((s.track as { channel: string }).channel, s.id, s.id);
    assert.match(s.url, new RegExp(`/${s.id}\\.mp3$`), s.id);
    assert.ok(s.routable, `${s.id} sends CORS, so it must route and duck properly`);
  }
});

test('the dial covers the genres it claims to', () => {
  // Added on request: rap/hip-hop, R&B/soul, industrial and cyberpunk. These
  // pin the INTENT — if one of these stations is ever dropped, the coverage
  // it was carrying should be a deliberate decision, not a quiet loss.
  const has = (id: string) => assert.ok(stationById(id), `${id} left the dial`);
  has('fluid'); // instrumental hip-hop / trap
  has('oldschool'); // 90s hip hop, the golden age
  has('7soul'); // vintage soul
  has('truerb'); // R&B
  has('doomed'); // dark industrial
  has('ebsm'); // electronic body music
  has('nightride'); // synthwave
  has('darksynth'); // cyberpunk, harder
  has('defcon'); // music for hacking
  has('rprock'); // rock
  has('eagle'); // classic rock
  has('indiepop'); // indie pop
  has('kickincountry'); // modern country
  has('highway'); // classic country
  has('bootliquor'); // americana
});

test('the dial is ordered as a scale, not as a list', () => {
  // The tuning dial is a slide-rule: scanning one way should get quieter and
  // the other way darker. That only holds if neighbours belong together, so
  // the ambient end, the country block and the dark end must each stay
  // contiguous — an alphabetical sort or a careless insert would scatter them.
  const at = (id: string) => STATIONS.findIndex((s) => s.id === id);
  const contiguous = (ids: string[]) => {
    const idx = ids.map(at).sort((a, b) => a - b);
    assert.ok(idx[0] >= 0, `unknown station in ${ids.join(',')}`);
    assert.equal(idx[idx.length - 1] - idx[0], ids.length - 1, `${ids.join(',')} is not contiguous`);
  };
  contiguous(['deepspaceone', 'missioncontrol', 'spacestation', 'dronezone', 'synphaera']);
  contiguous(['kickincountry', 'highway', 'bootliquor']);
  contiguous(['nightride', 'darksynth', 'datawave', 'ebsm']);
  // And the quiet end really is the quiet end.
  assert.ok(at('deepspaceone') < at('oldschool'), 'ambient should sit before hip hop');
  assert.ok(at('rprock') < at('doomed'), 'rock should sit before the dark end');
});

test('every chapter tunes to a station that exists', () => {
  const chapters: Array<ChapterKind | null> = [
    'hauling', 'mining', 'exobiology', 'passenger runs',
    'bounty hunting', 'community-goal work', 'exploring', null,
  ];
  for (const c of chapters) {
    const id = stationForChapter(c);
    assert.ok(stationById(id), `${c} tunes to unknown station ${id}`);
  }
  // The black gets ambient and the hauls get rock — the mapping's whole point
  // is that it is unsurprising.
  assert.equal(stationForChapter('exploring'), 'deepspaceone');
  assert.equal(stationForChapter('mining'), 'dronezone');
  assert.equal(stationForChapter('hauling'), 'seventies');
  assert.equal(stationForChapter(null), DEFAULT_STATION);
  assert.ok(stationById(DEFAULT_STATION), 'the default must exist');
});

test('music ducks under the operator harder than under comms', () => {
  // The two mean different things: the operator must not be missed, comms is
  // atmosphere and only thins the radio.
  assert.equal(musicGainDb(0, false, false), 0);
  assert.equal(musicGainDb(0, false, true), MUSIC_DUCK_AMBIENT_DB);
  assert.equal(musicGainDb(0, true, false), MUSIC_DUCK_PRIORITY_DB);
  // Both sounding: the deeper duck wins, or a callout over chatter would
  // leave the radio sitting at the shallower level.
  assert.equal(musicGainDb(0, true, true), MUSIC_DUCK_PRIORITY_DB);
  assert.ok(MUSIC_DUCK_PRIORITY_DB < MUSIC_DUCK_AMBIENT_DB);
  // Ducking is relative to wherever the commander left the slider.
  assert.equal(musicGainDb(-6, true, false), -6 + MUSIC_DUCK_PRIORITY_DB);
});

test('the listen.fm additions point at 181.FM mounts that exist', () => {
  // These were asked for as listen.fm links. listen.fm is an aggregator whose
  // own backend (tp.andresamaya.co) no longer resolves, and its slugs are
  // 181.FM channel names — so they are wired to the upstream source directly,
  // through the one81 helper this dial already had. Each mount was checked
  // against 181.FM's own catalogue and answered audio/mpeg.
  const want: Array<[string, string]> = [
    ['classical', '181-classical'],
    ['90sdance', '181-90sdance'],
    ['hairband', '181-hairband'],
    ['power181', '181-powerexplicit'],
    ['thebeat', '181-beat'],
  ];
  for (const [id, mount] of want) {
    const s = stationById(id);
    assert.ok(s, `${id} is on the dial`);
    assert.equal(s!.url, `https://listen.181fm.com/${mount}_128k.mp3`);
    assert.equal(s!.source, '181.FM');
    assert.equal(s!.routable, true, 'the relay routes these like the other 181 mounts');
  }
});

test('the explicit channel says so in its blurb', () => {
  // Power 181 [E] is 181.FM's uncensored feed. The picker is one line per
  // station, so that line is the only warning a commander gets before it
  // starts playing over the game.
  assert.match(stationById('power181')!.blurb, /explicit/i);
});
