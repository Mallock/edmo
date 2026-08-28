/**
 * Text-to-speech with two engines (SPEC §3.3):
 *  - 'piper'  — the bundled local neural model (Piper + en_GB Alba voice),
 *               synthesized by the Rust sidecar. 100% offline & private.
 *  - 'system' — Windows speechSynthesis voices; cloud ("Natural") voices are
 *               filtered out unless local_voices_only is disabled.
 *
 * Two buses, not one queue (design.md D2). PRIORITY carries the operator, the
 * newsreader and the saga: serialized, de-duplicated, and never made to wait
 * for anything. AMBIENT carries comms traffic: it ducks under PRIORITY, drops
 * when it backs up, and discards anything that has gone stale rather than
 * speaking late. Routing chatter through the priority queue would put a dock
 * worker's joke in front of a hull-breach callout, which is the one thing this
 * design must never allow.
 *
 * Radio character is applied by src/ui/radio.ts, which needs the raw samples —
 * so it only works on the Piper path. `speechSynthesis` gives no access to its
 * output, so with the 'system' engine a profile is accepted and ignored, and
 * chatter simply speaks unprocessed. That is stated here rather than hidden
 * because it is a real limitation of the browser API, not an oversight.
 */
import type { AppSettings } from './settings.ts';
import { isTauri, piperSpeak, edgeSpeak } from './bridge.ts';
import { RadioBus } from './radio.ts';
import {
  AMBIENT_QUEUE_CAP,
  AmbientQueue,
  DEFAULT_TTL_MS,
  type AmbientItem,
  type BusId,
  type DropReason,
} from '../engine/chatter/bus.ts';
import { radioProfile, type RadioProfile } from '../engine/chatter/profiles.ts';
import { LruCache, synthKey } from '../engine/chatter/wavcache.ts';

const DEDUPE_WINDOW_MS = 3 * 60_000;
/** One failed synth must not mute comms for the whole session. */
const PIPER_RETRY_COOLDOWN_MS = 30_000;
/** Longer than Piper's: a network service that just failed is unlikely to be
 *  well a second later, and re-dialling a dead endpoint per line costs the
 *  commander latency on every single utterance. */
const EDGE_RETRY_COOLDOWN_MS = 120_000;

/** In-memory synthesized-audio cache. The sidecar also caches to disk (which
 *  survives restarts); this one saves the IPC round trip for lines repeated
 *  within a session, which is most of them once chatter is running. */
const WAV_CACHE_MAX = 96;

export function listSystemVoices(localOnly: boolean): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  const all = speechSynthesis.getVoices();
  return localOnly ? all.filter((v) => v.localService) : all;
}

/** Per-utterance routing. Omit it all and you get exactly the old behaviour. */
export interface SpeakOptions {
  /** Which bus. Defaults to PRIORITY — the pre-existing behaviour. */
  bus?: BusId;
  /** Radio profile name. Defaults to 'clean', i.e. no processing. */
  profile?: string;
  /**
   * Persona timbre, 0.94..1.06 (design D7a). ONE number drives both halves of
   * the trick — synthesis is slowed by it and playback sped up by it — because
   * holding them as two fields is holding them wrong: they must never drift.
   */
  timbre?: number;
  /** Signal degradation 0..1 — comms range makes a distant station sound it. */
  degrade?: number;
  /** Stereo seat -1..1 (radio.ts PlayOptions.pan): a scene's caller and reply
   *  sit either side of the listener. Omit for centre — the operator's seat. */
  pan?: number;
  /** How long this stays worth saying. AMBIENT only. */
  ttlMs?: number;
  /** Which channel it belongs to, for per-channel squelch. AMBIENT only. */
  channel?: string;
  /** Called when the line was dropped instead of spoken. AMBIENT only. */
  onDrop?: (reason: DropReason) => void;
}

/**
 * One queued utterance.
 *
 * The voice rides with the TEXT rather than being read off settings at speak
 * time, because a bulletin and the operator's own line can be in the queue
 * together — and the newsreader must not borrow the operator's voice just
 * because the queue drained in a different order than it filled.
 */
