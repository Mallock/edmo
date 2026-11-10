/**
 * The system architect's shopping list.
 *
 * A colonisation build is a haulage problem the game states exactly once, on a
 * panel the commander can only read while docked at the site — and then never
 * again from the cockpit. The depot at HIP 71120 wants 6,721 t across seventeen
 * commodities, and the only place that list exists is inside the construction
 * contribution screen.
 *
 * Everything here is folded from the real events of that build:
 *
 *   Docked                          StationType SpaceConstructionDepot,
 *                                   services include colonisationcontribution,
 *                                   LandingPads Small 3 / Medium 11 / Large 0
 *   ColonisationConstructionDepot   ResourcesRequired[17], ConstructionProgress
 *                                   0.002678 — Steel 2542, Titanium 1525,
 *                                   Aluminium 1322, Liquid oxygen 678 …
 *   ColonisationContribution        Contributions[{Liquid oxygen 2, Water 16}]
 *   Cargo.json                      Inventory[{Name:'methaneclathrate', …}]
 *
 * The three name each commodity a different way — `$aluminium_name;` in the
 * depot, `$LiquidOxygen_name;` (capitalised!) in the contribution, plain
 * `methaneclathrate` in the hold, "Liquid oxygen" in a market. commodityKey()
 * is what lets one shopping list be built across all four.
 *
 * Pure module — unit-tested in tests/architect.test.ts.
 */
import type { JournalEvent } from './types.ts';
import type { MarketRecord } from './trade.ts';
import { reportAgeDays, STALE_DAYS, type MarketLookupRow } from './tools.ts';
import { jumpsFor, type ReachEstimate } from './starmap.ts';

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** A fleet carrier's registration plate — "V6W-TTJ". The only tell in a name. */
const CALLSIGN = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;

/**
 * One commodity, one key, whatever wrapper the game put around the name.
 *
 * `$aluminium_name;` (depot), `$LiquidOxygen_name;` (contribution),
 * `methaneclathrate` (Cargo.json), "Liquid oxygen" (market listing) and
 * "Fruit and Vegetables" (Ardent) must all collapse onto the same string or the
 * list silently double-counts and the hold never matches the requirement.
 */
export function commodityKey(name: string | null | undefined): string {
  return String(name ?? '')
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/_name;?$/, '')
    .replace(/[^a-z0-9]+/g, '');
}

/** One line of the requirement, as the depot states it. */
export interface DepotResource {
  key: string;
  name: string;
  required: number;
  provided: number;
  /** Still wanted. Never negative — an over-delivered commodity is just done. */
  remaining: number;
  /** What the depot pays per ton, which is not what it costs to buy. */
  payment: number;
}

export interface DepotState {
  marketId: number;
  station: string | null;
  system: string | null;
  /** 0–1, as the game reports it (0.002678 on the first day of a build). */
  progress: number;
  complete: boolean;
  failed: boolean;
  /** ISO timestamp of the depot event this was folded from. */
  at: string;
  resources: DepotResource[];
  /**
   * ISO timestamp of the last docking here. Null for a depot restored from the
   * single-depot save, which never recorded one. Only ever used to decide
   * which memory to let go of first.
   */
  lastDockedAt?: string | null;
}

/**
 * The name the game wrote, made readable.
 *
 * A colonisation ship's StationName is not a name, it is a localisation token
 * with a name stuck on the end:
 *
 *   "$EXT_PANEL_ColonisationShip; Byeong-cheon Reach"
 *
 * The game's own UI resolves `$EXT_PANEL_ColonisationShip;` to "Colonisation
 * Ship" and shows the pair. We were rendering the raw token — as the panel
 * title, in the feed, in the sites list, and out loud, where a text-to-speech
 * voice has to make something of "dollar E X T underscore panel". Every other
 * construction site in the game reads perfectly ("Orbital Construction Site:
 * Perga's Progress"), so this one token was the whole problem.
 *
 * Unknown `$…;` tokens are un-camel-cased rather than dropped: the game adds
 * new ones, and "Foo Bar: Some Name" is a good guess where deleting the token
 * would lose which KIND of place this is.
 */
export function stationDisplayName(name: string | null | undefined): string {
  const raw = str(name);
  if (!raw) return '';
  const m = /^\$([A-Za-z0-9_]+?)_?;?\s*(?:;|\s)\s*(.*)$/.exec(raw) ?? /^\$([A-Za-z0-9_]+);?\s*$/.exec(raw);
  if (!m) return raw;
  const token = m[1].replace(/^EXT_PANEL_/i, '').replace(/_name$/i, '');
  const label = token
    // ColonisationShip → Colonisation Ship; keeps runs like "FC" together.
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim();
  const rest = (m[2] ?? '').trim();
  if (!label) return rest || raw;
  return rest ? `${label}: ${rest}` : label;
}

/** A construction site is the only station type that asks for contributions. */
export function isConstructionDepot(ev: JournalEvent): boolean {
  const type = str(ev.StationType).toLowerCase();
  if (type.includes('constructiondepot')) return true;
  const services = Array.isArray(ev.StationServices) ? ev.StationServices : [];
  return services.some((s) => String(s).toLowerCase() === 'colonisationcontribution');
}

/**
 * DO NOT reintroduce a landing-pad check from `LandingPads`.
 *
 * The Docked event at a construction site reports its pads, and for these
 * stations it is WRONG. "Orbital Construction Site: Perga's Progress" reports
 * `{Small: 3, Medium: 11, Large: 0}` on every single docking — while the
 * commander docks there repeatedly in a Panther Clipper Mk II, a 1,046 t
 * large-pad-only hauler. Orbital construction sites take large ships.
 *
 * A warning built on that field told a commander their ship could not dock at
 * a pad they were already standing on, which is worse than saying nothing.
 *
 * @see tests/architect.test.ts — "the site's own pad count is not trusted"
 */

/**
 * Past this many remembered depots, the oldest memory goes.
 *
 * A `DepotState` is a few hundred bytes; thirty-two of them is nothing against
 * any storage limit. The cap exists so a career-long colonisation hauler does
 * not accumulate an unbounded list in localStorage, not because the data is
 * large.
 */
const MAX_DEPOTS = 32;

/**
 * Folds the depot events into what the commander knows first-hand.
 *
 * The depot event itself carries no station name — only a MarketID — so the
 * Docked event is what gives the list a place. Without pairing them the panel
 * can tell the commander what to buy but not where to bring it.
 *
 * TWO TIERS OF KNOWLEDGE LIVE IN THIS MODULE, AND THEY MUST NOT BLUR.
 *
 *   First-hand  — `DepotState`, folded from the journal of a site the commander
 *                 actually docked at. Carries TONNAGE: RequiredAmount and
 *                 ProvidedAmount, which exist nowhere else in the galaxy.
 *   Third-hand  — `SiteListing`, folded from community data about a site nobody
 *                 in this cockpit has visited. Carries the commodity set and a
 *                 price, and NO TONNAGE FIELD AT ALL.
 *
 * They are separate types rather than one type with optional fields precisely
 * so the second can never be mistaken for the first. EDDN reports `demand: 0`
 * on every construction-depot row — verified across 160 live rows in Preae Aihm
 * EH-D d12-64 — so any tonnage attached to a `SiteListing` would be invented.
 * A missing field cannot be misread; an `undefined` one can.
 *
 * Every site the commander has docked at is remembered, keyed by MarketID.
 * Docking at the next one does not erase the last: a colonisation system holds
 * dozens of sites (42 in that same system), and a commander working a build
 * area moves between them all day.
 */
