/**
 * Route plotter — Spansh's neutron highway (ship) and fleet-carrier planner,
 * folded into one list of waypoints the HUD and the operator can both follow.
 *
 * Why this exists at all: the galaxy map plots a ship route but knows nothing
 * about neutron supercharging, and it will not plot a carrier route in any
 * form. A carrier jump is a single ≤500 ly hop typed in by hand, so Sol to
 * Colonia is forty-six separate system names the commander has to look up one
 * at a time — while working out, from nothing, whether they are carrying enough
 * tritium to actually arrive. That last part is what strands people.
 *
 * Spansh answers both questions and its two replies look nothing alike:
 *
 *   ship    POST /api/route              → result.system_jumps[]
 *                                          { system, distance_jumped,
 *                                            distance_left, jumps, neutron_star }
 *   carrier POST /api/fleetcarrier/route → result.jumps[]
 *                                          { name, distance, fuel_used,
 *                                            fuel_in_tank, restock_amount,
 *                                            has_icy_ring, is_system_pristine }
 *
 * Both are normalised to PlotWaypoint here so one card renders either.
 *
 * The tritium arithmetic, which is the whole point of the carrier side:
 * a carrier tops its 1000 t depot from its own cargo hold between jumps, so the
 * tank level never tells you whether the trip is possible. What matters is the
 * BURN — the sum of every jump's fuel — because that is the tonnage that has to
 * be sitting in the hold when you leave. Spansh reports the same figure as the
 * origin's `restock_amount`; we sum it ourselves as well so the card can say
 * where the number came from rather than quoting a field.
 *
 * Pure module: the network calls live in Rust (opt-in), tests in
 * tests/plotter.test.ts against captured real responses.
 */

export type PlotKind = 'ship' | 'carrier';

/** One stop on a plotted route — a neutron waypoint, or a carrier jump. */
export interface PlotWaypoint {
  system: string;
  /** Ly covered reaching this stop; 0 at the origin. */
  legLy: number;
  /** Ly still to run after it. */
  remainingLy: number;
  /** Ship: FSD jumps this leg costs. Carrier: 1 per hop, 0 at the origin. */
  jumps: number;
  /** Ship: supercharge the FSD here. */
  neutron: boolean;
  /** Carrier: tritium burned arriving here. */
  fuelUsed: number;
  /** Carrier: depot level on arrival. */
  fuelLeft: number;
  /** Carrier: tons Spansh says to take on here before jumping again. */
  restock: number;
  /** Carrier: icy rings in system — tritium can be mined at this stop. */
  icyRing: boolean;
  /** Carrier: those rings are pristine, i.e. worth the detour. */
  pristine: boolean;
}

/** The tritium bill for a carrier trip, and how far short the commander is. */
export interface TritiumPlan {
  /** Tons the whole route burns — the tonnage that must be in the hold. */
  burn: number;
  /** In the carrier's depot when the route was plotted (journal CarrierStats). */
  inTank: number;
  /** Tritium already sitting in the carrier's cargo hold. */
  inHold: number;
  /** Still to find, after the hold and the depot. 0 when the trip is covered. */
  shortfall: number;
  /** Ship-hold runs needed to fetch the shortfall; null with no known ship. */
  trips: number | null;
  /** Ship's cargo capacity used for `trips`, when known. */
  shipCargo: number | null;
  /** Mid-route stops where Spansh says to take on more fuel. */
  restocks: Array<{ system: string; tons: number; icyRing: boolean; pristine: boolean }>;
  /** Stops with icy rings — where the shortfall can be mined instead of bought. */
  miningStops: number;
  /** True when the load will not fit in the carrier's free space in one go. */
  overCapacity: boolean;
  /** Free tons aboard the carrier at plot time, or null when unknown. */
  freeSpace: number | null;
}

export interface PlottedRoute {
  kind: PlotKind;
  source: string;
  destination: string;
  totalLy: number;
  /** Ship: FSD jumps end to end. Carrier: carrier jumps. */
  totalJumps: number;
  waypoints: PlotWaypoint[];
  /** Carrier routes only. */
  tritium: TritiumPlan | null;
  fetchedAt: number;
}

