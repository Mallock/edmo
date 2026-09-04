/**
 * The dial — internet radio the commander can have on while they work.
 *
 * Every other voice in this app is generated; this one is simply *there*, the
 * way a radio is there in a lorry cab. It exists because the game's long
 * stretches — a Colonia haul, an hour in the rings — are exactly the hours
 * people put music on for.
 *
 * TWO PLAYBACK MODES, and the difference is CORS, not preference. A station
 * that sends `Access-Control-Allow-Origin` can be routed through the app's own
 * audio graph (radio.ts), which means it DUCKS properly: down hard under the
 * operator, thinner under comms traffic, back up after. A station that does
 * not can still be played — straight out of an audio element — but ducking
 * there is a volume ramp on the element rather than a bus automation. Both
 * work; only one is precise. Every URL below was checked live on 2026-08-27,
 * stream and metadata alike — see scripts/stations-check.ts.
 *
 * SomaFM is listener-supported and publishes both a channel directory and
 * direct stream links for exactly this purpose; Nightride FM, which carries
 * the synthwave and industrial end of the dial, is the same kind of operation.
 * If this feature earns its keep, the donate links in Settings are not
 * decoration.
 *
 * THE FINNISH BLOCK sits outside the genre scale, at the bottom beside Galaxy
 * News Radio, because it is organised by country rather than by sound — a
 * commander looking for it is looking for Finland, not for a tempo. Yle, the
 * public broadcaster, leads it; the commercial dial follows.
 *
 * Yle is the only AAC on this dial, and that cost a packaging change rather
 * than a shrug. Measured in a bookworm container: with GStreamer's base and
 * good plugin sets alone, decodebin refuses the stream outright —
 * `Missing decoder: MPEG-4 AAC` — so on Linux every Yle channel would have
 * failed with "the station did not answer" and no clue why. Adding
 * `gstreamer1.0-libav` to the .deb's depends (tauri.linux.conf.json) fixes it,
 * verified by the same pipeline then streaming happily. Windows is unaffected:
 * the caps say AAC-LC rather than HE-AAC, which WebView2 decodes natively.
 *
 * The AppImage cannot declare dependencies, so it borrows the host's GStreamer.
 * A desktop with the usual media plugins plays Yle; a very bare one will show
 * the station's error line. That is the honest limit of a portable bundle, and
 * it is why the rest of the Finnish block is deliberately MP3.
 */

/** ChapterKind from arc.ts, duplicated as a type-only import would cycle. */
import type { ChapterKind } from './arc.ts';

/**
 * How the current track is read.
 *
 * A union rather than a bare URL because the two hosts answer in genuinely
 * different ways, and a lone `nowPlayingUrl` would let a station claim an
 * endpoint the player has no idea how to parse. SomaFM serves a per-channel
 * JSON document that can be polled; Nightride pushes every channel down one
 * server-sent-event stream, so the track arrives when it changes rather than
 * up to half a minute later.
 */
export type TrackFeed =
  | { kind: 'somafm'; url: string }
  | { kind: 'nightride'; url: string; channel: string }
  | { kind: 'radioparadise'; url: string };

export interface RadioStation {
  id: string;
  label: string;
  /** One line for the picker — what it actually sounds like. */
  blurb: string;
  url: string;
  /**
   * True when the stream sends permissive CORS, so it can be routed into the
   * app's audio graph and ducked properly. False means direct playback.
   */
  routable: boolean;
  /** Where the current track can be read, when the host publishes one. */
  track?: TrackFeed;
  /** Who to credit, shown in Settings beside the picker. */
  source:
    | 'SomaFM'
    | 'Fallout.FM'
    | 'Nightride FM'
    | 'Radio Paradise'
    | '181.FM'
    | 'Bauer Media Finland'
    | 'Radio Helsinki'
    | 'Järviradio'
    | 'Yle';
  /**
   * The stream is served only to an ad-insertion session — see adswizzUrl().
   * The station's URL alone plays a notice; the player must register a
   * listener with AdsWizz and carry the id on every request.
   */
  adswizz?: AdswizzSession;
}

