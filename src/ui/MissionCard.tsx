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

/** The World of Death tab: timer to the next window edge, dot green when open. */
export interface ClockTab {
  active: boolean;
  timer: string;
  open: boolean;
  onSelect: () => void;
}

/** The plotter tab: jumps left when a route is running, otherwise just the dial. */
export interface PlotTab {
  active: boolean;
  /** "12 jmp" while following a route, or a live carrier clock like "4:12". */
  label: string;
  /** A route is loaded and still has road ahead. */
  running: boolean;
  /** The carrier is clear to jump — worth catching the eye from any tab. */
  urgent?: boolean;
  onSelect: () => void;
}

/** The construction tab: tons the site is still short of. */
export interface ArchitectTab {
  active: boolean;
  /** Outstanding tonnage, e.g. "6,093t". */
  label: string;
  /** The hold contains something the site is asking for. */
  urgent?: boolean;
  onSelect: () => void;
}

/** The local wire tab: a dot when there are unread stories for this system. */
export interface NewsTab {
  active: boolean;
  count: number;
  onSelect: () => void;
}

/** The orrery tab: how many bodies this system has given up so far. */
export interface OrreryTab {
  active: boolean;
  count: number;
  onSelect: () => void;
}

export function MissionTabs({
  missions,
  selectedId,
  nowMs,
  onSelect,
  clock,
  plot,
  architect,
  news,
  orrery,
}: {
  missions: Mission[];
  selectedId: number | null;
  nowMs: number;
  onSelect: (id: number) => void;
  clock?: ClockTab;
  plot?: PlotTab;
  architect?: ArchitectTab;
  news?: NewsTab;
  orrery?: OrreryTab;
}) {
  if (missions.length <= 1 && !clock && !plot && !architect && !news && !orrery) return null;
  const otherActive =
    clock?.active || plot?.active || architect?.active || news?.active || orrery?.active;
  return (
    <div className="tabs" role="tablist" aria-label="Active missions">
      {missions.map((m, i) => (
        <button
          key={m.id}
          role="tab"
          aria-selected={m.id === selectedId && !otherActive}
          className={m.id === selectedId && !otherActive ? 'tab active' : 'tab'}
          style={{ borderColor: categoryColor(m.category) }}
          title={m.title}
          onClick={() => onSelect(m.id)}
        >
          <span className="tab-dot" style={{ background: categoryColor(m.category) }} />
          {i + 1}
          <span className="tab-timer mono">{countdown(m.expiry, nowMs)}</span>
        </button>
      ))}
      {clock && (
        <button
          role="tab"
          aria-selected={clock.active}
          className={clock.active ? 'tab active' : 'tab'}
          style={{ borderColor: 'var(--red)' }}
          title="World of Death — landing windows (Spoihaae XE-X d2-9 A 1)"
          onClick={clock.onSelect}
        >
          <span className="tab-dot" style={{ background: clock.open ? 'var(--green)' : 'var(--red)' }} />
          ☠
          <span className="tab-timer mono">{clock.timer}</span>
        </button>
      )}
      {plot && (
        <button
          role="tab"
          aria-selected={plot.active}
          className={plot.active ? 'tab active' : 'tab'}
          style={{ borderColor: 'var(--cyan)' }}
          title="Plotter — neutron route for the ship, jump list and tritium for the carrier"
          onClick={plot.onSelect}
        >
          <span
            className="tab-dot"
            style={{ background: plot.urgent ? 'var(--green)' : plot.running ? 'var(--cyan)' : 'var(--dim)' }}
          />
          🧭
          {plot.label && <span className="tab-timer mono">{plot.label}</span>}
        </button>
      )}
      {architect && (
        <button
          role="tab"
          aria-selected={architect.active}
          className={architect.active ? 'tab active' : 'tab'}
          style={{ borderColor: 'var(--amber)' }}
          title="System architect — what the construction site still needs, and where to buy it"
          onClick={architect.onSelect}
        >
          <span
            className="tab-dot"
            style={{ background: architect.urgent ? 'var(--green)' : 'var(--amber)' }}
          />
          🏗
          {architect.label && <span className="tab-timer mono">{architect.label}</span>}
        </button>
      )}
      {news && (
        <button
          role="tab"
          aria-selected={news.active}
          className={news.active ? 'tab active' : 'tab'}
          style={{ borderColor: 'var(--text)' }}
          title="Local wire — fictional news for this system, written from its own faction and station data"
          onClick={news.onSelect}
        >
          <span className="tab-dot" style={{ background: news.count ? 'var(--text)' : 'var(--dim)' }} />
          📰
          {news.count > 0 && <span className="tab-timer mono">{news.count}</span>}
        </button>
      )}
      {orrery && (
        <button
          role="tab"
          aria-selected={orrery.active}
          className={orrery.active ? 'tab active' : 'tab'}
          style={{ borderColor: 'var(--cyan)' }}
          title="Orrery — where this system's bodies are right now, from their scanned orbits"
          onClick={orrery.onSelect}
        >
          <span className="tab-dot" style={{ background: 'var(--cyan)' }} />
          🪐
          <span className="tab-timer mono">{orrery.count}</span>
        </button>
      )}
    </div>
  );
}
