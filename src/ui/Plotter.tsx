/**
 * The Plotter tab — Spansh's neutron highway for the ship, its fleet-carrier
 * planner for the carrier, as a list of waypoints you can paste one at a time.
 *
 * The shape of the card follows the job. A carrier trip is not really a
 * navigation problem, it is a fuel problem: the tritium panel sits ABOVE the
 * waypoints because "can I make it" is the question that decides whether the
 * route gets flown at all. A ship route has no such question, so that panel is
 * simply absent rather than zeroed.
 *
 * All arithmetic lives in engine/plotter.ts; this renders it.
 */
import { useEffect, useRef } from 'react';
import { fmtLy, nextWaypoint, remaining, type PlotKind } from '../engine/plotter.ts';
import { fmtClock, phaseOf, type CarrierPhase } from '../engine/carrierjump.ts';
import type { PlotterView } from './store.ts';

const tons = (n: number): string => `${Math.round(n).toLocaleString('en-US')} t`;

export interface PlotterActions {
  onKind: (k: PlotKind) => void;
  onTarget: (s: string) => void;
  onEfficiency: (n: number) => void;
  onHold: (n: number) => void;
  onPlot: () => void;
  onCopy: (idx: number) => void;
  onClear: () => void;
  onEnableOnline: () => void;
}

/**
 * The two clocks a carrier run is paced by, as one big digital readout.
 *
 * Deliberately the largest thing on the card while it is running: during a long
 * route this is the only number that decides what the commander does for the
 * next quarter of an hour, and the game only shows it on the carrier management
 * panel — not where they are while they mine or scoop.
 */
function JumpClock({ phase }: { phase: CarrierPhase }) {
  if (phase.kind === 'idle') return null;
  const colour =
    phase.kind === 'countdown' ? 'var(--amber)' : phase.kind === 'ready' ? 'var(--green)' : 'var(--cyan)';
  const label =
    phase.kind === 'countdown'
      ? 'JUMPS IN'
      : phase.kind === 'cooldown'
        ? 'NEXT JUMP IN'
        : 'READY TO JUMP';
  return (
    <div className="plot-clock" style={{ borderColor: colour }}>
      <div className="plot-clock-label" style={{ color: colour }}>
        {label}
      </div>
      {phase.kind !== 'ready' && (
        <div className="plot-clock-digits mono" style={{ color: colour }}>
          {fmtClock(phase.secondsLeft)}
        </div>
      )}
      <div className="plot-clock-sub">
        {phase.kind === 'countdown'
          ? `Locked down — jumping to ${phase.system}.`
          : phase.kind === 'cooldown'
            ? 'Cooling down. The carrier will not accept the next hop yet.'
            : 'Plot the next hop whenever you are ready.'}
      </div>
    </div>
  );
}

/** The tritium bill: what the trip costs, what they have, what is missing. */
function TritiumPanel({ view, actions }: { view: PlotterView; actions: PlotterActions }) {
  const t = view.route?.tritium;
  if (!t) return null;
  const short = t.shortfall > 0;
  return (
    <div className={short ? 'plot-fuel short' : 'plot-fuel'}>
      <div className="plot-fuel-row">
        <span className="plot-k">Burn</span>
        <span className="plot-v mono">{tons(t.burn)}</span>
        <span className="plot-k">Depot</span>
        <span className="plot-v mono">{t.inTank ? tons(t.inTank) : '—'}</span>
        <span className="plot-k">In hold</span>
        <label className="plot-hold">
          <input
            type="number"
            min={0}
            max={25000}
            step={100}
            value={view.inHold}
            aria-label="Tritium already in the carrier's cargo hold"
            title="Tritium already in the carrier's hold — the journal never breaks the hold down by commodity, so this one is yours to set."
            onChange={(e) => actions.onHold(Math.max(0, Number(e.target.value) || 0))}
          />
        </label>
      </div>
      <div className="plot-verdict" style={{ color: short ? 'var(--amber)' : 'var(--green)' }}>
        {short ? (
          <>
            Short {tons(t.shortfall)}
            {t.trips != null && t.shipCargo
              ? ` — ${t.trips} run${t.trips === 1 ? '' : 's'} with your ${t.shipCargo} t hold`
              : ''}
          </>
        ) : (
          <>Fuelled for the trip{t.inTank ? ` — the depot alone covers ${tons(t.burn)}` : ''}</>
        )}
      </div>
      {t.overCapacity && (
        <div className="plot-warn">
          ⚠ The whole load will not fit aboard{t.freeSpace != null ? ` (${tons(t.freeSpace)} free)` : ''} — you
          will have to take fuel on during the run.
        </div>
      )}
      {t.restocks.length > 0 && (
        <div className="plot-warn">
          ⛽ Restock en route: {t.restocks.map((r) => `${r.system} (${tons(r.tons)})`).join(', ')}
        </div>
      )}
      {t.miningStops > 0 && short && (
        <div className="plot-note">
          ❄ {t.miningStops} stop{t.miningStops === 1 ? '' : 's'} on this route
          {t.restocks.some((r) => r.pristine) ? ' — some pristine' : ''}: icy rings, so the shortfall can be
          mined instead of bought.
        </div>
      )}
    </div>
  );
}

