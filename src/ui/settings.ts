/**
 * App settings — persisted in localStorage, shape mirrors SPEC.md §7 (subset
 * that is actually wired). Geometry is persisted Rust-side; shortcuts are
 * fixed (see README).
 */

export type TtsEngine = 'piper' | 'system';

export interface AppSettings {
  lm: {
    /** 'bundled' = the app's own llama.cpp engine (no LM Studio needed);
     *  'lmstudio' = talk to a user-run LM Studio at `endpoint`. */
    engine: 'bundled' | 'lmstudio';
    /** Model id the bundled engine should serve (see engine.rs manifest). */
    bundledModel: string | null;
    endpoint: string;
    model: string | null; // null = auto-pick first non-embedding model
    temperature: number;
    maxTokens: number;
    tools: boolean; // let the operator call tools to read live game data
    /** Refresh the bundled llama.cpp runtime when a newer pinned build
     *  ships. The archive is ~32 MB and still comes from the pinned URL
     *  in engine.rs — this only removes the click, not the pinning. */
    autoUpdateRuntime: boolean;
  };
  voice: {
    enabled: boolean;
    engine: TtsEngine; // 'piper' = bundled local neural model (default, private)
    piperVoice: string | null; // null = first installed voice
    systemVoice: string | null;
    localVoicesOnly: boolean; // filter cloud voices from the system picker
    rate: number; // 0.5 .. 2.0
    volume: number; // 0 .. 100
  };
  hud: {
    opacity: number; // 0.3 .. 1
    fontScale: number; // 0.8 .. 1.5
    clickThrough: boolean;
  };
  journal: {
    directory: string | null; // null = auto-detect default Saved Games path
    bootstrapPreviousSessions: number;
    expiryWarningMin: number;
  };
  /** Fictional local wire service for the current system, grounded in the
   *  journal's own faction/station/signal data. Off by default: it costs a
   *  model call, and a commander who never opens the tab should not pay it. */
  news: {
    enabled: boolean;
    /** Minutes between editions; 0 is Off (see NEWS_INTERVALS). */
    everyMin: number;
    /** Stories per edition. */
    perEdition: number;
    /** 'wry' gives the wire an editorial voice; 'straight' reports flat. */
    tone: 'straight' | 'wry';
    /** Read new editions aloud. */
    speak: boolean;
    /**
     * The newsreader's voice — a piper voice id, or null to use the
     * operator's own. A bulletin read in the operator's voice sounds like the
     * operator talking about the news; a different voice makes it a broadcast.
     */
    voice: string | null;
  };
  chatter: {
    enabled: boolean; // fictional flavor stories about active missions
    intervalMin: number; // minimum minutes between automatic stories
    epic: boolean; // epic, purpose-driven tone for chatter + copilot commentary
  };
  /** Radio processing chain for all spoken output (operator + news + comms). */
  radio: {
    /** Process speech through the radio bus. */
    enabled: boolean;
    /** Profile for the operator/news/saga voice bus. */
    operatorProfile: string;
    /** Master mute for the radio bus output. */
    muted: boolean;
  };
  /** Ambient channel traffic heard in the Comms panel. */
  comms: {
    enabled: boolean;
    density: 'sparse' | 'normal' | 'busy' | 'bustling';
    volume: number;
    mutedChannels: string[];
    /** Legacy compatibility; source controls model/template policy now. */
    useModel: boolean;
    source: 'llm' | 'hybrid' | 'grammar';
    promoteRealShips: boolean;
    persistLog: boolean;
    /** Let the model improvise beyond observed journal nouns and figures. */
    allowFiction: boolean;
    grammarFile: string | null;
  };
  saga: {
    enabled: boolean; // auto-narrate a space-opera episode when a session ends
  };
  trade: {
    enabled: boolean; // remember visited markets and surface trade leads
    minProfitPerTon: number; // suggest only spreads at least this good
    online: boolean; // OPT-IN: ask Spansh for routes (sends system/station name)
    routeMaxHopLy: number; // max jump per hop for online route search
    autoCopyRoute: boolean; // keep the next waypoint system on the clipboard
  };
  exobio: {
    enabled: boolean; // track bodies with uncollected biological signals
  };
  /** OPT-IN community data sources. Both are off by default and each states
   *  exactly what leaves the machine. */
  external: {
    /** Galnet news for lore-flavoured beats. Sends NOTHING about the commander. */
    galnet: boolean;
    /** Ardent Insight galaxy-wide markets. Sends the system + commodity asked about. */
    ardent: boolean;
    /** EDAstro exploration catalogue. Sends the system name asked about. */
    edastro: boolean;
  };
  memory: {
    enabled: boolean; // persistent commander memory bank (memory.json)
    proactive: boolean; // spoken remarks from memory (records, returns, milestones)
    remarkCooldownMin: number; // min minutes between routine memory remarks
  };
  vision: {
    enabled: boolean; // OPT-IN: periodic screen glances to the local vision model
    intervalMin: number; // minutes between glances while the game is live
    /** Rich copilot remarks about what's on screen — not just danger verdicts.
     *  Paced by the chatter cooldown so it can never flood the commander. */
    commentary: boolean;
    /** Two-stage vision: a first pass reads the screen into a structured
     *  description, which the operator then speaks from. Splits perception from
     *  phrasing so small local VLMs ground better; costs one extra (fast,
     *  text-only) inference per glance. */
    describeFirst: boolean;
    /** How reactive the living copilot is to game events (jumps, arrivals,
     *  docking, hand-ins) on top of the periodic screen glance. 'low' = mission
     *  moments only, 'high' = chatty (reacts to travel too). */
    involvement: 'low' | 'medium' | 'high';
  };
  voiceInput: {
    enabled: boolean; // push-to-talk via the local whisper.cpp sidecar
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  lm: {
    // Existing installs keep talking to LM Studio; the bundled engine is opted
    // into from Settings (or the first-run flow) once it has been downloaded.
    engine: 'lmstudio',
    bundledModel: null,
    endpoint: 'http://127.0.0.1:1234',
    model: null,
    // 0.3 was a guidance-era default, from when the ask path mostly recited
    // procedure. The operator is a conversation now, and 0.3 reads flat.
    temperature: 0.8,
    // Reasoning models (gemma-4, qwen3.x) burn hidden "thinking" tokens before
    // any visible answer — measured on gemma-4-e4b: a 2-sentence chatter beat
    // spends 800-1,700 chars of hidden reasoning first. The model is local, so
    // tokens are free; 4096 buys quality and headroom, not cost.
    maxTokens: 4096,
    // Tool loop on by default; auto-disabled at runtime for models that don't
    // support tool calls, and falls back to grounded context on tool errors.
    tools: true,
    // On by default: a stale runtime silently missed every upstream fix,
    // because build.txt was written and never read. Turn it off to keep
    // the strict never-fetch-unasked behaviour.
    autoUpdateRuntime: true,
  },
  voice: {
    enabled: true,
    engine: 'piper',
    piperVoice: null,
    systemVoice: null,
    localVoicesOnly: true,
    rate: 1.0,
    volume: 80,
  },
  hud: {
    opacity: 0.95,
    fontScale: 1.0,
    clickThrough: false,
  },
  journal: {
    directory: null,
    bootstrapPreviousSessions: 1,
    expiryWarningMin: 30,
  },
  news: {
    enabled: false,
    everyMin: 30,
    perEdition: 3,
    tone: 'wry',
    speak: true,
    voice: null,
  },
  chatter: {
    enabled: true,
    intervalMin: 6,
    epic: false,
  },
  radio: {
    enabled: true,
    operatorProfile: 'clean',
    muted: false,
  },
  comms: {
    enabled: false,
    density: 'busy',
    volume: 70,
    mutedChannels: [],
    useModel: true,
    source: 'hybrid',
    promoteRealShips: true,
    persistLog: false,
    // Ambient chatter is flavor text; allow light invention by default.
    allowFiction: true,
    grammarFile: null,
  },
  saga: {
    enabled: true,
  },
  trade: {
    enabled: true,
    minProfitPerTon: 5000,
    online: false,
    routeMaxHopLy: 40,
    autoCopyRoute: true,
  },
  exobio: {
    enabled: true,
  },
  external: {
    // Off by default like every other network feature; Galnet sends nothing
    // identifying, Ardent sends a system + commodity name (as Spansh already does).
    galnet: false,
    ardent: false,
    edastro: false,
  },
  memory: {
    enabled: true,
    proactive: true,
    remarkCooldownMin: 15,
  },
  vision: {
    // Off by default: screenshots only ever travel to the local LM endpoint,
    // but looking at the screen is something the commander should invite.
    enabled: false,
    intervalMin: 5,
    // When vision is on, let the operator actually TALK about what it sees —
    // the danger-only verdict wastes a capable VLM.
    commentary: true,
    // Read the screen first, then speak from that reading — grounded comments
    // out of small local models, at the price of one extra fast inference.
    describeFirst: true,
    // Balanced by default: the copilot reacts to arrivals, docking and mission
    // moments, not every jump — a good middle ground of company.
    involvement: 'medium',
  },
  voiceInput: {
    // Off by default — enabling offers the one-time whisper.cpp download.
    enabled: false,
  },
};

const KEY = 'edmo.settings.v1';

function merge<T extends Record<string, unknown>>(base: T, over: unknown): T {
  if (!over || typeof over !== 'object') return base;
  const out = { ...base } as Record<string, unknown>;
  for (const [k, v] of Object.entries(over as Record<string, unknown>)) {
    if (!(k in base)) continue;
    const bv = (base as Record<string, unknown>)[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) {
      out[k] = merge(bv as Record<string, unknown>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export function loadSettings(): AppSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULT_SETTINGS);
    const s = merge(structuredClone(DEFAULT_SETTINGS), JSON.parse(raw));
    // Migration: 512 and 2048 were earlier defaults — 512 starves reasoning
    // models outright, 2048 leaves thinking-heavy models cramped. Users who
    // set a custom value keep it; old defaults ride up to the new one.
    if (s.lm.maxTokens === 512 || s.lm.maxTokens === 2048)
      s.lm.maxTokens = DEFAULT_SETTINGS.lm.maxTokens;
    // Migration: the old 0.3 guidance-era temperature rides up to the
    // conversational default. A custom value is left alone.
    if (s.lm.temperature === 0.3) s.lm.temperature = DEFAULT_SETTINGS.lm.temperature;
    // Migration: chatter default moved 10 → 6 min ("more operator talking").
    if (s.chatter.intervalMin === 10) s.chatter.intervalMin = DEFAULT_SETTINGS.chatter.intervalMin;
    return s;
  } catch {
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export function saveSettings(s: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // storage full/unavailable — settings just won't persist
  }
}
