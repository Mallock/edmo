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
  adswizzUrl,
  parseAdswizzListenerId,
  stationById,
  stationForChapter,
  syntheticListenerId,
} from '../src/engine/stations.ts';
import type { ChapterKind } from '../src/engine/arc.ts';
import { musicGainDb, MUSIC_DUCK_PRIORITY_DB, MUSIC_DUCK_AMBIENT_DB } from '../src/engine/chatter/bus.ts';
import { readFileSync } from 'node:fs';

test('every station is playable and credited', () => {
  assert.ok(STATIONS.length >= 8, 'a dial worth having');
  const ids = new Set<string>();
  for (const s of STATIONS) {
    assert.ok(!ids.has(s.id), `duplicate id ${s.id}`);
    ids.add(s.id);
    assert.match(s.url, /^https?:\/\//, s.id);
    assert.ok(s.label.length > 2 && s.blurb.length > 8, s.id);
    assert.ok(
      [
        'SomaFM', 'Fallout.FM', 'Nightride FM', 'Radio Paradise', '181.FM',
        'Bauer Media Finland', 'Radio Helsinki', 'Järviradio', 'Yle',
      ].includes(s.source),
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
  // The Finnish block is grouped by COUNTRY, not by sound, so it has to stay
  // whole — an insert that split Radio City from Suomirock would leave two
  // orphans in the middle of a genre scale they do not belong to.
  contiguous([
    'yleklassinen', 'yleradio1', 'ylex', 'ylex3m', 'ylevega', 'ylesami', 'yleradiosuomi',
    'radiohelsinki', 'radiocity', 'suomirock', 'radio957', 'radionova',
    'kasari', 'ysari', 'bassoradio', 'iskelma', 'jarviradio',
  ]);
  // Yle leads it, quiet end first, the way the whole dial is ordered.
  assert.ok(at('yleklassinen') < at('ylex'), 'classical should lead the Yle run');
  assert.ok(at('ylesami') < at('radiocity'), 'the public broadcaster leads the commercial dial');
  // And it sits at the bottom, beside the other by-country oddity.
  assert.ok(at('doomed') < at('yleklassinen'), 'the Finnish block sits after the genre scale');
  assert.ok(at('jarviradio') < at('gnr'), 'Galaxy News Radio keeps the last slot');
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

test('the Finnish block is Finnish, HTTPS, and credited to whoever broadcasts it', () => {
  // Asked for as "city radio rock etc.". These pin the INTENT the way the
  // genre-coverage test above does: city radio, rock, the two decade channels
  // and the Finnish-language ends of hip hop and iskelmä.
  const suomi = [
    'yleklassinen', 'yleradio1', 'ylex', 'ylex3m', 'ylevega', 'ylesami', 'yleradiosuomi',
    'radiohelsinki', 'radiocity', 'suomirock', 'radio957', 'radionova',
    'kasari', 'ysari', 'bassoradio', 'iskelma', 'jarviradio',
  ];
  for (const id of suomi) {
    const s = stationById(id);
    assert.ok(s, `${id} left the Finnish dial`);
    assert.match(s!.url, /^https:/, `${id} must be HTTPS`);
    assert.ok(
      ['Bauer Media Finland', 'Radio Helsinki', 'Järviradio', 'Yle'].includes(s!.source),
      `${id} is credited to a Finnish broadcaster`,
    );
  }
});

test('a notice-loop host is only ever used with an AdsWizz session', () => {
  // Bauer's mounts pass every liveness check while playing "jatka kuuntelua
  // osoitteessa Radioplay" on a loop to any client without an ad session.
  // Station directories list them as live, because by every measure a
  // directory takes they are. So: the bare URL of a Bauer station is the
  // notice, and only adswizzUrl() turns it into the broadcast. A station on
  // one of those hosts WITHOUT the session config would loop in someone's
  // headphones with every test green — this is the test that goes red.
  for (const s of STATIONS) {
    if (/radioplay\.fi|sharp-stream\.com/.test(s.url)) {
      assert.ok(s.adswizz, `${s.id} is on a notice-loop host with no AdsWizz session`);
      assert.ok(!s.url.includes('streaming.radioplay.fi'), `${s.id} is on the withdrawn host`);
    }
  }
});

test('the Bauer stations are MP3 on the host their player uses, with the session config', () => {
  const bauer = STATIONS.filter((s) => s.source === 'Bauer Media Finland');
  assert.ok(bauer.length >= 8, 'the commercial Finnish dial');
  for (const s of bauer) {
    assert.equal(s.url, `https://live-bauerfi.sharp-stream.com/fi_${s.id}_128.mp3?direct=true`, s.id);
    assert.deepEqual(s.adswizz, { first: 'bauer', playerId: 'BMUK_inpage_html5' }, s.id);
    // No CORS from that host, so outside the relay these play direct.
    assert.equal(s.routable, false, `${s.id} sends no CORS header`);
  }
});

test('adswizzUrl appends exactly the measured minimum, and leaves other stations alone', () => {
  // Measured one parameter at a time against Bauer's edge: listenerid alone
  // loops, listenerid + playerid loops, this set plays the broadcast. The
  // TCF consent string their web player sends is NOT needed — and not sent,
  // since gdpr=true at registration already means non-personalised ads.
  const rc = stationById('radiocity')!;
  const url = new URL(adswizzUrl(rc, 'abc123def456abc123def456abc123de', 1_788_560_184_000));
  assert.equal(url.origin + url.pathname, 'https://live-bauerfi.sharp-stream.com/fi_radiocity_128.mp3');
  assert.equal(url.searchParams.get('direct'), 'true');
  assert.equal(url.searchParams.get('listenerid'), 'abc123def456abc123def456abc123de');
  assert.equal(url.searchParams.get('aw_0_1st.bauer_listenerid'), 'abc123def456abc123def456abc123de');
  assert.equal(url.searchParams.get('aw_0_1st.playerid'), 'BMUK_inpage_html5');
  assert.equal(url.searchParams.get('aw_0_1st.skey'), '1788560184');
  assert.equal(url.searchParams.get('aw_0_1st.bauer_loggedin'), 'false');
  assert.equal(url.searchParams.has('aw_0_req.userConsentV2'), false, 'no consent string');
  // A station without the config is returned untouched.
  const ylex = stationById('ylex')!;
  assert.equal(adswizzUrl(ylex, 'abc123def456abc123def456abc123de'), ylex.url);
});

test('a synthetic listener id has the shape AdsWizz issues', () => {
  // The edge accepts a made-up id (measured: it is skey that opens the
  // gate), so registration failing falls back to one of these rather than
  // to silence. Same 32 hex characters, so nothing downstream can tell.
  const seq = [0, 0.5, 0.999, 0.25];
  let i = 0;
  const id = syntheticListenerId(() => seq[i++ % seq.length]);
  assert.match(id, /^[0-9a-f]{32}$/);
  assert.equal(id.slice(0, 4), '08f4');
  assert.match(syntheticListenerId(), /^[0-9a-f]{32}$/);
});

test('the listener id is read out of register2.php exactly as their player reads it', () => {
  const body =
    "var com_adswizz_register_PROTOCOL_VERSION = '2.2.0';if (typeof com_adswizz_synchro_listenerid === 'undefined') {" +
    "    var com_adswizz_synchro_listenerid = '5543bc67ef2d35d3814f34e8549e2424';}else {    com_adswizz_synchro_listenerid = '5543bc67ef2d35d3814f34e8549e2424';}";
  assert.equal(parseAdswizzListenerId(body), '5543bc67ef2d35d3814f34e8549e2424');
  assert.equal(parseAdswizzListenerId('<html>blocked</html>'), null);
  assert.equal(parseAdswizzListenerId(''), null);
});

test('the two CORS-clean Finnish stations route without the relay', () => {
  // Radio Helsinki and Järviradio both answer with Access-Control-Allow-Origin,
  // so they duck by bus automation even in a bare browser.
  for (const id of ['radiohelsinki', 'jarviradio']) {
    assert.equal(stationById(id)!.routable, true, `${id} sends CORS and should route`);
  }
});

test('the Yle channels point at the public broadcaster and route without the relay', () => {
  // Yle answers with permissive CORS on every mount, which makes these the
  // cleanest streams on the dial — they duck by bus automation even in a bare
  // browser. Yle Puhe is deliberately absent: it is not on this icecast host
  // under any mount name, only as HLS, which the audio element cannot take.
  const want = [
    ['yleklassinen', 'YleKlassinen'],
    ['yleradio1', 'YleRadio1'],
    ['ylex', 'YleX'],
    ['ylex3m', 'YleX3M'],
    ['ylevega', 'YleVega'],
    ['ylesami', 'YleSami'],
    ['yleradiosuomi', 'YleRS'],
  ];
  for (const [id, mount] of want) {
    const s = stationById(id);
    assert.ok(s, `${id} left the dial`);
    assert.equal(s!.url, `https://icecast.live.yle.fi/radio/${mount}/icecast.audio`, id);
    assert.equal(s!.source, 'Yle', id);
    assert.equal(s!.routable, true, `${id} sends CORS and must route`);
  }
  assert.equal(stationById('ylepuhe'), undefined, 'Yle Puhe is HLS-only and cannot be played');
});

test('the Linux package declares the decoder the Yle channels need', () => {
  // Measured in a bookworm container: with GStreamer's base and good plugin
  // sets alone, decodebin refuses Yle outright — "Missing decoder: MPEG-4 AAC"
  // — and every Yle channel dies as "the station did not answer". The .deb
  // therefore depends on gstreamer1.0-libav. This test exists because that
  // link is invisible: nothing in stations.ts mentions packaging, and a
  // well-meaning tidy of the bundle config would silence a seventh of the
  // Finnish dial on Linux with no test failing.
  const cfg = JSON.parse(
    readFileSync(new URL('../src-tauri/tauri.linux.conf.json', import.meta.url), 'utf8'),
  ) as { bundle: { linux: { deb: { depends: string[] } } } };
  const depends = cfg.bundle.linux.deb.depends;
  const needsAac = STATIONS.some((s) => s.source === 'Yle');
  if (needsAac) {
    assert.ok(
      depends.includes('gstreamer1.0-libav'),
      'AAC stations are on the dial, so the .deb must pull a GStreamer AAC decoder',
    );
  }
});
