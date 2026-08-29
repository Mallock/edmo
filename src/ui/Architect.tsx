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

const tons = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;
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
  here: 'var(--cyan)',
  // In-system is nearly as good as here: supercruise, no jump, no route.
  system: 'var(--cyan)',
  nearby: 'var(--amber)',
  unknown: 'var(--red)',
  done: 'var(--dim)',
};

function SourceRow({ source, need }: { source: Source; need: number }) {
  const pad = padLabel(source.pad);
  const short = source.stock != null && source.stock < need;
  return (
    <li className="arc-src">
      <span className="arc-src-where">
        {source.station}
        {source.carrier && <span className="arc-chip">carrier</span>}
        {pad && <span className="arc-chip">pad {pad}</span>}
      </span>
      <span className="arc-src-sys">
        {source.system}
        {source.inSystem
          ? // Inside one system the supercruise leg is the whole journey, and
            // it is not always short — say it rather than implying "next door".
            source.distanceLs != null
            ? ` · ${Math.round(source.distanceLs).toLocaleString('en-US')} Ls`
            : ' · in system'
          : source.distanceLy != null && source.distanceLy > 0
            ? ` · ${Math.round(source.distanceLy)} ly`
            : ''}
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
  const need = item.remaining;
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
          {item.bucket === 'deliver' ? `${tons(item.deliverNow)} aboard` : item.bucket === 'done' ? 'done' : tons(need)}
        </span>
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
            } this build needs — ${tons(item.stop.tons)} from one pad`}
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
              <span className="arc-src-sys">{tons(item.inHold)} aboard</span>
              <span className="arc-src-num mono">—</span>
              <span className="arc-src-num mono">{tons(item.deliverNow)} wanted</span>
              <span className="arc-age own">now</span>
            </li>
          )}
          {sources.map((s, i) => (
            <SourceRow key={`${s.station}-${s.system}-${i}`} source={s} need={need} />
          ))}
          {!sources.length && !item.inHold && (
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
        <span className="arc-name">{site.station}</span>
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
        <span className="arc-name">{depot.station ?? 'Construction site'}</span>
        <span className="arc-need mono">
          {depot.complete ? 'complete' : depot.failed ? 'failed' : tons(left)}
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
          {tons(hold.reduce((n, h) => n + h.tons, 0))}
        </span>
      </div>
      <ul className="arc-items">
        {taken.map((h) => (
          <li className="arc-item" key={h.key}>
            <div className="arc-known">
              <span className="arc-twist">·</span>
              <span className="arc-name">{h.name}</span>
              <span className="arc-need mono">{tons(h.tons)} aboard</span>
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
}: {
  view: ArchitectView;
  nowMs: number;
  onScan: () => void;
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
          🏗 {depot.station ?? 'Construction site'}
        </div>
        <div className="arc-sub">
          {depot.system ?? '?'}
          {view.atSite ? ' · docked here' : ''}
        </div>
      </div>

      <div className="arc-progress">
        <div className="arc-progress-bar" aria-hidden>
          <span style={{ width: `${Math.round(built * 100)}%` }} />
        </div>
        <div className="arc-progress-line">
          <span>
            <b className="mono">{tons(view.totalRemaining)}</b> still wanted of{' '}
            {tons(view.totalRequired)}
          </span>
          <span className="arc-pct mono">{pct}% built</span>
        </div>
      </div>

      <HoldBlock hold={view.hold} />

      <div className="arc-tools">
        <button className="arc-scan" disabled={view.scanning || !view.online} onClick={onScan}>
          {view.scanning ? 'Scanning…' : 'Rescan markets'}
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
                  {g.bucket !== 'done' && ` · ${tons(g.tons)}`}
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
      </div>
    </div>
  );
}
