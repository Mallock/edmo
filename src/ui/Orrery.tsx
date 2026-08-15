/**
 * The Orrery tab — the system map, top-down, at the size of a HUD.
 *
 * The game already draws this and then puts it behind a full-screen mode you
 * cannot open while flying, which is the same complaint that produced the route
 * plotter and the architect list. What is wanted mid-flight is not the pretty
 * one: it is where things are relative to each other, now, and how long until
 * that changes.
 *
 * Top-down on purpose. Three dimensions in a 420 px panel buys a viewing angle
 * to fiddle with and loses the one thing the panel is for — reading it in a
 * glance. Inclination is not discarded, it is applied and then projected, so a
 * steeply inclined moon draws where it really is from above.
 *
 * All the arithmetic is engine/orrery.ts; this renders it.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_SCALE,
  bodyRadiusPx,
  orbitPath,
  lightSource,
  materialGrade,
  placeBelts,
  placeLabels,
  placeSystem,
  separateDiscs,
  surfaceOf,
  type OrreryBody,
  type OrrerySystem,
  type PlacedBody,
  type ScaleOptions,
} from '../engine/orrery.ts';
import { OrreryDefs, SHADE_HIGHLIGHT_DEG, SURFACE_BASE } from './OrreryDefs.tsx';

/** Warp steps. 1× is honest and completely still; the rest are for reading. */
const WARPS = [1, 1_000, 100_000] as const;
const WARP_LABEL: Record<number, string> = {
  1: 'live',
  1_000: '×1k',
  100_000: '×100k',
};

const VIEW_W = 400;
const VIEW_H = 260;
const CX = VIEW_W / 2;
const CY = VIEW_H / 2;
/** Room for a body drawn at the very edge, plus its label. */
const MARGIN = 16;
/** How far separation may drag a body from where it really is, in pixels. */
const MAX_SHIFT = 15;
const MIN_ZOOM = 1;
const MAX_ZOOM = 14;
/**
 * Pixels of travel before a press counts as a drag rather than a tap.
 *
 * A mouse moves a little between press and release, and a finger moves more.
 * Below this, the gesture is a tap and must reach the body under it.
 */
const DRAG_SLOP = 4;

/**
 * The colour a body's NAME is written in — its own surface, so the label and
 * the thing it labels are obviously the same object.
 *
 * Painting bodies by class took the green off landable worlds, which used to
 * be the one operational fact the map carried. It comes back as a ring around
 * the body rather than as its fill: a hue still means one thing, and "you can
 * put a ship on this" is worth more than the tenth shade of grey.
 */
const colourOf = (b: OrreryBody): string => {
  if (b.kind === 'star') return 'var(--amber)';
  if (b.kind === 'barycentre') return 'var(--dim)';
  if (b.landable) return 'var(--green)';
  return SURFACE_BASE[surfaceOf(b)];
};

const fmtLs = (ls: number): string => {
  if (ls >= 1000) return `${Math.round(ls).toLocaleString('en-US')} ls`;
  if (ls >= 10) return `${ls.toFixed(0)} ls`;
  if (ls >= 1) return `${ls.toFixed(1)} ls`;
  return `${ls.toFixed(3)} ls`;
};

/**
 * Surface gravity in G, which is the unit that decides whether to land.
 *
 * The journal reports m/s². 1 G is the number a commander has a feel for;
 * 9.8 m/s² is a number they would have to convert mid-approach.
 */
const fmtG = (ms2: number): string => `${(ms2 / 9.80665).toFixed(2)} G`;

/**
 * High gravity is not trivia, it is the thing that writes off ships.
 *
 * Above ~2 G a routine landing stops being routine; above 3 G it will break a
 * large ship put down carelessly. The number turns amber then red rather than
 * sitting in the same grey as the orbital period.
 */
const gravityClass = (ms2: number): string => {
  const g = ms2 / 9.80665;
  if (g >= 3) return 'v mono grav-hi';
  if (g >= 2) return 'v mono grav-mid';
  return 'v mono';
};

