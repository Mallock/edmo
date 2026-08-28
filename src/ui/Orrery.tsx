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
  legProgress,
  lightSource,
  materialGrade,
  placeBelts,
  placeLabels,
  placeSystem,
  separateDiscs,
  surfaceOf,
  type OrreryBody,
  type OrrerySystem,
  type ShipLeg,
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
// 34x: deep enough that a moon family 60 display-ls wide fills the panel.
// The proportional scale made depth worth having — at the old 14x cap a
// tight family had barely opened past its discs.
const MAX_ZOOM = 34;
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

/**
 * A dock name at map size. The game's construction-site names are sentences —
 * "Planetary Construction Site: Stein's Garrison" — and the interesting half
 * is the second one.
 */
const shortPortName = (name: string): string => {
  const s = name.replace(/^(Planetary|Orbital) Construction Site: /, '').trim();
  return s.length > 22 ? `${s.slice(0, 21)}…` : s;
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
  /**
   * The supercruise leg under way, or null when parked.
   *
   * Drawn as an interval rather than a dot: the game reports no in-system
   * position, so where the ship is between two bodies is genuinely unknown.
   */
  ship: (ShipLeg & { destName?: string; fromPortId?: number; toPortId?: number }) | null;
  /**
   * The exact dock the ship is at, when it is at one — so the marker can ring
   * the station itself, not just the world it orbits.
   */
  herePortId: number | null;
  /**
   * In supercruise toward somewhere the map cannot place (an unvisited
   * station, an unscanned body): the destination's name, for the note. The
   * alternative was silence, and silence reads as a broken feature.
   */
  shipUnresolved: string | null;
}

