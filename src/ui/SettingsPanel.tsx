/** Settings drawer — LM Studio, voice, HUD, journal, manual import (T5.6). */
import { useEffect, useState } from 'react';
import type { AppSettings } from './settings.ts';
import { listSystemVoices } from './tts.ts';
import type { AppSnapshot } from './store.ts';
import { core } from './store.ts';
import {
  classifyModel,
  fitLabel,
  isEmbeddingModel,
  recommendationLabel,
  specsLabel,
} from './modelfit.ts';
import { PIPER_VOICE_CATALOG } from './voices.ts';

/** Screen glances are GDI-based; on Linux the section shows as unavailable. */
const IS_LINUX = typeof navigator !== 'undefined' && navigator.userAgent.includes('Linux');

export function SettingsPanel({ snap }: { snap: AppSnapshot }) {
  const s = snap.settings;
  const [voicesTick, setVoicesTick] = useState(0);
  const [importText, setImportText] = useState('');
  const [forgetArmed, setForgetArmed] = useState(false);

  useEffect(() => {
    // System voices load asynchronously (T4.1).
    const bump = () => setVoicesTick((n) => n + 1);
    if (typeof speechSynthesis !== 'undefined') {
      speechSynthesis.addEventListener('voiceschanged', bump);
      return () => speechSynthesis.removeEventListener('voiceschanged', bump);
    }
    return undefined;
  }, []);
  void voicesTick;

  const voices = listSystemVoices(s.voice.localVoicesOnly);
  const set = (next: AppSettings) => core.updateSettings(next);

  return (
    <div className="settings" role="dialog" aria-label="Settings">
      <div className="settings-head">
        <span>SETTINGS</span>
        <button className="icon-btn" aria-label="Close settings" onClick={() => core.setSettingsOpen(false)}>
          ✕
        </button>
      </div>
      <div className="settings-body">
        <section>
          <h3>AI operator — LM Studio</h3>
          <label>
            Endpoint
            <input
              type="text"
              value={s.lm.endpoint}
              onChange={(e) => set({ ...s, lm: { ...s.lm, endpoint: e.target.value } })}
            />
          </label>
          <label>
            Model
            <select
              value={s.lm.model ?? ''}
              onChange={(e) => set({ ...s, lm: { ...s.lm, model: e.target.value || null } })}
            >
              <option value="">auto (first chat model)</option>
              {snap.lm.models.map((id) => {
                const note = isEmbeddingModel(id)
                  ? 'embedding — not for chat'
                  : fitLabel(classifyModel(id, snap.specs));
                return (
                  <option key={id} value={id}>
                    {id}
                    {note ? ` — ${note}` : ''}
                  </option>
                );
              })}
            </select>
          </label>
          {snap.specs && (
            <div className="hint">
              Your machine: {specsLabel(snap.specs)}
              <br />
              {recommendationLabel(snap.specs)}
            </div>
          )}
          {snap.lm.activeFit === 'big' && snap.lm.activeModel && (
            <div className="hint warn-hint">
              ⚠ {snap.lm.activeModel} likely exceeds this machine's memory — expect heavy swapping
              or a failed load. Pick a smaller model above.
            </div>
          )}
          {snap.lm.activeFit === 'cpu' && snap.lm.activeModel && (
            <div className="hint warn-hint">
              ◐ {snap.lm.activeModel} won't fit the GPU alongside the game — it will run on
              CPU/RAM, answer slowly, and compete with ED for cores.
            </div>
          )}
          <div className="row">
            <label>
              Temperature
              <input
                type="number"
                min={0}
                max={1.5}
                step={0.05}
                value={s.lm.temperature}
                onChange={(e) => set({ ...s, lm: { ...s.lm, temperature: Number(e.target.value) } })}
              />
            </label>
            <label>
              Max tokens
              <input
                type="number"
                min={64}
                max={4096}
                step={64}
                value={s.lm.maxTokens}
                onChange={(e) => set({ ...s, lm: { ...s.lm, maxTokens: Number(e.target.value) } })}
              />
            </label>
          </div>
          <div className="hint">
            {snap.lm.ok
              ? `Connected — using ${snap.lm.activeModel ?? '?'}`
              : 'LM Studio unreachable — start its local server and load a model.'}
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.lm.tools}
              onChange={(e) => set({ ...s, lm: { ...s.lm, tools: e.target.checked } })}
            />
            Let the operator use tools (reads your live market, ship, missions & plans routes on demand)
          </label>
          <div className="hint">
            Needs a tool-calling model; auto-falls back to grounded answers otherwise.
          </div>
        </section>

        <section>
          <h3>Voice</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.voice.enabled}
              onChange={(e) => set({ ...s, voice: { ...s.voice, enabled: e.target.checked } })}
            />
            Voice prompts enabled
          </label>
          <label>
            Engine
            <select
              value={s.voice.engine}
              onChange={(e) =>
                set({ ...s, voice: { ...s.voice, engine: e.target.value as 'piper' | 'system' } })
              }
            >
              <option value="piper">
                Piper — bundled local neural voice (Alba, offline{snap.piperOk ? '' : ' — NOT FOUND'})
              </option>
              <option value="system">Windows system voices</option>
            </select>
          </label>
          {s.voice.engine === 'piper' && (
            <>
              <label>
                Piper voice
                <select
                  value={s.voice.piperVoice ?? ''}
                  onChange={(e) =>
                    set({ ...s, voice: { ...s.voice, piperVoice: e.target.value || null } })
                  }
                >
                  <option value="">auto (first installed)</option>
                  {snap.piperVoices.map((name) => {
                    const info = PIPER_VOICE_CATALOG.find((v) => v.name === name);
                    return (
                      <option key={name} value={name}>
                        {info?.label ?? name}
                      </option>
                    );
                  })}
                </select>
              </label>
              {PIPER_VOICE_CATALOG.filter((v) => !snap.piperVoices.includes(v.name)).length > 0 && (
                <div className="voice-catalog">
                  <div className="hint">More offline voices (one-time download, then fully local):</div>
                  {PIPER_VOICE_CATALOG.filter((v) => !snap.piperVoices.includes(v.name)).map((v) => (
                    <div key={v.name} className="voice-row">
                      <span className="voice-label">{v.label}</span>
                      <span className="voice-size mono">{v.sizeMb} MB</span>
                      <button
                        className="btn"
                        disabled={snap.voiceDownloading !== null}
                        onClick={() => void core.downloadVoice(v.repoPath, v.label)}
                      >
                        {snap.voiceDownloading === v.repoPath ? 'Downloading…' : '⬇ Get'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          {s.voice.engine === 'system' && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.voice.localVoicesOnly}
                  onChange={(e) =>
                    set({ ...s, voice: { ...s.voice, localVoicesOnly: e.target.checked } })
                  }
                />
                Local voices only (block cloud “Natural” voices)
              </label>
              <label>
                Voice
                <select
                  value={s.voice.systemVoice ?? ''}
                  onChange={(e) =>
                    set({ ...s, voice: { ...s.voice, systemVoice: e.target.value || null } })
                  }
                >
                  <option value="">auto (first English)</option>
                  {voices.map((v) => (
                    <option key={v.name} value={v.name}>
                      {v.name} {v.localService ? '(local)' : '(CLOUD)'}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={s.voiceInput.enabled}
              onChange={(e) =>
                set({ ...s, voiceInput: { enabled: e.target.checked } })
              }
            />
            Voice input — talk to the operator (push-to-talk)
          </label>
          {s.voiceInput.enabled && (
            <>
              {!snap.sttOk ? (
                <button
                  className="btn"
                  disabled={snap.sttDownloading}
                  onClick={() => void core.downloadStt()}
                >
                  {snap.sttDownloading
                    ? 'Downloading speech recognition…'
                    : '⬇ Get speech recognition (~150 MB, one time)'}
                </button>
              ) : (
                <div className="hint">
                  🎤 Ready. Hold <span className="mono">Ctrl+Shift+Space</span> (works in-game) or
                  the mic button, speak, release. The operator remembers the conversation —
                  follow-up questions work.
                </div>
              )}
              <div className="hint">
                Recognition runs on a local Whisper model — your voice never leaves this machine.
              </div>
            </>
          )}
          <div className="row">
            <label>
              Rate {s.voice.rate.toFixed(2)}
              <input
                type="range"
                min={0.5}
                max={2}
                step={0.05}
                value={s.voice.rate}
                onChange={(e) => set({ ...s, voice: { ...s.voice, rate: Number(e.target.value) } })}
              />
            </label>
            <label>
              Volume {s.voice.volume}
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={s.voice.volume}
                onChange={(e) => set({ ...s, voice: { ...s.voice, volume: Number(e.target.value) } })}
              />
            </label>
          </div>
          <button className="btn" onClick={() => core.testVoice()}>
            Test voice
          </button>
        </section>

        <section>
          <h3>Operator chatter</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.chatter.enabled}
              onChange={(e) => set({ ...s, chatter: { ...s.chatter, enabled: e.target.checked } })}
            />
            Fictional flavor stories about your missions
          </label>
          <div className="row">
            <label>
              Minutes between stories
              <input
                type="number"
                min={3}
                max={60}
                value={s.chatter.intervalMin}
                onChange={(e) =>
                  set({ ...s, chatter: { ...s.chatter, intervalMin: Number(e.target.value) } })
                }
              />
            </label>
          </div>
          <button className="btn" onClick={() => core.tellStory()}>
            Tell one now
          </button>
          <div className="hint">
            Pure fiction grounded in your real missions — rumors, backstories, gossip. Uses the AI
            when available, an offline generator otherwise. Never contains instructions.
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.saga.enabled}
              onChange={(e) => set({ ...s, saga: { enabled: e.target.checked } })}
            />
            The Saga — auto-narrate a space-opera episode when a game session ends
          </label>
          <button className="btn" onClick={() => core.tellSaga()}>
            📜 Narrate today so far
          </button>
        </section>

        <section>
          <h3>Operator memory &amp; sight</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.memory.enabled}
              onChange={(e) => set({ ...s, memory: { ...s.memory, enabled: e.target.checked } })}
            />
            Long-term memory — the operator remembers you across sessions
          </label>
          {s.memory.enabled && (
            <>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.memory.proactive}
                  onChange={(e) =>
                    set({ ...s, memory: { ...s.memory, proactive: e.target.checked } })
                  }
                />
                Spoken remarks from memory (records broken, returns to old haunts, milestones)
              </label>
              <div className="row">
                <label>
                  Min minutes between remarks
                  <input
                    type="number"
                    min={5}
                    max={120}
                    value={s.memory.remarkCooldownMin}
                    onChange={(e) =>
                      set({
                        ...s,
                        memory: { ...s.memory, remarkCooldownMin: Number(e.target.value) },
                      })
                    }
                  />
                </label>
              </div>
              <div className="hint">Remembered so far: {snap.memorySummary}</div>
              <div className="row">
                <button className="btn" onClick={() => core.runReflection(true)}>
                  🧠 Distill session into memory now
                </button>
                <button
                  className="btn danger"
                  onClick={() => {
                    // Two-click confirm — native confirm() dialogs are
                    // unreliable inside webviews.
                    if (forgetArmed) {
                      core.forgetMemory();
                      setForgetArmed(false);
                    } else {
                      setForgetArmed(true);
                      setTimeout(() => setForgetArmed(false), 4000);
                    }
                  }}
                >
                  {forgetArmed ? 'Really forget it all?' : 'Forget everything'}
                </button>
              </div>
              <div className="hint">
                Ledgers (factions, systems, records) update straight from the journal; at session
                end the AI distills a few durable memories. Everything lives in a local
                memory.json — nothing ever leaves this machine.
              </div>
            </>
          )}
          <label className="check">
            <input
              type="checkbox"
              checked={s.vision.enabled}
              disabled={IS_LINUX}
              onChange={(e) => set({ ...s, vision: { ...s.vision, enabled: e.target.checked } })}
            />
            Screen glances — the operator occasionally looks at your screen
            {IS_LINUX
              ? ' (Windows only for now)'
              : !snap.visionOk && snap.lm.ok
                ? ' (active model has no vision!)'
                : ''}
          </label>
          {s.vision.enabled && (
            <>
              <div className="row">
                <label>
                  Minutes between glances
                  <input
                    type="number"
                    min={2}
                    max={60}
                    value={s.vision.intervalMin}
                    onChange={(e) =>
                      set({ ...s, vision: { ...s.vision, intervalMin: Number(e.target.value) } })
                    }
                  />
                </label>
                <button className="btn" onClick={() => void core.glance(true)}>
                  👁 Glance now
                </button>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.vision.commentary}
                  onChange={(e) =>
                    set({ ...s, vision: { ...s.vision, commentary: e.target.checked } })
                  }
                />
                Copilot commentary — the operator follows your whole session (events + screen) and
                reacts in context, like a crewmate riding along (paced with chatter, never floods)
              </label>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.vision.describeFirst}
                  onChange={(e) =>
                    set({ ...s, vision: { ...s.vision, describeFirst: e.target.checked } })
                  }
                />
                Read the screen first — a separate pass describes the screen, then the operator
                speaks from that description (steadier on small models)
              </label>
              <div className="hint">
                A near-native screenshot goes ONLY to your local LM endpoint and is never saved.
                Without commentary, the operator speaks only when it sees something genuinely
                worth reacting to
                {snap.glanceActivity ? ` — last seen: ${snap.glanceActivity}` : ''}.
              </div>
              {snap.visionStatus && (
                <div className="hint">👁 {snap.visionStatus}</div>
              )}
            </>
          )}
        </section>

        <section>
          <h3>Trade leads</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.trade.enabled}
              onChange={(e) => set({ ...s, trade: { ...s.trade, enabled: e.target.checked } })}
            />
            Remember visited markets and suggest profitable runs
          </label>
          <div className="row">
            <label>
              Min profit (cr/ton)
              <input
                type="number"
                min={1000}
                max={50000}
                step={500}
                value={s.trade.minProfitPerTon}
                onChange={(e) =>
                  set({ ...s, trade: { ...s.trade, minProfitPerTon: Number(e.target.value) } })
                }
              />
            </label>
          </div>
          <div className="hint">
            The operator learns prices from every commodities market you open in-game and flags
            buy-low / sell-high spreads between remembered stations. Dismissed leads stay hidden
            for a day; prices older than 48 h age out.
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.exobio.enabled}
              onChange={(e) => set({ ...s, exobio: { enabled: e.target.checked } })}
            />
            Exobiology leads — bodies with bio signals you haven't sampled yet
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.trade.online}
              onChange={(e) => set({ ...s, trade: { ...s.trade, online: e.target.checked } })}
            />
            Online route planner (Spansh) — community price data, sends only your
            current system/station name
          </label>
          {s.trade.online && (
            <>
              <div className="row">
                <label>
                  Max hop distance (ly)
                  <input
                    type="number"
                    min={10}
                    max={200}
                    step={5}
                    value={s.trade.routeMaxHopLy}
                    onChange={(e) =>
                      set({ ...s, trade: { ...s.trade, routeMaxHopLy: Number(e.target.value) } })
                    }
                  />
                </label>
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={s.trade.autoCopyRoute}
                  onChange={(e) =>
                    set({ ...s, trade: { ...s.trade, autoCopyRoute: e.target.checked } })
                  }
                />
                Auto-copy the next waypoint to the clipboard (paste in galaxy map with Ctrl+V)
              </label>
              <button
                className="btn"
                disabled={snap.routeBusy}
                onClick={() => void core.fetchRoute(true)}
              >
                {snap.routeBusy ? 'Searching…' : '🔄 Find a route from here'}
              </button>
              <div className="hint">
                Routes are sized to your ship's cargo hold and bankroll automatically, and also
                refresh when you dock (at most twice an hour).
              </div>
            </>
          )}
        </section>

        <section>
          <h3>HUD</h3>
          <div className="row">
            <label>
              Opacity {Math.round(s.hud.opacity * 100)}%
              <input
                type="range"
                min={0.4}
                max={1}
                step={0.05}
                value={s.hud.opacity}
                onChange={(e) => set({ ...s, hud: { ...s.hud, opacity: Number(e.target.value) } })}
              />
            </label>
            <label>
              Font {Math.round(s.hud.fontScale * 100)}%
              <input
                type="range"
                min={0.8}
                max={1.5}
                step={0.05}
                value={s.hud.fontScale}
                onChange={(e) => set({ ...s, hud: { ...s.hud, fontScale: Number(e.target.value) } })}
              />
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.hud.clickThrough}
              onChange={(e) => set({ ...s, hud: { ...s.hud, clickThrough: e.target.checked } })}
            />
            Click-through (HUD ignores mouse — Ctrl+Shift+T to toggle back!)
          </label>
        </section>

        <section>
          <h3>Journal</h3>
          <label>
            Directory (blank = auto-detect Saved Games)
            <input
              type="text"
              placeholder="%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous"
              value={s.journal.directory ?? ''}
              onChange={(e) =>
                set({ ...s, journal: { ...s.journal, directory: e.target.value || null } })
              }
            />
          </label>
          <div className="row">
            <label>
              Previous sessions to replay
              <input
                type="number"
                min={0}
                max={10}
                value={s.journal.bootstrapPreviousSessions}
                onChange={(e) =>
                  set({
                    ...s,
                    journal: { ...s.journal, bootstrapPreviousSessions: Number(e.target.value) },
                  })
                }
              />
            </label>
            <label>
              Expiry warning (min)
              <input
                type="number"
                min={5}
                max={240}
                value={s.journal.expiryWarningMin}
                onChange={(e) =>
                  set({ ...s, journal: { ...s.journal, expiryWarningMin: Number(e.target.value) } })
                }
              />
            </label>
          </div>
          <div className="hint">
            {snap.journal.ok
              ? `Watching ${snap.journal.file ?? '(no journal yet)'}`
              : (snap.journal.error ?? 'Journal not connected.')}
          </div>
          <button className="btn" onClick={() => void core.restartWatch()}>
            Re-scan journal
          </button>
        </section>

        <section>
          <h3>Manual import</h3>
          <textarea
            rows={4}
            placeholder='Paste journal JSON lines (e.g. {"event":"MissionAccepted", ...})'
            value={importText}
            onChange={(e) => setImportText(e.target.value)}
          />
          <button
            className="btn"
            onClick={() => {
              core.importText(importText);
              setImportText('');
            }}
          >
            Import events
          </button>
        </section>

        <section>
          <h3>Shortcuts (global)</h3>
          <div className="hint">
            Ctrl+Shift+M show/hide · Ctrl+Shift+H ask AI · Ctrl+Shift+V voice ·{' '}
            Ctrl+Shift+J cycle mission · Ctrl+Shift+K collapse · Ctrl+Shift+T click-through
          </div>
        </section>
      </div>
    </div>
  );
}
