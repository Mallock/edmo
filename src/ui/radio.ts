/**
 * The radio bus — one persistent Web Audio graph for every spoken word.
 *
 * Before this, all speech went through `new Audio(url)` with a volume set from
 * settings (see tts.ts). That is fine for one voice and useless for a channel:
 * it cannot duck, it cannot bandpass, and it cannot bracket a transmission
 * with a squelch and a roger beep — which, per design.md, is most of why the
 * reference implementation sounds convincing while inventing every fact.
 *
 * The graph is built ONCE and outlives every utterance. That matters twice
 * over: creating a context per utterance is a known source of clicks and leaks,
 * and ducking is by definition a property of something that survives the
 * utterance that triggered it.
 *
 *   BufferSource ─▶ [HPF] ─▶ [Drive] ─▶ [LPF] ─▶ trim ─┐
 *    (Piper WAV)                                        │
 *   noiseLoop ──▶ hissGain ──(gated to utterance)───────┼─▶ busGain ─▶ master ─▶ out
 *   popSource ──▶ (poisson crackle)─────────────────────┤       ▲
 *   beepOsc ────▶ open / roger tones ───────────────────┘   duck automation
 *
 * Filters in brackets are SKIPPED when the profile asks for no filtering — a
 * biquad parked at the band edge still colours the signal, so `clean` must not
 * get one at all.
 *
 * Everything here is browser-only. The numbers it applies (profiles, duck
 * depth, ramp times) live in src/engine/chatter/ so they stay testable without
 * an audio device.
 */
import {
  DUCK_RESTORE_MS,
  ambientGainDb,
  duckRampMs,
  type BusId,
} from '../engine/chatter/bus.ts';
import {
  dbToGain,
  isBypass,
  type RadioProfile,
} from '../engine/chatter/profiles.ts';

/** Idle time before the context is suspended to stop burning CPU beside a game. */
const IDLE_SUSPEND_MS = 30_000;

/** Length of the looping noise buffer. Long enough not to hear the seam. */
const NOISE_SECONDS = 4;

type Ctx = AudioContext;

export interface PlayOptions {
  bus: BusId;
  profile: RadioProfile;
  /** 0..1, the user's volume for this bus. */
  volume: number;
  /** Extra signal degradation, 0 (perfect) .. 1 (barely there). Comms range
   *  uses this so a distant station genuinely sounds distant without needing
   *  its own profile. */
  degrade?: number;
  /**
   * Persona timbre. The caller synthesizes at `length_scale = timbre` and we
   * play back at the same rate, so the tempo change cancels and the pitch
   * shift remains (design D7a). Measured usable range is 0.94..1.06 — beyond
   * that the cancellation breaks down and the line audibly rushes.
   */
  timbre?: number;
  /**
   * Stereo seat, -1 (hard left) .. 1 (hard right). A two-voice scene reads
   * as two PEOPLE when caller and reply sit either side of the listener —
   * the store pans a scene's speakers apart. Voice, hiss, beeps and crackle
   * all ride the same panner so the whole transmission moves as one signal.
   * Omitted or 0 = centre (the operator always speaks from the centre).
   */
  pan?: number;
  /** Resolves when playback finishes; rejects if it could not start. */
  signal?: AbortSignal;
}

/**
 * Owns the context, the buses and the shared noise buffer.
 *
 * A single instance is created lazily by the Speaker. If the context cannot be
 * constructed at all — no Web Audio in this webview — `available` stays false
 * and the caller falls back to the plain audio-element path, which keeps
 * chatter working, just unprocessed (radio-bus spec: degrade, never fail).
 */
export class RadioBus {
  private ctx: Ctx | null = null;
  private master: GainNode | null = null;
  private buses = new Map<BusId, GainNode>();
  private noise: AudioBuffer | null = null;
  private priorityDepth = 0;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private configuredDb = new Map<BusId, number>();
  private failed = false;

  /** True when the graph is usable. False means callers must fall back. */
  get available(): boolean {
    return !this.failed;
  }