export class ConstructionTracker {
  /** Every site docked at, keyed by MarketID. The docked one is `activeId`. */
  private depots = new Map<number, DepotState>();
  private activeId: number | null = null;
  /** Where each MarketID was docked, so a depot event can be given a name. */
  private places = new Map<number, { station: string; system: string; at: string | null }>();

  /**
   * The site under the ship — or the last one we actually read a board at.
   *
   * The fallback matters: `ColonisationConstructionDepot` is written when the
   * commander opens the contribution panel, NOT when they dock. Docking at a
   * site whose board has never been opened must not blank a requirement we are
   * still holding for somewhere else.
   */
  get depot(): DepotState | null {
    return (this.activeId != null ? this.depots.get(this.activeId) : undefined) ?? this.all[0] ?? null;
  }

  /** Every remembered site, the active one first, then most recent docking. */
  get all(): DepotState[] {
    const when = (d: DepotState): number => Date.parse(d.lastDockedAt ?? d.at) || 0;
    return [...this.depots.values()].sort(
      (a, b) =>
        Number(b.marketId === this.activeId) - Number(a.marketId === this.activeId) ||
        when(b) - when(a),
    );
  }

  /** True when this event changed the list — the caller may want to react. */
  apply(ev: JournalEvent): boolean {
    switch (ev.event) {
      case 'Docked': {
        if (!isConstructionDepot(ev)) return false;
        const marketId = num(ev.MarketID);
        if (!marketId) return false;
        const at = str(ev.timestamp) || null;
        const place = {
          station: str(ev.StationName) || 'Construction site',
          system: str(ev.StarSystem) || '?',
          at,
        };
        this.places.set(marketId, place);
        const was = this.activeId;
        this.activeId = marketId;
        // A depot event we already hold gains its name the moment we dock —
        // and becomes the active one again, without losing its siblings.
        const held = this.depots.get(marketId);
        if (held) {
          this.depots.set(marketId, {
            ...held,
            station: place.station,
            system: place.system,
            lastDockedAt: at ?? held.lastDockedAt ?? null,
          });
          return true;
        }
        // No requirement read here yet. The place is remembered so the depot
        // event that follows lands with a name on it; deliberately NO entry is
        // created, because a DepotState with no resources would render as a
        // build that wants nothing — a lie, rather than an empty state.
        return was !== marketId;
      }
      case 'ColonisationConstructionDepot': {
        const marketId = num(ev.MarketID);
        const raw = Array.isArray(ev.ResourcesRequired) ? ev.ResourcesRequired : [];
        if (!marketId || !raw.length) return false;
        const resources: DepotResource[] = [];
        for (const r of raw as Array<Record<string, unknown>>) {
          const name = str(r.Name_Localised) || str(r.Name);
          const key = commodityKey(str(r.Name) || name);
          if (!key) continue;
          const required = num(r.RequiredAmount);
          const provided = num(r.ProvidedAmount);
          resources.push({
            key,
            name: name.replace(/^\$|_name;?$/g, '') || key,
            required,
            provided,
            remaining: Math.max(0, required - provided),
            payment: num(r.Payment),
          });
        }
        if (!resources.length) return false;
        const at = this.places.get(marketId);
        const held = this.depots.get(marketId);
        // Replaced in place: a re-read of a known site updates that site and
        // never becomes a second entry for the same MarketID.
        this.depots.set(marketId, {
          marketId,
          station: at?.station ?? held?.station ?? null,
          system: at?.system ?? held?.system ?? null,
          progress: num(ev.ConstructionProgress),
          complete: ev.ConstructionComplete === true,
          failed: ev.ConstructionFailed === true,
          at: str(ev.timestamp) || new Date(0).toISOString(),
          resources,
          lastDockedAt: at?.at ?? held?.lastDockedAt ?? null,
        });
        if (this.activeId == null) this.activeId = marketId;
        this.evict();
        return true;
      }
      case 'ColonisationContribution': {
        // The depot event normally follows a contribution, but not always
        // before the commander undocks and flies away — so credit the delivery
        // immediately rather than showing them a list they have already filled.
        //
        // Scoped by MarketID: a contribution at one site must never be credited
        // against a sibling site's requirement.
        const marketId = num(ev.MarketID);
        const held = marketId ? this.depots.get(marketId) : undefined;
        const given = Array.isArray(ev.Contributions) ? ev.Contributions : [];
        if (!held || !given.length) return false;
        const by = new Map<string, number>();
        for (const c of given as Array<Record<string, unknown>>) {
          const key = commodityKey(str(c.Name) || str(c.Name_Localised));
          if (key) by.set(key, (by.get(key) ?? 0) + num(c.Amount));
        }
        if (!by.size) return false;
        this.depots.set(marketId, {
          ...held,
          at: str(ev.timestamp) || held.at,
          resources: held.resources.map((r) => {
            const add = by.get(r.key);
            if (!add) return r;
            const provided = Math.min(r.required, r.provided + add);
            return { ...r, provided, remaining: Math.max(0, r.required - provided) };
          }),
        });
        return true;
      }
      default:
        return false;
    }
  }

  /**
   * Let go of the oldest memory, never the site under the ship.
   *
   * A build the commander finished is the one they need least, so those go
   * first, oldest docking first. Only when every remembered site is still
   * outstanding does an unfinished one get dropped.
   */
  private evict(): void {
    const when = (d: DepotState): number => Date.parse(d.lastDockedAt ?? d.at) || 0;
    while (this.depots.size > MAX_DEPOTS) {
      const spare = [...this.depots.values()].filter((d) => d.marketId !== this.activeId);
      if (!spare.length) return;
      const finished = spare.filter((d) => d.complete || d.failed);
      const pool = finished.length ? finished : spare;
      const oldest = pool.reduce((a, b) => (when(a) <= when(b) ? a : b));
      this.depots.delete(oldest.marketId);
    }
  }

  toJSON(): { depots: DepotState[]; activeId: number | null } {
    return { depots: [...this.depots.values()], activeId: this.activeId };
  }

