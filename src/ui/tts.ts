/**
 * Text-to-speech with two engines (SPEC §3.3):
 *  - 'piper'  — the bundled local neural model (Piper + en_GB Alba voice),
 *               synthesized by the Rust sidecar. 100% offline & private.
 *  - 'system' — Windows speechSynthesis voices; cloud ("Natural") voices are
 *               filtered out unless local_voices_only is disabled.
 *
 * A single queue serializes utterances; de-dupe drops text repeated within a
 * short window so event storms never double-speak (T4.3).
 */
import type { AppSettings } from './settings.ts';
import { isTauri, piperSpeak } from './bridge.ts';

const DEDUPE_WINDOW_MS = 3 * 60_000;

export function listSystemVoices(localOnly: boolean): SpeechSynthesisVoice[] {
  if (typeof speechSynthesis === 'undefined') return [];
  const all = speechSynthesis.getVoices();
  return localOnly ? all.filter((v) => v.localService) : all;
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
}

export class Speaker {
  private queue: Utterance[] = [];
  private pumping = false;
  private recent = new Map<string, number>();
  private currentAudio: HTMLAudioElement | null = null;
  /** Piper marked unavailable after a failed synth — falls back to system. */
  private piperOk = true;

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
  speak(text: string, voice?: string | null): void {
    const s = this.getSettings();
    if (!s.voice.enabled) return;
    const clean = text.replace(/\s+/g, ' ').trim();
    if (!clean) return;
    const now = Date.now();
    const last = this.recent.get(clean);
    if (last !== undefined && now - last < DEDUPE_WINDOW_MS) return;
    this.recent.set(clean, now);
    if (this.recent.size > 200) {
      for (const [k, t] of this.recent) {
        if (now - t > DEDUPE_WINDOW_MS) this.recent.delete(k);
      }
    }
    this.queue.push({ text: clean, voice });
    void this.pump();
  }

  /** Speak regardless of de-dupe (settings "test voice" buttons). */
  test(voice?: string | null): void {
    this.queue.push(
      voice
        ? { text: 'This is the local wire, reading the system bulletin.', voice }
        : { text: 'Voice check. Mission Operator online and tracking.' },
    );
    void this.pump();
  }

  stop(): void {
    this.queue = [];
    if (typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    if (this.currentAudio) {
      this.currentAudio.pause();
      this.currentAudio = null;
    }
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const { text, voice } = this.queue.shift()!;
        const s = this.getSettings();
        if (!s.voice.enabled) continue;
        try {
          if (s.voice.engine === 'piper' && isTauri && this.piperOk) {
            await this.speakPiper(text, s, voice);
          } else {
            await this.speakSystem(text, s, voice);
          }
        } catch {
          // If piper failed, degrade to system voices for this session.
          if (s.voice.engine === 'piper') {
            this.piperOk = false;
            try {
              await this.speakSystem(text, s, voice);
            } catch {
              /* no speech available at all — stay silent */
            }
          }
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async speakPiper(text: string, s: AppSettings, voice?: string | null): Promise<void> {
    // Piper speed: length_scale is inverse of rate (2.0 = twice as slow).
    const lengthScale = 1 / Math.min(2, Math.max(0.5, s.voice.rate));
    const wav = await piperSpeak(text, lengthScale, voice ?? s.voice.piperVoice);
    const blob = new Blob([wav], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);
    try {
      await new Promise<void>((resolve, reject) => {
        const audio = new Audio(url);
        this.currentAudio = audio;
        audio.volume = Math.min(1, Math.max(0, s.voice.volume / 100));
        audio.onended = () => resolve();
        audio.onerror = () => reject(new Error('audio playback failed'));
        audio.play().catch(reject);
      });
    } finally {
      this.currentAudio = null;
      URL.revokeObjectURL(url);
    }
  }

  private speakSystem(text: string, s: AppSettings, voice?: string | null): Promise<void> {
    return new Promise((resolve, reject) => {
      if (typeof speechSynthesis === 'undefined') {
        reject(new Error('speechSynthesis unavailable'));
        return;
      }
      const u = new SpeechSynthesisUtterance(text);
      const voices = listSystemVoices(s.voice.localVoicesOnly);
      // A per-utterance override names a SYSTEM voice here, not a piper one;
      // when it does not match anything installed we fall back rather than
      // going silent, because a bulletin in the wrong voice still beats none.
      const pick = voice ?? s.voice.systemVoice;
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
      u.rate = s.voice.rate;
      u.volume = Math.min(1, Math.max(0, s.voice.volume / 100));
      u.onend = () => resolve();
      u.onerror = () => resolve(); // don't wedge the queue on utterance errors
      speechSynthesis.speak(u);
    });
  }
}
