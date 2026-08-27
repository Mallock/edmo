/**
 * The dial, wired up — internet radio under the operator's voice.
 *
 * The design decision that shapes this file: an HTMLAudioElement can be handed
 * to `createMediaElementSource` exactly ONCE, and from that moment its audio
 * belongs to the graph and never reaches the speakers on its own. So there are
 * two elements, permanently:
 *
 *   routedEl  crossOrigin='anonymous', wired into the MUSIC bus. Stations that
 *             send CORS play here and duck properly — the bus automates the
 *             gain under the operator and under comms traffic.
 *   directEl  no crossOrigin, never wired. Stations without CORS play here;
 *             the browser would hand the graph silence, so instead the duck is
 *             a volume ramp on the element, driven by the same arithmetic.
 *
 * Everything else is bookkeeping: what is on, whether it is actually playing,
 * and what track — SomaFM publishes a per-channel now-playing JSON, so the HUD
 * can name the song without touching the stream.
 */
import type { AppSettings } from './settings.ts';
import type { RadioBus } from './radio.ts';
import { isTauri, radioRelayPort } from './bridge.ts';
import { STATIONS, stationById, type RadioStation } from '../engine/stations.ts';

/** How often an unrouted station re-checks the duck level. */
const DUCK_POLL_MS = 150;
/** How often the current track is refreshed. Songs are minutes long. */
const NOW_PLAYING_MS = 30_000;

export interface MusicState {
  /** The station the commander has on, or null when the radio is off. */
  stationId: string | null;
  label: string | null;
  /** True once the stream is actually producing audio. */
  playing: boolean;
  /** "Artist — Title", when the host publishes it. */
  nowPlaying: string | null;
  /** Set when a stream refused to play, for the settings panel. */
  error: string | null;
}

export class MusicPlayer {
  private routedEl: HTMLAudioElement | null = null;
  private directEl: HTMLAudioElement | null = null;
  private routedAttached = false;
  private current: RadioStation | null = null;
  /** Whether the current station went through the graph or plays direct. */
  private currentRouted = false;
  private duckTimer: ReturnType<typeof setInterval> | null = null;
  private trackTimer: ReturnType<typeof setInterval> | null = null;
  /** Open only while a push-metadata station (Nightride) is on. */
  private trackStream: EventSource | null = null;
  /** A gesture listener is waiting to retry a blocked start. */
  private gestureArmed = false;
  /** Loopback relay port, once the Rust side has one open. */
  private relayPort: number | null = null;
  private state: MusicState = {
    stationId: null,
    label: null,
    playing: false,
    nowPlaying: null,
    error: null,
  };

  private readonly getBus: () => RadioBus;
  private readonly getSettings: () => AppSettings;
  private readonly onChange: () => void;

  constructor(getBus: () => RadioBus, getSettings: () => AppSettings, onChange: () => void) {
    this.getBus = getBus;
    this.getSettings = getSettings;
    this.onChange = onChange;
  }

  snapshot(): MusicState {
    return { ...this.state };
  }

  /** Open the relay early, so the first play does not wait on it. */
  async init(): Promise<void> {
    if (!isTauri || this.relayPort !== null) return;
    try {
      this.relayPort = await radioRelayPort();
    } catch {
      this.relayPort = null; // fall back to playing the station directly
    }
  }

  /**
   * What the audio element should actually load.
   *
   * Through the relay whenever there is one: it carries the app's own
   * User-Agent (which is the difference between 200 and 403 on SomaFM), and
   * it answers with permissive CORS, so every station — including the ones
   * that publish none — can be routed into the graph and ducked properly.
   */
  private streamUrl(station: RadioStation): string {
    if (this.relayPort === null) return station.url;
    return `http://127.0.0.1:${this.relayPort}/play?url=${encodeURIComponent(station.url)}`;
  }

  /** The configured level, 0..1, from settings. */
  private volume(): number {
    return Math.min(1, Math.max(0, (this.getSettings().music?.volume ?? 45) / 100));
  }