  /**
   * Read either save shape.
   *
   * `{ depot }` is what every version up to 1.9.3 wrote. A commander mid-build
   * must not lose the site they are standing in to a version bump, so the old
   * shape loads as a one-entry map with that site active. Absent, malformed or
   * resource-less input leaves the tracker empty rather than throwing — the
   * next depot event restates the whole list anyway.
   */
  load(
    d: { depot?: DepotState | null; depots?: DepotState[]; activeId?: number | null } | null,
  ): void {
    if (!d || typeof d !== 'object') return;
    const keep = (dep: unknown): number | null => {
      if (!dep || typeof dep !== 'object') return null;
      const s = dep as DepotState;
      const marketId = num(s.marketId);
      if (!marketId || !Array.isArray(s.resources)) return null;
      this.depots.set(marketId, { ...s, lastDockedAt: s.lastDockedAt ?? null });
      if (s.station && s.system) {
        this.places.set(marketId, {
          station: s.station,
          system: s.system,
          at: s.lastDockedAt ?? null,
        });
      }
      return marketId;
    };
    if (Array.isArray(d.depots)) {
      for (const dep of d.depots) keep(dep);
      const active = num(d.activeId);
      this.activeId = active && this.depots.has(active) ? active : null;
      return;
    }
    this.activeId = keep(d.depot);
  }
}

// -------------------------------------------------------------- the site roster

/**
 * One row of the whole-system commodity sweep, as this module needs it.
 *
 * Declared structurally rather than imported from the UI bridge so the engine
 * stays a pure, testable module with no view layer above it — the same
 * discipline `spansh.ts` keeps while its network call lives in Rust.
 * `ArdentSystemRow` satisfies this shape.
 */
export interface SystemCommodityRow {
  /** Null on a site nobody has reported: one row, every commodity field empty. */
  commodity?: string | null;
  station: string;
  system: string;
  stationType?: string | null;
  price?: number | null;
  pad?: string | null;
  distanceLs?: number | null;
  updatedAt?: string | null;
}

/**
 * The two station types the game gives a colonisation site.
 *
 * The only reliable way to tell a construction site from a station. Names are
 * no help: a site can be called "Orbital Construction Site: Coney Platform" or
 * simply "Crevenna Town", and both are building.
 */
const CONSTRUCTION_TYPES = new Set(['spaceconstructiondepot', 'planetaryconstructiondepot']);

export const isConstructionSiteType = (stationType: string | null | undefined): boolean =>
  CONSTRUCTION_TYPES.has(String(stationType ?? '').toLowerCase());

/**
 * Ardent squashes a commodity to its key — `advancedcatalysers`, `liquidoxygen`
 * — so a readable name can only come from somewhere the game wrote one: the
 * depot's `Name_Localised`, or the hold. Failing both, the key is shown as it
 * is rather than guessed at.
 */
const label = (raw: string): string => (raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : raw);

/** One commodity a site is reported to take, and what its board paid for it. */
export interface SiteCommodity {
  key: string;
  name: string;
  /**
   * Credits per ton, as the community last read this site's board.
   *
   * A price, not a quantity. Nothing here says how much the site still wants.
   */
  payment: number | null;
}

/**
 * A construction site the commander has NOT stood on: third-hand knowledge.
 *
 * THERE IS NO TONNAGE FIELD ON THIS TYPE, AND ONE MUST NEVER BE ADDED.
 *
 * EDDN reports `demand: 0` on every construction-depot row — 160 of them
 * checked live — so "how much does this site still want" simply is not in
 * community data. It exists only in the journal of a commander who docked
 * there, which is what `DepotState` is for. An optional `remaining?: number`
 * here would be `undefined` for every listing and every consumer would have to
 * remember that; one missed guard renders an invented figure.
 *
 * @see tests/architect.test.ts — "a site listing carries no tonnage, ever"
 */
export interface SiteListing {
  station: string;
  system: string;
  /** `SpaceConstructionDepot` or `PlanetaryConstructionDepot`, as reported. */
  stationType: string;
  /** Supercruise distance from the star — inside one system, the whole journey. */
  distanceLs: number | null;
  pad: string | null;
  /** What the site is reported to accept. Empty when nobody has reported it. */
  commodities: SiteCommodity[];
  /** When the community last saw this site's board. Null if never. */
  updatedAt: string | null;
  ageDays: number | null;
  /**
   * Too old to fly on — or never dated at all. An unreported site is not
   * fresh, so it does not get to sit above one that was read this week.
   */
  stale: boolean;
}

/**
 * More commodities than any construction site could be asking for.
 *
 * Real requirement lists are small: seventeen at HIP 71120, one to twenty-seven
 * across the twenty reported sites in Pueloi VY-S d3-94, twenty-one at each
 * Preae Aihm site. Past this, the rows are not a requirement — they are a
 * whole price table that was reported once and never expired.
 *
 * @see pruneCatalogueDump
 */
const CATALOGUE_MAX = 40;

export interface RosterInput {
  /** Sites the commander has docked at. First-hand wins; these are suppressed. */
  known?: readonly DepotState[];
  /** Commodity key → the readable name the game wrote, when we have one. */
  names?: ReadonlyMap<string, string>;
  /** Sites in this system lead — usually where the ship is standing. */
  first?: string | null;
  nowMs?: number;
}

/**
 * Throw away a stale price table masquerading as a requirement.
 *
 * Ardent keeps the union of everything ever reported about a station and never
 * expires a row, so a site can arrive carrying two unrelated readings at once.
 * "Orbital Construction Site: Archades Hammer" returned 371 commodities: 364
 * dated 2026-07-01 — the entire game catalogue, `advert1` and
 * `albinoquechuamammoth` included — and seven dated 2026-08-25/26 that are the
 * actual outpost list (aluminium, insulating membrane, liquid oxygen, polymers,
 * steel, titanium, water). Taking the union told the commander the site accepted
 * tritium at 39,501 cr, which it does not accept at all: exactly the invented
 * knowledge this module exists to refuse.
 *
 * So when a site's list is implausibly long, only its most recent reporting
 * window is believed. The trade is deliberate and one-directional: a real
 * commodity reported weeks before the newest row is dropped along with the
 * junk, so the site is under-claimed rather than over-claimed. It only ever
 * fires on a list no construction site could have — nineteen of the twenty
 * reported sites in that system are untouched.
 */
function pruneCatalogueDump(list: Array<SiteCommodity & { at: string | null }>): void {
  if (list.length <= CATALOGUE_MAX) return;
  const newest = list.reduce<number>((n, c) => Math.max(n, Date.parse(c.at ?? '') || 0), 0);
  if (!newest) return;
  // Same horizon as a stale report, measured from the site's own newest row
  // rather than from now: one reporting window, not one moment.
  const cut = newest - STALE_DAYS * 86_400_000;
  const kept = list.filter((c) => (Date.parse(c.at ?? '') || 0) >= cut);
  if (kept.length) list.splice(0, list.length, ...kept);
}

/**
 * The construction sites of a system, from the sweep already fetched.
 *
 * A fold, not a fetch. `architectScan` asks Ardent for every commodity at every
 * station in the system and keeps the rows that are selling; the construction
 * sites in that same response — the stations that would TAKE what is in the
 * hold — used to be dropped on the floor. This picks them back up. No extra
 * request, no new host, nothing beyond the opt-in already granted.
 *
 * A site with a null commodity name is kept, with an empty commodity list.
 * Preae Aihm EH-D d12-64 holds 42 sites and only twelve have ever been
 * reported; dropping the other thirty would tell the commander the system has
 * twelve sites when it has forty-two.
 */
