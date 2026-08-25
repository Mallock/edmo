/** HUD root — header, mission carousel, operator feed, chat, footer. */
import { useEffect, useState, useSyncExternalStore } from 'react';
import { closeApp, isTauri } from './bridge.ts';
import { core } from './store.ts';
import { MissionCard, MissionTabs } from './MissionCard.tsx';
import { DeathClockCard } from './DeathClock.tsx';
import { PlotterCard } from './Plotter.tsx';
import { ArchitectCard } from './Architect.tsx';
import { NewsCard } from './News.tsx';
import { CommsPanel } from './CommsPanel.tsx';
import { OrreryCard } from './Orrery.tsx';
import { fmtDur, phaseOf } from '../engine/deathclock.ts';
import { remaining as plotRemaining } from '../engine/plotter.ts';
import { fmtClock, phaseOf as jumpPhaseOf } from '../engine/carrierjump.ts';
import { Feed } from './Feed.tsx';
import { SettingsPanel } from './SettingsPanel.tsx';
import { categoryColor, countdown } from './util.ts';
import type { HudShipStatus, CampaignHudView } from './store.ts';
import type { ShipPanel } from '../engine/shippanel.ts';

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

/** The campaign spine: who is in the commander's story and how tight their
 *  clock is wound. Renders nothing until something is elected or vowed —
 *  the threads are chosen by the journal (campaign.ts), never invented. */
function CampaignStrip({ campaign }: { campaign: CampaignHudView }) {
  const pips = (clock: number) => '▓'.repeat(clock) + '░'.repeat(Math.max(0, 6 - clock));
  return (
    <div className="status-strip campaign-strip">
      {campaign.pursuer && (
        <span
          className="status-chip warn"
          title="The faction working against you — the clock is how close things are to a head"
        >
          ⚔ {campaign.pursuer.faction} <span className="mono">{pips(campaign.pursuer.clock)}</span>
        </span>
      )}
      {campaign.patron && (
        <span
          className="status-chip info"
          title="The faction you keep helping — the clock builds toward recognition"
        >
          🤝 {campaign.patron.faction} <span className="mono">{pips(campaign.patron.clock)}</span>
        </span>
      )}
      {campaign.vow && (
        <span className="campaign-vow" title="The standing aim, read off what you actually do">
          {campaign.vow}
        </span>
      )}
    </div>
  );
}

/** The ship readout that fills the space when no mission is selected. */
function ShipPanelCard({ panel }: { panel: ShipPanel }) {
  return (
    <div className="ship-panel">
      <div className="sp-title mono">{panel.title}</div>
      {panel.gauges.map((g) => (
        <div className={g.warn ? 'sp-gauge warn' : 'sp-gauge'} key={g.label}>
          <span className="sp-label">{g.label}</span>
          <span className="sp-bar">
            {g.fraction != null && <i style={{ width: `${Math.round(g.fraction * 100)}%` }} />}
          </span>
          <span className="sp-val mono">{g.text}</span>
        </div>
      ))}
      {panel.facts.length > 0 && (
        <div className="sp-facts">
          {panel.facts.map((f) => (
            <span key={f.label}>
              <b>{f.label}</b> <span className="mono">{f.value}</span>
            </span>
          ))}
        </div>
      )}
      {panel.atRisk && <div className="sp-risk">⚠ {panel.atRisk}</div>}
      {panel.hint && <div className="empty-hint">{panel.hint}</div>}
    </div>
  );
}

