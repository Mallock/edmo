/**
 * App settings — persisted in localStorage, shape mirrors SPEC.md §7 (subset
 * that is actually wired). Geometry is persisted Rust-side; shortcuts are
 * fixed (see README).
 */

export type TtsEngine = 'piper' | 'system';

export interface AppSettings {
  lm: {
    endpoint: string;
    model: string | null; // null = auto-pick first non-embedding model
    temperature: number;
    maxTokens: number;
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
  chatter: {
    enabled: boolean; // fictional flavor stories about active missions
    intervalMin: number; // minimum minutes between automatic stories
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
  memory: {
    enabled: boolean; // persistent commander memory bank (memory.json)
    proactive: boolean; // spoken remarks from memory (records, returns, milestones)
    remarkCooldownMin: number; // min minutes between routine memory remarks
  };
  vision: {
    enabled: boolean; // OPT-IN: periodic screen glances to the local vision model
    intervalMin: number; // minutes between glances while the game is live
  };
  voiceInput: {
    enabled: boolean; // push-to-talk via the local whisper.cpp sidecar
  };
}

export const DEFAULT_SETTINGS: AppSettings = {
  lm: {
    endpoint: 'http://127.0.0.1:1234',
    model: null,
    temperature: 0.3,
    // Reasoning models (gemma-4, qwen3.x) burn hidden "thinking" tokens before
    // any visible answer — 512 gets fully consumed by reasoning and the reply
    // arrives empty. 2048 leaves room to think AND answer.
    maxTokens: 2048,
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
  chatter: {
    enabled: true,
    intervalMin: 6,
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
    // Migration: 512 was the old default and starves reasoning models (their
    // hidden thinking eats the whole budget → empty answers). Upgrade it.
    if (s.lm.maxTokens === 512) s.lm.maxTokens = DEFAULT_SETTINGS.lm.maxTokens;
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
