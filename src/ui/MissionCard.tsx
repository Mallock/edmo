/** Active-mission card + synthesized objective checklist (T2.3, T2.4). */
import type { Mission } from '../engine/types.ts';
import { categoryColor, categoryLabel, countdown, credits, expiryMinutes } from './util.ts';

export function MissionCard({
  mission,
  nowMs,
  warnMin,
}: {
  mission: Mission;
  nowMs: number;
  warnMin: number;
}) {
  const color = categoryColor(mission.category);
  const expMin = expiryMinutes(mission.expiry, nowMs);
  const timerClass =
    expMin <= 10 ? 'timer urgent' : expMin <= warnMin ? 'timer warn' : 'timer';
  const dest = mission.destination;

  return (
    <div className="card" style={{ borderColor: color }}>
      <div className="card-badge-row">
        <span className="badge" style={{ background: color }}>
          {categoryLabel(mission)}
        </span>
        {mission.state === 'REDIRECTED' && <span className="badge redirected">REDIRECTED</span>}
        {mission.wing && <span className="badge wing">WING</span>}
      </div>
      <div className="card-title">{mission.title}</div>
      {mission.faction && <div className="card-faction">{mission.faction}</div>}
      <div className="card-dest">
        → {dest ? (dest.station ? `${dest.station} · ${dest.system}` : dest.system) : 'unknown destination'}
      </div>
      <div className="card-meta">
        <span className="mono reward">{credits(mission.reward)}</span>
        {(mission.influence || mission.reputation) && (
          <span className="mono infrep" title="Influence / Reputation gain">
            INF {mission.influence ?? '–'} · REP {mission.reputation ?? '–'}
          </span>
        )}
        <span className={`mono ${timerClass}`}>⏱ {countdown(mission.expiry, nowMs)}</span>
      </div>
      {mission.category === 'Massacre' && mission.killCount != null && mission.killCount > 0 && (
        <div className="cargo">
          <div className="cargo-bar">
            <div
              className="cargo-fill"
              style={{
                width: `${Math.min(100, Math.round((Math.min(mission.killProgress, mission.killCount) / mission.killCount) * 100))}%`,
                background: color,
              }}
            />
          </div>
          <span className="mono cargo-text">
            {Math.min(mission.killProgress, mission.killCount)}/{mission.killCount}{' '}
            {mission.targetType ?? 'kills'} (est.)
            {mission.targetFaction ? ` · ${mission.targetFaction}` : ''}
          </span>
        </div>
      )}
      {mission.cargo && mission.cargo.total > 0 && (
        <div className="cargo">
          <div className="cargo-bar">
            <div
              className="cargo-fill"
              style={{
                width: `${Math.min(100, Math.round((mission.cargo.delivered / mission.cargo.total) * 100))}%`,
                background: color,
              }}
            />
          </div>
          <span className="mono cargo-text">
            {mission.cargo.delivered}/{mission.cargo.total} delivered
            {mission.cargo.collected > mission.cargo.delivered
              ? ` · ${mission.cargo.collected} aboard`
              : ''}
          </span>
        </div>
      )}
      {mission.passengers && (
        <div className="card-extra">
          🧑‍🚀 {mission.passengers.count} {mission.passengers.type}
          {mission.passengers.vip ? ' · VIP' : ''}
          {mission.passengers.wanted ? ' · WANTED' : ''}
        </div>
      )}
      {mission.commodity && !mission.cargo && (
        <div className="card-extra">
          🎁 Bring: {mission.commodity.count} {mission.commodity.localised}
        </div>
      )}
      {mission.target && (
        <div className="card-extra">
          🎯 {mission.target.name} ({mission.target.type})
          {mission.killProgress > 0 ? ` · ${mission.killProgress} kill(s)` : ''}
        </div>
      )}
      {(mission.category === 'Assassinate' || mission.category === 'Massacre') &&
        !mission.redirected &&
        mission.origin?.station && (
          <div className="card-extra handin">
            ↩ Hand-in: {mission.origin.station}
            {mission.origin.system ? ` · ${mission.origin.system}` : ''} (after completion)
          </div>
        )}
      <ul className="steps" aria-label="Objectives">
        {mission.steps.map((s, i) => (
          <li key={i} className={s.done ? 'step done' : 'step'}>
            <span className="step-box">{s.done ? '✓' : ''}</span>
            {s.label}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function MissionTabs({
  missions,
  selectedId,
  nowMs,
  onSelect,
}: {
  missions: Mission[];
  selectedId: number | null;
  nowMs: number;
  onSelect: (id: number) => void;
}) {
  if (missions.length <= 1) return null;
  return (
    <div className="tabs" role="tablist" aria-label="Active missions">
      {missions.map((m, i) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={m.id === selectedId}
          className={m.id === selectedId ? 'tab active' : 'tab'}
          style={{ borderColor: categoryColor(m.category) }}
          title={m.title}
          onClick={() => onSelect(m.id)}
        >
          <span className="tab-dot" style={{ background: categoryColor(m.category) }} />
          {i + 1}
          <span className="tab-timer mono">{countdown(m.expiry, nowMs)}</span>
        </button>
      ))}
    </div>
  );
}
