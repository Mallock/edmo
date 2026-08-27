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
  | { kind: 'nightride'; url: string; channel: string };

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
  source: 'SomaFM' | 'Fallout.FM' | 'Nightride FM';
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
  soma('deepspaceone', 'Deep Space One', 'Deep ambient and space music — for the black'),
  soma('missioncontrol', 'Mission Control', 'Ambient, cut with real NASA mission audio'),
  soma('spacestation', 'Space Station Soma', 'Spaced-out ambient and mid-tempo electronica'),
  soma('dronezone', 'Drone Zone', 'Atmospheric textures with minimal beats'),
  soma('synphaera', 'Synphaera Radio', 'Modern space ambient from an indie label'),
  soma('groovesalad', 'Groove Salad', 'Chilled ambient downtempo — the default'),
  soma('gsclassic', 'Groove Salad Classic', 'The early-2000s cut of the same idea'),
  soma('seventies', 'Left Coast 70s', 'Mellow album rock. Yacht not required'),
  soma('bootliquor', 'Boot Liquor', 'Americana for cowhands — the frontier hour'),
  soma('u80s', 'Underground 80s', 'Early-80s UK synthpop and new wave'),
  soma('secretagent', 'Secret Agent', 'For spies and the stylishly dangerous'),
  soma('beatblender', 'Beat Blender', 'Late-night deep house and downtempo'),
  soma('fluid', 'Fluid', 'Instrumental hip-hop, future soul and liquid trap'),
  soma('7soul', 'Seven Inch Soul', 'Vintage soul, straight off the 45s'),
  soma('defcon', 'DEF CON Radio', 'Music for hacking — the DEF CON year-round channel'),
  soma('cliqhop', 'Cliqhop IDM', "Blips'n'beeps over beats. Intelligent dance music"),
  soma('vaporwaves', 'Vaporwaves', 'All vaporwave, all the time — a dead mall in orbit'),
  soma('doomed', 'Doomed', 'Dark industrial and ambient, for tortured souls'),
  nightride('nightride', 'Nightride FM', 'Synthwave — neon, chrome and a long night drive'),
  nightride('darksynth', 'Darksynth', 'The harder, horror-tinged cut of the same neon'),
  nightride('datawave', 'Datawave', 'Cyberpunk downtempo — for working the console'),
  nightride('ebsm', 'EBSM', 'Electronic body music: industrial with a pulse'),
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