export function siteRoster(
  rows: readonly SystemCommodityRow[],
  input: RosterInput = {},
): SiteListing[] {
  const nowMs = input.nowMs ?? Date.now();
  const at = (station: string | null, system: string | null): string =>
    `${station ?? ''}|${system ?? ''}`.toLowerCase();
  // Somewhere we have docked is somewhere we know precisely. Showing the
  // community's July price beside tonnage read this morning invites the
  // commander to compare them, and the older one always loses.
  const mine = new Set(
    (input.known ?? []).filter((d) => d.station && d.system).map((d) => at(d.station, d.system)),
  );
  const sites = new Map<string, SiteListing>();
  // Commodities are collected with the date of the row they came from, so a
  // second reading of the same board can replace the first and an ancient
  // price table can be told apart from this week's requirement.
  const listed = new Map<string, Map<string, SiteCommodity & { at: string | null }>>();
  for (const row of rows) {
    if (!isConstructionSiteType(row.stationType)) continue;
    const station = String(row.station ?? '').trim();
    const system = String(row.system ?? '').trim();
    if (!station || !system) continue;
    const id = at(station, system);
    if (mine.has(id)) continue;
    let site = sites.get(id);
    if (!site) {
      site = {
        station,
        system,
        stationType: String(row.stationType ?? ''),
        distanceLs: row.distanceLs ?? null,
        pad: row.pad ?? null,
        commodities: [],
        updatedAt: null,
        ageDays: null,
        stale: true,
      };
      sites.set(id, site);
      listed.set(id, new Map());
    }
    const key = commodityKey(row.commodity);
    if (!key) continue;
    const already = listed.get(id)!;
    const held = already.get(key);
    // The newest reading of a commodity wins, not the first one in the array:
    // where a board has been read twice, the later price is the true one.
    if (held && (Date.parse(held.at ?? '') || 0) >= (Date.parse(row.updatedAt ?? '') || 0)) continue;
    already.set(key, {
      key,
      name: input.names?.get(key) ?? label(String(row.commodity ?? key)),
      payment: row.price ?? null,
      at: row.updatedAt ?? null,
    });
  }
  const out = [...sites.values()];
  for (const s of out) {
    const list = [...listed.get(at(s.station, s.system))!.values()];
    pruneCatalogueDump(list);
    s.commodities = list
      .map(({ key, name, payment }) => ({ key, name, payment }))
      .sort((a, b) => a.name.localeCompare(b.name));
    // A site is as fresh as the newest row still believed about it.
    s.updatedAt = list.reduce<string | null>(
      (n, c) => (c.at && (!n || c.at > n) ? c.at : n),
      null,
    );
    s.ageDays = reportAgeDays(s.updatedAt, nowMs);
    s.stale = s.ageDays == null || s.ageDays > STALE_DAYS;
  }
  const home = (input.first ?? '').toLowerCase();
  const near = (s: SiteListing): number => (home && s.system.toLowerCase() === home ? 0 : 1);
  out.sort(
    (a, b) =>
      near(a) - near(b) ||
      Number(!a.commodities.length) - Number(!b.commodities.length) ||
      Number(a.stale) - Number(b.stale) ||
      (a.distanceLs ?? Infinity) - (b.distanceLs ?? Infinity) ||
      a.station.localeCompare(b.station),
  );
  return out;
}

/** One site that takes something aboard, and the terms it was last seen on. */
export interface HoldSite {
  station: string;
  system: string;
  payment: number | null;
  pad: string | null;
  distanceLs: number | null;
  ageDays: number | null;
  stale: boolean;
}

/** What is in the hold, and who around here will take it. */
export interface HoldMatch {
  key: string;
  name: string;
  /** Tons aboard right now — first-hand, straight off Cargo.json. */
  tons: number;
  sites: HoldSite[];
  /** Said out loud when nothing here takes it, rather than shown as a blank. */
  note: string | null;
}

/**
 * Lead with the hold: what is aboard, and who here accepts it.
 *
 * The keying is the whole trick, as everywhere else in this module — the hold
 * says `liquidoxygen` and Ardent says `liquidoxygen` but a depot says
 * `$LiquidOxygen_name;`, so everything collapses through `commodityKey` first.
 *
 * A commodity nobody here takes gets a sentence, not an empty list. "No result"
 * and "we looked and the answer is nobody" read identically on a panel, and
 * only one of them is worth acting on.
 */
export function holdAtSites(
  cargo: ReadonlyMap<string, number>,
  listings: readonly SiteListing[],
  names?: ReadonlyMap<string, string>,
): HoldMatch[] {
  const out: HoldMatch[] = [];
  for (const [rawKey, tons] of cargo) {
    const key = commodityKey(rawKey);
    if (!key || tons <= 0) continue;
    const sites: HoldSite[] = [];
    let name = names?.get(key) ?? null;
    for (const l of listings) {
      const c = l.commodities.find((x) => x.key === key);
      if (!c) continue;
      name ??= c.name;
      sites.push({
        station: l.station,
        system: l.system,
        payment: c.payment,
        pad: l.pad,
        distanceLs: l.distanceLs,
        ageDays: l.ageDays,
        stale: l.stale,
      });
    }
    // Best paid first, but never a rumour above a current report: a six-week
    // old board is a reason to look, not a reason to fly.
    sites.sort(
      (a, b) =>
        Number(a.stale) - Number(b.stale) ||
        (b.payment ?? -1) - (a.payment ?? -1) ||
        (a.distanceLs ?? Infinity) - (b.distanceLs ?? Infinity),
    );
    out.push({
      key,
      name: name ?? label(key),
      tons,
      sites,
      note: sites.length ? null : 'No known site here accepts this.',
    });
  }
  return out.sort((a, b) => b.sites.length - a.sites.length || b.tons - a.tons);
}

// ------------------------------------------------------------ the shopping list

/** Where a commodity can be got, ranked into the tree. */
export interface Source {
  station: string;
  system: string;
  distanceLy: number | null;
  price: number | null;
  stock: number | null;
  pad: string | null;
  carrier: boolean;
  updatedAt?: string | null;
  /** Days since the community last saw it; null when undated. */
  ageDays: number | null;
  /** The commander read this price off the board themselves. */
  own?: boolean;
  /** Same system as the build — a haul with no jump in it. */
  inSystem?: boolean;
  /**
   * Supercruise distance from the star, when known.
   *
   * Inside one system this is the ONLY distance that matters, and it is not a
   * small difference: HIP 71120's stations run from 743 Ls to well past
   * 200,000. "No jump" does not mean "next door".
   */
  distanceLs?: number | null;
  /**
   * Jumps to get there, at the ship's measured laden range.
   *
   * Light years are the honest number and jumps are the one a commander
   * actually feels: 464 ly is abstract, fourteen jumps is an evening. Null
   * whenever the distance or the range is unknown — never a guess.
   */
  jumps?: number | null;
}

