/**
 * The Booze Cruise — the run to Rackham's Peak, computed.
 *
 * Once a year (or thereabouts) the peak at HIP 58832 declares a public
 * holiday and pays roughly eight times its usual rate for wine, and the
 * community hauls it 5,000 ly above the plane in fleet carriers. The event is
 * a hauling loop with a hold and a clock, which is the same shape as the
 * construction architect — so this module does what that one does: folds the
 * arithmetic here, in code, from things the journal actually said.
 *
 * TWO HONEST LIMITS, both deliberate.
 *
 * The holiday is detected from the PRICE, never from a date. Wine sells at
 * the peak for about 33,000 cr/t normally and north of 270,000 during the
 * holiday, a gap no ambiguity survives — and a price the commander's own
 * market read supplies. A hardcoded season would be wrong the first time
 * Frontier moved it.
 *
 * And nothing here forecasts the trigger. The community's own guide says
 * plainly that the cruise "is a bet"; the BGS does publish a state as PENDING
 * before it lands, which is a real warning, but an unpending holiday has no
 * honest ETA. A tab that invented one would send somebody 5,000 ly on a
 * number this app made up.
 */

/** Where the party is. */
export const BOOZE_SYSTEM = 'HIP 58832';
export const BOOZE_PORT = "Rackham's Peak";
/** The commodity, as the journal localises it. */
export const WINE = 'Wine';

/** The peak's ordinary rate, and the holiday rate, in credits per ton. */
export const QUIET_PRICE = 33_000;
export const HOLIDAY_PRICE = 270_000;
/**
 * Anything above this is the holiday. Sits in the middle of a gap so wide
 * that no market fluctuation can cross it by accident.
 */
export const HOLIDAY_THRESHOLD = 100_000;

/** Rackham's Peak has M and S pads only — a big hauler cannot land at all. */
export const PEAK_MAX_PAD = 'M' as const;

export type PeakState = 'holiday' | 'quiet' | 'unknown';

/**
 * Is the party on? From the price, and only from the price.
 *
 * `null` means nobody has read that market yet, which is honestly different
 * from "the holiday is off" and must stay different all the way to the panel.
 */
export function peakStateFromPrice(sellPerT: number | null | undefined): PeakState {
  if (sellPerT == null || sellPerT <= 0) return 'unknown';
  return sellPerT >= HOLIDAY_THRESHOLD ? 'holiday' : 'quiet';
}

export interface RunEconomics {
  /** What one full hold earns, before the cost of the wine. */
  grossPerRun: number;
  /** …and after it, when a purchase price is known. */
  netPerRun: number | null;
  sellPerT: number;
  buyPerT: number | null;
  capacityT: number;
}

/**
 * What one run is worth with THIS ship at THESE prices.
 *
 * Both prices come from markets the commander actually opened, so the figure
 * is theirs rather than a guide's — a carrier charging over the odds for wine
 * shows up here as a smaller number, which is the entire point.
 */
export function runEconomics(
  capacityT: number,
  sellPerT: number,
  buyPerT: number | null,
): RunEconomics {
  const cap = Math.max(0, Math.floor(capacityT));
  const gross = cap * Math.max(0, sellPerT);
  return {
    grossPerRun: gross,
    netPerRun: buyPerT == null ? null : gross - cap * Math.max(0, buyPerT),
    sellPerT,
    buyPerT,
    capacityT: cap,
  };
}

/** One load sold at the peak. */
export interface Delivery {
  /** Epoch ms. */
  at: number;
  tons: number;
  credits: number;
}

/**
 * The commander's own round trip, in milliseconds — median of the gaps
 * between deliveries.
 *
 * Measured rather than assumed, for the same reason the orrery draws the
 * supercruise leg as a band: the same run takes wildly different times
 * depending on traffic, pad queues and how long somebody spent in the
 * carrier's kitchen. Median, not mean, so one interrupted trip (a break, a
 * relog) does not drag the estimate.
 *
 * Null until there are two deliveries, because one delivery is not a pace.
 */
export function medianRoundTripMs(deliveries: readonly Delivery[]): number | null {
  if (deliveries.length < 2) return null;
  const sorted = [...deliveries].sort((a, b) => a.at - b.at);
  const gaps: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].at - sorted[i - 1].at;
    // A gap beyond three hours is a night's sleep, not a lap.
    if (gap > 0 && gap < 3 * 3_600_000) gaps.push(gap);
  }
  if (!gaps.length) return null;
  gaps.sort((a, b) => a - b);
  const mid = Math.floor(gaps.length / 2);
  return gaps.length % 2 ? gaps[mid] : Math.round((gaps[mid - 1] + gaps[mid]) / 2);
}

/** Full loads still in the carrier, rounded up — a part load is still a trip. */
export function runsRemaining(wineTons: number | null, capacityT: number): number | null {
  if (wineTons == null || capacityT <= 0) return null;
  return Math.ceil(Math.max(0, wineTons) / capacityT);
}

/** How long those runs will take at the measured pace. */
export function etaMs(runs: number | null, roundTripMs: number | null): number | null {
  if (runs == null || roundTripMs == null || runs <= 0) return null;
  return runs * roundTripMs;
}

/** Credits banked per hour, over the deliveries inside `windowMs`. */
export function creditsPerHour(
  deliveries: readonly Delivery[],
  nowMs: number,
  windowMs = 2 * 3_600_000,
): number | null {
  const recent = deliveries.filter((d) => nowMs - d.at <= windowMs);
  if (recent.length < 2) return null;
  const first = Math.min(...recent.map((d) => d.at));
  const span = nowMs - first;
  if (span < 60_000) return null;
  const credits = recent.reduce((n, d) => n + d.credits, 0);
  return Math.round((credits / span) * 3_600_000);
}

/** Totals for the run so far. */
export function tally(deliveries: readonly Delivery[]): { tons: number; credits: number; runs: number } {
  return {
    tons: deliveries.reduce((n, d) => n + d.tons, 0),
    credits: deliveries.reduce((n, d) => n + d.credits, 0),
    runs: deliveries.length,
  };
}

/**
 * Is this the peak?
 *
 * The SYSTEM is the real test. A `Location` event carries no station name —
 * only `Docked` does — so requiring the name would silently miss a sale made
 * after a relog at the peak, which is precisely when a tally matters. There
 * is one port in HIP 58832 worth hauling wine to; being there is enough.
 * The name is still accepted on its own, for a market remembered from a
 * session where the system was not recorded.
 */
export function isPeak(station: string | null | undefined, system?: string | null): boolean {
  const s = (station ?? '').trim().toLowerCase();
  if (s.includes('rackham')) return true;
  return !!system && system.trim().toLowerCase() === BOOZE_SYSTEM.toLowerCase();
}