export function OrreryCard({ view, nowMs }: { view: OrreryView; nowMs: number }) {
  const [warp, setWarp] = useState<number>(1);
  const [trueScale, setTrueScale] = useState(false);
  const [picked, setPicked] = useState<number | null>(null);
  /**
   * Keep the camera on the ship.
   *
   * Zoomed in on your own leg, every tick of the estimate slides the marker
   * toward the edge and off it — the one thing being watched is the one thing
   * that leaves the frame. Follow recentres after every movement instead.
   * Grabbing the map disengages it, because a drag IS the statement "I want
   * to look somewhere else".
   *
   * Starts ENGAGED: the tab opens on the commander, a little zoomed in —
   * undocking auto-switches to this map, and the first thing it should show
   * is where you are, not a survey you then have to dive into. One drag or
   * double-click and the survey is back.
   */
  const [follow, setFollow] = useState(true);
  /** One zoom-in per engagement, not a lock — wheeling back out must stick. */
  const engageZoomed = useRef(false);
  /**
   * The camera flies the leg with you. While following in supercruise the
   * zoom is DYNAMIC: chosen so the destination sits a fixed distance from
   * your centred ship — wide at departure, when the destination is far and
   * the frame therefore holds most of the system, tightening continuously
   * as you close. Touching the wheel pauses it (manual intent wins); a new
   * leg re-arms it.
   */
  const autoZoom = useRef(true);
  const legRef = useRef<string | null>(null);
  /** The last clock tick the camera stepped on — one eased step per tick. */
  const stepRef = useRef(0);
  /**
   * Where the ship last stood. Arriving somewhere NEW re-runs the parked
   * engagement: without this, ApproachBody ends the leg mid-approach and
   * the one-shot engage flag — spent at session start — left the camera
   * frozen at whatever zoom the cruise had reached, never framing the
   * place actually arrived at.
   */
  const parkedAtRef = useRef<string | null>(null);
  /**
   * A faster clock, but only in supercruise. The app's shared clock ticks
   * once a second, which made the whole follow experience step to it: the
   * marker jumped a second's worth of progress and the camera snapped the
   * full correction after it, once per second — janky. At 10 Hz the marker's
   * motion is sub-pixel per step and the camera's eased corrections are
   * small, which reads as gliding. Parked, nothing moves, so the fast clock
   * stops and the tab costs what a static picture costs.
   */
  const [liveMs, setLiveMs] = useState(() => Date.now());
  const cruising = view.ship != null || view.shipUnresolved != null;
  useEffect(() => {
    if (!cruising) return;
    const id = window.setInterval(() => setLiveMs(Date.now()), 100);
    return () => window.clearInterval(id);
  }, [cruising]);
  useEffect(() => {
    if (!cruising) setLiveMs(nowMs);
  }, [cruising, nowMs]);
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
    // The camera was just reset, so the follow engagement starts over too —
    // if follow is on, the effect below re-steps the zoom onto the ship in
    // the NEW system. Declared before that effect on purpose: this also makes
    // StrictMode's double-run converge on the stepped zoom instead of letting
    // the second reset clobber it while a stale flag blocks the re-step.
    engageZoomed.current = false;
    autoZoom.current = true;
    legRef.current = null;
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
      // A manual wheel is the commander taking the zoom back — the dynamic
      // flight zoom stands down until a new leg (or a recenter tap) re-arms.
      autoZoom.current = false;
      // Following, the ship is pinned to the viewport centre — so the zoom
      // anchors there too. Anchoring at the pointer would scale the ship away
      // from centre only for the follow loop to yank it back, one jerk per
      // wheel tick; anchoring where the ship already is makes zoom and follow
      // agree instead of fight.
      const { x, y } = follow ? { x: CX, y: CY } : toView(e.clientX, e.clientY);
      setCam((c) => {
        const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, c.zoom * Math.exp(-e.deltaY * 0.0015)));
        const f = next / c.zoom;
        // Keep whatever is under the anchor under the anchor: solve for the
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
  }, [toView, follow]);

  const resetView = () => {
    // Double-click means "frame the whole system", which following would
    // immediately undo by re-centring on the ship.
    setFollow(false);
    setCam({ zoom: 1, x: 0, y: 0 });
  };

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
    () => ({ ...DEFAULT_SCALE, mode: trueScale ? 'true' : 'hybrid' }),
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
    // Discs may not swallow spacing — but the fit must not eat the SIZE
    // RATIO the scan measured. Clamping each disc against its own gap pinned
    // every tight family at planet:moon ≈ 1.8 no matter what the data said —
    // a 77,000 km giant drew twice its 700 km moon. So a planet's family
    // (itself and its satellites) now shrinks UNIFORMLY: one factor, chosen
    // so the moon stays within 0.30 of its gap and the planet within 0.55,
    // scales every member — the ratio survives, the spacing holds, and zoom
    // releases the factor back toward the true power-law sizes. Floors keep
    // a shrunken family legible (planet ≥ 4 px, moon ≥ 2) — at survey zoom
    // the hierarchy compresses to dots, but never inverts.
    // The star's own family spans the whole map, so one cramped inner planet
    // must not shrink every other; star-children keep independent caps.
    const byId = new Map(discs.map((d) => [d.p.body.id, d]));
    const famF = new Map<number, number>();
    const starCap = new Map<number, number>();
    const nearestStarChild = new Map<number, number>();
    for (const d of discs) {
      const pid = d.p.body.parentId;
      if (pid === null) continue;
      const par = byId.get(pid);
      if (!par) continue;
      const dist = Math.hypot(d.x - par.x, d.y - par.y);
      if (dist <= 0) continue;
      if (par.p.body.parentId === null) {
        starCap.set(d.p.body.id, Math.max(2, dist * 0.3));
        nearestStarChild.set(pid, Math.min(nearestStarChild.get(pid) ?? Infinity, dist));
      } else {
        const f = Math.min(1, (0.3 * dist) / d.r, (0.55 * dist) / par.r);
        famF.set(pid, Math.min(famF.get(pid) ?? 1, f));
      }
    }
    for (const d of discs) {
      const id = d.p.body.id;
      const asParent = famF.get(id);
      const asChild = d.p.body.parentId !== null ? famF.get(d.p.body.parentId) : undefined;
      const f = Math.min(asParent ?? 1, asChild ?? 1);
      if (f < 1) d.r = Math.max(asParent !== undefined ? 4 : 2, d.r * f);
      const cap = starCap.get(id);
      if (cap !== undefined) d.r = Math.min(d.r, Math.max(asParent !== undefined ? 4 : 2, cap));
      const near = nearestStarChild.get(id);
      if (near !== undefined) d.r = Math.min(d.r, Math.max(5, near * 0.55));
    }
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
   * The leg being flown, as a band of possible progress along it.
   *
   * `nowMs` is in the dependencies on purpose: this is the one thing on the
   * map that must advance with the wall clock even at 1× and even while the
   * bodies barely move.
   */
  const flight = useMemo(() => {
    const leg = view.ship;
    if (!leg || !sys) return null;
    const pointFromPort = (id: number) => {
      const port = sys.ports.get(id);
      if (!port || port.parentId == null) return null;
      const host = drawn.find((d) => d.p.body.id === port.parentId);
      if (!host) return null;
      const siblings = [...sys.ports.values()]
        .filter((p) => p.parentId === port.parentId)
        .sort((a, b) => a.id - b.id);
      const n = siblings.findIndex((p) => p.id === id);
      if (n < 0) return null;
      const ang = (-45 + n * 72) * (Math.PI / 180);
      const off = host.r + 4.5;
      return {
        x: host.x + Math.cos(ang) * off,
        y: host.y + Math.sin(ang) * off,
        body: host.p.body,
      };
    };
    /**
     * A leg endpoint as something with a position.
     *
     * Belt clusters are drawn as bands, not points, so they are not in
     * `drawn` — and a commander drops at belt clusters constantly, to mine.
     * A belt is a ring around its parent, so the parent's position is the
     * honest stand-in: "left the belt around 2 b" starts at 2 b.
     */
    const endpoint = (id: number, portId?: number) => {
      if (portId != null) {
        const port = pointFromPort(portId);
        if (port) return port;
      }
      const direct = drawn.find((d) => d.p.body.id === id);
      if (direct) return { x: direct.x, y: direct.y, body: direct.p.body };
      const parentId = sys.bodies.get(id)?.parentId;
      const parent = parentId != null ? drawn.find((d) => d.p.body.id === parentId) : undefined;
      return parent ? { x: parent.x, y: parent.y, body: parent.p.body } : null;
    };
    const a = endpoint(leg.fromId, leg.fromPortId);
    const b = endpoint(leg.toId, leg.toPortId);
    if (!a || !b) return null;
    if (a.body.id === b.body.id && Math.hypot(a.x - b.x, a.y - b.y) < 0.5) return null;
    const sepLs = Math.hypot(
      (a.body.distanceLs ?? 0) - (b.body.distanceLs ?? 0),
      0,
    );
    const prog = legProgress(leg, liveMs, sepLs);
    const at = (f: number) => ({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
    return { a, b, prog, lo: at(prog.lo), hi: at(prog.hi), mid: at(prog.mid), to: b.body };
  }, [view.ship, drawn, liveMs, sys]);

  /**
   * Docks, placed beside the body they belong to.
   *
   * A port has no orbit of its own — the journal gives it a distance from the
   * star and, for surface ports, a world and a latitude, but never a position.
   * So each one is pinned to its body and fanned out around it by index, which
   * says "these docks are here" without inventing where in the orbit they sit.
   */
  const ports = useMemo(() => {
    if (!sys) return [];
    const byParent = new Map<number, number>();
    const out: Array<{ id: number; name: string; x: number; y: number; surface: boolean }> = [];
    // Sorted by id, so a port keeps its berth around the body between renders
    // and sessions — discovery order would reshuffle the fan every time a new
    // dock was learned.
    for (const port of [...sys.ports.values()].sort((a, b) => a.id - b.id)) {
      if (port.parentId == null) continue;
      const host = drawn.find((d) => d.p.body.id === port.parentId);
      if (!host) continue;
      const n = byParent.get(port.parentId) ?? 0;
      byParent.set(port.parentId, n + 1);
      // Fan around the host, starting up-right, so several docks on one world
      // stay countable instead of stacking.
      const ang = (-45 + n * 72) * (Math.PI / 180);
      const off = host.r + 4.5;
      out.push({
        id: port.id,
        name: port.name,
        x: host.x + Math.cos(ang) * off,
        y: host.y + Math.sin(ang) * off,
        surface: port.latitude != null,
      });
    }
    return out;
  }, [sys, drawn]);

  /**
   * The ship at rest: docked, dropped, or orbiting somewhere known.
   *
   * The leg band only exists in supercruise, which left the ship invisible for
   * most of a session — parked at a station is where a commander actually IS
   * most of the time, and "where am I on this map" deserves an answer then
   * too. Anchored to the exact dock when at one, else to the body.
   */
  /**
   * The zoom that frames a body's FAMILY — its planet's satellites, or its
   * own — which is the view a commander means by "where I am": the ringed
   * planet, its moons, the docks. Used as the parked view, the departure
   * view, and (via the 24x cap it usually hits in a big system) the arrival
   * view. Extent is measured from the placed family head, so it is the
   * satellite budget as actually drawn, not a guess.
   */
  const famGeom = useMemo(() => {
    const headOf = new Map<number, number>();
    const extent = new Map<number, number>();
    if (!sys) return { headOf, extent };
    const headFor = (id: number): number => {
      let cur = sys.bodies.get(id);
      if (!cur) return id;
      while (cur.parentId !== null) {
        const par = sys.bodies.get(cur.parentId);
        if (!par) break;
        if (par.parentId === null) return cur.id;
        cur = par;
      }
      return cur.id;
    };
    const pos = new Map(placed.map((q) => [q.body.id, q]));
    for (const q of placed) {
      const h = headFor(q.body.id);
      headOf.set(q.body.id, h);
      const hp = pos.get(h);
      if (!hp) continue;
      const d = Math.hypot(q.x - hp.x, q.y - hp.y);
      extent.set(h, Math.max(extent.get(h) ?? 0, d));
    }
    return { headOf, extent };
  }, [sys, placed]);

  const localZoom = (bodyId: number | null | undefined): number => {
    if (bodyId == null) return 3;
    const h = famGeom.headOf.get(bodyId);
    if (h == null) return 3;
    const e = famGeom.extent.get(h) ?? 0;
    if (e <= 0 || !fit.k) return 12; // a lone body: just get close
    return Math.min(24, Math.max(3, 85 / (e * fit.k)));
  };

  const parked = useMemo(() => {
    if (view.ship) return null; // in flight, the band is the marker
    if (view.herePortId != null) {
      const port = ports.find((p) => p.id === view.herePortId);
      if (port) return { x: port.x, y: port.y, name: shortPortName(port.name) };
    }
    if (view.hereBodyId != null) {
      const host = drawn.find((d) => d.p.body.id === view.hereBodyId);
      if (host) return { x: host.x + host.r + 2, y: host.y - host.r - 2, name: host.p.body.label };
    }
    return null;
  }, [view.ship, view.herePortId, view.hereBodyId, ports, drawn]);

  /**
   * The follow loop: nudge the camera until the ship sits at the centre.
   *
   * Everything here is linear, so one nudge lands exactly and the effect's
   * next run measures a delta of zero — the epsilon guard is what parks the
   * loop rather than letting a recentred frame re-trigger itself for ever.
   * Runs off the same recomputes that move the marker: the estimate ticking
   * forward, a zoom changing the projection, an arrival turning the band into
   * a chevron. Whatever moved it, the next frame re-centres it.
   */
  useEffect(() => {
    if (!follow) {
      engageZoomed.current = false;
      return;
    }
    // Leaving the system: in supercruise toward a target this map cannot
    // place — a hyperspace target, an unvisited station — there is nothing
    // to fly the camera toward, so it eases back out to the whole-system
    // frame: the departure seen from above, instead of a stale close-up of
    // wherever the ship just was.
    if ((view.ship || view.shipUnresolved) && !flight && !parked) {
      if (!autoZoom.current) return;
      // One eased step per clock tick — the gate keeps React's own
      // re-render cascade from rushing the animation to its target.
      if (stepRef.current === liveMs) return;
      stepRef.current = liveMs;
      // Converge on a wide-but-legible 2.5x frame — easing DOWN from the
      // approach zoom the retarget interrupted, or UP from the survey view a
      // fresh mount starts at. Not 1x: the departure should still read as a
      // place, not a dot field.
      setCam((c) => {
        const ratio = 2.5 / c.zoom;
        if (Math.abs(ratio - 1) < 0.03 && Math.abs(c.x) < 1 && Math.abs(c.y) < 1) return c;
        return { zoom: c.zoom * Math.pow(ratio, 0.05), x: c.x * 0.985, y: c.y * 0.985 };
      });
      return;
    }
    const anchor = flight ? flight.mid : parked;
    if (!anchor) return;
    if (flight) {
      // A new leg re-arms the dynamic zoom a manual wheel may have paused.
      const legKey = `${flight.a.body.id}>${flight.to.id}`;
      if (legRef.current !== legKey) {
        legRef.current = legKey;
        autoZoom.current = true;
      }
      // Paced by the 10 Hz flight clock: each tick takes ONE small eased
      // step of zoom and pan together, and the gate below keeps React's own
      // re-render cascade from rushing it. On that clock the marker's
      // motion is sub-pixel per tick, so the whole follow reads as gliding
      // — the old shape snapped the full correction once a second, after
      // the marker had jumped a second's worth of progress, and looked
      // exactly as janky as that sounds.
      if (stepRef.current === liveMs) return;
      stepRef.current = liveMs;
      if (autoZoom.current) {
        const dp = Math.hypot(flight.b.x - anchor.x, flight.b.y - anchor.y);
        // Departure holds the LOCAL view — the family you are pulling away
        // from — fading over the first 30 SECONDS, wall clock. Tying the
        // fade to estimated progress held the close-up for minutes on a
        // long leg; half a minute is how long a departure feels like one,
        // and then the full leg deserves the frame. The cruise law — the
        // remaining leg held at ~120 px, so the space around it stays in
        // frame — takes over when it is tighter; arrival is the cruise law
        // rising into its 24x cap.
        const departFloor =
          flight.prog.elapsedS < 30
            ? localZoom(flight.a.body.id) * (1 - flight.prog.elapsedS / 30)
            : 0;
        const zLaw = dp > 1e-6 ? Math.max(1, (zoom * 120) / dp) : 24;
        const want = Math.min(24, Math.max(zLaw, departFloor, 1));
        // The centre leads toward the landing only as far as the zoom lets
        // the destination matter: while the departure floor holds the local
        // view, the ship keeps the frame; in cruise the destination owns it.
        const w = 0.6 * Math.min(1, zLaw / Math.max(zoom, 1e-6));
        const wx = anchor.x + (flight.b.x - anchor.x) * w;
        const wy = anchor.y + (flight.b.y - anchor.y) * w;
        const dx = CX - wx;
        const dy = CY - wy;
        if (Math.abs(want / zoom - 1) < 0.01 && Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
        setCam((c) => ({
          zoom: c.zoom * Math.pow(want / c.zoom, 0.05),
          x: c.x + dx * 0.18,
          y: c.y + dy * 0.18,
        }));
        return;
      }
      // Manual zoom, still following: eased ship-centred pan.
      const dx = CX - anchor.x;
      const dy = CY - anchor.y;
      if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
      setCam((c) => ({ ...c, x: c.x + dx * 0.25, y: c.y + dy * 0.25 }));
      return;
    } else {
      // A new berth — a fresh arrival, not a camera the commander parked
      // somewhere — re-arms the engagement below.
      if (parkedAtRef.current !== parked!.name) {
        parkedAtRef.current = parked!.name;
        engageZoomed.current = false;
      }
    }
    if (!flight && !engageZoomed.current) {
      // Parked: open on the LOCAL view — the family around the dock, framed
      // like the arrival that put you there. Once per engagement — wheeling
      // away afterwards must stick.
      engageZoomed.current = true;
      const want = localZoom(view.hereBodyId);
      let stepped = false;
      setCam((c) => {
        if (Math.abs(want / c.zoom - 1) < 0.05) return c;
        stepped = true;
        return { ...c, zoom: want };
      });
      // The zoom changes the projection under the anchor; let the effect run
      // again against the recomputed positions rather than panning to a
      // point that no longer exists.
      if (stepped) return;
    }
    const dx = CX - anchor.x;
    const dy = CY - anchor.y;
    if (Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5) return;
    setCam((c) => ({ ...c, x: c.x + dx, y: c.y + dy }));
    // liveMs drives the easing when nothing else changes: in the away state
    // every other dependency is stable, and a convergence that only moves
    // when its inputs change would take exactly one step and stall.
  }, [follow, flight, parked, view.ship, view.shipUnresolved, liveMs]);

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
    // Dock names, once zoomed in enough that there is room to write them.
    // Lowest priority — a station never costs a planet its name — and keyed
    // negatively so they cannot collide with a body id.
    if (zoom >= 3) {
      for (const port of ports) {
        wishes.push({
          key: -port.id,
          text: shortPortName(port.name),
          x: port.x,
          y: port.y,
          r: 2.5,
          width: shortPortName(port.name).length * 4.9,
          priority: 6,
        });
      }
    }
    return placeLabels(wishes, { bodies: drawn });
  }, [drawn, view.hereBodyId, picked, ports, zoom]);

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
              // A deliberate drag is the commander taking the camera back.
              setFollow(false);
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
          {/*
            The leg under way. The thin line is the route, which is certain.
            The thick segment is where the ship might be, which is not: the
            game reports no in-system position, so this is an interval derived
            from elapsed time against the slowest and fastest legs this
            commander has actually flown. It slides and narrows as it goes.
          */}
          {flight && (
            <g className="orr-flight" pointerEvents="none">
              <line
                x1={flight.a.x}
                y1={flight.a.y}
                x2={flight.b.x}
                y2={flight.b.y}
                stroke="var(--cyan)"
                strokeWidth="0.8"
                strokeDasharray="3 3"
                opacity="0.55"
              />
              <line
                x1={flight.lo.x}
                y1={flight.lo.y}
                x2={flight.hi.x}
                y2={flight.hi.y}
                stroke="var(--cyan)"
                strokeWidth="3"
                opacity="0.3"
                strokeLinecap="round"
              />
              {/* Hollow, because a filled dot would read as a fix. */}
              <circle
                cx={flight.mid.x}
                cy={flight.mid.y}
                r="3.4"
                fill="none"
                stroke="var(--cyan)"
                strokeWidth="1.3"
              />
              <circle cx={flight.mid.x} cy={flight.mid.y} r="1" fill="var(--cyan)" />
              <text
                x={flight.mid.x + 6}
                y={flight.mid.y + 3}
                className="orr-label"
                fill="var(--cyan)"
              >
                ~you
              </text>
            </g>
          )}
          {/* Docks: a hollow square for an orbital, a filled one for a surface
              port. Small, because they annotate a body rather than compete
              with it. */}
          {ports.map((p) => (
            <rect
              key={`port-${p.id}`}
              x={p.x - 1.8}
              y={p.y - 1.8}
              width={3.6}
              height={3.6}
              fill={p.surface ? 'var(--amber)' : 'none'}
              stroke="var(--amber)"
              strokeWidth="0.9"
              opacity="0.9"
            >
              <title>{p.name}</title>
            </rect>
          ))}
          {/* The ship at rest: a filled chevron, because here it IS a fix —
              the journal stated this arrival outright. Only the in-flight
              marker is hollow, being an estimate. */}
          {parked && (
            <g className="orr-flight" pointerEvents="none">
              <path
                d={`M ${parked.x} ${parked.y - 3.6} L ${parked.x + 2.8} ${parked.y + 2.6} L ${parked.x} ${parked.y + 1.1} L ${parked.x - 2.8} ${parked.y + 2.6} Z`}
                fill="var(--cyan)"
                stroke="rgba(0,0,0,0.6)"
                strokeWidth="0.5"
              />
              <text x={parked.x + 5} y={parked.y + 3} className="orr-label" fill="var(--cyan)">
                you
              </text>
            </g>
          )}
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
              fill={l.key < 0 ? 'var(--amber)' : (colourFor.get(l.key) ?? 'var(--text)')}
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
        {/*
          The chip names the action, not the mode. Off, it reads "recenter"
          because that is what the tap does — snap the camera back to the ship
          and stay with it; a commander who has dragged away and zoomed around
          is looking for exactly that word. On, it reads "following" so it is
          plain what a second tap turns off.
        */}
        <button
          className={follow && (flight || parked) ? 'orr-chip active' : 'orr-chip'}
          aria-pressed={follow && !!(flight || parked)}
          disabled={!flight && !parked}
          title={
            !flight && !parked
              ? 'No ship on this map to follow'
              : follow
                ? 'Following your ship — zoom freely; dragging the map lets go'
                : 'Snap the camera back to your ship and keep following it'
          }
          onClick={() => {
            // Re-engaging is a recenter: the dynamic flight zoom re-arms too.
            if (!follow) autoZoom.current = true;
            setFollow(!follow);
          }}
        >
          {follow && (flight || parked) ? '▲ following' : '▲ recenter'}
        </button>
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
              ? 'Every distance exact — a hugging moon disappears into its planet, because that is where it is'
              : 'Planet distances to scale — a 2,000 ls leg is half a 4,000 ls one. Moons spread to stay visible.'
          }
          onClick={() => setTrueScale(!trueScale)}
        >
          {trueScale ? 'exact' : 'to scale'}
        </button>
      </div>

      {/* Say which one it is, always. A map that silently lies about scale is
          worse than one that does not draw. */}
      <div className="orr-note">
        {trueScale
          ? 'Every distance exact · body sizes exaggerated · nothing nudged'
          : 'Planet distances to scale · moons spread to be seen · order kept'}
        {warp !== 1 && ' · warped'}
      </div>

      {/* Say plainly that the ship marker is a guess, and how wide a guess.
          The game gives no in-system position; the worst thing this map could
          do is imply otherwise. */}
      {flight && (
        <div className="orr-flight-note">
          <b>~</b> In supercruise to <b>{view.ship?.destName ?? flight.to.label}</b> ·{' '}
          {Math.round(flight.prog.elapsedS)} s
          out · somewhere in the {Math.round(flight.prog.lo * 100)}–
          {Math.round(flight.prog.hi * 100)}% of the way — estimated, the game does not report
          position
        </div>
      )}
      {/* Flying somewhere the map cannot place. Without this line the feature
          simply looks broken — the commander is in supercruise and nothing on
          the card says the app noticed. */}
      {!flight && view.shipUnresolved && (
        <div className="orr-flight-note">
          <b>~</b> In supercruise to <b>{view.shipUnresolved}</b> — not on this map yet; it will
          be once you arrive
        </div>
      )}
      {parked && (
        <div className="orr-flight-note">
          <b>▲</b> You are at <b>{parked.name}</b>
        </div>
      )}

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

          {/* The docks on or around this body — the map shows them as marks;
              the card is where their full names fit. */}
          {sys.ports.size > 0 &&
            (() => {
              const here = [...sys.ports.values()]
                .filter((p) => p.parentId === sel.body.id)
                .sort((a, b) => a.id - b.id);
              if (!here.length) return null;
              return (
                <div className="orr-detail-note">
                  {here
                    .map((p) => `${p.latitude != null || p.id >= 1_000_000 ? '■' : '□'} ${p.name}`)
                    .join(' · ')}
                </div>
              );
            })()}
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