  private el(routable: boolean): HTMLAudioElement | null {
    if (typeof Audio === 'undefined') return null;
    if (routable) {
      if (!this.routedEl) {
        const el = new Audio();
        el.crossOrigin = 'anonymous';
        el.preload = 'none';
        this.routedEl = el;
      }
      return this.routedEl;
    }
    if (!this.directEl) {
      const el = new Audio();
      el.preload = 'none';
      this.directEl = el;
    }
    return this.directEl;
  }

  /** Put a station on. Unknown ids are ignored rather than throwing. */
  play(stationId: string): void {
    const station = stationById(stationId) ?? STATIONS.find((s) => s.id === stationId);
    if (!station) return;
    if (this.current?.id === station.id && this.state.playing) return;
    this.stop({ keepState: true });

    // With the relay in front of it, EVERY station answers with permissive
    // CORS — so the ones that publish none (Galaxy News Radio) become
    // routable too, and duck as precisely as the rest.
    const routed = this.relayPort !== null || station.routable;
    const el = this.el(routed);
    if (!el) return;
    this.current = station;
    this.currentRouted = routed;
    this.state = {
      stationId: station.id,
      label: station.label,
      playing: false,
      nowPlaying: null,
      error: null,
    };

    if (routed) {
      // Routed: the bus owns the level, so the element runs wide open.
      const ok = this.getBus().attachMusic(el);
      this.routedAttached = this.routedAttached || ok;
      el.volume = 1;
      this.getBus().setBusVolume('MUSIC', this.volume());
    } else {
      el.volume = this.volume();
      this.startDuckPolling();
    }

    el.onplaying = () => {
      this.state = { ...this.state, playing: true, error: null };
      this.getBus().setMusicPlaying(true);
      this.onChange();
    };
    el.onerror = () => {
      this.state = { ...this.state, playing: false, error: 'the station did not answer' };
      this.getBus().setMusicPlaying(false);
      this.onChange();
    };
    // A live stream has no end; a stall usually means the host dropped us.
    el.onstalled = () => {
      this.state = { ...this.state, playing: false };
      this.onChange();
    };

    // Wake the graph in the SAME gesture that starts the element: a routed
    // station whose context is suspended plays to nobody, silently.
    this.getBus().wake();
    el.src = this.streamUrl(station);
    void el.play().catch((e: unknown) => {
      // Autoplay policy is a different animal from a dead stream, and saying
      // so matters: one needs a click, the other needs a new station. On
      // Windows the webview is launched with the policy disabled, so this is
      // the Linux/WebKitGTK path and the boot-resume case.
      const blocked =
        !!e && typeof e === 'object' && (e as { name?: string }).name === 'NotAllowedError';
      this.state = {
        ...this.state,
        playing: false,
        error: blocked
          ? 'waiting for a click — the window blocks audio until you interact with it'
          : 'the station would not start',
      };
      if (blocked) this.armGestureRetry(station.id);
      this.onChange();
    });

    this.startTrackPolling(station);
    this.onChange();
  }

  /**
   * Start again the moment the commander touches anything.
   *
   * The alternative is telling them to go and click the station a second
   * time, which is a bug wearing an instruction's clothes. One listener, one
   * shot, removed whether it fires or the radio is switched off first.
   */
  private armGestureRetry(stationId: string): void {
    if (this.gestureArmed || typeof document === 'undefined') return;
    this.gestureArmed = true;
    const retry = (): void => {
      document.removeEventListener('pointerdown', retry);
      document.removeEventListener('keydown', retry);
      this.gestureArmed = false;
      // Only if that station is still the one wanted — the commander may have
      // retuned or switched the radio off while it was waiting.
      if (this.state.stationId === stationId && !this.state.playing) this.play(stationId);
    };
    document.addEventListener('pointerdown', retry);
    document.addEventListener('keydown', retry);
  }

  stop(opts: { keepState?: boolean } = {}): void {
    for (const el of [this.routedEl, this.directEl]) {
      if (!el) continue;
      try {
        el.pause();
        el.removeAttribute('src');
        el.load();
      } catch {
        /* the element was never started */
      }
    }
    if (this.duckTimer) clearInterval(this.duckTimer);
    if (this.trackTimer) clearInterval(this.trackTimer);
    this.closeTrackStream();
    this.duckTimer = null;
    this.trackTimer = null;
    this.current = null;
    this.getBus().setMusicPlaying(false);
    if (!opts.keepState) {
      this.state = { stationId: null, label: null, playing: false, nowPlaying: null, error: null };
      this.onChange();
    }
  }