  /** Build (or return) the context and bus graph. Null when unavailable. */
  private ensure(): Ctx | null {
    if (this.failed) return null;
    if (this.ctx) return this.ctx;
    try {
      const Ctor: typeof AudioContext =
        (globalThis as { AudioContext?: typeof AudioContext }).AudioContext ??
        (globalThis as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext!;
      if (!Ctor) throw new Error('no AudioContext');
      const ctx = new Ctor();
      const master = ctx.createGain();
      master.gain.value = 1;
      master.connect(ctx.destination);
      for (const id of ['PRIORITY', 'AMBIENT'] as BusId[]) {
        const g = ctx.createGain();
        g.gain.value = 1;
        g.connect(master);
        this.buses.set(id, g);
        this.configuredDb.set(id, 0);
      }
      this.ctx = ctx;
      this.master = master;
      this.noise = buildNoise(ctx);
      return ctx;
    } catch {
      // No Web Audio here. Say so once and let the caller degrade.
      this.failed = true;
      return null;
    }
  }

  /** Wake the context if it was suspended, and re-arm the idle timer. */
  private touch(ctx: Ctx): void {
    if (ctx.state === 'suspended') void ctx.resume();
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      if (this.priorityDepth === 0 && this.ctx?.state === 'running') void this.ctx.suspend();
    }, IDLE_SUSPEND_MS);
  }

  /** Set a bus's resting level. Ducking is applied relative to this. */
  setBusVolume(bus: BusId, volume0to1: number): void {
    const ctx = this.ensure();
    if (!ctx) return;
    const db = volume0to1 <= 0 ? -120 : 20 * Math.log10(Math.min(1, volume0to1));
    this.configuredDb.set(bus, db);
    if (bus === 'AMBIENT') this.applyDuck();
    else {
      const g = this.buses.get(bus);
      if (g) g.gain.setTargetAtTime(dbToGain(db), ctx.currentTime, 0.02);
    }
  }

  /** Push the ambient bus to its current target, ducked or not. */
  private applyDuck(): void {
    const ctx = this.ctx;
    const g = this.buses.get('AMBIENT');
    if (!ctx || !g) return;
    const active = this.priorityDepth > 0;
    const target = dbToGain(ambientGainDb(this.configuredDb.get('AMBIENT') ?? 0, active));
    const ms = duckRampMs(active);
    g.gain.cancelScheduledValues(ctx.currentTime);
    g.gain.setTargetAtTime(target, ctx.currentTime, ms / 3000);
  }

  /**
   * Play a decoded utterance through a bus with a profile.
   *
   * Resolves when the audio has finished. The returned promise never rejects
   * for musical reasons — only when the graph could not be built, which the
   * caller already handles by falling back.
   */
  async play(wav: ArrayBuffer, opts: PlayOptions): Promise<void> {
    const ctx = this.ensure();
    if (!ctx) throw new Error('radio bus unavailable');
    this.touch(ctx);

    const buffer = await ctx.decodeAudioData(wav.slice(0));
    const bus = this.buses.get(opts.bus)!;
    const p = opts.profile;
    const degrade = Math.max(0, Math.min(1, opts.degrade ?? 0));

    // The transmission's stereo seat (PlayOptions.pan). One panner for the
    // whole signal; skipped entirely at centre so the untouched path stays
    // byte-identical to what shipped before stereo existed.
    let out: AudioNode = bus;
    if (opts.pan && typeof ctx.createStereoPanner === 'function') {
      const panner = ctx.createStereoPanner();
      panner.pan.value = Math.max(-1, Math.min(1, opts.pan));
      panner.connect(bus);
      out = panner;
    }

    // Squelch: the channel opens, then speech starts. Everything below is
    // scheduled relative to this instant so the beeps land either side.
    const t0 = ctx.currentTime + 0.02;
    const squelch = p.squelchMs / 1000;
    const speechAt = t0 + squelch;
    // Playback rate changes how long the buffer actually takes to sound, and
    // the hiss envelope and roger beep are scheduled off that — get this wrong
    // and the beep lands mid-word on every persona that is not at unity.
    const rate = opts.timbre && opts.timbre !== 1 ? Math.max(0.5, Math.min(2, opts.timbre)) : 1;
    const dur = buffer.duration / rate;
    const endAt = speechAt + dur;

    // ---- voice chain -----------------------------------------------------
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    // The other half of the timbre trick: synthesized slow, played back fast.
    if (opts.timbre && opts.timbre !== 1) {
      src.playbackRate.value = Math.max(0.5, Math.min(2, opts.timbre));
    }
    let node: AudioNode = src;

    if (p.hpfHz > 0) {
      const hpf = ctx.createBiquadFilter();
      hpf.type = 'highpass';
      // Range degradation narrows the band from below as well as above.
      hpf.frequency.value = p.hpfHz * (1 + 0.35 * degrade);
      hpf.Q.value = 0.707;
      node.connect(hpf);
      node = hpf;
    }
    if (p.drive > 0) {
      const shaper = ctx.createWaveShaper();
      shaper.curve = driveCurve(Math.min(1, p.drive + 0.3 * degrade));
      shaper.oversample = '2x';
      node.connect(shaper);
      node = shaper;
    }
    if (p.lpfHz < ctx.sampleRate / 2) {
      const lpf = ctx.createBiquadFilter();
      lpf.type = 'lowpass';
      lpf.frequency.value = Math.max(800, p.lpfHz * (1 - 0.4 * degrade));
      lpf.Q.value = 0.707;
      node.connect(lpf);
      node = lpf;
    }

    const trim = ctx.createGain();
    // Drive raises perceived loudness; pull back so hot profiles do not jump.
    trim.gain.value = dbToGain(p.gainDb) * (1 - 0.35 * p.drive);
    node.connect(trim);
    trim.connect(out);

    // ---- hiss bed, gated to the transmission -----------------------------
    let hissSrc: AudioBufferSourceNode | null = null;
    if (p.hissDb !== null && this.noise) {
      hissSrc = ctx.createBufferSource();
      hissSrc.buffer = this.noise;
      hissSrc.loop = true;
      const hissGain = ctx.createGain();
      const level = dbToGain(p.hissDb + 10 * degrade);
      // The bed comes up with the squelch and leaves with the carrier — that
      // envelope IS the squelch effect; a constant hiss just sounds broken.
      hissGain.gain.setValueAtTime(0, t0);
      hissGain.gain.linearRampToValueAtTime(level, t0 + 0.04);
      hissGain.gain.setValueAtTime(level, endAt);
      hissGain.gain.linearRampToValueAtTime(0, endAt + 0.12);
      hissSrc.connect(hissGain);
      hissGain.connect(out);
      hissSrc.start(t0);
      hissSrc.stop(endAt + 0.2);
    }

    // ---- crackle ---------------------------------------------------------
    if (p.popsPerMin > 0) {
      const expected = (p.popsPerMin * (squelch + dur)) / 60;
      const count = poisson(expected);
      for (let i = 0; i < count; i++) {
        const at = t0 + Math.random() * (squelch + dur);
        this.pop(ctx, out, at, 0.06 + 0.06 * degrade);
      }
    }

    // ---- beeps -----------------------------------------------------------
    if (p.beep === 'open' || p.beep === 'both') this.beep(ctx, out, t0, 1180, 0.07);
    if (p.beep === 'roger' || p.beep === 'both') this.beep(ctx, out, endAt + 0.06, 1560, 0.09);

    if (opts.bus === 'PRIORITY') {
      this.priorityDepth += 1;
      this.applyDuck();
    }

    src.start(speechAt);

    return new Promise<void>((resolve) => {
      let settled = false;
      const done = (): void => {
        if (settled) return;
        settled = true;
        if (opts.bus === 'PRIORITY') {
          this.priorityDepth = Math.max(0, this.priorityDepth - 1);
          this.applyDuck();
        }
        try {
          src.disconnect();
          hissSrc?.stop();
        } catch {
          /* already stopped */
        }
        resolve();
      };
      src.onended = done;
      // Belt and braces: onended does not fire if the context is suspended
      // mid-utterance (the game grabbing focus can do it).
      const guard = setTimeout(done, (squelch + dur) * 1000 + DUCK_RESTORE_MS + 500);
      opts.signal?.addEventListener('abort', () => {
        clearTimeout(guard);
        try {
          src.stop();
        } catch {
          /* not started */
        }
        done();
      });
    });
  }

  /** A short tone. Two of these bracket a transmission. */
  private beep(ctx: Ctx, out: AudioNode, at: number, hz: number, len: number): void {
    const osc = ctx.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = hz;
    const g = ctx.createGain();
    // Hard edges click; a 8 ms fade reads as equipment.
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(0.14, at + 0.008);
    g.gain.setValueAtTime(0.14, at + len - 0.008);
    g.gain.linearRampToValueAtTime(0, at + len);
    osc.connect(g);
    g.connect(out);
    osc.start(at);
    osc.stop(at + len + 0.02);
  }

  /** One crackle: a very short filtered noise burst. */
  private pop(ctx: Ctx, out: AudioNode, at: number, level: number): void {
    if (!this.noise) return;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 900 + Math.random() * 2200;
    bp.Q.value = 1.4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(level, at);
    g.gain.exponentialRampToValueAtTime(0.0001, at + 0.035);
    src.connect(bp);
    bp.connect(g);
    g.connect(out);
    src.start(at, Math.random() * NOISE_SECONDS * 0.5);
    src.stop(at + 0.05);
  }

  /** Silence everything immediately — master mute, or CRISIS. */
  stopAll(): void {
    if (!this.ctx || !this.master) return;
    this.master.gain.cancelScheduledValues(this.ctx.currentTime);
    this.master.gain.setValueAtTime(0, this.ctx.currentTime);
    this.master.gain.setTargetAtTime(1, this.ctx.currentTime + 0.05, 0.01);
  }

  setMasterMuted(muted: boolean): void {
    const ctx = this.ensure();
    if (!ctx || !this.master) return;
    this.master.gain.setTargetAtTime(muted ? 0 : 1, ctx.currentTime, 0.02);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * One looping noise buffer for the whole session.
 *
 * Generating noise per utterance is the obvious implementation and the wrong
 * one — it allocates a multi-second Float32Array every time somebody speaks,
 * on a HUD that is running beside a game. Pink-ish rather than white: white
 * noise sounds like a hiss from a cheap effect, pink sounds like a room.
 */
function buildNoise(ctx: Ctx): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * NOISE_SECONDS);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  // Voss-McCartney-lite: a few decaying accumulators approximate 1/f cheaply.
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  for (let i = 0; i < len; i++) {
    const white = Math.random() * 2 - 1;
    b0 = 0.99765 * b0 + white * 0.099046;
    b1 = 0.963 * b1 + white * 0.2965164;
    b2 = 0.57 * b2 + white * 1.0526913;
    data[i] = (b0 + b1 + b2 + white * 0.1848) * 0.22;
  }
  return buf;
}

