/** Settings drawer — the bundled AI engine, voice, HUD, journal, manual import (T5.6). */
import { useEffect, useState } from 'react';
import type { AppSettings } from './settings.ts';
import { listSystemVoices } from './tts.ts';
import type { AppSnapshot } from './store.ts';
import { core } from './store.ts';
import { NEWS_INTERVALS, newsIntervalLabel } from '../engine/news.ts';
import { recommendationLabel, specsLabel } from './modelfit.ts';
import { PIPER_VOICE_CATALOG } from './voices.ts';
import { STATIONS } from '../engine/stations.ts';
import { RADIO_PROFILE_NAMES } from '../engine/chatter/profiles.ts';

/** Screen glances are GDI-based; on Linux the section shows as unavailable. */
const IS_LINUX = typeof navigator !== 'undefined' && navigator.userAgent.includes('Linux');

/**
 * The drawer used to be one column of fifteen sections — about two thousand
 * pixels of scroll between the AI engine at the top and the shortcuts at the
 * bottom. Turning the radio down meant scrolling past model downloads,
 * long-term memory and trade thresholds to get there.
 *
 * Five groups, named for what a commander is trying to CHANGE rather than for
 * which subsystem owns the code. Words, not icons: at 420 px five emoji would
 * be a guessing game, and these five words are short enough to sit on one row
 * at every font scale the HUD offers.
 */
const CATEGORIES = [
  { id: 'ai', label: 'AI', hint: 'The engine, the operator, its memory' },
  { id: 'audio', label: 'Audio', hint: 'Voice, radio processing, music, comms' },
  { id: 'feeds', label: 'Feeds', hint: 'Local wire, community data, trade leads' },
  { id: 'hud', label: 'HUD', hint: 'Size, colour, behaviour, shortcuts' },
  { id: 'data', label: 'Data', hint: 'Journal directory and manual import' },
] as const;

type Category = (typeof CATEGORIES)[number]['id'];

/**
 * Where the drawer was left, for as long as the app is running.
 *
 * Module-level rather than component state, because the panel unmounts every
 * time it closes — and someone nudging the radio between jumps should not be
 * put back on the AI engine each time. Deliberately NOT persisted to disk: a
 * fresh launch starting anywhere but the top would be its own small mystery.
 */
let lastCategory: Category = 'ai';

/** The phosphors, in the order the picker offers them. */
const TINTS = [
  { id: 'amber', label: 'Amber', swatch: '#f0a030' },
  { id: 'green', label: 'Green', swatch: '#5cbf82' },
  { id: 'red', label: 'Red', swatch: '#cf6257' },
  { id: 'grey', label: 'Grey', swatch: '#9aabc2' },
] as const;

