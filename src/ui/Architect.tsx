/**
 * The system architect's panel: a colonisation build as a shopping list.
 *
 * The game states the requirement once, on the contribution panel at the site,
 * as seventeen alphabetical rows of "required / provided". That ordering is
 * the least useful one available — it says nothing about what to do next, and
 * the commander cannot read it at all once they undock to go shopping.
 *
 * So the tree is ordered by what can be acted on, nearest-hand first: tons
 * already in the hold, then the market under the ship, then the near cluster,
 * then whatever nobody around here stocks. Each row opens to show where to buy
 * it, how old that report is, and how many full holds the job takes.
 *
 * Below the tree sit the sites themselves, in two tiers that must never be
 * allowed to look alike: the ones the commander has docked at, which carry
 * tonnage read off the game's own contribution panel, and the ones known only
 * through community data, which carry a commodity list and a price and NO
 * TONNAGE — because nobody reports it. A number in the wrong column here is
 * the difference between a plan and a wild guess.
 */
import { useState } from 'react';
import type { ArchitectView } from './store.ts';
import type {
  Bucket,
  DepotState,
  HoldMatch,
  ShoppingItem,
  SiteListing,
  Source,
} from '../engine/architect.ts';
import { stationDisplayName } from '../engine/architect.ts';
import { jumpsFor, type ReachEstimate } from '../engine/starmap.ts';
import { copyText } from './bridge.ts';
import type { Basket as BasketView, Cart as CartView, StopPlan, TripPlan } from '../engine/haul.ts';
import {
  ALL_BUILD_TYPES,
  BUILD_TYPES,
  describePoints,
  type BuildGuess,
  type BuildType,
  type LearnedBuild,
} from '../engine/buildtypes.ts';

/**
 * Tier points for the identified build.
 *
 * Read off the first match only. Where a tonnage matches several facilities
 * they sit at the same tier and cost the same points — the six orbital
 * outposts at 18,988 t are all "+1 T2" — so one reading covers the whole
 * family without implying the panel picked one of them.
 */
const buildPoints = (guess: BuildGuess): string => describePoints(guess.types[0]);

const tonsOf = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;
const cr = (n: number | null): string => (n == null ? '—' : `${Math.round(n).toLocaleString('en-US')} cr`);

/** Ardent reports pad size as 1/2/3; the commander reads S/M/L. */
const padLabel = (pad: string | number | null): string | null => {
  if (pad == null || pad === '') return null;
  const n = Number(pad);
  return n === 3 ? 'L' : n === 2 ? 'M' : n === 1 ? 'S' : String(pad);
};