/** What an AdsWizz-gated stream needs appended to its URL. */
export interface AdswizzSession {
  /** The broadcaster's first-party prefix — `aw_0_1st.<first>_listenerid`. */
  first: string;
  /** The player identity their edge expects, e.g. `BMUK_inpage_html5`. */
  playerId: string;
}

/** Where a listener id is issued. Answers with JavaScript that assigns the id. */
export const ADSWIZZ_REGISTER_URL = 'https://synchrobox.adswizz.com/register2.php?aw_0_req.gdpr=true';

/** Pull the listener id out of register2.php's JavaScript reply, or null. */
export function parseAdswizzListenerId(body: string): string | null {
  const m = /com_adswizz_synchro_listenerid\s*=\s*'([0-9a-f]{16,64})'/i.exec(body);
  return m ? m[1] : null;
}

/**
 * A listener id of the same shape AdsWizz issues — 32 hex characters — for
 * when registration cannot be reached. The edge accepts it (measured), so an
 * ad network being down does not take the station down with it.
 */
export function syntheticListenerId(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < 32; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}

/**
 * The URL a gated station actually plays from.
 *
 * Measured against Bauer's edge, one parameter at a time: `listenerid` alone
 * plays the notice; so does `listenerid` with the player id; drop `skey` and
 * the notice is back. The set below plays the broadcast, on the MP3 mount as
 * well as the AAC one, without the TCF consent string their web player also
 * sends. `skey` is a Unix timestamp — a session key, not a signature, and
 * the parameter that actually opens the gate. The id itself is not checked
 * against AdsWizz: a made-up one passes. Registration is still done first
 * because it is how their listener is counted and served the way their own
 * app's are — the deal behind carrying their adverts at all — but a failed
 * registration falls back to syntheticListenerId() rather than to silence.
 * `aw_0_req.gdpr=true` at registration means non-personalised ads, which is
 * the only kind this app can consent to on a commander's behalf.
 */
export function adswizzUrl(station: RadioStation, listenerId: string, nowMs = Date.now()): string {
  const s = station.adswizz;
  if (!s) return station.url;
  const sep = station.url.includes('?') ? '&' : '?';
  const p = new URLSearchParams({
    listenerid: listenerId,
    [`aw_0_1st.${s.first}_listenerid`]: listenerId,
    'aw_0_1st.playerid': s.playerId,
    'aw_0_1st.skey': String(Math.floor(nowMs / 1000)),
    [`aw_0_1st.${s.first}_loggedin`]: 'false',
  });
  return `${station.url}${sep}${p.toString()}`;
}

/** The `-128-mp3` mount is the highest-quality MP3 SomaFM publishes. */
const soma = (
  id: string,
  label: string,
  blurb: string,
): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://ice1.somafm.com/${id}-128-mp3`,
  routable: true,
  track: { kind: 'somafm', url: `https://somafm.com/songs/${id}.json` },
  source: 'SomaFM',
});

/**
 * Nightride FM — the cyberpunk end of the dial.
 *
 * Every channel is MP3 with permissive CORS, so they route into the graph and
 * duck exactly like SomaFM's. Metadata for ALL channels comes down a single
 * event stream, which is why the feed carries the channel name: the player
 * subscribes once and keeps the row that belongs to whatever is on.
 */
const nightride = (id: string, label: string, blurb: string): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://stream.nightride.fm/${id}.mp3`,
  routable: true,
  track: { kind: 'nightride', url: 'https://nightride.fm/meta', channel: id },
  source: 'Nightride FM',
});

/**
 * Radio Paradise — listener-supported, no adverts, and the best-sounding
 * stream on this dial at 192 kbps. Its now-playing API answers with NO CORS
 * header, so the track name arrives through the relay or not at all; the
 * station still names itself either way.
 */
const paradise = (
  id: string,
  chan: number,
  label: string,
  blurb: string,
): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://stream.radioparadise.com/${id === 'rpmain' ? 'mp3-192' : `${id.slice(2)}-192`}`,
  routable: true,
  track: { kind: 'radioparadise', url: `https://api.radioparadise.com/api/now_playing?chan=${chan}` },
  source: 'Radio Paradise',
});