export function PlotterCard({
  view,
  actions,
  nowMs,
}: {
  view: PlotterView;
  actions: PlotterActions;
  /** Ticks once a second, so the digital clock actually counts. */
  nowMs: number;
}) {
  const { route } = view;
  const listRef = useRef<HTMLDivElement>(null);
  const hereRef = useRef<HTMLDivElement>(null);

  // Long routes are hundreds of rows; the one that matters is where the ship
  // is, so keep it in sight as the trip advances rather than at the top.
  useEffect(() => {
    if (hereRef.current && listRef.current) {
      hereRef.current.scrollIntoView({ block: 'nearest' });
    }
  }, [view.idx, route?.fetchedAt]);

  const left = route ? remaining(route, view.idx) : null;
  const next = route ? nextWaypoint(route, view.idx) : null;
  const target = view.target || view.suggestion || '';

  return (
    <div className="card plot-card">
      <div className="plot-head">
        <span className="card-title">🧭 Plotter</span>
        <span className="plot-kinds" role="group" aria-label="What is being routed">
          <button
            className={view.kind === 'ship' ? 'plot-kind on' : 'plot-kind'}
            aria-pressed={view.kind === 'ship'}
            title="Neutron-highway route for the ship you are flying"
            onClick={() => actions.onKind('ship')}
          >
            SHIP
          </button>
          <button
            className={view.kind === 'carrier' ? 'plot-kind on' : 'plot-kind'}
            aria-pressed={view.kind === 'carrier'}
            title="Fleet-carrier route, jump by jump, with the tritium it costs"
            onClick={() => actions.onKind('carrier')}
          >
            CARRIER
          </button>
        </span>
      </div>

      <div className="plot-from">
        {view.from ? (
          <>
            From <b>{view.from}</b>
            {view.kind === 'ship' && view.shipRange != null && (
              <span className="mono"> · {view.shipRange.toFixed(1)} ly jump range</span>
            )}
            {view.kind === 'carrier' && view.carrier?.callsign && (
              <span className="mono"> · {view.carrier.callsign}</span>
            )}
          </>
        ) : (
          <span className="plot-warn">{view.fromNote ?? 'No starting point yet.'}</span>
        )}
      </div>

      <div className="plot-form">
        <input
          type="text"
          className="plot-target"
          value={view.target}
          placeholder={view.suggestion ? `${view.suggestion} (targeted)` : 'Destination system…'}
          aria-label="Destination system"
          onChange={(e) => actions.onTarget(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !view.busy) actions.onPlot();
          }}
        />
        {view.kind === 'ship' && (
          <select
            className="plot-eff"
            value={view.efficiency}
            aria-label="How far off the direct line the route may wander"
            title="Spansh's efficiency dial: higher stays on the straight line, lower accepts detours for better supercharges."
            onChange={(e) => actions.onEfficiency(Number(e.target.value))}
          >
            <option value={100}>direct</option>
            <option value={60}>balanced</option>
            <option value={30}>scenic</option>
          </select>
        )}
        <button
          className="plot-go"
          disabled={view.busy || !target.trim() || !view.from}
          onClick={() => actions.onPlot()}
        >
          {view.busy ? '…' : 'Plot'}
        </button>
      </div>

      {!view.online && (
        <div className="plot-optin">
          Plotting asks <b>Spansh</b> — it sends the two system names and, for a carrier, its tonnage.
          Nothing else leaves this machine.
          <button className="plot-enable" onClick={() => actions.onEnableOnline()}>
            Turn it on
          </button>
        </div>
      )}

      <JumpClock phase={phaseOf(view.jumpState, nowMs)} />

      {view.busy && <div className="plot-note">Spansh is working — long routes take up to a minute.</div>}
      {view.error && !view.busy && <div className="plot-warn">{view.error}</div>}

      {route && (
        <>
          <div className="plot-summary">
            <b>{route.source}</b> → <b>{route.destination}</b>
            <span className="mono">
              {' '}
              · {fmtLy(route.totalLy)} · {route.totalJumps} jump{route.totalJumps === 1 ? '' : 's'}
            </span>
            {left && (
              <span className="plot-left mono">
                {left.jumps > 0 ? ` · ${left.jumps} left (${fmtLy(left.ly)})` : ' · arrived'}
              </span>
            )}
          </div>

          <TritiumPanel view={view} actions={actions} />

          <div className="plot-list" ref={listRef} role="list" aria-label="Route waypoints">
            {route.waypoints.map((w, i) => {
              const done = i < view.idx;
              const here = i === view.idx;
              const isNext = i === view.idx + 1;
              return (
                <div
                  key={`${i}-${w.system}`}
                  role="listitem"
                  ref={here ? hereRef : undefined}
                  className={`plot-row${done ? ' done' : ''}${here ? ' here' : ''}${isNext ? ' next' : ''}`}
                >
                  <span className="plot-n mono">{here ? '▸' : done ? '✓' : i}</span>
                  <span className="plot-sys">
                    {w.system}
                    {w.neutron && (
                      <span className="plot-tag neutron" title="Neutron star — supercharge the FSD here">
                        ⚡
                      </span>
                    )}
                    {w.icyRing && (
                      <span
                        className={w.pristine ? 'plot-tag icy pristine' : 'plot-tag icy'}
                        title={w.pristine ? 'Pristine icy rings — tritium mining' : 'Icy rings — tritium mining'}
                      >
                        ❄
                      </span>
                    )}
                    {w.restock > 0 && i > 0 && (
                      <span className="plot-tag fuel" title={`Take on ${tons(w.restock)} of tritium here`}>
                        ⛽ {w.restock}
                      </span>
                    )}
                  </span>
                  <span className="plot-cost mono">
                    {i === 0
                      ? 'start'
                      : route.kind === 'carrier'
                        ? `${fmtLy(w.legLy)} · ${tons(w.fuelUsed)}`
                        : `${fmtLy(w.legLy)} · ${w.jumps} jump${w.jumps === 1 ? '' : 's'}`}
                  </span>
                  {i > view.idx && (
                    <button
                      className="hop-copy"
                      title={`Copy "${w.system}"${route.kind === 'carrier' ? ' for the carrier panel' : ' for the galaxy map'}`}
                      aria-label={`Copy ${w.system} to clipboard`}
                      onClick={() => actions.onCopy(i)}
                    >
                      📋
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="plot-btns">
            {next && (
              <button className="plot-next" onClick={() => actions.onCopy(view.idx + 1)}>
                📋 Copy next — {next.system}
              </button>
            )}
            <button onClick={() => actions.onClear()}>Clear route</button>
          </div>
          <div className="plot-hint">
            {route.kind === 'carrier'
              ? 'Carrier management → Jump → paste the system, one hop at a time. Each jump locks the carrier for ~15 minutes.'
              : 'Galaxy map → search → paste. Supercharge at each ⚡ before plotting the next leg.'}
          </div>
        </>
      )}
    </div>
  );
}