export type Bucket = 'deliver' | 'carrier' | 'here' | 'system' | 'nearby' | 'unknown' | 'done';

export interface ShoppingItem {
  key: string;
  name: string;
  required: number;
  provided: number;
  remaining: number;
  payment: number;
  /** Tons of it in the hold right now. */
  inHold: number;
  /** What can be handed over on this docking without flying anywhere. */
  deliverNow: number;
  /**
   * Tons of it already sitting in the fleet carrier's hold.
   *
   * Not deliverable — it still has to be shuttled — but it is bought and paid
   * for, and a list that ignores it sends the commander to buy steel they
   * already own 4,500 t of.
   */
  onCarrier: number;
  /**
   * What still has to be ACQUIRED: remaining, less what the carrier holds.
   *
   * `remaining` is what the depot wants; `toBuy` is what the commander has to
   * go and find. On a build with no carrier behind it the two are identical,
   * which is why every ordering below can safely use this one.
   */
  toBuy: number;
  /** Best place to buy the rest, and the runners-up. */
  best: Source | null;
  alternatives: Source[];
  /** Full holds needed to shift what remains, when the capacity is known. */
  trips: number | null;
  /** A galaxy lookup has been run for this commodity. */
  scanned: boolean;
  bucket: Bucket;
  /**
   * The other lines the same stop covers.
   *
   * Crippen Reach sells both the steel and the titanium of the HIP 71120 build
   * — 4,067 t of the 6,703 t outstanding, from one pad. A per-commodity list
   * hides that completely and sends the commander back and forth.
   */
  stop: { station: string; system: string; lines: number; tons: number } | null;
}

export interface ShoppingGroup {
  bucket: Bucket;
  title: string;
  /** The one-line reason this group sits where it does. */
  hint: string;
  items: ShoppingItem[];
  /** Tons outstanding across the group. */
  tons: number;
}

export interface ShoppingInput {
  /** Commodity key → tons in the hold (from Cargo.json). */
  cargo?: ReadonlyMap<string, number>;
  /** The market at the station the commander is docked at, when there is one. */
  localMarket?: MarketRecord | null;
  /**
   * Every market the commander has actually docked at and read.
   *
   * The whole reason this exists: Ardent knows nothing about HIP 71120, because
   * a system colonised last week has never been reported to EDDN. The community
   * cannot see the commander's own build site — but the commander can, one
   * docking at a time, and those readings are both first-hand and in-system.
   */
  visited?: readonly MarketRecord[];
  /** Commodity key → galaxy rows, as scanned. A present-but-empty array means
   *  "looked, found nobody" — which is not the same as "not looked yet". */
  sources?: ReadonlyMap<string, readonly MarketLookupRow[]>;
  /** Hold size, for the trip count. */
  cargoCapacity?: number | null;
  /**
   * What the commander's own fleet carrier is holding, and where it is.
   *
   * The staging warehouse of every deep-space build. `tons` is commodity key →
   * tons, as `CarrierHold.tons()` returns it; `system` decides whether that
   * tonnage is a supercruise hop away or a carrier jump away, which is the
   * difference between an afternoon and a week.
   */
  carrier?: {
    tons: ReadonlyMap<string, number>;
    system?: string | null;
    callsign?: string | null;
  } | null;
  /**
   * Light years from the commander to a system, for markets THEY read.
   *
   * Community rows arrive with a distance already on them; first-hand ones
   * never have, because market memory records a station, a system and a price
   * and has never known where any of it is. Without this the commander's own
   * five best sellers of titanium show no distance at all and cannot be
   * ordered by the only thing that decides the trip.
   */
  distanceFrom?: (system: string) => number | null;
  /** The ship's measured reach, for turning light years into jumps. */
  reach?: ReachEstimate | null;
  /**
   * Leave other commanders' fleet carriers out of the list.
   *
   * A carrier is not a supplier. It moves, it sells out, its owner reprices it
   * on a whim and may refuse the dock outright — and a colonisation haul runs
   * for days. Of the five nearest sellers of steel to the commander's build,
   * every single one was a carrier; the permanent stations holding 793,835 t
   * and 482,353 t were pushed off the end of the list by them.
   */
  stationsOnly?: boolean;
  /** The commander's own carrier, which is never filtered — it is their warehouse. */
  ownCarrier?: string | null;
  nowMs?: number;
}

/**
 * Distance rings rather than raw light-years.
 *
 * Only ever a tie-break. Ranking a shopping list by distance puts a 9 t errand
 * thirteen light-years away above the 2,542 t of steel that IS the build —
 * which is what the first cut of this module did against the real HIP 71120
 * data. Tonnage decides; the ring separates two hauls of similar size.
 */
const ring = (ly: number | null): number =>
  ly == null ? 5 : ly <= 1 ? 0 : ly <= 20 ? 1 : ly <= 50 ? 2 : ly <= 150 ? 3 : 4;

/** Where a row would be bought, as a grouping key. */
const stopKey = (i: ShoppingItem): string =>
  i.best ? `${i.best.station} ${i.best.system}` : '';

/**
 * Order the buy list as a trip, not as an inventory.
 *
 * Commodities cluster by seller — Crippen Reach has the steel AND the titanium,
 * Hayashi Engineering Forge has the polymers, ceramics and superconductors — so
 * the useful unit of planning is the stop, not the commodity. Clusters are
 * ranked by how much of the build they clear (with distance breaking ties
 * between similar hauls), and inside a cluster the big line leads.
 */
function byStop(items: readonly ShoppingItem[]): ShoppingItem[] {
  const stops = new Map<string, ShoppingItem[]>();
  for (const i of items) {
    const k = stopKey(i);
    const at = stops.get(k);
    if (at) at.push(i);
    else stops.set(k, [i]);
  }
  // Ranked by `toBuy`, never by `remaining`: a stop is worth flying to for what
  // it still has to SELL us. Ranking by what the depot wants would put a stop
  // top of the list for 4,067 t of steel the commander's own carrier is already
  // holding two hundred Ls from the site.
  const clusters = [...stops.values()].map((group) => {
    const sorted = [...group].sort((a, b) => b.toBuy - a.toBuy);
    return {
      items: sorted,
      tons: sorted.reduce((n, i) => n + i.toBuy, 0),
      ring: Math.min(...sorted.map((i) => ring(i.best?.distanceLy ?? null))),
    };
  });
  clusters.sort((a, b) => b.tons - a.tons || a.ring - b.ring);
  return clusters.flatMap((c) => c.items);
}

const toSource = (r: MarketLookupRow, nowMs: number, home = '', own = false): Source => ({
  station: r.station,
  system: r.system,
  distanceLy: r.distanceLy,
  price: r.price,
  stock: r.stock,
  pad: r.pad,
  carrier: r.carrier,
  updatedAt: r.updatedAt ?? null,
  ageDays: reportAgeDays(r.updatedAt, nowMs),
  own,
  inSystem: !!home && r.system.toLowerCase() === home,
  // Only the whole-system sweep carries this; a nearby row has no Ls figure.
  distanceLs: (r as { distanceLs?: number | null }).distanceLs ?? null,
});

