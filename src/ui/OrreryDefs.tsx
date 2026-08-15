/**
 * Surfaces for the orrery, generated rather than downloaded.
 *
 * Elite ships no texture maps and this app ships no asset files, so the
 * planets are painted procedurally — the same idea as the SDL2 noise demos,
 * but expressed as SVG `feTurbulence`, which IS Perlin noise and which the
 * browser composites on the GPU instead of looping over pixels on the CPU.
 * That distinction is the whole reason this is affordable in a HUD that must
 * not steal frames from the game.
 *
 * The cost control is `<pattern>`. A filter attached to 36 circles is 36
 * filter evaluations a frame; a filter attached to one rect inside a pattern
 * is ONE, and every body that fills with that pattern reuses the cached tile.
 * So this file is a fixed set of defs whose cost does not grow with the size
 * of the system.
 *
 * Nothing in here is claimed to be that particular world. The class is what
 * the journal states; the grain is invention, kept generic on purpose.
 */
import type { Surface } from '../engine/orrery.ts';

/**
 * Bearing of `#orrShade`'s highlight, in degrees, before any rotation.
 *
 * The gradient's focus sits at (0.32, 0.32) of the bounding box — up and left
 * of the centre at (0.5, 0.5) — so the lit point bears −135°. Lives here, next
 * to the gradient it describes, because the two must change together: rotating
 * a body by its star's bearing alone lit every planet 45° away from its sun.
 */
export const SHADE_HIGHLIGHT_DEG = -135;

/** Base colour per surface, before shading. */
export const SURFACE_BASE: Record<Surface, string> = {
  star: '#f0a030',
  icy: '#cfe4f2',
  rock: '#9a8f86',
  metal: '#c08a4e',
  ocean: '#3f8fb8',
  gas: '#d9bc8a',
  ammonia: '#b98a6a',
  none: '#7a8aa0',
};

/** The textured classes. `star` and `none` are drawn flat. */
const TEXTURED: Array<{
  key: Surface;
  /** Anisotropic frequency is what turns noise into bands on a gas giant. */
  freq: string;
  octaves: number;
  /** Second, darker tone the noise mixes toward. */
  shade: string;
  /** How strongly the grain shows. */
  alpha: number;
}> = [
  { key: 'icy', freq: '0.9', octaves: 3, shade: '#6f97b8', alpha: 0.55 },
  { key: 'rock', freq: '1.1', octaves: 4, shade: '#5d534b', alpha: 0.7 },
  { key: 'metal', freq: '1.0', octaves: 4, shade: '#6d4520', alpha: 0.7 },
  { key: 'ocean', freq: '0.7', octaves: 3, shade: '#1d4f73', alpha: 0.6 },
  { key: 'ammonia', freq: '0.8', octaves: 3, shade: '#6f4a33', alpha: 0.6 },
  // Bands, not blotches: stretch the noise 20× along x and it reads as weather.
  { key: 'gas', freq: '0.06 1.2', octaves: 2, shade: '#8a6b3f', alpha: 0.75 },
];

/** Tile size in user units. Small enough to look fine on a 5 px moon. */
const TILE = 24;

export function OrreryDefs() {
  return (
    <defs>
      {/*
        The terminator. One gradient, reused by every body, with the lit side
        fixed toward -x; each body is rotated so that side faces its own star.
        Sphere shading is symmetric about the light axis, so a rotation is all
        it takes — no per-body gradient, no per-body filter.
      */}
      <radialGradient id="orrShade" cx="0.32" cy="0.32" r="0.78">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.42" />
        <stop offset="38%" stopColor="#fff" stopOpacity="0.06" />
        <stop offset="62%" stopColor="#000" stopOpacity="0.18" />
        <stop offset="100%" stopColor="#000" stopOpacity="0.72" />
      </radialGradient>

      {/* A star is a light source, not a lit body: it gets a corona instead. */}
      <radialGradient id="orrStarGlow">
        <stop offset="0%" stopColor="#fff" stopOpacity="0.95" />
        <stop offset="45%" stopColor="#ffd28a" stopOpacity="0.55" />
        <stop offset="100%" stopColor="#f0a030" stopOpacity="0" />
      </radialGradient>

      {TEXTURED.map((t) => (
        <filter key={`f-${t.key}`} id={`orrTex-${t.key}`} x="0" y="0" width="100%" height="100%">
          <feTurbulence
            type="fractalNoise"
            baseFrequency={t.freq}
            numOctaves={t.octaves}
            seed={t.key.length * 7}
            result="n"
          />
          {/* Noise → a single tone ramp between the base and its darker twin,
              rather than the rainbow feTurbulence produces on its own. */}
          <feColorMatrix
            in="n"
            type="matrix"
            values={`0 0 0 0 0
                     0 0 0 0 0
                     0 0 0 0 0
                     0.33 0.33 0.33 0 0`}
            result="a"
          />
          <feFlood floodColor={t.shade} floodOpacity={t.alpha} result="c" />
          <feComposite in="c" in2="a" operator="in" />
        </filter>
      ))}

      {TEXTURED.map((t) => (
        <pattern
          key={`p-${t.key}`}
          id={`orrPat-${t.key}`}
          patternUnits="userSpaceOnUse"
          width={TILE}
          height={TILE}
        >
          <rect width={TILE} height={TILE} fill={SURFACE_BASE[t.key]} />
          {/* The one filtered element per class. Everything else reuses it. */}
          <rect width={TILE} height={TILE} filter={`url(#orrTex-${t.key})`} />
        </pattern>
      ))}
    </defs>
  );
}