/**
 * 181.FM — the format radio of the dial: classic rock, country, old-school
 * hip hop, R&B. No public now-playing endpoint worth relying on, so these
 * announce themselves by name, which is what a dial does anyway.
 */
const one81 = (id: string, mount: string, label: string, blurb: string): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://listen.181fm.com/${mount}_128k.mp3`,
  routable: true,
  source: '181.FM',
});

/**
 * Bauer Media Finland — Radio City, Suomirock, Bassoradio, Radio Nova, Radio
 * 957, Kasari, Ysäri, Iskelmä — as an AdsWizz session, adverts and all.
 *
 * The record, because every station directory still lists these as live and
 * by every measure a directory takes they are. The bare mounts — on
 * streaming.radioplay.fi and on this host, MP3 and AAC alike — pass every
 * check: 200, audio/mpeg, bytes flowing, a healthy waveform out of a real
 * audio element. The audio is a discontinuation notice on a loop, "jatka
 * kuuntelua osoitteessa Radioplay", served to every client that is not their
 * own player: the app's User-Agent, a browser, VLC, with or without a
 * radioplay.fi Referer. No test that asks "is there sound?" can tell it from
 * a broadcast, and byte comparison cannot either, because the notice is
 * re-encoded live. What can: decode ninety seconds and autocorrelate the
 * loudness envelope — r = 1.00 at a 92.5 s period, identical across all
 * eight stations, against 0.42 for SomaFM. scripts/stream-loop-check.mjs.
 *
 * Their player (rayo.fi) gets the broadcast because it registers a listener
 * with AdsWizz and carries the session on the stream URL; adswizzUrl() above
 * reproduces the smallest set of parameters that opens the gate, measured
 * one at a time. That makes this app one more AdsWizz-registered player, and
 * the stream that comes back carries Bauer's adverts. Product decision, Mika,
 * 2026-09-05: "ads are okay". The relay still identifies the app honestly;
 * what changed is that the listener is now counted and served the way their
 * own app's listeners are.
 *
 * `_128.mp3` exists for every station here and plays under the session; the
 * `_prem.aac` tier is only 68 kbps HE-AAC, so MP3 is both the safer codec and
 * the better sound. `?direct=true` is what their player sends. No CORS, so
 * `routable` is false and in a bare browser these play out of the direct
 * element; inside the app the relay makes them same-origin like the rest.
 */
const bauerfi = (id: string, mount: string, label: string, blurb: string): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://live-bauerfi.sharp-stream.com/fi_${mount}_128.mp3?direct=true`,
  routable: false,
  source: 'Bauer Media Finland',
  adswizz: { first: 'bauer', playerId: 'BMUK_inpage_html5' },
});

/**
 * Yle — Finland's public broadcaster, no adverts, funded by the Yle tax.
 *
 * Every channel answers with permissive CORS, so these route into the graph
 * and duck properly even without the relay — the cleanest streams on the dial
 * in that respect. AAC-LC rather than MP3; see the module comment for what
 * that cost on Linux and how it is paid.
 *
 * Yle Puhe is absent because it is not on this icecast host under any mount
 * name — it is published as HLS, which the audio element cannot take.
 */
const yle = (id: string, mount: string, label: string, blurb: string): RadioStation => ({
  id,
  label,
  blurb,
  url: `https://icecast.live.yle.fi/radio/${mount}/icecast.audio`,
  routable: true,
  source: 'Yle',
});

/**
 * The curated dial. Not all 46 SomaFM channels — the ones a commander would
 * actually leave on, in the order the picker shows them.
 *
 * Order is stable on purpose: the ambient and rock end first, because that is
 * what most of the game's long hours want, then the harder and stranger
 * channels, then Galaxy News Radio on its own at the bottom. New stations are
 * appended within their block rather than sorted in, so nobody's dial
 * rearranges itself under them between versions.
 */