/**
 * Turn the depot requirement into an ordered plan.
 *
 * The order is the whole point. A flat alphabetical list of seventeen
 * commodities — which is what the game itself shows — tells the commander
 * nothing about what to do next, and the answer is rarely "the first one".
 * Tons already in the hold outrank everything (that is progress for free),
 * then whatever the site's own market sells, then the near cluster, and only
 * then the commodities nobody nearby stocks.
 */
export function buildShoppingList(
  depot: DepotState | null,
  input: ShoppingInput = {},
): ShoppingGroup[] {
  if (!depot) return [];
  const nowMs = input.nowMs ?? Date.now();
  const cargo = input.cargo ?? new Map<string, number>();
  const sources = input.sources ?? new Map<string, readonly MarketLookupRow[]>();
  const capacity = input.cargoCapacity && input.cargoCapacity > 0 ? input.cargoCapacity : null;

  // What the station under the ship sells, keyed the same way as everything else.
  const local = new Map<string, { price: number; stock: number }>();
  for (const i of input.localMarket?.items ?? []) {
    if (i.buy > 0 && i.stock > 0) local.set(commodityKey(i.name), { price: i.buy, stock: i.stock });
  }
  const localAt = input.localMarket
    ? { station: input.localMarket.station, system: input.localMarket.system, at: input.localMarket.at }
    : null;

  // Markets read first-hand, indexed by commodity. A station the commander has
  // stood on outranks any report about it, and in a freshly colonised system it
  // is the ONLY source of truth — Ardent has never heard of the place.
  const home = (depot.system ?? '').toLowerCase();
  const seen = new Map<string, Source[]>();
  const seenEmpty = new Set<string>();
  for (const m of input.visited ?? []) {
    const sameSystem = m.system.toLowerCase() === home;
    const stocked = new Set<string>();
    for (const i of m.items) {
      const key = commodityKey(i.name);
      if (!(i.buy > 0 && i.stock > 0)) continue;
      stocked.add(key);
      const at: Source = {
        station: m.station,
        system: m.system,
        // Inside the build's own system there is no jump to make at all.
        // Anywhere else, the star map measures it — every system in market
        // memory is one the commander flew to, so its StarPos is on record.
        distanceLy: sameSystem ? 0 : (input.distanceFrom?.(m.system) ?? null),
        price: i.buy,
        stock: i.stock,
        pad: null,
        // Market memory records a station name and never a station TYPE, so a
        // board read on a carrier used to render as a permanent station. The
        // callsign shape is the only tell there is, and it is the same test
        // trade.ts already uses to keep carriers out of route starts.
        carrier: CALLSIGN.test(m.station),
        updatedAt: m.at,
        ageDays: reportAgeDays(m.at, nowMs),
        own: true,
        inSystem: sameSystem,
      };
      const list = seen.get(key);
      if (list) list.push(at);
      else seen.set(key, [at]);
    }
    // "I looked and it had none" is a fact about that station, and it must beat
    // a stranger's older claim that it was full.
    for (const r of depot.resources) if (!stocked.has(r.key)) seenEmpty.add(`${m.station}|${m.system}|${r.key}`);
  }

  const carrierTons = input.carrier?.tons ?? new Map<string, number>();
  const items: ShoppingItem[] = depot.resources.map((r) => {
    const inHold = cargo.get(r.key) ?? 0;
    const deliverNow = Math.min(inHold, r.remaining);
    // Only what the carrier holds AGAINST this line counts. A carrier sitting
    // on 900 t of tritium against a build that wants none of it is not 900 t
    // of progress, and must not be allowed to read as any.
    const onCarrier = Math.min(carrierTons.get(r.key) ?? 0, r.remaining);
    // The hold and the carrier are separate stacks, so both come off what is
    // still to be found. Capped at the requirement — over-supply is not credit
    // against the next commodity.
    const toBuy = Math.max(0, r.remaining - deliverNow - onCarrier);
    const rows = sources.get(r.key);
    const scanned = rows != null;
    const here = local.get(r.key);
    const mine = seen.get(r.key) ?? [];
    // Drop community rows for stations we have read ourselves — ours is both
    // first-hand and, by definition, from the last time we were actually there.
    const mineAt = new Set(mine.map((s) => `${s.station}|${s.system}`.toLowerCase()));
    const community = (rows ?? []).filter(
      (x) =>
        !mineAt.has(`${x.station}|${x.system}`.toLowerCase()) &&
        !seenEmpty.has(`${x.station}|${x.system}|${r.key}`),
    );
    // No jump beats everything except our own eyes on the same trip: a station
    // in the build's own system is supercruise, not a route. Inside each tier
    // the usual ranking applies — can it fill the order, then price.
    /**
     * Nearest first — this is a haul, not a bargain hunt.
     *
     * The general lookup in tools.ts ranks by price, and for a trader that is
     * right. A colonisation run is the opposite problem: the site PAYS more
     * than any of these sellers charge (5,360 cr/t against 3,883), so every
     * source on the list is profitable and the only real cost is the flying.
     * Ordering five sellers of titanium by a 477 cr spread, when one of them
     * is in the next system and another is fourteen jumps away, sorts by the
     * number that does not matter.
     *
     * One guard ahead of distance: a seller who cannot fill even a single hold
     * is a stop, not a supply, and leading with a nearer one holding 40 t sends
     * the commander to a pad for nothing.
     */
    const worthLoad = Math.max(1, Math.min(toBuy || r.remaining, capacity ?? Infinity));
    const thin = (s: Source): number => ((s.stock ?? Infinity) >= worthLoad ? 0 : 1);
    const byNear = (a: Source, b: Source): number =>
      thin(a) - thin(b) ||
      // An unknown distance sorts as far away, because that is the honest
      // assumption: the systems we cannot measure are the ones visited long
      // ago, and out here that usually means the bubble.
      (a.distanceLy ?? Infinity) - (b.distanceLy ?? Infinity) ||
      // Only NOW does having been there matter: two equally distant boards,
      // and the one we read ourselves is the one whose price is real.
      Number(!!b.own) - Number(!!a.own) ||
      (a.price ?? Infinity) - (b.price ?? Infinity) ||
      (b.stock ?? 0) - (a.stock ?? 0);
    /**
     * Somebody else's fleet carrier, when the commander has asked for none.
     *
     * Their OWN carrier is exempt: it is the warehouse the rest of this panel
     * is built around and the door is always open to them.
     */
    const ownRig = (input.ownCarrier ?? '').trim().toLowerCase();
    const shunned = (s: { carrier?: boolean; station: string }): boolean =>
      !!input.stationsOnly && !!s.carrier && s.station.trim().toLowerCase() !== ownRig;
    const asSources = (rows: MarketLookupRow[]): Source[] =>
      rows.filter((x) => !shunned(x)).map((x) => toSource(x, nowMs, home));
    /**
     * OUT OF SYSTEM, FIRST-HAND KNOWLEDGE IS NOT A TIER. IT IS A TIE-BREAK.
     *
     * This used to rank every market the commander had personally read above
     * every community row, which is obviously right inside the build's own
     * system and catastrophically wrong outside it. A commander colonising
     * Floanth PW-G b16-3 was shown five sellers of steel in HIP 71120, all
     * marked "you saw it", all listed under "Found nearby" — and HIP 71120 is
     * in the BUBBLE, 15,114 light years away. Four hundred and fifty-six jumps,
     * one way. The nearest real seller, FLK-B2Z at 107 ly, was ranked beneath
     * them because a stranger reported it.
     *
     * Having stood on a pad two months ago says the price was real. It says
     * nothing whatever about the place being near, and the two must never be
     * confused again.
     */
    const ours = mine.filter((s) => !shunned(s));
    const away = [...ours.filter((s) => !s.inSystem), ...asSources(community.filter((x) => x.system.toLowerCase() !== home))];
    const ranked = [
      // The build's own system genuinely IS a tier: no jump, at any price.
      ...[...ours.filter((s) => s.inSystem), ...asSources(community.filter((x) => x.system.toLowerCase() === home))].sort(byNear),
      ...away.sort(byNear),
    ];
    // Light years into jumps, once, for every row this line will show.
    for (const s of ranked) s.jumps = jumpsFor(s.distanceLy, input.reach ?? null);
    // The market we are standing on beats anything a stranger reported: no
    // travel, and the price is on the board rather than days old.
    const hereSource: Source | null =
      here && localAt
        ? {
            station: localAt.station,
            system: localAt.system,
            distanceLy: 0,
            price: here.price,
            stock: here.stock,
            pad: null,
            carrier: false,
            updatedAt: localAt.at,
            ageDays: reportAgeDays(localAt.at, nowMs),
            own: true,
            // The ship is standing on it. No distance, and no jumps.
            jumps: 0,
          }
        : null;
    const best = hereSource ?? ranked[0] ?? null;
    // Carrier stock outranks every shop: the tons are bought, paid for and
    // already in deep space. A line the carrier covers in full is not a
    // shopping problem at all, it is a shuttle run — so it leaves the buy
    // groups entirely rather than sitting in them with a footnote.
    const bucket: Bucket =
      r.remaining <= 0
        ? 'done'
        : deliverNow > 0
          ? 'deliver'
          : toBuy <= 0 && onCarrier > 0
            ? 'carrier'
            : hereSource
              ? 'here'
              : best?.inSystem
                ? 'system'
                : ranked.length
                  ? 'nearby'
                  : 'unknown';
    return {
      key: r.key,
      name: r.name,
      required: r.required,
      provided: r.provided,
      remaining: r.remaining,
      payment: r.payment,
      inHold,
      deliverNow,
      onCarrier,
      toBuy,
      best,
      alternatives: hereSource ? ranked.slice(0, 4) : ranked.slice(1, 5),
      trips: capacity ? Math.ceil(r.remaining / capacity) : null,
      scanned,
      bucket,
      stop: null,
    };
  });

  // What else each stop covers — computed across the whole list, since the
  // point is precisely that two different lines share one pad.
  const atStop = new Map<string, ShoppingItem[]>();
  for (const i of items) {
    // `toBuy`, not `remaining`: "+2 more from one pad" has to mean two more
    // lines this stop can actually sell us, or the badge promises a trip that
    // clears nothing.
    if (!i.best || i.toBuy <= 0) continue;
    const k = stopKey(i);
    const at = atStop.get(k);
    if (at) at.push(i);
    else atStop.set(k, [i]);
  }
  for (const i of items) {
    const together = atStop.get(stopKey(i));
    if (!i.best || !together) continue;
    i.stop = {
      station: i.best.station,
      system: i.best.system,
      lines: together.length,
      tons: together.reduce((n, x) => n + x.toBuy, 0),
    };
  }

  const byTons = (a: ShoppingItem, b: ShoppingItem): number => b.toBuy - a.toBuy;
  // Where the carrier is decides what the carrier group MEANS. Parked at the
  // build it is a shuttle run measured in minutes; parked in the bubble it is a
  // jump, a cooldown and a week — and a hint that says the wrong one of those
  // is worse than no hint.
  const carrierSystem = (input.carrier?.system ?? '').toLowerCase();
  const carrierHere = !!carrierSystem && carrierSystem === home;
  const carrierWho = input.carrier?.callsign ?? 'your carrier';
  const groups: ShoppingGroup[] = [
    {
      bucket: 'deliver',
      title: 'In your hold — hand it over now',
      hint: 'Already bought and already here. Contribute before you fly anywhere.',
      items: items.filter((i) => i.bucket === 'deliver').sort((a, b) => b.deliverNow - a.deliverNow),
      tons: 0,
    },
    {
      bucket: 'carrier',
      title: carrierHere
        ? `On ${carrierWho} — already here, just shuttle it`
        : `On ${carrierWho}${input.carrier?.system ? ` in ${input.carrier.system}` : ''} — bought, not delivered`,
      hint: carrierHere
        ? 'Parked in this system. Dock, transfer to the ship, fly it over — no market, no credits.'
        : 'You already own these. Jump the carrier here before buying a single ton of them again.',
      items: items.filter((i) => i.bucket === 'carrier').sort((a, b) => b.onCarrier - a.onCarrier),
      tons: 0,
    },
    {
      bucket: 'here',
      title: 'On sale at this station',
      hint: 'Buy it where you are standing — no jump, and the price is on the board.',
      items: items.filter((i) => i.bucket === 'here').sort(byTons),
      tons: 0,
    },
    {
      bucket: 'system',
      title: `In ${depot.system ?? 'this system'} — no jump`,
      hint: 'Stations you have docked at in the build’s own system. Supercruise, not a route.',
      items: byStop(items.filter((i) => i.bucket === 'system')),
      tons: 0,
    },
    {
      bucket: 'nearby',
      title: 'Found nearby',
      hint: 'Grouped by seller — the stop that clears the most of the build first.',
      items: byStop(items.filter((i) => i.bucket === 'nearby')),
      tons: 0,
    },
    {
      bucket: 'unknown',
      title: 'No source found',
      hint: 'Nobody nearby stocks these — widen the search, or mine/refine them.',
      items: items.filter((i) => i.bucket === 'unknown').sort(byTons),
      tons: 0,
    },
    {
      bucket: 'done',
      title: 'Delivered in full',
      hint: 'Nothing left to buy.',
      items: items.filter((i) => i.bucket === 'done').sort((a, b) => b.required - a.required),
      tons: 0,
    },
  ];
  // Each group counts the tonnage its own action moves: what can be handed
  // over now, what is waiting on the carrier, what still has to be bought. A
  // single `remaining` across all of them would count the same ton twice.
  for (const g of groups) {
    g.tons = g.items.reduce(
      (n, i) =>
        n +
        (g.bucket === 'deliver' ? i.deliverNow : g.bucket === 'carrier' ? i.onCarrier : i.toBuy),
      0,
    );
  }
  return groups.filter((g) => g.items.length);
}

