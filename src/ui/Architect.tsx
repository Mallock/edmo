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
 */
import { useState } from 'react';
import type { ArchitectView } from './store.ts';
import type { Bucket, ShoppingItem, Source } from '../engine/architect.ts';

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

      <div className="arc-foot">
        {view.cargoCapacity
          ? `Hold ${view.holdUsed ?? 0} / ${view.cargoCapacity} t — ×N is how many full loads a line still needs.`
          : 'Hold size unknown, so no trip counts. Board the hauler and it will fill in.'}
      </div>
    </div>
  );
}
