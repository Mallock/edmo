/** HUD root — header, mission carousel, operator feed, chat, footer. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { closeApp, isTauri } from './bridge.ts';
import { core } from './store.ts';
import { MissionCard, MissionTabs } from './MissionCard.tsx';
import { Feed } from './Feed.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { categoryColor, countdown } from './util.ts';
import type { HudShipStatus } from './store.ts';

/** Compact live ship telemetry: fuel gauge + hazard chips (from Status.json). */
function ShipStatusStrip({ status }: { status: HudShipStatus }) {
  const chips: Array<{ label: string; cls: string }> = [];
  if (status.beingInterdicted) chips.push({ label: 'INTERDICTION', cls: 'urgent' });
  if (status.overheating) chips.push({ label: 'OVERHEAT', cls: 'urgent' });
  if (status.inDanger && !status.beingInterdicted) chips.push({ label: 'DANGER', cls: 'warn' });
  if (status.lowFuel) chips.push({ label: 'LOW FUEL', cls: 'warn' });
  if (status.silentRunning) chips.push({ label: 'SILENT', cls: 'info' });
  if (status.legalState) chips.push({ label: status.legalState.toUpperCase(), cls: 'warn' });
  const fuel = status.fuelPct;
  const fuelCls = fuel == null ? '' : fuel < 0.25 ? 'warn' : fuel < 0.5 ? 'mid' : 'ok';
  // Nothing worth a strip when everything is nominal and we lack a fuel reading.
  if (fuel == null && chips.length === 0) return null;
  return (
    <div className="status-strip">
      {fuel != null && (
        <span className={`fuel-gauge ${fuelCls}`} title={`Main fuel ${Math.round(fuel * 100)}%`}>
          <i className="fuel-bar" style={{ width: `${Math.round(fuel * 100)}%` }} />
          <span className="fuel-label mono">⛽ {Math.round(fuel * 100)}%</span>
        </span>
      )}
      {chips.map((c) => (
        <span key={c.label} className={`status-chip ${c.cls}`}>
          {c.label}
        </span>
      ))}
      {status.onFoot && <span className="status-chip info">ON FOOT</span>}
    </div>
  );
}