// ----------------------------------------------------------------- the summary

/**
 * What the market just read covers of the build.
 *
 * Called on every Market.json the game writes, which is every docking. In a
 * newly colonised system this is the only way the list ever learns anything:
 * nobody has reported these stations to EDDN, so until the commander docks
 * there the panel cannot know the hub two hundred Ls away sells the steel.
 */
export function coversFromMarket(
  depot: DepotState | null,
  market: MarketRecord | null,
): Array<{ name: string; needed: number; price: number; stock: number }> {
  if (!depot || !market) return [];
  const wanted = new Map(depot.resources.filter((r) => r.remaining > 0).map((r) => [r.key, r]));
  const out: Array<{ name: string; needed: number; price: number; stock: number }> = [];
  for (const i of market.items) {
    if (!(i.buy > 0 && i.stock > 0)) continue;
    const r = wanted.get(commodityKey(i.name));
    if (r) out.push({ name: r.name, needed: r.remaining, price: i.buy, stock: i.stock });
  }
  return out.sort((a, b) => b.needed - a.needed);
}

/** One line for the feed when a docking turns up something the build needs. */
export function describeCoverage(
  station: string,
  covers: ReadonlyArray<{ name: string; needed: number; stock: number }>,
  inSystem: boolean,
): string | null {
  if (!covers.length) return null;
  const named = covers
    .slice(0, 3)
    .map((c) => `${c.name} (${tons(Math.min(c.needed, c.stock))} of the ${tons(c.needed)} wanted)`);
  const more = covers.length > 3 ? `, and ${covers.length - 3} more` : '';
  return `${station} sells ${named.join(', ')}${more} — ${
    inSystem ? 'and it is in the build’s own system, so no jump' : 'noted for the shopping list'
  }.`;
}

