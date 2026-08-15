/**
 * The Death Clock tab — landing windows for the World of Death
 * (Spoihaae XE-X d2-9 A 1). All timing logic lives in engine/deathclock.ts;
 * this card renders the phase for the current second: an orbit strip with the
 * safe arc, the live countdown, the next windows, and calibration.
 */
import { useMemo } from 'react';
import {
  orbitXY,
  phaseOf,
  fmtDur,
  type DeathClockMarkKind,
  type DeathClockState,
  type DeathClockZone,
} from '../engine/deathclock.ts';

const ZONE_COLOR: Record<DeathClockZone, string> = {
  exclusion: 'var(--red)',
  clear: 'var(--amber)',
  board: 'var(--red)',
  jet: '#8a70ff',
};

const ZONE_TITLE: Record<DeathClockZone, string> = {
  exclusion: 'HOLD — EXCLUSION ZONE',
  clear: 'CLEAR TO LAND',
  board: 'BOARD NOW',
  jet: 'HOLD — JET CONE',
};

const ZONE_DETAIL: Record<DeathClockZone, string> = {
  exclusion: 'Too close to the dwarf — you would drop out of supercruise.',
  clear: 'Safe to drop, land and work. Dismiss the ship from the SRV.',
  board: 'Buffer burning — recall, board, and climb out of the cone.',
  jet: 'The planet is inside the jets. Hold off in supercruise.',
};

// Orbit strip geometry: star (focus) right of centre, apoapsis on the left.
const SX = 352;
const SY = 60;
const SCALE = 130;

function svgPt(t: number, period: number): string {
  const p = orbitXY(t, period);
  return `${(SX + p.x * SCALE).toFixed(1)},${(SY + p.y * SCALE).toFixed(1)}`;
}

function arc(from: number, to: number, period: number): string {
  const steps = Math.max(16, Math.round(((to - from) / period) * 240));
  const pts: string[] = [];
  for (let i = 0; i <= steps; i++) pts.push(svgPt(from + ((to - from) * i) / steps, period));
  return pts.join(' ');
}

function clockAt(ms: number): string {
  return new Date(ms).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
}