export function App() {
  const snap = useSyncExternalStore(core.subscribe, core.getSnapshot);
  const [nowMs, setNowMs] = useState(() => Date.now());
  const [question, setQuestion] = useState('');

  useEffect(() => {
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    // In-window shortcuts (SPEC §3.4.4): Esc collapses, Ctrl+Tab cycles.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        core.setCollapsed(true);
      } else if (e.key === 'Tab' && e.ctrlKey) {
        e.preventDefault();
        core.cycleMission(e.shiftKey ? -1 : 1);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const selected = snap.missions.find((m) => m.id === snap.selectedId) ?? null;
  const s = snap.settings;

  const rootStyle = {
    '--hud-alpha': s.hud.opacity,
    fontSize: `${Math.round(14 * s.hud.fontScale)}px`,
  } as React.CSSProperties;

  if (snap.collapsed) {
    const next = snap.missions[0] ?? null;
    return (
      <div className="hud collapsed" style={rootStyle}>
        <div className="bar" data-tauri-drag-region>
          <span className="bar-dot" data-tauri-drag-region style={{ background: next ? categoryColor(next.category) : '#808090' }} />
          <span className="bar-text" data-tauri-drag-region>
            {next ? next.title : 'No active missions'}
          </span>
          {next && (
            <span className="mono bar-timer" data-tauri-drag-region>
              {countdown(next.expiry, nowMs)}
            </span>
          )}
          <button className="icon-btn" aria-label="Expand HUD" onClick={() => core.setCollapsed(false)}>
            ▣
          </button>
        </div>
      </div>
    );
  }

  const send = () => {
    if (snap.lm.busy) return;
    core.ask(question || 'What should I do right now?');
    setQuestion('');
  };

  return (
    <div className="hud" style={rootStyle}>
      <header className="head" data-tauri-drag-region>
        <span className="head-title" data-tauri-drag-region>
          ⬢ MISSION OPERATOR
        </span>
        <span className="head-spacer" data-tauri-drag-region />
        <button className="icon-btn" aria-label="Settings" title="Settings" onClick={() => core.setSettingsOpen(!snap.settingsOpen)}>
          ⚙
        </button>
        <button className="icon-btn" aria-label="Collapse HUD" title="Collapse (Esc)" onClick={() => core.setCollapsed(true)}>
          ▁
        </button>
        {isTauri && (
          <button className="icon-btn" aria-label="Quit" title="Quit" onClick={() => void closeApp()}>
            ✕
          </button>
        )}
      </header>

      {snap.settingsOpen ? (
        <SettingsPanel snap={snap} />
      ) : (
        <>
          <MissionTabs
            missions={snap.missions}
            selectedId={snap.selectedId}
            nowMs={nowMs}
            onSelect={(id) => core.select(id)}
          />
          {selected ? (
            <MissionCard mission={selected} nowMs={nowMs} warnMin={s.journal.expiryWarningMin} />
          ) : (
            <div className="no-mission">
              {snap.journal.ok ? (
                <>
                  <div>No active missions — accept one in-game and it appears here.</div>
                  <div className="empty-actions">
                    Meanwhile:
                    <button onClick={() => void core.fetchRoute(true)} disabled={snap.routeBusy}>
                      🔄 {snap.routeBusy ? 'searching…' : 'trade route'}
                    </button>
                    <button onClick={() => core.tellStory()} disabled={snap.lm.busy}>
                      📖 story
                    </button>
                    <button onClick={() => core.tellSaga()} disabled={snap.lm.busy}>
                      📜 today's episode
                    </button>
                  </div>
                  <div className="empty-hint">
                    <span className="mono">Ctrl+Shift+H</span> asks the operator, any time
                  </div>
                </>
              ) : (
                (snap.journal.error ?? 'Connecting to journal…')
              )}
            </div>
          )}

          {snap.shipStatus && <ShipStatusStrip status={snap.shipStatus} />}

          {snap.trade && (
            <div className="trade-card">
              <div className="trade-head">
                <span className="trade-title">💰 TRADE LEAD</span>
                <span className="mono trade-profit">
                  {snap.trade.profitPerTon.toLocaleString('en-US')} cr/t
                </span>
                <button
                  className="icon-btn"
                  title="Discard this lead"
                  aria-label="Discard trade lead"
                  onClick={() => core.dismissTrade()}
                >
                  ✕
                </button>
              </div>
              <div className="trade-body">
                <b>{snap.trade.commodity}</b> · buy {snap.trade.buy.station} ·{' '}
                {snap.trade.buy.system} @{' '}
                <span className="mono">{snap.trade.buy.price.toLocaleString('en-US')}</span> → sell{' '}
                {snap.trade.sell.station} · {snap.trade.sell.system} @{' '}
                <span className="mono">{snap.trade.sell.price.toLocaleString('en-US')}</span>
                <span className="trade-age">
                  {' '}
                  · seen {Math.max(1, Math.round((nowMs - Date.parse(snap.trade.buy.at)) / 3600_000))}h /{' '}
                  {Math.max(1, Math.round((nowMs - Date.parse(snap.trade.sell.at)) / 3600_000))}h ago
                </span>
              </div>
            </div>
          )}

          {snap.route && (
            <div className="trade-card route-card">
              <div className="trade-head">
                <span className="trade-title route-title">🔄 TRADE ROUTE · SPANSH</span>
                <span className="mono trade-profit route-profit">
                  +{snap.route.totalProfit.toLocaleString('en-US')} cr
                </span>
                <button
                  className="icon-btn"
                  title="Discard this route"
                  aria-label="Discard trade route"
                  onClick={() => core.dismissRoute()}
                >
                  ✕
                </button>
              </div>
              <div className="trade-body">
                {snap.route.hops.map((h, i) => (
                  <div key={i} className={i < snap.routeIdx ? 'hop done' : 'hop'}>
                    <div>
                      {i + 1}. {h.fromStation} → <b>{h.toStation}</b> · {h.toSystem}{' '}
                      <span className="mono">({h.distanceLy} ly)</span> ·{' '}
                      <span className="mono">+{h.totalProfit.toLocaleString('en-US')} cr/trip</span>
                      <span className="trade-age"> · prices {h.marketAgeh}h old</span>
                      {i >= snap.routeIdx && (
                        <button
                          className="hop-copy"
                          title={`Copy "${h.toSystem}" for the galaxy map`}
                          aria-label={`Copy ${h.toSystem} to clipboard`}
                          onClick={() => void core.copyWaypoint(i)}
                        >
                          📋
                        </button>
                      )}
                    </div>
                    {(h.commodities ?? []).map((c) => (
                      <div key={c.name} className="hop-calc mono">
                        {c.amount.toLocaleString('en-US')} t <b>{c.name}</b> · buy{' '}
                        {c.buyPrice.toLocaleString('en-US')} → sell {c.sellPrice.toLocaleString('en-US')} ·{' '}
                        +{c.profitPerTon.toLocaleString('en-US')}/t
                        {c.marginPct !== null ? ` (${c.marginPct.toLocaleString('en-US')}%)` : ''} ={' '}
                        +{c.totalProfit.toLocaleString('en-US')} cr
                      </div>
                    ))}
                  </div>
                ))}
                {snap.routeIdx >= snap.route.hops.length && (
                  <div className="trade-age">Route complete — good business, commander.</div>
                )}
              </div>
            </div>
          )}

          {snap.bio && (
            <div className="trade-card bio-card">
              <div className="trade-head">
                <span className="trade-title bio-title">🧬 EXOBIO LEAD</span>
                <span className="mono trade-profit bio-count">
                  {snap.bio.remaining}/{snap.bio.signals} uncollected
                </span>
                <button
                  className="icon-btn"
                  title="Discard this lead"
                  aria-label="Discard exobiology lead"
                  onClick={() => core.dismissBio()}
                >
                  ✕
                </button>
              </div>
              <div className="trade-body">
                <b>{snap.bio.body}</b>
                {snap.bio.inCurrentSystem ? ' · this system' : ` · ${snap.bio.system}`}
                {snap.bio.genuses.length > 0 && <> · {snap.bio.genuses.slice(0, 3).join(', ')}</>}
                {snap.bio.distanceLs != null && (
                  <span className="trade-age"> · {snap.bio.distanceLs.toLocaleString('en-US')} ls</span>
                )}
              </div>
            </div>
          )}

          {snap.exploreLead && snap.exploreLead.inCurrentSystem && (
            <div className="trade-card explore-card">
              <div className="trade-head">
                <span className="trade-title explore-title">🌍 WORTH MAPPING</span>
                <span className="mono trade-profit explore-value">
                  ~{snap.exploreLead.estValue.toLocaleString('en-US')} cr
                </span>
              </div>
              <div className="trade-body">
                <b>{snap.exploreLead.body}</b> · {snap.exploreLead.planetClass}
                {snap.exploreLead.terraformable ? ' · terraformable' : ''}
                {snap.exploreLead.distanceLs != null && (
                  <span className="trade-age"> · {Math.round(snap.exploreLead.distanceLs).toLocaleString('en-US')} ls</span>
                )}
              </div>
            </div>
          )}

          <Feed entries={snap.feed} />

          <div className="chatbar">
            <input
              type="text"
              value={question}
              placeholder={snap.lm.busy ? 'Operator is thinking…' : 'Ask the operator… (Enter)'}
              disabled={snap.lm.busy}
              aria-label="Ask the AI operator"
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') send();
              }}
            />
            {snap.lm.busy ? (
              <button className="btn" onClick={() => core.cancelAsk()} aria-label="Cancel AI response">
                ■
              </button>
            ) : (
              <button className="btn" onClick={send} aria-label="Send question">
                ➤
              </button>
            )}
            {s.voiceInput.enabled && (
              <button
                className={snap.listening ? 'btn voice listening' : 'btn voice'}
                title="Hold to talk to the operator (or hold Ctrl+Shift+Space)"
                aria-label="Hold to talk"
                onMouseDown={() => core.pttDown()}
                onMouseUp={() => core.pttUp()}
                onMouseLeave={() => core.pttCancel()}
              >
                🎤
              </button>
            )}
            <button
              className="btn voice"
              title="Operator chatter — tell me a story"
              aria-label="Tell a mission story"
              disabled={snap.lm.busy}
              onClick={() => core.tellStory()}
            >
              📖
            </button>
            <button
              className="btn voice"
              title="The Saga — narrate today as a space-opera episode"
              aria-label="Narrate today's saga episode"
              disabled={snap.lm.busy}
              onClick={() => core.tellSaga()}
            >
              📜
            </button>
            <button
              className={snap.routeBusy ? 'btn voice busy' : 'btn voice'}
              title="Find a profitable trade route from here (community data via Spansh)"
              aria-label="Find a trade route"
              disabled={snap.routeBusy}
              onClick={() => void core.fetchRoute(true)}
            >
              🔄
            </button>
            <button
              className={s.voice.enabled ? 'btn voice on' : 'btn voice'}
              title="Toggle voice (Ctrl+Shift+V)"
              aria-label="Toggle voice"
              onClick={() => core.toggleVoice()}
            >
              {s.voice.enabled ? '🔊' : '🔇'}
            </button>
          </div>
        </>
      )}

      <footer className="foot">
        <span>{snap.missions.length} mission{snap.missions.length === 1 ? '' : 's'}</span>
        <span className="pill">
          <i className={snap.journal.ok && snap.journal.gameLive ? 'dot ok' : snap.journal.ok ? 'dot idle' : 'dot bad'} />
          JRNL
        </span>
        <span
          className="pill"
          title={
            snap.lm.activeFit === 'big'
              ? `${snap.lm.activeModel} is likely too big for this machine — pick a smaller model in Settings`
              : (snap.lm.activeModel ?? '')
          }
        >
          <i className={!snap.lm.ok ? 'dot bad' : snap.lm.activeFit === 'big' ? 'dot idle' : 'dot ok'} />
          LM{snap.lm.ok && snap.lm.activeFit === 'big' ? '⚠' : ''}
        </span>
        <span className="pill">
          <i className={s.voice.enabled ? 'dot ok' : 'dot bad'} />
          {s.voice.engine === 'piper' ? 'PIPER' : 'VOICE'}
        </span>
        <span className="foot-loc mono">
          {snap.location.station ? `${snap.location.station} · ` : ''}
          {snap.location.system}
        </span>
      </footer>
    </div>
  );
}