/** Tons outstanding across the whole build. */
export function tonsRemaining(depot: DepotState | null): number {
  return depot ? depot.resources.reduce((n, r) => n + r.remaining, 0) : 0;
}

/** Tons the build asked for in total. */
export function tonsRequired(depot: DepotState | null): number {
  return depot ? depot.resources.reduce((n, r) => n + r.required, 0) : 0;
}

const tons = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;

/**
 * The spoken/feed line when the list first appears.
 *
 * Leads with what can be done this minute (cargo in the hold the site wants),
 * because that is the difference between a status report and an instruction.
 */
export function describeDepot(
  depot: DepotState | null,
  groups: readonly ShoppingGroup[],
): string | null {
  if (!depot) return null;
  if (depot.complete) return `${stationDisplayName(depot.station) || 'The construction site'} is complete.`;
  if (depot.failed) return `${stationDisplayName(depot.station) || 'The construction site'} has failed.`;
  const left = tonsRemaining(depot);
  if (left <= 0) return `${stationDisplayName(depot.station) || 'The site'} has everything it asked for.`;
  const pct = Math.round(depot.progress * 1000) / 10;
  const wanted = depot.resources.filter((r) => r.remaining > 0).length;
  const head = `${stationDisplayName(depot.station) || 'Construction site'}: ${tons(left)} still wanted across ${wanted} commodit${
    wanted === 1 ? 'y' : 'ies'
  }, ${pct}% built.`;
  const deliver = groups.find((g) => g.bucket === 'deliver');
  if (deliver?.items.length) {
    const names = deliver.items.slice(0, 3).map((i) => `${Math.round(i.deliverNow)} t of ${i.name}`);
    return `${head} You are carrying ${names.join(', ')} it wants — hand that over first.`;
  }
  const biggest = [...depot.resources].sort((a, b) => b.remaining - a.remaining)[0];
  return `${head} The long pole is ${biggest.name}, ${tons(biggest.remaining)}.`;
}

/** Rows worth putting in front of the model when it is asked about the build. */
export function architectFacts(
  depot: DepotState | null,
  groups: readonly ShoppingGroup[],
): string | null {
  if (!depot) return null;
  const lines: string[] = [];
  lines.push(
    `CONSTRUCTION: ${stationDisplayName(depot.station) || 'site'} in ${depot.system ?? '?'} — ${Math.round(
      depot.progress * 1000,
    ) / 10}% built, ${tons(tonsRemaining(depot))} outstanding.`,
  );
  for (const g of groups) {
    if (g.bucket === 'done' || !g.items.length) continue;
    const items = g.items
      .slice(0, 6)
      .map((i) => {
        const where =
          i.bucket === 'deliver'
            ? `${Math.round(i.deliverNow)} t in your hold`
            : i.bucket === 'carrier'
              ? `${Math.round(i.onCarrier)} t already on your fleet carrier — do NOT suggest buying it`
              : i.best
              ? `${i.best.station}${i.best.system !== depot.system ? ` (${i.best.system}${
                  i.best.distanceLy != null ? `, ${Math.round(i.best.distanceLy)} ly` : ''
                })` : ''}${i.best.price != null ? ` at ${i.best.price.toLocaleString('en-US')} cr` : ''}`
              : 'no source found';
        return `${i.name} ${tons(i.remaining)} — ${where}`;
      })
      .join('; ');
    lines.push(`${g.title}: ${items}.`);
  }
  const stale = groups
    .flatMap((g) => g.items)
    .filter((i) => i.best && !i.best.own && (i.best.ageDays ?? 0) > STALE_DAYS).length;
  if (stale) lines.push(`${stale} of these sources are community reports over ${STALE_DAYS} days old — may be wrong.`);
  return lines.join('\n');
}

/** What the carrier's hold is worth to this build. */
export interface CarrierCoverage {
  /** Outstanding lines the carrier can close on its own. */
  lines: number;
  /** Outstanding lines in total, so the ratio can be stated. */
  ofLines: number;
  /** Tons of the outstanding requirement the carrier already holds. */
  tons: number;
  /** Tons still to be bought once the carrier and the hold are counted. */
  toBuy: number;
}

/**
 * How much of the build is already paid for and parked in deep space.
 *
 * The one number that changes a plan. A commander looking at "20,464 t still
 * wanted" and a commander looking at "20,464 t wanted, 12,900 t of it already
 * on your carrier in the next system" are running different operations, and
 * the game shows only the first of those figures.
 */
export function carrierCoverage(groups: readonly ShoppingGroup[]): CarrierCoverage {
  const all = groups.flatMap((g) => g.items).filter((i) => i.remaining > 0);
  return {
    lines: all.filter((i) => i.onCarrier > 0).length,
    ofLines: all.length,
    tons: all.reduce((n, i) => n + i.onCarrier, 0),
    toBuy: all.reduce((n, i) => n + i.toBuy, 0),
  };
}