/** Landing-pad floor in the words a commander uses. */
function padWord(pad: number): string {
  return pad >= 3 ? 'large' : pad === 2 ? 'medium' : 'small';
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
  const dcPhase = snap.deathClock ? phaseOf(snap.deathClock.state, nowMs) : null;
  const clockOpen = snap.view === 'deathclock' && snap.deathClock != null;
  const plotOpen = snap.view === 'plotter';
  const archOpen = snap.view === 'architect' && snap.architect != null;
  const newsOpen = snap.view === 'news' && snap.news != null;
  const orreryOpen = snap.view === 'orrery' && snap.orrery != null;
  const commsOpen = snap.view === 'comms';
  const plotLeft = snap.plotter.route ? plotRemaining(snap.plotter.route, snap.plotter.idx) : null;
  // The carrier clock outranks the jump count on the tab: while a jump is
  // locked down or cooling, that countdown is the number being waited on.
  const jumpPhase = jumpPhaseOf(snap.plotter.jumpState, nowMs);
  const plotTabLabel =
    jumpPhase.kind === 'countdown' || jumpPhase.kind === 'cooldown'
      ? fmtClock(jumpPhase.secondsLeft)
      : plotLeft && plotLeft.jumps > 0
        ? `${plotLeft.jumps} jmp`
        : '';

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
            clock={
              snap.deathClock
                ? {
                    active: clockOpen,
                    timer: dcPhase ? fmtDur(dcPhase.countdownS) : '--:--',
                    open: dcPhase?.inWindow ?? false,
                    onSelect: () => core.setView(clockOpen ? 'missions' : 'deathclock'),
                  }
                : undefined
            }
            plot={{
              active: plotOpen,
              label: plotTabLabel,
              running: (plotLeft?.jumps ?? 0) > 0 || jumpPhase.kind === 'countdown',
              urgent: jumpPhase.kind === 'ready',
              onSelect: () => core.setView(plotOpen ? 'missions' : 'plotter'),
            }}
            news={
              snap.news
                ? {
                    active: newsOpen,
                    count: snap.news.items.length,
                    onSelect: () => core.setView(newsOpen ? 'missions' : 'news'),
                  }
                : undefined
            }
            architect={
              snap.architect
                ? {
                    active: archOpen,
                    // Tons outstanding is the number the whole build is about.
                    label: `${Math.round(snap.architect.totalRemaining).toLocaleString('en-US')}t`,
                    // Something in the hold the site wants — hand it over.
                    urgent: snap.architect.groups.some((g) => g.bucket === 'deliver'),
                    onSelect: () => core.setView(archOpen ? 'missions' : 'architect'),
                  }
                : undefined
            }
            orrery={
              snap.orrery
                ? {
                    active: orreryOpen,
                    count: snap.orrery.bodyCount,
                    onSelect: () => core.setView(orreryOpen ? 'missions' : 'orrery'),
                  }
                : undefined
            }
            comms={
              s.comms.enabled
                ? {
                    active: commsOpen,
                    count: snap.comms.log.length,
                    live: snap.comms.channels.some((c) => c.open),
                    crisis: snap.comms.act === 'CRISIS',
                    onSelect: () => core.setView(commsOpen ? 'missions' : 'comms'),
                  }
                : undefined
            }
          />
          {commsOpen ? (
            <CommsPanel
              view={snap.comms}
              nowMs={nowMs}
              onToggleChannel={(id) => core.toggleCommsChannel(id)}
            />
          ) : orreryOpen && snap.orrery ? (
            <OrreryCard view={snap.orrery} nowMs={nowMs} />
          ) : newsOpen && snap.news ? (
            <NewsCard view={snap.news} nowMs={nowMs} onRefresh={() => void core.refreshNews(true)} />
          ) : archOpen && snap.architect ? (
            <ArchitectCard
              view={snap.architect}
              nowMs={nowMs}
              onScan={() => void core.architectScan()}
            />
          ) : plotOpen ? (
            <PlotterCard
              nowMs={nowMs}
              view={snap.plotter}
              actions={{
                onKind: (k) => core.setPlotKind(k),
                onTarget: (t) => core.setPlotTarget(t),
                onEfficiency: (n) => core.setPlotEfficiency(n),
                onHold: (n) => core.setPlotHold(n),
                onPlot: () => void core.plotRoute(),
                onCopy: (i) => void core.copyPlotWaypoint(i),
                onClear: () => core.clearPlot(),
                onEnableOnline: () => core.enableSpansh(),
              }}
            />
          ) : clockOpen && snap.deathClock ? (
            <DeathClockCard
              state={snap.deathClock.state}
              nowMs={nowMs}
              onMark={(kind) => core.deathClockMark(kind)}
            />
          ) : selected ? (
            <MissionCard mission={selected} nowMs={nowMs} warnMin={s.journal.expiryWarningMin} />
          ) : (
            <div className="no-mission">
              {/* First run: the AI is the one thing that still needs a choice.
                  Offer it as a single button with an honest size, and let the
                  commander dismiss it — everything else works without it. */}
              {snap.aiSetupOffer && (
                <div className="empty-actions" style={{ display: 'block', marginBottom: 10 }}>
                  <div style={{ marginBottom: 6 }}>
                    <b>Set up the AI operator?</b> It talks, tells stories and watches your screen —
                    all on this machine, nothing else to install.
                  </div>
                  <button onClick={() => void core.startAiSetup()} disabled={snap.engineProgress != null}>
                    ⬇ Set up the AI ({snap.aiSetupOffer.gb} GB, one time)
                  </button>
                  <button onClick={() => core.dismissAiSetup()}>Not now</button>
                  {snap.engineProgress && (
                    <div className="empty-hint">
                      {snap.engineProgress.phase} —{' '}
                      {snap.engineProgress.total > 0
                        ? `${Math.round((snap.engineProgress.received / snap.engineProgress.total) * 100)}%`
                        : `${(snap.engineProgress.received / 1e9).toFixed(2)} GB`}
                    </div>
                  )}
                  <div className="empty-hint">
                    Downloads a small runtime plus a model from their official sources. Mission
                    tracking and voice already work without it.
                  </div>
                </div>
              )}
              {snap.journal.ok ? (
                <>
                  {/* The trade-route / story / episode buttons that used to
                      live here are all in the chat bar below, so this was a
                      large panel of nothing. Show the ship instead. */}
                  <ShipPanelCard panel={snap.shipPanel} />
                  <div className="empty-hint">
                    No active missions · <span className="mono">Ctrl+Shift+H</span> asks the operator
                  </div>
                </>
              ) : (
                (snap.journal.error ?? 'Connecting to journal…')
              )}
            </div>
          )}

          {snap.shipStatus && <ShipStatusStrip status={snap.shipStatus} />}

          {snap.campaign && <CampaignStrip campaign={snap.campaign} />}

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

          {snap.tradeRun && snap.tradeRun.legs.length > 0 && (
            <div className="trade-card run-card">
              <div className="trade-head">
                <span className="trade-title run-title">💱 TRADE RUN · {snap.tradeRun.origin.toUpperCase()}</span>
                <span className="mono trade-profit run-profit">
                  +{snap.tradeRun.legs[0].profitPerTrip.toLocaleString('en-US')} cr/trip
                </span>
                <button
                  className="icon-btn"
                  title="Discard this run"
                  aria-label="Discard trade run"
                  onClick={() => core.dismissTradeRun()}
                >
                  ✕
                </button>
              </div>
              <div className="trade-body">
                {snap.tradeRun.legs.slice(0, 3).map((l, i) => (
                  <div key={`${l.commodity}-${l.toStation}`} className="hop">
                    <div className="run-line">
                      {/* One element, so the flex row has exactly two children
                          and the copy button pins right instead of each text
                          node becoming its own column. */}
                      <span>
                        {i + 1}. <b>{l.commodity}</b> → <b>{l.toStation}</b> · {l.toSystem}{' '}
                        <span className="mono">({l.distanceLy} ly)</span> ·{' '}
                        <span className="mono">+{l.profitPerTon.toLocaleString('en-US')}/t</span>
                      </span>
                      <button
                        className="hop-copy"
                        title={`Copy "${l.toSystem}" for the galaxy map`}
                        aria-label={`Copy ${l.toSystem} to clipboard`}
                        onClick={() => void core.copyRunDestination(i)}
                      >
                        📋
                      </button>
                    </div>
                    <div className="hop-calc mono">
                      {l.tons.toLocaleString('en-US')} t · buy {l.buyPrice.toLocaleString('en-US')} at{' '}
                      {l.fromStation} → sell {l.sellPrice.toLocaleString('en-US')} = +
                      {l.profitPerTrip.toLocaleString('en-US')} cr
                      {l.dataAgeH != null && (
                        <span className="trade-age">
                          {' '}
                          · prices {l.dataAgeH < 48 ? `${l.dataAgeH}h` : `${Math.round(l.dataAgeH / 24)}d`} old
                        </span>
                      )}
                    </div>
                  </div>
                ))}
                <div className="trade-age">
                  {padWord(snap.tradeRun.filters.minPad)} pad or better ·{' '}
                  {snap.tradeRun.filters.minVolume.toLocaleString('en-US')} t either side ·{' '}
                  {snap.tradeRun.filters.cargo} t hold · checked {snap.tradeRun.checked} of{' '}
                  {snap.tradeRun.candidates}
                </div>
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
              onClick={() => void core.fetchRoute()}
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