/** How long ago a price was seen — the field that decides whether to fly. */
const ageLabel = (days: number | null): string =>
  days == null ? 'age unknown' : days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days}d ago`;

const bucketColour: Record<Bucket, string> = {
  deliver: 'var(--green)',
  // The carrier is the commander's own warehouse, so it wears the commander's
  // own phosphor rather than one of the four fixed status colours — it is not
  // a state of the build, it is a thing they own.
  carrier: 'var(--phos)',
  here: 'var(--cyan)',
  // In-system is nearly as good as here: supercruise, no jump, no route.
  system: 'var(--cyan)',
  nearby: 'var(--amber)',
  unknown: 'var(--red)',
  done: 'var(--dim)',
};

/**
 * How far, and what that is in jumps.
 *
 * Light years are the honest unit and jumps are the one a commander plans an
 * evening around: "464 ly" is a number, "14 jumps" is a decision. Shown only
 * where the ship's range has actually been measured — a jump count off an
 * unknown range would be the one invented figure on the panel.
 */
const legLabel = (source: Source): string => {
  if (source.inSystem) {
    // Inside one system the supercruise leg is the whole journey, and it is
    // not always short — say it rather than implying "next door".
    return source.distanceLs != null
      ? `${Math.round(source.distanceLs).toLocaleString('en-US')} Ls`
      : 'in system';
  }
  // A blank read as "near". It is the opposite: the systems with no distance
  // are the ones visited long ago, and out in deep space that means the
  // bubble — fifteen thousand light years of it. Say so.
  if (source.distanceLy == null) return 'distance unknown';
  if (source.distanceLy <= 0) return '';
  const ly = `${Math.round(source.distanceLy).toLocaleString('en-US')} ly`;
  return source.jumps ? `${ly} · ${source.jumps} jump${source.jumps === 1 ? '' : 's'}` : ly;
};

/**
 * The system name, and a button that puts it on the clipboard.
 *
 * The next thing a commander does with any of these rows is type the system
 * into the galaxy map search box — and these are not names anyone types
 * willingly: "Floanth FY-L c10-107", "Greae Hype TO-G c27-107". One character
 * wrong and the map finds nothing. The route plotter has had this button for
 * waypoints all along; the shopping list is where the awkward names actually
 * live.
 */
function SystemName({ system, leg }: { system: string; leg?: string }) {
  const [done, setDone] = useState(false);
  const copy = (e: { stopPropagation: () => void }): void => {
    // A source row sits inside an expanded disclosure; copying must not fold it.
    e.stopPropagation();
    void copyText(system).then(
      () => {
        setDone(true);
        window.setTimeout(() => setDone(false), 1400);
      },
      () => undefined,
    );
  };
  return (
    <>
      {/* The NAME is the button, not just the chip beside it. It is the widest
          target on the row and the thing the commander is already looking at —
          a glyph small enough to be tidy is small enough to go unnoticed. */}
      <button className="arc-sysname" title={`Copy "${system}" for the galaxy map`} onClick={copy}>
        {system}
        <span className={done ? 'arc-copy done' : 'arc-copy'} aria-hidden>
          {done ? '✓ copied' : 'copy'}
        </span>
      </button>
      {leg && <span className="arc-leg"> · {leg}</span>}
    </>
  );
}

function SourceRow({ source, need }: { source: Source; need: number }) {
  const pad = padLabel(source.pad);
  const short = source.stock != null && source.stock < need;
  const leg = legLabel(source);
  return (
    <li className="arc-src">
      <span className="arc-src-where">
        {source.station}
        {source.carrier && <span className="arc-chip">carrier</span>}
        {pad && <span className="arc-chip">pad {pad}</span>}
      </span>
      <span className="arc-src-sys">
        <SystemName system={source.system} leg={leg} />
      </span>
      <span className="arc-src-num mono">{cr(source.price)}</span>
      <span className={short ? 'arc-src-num mono short' : 'arc-src-num mono'}>
        {source.stock != null ? `${source.stock.toLocaleString('en-US')} t` : '—'}
      </span>
      <span className={source.own ? 'arc-age own' : (source.ageDays ?? 0) > 7 ? 'arc-age stale' : 'arc-age'}>
        {source.own ? 'you saw it' : ageLabel(source.ageDays)}
      </span>
    </li>
  );
}

function ItemRow({ item, capacity }: { item: ShoppingItem; capacity: number | null }) {
  const [open, setOpen] = useState(false);
  const pct = item.required > 0 ? Math.min(1, item.provided / item.required) : 1;
  const sources = item.best ? [item.best, ...item.alternatives] : [];
  // What a seller is asked for is what is left to BUY, not what the depot
  // wants: the "is it short?" mark must not turn red over tonnage already
  // sitting in the commander's own carrier.
  const need = item.toBuy;
  return (
    <li className="arc-item">
      <button
        className="arc-item-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={`${item.name}: ${item.provided.toLocaleString('en-US')} of ${item.required.toLocaleString('en-US')} t delivered`}
      >
        <span className="arc-twist">{sources.length ? (open ? '▾' : '▸') : '·'}</span>
        <span className="arc-name">{item.name}</span>
        <span className="arc-need mono">
          {item.bucket === 'deliver'
            ? `${tonsOf(item.deliverNow)} aboard`
            : item.bucket === 'carrier'
              ? `${tonsOf(item.onCarrier)} held`
              : item.bucket === 'done'
                ? 'done'
                : tonsOf(item.toBuy)}
        </span>
        {/* Part-covered: the line still wants 2,542 t and 1,000 of them are
            already on the carrier, so say what it has rather than letting the
            buy figure read as the whole requirement. */}
        {item.onCarrier > 0 && item.bucket !== 'carrier' && item.bucket !== 'done' && (
          <span
            className="arc-onfc"
            title={`${tonsOf(item.onCarrier)} of this is already on your fleet carrier — ${tonsOf(
              item.toBuy,
            )} still to buy of the ${tonsOf(item.remaining)} the site wants`}
          >
            +{tonsOf(item.onCarrier)} held
          </span>
        )}
        {item.trips != null && item.trips > 1 && item.bucket !== 'done' && (
          <span className="arc-trips" title={`${item.trips} full holds at ${capacity} t`}>
            ×{item.trips}
          </span>
        )}
        {item.stop && item.stop.lines > 1 && (
          <span
            className="arc-stop"
            title={`${item.stop.station} also sells ${item.stop.lines - 1} other thing${
              item.stop.lines === 2 ? '' : 's'
            } this build needs — ${tonsOf(item.stop.tons)} from one pad`}
          >
            +{item.stop.lines - 1}
          </span>
        )}
        <span className="arc-bar" aria-hidden>
          <span className="arc-bar-fill" style={{ width: `${Math.round(pct * 100)}%` }} />
        </span>
      </button>
      {open && (
        <ul className="arc-srcs">
          {item.inHold > 0 && (
            <li className="arc-src hold">
              <span className="arc-src-where">In your hold</span>
              <span className="arc-src-sys">{tonsOf(item.inHold)} aboard</span>
              <span className="arc-src-num mono">—</span>
              <span className="arc-src-num mono">{tonsOf(item.deliverNow)} wanted</span>
              <span className="arc-age own">now</span>
            </li>
          )}
          {item.onCarrier > 0 && (
            <li className="arc-src fc">
              <span className="arc-src-where">On your carrier</span>
              <span className="arc-src-sys">{tonsOf(item.onCarrier)} held</span>
              <span className="arc-src-num mono">paid</span>
              <span className="arc-src-num mono">{tonsOf(item.remaining)} wanted</span>
              <span className="arc-age own">yours</span>
            </li>
          )}
          {sources.map((s, i) => (
            <SourceRow key={`${s.station}-${s.system}-${i}`} source={s} need={need} />
          ))}
          {!sources.length && !item.inHold && !item.onCarrier && (
            <li className="arc-none">
              {item.scanned
                ? 'Searched — nobody within range is selling it. Mine or refine it, or widen the search.'
                : 'Not searched yet.'}
            </li>
          )}
          {item.payment > 0 && (
            <li className="arc-pay">
              The site pays {cr(item.payment)}/t{item.best?.price != null && ` · buying at ${cr(item.best.price)}`}
              {item.best?.price != null && (
                <b className={item.payment > item.best.price ? ' good' : ' bad'}>
                  {item.payment > item.best.price
                    ? ` (+${cr(item.payment - item.best.price)}/t)`
                    : ` (${cr(item.best.price - item.payment)}/t out of pocket)`}
                </b>
              )}
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Supercruise distance — inside one system, the whole journey. */
const lsLabel = (n: number | null): string | null =>
  n == null ? null : `${Math.round(n).toLocaleString('en-US')} Ls`;

/** System · Ls · pad, in one line, skipping whatever is not known. */
const whereLine = (system: string, distanceLs: number | null, pad: string | null): string => {
  const bits = [system, lsLabel(distanceLs), padLabel(pad) && `pad ${padLabel(pad)}`];
  return bits.filter(Boolean).join(' · ');
};

/**
 * A site nobody in this cockpit has stood on.
 *
 * The tonnage column is DELIBERATELY EMPTY here. A first-hand depot shows tons
 * outstanding in that position; community data does not carry the figure at
 * all, so the row says what the site is reported to accept and stops. The
 * moment a number appears here the commander will read it as a requirement.
 */
function SiteRow({ site }: { site: SiteListing }) {
  const [open, setOpen] = useState(false);
  const takes = site.commodities.length;
  return (
    <li className="arc-item">
      <button
        className="arc-item-head"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={
          takes
            ? `${site.station} was reported to accept ${takes} commodit${takes === 1 ? 'y' : 'ies'} — how much it still wants is not in community data`
            : `${site.station} — nobody has reported this site's board`
        }
      >
        <span className="arc-twist">{takes ? (open ? '▾' : '▸') : '·'}</span>
        <span className="arc-name">{stationDisplayName(site.station)}</span>
        <span className="arc-takes">
          {takes ? `takes ${takes}` : 'unreported'}
        </span>
        <span className={site.stale ? 'arc-age stale' : 'arc-age'}>{ageLabel(site.ageDays)}</span>
      </button>
      {open && (
        <ul className="arc-srcs">
          <li className="arc-site-where">{whereLine(site.system, site.distanceLs, site.pad)}</li>
          {site.commodities.map((c) => (
            <li className="arc-src" key={c.key}>
              <span className="arc-src-where">{c.name}</span>
              <span className="arc-src-num mono">{c.payment == null ? '—' : `${cr(c.payment)}/t`}</span>
            </li>
          ))}
          <li className="arc-none">
            Accepted here, as the community last read this board. How much it still wants is not
            reported by anyone — only docking there says that.
          </li>
        </ul>
      )}
    </li>
  );
}