export function SettingsPanel({ snap }: { snap: AppSnapshot }) {
  const s = snap.settings;
  const [voicesTick, setVoicesTick] = useState(0);
  const [importText, setImportText] = useState('');
  const [forgetArmed, setForgetArmed] = useState(false);
  const [campaignArmed, setCampaignArmed] = useState(false);
  const [cat, setCatState] = useState<Category>(lastCategory);
  const setCat = (next: Category) => {
    lastCategory = next;
    setCatState(next);
  };

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
      <div className="settings-nav" role="tablist" aria-label="Settings categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            role="tab"
            aria-selected={cat === c.id}
            className={cat === c.id ? 'settings-cat on' : 'settings-cat'}
            title={c.hint}
            onClick={() => setCat(c.id)}
          >
            {c.label}
          </button>
        ))}
      </div>
      <div className="settings-body" data-cat={cat}>
        <section data-cat="ai">
          <h3>AI engine</h3>
              {snap.engineProgress ? (
                <>
                  <div className="hint">
                    ⬇ {snap.engineProgress.phase}
                    {snap.engineProgress.total > 0
                      ? ` — ${Math.round((snap.engineProgress.received / snap.engineProgress.total) * 100)}%` +
                        ` (${(snap.engineProgress.received / 1e9).toFixed(2)} / ${(snap.engineProgress.total / 1e9).toFixed(2)} GB)`
                      : ` — ${(snap.engineProgress.received / 1e9).toFixed(2)} GB`}
                  </div>
                  <button className="btn" onClick={() => void core.engineCancel()}>
                    Cancel download
                  </button>
                </>
              ) : snap.engine?.running ? (
                <>
                  <div className="hint">
                    ✅ Running locally on port {snap.engine.port} — {snap.engine.running_model}.
                    Nothing else to install.
                  </div>
                  <button className="btn" onClick={() => void core.engineShutdown()}>
                    Stop the engine
                  </button>
                </>
              ) : (
                <>
                  {(snap.engine?.models ?? []).map((m) => (
                    <div className="row" key={m.id}>
                      <span style={{ flex: 1 }}>
                        {m.label} · {(m.bytes / 1e9).toFixed(1)} GB
                        {m.installed
                          ? ' · installed'
                          : m.partial_bytes > 0
                            ? ` · ${(m.partial_bytes / 1e9).toFixed(2)} GB downloaded — paused`
                            : ''}
                      </span>
                      <button
                        className="btn"
                        onClick={() =>
                          void core.engineSetup(
                            snap.engine?.runtime_backend ?? snap.engine?.recommended_backend ?? 'vulkan',
                            m.id,
                          )
                        }
                      >
                        {m.installed
                          ? 'Start'
                          : m.partial_bytes > 0
                            ? 'Resume download'
                            : 'Download & start'}
                      </button>
                      {!m.installed && m.partial_bytes > 0 && (
                        <button
                          className="btn"
                          title="Discard the partial download and free the disk space"
                          onClick={() => void core.engineDiscardPartial(m.id)}
                        >
                          Discard
                        </button>
                      )}
                    </div>
                  ))}
                  <div className="hint">
                    One-time download of a small inference runtime
                    {snap.engine?.recommended_backend
                      ? ` (${snap.engine.recommended_backend} — picked for your hardware)`
                      : ''}{' '}
                    plus the model. It runs entirely on this machine; nothing is sent anywhere.
                    Models are published under their own licence terms.
                  </div>
                  <label>
                    Run the AI on
                    <select
                      value={s.lm.compute}
                      onChange={(e) =>
                        set({
                          ...s,
                          lm: { ...s.lm, compute: e.target.value as typeof s.lm.compute },
                        })
                      }
                    >
                      <option value="gpu">Graphics card (default)</option>
                      <option value="cpu">Processor — leave the card to the game</option>
                    </select>
                  </label>
                  <div className="hint">
                    The card is usually faster. But on a strong processor it is not, and the card
                    is what the game needs: measured on a Ryzen 7 9800X3D against an RX 7800 XT,
                    moving the AI to the processor read prompts <b>2.7× faster</b>, answered{' '}
                    <b>41% quicker</b>, and handed back <b>3.6 GB</b> of graphics memory. Worth
                    trying if the game stutters when the operator speaks. Takes effect when the
                    engine next starts.
                  </div>
                </>
              )}
        </section>

        <section data-cat="ai">
          <h3>AI operator</h3>
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
                max={8192}
                step={64}
                value={s.lm.maxTokens}
                onChange={(e) => set({ ...s, lm: { ...s.lm, maxTokens: Number(e.target.value) } })}
              />
            </label>
          </div>
          <div className="hint">
            {snap.lm.ok
              ? `Connected — using ${snap.lm.activeModel ?? '?'}`
              : 'Engine not running — download or start a model above.'}
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

        <section data-cat="audio">
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
                /* Seventeen voices are a shelf you visit once and a wall you
                   scroll past forever. Folded shut by default, and the count
                   is on the summary so it still advertises itself. */
                <details className="voice-catalog">
                  <summary>
                    More offline voices
                    <span className="mono">
                      {PIPER_VOICE_CATALOG.filter((v) => !snap.piperVoices.includes(v.name)).length}
                    </span>
                  </summary>
                  <div className="hint">One-time download, then fully local.</div>
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
                </details>
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

        <section data-cat="audio">
          <h3>Radio processing</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.radio.enabled}
              onChange={(e) => set({ ...s, radio: { ...s.radio, enabled: e.target.checked } })}
            />
            Process speech through radio filters
          </label>
          <label>
            Operator profile
            <select
              value={s.radio.operatorProfile}
              onChange={(e) =>
                set({ ...s, radio: { ...s.radio, operatorProfile: e.target.value } })
              }
              disabled={!s.radio.enabled}
            >
              {RADIO_PROFILE_NAMES.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.radio.muted}
              onChange={(e) => set({ ...s, radio: { ...s.radio, muted: e.target.checked } })}
            />
            Mute radio output
          </label>
        </section>

        <section data-cat="audio">
          <h3>
            Music{' '}
            <span style={{ color: 'var(--dim)', fontSize: '0.8em' }}>
              (internet radio, off by default)
            </span>
          </h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.music.enabled}
              onChange={(e) => set({ ...s, music: { ...s.music, enabled: e.target.checked } })}
            />
            Play internet radio under the operator
          </label>
          <label>
            Station
            <select
              value={s.music.station}
              onChange={(e) => core.setMusicStation(e.target.value)}
              disabled={!s.music.enabled}
            >
              {STATIONS.map((st) => (
                <option key={st.id} value={st.id}>
                  {st.label} — {st.blurb}
                </option>
              ))}
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.music.followActivity}
              onChange={(e) =>
                set({ ...s, music: { ...s.music, followActivity: e.target.checked } })
              }
              disabled={!s.music.enabled}
            />
            Let the station follow the work (the rings get drone, hauls get rock)
          </label>
          <div className="row">
            <label>
              Volume {s.music.volume}
              <input
                type="range"
                min={0}
                max={100}
                value={s.music.volume}
                onChange={(e) =>
                  set({ ...s, music: { ...s.music, volume: Number(e.target.value) } })
                }
                disabled={!s.music.enabled}
              />
            </label>
          </div>
          {snap.music?.nowPlaying && (
            <div className="hint">♫ {snap.music.nowPlaying}</div>
          )}
          {snap.music?.error && <div className="hint">{snap.music.error}</div>}
          <div className="hint">
            The radio ducks under the operator and thins under comms traffic. Streams come from{' '}
            <a href="https://somafm.com" target="_blank" rel="noopener">
              SomaFM
            </a>
            , which is listener-supported and free of adverts —{' '}
            <a href="https://somafm.com/support/" target="_blank" rel="noopener">
              consider donating
            </a>{' '}
            if you leave it on. The synthwave and industrial channels come from{' '}
            <a href="https://nightride.fm" target="_blank" rel="noopener">
              Nightride FM
            </a>
            , also listener-supported, and Galaxy News Radio from Fallout.FM. This is the app's only
            continuous internet connection; everything else stays on this machine.
          </div>
        </section>

        <section data-cat="audio" data-last>
          <h3>Comms traffic</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.comms.enabled}
              onChange={(e) => set({ ...s, comms: { ...s.comms, enabled: e.target.checked } })}
            />
            Ambient comms traffic
          </label>
          <div className="row">
            <label>
              How busy
              <select
                value={s.comms.density}
                onChange={(e) =>
                  set({
                    ...s,
                    comms: { ...s.comms, density: e.target.value as typeof s.comms.density },
                  })
                }
                disabled={!s.comms.enabled}
              >
                <option value="sparse">Sparse</option>
                <option value="normal">Normal</option>
                <option value="busy">Busy</option>
                <option value="bustling">Bustling</option>
              </select>
            </label>
          </div>
          <div className="row">
            <label>
              Volume
              <input
                type="range"
                min={0}
                max={100}
                value={s.comms.volume}
                onChange={(e) =>
                  set({ ...s, comms: { ...s.comms, volume: Number(e.target.value) } })
                }
                disabled={!s.comms.enabled}
              />
            </label>
            <span className="mono">{s.comms.volume}</span>
          </div>
          <label>
            Written by
            <select
              value={s.comms.source}
              onChange={(e) =>
                set({ ...s, comms: { ...s.comms, source: e.target.value as typeof s.comms.source } })
              }
              disabled={!s.comms.enabled}
            >
              <option value="hybrid">AI with templates fallback</option>
              <option value="llm">AI only</option>
              <option value="grammar">Templates only</option>
            </select>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.comms.persistLog}
              onChange={(e) => set({ ...s, comms: { ...s.comms, persistLog: e.target.checked } })}
              disabled={!s.comms.enabled}
            />
            Keep the transmission log across restarts
          </label>
        </section>

        <section data-cat="feeds">
          <h3>Local wire</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.news.enabled}
              onChange={(e) => set({ ...s, news: { ...s.news, enabled: e.target.checked } })}
            />
            Fictional local news for the system you are in
          </label>
          <div className="row">
            <label>
              New edition
              <select
                value={s.news.everyMin}
                onChange={(e) => set({ ...s, news: { ...s.news, everyMin: Number(e.target.value) } })}
              >
                {NEWS_INTERVALS.map((m) => (
                  <option key={m} value={m}>
                    {newsIntervalLabel(m)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Stories each time
              <input
                type="number"
                min={1}
                max={5}
                value={s.news.perEdition}
                onChange={(e) =>
                  set({ ...s, news: { ...s.news, perEdition: Number(e.target.value) } })
                }
              />
            </label>
          </div>
          <div className="row">
            <label>
              House style
              <select
                value={s.news.tone}
                onChange={(e) =>
                  set({ ...s, news: { ...s.news, tone: e.target.value as 'straight' | 'wry' } })
                }
              >
                <option value="wry">Wry — deadpan, unimpressed, takes the piss upwards</option>
                <option value="straight">Straight — flat reporting, no opinion</option>
              </select>
            </label>
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.news.speak}
              onChange={(e) => set({ ...s, news: { ...s.news, speak: e.target.checked } })}
            />
            Read new editions aloud
          </label>
          {s.news.speak && (
            <div className="row">
              <label>
                Newsreader voice
                <select
                  value={s.news.voice ?? ''}
                  onChange={(e) => set({ ...s, news: { ...s.news, voice: e.target.value || null } })}
                >
                  <option value="">same as the operator</option>
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
              <button className="btn" onClick={() => core.testNewsVoice()}>
                Hear it
              </button>
            </div>
          )}
          <p className="hint">
            Written by your local AI from this system&rsquo;s own faction board, stations, signals and
            construction sites. It may invent people and quotes; it may not invent a faction or a
            station. &ldquo;Off&rdquo; still lets you press <b>New edition</b> in the tab.
            {s.news.speak && s.voice.engine === 'system' && (
              <>
                {' '}
                Your voice engine is set to <b>system voices</b>, so the newsreader list above is for
                the offline Piper voices — pick a system voice by name only if you have one installed
                under that name.
              </>
            )}
            {s.news.speak && snap.piperVoices.length < 2 && s.voice.engine === 'piper' && (
              <>
                {' '}
                Only one offline voice is installed, so the wire will sound like the operator.
                Download another under <b>Voice</b> above to tell them apart.
              </>
            )}
          </p>
        </section>

        <section data-cat="ai">
          <h3>Operator chatter</h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.chatter.enabled}
              onChange={(e) => set({ ...s, chatter: { ...s.chatter, enabled: e.target.checked } })}
            />
            Fictional flavor stories about your missions
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.chatter.epic}
              onChange={(e) => set({ ...s, chatter: { ...s.chatter, epic: e.target.checked } })}
            />
            Epic mode - grand, purpose-driven delivery for chatter and copilot beats
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

        <section data-cat="ai" data-last>
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
          <div className="row">
            <button
              className="btn danger"
              onClick={() => {
                // Same two-click confirm as the memory wipe — native confirm()
                // dialogs are unreliable inside webviews.
                if (campaignArmed) {
                  core.resetCampaign();
                  setCampaignArmed(false);
                } else {
                  setCampaignArmed(true);
                  setTimeout(() => setCampaignArmed(false), 4000);
                }
              }}
            >
              {campaignArmed ? 'Really reset the campaign?' : 'Reset campaign'}
            </button>
          </div>
          <div className="hint">
            The campaign is the story that follows you between systems — the faction working
            against you, the one you keep helping, the standing aim. Resetting starts it from
            scratch; the journal is untouched.
          </div>
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
              {s.vision.commentary && (
                <div className="row">
                  <label>
                    Copilot involvement
                    <select
                      value={s.vision.involvement}
                      onChange={(e) =>
                        set({
                          ...s,
                          vision: {
                            ...s.vision,
                            involvement: e.target.value as 'low' | 'medium' | 'high',
                          },
                        })
                      }
                    >
                      <option value="low">Reserved — mission moments only</option>
                      <option value="medium">Balanced — arrivals, docking &amp; discoveries too</option>
                      <option value="high">Chatty — reacts to jumps as well</option>
                    </select>
                  </label>
                </div>
              )}
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

        <section data-cat="feeds">
          <h3>Community data <span style={{ color: 'var(--dim)', fontSize: '0.8em' }}>(optional, off by default)</span></h3>
          <label className="check">
            <input
              type="checkbox"
              checked={s.external.galnet}
              onChange={(e) => set({ ...s, external: { ...s.external, galnet: e.target.checked } })}
            />
            Galnet news — ask "any news?" and the operator reads the wire
          </label>
          <div className="hint">
            Fetches the official public news feed <b>only when you ask</b> — it never interrupts you
            with headlines. Sends <b>nothing</b> about you: no name, no system, no identifiers. News
            is relayed as someone else's dispatch, never as something you witnessed.
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.external.ardent}
              onChange={(e) => set({ ...s, external: { ...s.external, ardent: e.target.checked } })}
            />
            Galaxy-wide markets &amp; trade runs — ask "what's worth hauling?" or "where can I sell this?"
          </label>
          <div className="hint">
            Uses Ardent Insight, built from community-shared market data (open source, anonymous).
            Finds the best buy-here/sell-there run out of any system, sized to your hold and filtered
            to pads your ship can actually land on. Sends only <b>the system asked about and the
            commodities checked</b>, and only when the operator looks something up. Prices can be
            hours old and fleet carriers move, so verify stock on arrival.
          </div>
          <label className="check">
            <input
              type="checkbox"
              checked={s.external.edastro}
              onChange={(e) => set({ ...s, external: { ...s.external, edastro: e.target.checked } })}
            />
            Exploration catalogue — ask whether a system is worth the detour, and what biology is already logged there
          </label>
          <div className="hint">
            Uses EDAstro's Galactic Exploration Catalogue. Sends only <b>the system name you asked
            about</b>. Nothing logged means nobody has been — which is where the five-times first
            footfall bonus still is, not proof the system is empty.
          </div>
        </section>

        <section data-cat="feeds" data-last>
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
            current system/station name, and only when you ask
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
                onClick={() => void core.fetchRoute()}
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

        <section data-cat="hud">
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
              checked={s.hud.autoView}
              onChange={(e) => set({ ...s, hud: { ...s.hud, autoView: e.target.checked } })}
            />
            Follow the game (a market at a build site opens the shopping list, undocking
            brings back the map)
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={s.hud.clickThrough}
              onChange={(e) => set({ ...s, hud: { ...s.hud, clickThrough: e.target.checked } })}
            />
            Click-through (HUD ignores mouse — Ctrl+Shift+T to toggle back!)
          </label>

          <div className="tint-label">Instrument colour</div>
          <div className="tint-row" role="radiogroup" aria-label="Instrument colour">
            {TINTS.map((t) => (
              <button
                key={t.id}
                role="radio"
                aria-checked={s.hud.tint === t.id}
                className={s.hud.tint === t.id ? 'tint on' : 'tint'}
                onClick={() => set({ ...s, hud: { ...s.hud, tint: t.id } })}
              >
                <i style={{ background: t.swatch }} />
                {t.label}
              </button>
            ))}
          </div>
          <div className="hint">
            Repaints the instrument — the frame, the title, gauges and edges. The four signal
            colours stay put, because on this panel a colour is a fact: amber is money and the
            standing job, cyan a destination, green delivered, red expiry. Red is the night
            setting; it is the one that leaves your eyes adjusted to the dark.
          </div>
        </section>

        <section data-cat="data">
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

        <section data-cat="data" data-last>
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

        <section data-cat="hud" data-last>
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