interface Utterance {
  text: string;
  /** Piper voice id, or null/undefined for the operator's own voice. */
  voice?: string | null;
  profile: RadioProfile;
  timbre?: number;
  degrade?: number;
  pan?: number;
  onDrop?: (reason: DropReason) => void;
}

export class Speaker {
  private queue: Utterance[] = [];
  private pumping = false;
  private recent = new Map<string, number>();
  private currentAudio: HTMLAudioElement | null = null;
  /** Piper marked unavailable after a failed synth — falls back to system. */
  private piperOk = true;
  /** When Piper may be tried again after a failure. */
  private piperRetryAt = 0;
  private edgeOk = true;
  private edgeRetryAt = 0;

  /** The ambient side: its own bounded, self-expiring queue and its own pump. */
  private ambient = new AmbientQueue<Utterance>(AMBIENT_QUEUE_CAP);
  private ambientPumping = false;
  private ambientAbort: AbortController | null = null;
  /** Which channel the sounding ambient line belongs to. Needed because a
   *  per-channel squelch must cut off THAT channel and no other — the pump has
   *  already taken the item out of the queue by the time the mute arrives. */
  private ambientChannel: string | null = null;

  private radio = new RadioBus();

  /** The shared audio graph, so the music player can route a station into the
   *  same buses the voices use — that is what makes ducking real. */
  radioBus(): RadioBus {
    return this.radio;
  }
  private wavCache = new LruCache<ArrayBuffer>(WAV_CACHE_MAX);

  /** Written out rather than a parameter property: Node's type-stripping (how
   *  the test runner loads .ts) does not support those, and tests/boot.test.ts
   *  has to be able to import the whole UI store. */
  private readonly getSettings: () => AppSettings;

  constructor(getSettings: () => AppSettings) {
    this.getSettings = getSettings;
  }