  /** Settings changed: apply the new level to whichever path is live. */
  applyVolume(): void {
    if (!this.current) return;
    if (this.currentRouted) this.getBus().setBusVolume('MUSIC', this.volume());
    else if (this.directEl) this.directEl.volume = this.volume() * this.getBus().musicDuckFactor();
  }

  /**
   * Unrouted stations duck by element volume. Polled rather than pushed: the
   * duck state lives in the audio graph, changes on every utterance, and a
   * 150 ms check is inaudible next to a 400 ms restore ramp.
   */
  private startDuckPolling(): void {
    if (this.duckTimer) clearInterval(this.duckTimer);
    this.duckTimer = setInterval(() => {
      const el = this.directEl;
      if (!el || !this.current || this.current.routable) return;
      const want = this.volume() * this.getBus().musicDuckFactor();
      // Move toward the target rather than jumping, so the duck sounds like a
      // hand on a dial instead of a switch.
      el.volume = el.volume + (want - el.volume) * 0.35;
    }, DUCK_POLL_MS);
  }

  /**
   * Show a track line, if it is new, not empty, and still about the station
   * that is actually on.
   *
   * That last condition is the whole reason this is a method. Clearing a timer
   * does not cancel a request already in flight: retune while SomaFM's JSON is
   * on the wire and the reply lands a moment later, writing the OLD station's
   * song under the NEW station's name. It is the worst kind of wrong, because
   * a real artist and a real title look exactly like success.
   */
  private setTrack(forId: string, artist: string | undefined, title: string | undefined): void {
    if (this.current?.id !== forId) return;
    const line = [artist, title].filter(Boolean).join(' — ');
    if (!line || line === this.state.nowPlaying) return;
    this.state = { ...this.state, nowPlaying: line };
    this.onChange();
  }

  private startTrackPolling(station: RadioStation): void {
    if (this.trackTimer) clearInterval(this.trackTimer);
    this.closeTrackStream();
    const feed = station.track;
    if (!feed) return;
    const forId = station.id;
    if (feed.kind === 'nightride') {
      this.startTrackStream(feed.url, feed.channel, forId);
      return;
    }
    const fetchTrack = async (): Promise<void> => {
      try {
        const res = await fetch(feed.url, { cache: 'no-store' });
        if (!res.ok) return;
        const json = (await res.json()) as { songs?: Array<{ artist?: string; title?: string }> };
        const song = json.songs?.[0];
        if (song) this.setTrack(forId, song.artist, song.title);
      } catch {
        /* the track name is a nicety — never let it surface as an error */
      }
    };
    void fetchTrack();
    this.trackTimer = setInterval(() => void fetchTrack(), NOW_PLAYING_MS);
  }

  /**
   * Nightride's metadata, which is pushed rather than polled.
   *
   * One event stream carries every channel, so each message is a small array
   * and the row for the channel on air is the one that matters. EventSource
   * reconnects by itself, which is the whole reason to use it here rather
   * than hand-rolling a reader over fetch.
   */
  private startTrackStream(url: string, channel: string, forId: string): void {
    if (typeof EventSource === 'undefined') return;
    try {
      const es = new EventSource(url);
      es.onmessage = (ev: MessageEvent<string>) => {
        try {
          const rows = JSON.parse(ev.data) as Array<{
            station?: string;
            artist?: string;
            title?: string;
          }>;
          const row = Array.isArray(rows) ? rows.find((r) => r.station === channel) : null;
          if (row) this.setTrack(forId, row.artist, row.title);
        } catch {
          /* a malformed frame is not worth a visible error */
        }
      };
      this.trackStream = es;
    } catch {
      /* no metadata, then — the station label still names what is on */
    }
  }

  private closeTrackStream(): void {
    if (!this.trackStream) return;
    try {
      this.trackStream.close();
    } catch {
      /* already gone */
    }
    this.trackStream = null;
  }
}