function ago(ms: number, nowMs: number): string {
  const min = Math.max(0, Math.round((nowMs - ms) / 60_000));
  if (min < 2) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

export function DeathClockCard({
  state,
  nowMs,
  onMark,
}: {
  state: DeathClockState;
  nowMs: number;
  onMark: (kind: DeathClockMarkKind) => void;
}) {
  const phase = phaseOf(state, nowMs);
  const arcs = useMemo(
    () => ({
      burn: arc(0, state.open, state.period),
      clear: arc(state.open, state.close, state.period),
      jet: arc(state.close, state.period, state.period),
    }),
    [state.open, state.close, state.period],
  );
  const planet = phase ? orbitXY(phase.t, state.period) : null;
  const zone = phase?.zone ?? null;
  const color = zone ? ZONE_COLOR[zone] : 'var(--dim)';

  return (
    <div className="card" style={{ borderColor: 'var(--red)' }}>
      <div className="card-title">☠ Death Clock</div>
      <div className="wod-sub">Spoihaae XE-X d2-9 · Planet A 1 · Monde de la Mort</div>

      <div className="wod-dial">
        <svg viewBox="0 0 400 120" role="img" aria-label="Orbit around the white dwarf with the safe landing arc marked">
          <defs>
            <radialGradient id="wodStar">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="35%" stopColor="#cfe9ff" />
              <stop offset="100%" stopColor="rgba(160, 200, 255, 0)" />
            </radialGradient>
          </defs>
          <polyline points={arcs.burn} fill="none" stroke="var(--red)" strokeWidth="2" opacity="0.8" />
          <polyline points={arcs.clear} fill="none" stroke="var(--amber)" strokeWidth="3.2" />
          <polyline points={arcs.jet} fill="none" stroke="#8a70ff" strokeWidth="2" opacity="0.8" />
          <circle cx={SX} cy={SY} r="22" fill="url(#wodStar)" opacity="0.7" />
          <circle cx={SX} cy={SY} r="3" fill="#fff" />
          {planet && (
            <circle
              cx={SX + planet.x * SCALE}
              cy={SY + planet.y * SCALE}
              r="4.5"
              fill="var(--text)"
              stroke="rgba(0,0,0,0.7)"
              strokeWidth="1.5"
            />
          )}
        </svg>
        <div className="wod-legend">
          <span><i style={{ background: 'var(--amber)' }} />Clear to land</span>
          <span><i style={{ background: 'var(--red)' }} />Exclusion</span>
          <span><i style={{ background: '#8a70ff' }} />Jet cone</span>
        </div>
      </div>

      <div
        className={zone === 'board' ? 'wod-status warn' : 'wod-status'}
        style={{ borderColor: color }}
      >
        <div className="wod-state" style={{ color }}>
          {zone ? ZONE_TITLE[zone] : 'NOT CALIBRATED'}
        </div>
        <div className="wod-count mono" style={{ color }}>
          {phase ? fmtDur(phase.countdownS) : '--:--'}
        </div>
        <div className="wod-detail">
          {phase
            ? zone === 'clear'
              ? `${ZONE_DETAIL.clear} Hard close in ${fmtDur(phase.closesInS ?? 0)}.`
              : ZONE_DETAIL[zone!]
            : 'Scan planet A 1 and the clock sets itself from the journal.'}
        </div>
      </div>

      {phase && (
        <>
          <div className="wod-grid">
            <div>
              <div className="k">Leave by</div>
              <div className="v mono">{zone === 'clear' || zone === 'board' ? clockAt(phase.windows[0].leaveByMs) : '—'}</div>
            </div>
            <div>
              <div className="k">Window opens</div>
              <div className="v mono">{clockAt(nowMs + phase.opensInS * 1000)}</div>
            </div>
            <div>
              <div className="k">Window closes</div>
              <div className="v mono">
                {clockAt(phase.inWindow ? nowMs + (phase.closesInS ?? 0) * 1000 : phase.windows[0].closesAtMs)}
              </div>
            </div>
            <div>
              <div className="k">Periapsis</div>
              <div className="v mono">{clockAt(nowMs + phase.periInS * 1000)}</div>
            </div>
          </div>

          <table className="wod-table" aria-label="Upcoming landing windows">
            <thead>
              <tr>
                <th>Opens</th>
                <th>Leave by</th>
                <th>Closes</th>
                <th>In</th>
              </tr>
            </thead>
            <tbody>
              {phase.windows.slice(0, 3).map((w) => (
                <tr key={w.opensAtMs} className={w.startsInS <= 0 ? 'now' : undefined}>
                  <td className="mono">{clockAt(w.opensAtMs)}</td>
                  <td className="mono">{clockAt(w.leaveByMs)}</td>
                  <td className="mono">{clockAt(w.closesAtMs)}</td>
                  <td className="mono">{w.startsInS <= 0 ? 'open now' : fmtDur(w.startsInS)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      <div className="wod-cal">
        {state.calibratedAt != null
          ? `Calibrated from ${state.source === 'scan' ? 'your scan of A 1' : 'a manual mark'} · ${ago(state.calibratedAt, nowMs)}. A fresh scan re-trues it.`
          : 'No fix yet. Scan A 1 with the FSS — or mark an orbital event you can see:'}
      </div>
      <div className="wod-btns">
        <button onClick={() => onMark('peri')} title="The planet is at closest approach right now">
          Mark periapsis
        </button>
        <button onClick={() => onMark('open')} title="The landing window is opening right now">
          Mark window open
        </button>
        <button onClick={() => onMark('apo')} title="The planet is at its farthest right now">
          Mark apoapsis
        </button>
        {state.epochMs != null && (
          <button onClick={() => onMark('clear')} title="Forget the calibration">
            Clear
          </button>
        )}
      </div>
      <div className="wod-hint">
        Rebuy at a carrier in-system first · sell your exo/carto data before descending · board
        only inside a window — night side ≈500 K, day side kills.
      </div>
    </div>
  );
}
