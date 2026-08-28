/**
 * The Booze Cruise card — the run to Rackham's Peak.
 *
 * Reads like the architect's shopping list on purpose: a goal, a hold, and
 * the number of trips between them. Every figure below came from a market
 * the commander opened or a load they sold, and the panel says how old the
 * price is rather than implying it is live — a stale 270,000 is exactly the
 * number that would send somebody 5,000 ly on a party that already ended.
 */
import type { BoozeView } from './store.ts';
import { BOOZE_SYSTEM } from '../engine/booze.ts';

const cr = (n: number): string => `${Math.round(n).toLocaleString('en-US')} cr`;

/** Big money in the units people actually say. */
function money(n: number): string {
  if (Math.abs(n) >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(2)} bn`;
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  return cr(n);
}

function duration(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return `${h} h ${String(min % 60).padStart(2, '0')} min`;
}

function ageOf(at: number | null, nowMs: number): string {
  if (!at) return 'never read';
  const min = Math.max(0, Math.round((nowMs - at) / 60_000));
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

export function BoozeCard({
  view,
  nowMs,
  onQuickNav,
}: {
  view: BoozeView;
  nowMs: number;
  onQuickNav: () => void;
}) {
  const stale = view.priceSeenAt != null && nowMs - view.priceSeenAt > 6 * 3_600_000;
  return (
    <div className="ship-panel">
      <div className="sp-title mono">🍷 BOOZE CRUISE · Rackham&apos;s Peak</div>

      <div className="booze-row booze-nav">
        <span className="k">Quick nav</span>
        <span className="v mono">{BOOZE_SYSTEM}</span>
        <button className="booze-nav-btn" onClick={onQuickNav} disabled={view.inSystem}>
          {view.inSystem ? 'here' : 'set route'}
        </button>
      </div>

      {/* The one thing everybody wants to know, and an honest version of it. */}
      <div className={`booze-row${view.state === 'holiday' ? ' party' : ''}`}>
        <span className="k">
          {view.state === 'holiday'
            ? 'THE PARTY IS ON'
            : view.state === 'quiet'
              ? 'Peak is quiet'
              : 'Nobody has looked yet'}
        </span>
        <span className="v mono">{view.sellPerT != null ? `${cr(view.sellPerT)}/t` : '—'}</span>
      </div>
      <div className="empty-hint">
        {view.state === 'unknown'
          ? 'No wine price read at the peak yet. Dock there — or have somebody who has — and this fills in.'
          : `price read ${ageOf(view.priceSeenAt, nowMs)}${stale ? ' — old enough to have changed' : ''}`}
      </div>

      {view.padWarning && <div className="sp-risk">⚠ {view.padWarning}</div>}

      <div className="sp-facts">
        {view.capacityT != null && (
          <span>
            <b>Hold</b> <span className="mono">{view.capacityT} t</span>
          </span>
        )}
        {view.wineAboard > 0 && (
          <span>
            <b>Wine aboard</b> <span className="mono">{view.wineAboard} t</span>
          </span>
        )}
        {view.economics?.netPerRun != null && (
          <span>
            <b>Per run</b> <span className="mono">{money(view.economics.netPerRun)}</span>
          </span>
        )}
        {view.economics?.netPerRun == null && view.economics && (
          <span>
            <b>Per run</b> <span className="mono">{money(view.economics.grossPerRun)} gross</span>
          </span>
        )}
        {view.perHour != null && (
          <span>
            <b>Rate</b> <span className="mono">{money(view.perHour)}/h</span>
          </span>
        )}
      </div>

      {view.source && (
        <div className="booze-row">
          <span className="k">Wine at {view.source.station}</span>
          <span className="v mono">
            {view.source.stock.toLocaleString('en-US')} t @ {cr(view.source.buyPerT)}
          </span>
        </div>
      )}

      {view.runsLeft != null && (
        <div className="booze-row">
          <span className="k">
            Runs to clear it{view.roundTripMs ? ` · ${duration(view.roundTripMs)} a lap` : ''}
          </span>
          <span className="v mono">
            {view.runsLeft}
            {view.etaMs != null ? ` · ${duration(view.etaMs)}` : ''}
          </span>
        </div>
      )}

      {view.tally.runs > 0 && (
        <div className="booze-row">
          <span className="k">
            Delivered · {view.tally.runs} load{view.tally.runs === 1 ? '' : 's'}
          </span>
          <span className="v mono">
            {view.tally.tons.toLocaleString('en-US')} t · {money(view.tally.credits)}
          </span>
        </div>
      )}

      <div className="empty-hint">
        {view.roundTripMs == null && view.tally.runs > 0
          ? 'One more load and the lap time — and the ETA — become measured rather than guessed.'
          : 'The holiday is read from the price at the peak, never from a date. Nothing here predicts when it starts; the community says plainly that it is a bet.'}
      </div>
    </div>
  );
}
