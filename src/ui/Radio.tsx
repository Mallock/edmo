/**
 * The radio set — stations, a volume knob, and a spectrum analyser.
 *
 * The analyser is a deliberate homage: discrete stacked blocks, green through
 * amber to red, with peak caps that hang for a moment and then fall. That
 * look is not nostalgia for its own sake — blocks and a falling cap tell you
 * more at a glance than a smooth curve, which is why every hi-fi on earth
 * drew them that way for thirty years.
 *
 * It is fed from a tap on the MUSIC bus, so it shows what is actually HEARD:
 * when the operator cuts in and the radio ducks, the bars dip with it, and
 * the display explains the silence instead of contradicting it.
 */
import { useEffect, useRef } from 'react';
import { core } from './store.ts';
import { STATIONS } from '../engine/stations.ts';
import type { MusicState } from './music.ts';
import type { AppSettings } from './settings.ts';

/** Bars across the display. Two dozen reads as a spectrum, not a barcode. */
const BARS = 24;
/** How fast a peak cap falls, in bar-fractions per frame. */
const PEAK_FALL = 0.9;
/** Display height in CSS pixels, for the tab and for the strip that follows
 *  you around. The strip is deliberately not a token 12px sliver — at that
 *  size the bars are a texture, and the point is to be readable at a glance
 *  from whatever tab the HUD has switched itself to. */
const HEIGHT = 96;
const MINI_HEIGHT = 34;
/**
 * The slice of the spectrum worth drawing. A 128 kbps stream is low-passed
 * around 16 kHz — bins above that are silent by construction, and bars fed
 * from them would never move. Bin 170 of 256 is roughly that ceiling.
 */
const BIN_LO = 2;
const BIN_TOP = 170;
const BIN_SPAN = BIN_TOP / BIN_LO;
/** Bass held back, treble lifted — measured against a real stream. */
const TILT = Array.from({ length: BARS }, (_, i) => 1.0 + 1.15 * Math.pow(i / (BARS - 1), 1.3));