/** Orbital period in the largest unit that stays readable. */
const fmtPeriod = (seconds: number): string => {
  const d = seconds / 86_400;
  if (d < 1) return `${(seconds / 3600).toFixed(1)} h`;
  if (d < 365) return `${d.toFixed(1)} d`;
  return `${(d / 365.25).toFixed(1)} y`;
};

const describe = (b: OrreryBody): string => {
  if (b.kind === 'star') return `Class ${b.starType ?? '?'} star`;
  if (b.kind === 'barycentre') return 'Barycentre — a point two bodies orbit';
  if (b.kind === 'belt') return 'Belt cluster';
  return b.planetClass ?? 'Planet';
};

export interface OrreryView {
  system: OrrerySystem | null;
  /** The body the commander is at or near, highlighted if it is on the map. */
  hereBodyId: number | null;
  /** Drawable bodies, for the tab badge — belts are not counted, being bands. */
  bodyCount: number;
  /**
   * How much of each material the commander is already carrying, keyed by the
   * journal's lowercase name.
   *
   * "Tellurium 1.2%" is a fact about the rock. "Tellurium 1.2%, you have 3" is
   * a reason to land, and the app already tracks the second half.
   */
  matCounts: Record<string, number>;
}

export function OrreryCard({ view, nowMs }: { view: OrreryView; nowMs: number }) {
  const [warp, setWarp] = useState<number>(1);
  const [trueScale, setTrueScale] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  /**
   * Zoom and pan as ONE piece of state.
   *
   * They were two, and zooming had to set pan from inside the zoom updater to
   * keep the pointer anchored — a side effect inside a reducer, which React
   * runs twice in StrictMode and which therefore panned twice per notch.
   */
  const [cam, setCam] = useState({ zoom: 1, x: 0, y: 0 });
  const { zoom } = cam;
  const pan = cam;
  const svgRef = useRef<SVGSVGElement | null>(null);
  const drag = useRef<{
    startX: number;
    startY: number;
    camX: number;
    camY: number;
    /** False until the pointer has moved far enough to mean "pan", not "tap". */
    active: boolean;
  } | null>(null);
  /** True for the instant after a pan, so its trailing click selects nothing. */
  const justDragged = useRef(false);
  const [dragging, setDragging] = useState(false);

  // A new system is a new map: keep the previous one's zoom and you land
  // somewhere at 8× looking at empty space.
  const systemKey = view.system?.address ?? '';
  useEffect(() => {
    setCam({ zoom: 1, x: 0, y: 0 });
    setPicked(null);
  }, [systemKey]);

  /** Client coords → viewBox coords, which is where all the geometry lives. */
  const toView = useCallback((clientX: number, clientY: number) => {
    const el = svgRef.current;
    if (!el) return { x: CX, y: CY };
    const r = el.getBoundingClientRect();
    return {
      x: ((clientX - r.left) / r.width) * VIEW_W,
      y: ((clientY - r.top) / r.height) * VIEW_H,
    };
  }, []);

  /**
   * Wheel to zoom, anchored on the pointer.
   *
   * Registered by hand rather than with onWheel because React attaches wheel
   * listeners passively, and a passive listener cannot preventDefault — so the
   * HUD scrolled behind the map every time someone tried to zoom it.
   */
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const { x, y } = toView(e.clientX, e.clientY);
      setCam((c) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * Math.exp(-e.deltaY * 0.0015)));
        const f = next / c.zoom;
        // Keep whatever is under the pointer under the pointer: solve for the
        // pan that leaves this view-space point fixed as the scale changes.
        return {
          zoom: next,
          x: x - CX - (x - CX - c.x) * f,
          y: y - CY - (y - CY - c.y) * f,
        };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [toView]);

  const resetView = () => setCam({ zoom: 1, x: 0, y: 0 });

  /**
   * Simulated time, anchored rather than accumulated.
   *
   * `sim = anchor.sim + (real − anchor.real) × warp`, re-anchored whenever the
   * warp changes. Adding a per-frame delta instead would accumulate rounding
   * for as long as the tab stayed open, which is exactly the drift the closed
   * form in the engine exists to avoid.
   */
  const anchor = useRef({ real: nowMs, sim: nowMs });
  useEffect(() => {
    anchor.current = { real: Date.now(), sim: anchor.current.sim };
  }, [warp]);

  /**
   * A faster tick, but only while warping.
   *
   * The HUD shares App's 1 Hz clock, which is right for countdowns and far too
   * coarse for a planet crossing the panel. 4 Hz while warped is smooth enough
   * to follow and stops the moment it is not needed — this thing floats over a
   * game, and an animation loop nobody asked for is frames stolen from it.
   */
  const [spin, setSpin] = useState(0);
  useEffect(() => {
    if (warp === 1) return;
    const id = setInterval(() => setSpin((n) => n + 1), 250);
    return () => clearInterval(id);
  }, [warp]);

  const simMs =
    warp === 1 ? nowMs : anchor.current.sim + (Date.now() - anchor.current.real) * warp;

  const opts: ScaleOptions = useMemo(
    () => ({ ...DEFAULT_SCALE, mode: trueScale ? 'true' : 'compressed' }),
    [trueScale],
  );

  const sys = view.system;

  /**
   * Place everything, then frame it by its actual BOUNDS.
   *
   * Fitting by furthest-distance-from-the-star assumes the system is spread
   * evenly around it, and no system is: HIP 71120 packs 36 bodies into two
   * clumps and left a third of the panel empty. Measuring the box the content
   * really occupies, and centring that, uses the whole card.
   */
  const { placed, belts, fit } = useMemo(() => {
    const empty = { placed: [] as PlacedBody[], belts: [] as ReturnType<typeof placeBelts>, fit: { k: 1, cx: 0, cy: 0 } };
    if (!sys) return empty;
    const p = placeSystem(sys, simMs, opts);
    const b = placeBelts(sys, simMs, opts);
    if (!p.length && !b.length) return empty;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    const grow = (x: number, y: number, pad = 0) => {
      minX = Math.min(minX, x - pad);
      maxX = Math.max(maxX, x + pad);
      minY = Math.min(minY, y - pad);
      maxY = Math.max(maxY, y + pad);
    };
    for (const q of p) grow(q.x, q.y);
    for (const q of b) grow(q.cx, q.cy, q.r);

    const w = Math.max(maxX - minX, 1e-6);
    const h = Math.max(maxY - minY, 1e-6);
    // MARGIN leaves room for the body drawn at the very edge and its label.
    const k = Math.min((VIEW_W - 2 * MARGIN) / w, (VIEW_H - 2 * MARGIN) / h);
    return { placed: p, belts: b, fit: { k, cx: (minX + maxX) / 2, cy: (minY + maxY) / 2 } };
    // `spin` is a deliberate dependency: it is what advances a warped view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sys, simMs, opts, spin]);

  /** display-ls → panel pixels, including the commander's zoom and pan. */
  const project = useCallback(
    (x: number, y: number) => ({
      px: CX + (x - fit.cx) * fit.k * zoom + pan.x,
      py: CY + (y - fit.cy) * fit.k * zoom + pan.y,
    }),
    [fit, zoom, pan],
  );

  /**
   * The bodies, projected and then pushed apart until they are countable.
   *
   * Separation is the whole point of the panel: at 36 bodies the clumps were
   * single blobs you could not click, let alone read. It runs only in
   * compressed mode — true-distance mode is the one that must not be
   * massaged — and nothing moves further than MAX_SHIFT from where it is,
   * so a body stays on its own orbit ring.
   */
  const drawn = useMemo(() => {
    const discs = placed.map((p) => {
      const { px, py } = project(p.x, p.y);
      // Radii grow with zoom, so separation has to be recomputed against the
      // bodies as they will actually be drawn, not as they were at 1×.
      return { p, x: px, y: py, r: bodyRadiusPx(p.body, zoom), hx: px, hy: py };
    });
    return trueScale ? discs : separateDiscs(discs, 2, MAX_SHIFT * Math.min(2.5, zoom));
  }, [placed, project, trueScale, zoom]);

  /**
   * Which way is the sun, per body, in degrees.
   *
   * The only honest thing on a drawn planet: the star's position comes from
   * the same elements as everything else, so the lit limb really does face the
   * light and the terminator really is where day ends.
   */
  const lightAngle = useMemo(() => {
    const m = new Map<number, number>();
    for (const d of drawn) {
      const star = lightSource(placed, d.p);
      if (!star) continue;
      const s = project(star.x, star.y);
      m.set(d.p.body.id, (Math.atan2(s.py - d.y, s.px - d.x) * 180) / Math.PI);
    }
    return m;
  }, [drawn, placed, project]);

  /**
   * Surfaces cost something, and at 1× they would be a texture on a five-pixel
   * dot. They switch on once bodies are big enough to show one.
   */
  const textured = zoom >= 2.2;

  /**
   * Name every body that has somewhere to put its name.
   *
   * Priority decides who gets the good berth when two names want the same
   * space: the star first, then the body the ship is at, then whatever is
   * selected, then landable worlds, then the rest. Barycentres come last —
   * "⊕56" is the least interesting thing on the map.
   */
  const labels = useMemo(() => {
    const wishes = drawn.map(({ p, x, y, r }) => ({
      key: p.body.id,
      text: p.body.label,
      x,
      y,
      r,
      // The selected name is drawn a size up (see .orr-label.picked), so it
      // must be measured a size up too or it books a berth it does not fit in.
      width: p.body.label.length * (p.body.id === picked ? 5.9 : 4.9),
      priority:
        p.body.kind === 'star' ? 0
        : p.body.id === view.hereBodyId ? 1
        : p.body.id === picked ? 2
        : p.body.kind === 'barycentre' ? 5
        : p.body.landable ? 3
        : 4,
    }));
    return placeLabels(wishes, { bodies: drawn });
  }, [drawn, view.hereBodyId, picked]);

  const colourFor = useMemo(() => {
    const m = new Map<number, string>();
    for (const { p } of drawn) m.set(p.body.id, colourOf(p.body));
    return m;
  }, [drawn]);

  // Orbit paths follow the same transform. They are the TRUE path — bodies may
  // sit a few pixels off them after separation, which the selected body's
  // leader line makes explicit rather than hiding.
  const paths = useMemo(() => {
    if (!sys) return [];
    return placed
      .filter((p) => p.body.elements)
      .map((p) => ({
        id: p.body.id,
        d: orbitPath(sys, p.body.id, simMs, opts, 64)
          .map((pt, i) => {
            const { px, py } = project(pt.x, pt.y);
            return `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`;
          })
          .join(' '),
      }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sys, opts, project, spin]);

  if (!sys || !placed.length) {
    return (
      <div className="card orrery">
        <div className="card-title">🪐 Orrery</div>
        <div className="orr-empty">
          Nothing scanned here — and the discovery scan will not change that. The honk reports
          how many bodies exist and where the signals are; the <b>orbits</b> only ever arrive on
          a <b>Scan</b>. Open the FSS and resolve a few, or scan the nav beacon in a populated
          system to get the lot at once. Anything you have scanned here before is already loaded.
        </div>
      </div>
    );
  }

  const sel = picked != null ? (placed.find((p) => p.body.id === picked) ?? null) : null;
  const scanned = placed.filter((p) => p.body.scanned).length;

  return (
    <div className="card orrery">
      <div className="card-title">
        🪐 {sys.name || 'Orrery'}
        <span className="orr-count mono">
          {scanned} scanned{belts.length ? ` · ${belts.length} belt` : ''}
        </span>
      </div>

      <div className="orr-plot">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
          className={dragging ? 'orr-svg dragging' : 'orr-svg'}
          role="img"
          aria-label={`Top-down map of ${sys.name}, ${scanned} bodies placed from their scanned orbits. Scroll to zoom, drag to pan.`}
          /*
           * Pan without eating the click.
           *
           * Capturing the pointer on pointerdown retargets every later pointer
           * event — and the click — to the SVG, so no body's onClick ever ran
           * and tapping a planet did nothing at all. The capture is what pan
           * needs and what selection could not survive.
           *
           * So the drag is only ARMED on pointerdown. It becomes real, and
           * takes the capture, once the pointer has moved past a few pixels;
           * a press that never moves is left alone to become a click on
           * whatever is under it.
           */
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            drag.current = {
              startX: e.clientX,
              startY: e.clientY,
              camX: cam.x,
              camY: cam.y,
              active: false,
            };
          }}
          onPointerMove={(e) => {
            const d = drag.current;
            const el = svgRef.current;
            if (!d || !el) return;
            const dx = e.clientX - d.startX;
            const dy = e.clientY - d.startY;
            if (!d.active) {
              if (Math.hypot(dx, dy) < DRAG_SLOP) return;
              d.active = true;
              setDragging(true);
              el.setPointerCapture(e.pointerId);
            }
            // Drag in CSS pixels, pan in viewBox units — the panel is scaled to
            // the card's width, so the two are not the same distance.
            const r = el.getBoundingClientRect();
            setCam((c) => ({
              ...c,
              x: d.camX + (dx / r.width) * VIEW_W,
              y: d.camY + (dy / r.height) * VIEW_H,
            }));
          }}
          onPointerUp={(e) => {
            const wasDragging = drag.current?.active ?? false;
            if (wasDragging) {
              e.currentTarget.releasePointerCapture(e.pointerId);
              // The click lands after this; swallow it so letting go of a pan
              // over a planet does not also select the planet.
              justDragged.current = true;
              setTimeout(() => {
                justDragged.current = false;
              }, 0);
            }
            drag.current = null;
            setDragging(false);
          }}
          onPointerCancel={() => {
            drag.current = null;
            setDragging(false);
          }}
          onDoubleClick={resetView}
        >
          <OrreryDefs />
          {/* Belts first: they are the backdrop other things pass in front of. */}
          {belts.map((b) => {
            const c = project(b.cx, b.cy);
            return (
              <circle
                key={`belt-${b.body.id}`}
                cx={c.px}
                cy={c.py}
                r={Math.max(1, b.r * fit.k * zoom)}
                fill="none"
                stroke="var(--dim)"
                strokeWidth="2.5"
                strokeDasharray="1 3"
                opacity="0.5"
              />
            );
          })}
          {paths.map((p) => (
            <path
              key={`orb-${p.id}`}
              d={p.d}
              fill="none"
              stroke={p.id === picked ? 'var(--amber)' : 'rgba(255, 255, 255, 0.22)'}
              strokeWidth={p.id === picked ? 1.2 : 0.8}
              opacity={p.id === picked ? 0.9 : 0.55}
            />
          ))}
          {drawn.map(({ p, x, y, r, hx, hy }) => {
            const colour = colourOf(p.body);
            if (p.body.kind === 'barycentre') {
              // Not a thing, a point. Drawn as one, so it is never mistaken
              // for an unscanned body sitting in the middle of a binary.
              return (
                <g key={p.body.id} opacity="0.55">
                  <line x1={x - 2.5} y1={y} x2={x + 2.5} y2={y} stroke={colour} strokeWidth="0.9" />
                  <line x1={x} y1={y - 2.5} x2={x} y2={y + 2.5} stroke={colour} strokeWidth="0.9" />
                </g>
              );
            }
            return (
              <g
                key={p.body.id}
                className="orr-body"
                onClick={() => {
                  // A pan that ends over a planet is not a request to open it.
                  if (justDragged.current) return;
                  setPicked(picked === p.body.id ? null : p.body.id);
                }}
                role="button"
                tabIndex={0}
                aria-label={`${p.body.label} — ${describe(p.body)}`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setPicked(picked === p.body.id ? null : p.body.id);
                  }
                }}
              >
                {/* Separation moved this body off its orbit. For the one being
                    inspected, say so with a leader back to the real position
                    rather than letting the ring quietly disagree with the dot. */}
                {p.body.id === picked && Math.hypot(x - hx, y - hy) > 2 && (
                  <line
                    x1={hx}
                    y1={hy}
                    x2={x}
                    y2={y}
                    stroke="var(--amber)"
                    strokeWidth="0.7"
                    strokeDasharray="1.5 1.5"
                    opacity="0.8"
                  />
                )}
                {p.body.id === view.hereBodyId && (
                  <circle cx={x} cy={y} r={r + 4} fill="none" stroke="var(--green)" strokeWidth="1" opacity="0.9" />
                )}
                {/* Planets only. A star's `Rings` ARE its belt clusters, which
                    are already drawn as bands — the ellipse reported the same
                    thing a second time, smaller and in the wrong place. */}
                {p.body.ringed && p.body.kind !== 'star' && (
                  <ellipse
                    cx={x}
                    cy={y}
                    rx={r * 2.1}
                    ry={r * 0.7}
                    fill="none"
                    stroke={colour}
                    strokeWidth="0.8"
                    opacity="0.6"
                  />
                )}
                {(() => {
                  const surf = surfaceOf(p.body);
                  const ang = lightAngle.get(p.body.id) ?? 180;
                  // A star is the light, so it gets a corona rather than a
                  // terminator; everything else is lit by one.
                  if (surf === 'star') {
                    return (
                      <>
                        <circle cx={x} cy={y} r={r * 2.6} fill="url(#orrStarGlow)" opacity="0.5" />
                        <circle
                          cx={x}
                          cy={y}
                          r={r}
                          fill={colour}
                          stroke={p.body.id === picked ? 'var(--text)' : 'rgba(0,0,0,0.5)'}
                          strokeWidth={p.body.id === picked ? 1.4 : 0.8}
                        />
                      </>
                    );
                  }
                  const fill =
                    textured && surf !== 'none' ? `url(#orrPat-${surf})` : SURFACE_BASE[surf];
                  return (
                    <>
                      <circle cx={x} cy={y} r={r} fill={fill} />
                      {/* The lit side, rotated to face this body's own star.
                          One shared gradient for the whole map — sphere shading
                          is symmetric about the light axis, so a rotation does
                          what a per-body gradient would have cost.

                          Subtracting the gradient's own highlight bearing is
                          what aims it: rotating by the star's bearing alone
                          left every planet lit 45° away from its own sun. */}
                      <circle
                        cx={x}
                        cy={y}
                        r={r}
                        fill="url(#orrShade)"
                        transform={`rotate(${(ang - SHADE_HIGHLIGHT_DEG).toFixed(0)} ${x.toFixed(1)} ${y.toFixed(1)})`}
                      />
                      {/* Landable worlds keep their green — as a rim now, so
                          the surface can be its own colour without losing the
                          one thing on this map you can act on. */}
                      <circle
                        cx={x}
                        cy={y}
                        r={r}
                        fill="none"
                        stroke={
                          p.body.id === picked
                            ? 'var(--text)'
                            : p.body.landable
                              ? 'var(--green)'
                              : 'rgba(0,0,0,0.55)'
                        }
                        strokeWidth={p.body.id === picked ? 1.4 : p.body.landable ? 1.1 : 0.7}
                      />
                    </>
                  );
                })()}
              </g>
            );
          })}
          {/* Names last, so they sit over the lines rather than under them.
              Drawn as one layer because placement is a decision about the map
              as a whole, not about any single body. */}
          {labels.map((l) => (
            <text
              key={`lab-${l.key}`}
              x={l.x}
              y={l.y}
              textAnchor={l.anchor}
              className={l.key === picked ? 'orr-label picked' : 'orr-label'}
              fill={colourFor.get(l.key) ?? 'var(--text)'}
            >
              {l.text}
            </text>
          ))}
        </svg>
      </div>

      <div className="orr-controls">
        <div className="orr-warp" role="group" aria-label="Time warp">
          {WARPS.map((w) => (
            <button
              key={w}
              className={warp === w ? 'orr-chip active' : 'orr-chip'}
              aria-pressed={warp === w}
              onClick={() => setWarp(w)}
            >
              {WARP_LABEL[w]}
            </button>
          ))}
        </div>
        {zoom > 1.01 && (
          <button className="orr-chip" onClick={resetView} title="Back to the whole system">
            {zoom.toFixed(1)}× ✕
          </button>
        )}
        <button
          className={trueScale ? 'orr-chip active' : 'orr-chip'}
          aria-pressed={trueScale}
          title={
            trueScale
              ? 'True distances — inner bodies collapse onto the star, because that is where they are'
              : 'Distances compressed per level so moons stay visible; order is preserved'
          }
          onClick={() => setTrueScale(!trueScale)}
        >
          {trueScale ? 'true dist' : 'compressed'}
        </button>
      </div>

      {/* Say which one it is, always. A map that silently lies about scale is
          worse than one that does not draw. */}
      <div className="orr-note">
        {trueScale
          ? 'True distances · body sizes exaggerated · nothing nudged'
          : 'Compressed & separated · order preserved, spacing is not'}
        {warp !== 1 && ' · warped'}
      </div>

      {sel ? (
        <div className="orr-detail">
          <div className="orr-detail-head" style={{ color: colourOf(sel.body) }}>
            {sel.body.label}
            <span className="orr-detail-kind">{describe(sel.body)}</span>
          </div>
          <div className="orr-detail-grid">
            {sel.body.distanceLs != null && (
              <div>
                <div className="k">From arrival</div>
                <div className="v mono">{fmtLs(sel.body.distanceLs)}</div>
              </div>
            )}
            {sel.trueLs > 0 && (
              <div>
                <div className="k">From parent</div>
                <div className="v mono">{fmtLs(sel.trueLs)}</div>
              </div>
            )}
            {sel.body.elements && (
              <div>
                <div className="k">Orbit</div>
                <div className="v mono">{fmtPeriod(sel.body.elements.period)}</div>
              </div>
            )}
            {sel.body.elements && sel.body.elements.eccentricity > 0.05 && (
              <div>
                <div className="k">Eccentricity</div>
                <div className="v mono">{sel.body.elements.eccentricity.toFixed(2)}</div>
              </div>
            )}
            {/* Gravity leads the surface numbers because it is the one that
                breaks ships. Everything above 1 G is worth reading before you
                commit to a landing. */}
            {sel.body.gravity != null && sel.body.gravity > 0 && (
              <div>
                <div className="k">Gravity</div>
                <div className={gravityClass(sel.body.gravity)}>{fmtG(sel.body.gravity)}</div>
              </div>
            )}
            {sel.body.temperature != null && sel.body.temperature > 0 && (
              <div>
                <div className="k">Surface</div>
                <div className="v mono">{Math.round(sel.body.temperature)} K</div>
              </div>
            )}
          </div>

          {(sel.body.atmosphere || sel.body.volcanism || sel.body.tidalLock) && (
            <div className="orr-detail-note">
              {[
                sel.body.atmosphere && sel.body.atmosphere !== 'None' ? sel.body.atmosphere : null,
                sel.body.volcanism || null,
                sel.body.tidalLock ? 'tidally locked' : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </div>
          )}

          {sel.body.landable && (
            <div className="orr-mats">
              <div className="orr-mats-head">
                Surface materials
                {sel.body.wasFootfalled === false && <span className="orr-first">first footfall</span>}
              </div>
              {sel.body.materials?.length ? (
                <div className="orr-mat-list">
                  {sel.body.materials.map((m) => {
                    const g = materialGrade(m.name);
                    const have = view.matCounts[m.name];
                    return (
                      <div key={m.name} className={`orr-mat g${g}`}>
                        <span className="orr-mat-name">{m.name}</span>
                        <span className="orr-mat-pct mono">{m.percent.toFixed(1)}%</span>
                        {/* What you already carry. A rich seam you have 300 of
                            is not a reason to land; one you have none of is. */}
                        <span className="orr-mat-have mono">
                          {have != null ? (have > 0 ? `have ${have}` : 'none held') : ''}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="orr-hint">Landable, but the scan listed no materials.</div>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="orr-hint">Tap a body for its orbit · scroll to zoom · drag to pan</div>
      )}
    </div>
  );
}