/** A site the commander has stood on: first-hand, and it carries tonnage. */
function KnownSiteRow({ depot, active }: { depot: DepotState; active: boolean }) {
  const left = depot.resources.reduce((n, r) => n + r.remaining, 0);
  return (
    <li className="arc-item">
      <div className={active ? 'arc-known here' : 'arc-known'}>
        <span className="arc-twist">{active ? '◆' : '·'}</span>
        <span className="arc-name">{stationDisplayName(depot.station) || 'Construction site'}</span>
        <span className="arc-need mono">
          {depot.complete ? 'complete' : depot.failed ? 'failed' : tonsOf(left)}
        </span>
        <span className="arc-age own">{active ? 'active' : 'you docked here'}</span>
      </div>
      <div className="arc-site-where">
        {depot.system ?? '?'} · {Math.round(depot.progress * 1000) / 10}% built
      </div>
    </li>
  );
}

/**
 * Lead with the hold.
 *
 * "What am I carrying and who around here takes it" is the question a loaded
 * hauler is actually asking, and it is answerable from the sweep the panel has
 * already paid for. A commodity nobody here accepts gets said out loud rather
 * than left as a gap — a blank reads as "not looked".
 */
function HoldBlock({ hold }: { hold: HoldMatch[] }) {
  const taken = hold.filter((h) => h.sites.length);
  const spare = hold.filter((h) => !h.sites.length);
  if (!hold.length) return null;
  return (
    <section className="arc-group">
      <div className="arc-group-head static" style={{ borderBottomColor: 'var(--green)' }}>
        <span className="arc-group-title" style={{ color: 'var(--green)' }}>
          Aboard — who here takes it
        </span>
        <span className="arc-group-count mono">
          {tonsOf(hold.reduce((n, h) => n + h.tons, 0))}
        </span>
      </div>
      <ul className="arc-items">
        {taken.map((h) => (
          <li className="arc-item" key={h.key}>
            <div className="arc-known">
              <span className="arc-twist">·</span>
              <span className="arc-name">{h.name}</span>
              <span className="arc-need mono">{tonsOf(h.tons)} aboard</span>
            </div>
            <ul className="arc-srcs">
              {h.sites.slice(0, 4).map((s, i) => (
                <li className="arc-src" key={`${s.station}-${i}`}>
                  <span className="arc-src-where">{s.station}</span>
                  <span className="arc-src-sys">{whereLine(s.system, s.distanceLs, s.pad)}</span>
                  <span className="arc-src-num mono">
                    {s.payment == null ? '—' : `${cr(s.payment)}/t`}
                  </span>
                  <span className={s.stale ? 'arc-age stale' : 'arc-age'}>{ageLabel(s.ageDays)}</span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {spare.length > 0 && (
        <div className="arc-hint">
          {spare
            .slice(0, 4)
            .map((h) => h.name)
            .join(', ')}
          {spare.length > 4 ? ` and ${spare.length - 4} more` : ''} — no known site here accepts{' '}
          {spare.length === 1 ? 'it' : 'them'}.
        </div>
      )}
    </section>
  );
}

/**
 * The two tiers, side by side and never blurred.
 *
 * Sites the commander has docked at carry tonnage and are marked as their own;
 * sites known only through EDDN carry a commodity list, a price and an age.
 * The visual split is the whole point — reusing the green "you saw it" mark
 * the source rows already use for first-hand knowledge.
 */
function SitesBlock({
  depots,
  activeId,
  roster,
  online,
}: {
  depots: DepotState[];
  activeId: number;
  roster: SiteListing[] | null;
  online: boolean;
}) {
  const [shut, setShut] = useState(false);
  const reported = (roster ?? []).filter((s) => s.commodities.length);
  const quiet = (roster ?? []).filter((s) => !s.commodities.length);
  const count = depots.length + (roster?.length ?? 0);
  return (
    <section className="arc-group">
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: 'var(--cyan)' }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span className="arc-group-title" style={{ color: 'var(--cyan)' }}>
          Construction sites
        </span>
        <span className="arc-group-count mono">{count}</span>
      </button>
      {!shut && (
        <>
          <div className="arc-hint">
            Sites you have docked at keep their tonnage. The rest is community data: what a site is
            reported to accept, never how much it still wants.
          </div>
          <ul className="arc-items">
            {depots.map((d) => (
              <KnownSiteRow key={d.marketId} depot={d} active={d.marketId === activeId} />
            ))}
            {reported.map((s) => (
              <SiteRow key={`${s.station}|${s.system}`} site={s} />
            ))}
          </ul>
          {quiet.length > 0 && (
            <div className="arc-hint">
              {quiet.length} more site{quiet.length === 1 ? '' : 's'} here that nobody has reported
              — the system holds them, but no board has been read.
            </div>
          )}
          {roster == null && (
            <div className="arc-hint">
              {online
                ? 'Sites nearby have not been looked for yet — rescan to sweep the system.'
                : 'Community data is off, so only the sites you have docked at are known.'}
            </div>
          )}
          {roster != null && !roster.length && (
            <div className="arc-hint">
              Swept — no construction sites here beyond the ones you have already docked at.
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The next load, as a loading manifest rather than a shopping list.
 *
 * The tree answers "what does the build want". This answers the question asked
 * at the pad, which is different and much narrower: what do I put in THIS hold,
 * at THIS station, right now. Seventeen lines and a 784 t hull do not divide
 * neatly, and the commander was doing this arithmetic on a notepad.
 */
function NextLoad({ trip, reach }: { trip: TripPlan; reach: ReachEstimate | null }) {
  const [shut, setShut] = useState(false);
  const shuttle = trip.source === 'carrier';
  const jumps = jumpsFor(trip.distanceLy, reach);
  const colour = shuttle ? 'var(--phos)' : 'var(--green)';
  return (
    <section className="arc-group arc-load">
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: colour }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span className="arc-group-title" style={{ color: colour }}>
          {shuttle ? 'Next load — off your carrier' : 'Next load'}
        </span>
        <span className="arc-group-count mono">
          {tonsOf(trip.tons)} / {tonsOf(trip.capacity)}
        </span>
      </button>
      {!shut && (
        <>
          <div className="arc-hint">
            {shuttle
              ? `${trip.station} is parked here. Transfer to the ship and fly it over — no market, no credits.`
              : `${trip.station}${trip.inSystem ? '' : ` · ${trip.system}`}${
                  trip.inSystem
                    ? trip.distanceLs != null
                      ? ` · ${Math.round(trip.distanceLs).toLocaleString('en-US')} Ls`
                      : ' · in system'
                    : trip.distanceLy != null
                      ? ` · ${Math.round(trip.distanceLy).toLocaleString('en-US')} ly${
                          jumps != null ? ` · ${jumps} jump${jumps === 1 ? '' : 's'}` : ''
                        }`
                      : ''
                }${padLabel(trip.pad) ? ` · pad ${padLabel(trip.pad)}` : ''}`}
          </div>
          <ul className="arc-items">
            {trip.lines.map((l) => (
              <li className="arc-item" key={l.key}>
                <div className="arc-known">
                  <span className="arc-twist">{l.closes ? '◆' : '·'}</span>
                  <span className="arc-name">{l.name}</span>
                  <span className="arc-need mono">{tonsOf(l.tons)}</span>
                  <span className={l.closes ? 'arc-age own' : 'arc-age'}>
                    {l.closes ? 'closes the line' : l.price != null ? `${cr(l.price)}/t` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="arc-hint">
            {trip.cost != null && trip.cost > 0 && (
              <>
                {cr(trip.cost)} for the load
                {trip.costPartial && ' (at least — one line had no price)'}.{' '}
              </>
            )}
            {trip.moreHere > 0
              ? `${tonsOf(trip.moreHere)} more here after this one — ${trip.loadsHere} full ${
                  trip.loadsHere === 1 ? 'load' : 'loads'
                } from this stop.`
              : 'This clears everything this stop can give you.'}
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The carrier as a warehouse, and what it cannot account for.
 *
 * `unaccountedTons` is shown rather than swallowed. The game states a
 * carrier's total cargo and refuses to name it, so a hold loaded before this
 * panel existed reads as thousands of tons the ledger cannot see — and a
 * commander told that goes and looks, while a commander shown a confident
 * short list does not.
 */
function CarrierBlock({
  carrier,
}: {
  carrier: NonNullable<ArchitectView['carrier']>;
}) {
  const [shut, setShut] = useState(true);
  const { hold, coverage } = carrier;
  const unknown = hold.unaccountedTons;
  return (
    <section className="arc-group">
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: 'var(--phos)' }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span className="arc-group-title" style={{ color: 'var(--phos)' }}>
          {hold.callsign ?? 'Your carrier'}
          {carrier.atBuild ? ' — parked here' : hold.system ? ` — ${hold.system}` : ''}
        </span>
        <span className="arc-group-count mono">{tonsOf(hold.namedTons)}</span>
      </button>
      {!shut && (
        <>
          <div className="arc-hint">
            {coverage.lines > 0
              ? `Covers ${coverage.lines} of ${coverage.ofLines} outstanding lines — ${tonsOf(
                  coverage.tons,
                )} of this build already bought.${
                  carrier.atBuild ? '' : ' Jump it here before buying any of that again.'
                }`
              : 'Nothing aboard is on this build’s list.'}
          </div>
          <ul className="arc-items">
            {hold.items.slice(0, 12).map((i) => (
              <li className="arc-item" key={i.key}>
                <div className="arc-known">
                  <span className="arc-twist">·</span>
                  <span className="arc-name">{i.name}</span>
                  <span className="arc-need mono">{tonsOf(i.tons)}</span>
                  <span
                    className={i.basis === 'market' ? 'arc-age own' : 'arc-age'}
                    title={
                      i.basis === 'market'
                        ? 'Read off the carrier’s own board'
                        : 'Summed from transfers — the game never states a carrier’s manifest'
                    }
                  >
                    {i.basis === 'market' ? 'read' : 'tallied'}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          {unknown != null && unknown > 0 && (
            <div className="arc-hint">
              The game reports {tonsOf(hold.reportedTons ?? 0)} aboard and names{' '}
              {tonsOf(hold.namedTons)} of it. The other {tonsOf(unknown)} was loaded where I could not
              see it — dock at the carrier and open its board to have it counted.
            </div>
          )}
          {unknown != null && unknown < 0 && (
            <div className="arc-warn soft">
              My tally is {tonsOf(-unknown)} above what the game says is aboard — something moved off
              the carrier while I was not running. Open its board to reset the count.
            </div>
          )}
          {!hold.items.length && (
            <div className="arc-hint">
              Nothing counted yet. Transfers to and from the carrier are tallied as they happen, and
              docking at it to read its board is what makes the figures exact.
            </div>
          )}
        </>
      )}
    </section>
  );
}

/**
 * The list at the pad, ticking off as the hold fills.
 *
 * The commodities market shows one commodity at a time, a 1,302 t hold does not
 * take a 2,462 t stop in one go, and the commander was holding the difference
 * in their head across two trips. Bought and still-to-buy come from different
 * places — the purchase log and the live requirement — so they always add up
 * and neither double-counts the other.
 */
function Basket({ basket }: { basket: BasketView }) {
  const pct = basket.wanted > 0 ? basket.bought / basket.wanted : 0;
  return (
    <section className="arc-group arc-basket">
      <div className="arc-group-head static" style={{ borderBottomColor: 'var(--green)' }}>
        <span className="arc-group-title" style={{ color: 'var(--green)' }}>
          {basket.complete ? `${basket.station} — done` : `Buying at ${basket.station}`}
        </span>
        <span className="arc-group-count mono">
          {tonsOf(basket.bought)} / {tonsOf(basket.wanted)}
        </span>
      </div>
      <div className="arc-progress-bar" aria-hidden>
        <span style={{ width: `${Math.round(pct * 100)}%`, background: 'var(--green)' }} />
      </div>
      <ul className="arc-items">
        {basket.lines.map((l) => (
          <li className="arc-item" key={l.key}>
            <div className={l.done ? 'arc-known done' : 'arc-known'}>
              <span className="arc-twist">{l.done ? '✓' : '·'}</span>
              <span className="arc-name">{l.name}</span>
              <span className="arc-need mono">{l.done ? 'done' : `${tonsOf(l.left)} to buy`}</span>
              <span className={l.done ? 'arc-age own' : 'arc-age'}>
                {l.bought > 0 ? `${tonsOf(l.bought)} in` : ''}
              </span>
            </div>
            {/* Why a line is smaller than the build's total: the tons are
                bought already and sitting on the carrier. */}
            {l.onCarrier > 0 && (
              <div className="arc-site-where">
                {tonsOf(l.onCarrier)} of this is already on your carrier — not counted above.
              </div>
            )}
          </li>
        ))}
      </ul>
      <div className="arc-hint">
        {basket.complete
          ? 'Everything this stop can give you is bought. Next stop is in the run below.'
          : `${tonsOf(basket.left)} still to buy here.`}
        {basket.onCarrier > 0 && ` ${tonsOf(basket.onCarrier)} of these lines is already on your carrier.`}
      </div>
    </section>
  );
}

/**
 * The cart: every outstanding line, and where each ton of it currently is.
 *
 * A deep-space build is GATHERED before it is delivered — bought across several
 * stations, transferred to the carrier a load at a time, and only worth jumping
 * 464 ly once the carrier holds the lot. A carrier taken one commodity short is
 * a carrier that has to come back.
 *
 * So this is the end-of-evening view: what is aboard, what is in the ship, and
 * what nobody has yet.
 */
function CartBlock({ cart, line, carrier }: { cart: CartView; line: string | null; carrier: string | null }) {
  const [shut, setShut] = useState(false);
  if (!cart.ofLines) return null;
  const got = cart.needed > 0 ? (cart.onCarrier + cart.inHold) / cart.needed : 0;
  return (
    <section className={cart.complete ? 'arc-group arc-cart full' : 'arc-group arc-cart'}>
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: cart.complete ? 'var(--green)' : 'var(--phos)' }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span
          className="arc-group-title"
          style={{ color: cart.complete ? 'var(--green)' : 'var(--phos)' }}
        >
          {cart.complete ? `${carrier ?? 'Your carrier'} — everything aboard` : `Gathering on ${carrier ?? 'your carrier'}`}
        </span>
        <span className="arc-group-count mono">
          {cart.linesDone}/{cart.ofLines}
        </span>
      </button>
      {!shut && (
        <>
          <div className="arc-progress-bar" aria-hidden>
            <span
              style={{
                width: `${Math.round(got * 100)}%`,
                background: cart.complete ? 'var(--green)' : 'var(--phos)',
              }}
            />
          </div>
          {line && <div className={cart.complete ? 'arc-hint good' : 'arc-hint'}>{line}</div>}
          <ul className="arc-items">
            {cart.lines.map((l) => (
              <li className="arc-item" key={l.key}>
                <div className={l.done ? 'arc-known done' : 'arc-known'}>
                  <span className="arc-twist">{l.done ? '✓' : '·'}</span>
                  <span className="arc-name">{l.name}</span>
                  <span className="arc-need mono">
                    {l.done ? 'gathered' : `${tonsOf(l.missing)} to buy`}
                  </span>
                  <span className="arc-age own">
                    {l.onCarrier > 0 ? `${tonsOf(l.onCarrier)} aboard` : ''}
                    {l.inHold > 0 ? `${l.onCarrier > 0 ? ' · ' : ''}${tonsOf(l.inHold)} in ship` : ''}
                  </span>
                </div>
              </li>
            ))}
          </ul>
          <div className="arc-hint">
            {tonsOf(cart.onCarrier)} on the carrier, {tonsOf(cart.inHold)} in the ship,{' '}
            {tonsOf(cart.missing)} still to buy — of {tonsOf(cart.needed)} the build wants.
          </div>
        </>
      )}
    </section>
  );
}

/**
 * The whole run, by stop.
 *
 * The tree answers "where do I get titanium", seventeen times over, and the
 * commander was opening every line in turn and holding the overlaps in their
 * head. This is the same data asked the other way round: every station, with
 * everything it can sell this build in one visit. Gustard Watch covering
 * fourteen of the seventeen lines is a fact the per-commodity view contains
 * and never states.
 */
function ShoppingRun({ stops, capacity }: { stops: StopPlan[]; capacity: number | null }) {
  const [shut, setShut] = useState(false);
  const [open, setOpen] = useState<string | null>(stops[0] ? `${stops[0].station}|${stops[0].system}` : null);
  if (!stops.length) return null;
  const tons = stops[0].tons;
  return (
    <section className="arc-group">
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: 'var(--cyan)' }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span className="arc-group-title" style={{ color: 'var(--cyan)' }}>
          The shopping run — by stop
        </span>
        <span className="arc-group-count mono">{stops.length}</span>
      </button>
      {!shut && (
        <>
          <div className="arc-hint">
            Every station that sells this build anything, and everything it sells in ONE visit —
            the top stop clears {tons.toLocaleString('en-US')} t of what is left.
          </div>
          <ul className="arc-items">
            {stops.map((s) => {
              const id = `${s.station}|${s.system}`;
              const shown = open === id;
              return (
                <li className="arc-item" key={id}>
                  <button
                    className="arc-item-head"
                    aria-expanded={shown}
                    onClick={() => setOpen(shown ? null : id)}
                    title={`${s.station} sells ${s.lines.length} of what this build still needs`}
                  >
                    <span className="arc-twist">{shown ? '▾' : '▸'}</span>
                    <span className="arc-name">
                      {s.station}
                      {s.carrier && <span className="arc-chip">carrier</span>}
                      {padLabel(s.pad) && <span className="arc-chip">pad {padLabel(s.pad)}</span>}
                    </span>
                    <span className="arc-need mono">{tonsOf(s.tons)}</span>
                    <span className="arc-trips" title={`${s.lines.length} of the outstanding lines`}>
                      {s.lines.length} lines
                    </span>
                    {s.loads != null && s.loads > 1 && (
                      <span className="arc-trips" title={`${s.loads} full holds at ${capacity} t`}>
                        ×{s.loads}
                      </span>
                    )}
                    <span className="arc-bar" aria-hidden>
                      <span className="arc-bar-fill" style={{ width: `${Math.round(s.share * 100)}%` }} />
                    </span>
                  </button>
                  {shown && (
                    <ul className="arc-srcs">
                      <li className="arc-site-where">
                        <SystemName
                          system={s.system}
                          leg={
                            s.inSystem
                              ? 'in system'
                              : s.distanceLy == null
                                ? 'distance unknown'
                                : `${Math.round(s.distanceLy).toLocaleString('en-US')} ly${
                                    s.jumps ? ` · ${s.jumps} jump${s.jumps === 1 ? '' : 's'}` : ''
                                  }`
                          }
                        />
                      </li>
                      {s.lines.map((l) => (
                        <li className="arc-src" key={l.key}>
                          <span className="arc-src-where">{l.name}</span>
                          <span className="arc-src-sys">{l.price != null ? `${cr(l.price)}/t` : 'price unknown'}</span>
                          <span className={l.short ? 'arc-src-num mono short' : 'arc-src-num mono'}>
                            {tonsOf(l.tons)}
                          </span>
                        </li>
                      ))}
                      <li className="arc-none">
                        {s.cost != null && `${cr(s.cost)} for the lot. `}
                        Covers {Math.round(s.share * 100)}% of everything still to buy
                        {s.lines.some((l) => l.short) && ' — the short lines need a second source'}.
                      </li>
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}

/**
 * The price list — what a facility costs BEFORE you place it.
 *
 * Everything else in this panel is about a build that already exists. This is
 * the one block that is useful the evening before: an Orbis is 209,122 t and a
 * Coriolis is 53,723 t, and the way most commanders find that out is by
 * committing to one and then hauling for a fortnight.
 *
 * Where the commander has actually built something of a given cost, the row
 * opens to the real commodity list they read off its panel. Where they have
 * not, it says so. Nobody publishes those breakdowns, so an invented one would
 * be the only untrustworthy number in the panel.
 */
function Catalogue({ learned, activeTons }: { learned: LearnedBuild[]; activeTons: number }) {
  const [shut, setShut] = useState(true);
  const [slot, setSlot] = useState<'space' | 'ground'>('space');
  const known = new Map(learned.map((l) => [l.tons, l]));
  const rows = ALL_BUILD_TYPES.filter((t) => t.slot === slot).sort((a, b) => b.tons - a.tons);
  return (
    <section className="arc-group">
      <button
        className="arc-group-head"
        aria-expanded={!shut}
        onClick={() => setShut((v) => !v)}
        style={{ borderBottomColor: 'var(--amber)' }}
      >
        <span className="arc-twist">{shut ? '▸' : '▾'}</span>
        <span className="arc-group-title" style={{ color: 'var(--amber)' }}>
          What things cost
        </span>
        <span className="arc-group-count mono">{ALL_BUILD_TYPES.length}</span>
      </button>
      {!shut && (
        <>
          <div className="arc-slots">
            {(['space', 'ground'] as const).map((s) => (
              <button
                key={s}
                className={slot === s ? 'arc-slot on' : 'arc-slot'}
                onClick={() => setSlot(s)}
              >
                {s === 'space' ? 'Orbital' : 'Ground'}
              </button>
            ))}
          </div>
          <div className="arc-hint">
            Total tonnage and tier points per facility. A row opens to the real
            commodity list only where you have built one — nobody publishes the
            breakdowns, so the rest are left blank rather than guessed.
          </div>
          <ul className="arc-items">
            {rows.map((t) => (
              <CatalogueRow
                key={t.key}
                type={t}
                learned={known.get(t.tons) ?? null}
                active={t.tons === activeTons || t.primaryTons === activeTons}
              />
            ))}
          </ul>
        </>
      )}
    </section>
  );
}

function CatalogueRow({
  type,
  learned,
  active,
}: {
  type: BuildType;
  learned: LearnedBuild | null;
  active: boolean;
}) {
  const [open, setOpen] = useState(false);
  const effects: Array<[string, number]> = [
    ['population', type.effects.maxPopulation],
    ['security', type.effects.security],
    ['tech', type.effects.techLevel],
    ['wealth', type.effects.wealth],
    ['living', type.effects.standardOfLiving],
    ['development', type.effects.developmentLevel],
  ];
  return (
    <li className="arc-item">
      <button className="arc-item-head" aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        <span className="arc-twist">{open ? '▾' : '▸'}</span>
        <span className="arc-name">
          {type.name}
          {active && <span className="arc-chip">building</span>}
        </span>
        <span className="arc-need mono">{tonsOf(type.tons)}</span>
        <span className="arc-age">{describePoints(type)}</span>
      </button>
      {open && (
        <ul className="arc-srcs">
          {type.primaryTons != null && (
            <li className="arc-site-where">
              As the system’s first station: {tonsOf(type.primaryTons)}.
            </li>
          )}
          <li className="arc-site-where">
            {effects
              .filter(([, v]) => v !== 0)
              .map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`)
              .join(' · ') || 'No effect on the system’s figures.'}
            {` · ${type.effects.systemScore} system points`}
          </li>
          {type.dependencies.length > 0 && (
            <li className="arc-none">
              Needs one of these standing first:{' '}
              {type.dependencies.map((d) => (BUILD_TYPES[d]?.name ?? d)).join(', ')}.
            </li>
          )}
          {learned ? (
            <>
              {learned.lines
                .slice()
                .sort((a, b) => b.required - a.required)
                .slice(0, 20)
                .map((l) => (
                  <li className="arc-src" key={l.key}>
                    <span className="arc-src-where">{l.name}</span>
                    <span className="arc-src-num mono">{tonsOf(l.required)}</span>
                  </li>
                ))}
              <li className="arc-none">
                Read off {learned.station ?? 'a site'}
                {learned.system ? ` in ${learned.system}` : ''} — your own figures, not anybody’s
                table.
              </li>
            </>
          ) : (
            <li className="arc-none">
              You have not built one, so the commodity split is unknown. Dock at one and open its
              contribution panel and it will be remembered here.
            </li>
          )}
        </ul>
      )}
    </li>
  );
}

/** Minutes-scale freshness — a market scan ages in minutes, not days. */
const scanAge = (at: number | null, nowMs: number): string => {
  if (at == null) return 'Not scanned yet.';
  const mins = Math.floor((nowMs - at) / 60_000);
  return mins < 1 ? 'Scanned just now' : mins === 1 ? 'Scanned a minute ago' : `Scanned ${mins} min ago`;
};

export function ArchitectCard({
  view,
  nowMs,
  onScan,
  onToggleStationsOnly,
}: {
  view: ArchitectView;
  nowMs: number;
  onScan: () => void;
  onToggleStationsOnly: () => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<Bucket>>(new Set(['done']));
  const toggle = (b: Bucket) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(b)) next.delete(b);
      else next.add(b);
      return next;
    });
  const { depot } = view;
  const pct = Math.round(depot.progress * 1000) / 10;
  const built = view.totalRequired > 0 ? 1 - view.totalRemaining / view.totalRequired : 0;

  return (
    <div className="card arc-card">
      <div className="arc-head">
        <div className="arc-title" title={depot.station ?? undefined}>
          🏗 {stationDisplayName(depot.station) || 'Construction site'}
        </div>
        <div className="arc-sub">
          {depot.system ? <SystemName system={depot.system} /> : '?'}
          {view.atSite ? ' · docked here' : ''}
        </div>
        {/* What the site IS. The game never says; the total tonnage does. */}
        {view.build && (
          <div
            className="arc-what"
            title={
              view.build.types.length > 1
                ? `${tonsOf(view.build.tons)} is the cost of ${view.build.types.length} different facilities, so this is as far as the tonnage can narrow it.`
                : undefined
            }
          >
            {view.build.primary && <span className="arc-chip">first station</span>}
            {view.build.types.map((t) => t.name).join(' / ')}
            <span className="arc-what-pts">{buildPoints(view.build)}</span>
          </div>
        )}
      </div>

      <div className="arc-progress">
        <div className="arc-progress-bar" aria-hidden>
          <span style={{ width: `${Math.round(built * 100)}%` }} />
        </div>
        <div className="arc-progress-line">
          <span>
            <b className="mono">{tonsOf(view.totalRemaining)}</b> still wanted of{' '}
            {tonsOf(view.totalRequired)}
          </span>
          <span className="arc-pct mono">{pct}% built</span>
        </div>
        {/* The horizon. Measured between deliveries, so an overnight gap does
            not turn 1,400 t/hr of hauling into 90. */}
        {view.clockLine && (
          <div className="arc-clock" title={`${view.clock.runs} deliveries recorded at this site`}>
            {view.clockLine}
          </div>
        )}
        {/* Carrier stock changes the denominator of the whole job. */}
        {view.carrier && view.carrier.coverage.lines > 0 && (
          <div className="arc-clock own">
            {tonsOf(view.carrier.coverage.tons)} of that is already on{' '}
            {view.carrier.hold.callsign ?? 'your carrier'}
            {view.carrier.atBuild ? ', parked here' : ''} — {tonsOf(view.carrier.coverage.toBuy)} left
            to buy.
          </div>
        )}
      </div>

      {view.basket && <Basket basket={view.basket} />}

      {view.trip && <NextLoad trip={view.trip} reach={view.reach} />}

      <ShoppingRun stops={view.stops} capacity={view.cargoCapacity} />

      {view.carrier && (
        <CartBlock cart={view.cart} line={view.cartLine} carrier={view.carrier.hold.callsign} />
      )}

      <HoldBlock hold={view.hold} />

      <div className="arc-tools">
        <button className="arc-scan" disabled={view.scanning || !view.online} onClick={onScan}>
          {view.scanning ? 'Scanning…' : 'Rescan markets'}
        </button>
        {/* A carrier is not a supplier: it moves, it sells out, and its owner
            may refuse the dock. Over a build measured in days a permanent
            station is worth more than a price. Their OWN carrier stays. */}
        <button
          className={view.stationsOnly ? 'arc-slot on' : 'arc-slot'}
          title={
            view.stationsOnly
              ? 'Other commanders’ fleet carriers are hidden — they move, sell out and can refuse the dock. Your own carrier is always shown.'
              : 'Fleet carriers are included. They are often nearest and cheapest, and often gone by the time you arrive.'
          }
          onClick={onToggleStationsOnly}
        >
          {view.stationsOnly ? 'Stations only' : 'Carriers shown'}
        </button>
        <span className="arc-scan-note">
          {!view.online
            ? 'Community data is off — the tree can only see the market you are docked at.'
            : view.scanning
              ? 'Asking where each commodity is sold…'
              : scanAge(view.scannedAt, nowMs)}
        </span>
      </div>
      {view.scanError && <div className="arc-warn soft">{view.scanError}</div>}

      <div className="arc-tree">
        {view.groups.map((g) => {
          const shut = collapsed.has(g.bucket);
          return (
            <section key={g.bucket} className="arc-group">
              <button
                className="arc-group-head"
                aria-expanded={!shut}
                onClick={() => toggle(g.bucket)}
                style={{ borderBottomColor: bucketColour[g.bucket] }}
              >
                <span className="arc-twist">{shut ? '▸' : '▾'}</span>
                <span className="arc-group-title" style={{ color: bucketColour[g.bucket] }}>
                  {g.title}
                </span>
                <span className="arc-group-count mono">
                  {g.items.length}
                  {g.bucket !== 'done' && ` · ${tonsOf(g.tons)}`}
                </span>
              </button>
              {!shut && (
                <>
                  <div className="arc-hint">{g.hint}</div>
                  <ul className="arc-items">
                    {g.items.map((i) => (
                      <ItemRow key={i.key} item={i} capacity={view.cargoCapacity} />
                    ))}
                  </ul>
                </>
              )}
            </section>
          );
        })}
      </div>

      {view.carrier && <CarrierBlock carrier={view.carrier} />}

      <Catalogue learned={view.learned} activeTons={view.totalRequired} />

      <SitesBlock
        depots={view.depots}
        activeId={depot.marketId}
        roster={view.roster}
        online={view.online}
      />

      <div className="arc-foot">
        {view.cargoCapacity
          ? `Hold ${view.holdUsed ?? 0} / ${view.cargoCapacity} t — ×N is how many full loads a line still needs.`
          : 'Hold size unknown, so no trip counts. Board the hauler and it will fill in.'}
        {/* Where the jump counts come from. A range taken off the outfitting
            screen is the EMPTY one and will flatter every estimate, so which
            figure is in use has to be readable. */}
        {view.reachLine && <> Jumps at {view.reachLine}.</>}
      </div>
    </div>
  );
}