function Analyser({
  playing,
  height = HEIGHT,
  cell = 4,
  className = 'radio-vis',
}: {
  playing: boolean;
  /** Display height in CSS pixels. Also drives the canvas box, so the two
   *  can never drift apart the way a constant and a stylesheet do. */
  height?: number;
  /** Block pitch. Smaller blocks for the strip, or it reads as three fat rows. */
  cell?: number;
  className?: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const peaks = useRef<number[]>(new Array(BARS).fill(0));
  const idle = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx2d = canvas.getContext('2d');
    if (!ctx2d) return;
    const bins = new Uint8Array(1024);
    let raf = 0;

    const draw = (): void => {
      raf = requestAnimationFrame(draw);

      // Match the backing store to the panel and to the screen's real pixels.
      // A canvas of fixed size stretched by CSS draws soft edges, and soft
      // edges are the one thing a segmented display cannot survive.
      const dpr = Math.min(3, window.devicePixelRatio || 1);
      const w = Math.max(80, Math.round(canvas.clientWidth || 0));
      const h = height;
      if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
        canvas.width = Math.round(w * dpr);
        canvas.height = Math.round(h * dpr);
      }
      ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx2d.clearRect(0, 0, w, h);

      const live = playing && core.musicSpectrum(bins);
      idle.current += 0.05;

      const gap = 2;
      // Fractional pitch, so the bars reach both edges instead of leaving a
      // dead strip wherever the width does not divide by twenty-four.
      const pitch = (w + gap) / BARS;
      const barW = Math.max(2, pitch - gap);
      const rows = Math.floor(h / cell);

      for (let i = 0; i < BARS; i++) {
        let level: number;
        if (live) {
          // Bins are linear in frequency, hearing is not: octaves, not hertz.
          // Log spacing gives the bottom bars a bin or two each and the top
          // bars a wide slice, which is why a real analyser's bass end moves
          // in detail while the treble end moves as a block.
          const lo = Math.min(BIN_TOP - 1, Math.floor(BIN_LO * Math.pow(BIN_SPAN, i / BARS)));
          const hi = Math.max(lo + 1, Math.floor(BIN_LO * Math.pow(BIN_SPAN, (i + 1) / BARS)));
          let sum = 0;
          for (let b = lo; b < hi; b++) sum += bins[b];
          level = sum / (hi - lo) / 255;
          // The tilt. Music carries most of its energy in the bass, so an
          // untilted display pins its first bars at the ceiling and leaves the
          // last ones flat on the floor — twenty-four bars showing two facts.
          level = Math.min(1, level * TILT[i]);
        } else {
          // Nothing playing: a slow sine idles across the bars so the panel
          // looks switched on rather than broken.
          level = playing ? 0.04 : 0.05 + 0.04 * Math.sin(idle.current + i * 0.4);
        }

        const x = i * pitch;
        const litRows = Math.round(level * rows);
        for (let r = 0; r < rows; r++) {
          const frac = r / rows;
          if (r < litRows) {
            ctx2d.fillStyle =
              frac > 0.82 ? '#ff4d4d' : frac > 0.6 ? '#ffcc33' : '#33dd66';
          } else {
            ctx2d.fillStyle = 'rgba(122, 138, 160, 0.10)';
          }
          ctx2d.fillRect(x, h - (r + 1) * cell, barW, cell - 1);
        }

        // The peak cap: hangs where the bar last reached, then falls.
        const peak = peaks.current;
        peak[i] = Math.max(litRows, peak[i] - PEAK_FALL);
        const capRow = Math.min(rows - 1, Math.floor(peak[i]));
        if (capRow > 0) {
          ctx2d.fillStyle = 'rgba(230, 240, 255, 0.85)';
          ctx2d.fillRect(x, h - (capRow + 1) * cell, barW, Math.max(1, cell - 2));
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [playing, height, cell]);

  return <canvas ref={canvasRef} className={className} style={{ height }} />;
}

/**
 * The strip that stays.
 *
 * The HUD retunes its own view as the session moves — arrive somewhere and the
 * orrery takes the panel, open a market and the commodities do. Every one of
 * those is the right call and every one of them used to take the radio off the
 * screen with it. So the analyser also lives at the bottom, under whatever tab
 * is showing: what is playing, and the bars proving it still is. One click
 * puts the full set back.
 */
export function MiniRadio({ music }: { music: MusicState | null }) {
  const playing = !!music?.playing;
  const line = music?.error ?? music?.nowPlaying ?? music?.label ?? 'Tuning…';
  return (
    <button
      className="radio-mini"
      title={`${music?.label ?? 'Radio'} — click for the dial`}
      aria-label="Open the radio"
      onClick={() => core.setView('radio')}
    >
      <Analyser playing={playing} height={MINI_HEIGHT} cell={3} className="radio-vis mini" />
      <span className="radio-mini-line">
        <span className={playing ? 'radio-led on' : 'radio-led'} />
        <span className="radio-track">{line}</span>
      </span>
    </button>
  );
}

export function RadioCard({ music, settings }: { music: MusicState | null; settings: AppSettings }) {
  const s = settings.music;
  const playing = !!music?.playing;

  return (
    <div className="ship-panel">
      <div className="sp-title mono">📻 RADIO</div>

      <Analyser playing={playing} />

      {/* What is on, and what it is doing. */}
      <div className="radio-now">
        <span className={playing ? 'radio-led on' : 'radio-led'} />
        <span className="radio-track">
          {!s.enabled
            ? 'Off'
            : music?.error
              ? music.error
              : (music?.nowPlaying ?? music?.label ?? 'Tuning…')}
        </span>
      </div>

      <div className="radio-controls">
        <button
          className="btn"
          onClick={() => core.setMusicEnabled(!s.enabled)}
          title={s.enabled ? 'Switch the radio off' : 'Switch the radio on'}
        >
          {s.enabled ? '⏹ Off' : '▶ On'}
        </button>
        <input
          type="range"
          min={0}
          max={100}
          value={s.volume}
          aria-label="Radio volume"
          onChange={(e) => core.setMusicVolume(Number(e.target.value))}
        />
        <span className="mono radio-vol">{s.volume}</span>
      </div>

      <label className="check radio-follow">
        <input
          type="checkbox"
          checked={s.followActivity}
          onChange={(e) => core.setMusicFollow(e.target.checked)}
        />
        Follow the work — the rings get drone, hauls get rock
      </label>

      {/* The dial. One click, no trip to Settings. */}
      <div className="radio-dial">
        {STATIONS.map((st) => (
          <button
            key={st.id}
            className={st.id === s.station && s.enabled ? 'radio-station on' : 'radio-station'}
            title={`${st.blurb} · ${st.source}`}
            onClick={() => core.setMusicStation(st.id)}
          >
            {st.label}
          </button>
        ))}
      </div>

      <div className="empty-hint">
        Ducks under the operator, thins under comms traffic. Streams from SomaFM, Nightride FM and
        Fallout.FM — the only part of this app that stays connected.
      </div>
    </div>
  );
}