  /**
   * Queue text for speech (no-op when voice is disabled or text repeats).
   *
   * `voice` overrides the operator's own for this utterance only — how the
   * news wire is read by somebody else.
   */
  speak(text: string, voice?: string | null, opts: SpeakOptions = {}): void {
    const s = this.getSettings();
    if (!s.voice.enabled) return;
    // Asterisks are markdown the models sometimes emit and Piper PRONOUNCES
    // them — a scene shipped "*Wanderlust*" and the voice said "asterisk".
    // The comms parser strips its own, but every path ends here, so the last
    // door does it unconditionally: an asterisk has no spoken value, ever.
    const clean = text.replace(/\*/g, '').replace(/\s+/g, ' ').trim();
    if (!clean) return;

    const bus: BusId = opts.bus ?? 'PRIORITY';
    // Radio character is a user setting, and turning it off must genuinely
    // bypass the chain rather than merely flatten it.
    const wanted = s.radio?.enabled
      ? (opts.profile ?? (bus === 'PRIORITY' ? s.radio.operatorProfile : undefined))
      : 'clean';
    const utt: Utterance = {
      text: clean,
      voice,
      profile: radioProfile(wanted),
      timbre: opts.timbre,
      degrade: opts.degrade,
      pan: opts.pan,
      onDrop: opts.onDrop,
    };

    if (bus === 'AMBIENT') {
      // No de-duplication here on purpose. Traffic control repeating itself is
      // realism; the anti-repetition that matters happens a layer up, at the
      // scene level, where it can reason about subjects rather than strings.
      this.ambient.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        channel: opts.channel ?? 'LOCAL',
        queuedAt: Date.now(),
        ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS,
        payload: utt,
      });
      this.reportDrops();
      void this.pumpAmbient();
      return;
    }

    const now = Date.now();
    const last = this.recent.get(clean);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    this.recent.set(clean, now);
    if (this.recent.size > 200) {
      for (const [k, t] of this.recent) {
        if (now - t > DEDUPE_WINDOW_MS) this.recent.delete(k);
      }
    }
    this.queue.push(utt);
    void this.pump();
  }

  /** Speak regardless of de-dupe (settings "test voice" buttons). */
  test(voice?: string | null, profile?: string): void {
    this.queue.push({
      text: voice
        ? 'This is the local wire, reading the system bulletin.'
        : 'Voice check. Mission Operator online and tracking.',
      voice,
      profile: radioProfile(profile),
    });
    void this.pump();
  }

  /** Preview a radio profile on the ambient bus, bypassing every gate. */
  testProfile(profile: string, voice?: string | null): void {
    this.ambient.push({
      id: `test-${Date.now()}`,
      channel: 'TEST',
      queuedAt: Date.now(),
      ttlMs: 30_000,
      payload: {
        text: 'Traffic control to inbound vessel, hold at the marker and confirm your manifest.',
        voice,
        profile: radioProfile(profile),
      },
    });
    void this.pumpAmbient();
  }

  stop(): void {
    this.queue = [];
    this.ambient.clear();
    this.ambientAbort?.abort();
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
    this.radio.stopAll();
    this.reportDrops();
  }

  /** Silence one channel: drop what is queued from it and stop it if sounding.
   *  Traffic on every other channel keeps going — that is what makes this a
   *  squelch rather than a mute. */
  muteChannel(channel: string): void {
    this.ambient.muteChannel(channel);
    if (this.ambientChannel === channel) this.ambientAbort?.abort();
    this.reportDrops();
  }

  /** Master mute for everything on the radio bus. */
  setMuted(muted: boolean): void {
    this.radio.setMasterMuted(muted);
  }

  /** Tell each dropped line's owner why it never played. */
  private reportDrops(): void {
    for (const d of this.ambient.takeDropped()) d.item.payload.onDrop?.(d.reason);
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const utt = this.queue.shift()!;
        const s = this.getSettings();
        if (!s.voice.enabled) continue;
        await this.say(utt, s, 'PRIORITY');
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * The ambient pump.
   *
   * Runs independently of the priority pump — that independence IS the duck:
   * both can be sounding at once, and the bus gains sort out who is audible.
   */
  private async pumpAmbient(): Promise<void> {
    if (this.ambientPumping) return;
    this.ambientPumping = true;
    try {
      for (;;) {
        const next = this.ambient.take(Date.now());
        this.reportDrops();
        if (!next) break;
        const s = this.getSettings();
        if (!s.voice.enabled) {
          next.payload.onDrop?.('muted');
          continue;
        }
        this.ambientAbort = new AbortController();
        this.ambientChannel = next.channel;
        try {
          await this.say(next.payload, s, 'AMBIENT', this.ambientAbort.signal);
        } finally {
          this.ambientAbort = null;
          this.ambientChannel = null;
        }
      }
    } finally {
      this.ambientPumping = false;
    }
  }

  /** Speak one utterance on one bus, with the engine fallbacks intact. */
  private async say(
    utt: Utterance,
    s: AppSettings,
    bus: BusId,
    signal?: AbortSignal,
  ): Promise<void> {
    // Online neural voices, when the commander has opted in.
    //
    // Falls through to Piper on ANY failure rather than going quiet. This is
    // an undocumented endpoint that Microsoft has already broken twice; the
    // app must degrade to the local voice, never to silence. The failure is
    // sticky for a cooldown so a dead service is not re-dialled every line.
    if (s.voice.engine === 'edge' && isTauri) {
      if (!this.edgeOk && Date.now() >= this.edgeRetryAt) this.edgeOk = true;
      if (this.edgeOk) {
        try {
          await this.speakEdge(utt, s, bus, signal);
          return;
        } catch {
          this.edgeOk = false;
          this.edgeRetryAt = Date.now() + EDGE_RETRY_COOLDOWN_MS;
        }
      }
      // Deliberately falls into the Piper branch below.
    }

    if ((s.voice.engine === 'piper' || s.voice.engine === 'edge') && isTauri) {
      // Recover automatically from a transient sidecar failure (startup race,
      // one bad utterance, temporary IO issue). Sticky-disable made comms look
      // dead for the whole run even after Piper was healthy again.
      if (!this.piperOk && Date.now() >= this.piperRetryAt) this.piperOk = true;

      if (this.piperOk) {
        try {
          await this.speakPiper(utt, s, bus, signal);
          return;
        } catch {
          this.piperOk = false;
          this.piperRetryAt = Date.now() + PIPER_RETRY_COOLDOWN_MS;
        }
      }

      try {
        await this.speakSystem(utt, s, signal);
      } catch {
        /* no speech available at all — stay silent */
      }
      return;
    }

    try {
      await this.speakSystem(utt, s, signal);
    } catch {
      /* no speech available at all — stay silent */
    }
  }

  /** Synthesize (or reuse) the WAV for an utterance. */
  private async synth(utt: Utterance, s: AppSettings): Promise<ArrayBuffer> {
    // Piper speed: length_scale is inverse of rate (2.0 = twice as slow).
    const base = 1 / Math.min(2, Math.max(0.5, s.voice.rate));
    const lengthScale = utt.timbre !== undefined ? base * utt.timbre : base;
    const voice = utt.voice ?? s.voice.piperVoice;
    const key = synthKey(utt.text, voice, lengthScale);

    const hit = this.wavCache.get(key);
    if (hit) return hit;

    const wav = await piperSpeak(utt.text, lengthScale, voice);
    this.wavCache.set(key, wav);
    return wav;
  }

  /** Cache hit rate, for the settings panel and soak runs. */
  cacheStats(): { hits: number; misses: number; size: number } {
    return this.wavCache.stats();
  }

  /**
   * One line through Microsoft's online voices.
   *
   * The bytes are MP3 rather than Piper's WAV, which the radio bus decodes
   * just the same — decodeAudioData does not care. The timbre trick does not
   * apply here: it works by cancelling a synthesis-time slowdown against a
   * playback-time speed-up, and the online service gives no length control,
   * so the cast's per-person pitch shifts are simply not available. Better an
   * honest single voice than a fake one.
   */
  private async speakEdge(
    utt: Utterance,
    s: AppSettings,
    bus: BusId,
    signal?: AbortSignal,
  ): Promise<void> {
    // THE CAST GETS ITS OWN VOICES HERE, and until now it did not.
    //
    // `utt.voice` is the persona's — the whole cast system exists to give each
    // character a voice of their own and keep it across a session. This line
    // used to read the settings voice unconditionally, so on the Edge engine
    // every speaker on every channel was the same person: traffic control, both
    // haulers, the crew and the concourse PA, all in one voice. The operator
    // still gets the configured voice, because nothing passes a persona for it.
    const voice = utt.voice ?? s.voice.edgeVoice ?? 'en-GB-SoniaNeural';
    // Timbre, carried across from the Piper path so a character sounds the same
    // shape on either engine. Piper takes it as a length scale where >1 is
    // SLOWER, so it inverts into a rate offset here; the steps are 0.94/1.0/1.06
    // and land as ±6%, which is a nudge rather than a costume.
    const base = Math.max(-50, Math.min(100, s.voice.edgeRate ?? 20));
    const rate = Math.round(
      Math.max(-50, Math.min(100, utt.timbre !== undefined ? base + (1 - utt.timbre) * 100 : base)),
    );
    const key = synthKey(utt.text, `edge:${voice}`, rate);
    let mp3 = this.wavCache.get(key);
    if (!mp3) {
      mp3 = await edgeSpeak(utt.text, voice, rate, 0);
      this.wavCache.set(key, mp3);
    }
    const volume = Math.min(1, Math.max(0, s.voice.volume / 100));
    if (this.radio.available) {
      const ambientScale = Math.min(1, Math.max(0, (s.comms?.volume ?? 70) / 100));
      await this.radio.play(mp3, {
        bus,
        // Already a RadioProfile — built once in speak() from the settings and
        // the bus, exactly as the Piper path below passes it. This line used to
        // call a `profileFor` that does not exist in this module (the only one
        // in the codebase takes a MODEL id, and one argument), so every Edge
        // utterance that reached the radio bus died on a ReferenceError.
        profile: utt.profile,
        volume: bus === 'PRIORITY' ? volume : volume * ambientScale,
        degrade: utt.degrade,
        pan: utt.pan,
        signal,
      });
      return;
    }
    await playBytes(mp3, volume, signal);
  }

  private async speakPiper(
    utt: Utterance,
    s: AppSettings,
    bus: BusId,
    signal?: AbortSignal,
  ): Promise<void> {
    const wav = await this.synth(utt, s);
    const volume = Math.min(1, Math.max(0, s.voice.volume / 100));

    if (this.radio.available) {
      // Ambient rides a little below the operator until settings grow its own
      // slider (task 12.1); the duck is applied inside the bus, not here.
      const ambientScale = Math.min(1, Math.max(0, (s.comms?.volume ?? 70) / 100));
      this.radio.setBusVolume(bus, bus === 'AMBIENT' ? volume * ambientScale : volume);
      try {
        await this.radio.play(wav, {
          bus,
          profile: utt.profile,
          volume,
          degrade: utt.degrade,
          timbre: utt.timbre,
          pan: utt.pan,
          signal,
        });
        return;
      } catch {
        /* graph unavailable — fall through to the plain element path */
      }
    }

    // Degrade, never fail: no Web Audio here, so play it unprocessed.
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        if (bus === 'PRIORITY') this.currentAudio = audio;
        audio.volume = volume;
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('audio playback failed'));
        signal?.addEventListener('abort', () => {
          audio.pause();
          resolve();
        });
        audio.play().catch(reject);
      });
    } finally {
      if (bus === 'PRIORITY') this.currentAudio = null;
      URL.revokeObjectURL(url);
    }
  }

  /**
   * System voices. `speechSynthesis` output cannot be intercepted, so radio
   * profiles do not apply here — the line is spoken plainly.
   *
   * Nor can a single utterance be stopped: `speechSynthesis.cancel()` clears
   * the whole queue, which on an abort would cut off the operator to squelch a
   * dock worker. So an abort here releases the pump and lets the line finish
   * rather than taking priority speech down with it. Per-line squelch is exact
   * only on the Piper path — which is the default, and the only path that has
   * radio character to squelch in the first place.
   */
  private speakSystem(utt: Utterance, s: AppSettings, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof speechSynthesis === 'undefined') {
        reject(new Error('speechSynthesis unavailable'));
        return;
      }
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => resolve(), { once: true });
      const u = new SpeechSynthesisUtterance(utt.text);
      const voices = listSystemVoices(s.voice.localVoicesOnly);
      // A per-utterance override names a SYSTEM voice here, not a piper one;
      // when it does not match anything installed we fall back rather than
      // going silent, because a bulletin in the wrong voice still beats none.
      const pick = utt.voice ?? s.voice.systemVoice;
      const wanted = pick
        ? voices.find((v) => v.name === pick) ??
          voices.find((v) => v.lang.startsWith('en')) ??
          voices[0]
        : voices.find((v) => v.lang.startsWith('en')) ?? voices[0];
      if (wanted) u.voice = wanted;
      else if (s.voice.localVoicesOnly && voices.length === 0) {
        // Local-only but no local voice — refuse rather than leak to cloud.
        reject(new Error('no local system voice'));
        return;
      }
      // System voices get the persona's tempo but not its pitch — there is no
      // pitch control on SpeechSynthesisUtterance worth the artifacts.
      u.rate = s.voice.rate * (utt.timbre ?? 1);
      u.volume = Math.min(1, Math.max(0, s.voice.volume / 100));
      u.onend = () => resolve();
      u.onerror = () => resolve(); // don't wedge the queue on utterance errors
      speechSynthesis.speak(u);
    });
  }
}

export type { AmbientItem };