export const STATIONS: readonly RadioStation[] = [
  // — the quiet end of the scale
  soma('deepspaceone', 'Deep Space One', 'Deep ambient and space music — for the black'),
  soma('missioncontrol', 'Mission Control', 'Ambient, cut with real NASA mission audio'),
  soma('spacestation', 'Space Station Soma', 'Spaced-out ambient and mid-tempo electronica'),
  soma('dronezone', 'Drone Zone', 'Atmospheric textures with minimal beats'),
  soma('synphaera', 'Synphaera Radio', 'Modern space ambient from an indie label'),
  one81('classical', '181-classical', 'Classical Music', 'The standard repertoire, played straight — for a long plot'),
  // — downtempo and electronic
  soma('groovesalad', 'Groove Salad', 'Chilled ambient downtempo — the default'),
  soma('gsclassic', 'Groove Salad Classic', 'The early-2000s cut of the same idea'),
  soma('beatblender', 'Beat Blender', 'Late-night deep house and downtempo'),
  soma('cliqhop', 'Cliqhop IDM', "Blips'n'beeps over beats. Intelligent dance music"),
  soma('vaporwaves', 'Vaporwaves', 'All vaporwave, all the time — a dead mall in orbit'),
  soma('secretagent', 'Secret Agent', 'For spies and the stylishly dangerous'),
  one81('90sdance', '181-90sdance', "90's Dance", 'Nineties club and eurodance, entirely unrepentant'),
  // — rock and pop
  paradise('rpmain', 0, 'Radio Paradise', 'Eclectic hand-picked rock, 192 kbps — the good stuff'),
  paradise('rprock', 2, 'RP Rock Mix', 'The same curation, turned up: rock and alternative'),
  soma('indiepop', 'Indie Pop Rocks!', 'Indie pop and jangle — SomaFM at its most cheerful'),
  one81('eagle', '181-eagle', 'The Eagle', 'Classic rock, the way a truck stop plays it'),
  soma('seventies', 'Left Coast 70s', 'Mellow album rock. Yacht not required'),
  soma('u80s', 'Underground 80s', 'Early-80s UK synthpop and new wave'),
  one81('hairband', '181-hairband', "80's Hairband", 'Eighties stadium rock, hairspray and all'),
  one81('power181', '181-powerexplicit', 'Power 181', 'Chart pop and hip hop — the uncensored feed, explicit lyrics'),
  // — country and americana
  one81('kickincountry', '181-kickincountry', "Kickin' Country", 'Modern country, the hits end'),
  one81('highway', '181-highway', 'Highway 181', 'Classic country — the long haul, honestly'),
  soma('bootliquor', 'Boot Liquor', 'Americana for cowhands — the frontier hour'),
  // — soul, R&B and hip hop
  soma('7soul', 'Seven Inch Soul', 'Vintage soul, straight off the 45s'),
  one81('truerb', '181-rnb', 'True R&B', 'R&B and slow jams, wall to wall'),
  one81('oldschool', '181-oldschool', 'Old School Hip Hop', 'The 90s golden age — beats, rhymes and attitude'),
  soma('fluid', 'Fluid', 'Instrumental hip-hop, future soul and liquid trap'),
  one81('thebeat', '181-beat', 'The Beat', 'Hip hop and R&B at the current end'),
  // — the dark end: hacking, neon, industrial
  soma('defcon', 'DEF CON Radio', 'Music for hacking — the DEF CON year-round channel'),
  nightride('nightride', 'Nightride FM', 'Synthwave — neon, chrome and a long night drive'),
  nightride('darksynth', 'Darksynth', 'The harder, horror-tinged cut of the same neon'),
  nightride('datawave', 'Datawave', 'Cyberpunk downtempo — for working the console'),
  nightride('ebsm', 'EBSM', 'Electronic body music: industrial with a pulse'),
  soma('doomed', 'Doomed', 'Dark industrial and ambient, for tortured souls'),
  // — Suomi: the Finnish dial, by country rather than by sound (see the module
  //   comment). Yle first, quiet end leading as everywhere else, then the
  //   commercial city stations, the decades, and the odd ones.
  yle('yleklassinen', 'YleKlassinen', 'Yle Klassinen', 'Classical, around the clock, no adverts — the public broadcaster'),
  yle('yleradio1', 'YleRadio1', 'Yle Radio 1', 'Classical, culture and long-form talk. Finland thinking aloud'),
  yle('ylex', 'YleX', 'YleX', 'Pop, rock and alternative — Yle pointed at people under forty'),
  yle('ylex3m', 'YleX3M', 'Yle X3M', "Swedish-language and young — Finland's other official language"),
  yle('ylevega', 'YleVega', 'Yle Vega', 'Swedish-language, broader and slower than X3M'),
  yle('ylesami', 'YleSami', 'Yle Sámi', 'Sámi-language radio from the far north — joik, news and weather'),
  yle('yleradiosuomi', 'YleRS', 'Yle Radio Suomi', 'News, sport and regional talk. What the country has on'),
  {
    id: 'radiohelsinki',
    label: 'Radio Helsinki',
    blurb: "Helsinki's own — indie, alternative and city talk at 256 kbps",
    url: 'https://stream.radiohelsinki.fi/stream',
    // Sends CORS, so it routes without the relay.
    routable: true,
    source: 'Radio Helsinki',
  },
  // The commercial dial. Adverts are Bauer's own, inserted into the stream —
  // see the bauerfi note for what it took to hear the stations at all.
  bauerfi('radiocity', 'radiocity', 'Radio City', 'Helsinki city rock — the original Finnish commercial station'),
  bauerfi('suomirock', 'suomirock', 'Suomirock', 'Finnish-language rock, wall to wall'),
  bauerfi('radio957', 'radio957', 'Radio 957', "Tampere's rock station — harder than the national feeds"),
  bauerfi('radionova', 'radionova', 'Radio Nova', 'The big national one: rock and pop for the whole country'),
  bauerfi('kasari', 'kasari', 'Kasari', 'The eighties, Finnish and imported — kasari means eighties'),
  bauerfi('ysari', 'ysari', 'Ysäri', 'The nineties, same idea, one decade on'),
  bauerfi('bassoradio', 'bassoradio', 'Bassoradio', 'Finnish hip hop, soul and club — Basso built that scene'),
  bauerfi('iskelma', 'iskelma', 'Iskelmä', 'Iskelmä: Finnish schlager, tango and heartbreak. No irony'),
  {
    id: 'jarviradio',
    label: 'Järviradio',
    blurb: 'Broadcast from the Ostrobothnian lakes — folk, hymns and local news',
    url: 'https://jarviradio.radiotaajuus.fi:9000/jr',
    routable: true,
    source: 'Järviradio',
  },
  {
    id: 'gnr',
    label: 'Galaxy News Radio',
    blurb: 'The wasteland standard — swing, blues and a DJ. Not ours; theirs',
    url: 'http://fallout.fm:8000/falloutfm1.ogg',
    // No CORS header, so it plays direct and ducks by element volume.
    routable: false,
    source: 'Fallout.FM',
  },
];

export const DEFAULT_STATION = 'groovesalad';

export function stationById(id: string): RadioStation | undefined {
  return STATIONS.find((s) => s.id === id);
}

/**
 * What to put on for the work being done.
 *
 * The session arc already computes the commander's chapter — hauling, mining,
 * exploring — so the dial can follow the job without being asked. Deliberately
 * unsurprising: the black gets ambient, the long hauls get rock, the rings get
 * drone. A commander who disagrees turns the follow switch off and picks.
 */
export function stationForChapter(chapter: ChapterKind | null): string {
  switch (chapter) {
    case 'exploring':
      return 'deepspaceone';
    case 'mining':
      return 'dronezone';
    case 'hauling':
      return 'seventies';
    case 'community-goal work':
      return 'bootliquor';
    case 'bounty hunting':
      return 'u80s';
    case 'passenger runs':
      return 'secretagent';
    case 'exobiology':
      return 'synphaera';
    default:
      return DEFAULT_STATION;
  }
}