/**
 * Soft-clip transfer curve.
 *
 * `amount` 0..1 maps to a tanh-ish knee. Deliberately soft: hard clipping
 * makes speech unintelligible long before it makes it sound like radio, and
 * intelligibility is the whole point of a channel that carries market prices.
 */
type CurveArray = WaveShaperNode['curve'] & Float32Array;
const CURVE_CACHE = new Map<number, CurveArray>();
function driveCurve(amount: number): CurveArray {
  const key = Math.round(amount * 20) / 20;
  const cached = CURVE_CACHE.get(key);
  if (cached) return cached;
  const n = 1024;
  // Backed by a plain ArrayBuffer so it satisfies WaveShaperNode.curve, which
  // will not accept the SharedArrayBuffer-capable Float32Array default.
  const curve = new Float32Array(new ArrayBuffer(n * 4)) as CurveArray;
  const k = 1 + key * 40;
  for (let i = 0; i < n; i++) {
    const x = (i * 2) / (n - 1) - 1;
    curve[i] = Math.tanh(k * x) / Math.tanh(k);
  }
  CURVE_CACHE.set(key, curve);
  return curve;
}

/** Knuth's method — small means, so the loop is short. */
function poisson(mean: number): number {
  if (mean <= 0) return 0;
  const limit = Math.exp(-mean);
  let k = 0;
  let p = 1;
  do {
    k += 1;
    p *= Math.random();
  } while (p > limit && k < 64);
  return k - 1;
}