/** What the carrier plotter needs to know that only the journal can tell it. */
export interface CarrierFuelInput {
  /** CarrierStats FuelLevel — the depot, max 1000 t. */
  inTank?: number;
  /** Tritium in the carrier's cargo hold; the journal never breaks this out. */
  inHold?: number;
  /** Ship cargo capacity, for "that is N runs from the mining site". */
  shipCargo?: number | null;
  /** Free tons aboard the carrier (TotalCapacity − used). */
  freeSpace?: number | null;
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const round1 = (n: number): number => Math.round(n * 10) / 10;

/** Ly with the precision a commander actually reads. */
export function fmtLy(ly: number): string {
  return ly >= 1000
    ? `${Math.round(ly).toLocaleString('en-US')} ly`
    : `${round1(ly).toLocaleString('en-US')} ly`;
}

function body(jsonText: string): Record<string, any> | null {
  try {
    const v = JSON.parse(jsonText);
    return v && typeof v === 'object' ? (v as Record<string, any>) : null;
  } catch {
    return null;
  }
}

/**
 * Parse the neutron plotter's reply (`POST /api/route`).
 *
 * Its waypoints are the neutron stars only — the ordinary jumps between them
 * are the `jumps` count, not rows — which is exactly what the commander pastes
 * into the galaxy map one at a time.
 */
export function parseShipPlot(jsonText: string, nowMs = Date.now()): PlottedRoute | null {
  const b = body(jsonText);
  const result = b?.result;
  const rows = Array.isArray(result?.system_jumps) ? result.system_jumps : [];
  if (!rows.length) return null;

  const waypoints: PlotWaypoint[] = rows.map((r: Record<string, unknown>) => ({
    system: str(r.system),
    legLy: round1(num(r.distance_jumped)),
    remainingLy: round1(num(r.distance_left)),
    jumps: num(r.jumps),
    neutron: r.neutron_star === true,
    fuelUsed: 0,
    fuelLeft: 0,
    restock: 0,
    icyRing: false,
    pristine: false,
  }));
  if (waypoints.some((w) => !w.system)) return null;

  return {
    kind: 'ship',
    source: str(result.source_system) || waypoints[0].system,
    destination: str(result.destination_system) || waypoints[waypoints.length - 1].system,
    totalLy: round1(num(result.distance) || waypoints[0].remainingLy),
    totalJumps: num(result.total_jumps) || waypoints.reduce((a, w) => a + w.jumps, 0),
    waypoints,
    tritium: null,
    fetchedAt: nowMs,
  };
}

/**
 * The tritium bill for a set of carrier waypoints.
 *
 * Kept separate from parsing because the commander's own figure — what is
 * already in the hold — arrives after the route does, typed into the card.
 * Re-pricing has to be arithmetic on waypoints we already have rather than
 * another minute of Spansh.
 */
function tritiumPlan(waypoints: readonly PlotWaypoint[], fuel: CarrierFuelInput): TritiumPlan {
  const burn = waypoints.reduce((a, w) => a + w.fuelUsed, 0);
  const inTank = Math.max(0, Math.round(fuel.inTank ?? 0));
  const inHold = Math.max(0, Math.round(fuel.inHold ?? 0));
  const shortfall = Math.max(0, burn - inTank - inHold);
  const shipCargo = fuel.shipCargo && fuel.shipCargo > 0 ? Math.floor(fuel.shipCargo) : null;
  const freeSpace = fuel.freeSpace != null && fuel.freeSpace >= 0 ? Math.floor(fuel.freeSpace) : null;
  return {
    burn,
    inTank,
    inHold,
    shortfall,
    trips: shipCargo ? Math.ceil(shortfall / shipCargo) : null,
    shipCargo,
    restocks: waypoints
      .slice(1)
      .filter((w) => w.restock > 0)
      .map((w) => ({ system: w.system, tons: w.restock, icyRing: w.icyRing, pristine: w.pristine })),
    miningStops: waypoints.filter((w) => w.icyRing).length,
    // The hold has to physically fit the load. A carrier with 3000 t free
    // cannot leave with 3739 t of tritium aboard however much is on the pad.
    overCapacity: freeSpace != null && burn - inHold > freeSpace,
    freeSpace,
  };
}

/** Re-cost a carrier route in place when the fuel figures change. */
export function reprice(route: PlottedRoute, fuel: CarrierFuelInput): PlottedRoute {
  if (route.kind !== 'carrier') return route;
  return { ...route, tritium: tritiumPlan(route.waypoints, fuel) };
}

/**
 * Parse the fleet-carrier planner's reply (`POST /api/fleetcarrier/route`) and
 * work out the tritium.
 *
 * The origin row is a departure instruction rather than a jump: `fuel_used` 0,
 * and a `restock_amount` that is the whole trip's fuel. It is kept as a
 * waypoint (the commander is standing there) but excluded from the mid-route
 * restock list, which is for the genuinely surprising stops — the ones on a
 * route too long to carry the fuel for in one load.
 */
export function parseCarrierPlot(
  jsonText: string,
  fuel: CarrierFuelInput = {},
  nowMs = Date.now(),
): PlottedRoute | null {
  const b = body(jsonText);
  const result = b?.result;
  const rows = Array.isArray(result?.jumps) ? result.jumps : [];
  if (rows.length < 2) return null; // origin + at least one hop, or it is not a route

  const waypoints: PlotWaypoint[] = rows.map((r: Record<string, unknown>, i: number) => ({
    system: str(r.name),
    legLy: round1(num(r.distance)),
    remainingLy: round1(num(r.distance_to_destination)),
    jumps: i === 0 ? 0 : 1,
    neutron: false,
    fuelUsed: num(r.fuel_used),
    fuelLeft: num(r.fuel_in_tank),
    restock: num(r.restock_amount),
    icyRing: r.has_icy_ring === true,
    pristine: r.is_system_pristine === true,
  }));
  if (waypoints.some((w) => !w.system)) return null;

  const tritium = tritiumPlan(waypoints, fuel);
  const dests = Array.isArray(result.destinations) ? result.destinations : [];
  return {
    kind: 'carrier',
    source: str(result.source) || waypoints[0].system,
    destination: str(dests[dests.length - 1]) || waypoints[waypoints.length - 1].system,
    totalLy: round1(waypoints[0].remainingLy || waypoints.reduce((a, w) => a + w.legLy, 0)),
    totalJumps: waypoints.length - 1,
    waypoints,
    tritium,
    fetchedAt: nowMs,
  };
}

/**
 * Which waypoint the commander is standing on, or null when they are between
 * stops (a ship route's intermediate jumps) or have wandered off it entirely.
 *
 * Searched from the END for the same reason the nav-route counter is: a long
 * route can pass through one system twice, and the commander is at the later of
 * the two. Null means "keep the last-good index" — a plotter that resets to
 * zero every time it loses the ship is worse than one that says nothing.
 */
export function plotProgress(route: PlottedRoute, currentSystem: string): number | null {
  const here = currentSystem.trim().toLowerCase();
  if (!here || here === 'unknown') return null;
  for (let i = route.waypoints.length - 1; i >= 0; i--) {
    if (route.waypoints[i].system.trim().toLowerCase() === here) return i;
  }
  return null;
}

/** The stop to steer for, or null when the route is finished. */
export function nextWaypoint(route: PlottedRoute, idx: number): PlotWaypoint | null {
  return route.waypoints[idx + 1] ?? null;
}

/** Jumps and light-years still ahead, from the waypoint we are standing on. */
export function remaining(route: PlottedRoute, idx: number): { jumps: number; ly: number } {
  const ahead = route.waypoints.slice(Math.max(0, idx) + 1);
  return {
    jumps: ahead.reduce((a, w) => a + w.jumps, 0),
    ly: round1(ahead.reduce((a, w) => a + w.legLy, 0)),
  };
}

/** One spoken line for the feed when a route comes back. */
export function plotSummary(route: PlottedRoute): string {
  const what = route.kind === 'carrier' ? 'Carrier route' : 'Neutron route';
  const legs =
    route.kind === 'carrier'
      ? `${route.totalJumps} carrier jump${route.totalJumps === 1 ? '' : 's'}`
      : `${route.totalJumps} jump${route.totalJumps === 1 ? '' : 's'} over ${route.waypoints.length - 1} supercharge${route.waypoints.length === 2 ? '' : 's'}`;
  const first = route.waypoints[1];
  const head = `${what} to ${route.destination}: ${legs}, ${fmtLy(route.totalLy)}.`;
  const fuel = route.tritium
    ? ` It burns ${route.tritium.burn.toLocaleString('en-US')} tons of tritium${
        route.tritium.shortfall > 0
          ? ` — you are ${route.tritium.shortfall.toLocaleString('en-US')} short`
          : ' and you have enough'
      }.`
    : '';
  return first ? `${head} First stop ${first.system}.${fuel}` : `${head}${fuel}`;
}

/**
 * The plotted route as one line of operator context.
 *
 * Deliberately states the tritium shortfall in the same breath as the
 * destination: an operator that knows where the carrier is going but not that
 * it cannot get there is the one that cheerfully suggests selling the tritium.
 */
export function plotContextLine(route: PlottedRoute, idx: number): string {
  const left = remaining(route, idx);
  const next = nextWaypoint(route, idx);
  const kind = route.kind === 'carrier' ? 'Fleet-carrier route' : 'Neutron-highway route';
  const parts = [
    `${kind} plotted to ${route.destination}: ${left.jumps} jump(s) and ${fmtLy(left.ly)} still ahead`,
  ];
  if (next) parts.push(`next waypoint ${next.system}${next.neutron ? ' (neutron — supercharge)' : ''}`);
  else parts.push('the commander is at the final waypoint');
  const t = route.tritium;
  if (t) {
    parts.push(
      t.shortfall > 0
        ? `the trip burns ${t.burn} t of tritium and they are ${t.shortfall} t short (${t.inTank} t in the depot, ${t.inHold} t in the hold)`
        : `the trip burns ${t.burn} t of tritium, which they already have`,
    );
    if (t.overCapacity) parts.push('the carrier cannot hold the whole load in one go — it must restock en route');
  }
  return `${parts.join('; ')}.`;
}
