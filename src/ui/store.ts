/**
 * AppCore — the HUD's single state container. Wires the Rust transport
 * (journal tail + snapshots + LLM proxy + Piper TTS) into the tested TS
 * engine (MissionStateManager, Heartbeat, Operator) and exposes an immutable
 * snapshot for React via subscribe/getSnapshot.
 */
import { MissionStateManager, normalizeCommodity, type StateChange } from '../engine/state.ts';
import { Heartbeat, type Nudge, type NudgeSeverity } from '../engine/heartbeat.ts';
import { parseJournalLine, parseJournalLines } from '../engine/parse.ts';
import {
  arrivalNotice,
  buildBriefingChat,
  buildChat,
  cargoNotice,
  completionNotice,
  describeSystemIntel,
  livelyBriefing,
  redirectNotice,
  ruleBasedAdvice,
} from '../engine/operator.ts';
import {
  afterglowFlavor,
  buildAfterglowChat,
  buildFlavorChat,
  planStory,
  ruleBasedFlavor,
} from '../engine/flavor.ts';
import { SessionStats } from '../engine/stats.ts';
import { SagaTracker, beatRecap, buildEpisodeChat } from '../engine/saga.ts';
import {
  MarketMemory,
  findOpportunities,
  parseMarketSnapshot,
  type TradeOpportunity,
} from '../engine/trade.ts';
import { BioTracker, type BioLead } from '../engine/exobio.ts';
import { StatusTracker, isBusyFocus, isScoopableStar, type StatusAlert } from '../engine/status.ts';
import { ShipTracker, describeShip, shipRequiresLargePad } from '../engine/ship.ts';
import { MaterialsTracker } from '../engine/materials.ts';
import { ExploreTracker, type ExploreLead } from '../engine/explore.ts';
import { parseSpanshRoute, routeSummary, type TradeRoute } from '../engine/spansh.ts';
import {
  CommanderMemory,
  REFLECTION_FORMAT,
  buildReflectionChat,
  type MemoryEvent,
} from '../engine/memory.ts';
import {
  GLANCE_FORMAT,
  SCENE_FORMAT,
  buildCommentaryMessages,
  buildGlanceMessages,
  buildSceneDescriptionMessages,
  parseGlanceReply,
  parseSceneDescription,
  renderSceneForOperator,
  suppressRoutineCoaching,
  suppressUngroundedFuelConcern,
  type CommentaryAngle,
} from '../engine/glance.ts';
import { ConvoBuffer, cleanTranscript } from '../engine/convo.ts';
import { TOOL_SCHEMAS, runTool, type ToolContext } from '../engine/tools.ts';
import type { ChatMessage } from '../engine/lmstudio.ts';
import type { JournalEvent, Mission, OperatorState } from '../engine/types.ts';
import {
  captureScreen,
  isTauri,
  llmCancel,
  llmChat,
  llmModels,
  llmModelTypes,
  memoryLoad,
  memorySave,
  onClickThrough,
  onJournalLines,
  onJournalReady,
  onLlmDone,
  onLlmError,
  onLlmToken,
  onShortcut,
  onSnapshot,
  onWatchStatus,
  piperAvailable,
  piperDownloadVoice,
  piperVoices,
  copyText,
  setClickThrough,
  spanshTradeRoute,
  startWatch,
  sttAvailable,
  sttCancel,
  sttDownload,
  sttStart,
  sttStop,
  systemSpecs,
  type ToolCallWire,
} from './bridge.ts';
import { classifyModel, type ModelFit, type SystemSpecs } from './modelfit.ts';
import { loadSettings, saveSettings, type AppSettings } from './settings.ts';
import { Speaker } from './tts.ts';

export type FeedKind =
  | 'briefing'
  | 'redirect'
  | 'arrival'
  | 'complete'
  | 'cargo'
  | 'abandoned'
  | 'failed'
  | 'nudge'
  | 'user'
  | 'ai'
  | 'story'
  | 'combat'
  | 'saga'
  | 'memory'
  | 'vision'
  | 'system';

export interface FeedEntry {
  id: number;
  time: string; // ISO
  kind: FeedKind;
  text: string;
  severity?: NudgeSeverity;
  missionId?: number;
  streaming?: boolean;
}

/** The stage-2 vision request held while the stage-1 screen reading runs. Once
 *  the reading arrives it is rendered to text and threaded into whichever of the
 *  two operator passes (spoken commentary or silent danger verdict) was chosen. */
interface PendingVision {
  mode: 'commentary' | 'verdict';
  dataUri: string;
  cmdr?: string;
  /** commentary mode */
  facts?: string;
  angle?: CommentaryAngle;
  recent?: string[];
  /** verdict mode */
  context?: string;
}

/** Compact ship telemetry surfaced to the HUD (from Status.json). */
export interface HudShipStatus {
  fuelPct: number | null;
  inDanger: boolean;
  beingInterdicted: boolean;
  silentRunning: boolean;
  lowFuel: boolean;
  overheating: boolean;
  legalState: string | null;
  onFoot: boolean;
  docked: boolean;
  supercruise: boolean;
  guiFocusLabel: string;
  pips: [number, number, number] | null;
}

export interface AppSnapshot {
  missions: Mission[];
  selectedId: number | null;
  feed: FeedEntry[];
  location: { system: string; station?: string };
  docked: boolean;
  journal: { ok: boolean; dir: string; file: string | null; error: string | null; gameLive: boolean };
  lm: { ok: boolean; models: string[]; activeModel: string | null; busy: boolean; activeFit: ModelFit };
  specs: SystemSpecs | null;
  trade: TradeOpportunity | null;
  bio: BioLead | null;
  /** Live ship telemetry from Status.json, or null before any snapshot. */
  shipStatus: HudShipStatus | null;
  /** Highest-value unmapped body known this session, or null. */
  exploreLead: ExploreLead | null;
  route: TradeRoute | null;
  routeBusy: boolean;
  routeIdx: number;
  piperOk: boolean;
  piperVoices: string[];
  voiceDownloading: string | null;
  collapsed: boolean;
  settingsOpen: boolean;
  settings: AppSettings;
  /** Memory bank inventory line for the settings panel. */
  memorySummary: string;
  /** True when the active model reports vision capability (VLM). */
  visionOk: boolean;
  /** Live one-line vision diagnostic: what the last glance did / why waiting. */
  visionStatus: string | null;
  /** Last screen-glance activity ("supercruising"), null before any glance. */
  glanceActivity: string | null;
  /** Voice input: whisper sidecar installed / downloading / mic hot. */
  sttOk: boolean;
  sttDownloading: boolean;
  listening: boolean;
  version: number;
}

const GAME_LIVE_WINDOW_MS = 90_000;

function stripThink(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

/** Human-readable label for a tool name, shown in the "working…" bubble. */
function friendlyTool(name?: string): string {
  const labels: Record<string, string> = {
    get_current_market: 'checking the market here',
    find_commodity: 'searching markets',
    list_known_markets: 'listing known markets',
    plan_trade_route: 'planning a route',
    get_ship: 'checking the ship',
    check_fit: 'checking cargo fit',
    get_ship_status: 'reading ship status',
    get_missions: 'reviewing missions',
    get_materials: 'checking materials',
    get_exploration: 'checking exploration',
    get_system_intel: 'reading system intel',
  };
  return labels[name ?? ''] ?? (name || 'a tool');
}

export class AppCore {
  private sm = new MissionStateManager();
  private hb: Heartbeat;
  private speaker = new Speaker(() => this.settings);
  private settings = loadSettings();

  private feed: FeedEntry[] = [];
  private feedSeq = 1;
  private selectedId: number | null = null;
  private collapsed = false;
  private settingsOpen = false;

  private journalStatus = {
    ok: false,
    dir: '',
    file: null as string | null,
    error: isTauri ? null : 'Running in a browser without the desktop shell — use Import in Settings.',
  };
  private lastGameActivity = 0;
  private bootstrapped = false;

  private lmModels: string[] = [];
  private lmOk = false;
  private lmBusy = false;
  private piperOk = false;
  private piperVoiceList: string[] = [];
  private voiceDownloading: string | null = null;
  private specs: SystemSpecs | null = null;

  private navRouteJumps = 0;
  private navRouteDest: string | null = null;

  private askSeq = 1;
  private currentAskId: string | null = null;
  /** Feed entry the stream writes into — null for silent requests
   *  (reflection, screen glances) that must not show streaming text. */
  private currentAiEntry: FeedEntry | null = null;
  private currentKind:
    | 'ai'
    | 'story'
    | 'brief'
    | 'saga'
    | 'reflect'
    | 'glance'
    | 'commentary'
    | 'describe' = 'ai';
  /** Live agentic tool-loop run for the current 'ai' question; null otherwise. */
  private agent: { entry: FeedEntry; messages: ChatMessage[]; rounds: number; useTools: boolean } | null = null;
  /** Cap tool rounds so a confused model can't loop forever. */
  private static readonly MAX_TOOL_ROUNDS = 5;
  private lastStoryAt = Date.now();

  // ------------------------------------------------------------- memory bank
  private memory = new CommanderMemory();
  private memoryReady = false; // bank loaded — journal folding may begin
  private memorySaving = false;
  private pendingMemoryEvents: Array<{ ev: MemoryEvent; at: number }> = [];
  private lastMemoryRemarkAt = 0;
  private pendingReflectAt = 0; // ms epoch to attempt a session reflection
  private reflectRetries = 0;
  private reflectManual = false;

  // -------------------------------------------------------- dialogue & voice
  /** Short-term conversation thread — the Jarvis property: follow-ups resolve. */
  private convo = new ConvoBuffer();
  private sttOk = false;
  private sttDownloading = false;
  private listening = false;
  private sttHintShown = false;

  /** Speak AND remember having said it, so "what did you mean?" resolves. */
  private speak(text: string): void {
    this.convo.push('assistant', text, Date.now());
    this.speaker.speak(text);
  }

  // ------------------------------------------------------------ screen sight
  private modelTypes: Record<string, string> = {};
  private lastGlanceAt = 0;
  private glanceActivity: string | null = null;
  private glanceActivityAt = 0;
  /** Last vision-pipeline outcome, timestamped — silent gates made "why is it
   *  quiet?" undiagnosable from the outside, so every decision leaves a note. */
  private glanceLog = '';
  /** Previous commentary register — rotated so beats don't repeat a mode. */
  private lastCommentaryAngle: CommentaryAngle | null = null;
  private lastGlanceRemark = '';
  private lastGlanceRemarkAt = 0;
  private glanceManual = false;
  private glanceInFlight = false;
  /** Stage-2 work parked while the stage-1 screen reading is in flight. Cleared
   *  when the reading completes (consumed) or the request is superseded. */
  private pendingVision: PendingVision | null = null;

  private stats = new SessionStats();
  private saga = new SagaTracker();
  // Real-time ship telemetry + loadout + material/exploration ledgers.
  private statusTracker = new StatusTracker();
  private ship = new ShipTracker();
  private materials = (() => {
    const m = new MaterialsTracker();
    try {
      m.load(JSON.parse(localStorage.getItem('edmo.materials.v1') ?? 'null'));
    } catch {
      /* start empty */
    }
    return m;
  })();
  private explore = (() => {
    const e = new ExploreTracker();
    try {
      e.load(JSON.parse(localStorage.getItem('edmo.explore.v1') ?? '[]'));
    } catch {
      /* start empty */
    }
    return e;
  })();
  /** Last hyperspace target star class + remaining jumps (FSDTarget). */
  private lastFsdStarClass: string | null = null;
  private lastStatusAlertAt = new Map<string, number>();
  private lastPadAnnounced = 0;
  private lastMiningAt = 0;
  private lastStoryText = '';
  private seedCountAtLastStory = 0;
  /** Interesting NPC comms overheard recently — ambient story texture.
   *  `used` marks lines already woven into a story: each transmission is
   *  offered to the LLM ONCE, or the same catchy line haunts every beat for
   *  45 minutes (the cruise-ship-safety-demo problem). */
  private recentComms: Array<{ text: string; at: number; used?: boolean }> = [];
  /** Last few spoken stories/commentaries — the anti-repetition ring. */
  private recentStories: string[] = [];
  private commsSeen = new Map<string, number>();

  /** Unused fresh comms, marked consumed on take — each line rides once. */
  private freshComms(): string[] {
    const cutoff = Date.now() - 45 * 60_000;
    const fresh = this.recentComms.filter((c) => c.at > cutoff && !c.used);
    for (const c of fresh) c.used = true;
    return fresh.map((c) => c.text);
  }

  /** Remember a spoken story/commentary for the anti-repetition ring. */
  private rememberStory(text: string): void {
    if (!text) return;
    this.recentStories.push(text);
    if (this.recentStories.length > 4) this.recentStories = this.recentStories.slice(-4);
  }

  private marketMemory = (() => {
    const mem = new MarketMemory();
    try {
      mem.load(JSON.parse(localStorage.getItem('edmo.markets.v1') ?? '[]'));
    } catch {
      /* start empty */
    }
    return mem;
  })();
  private dismissedTrades: Record<string, number> = (() => {
    try {
      return JSON.parse(localStorage.getItem('edmo.trades.dismissed.v1') ?? '{}');
    } catch {
      return {};
    }
  })();
  private tradeOpp: TradeOpportunity | null = null;
  private lastTradeKeyAnnounced = '';

  private bioTracker = (() => {
    const t = new BioTracker();
    try {
      t.load(JSON.parse(localStorage.getItem('edmo.bio.v1') ?? '[]'));
    } catch {
      /* start empty */
    }
    return t;
  })();
  private dismissedBio: Record<string, number> = (() => {
    try {
      return JSON.parse(localStorage.getItem('edmo.bio.dismissed.v1') ?? '{}');
    } catch {
      return {};
    }
  })();
  private bioLead: BioLead | null = null;
  private lastBioKeyAnnounced = '';

  private route: TradeRoute | null = null;
  private routeBusy = false;
  private lastRouteFetchAt = 0;
  /** Next waypoint index into route.hops (hops before this are completed). */
  private routeIdx = 0;
  private sagaEpisodes: Array<{ n: number; day: string; text: string; at: number }> = (() => {
    try {
      return JSON.parse(localStorage.getItem('edmo.saga.v1') ?? '[]');
    } catch {
      return [];
    }
  })();
  private pendingSaga: { n: number; day: string } | null = null;
  /** True recent happenings the story generator may weave in as callbacks. */
  private seeds: Array<{ text: string; at: number }> = [];
  private cgAnnounced = new Set<number>();
  private lastCombatAt = 0;
  private lastUnderAttackNoteAt = 0;
  private lastProspectAt = 0;
  // Mining companionship — present without being chatty: a ring greeting,
  // first-of-each-ore acknowledgements, session tonnage milestones.
  private lastRingGreetAt = 0;
  private sessionOreAnnounced = new Set<string>();
  private oreMilestonesDone = new Set<number>();
  private lastMiningSpokeAt = 0;
  private lastLedgerAt = 0;
  private ledgerEarnedMark = 0;
  private recentThreats = new Map<string, number>();

  private listeners = new Set<() => void>();
  private version = 0;
  private snap: AppSnapshot;
  private initialized = false;

  constructor() {
    this.hb = new Heartbeat({ expiryWarnMin: this.settings.journal.expiryWarningMin });
    // Browser fallback bank; in Tauri the memory.json file (loaded in init,
    // BEFORE the journal watch starts) replaces it.
    try {
      const raw = localStorage.getItem('edmo.memory.v1');
      if (raw) this.memory.load(JSON.parse(raw));
    } catch {
      /* start with an empty bank */
    }
    if (!isTauri) this.memoryReady = true;
    this.snap = this.buildSnapshot();
  }

  // ------------------------------------------------------------------ React
  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  };

  getSnapshot = (): AppSnapshot => this.snap;

  private emit(): void {
    this.version += 1;
    this.snap = this.buildSnapshot();
    for (const cb of this.listeners) cb();
  }

  private buildSnapshot(): AppSnapshot {
    const missions = this.sm.activeMissions();
    const selected =
      this.selectedId !== null && missions.some((m) => m.id === this.selectedId)
        ? this.selectedId
        : (missions[0]?.id ?? null);
    this.selectedId = selected;
    return {
      missions: [...missions],
      selectedId: selected,
      feed: [...this.feed],
      location: { ...this.sm.location },
      docked: this.sm.docked,
      journal: {
        ...this.journalStatus,
        gameLive: Date.now() - this.lastGameActivity < GAME_LIVE_WINDOW_MS,
      },
      lm: {
        ok: this.lmOk,
        models: this.lmModels,
        activeModel: this.activeModel(),
        busy: this.lmBusy,
        activeFit: (() => {
          const m = this.activeModel();
          return m ? classifyModel(m, this.specs).fit : 'unknown';
        })(),
      },
      specs: this.specs,
      trade: this.tradeOpp,
      bio: this.bioLead,
      shipStatus: this.hudShipStatus(),
      exploreLead: this.explore.leads()[0] ?? null,
      route: this.route,
      routeBusy: this.routeBusy,
      routeIdx: this.routeIdx,
      piperOk: this.piperOk,
      piperVoices: this.piperVoiceList,
      voiceDownloading: this.voiceDownloading,
      collapsed: this.collapsed,
      settingsOpen: this.settingsOpen,
      settings: this.settings,
      memorySummary: this.memory.summaryLine(),
      visionOk: this.activeModelIsVlm(),
      visionStatus: this.settings.vision.enabled ? this.visionStatusLine() : null,
      glanceActivity:
        this.glanceActivity && Date.now() - this.glanceActivityAt < 10 * 60_000
          ? this.glanceActivity
          : null,
      sttOk: this.sttOk,
      sttDownloading: this.sttDownloading,
      listening: this.listening,
      version: this.version,
    };
  }

  /** Compact live ship telemetry for the HUD, or null before any snapshot. */
  private hudShipStatus(): HudShipStatus | null {
    const s = this.statusTracker.current;
    if (!s) return null;
    return {
      fuelPct: s.fuelPct ?? null,
      inDanger: s.inDanger,
      beingInterdicted: s.beingInterdicted,
      silentRunning: s.silentRunning,
      lowFuel: s.lowFuel,
      overheating: s.overheating,
      legalState: s.legalState && s.legalState !== 'Clean' ? s.legalState : null,
      onFoot: s.onFoot,
      docked: s.docked,
      supercruise: s.supercruise,
      guiFocusLabel: s.guiFocusLabel,
      pips: s.pips ?? null,
    };
  }

  /** VLM per LM Studio's REST API; unknown (older LM Studio) counts as capable
   *  — a failed glance is silent, so optimism costs nothing. */
  private activeModelIsVlm(): boolean {
    const m = this.activeModel();
    if (!m) return false;
    const ty = this.modelTypes[m];
    return ty === undefined ? true : ty === 'vlm';
  }

  // ------------------------------------------------------------------ setup
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    if (isTauri) {
      await Promise.all([
        onJournalLines((p) => this.onLines(p.lines, p.live)),
        onJournalReady(() => this.onBootstrapDone()),
        onSnapshot((p) => this.onSnapshotFile(p.name, p.text)),
        onWatchStatus((p) => {
          this.journalStatus = { ok: p.ok, dir: p.dir, file: p.file, error: p.error };
          this.emit();
        }),
        onShortcut((p) => this.onShortcutAction(p.action)),
        onClickThrough((p) => {
          this.settings = {
            ...this.settings,
            hud: { ...this.settings.hud, clickThrough: p.enabled },
          };
          saveSettings(this.settings);
          this.pushFeed('system', p.enabled
            ? 'Click-through ON — HUD ignores the mouse. Ctrl+Shift+T to restore.'
            : 'Click-through off.');
        }),
        onLlmToken((p) => this.onAiToken(p.id, p.token)),
        onLlmDone((p) => this.onAiDone(p.id, p.text, p.tool_calls)),
        onLlmError((p) => this.onAiError(p.id, p.message)),
      ]);

      systemSpecs()
        .then((s) => {
          this.specs = s;
          this.emit();
        })
        .catch(() => undefined);

      sttAvailable()
        .then((ok) => {
          this.sttOk = ok;
          this.emit();
        })
        .catch(() => undefined);

      piperAvailable()
        .then((ok) => {
          this.piperOk = ok;
          if (!ok && this.settings.voice.engine === 'piper') {
            this.pushFeed('system', 'Local Piper voice not found — using Windows voices.');
          }
          this.emit();
        })
        .catch(() => undefined);
      void this.refreshPiperVoices();

      // The memory bank MUST be loaded before the journal watch starts, or
      // the bootstrap replay refolds history into an empty bank.
      try {
        const raw = await memoryLoad();
        if (raw) this.memory.load(JSON.parse(raw));
      } catch {
        /* keep the localStorage/blank bank */
      }
      this.memoryReady = true;

      void this.restartWatch();
      if (this.settings.hud.clickThrough) void setClickThrough(true).catch(() => undefined);

      void this.pollLm();
      setInterval(() => void this.pollLm(), 20_000);
    }

    // Restore any remembered trade lead silently (no re-announcement).
    this.tradeOpp = findOpportunities(this.marketMemory, {
      minProfitPerTon: this.settings.trade.minProfitPerTon,
      exclude: new Set(Object.keys(this.dismissedTrades)),
    })[0] ?? null;
    this.lastTradeKeyAnnounced = this.tradeOpp?.key ?? '';
    this.bioLead = this.bioTracker.leads(new Set(Object.keys(this.dismissedBio)))[0] ?? null;
    this.lastBioKeyAnnounced = this.bioLead?.key ?? '';

    // Heartbeat + gameLive refresh tick.
    setInterval(() => this.heartbeatTick(), 15_000);
    this.emit();
  }

  async restartWatch(): Promise<void> {
    if (!isTauri) return;
    this.bootstrapped = false;
    this.sm = new MissionStateManager();
    this.hb = new Heartbeat({ expiryWarnMin: this.settings.journal.expiryWarningMin });
    // Fresh telemetry baseline — the next Status.json snapshot re-establishes it
    // without firing hazard alerts about the previous session.
    this.statusTracker = new StatusTracker();
    this.ship = new ShipTracker();
    this.lastStatusAlertAt.clear();
    try {
      await startWatch(
        this.settings.journal.directory,
        this.settings.journal.bootstrapPreviousSessions,
      );
    } catch (e) {
      this.journalStatus = {
        ...this.journalStatus,
        ok: false,
        error: String(e),
      };
      this.emit();
    }
  }

  // ---------------------------------------------------------------- journal
  private onLines(lines: string[], live: boolean): void {
    for (const line of lines) {
      const ev = parseJournalLine(line);
      if (!ev) continue;
      // Ledger folds everything — LoadGame resets it, so replayed history
      // washes out and only the current game session remains.
      this.stats.apply(ev);
      this.saga.apply(ev);
      this.bioTracker.apply(ev);
      this.ship.apply(ev);
      this.materials.apply(ev);
      this.explore.apply(ev);
      // Teach the status tracker the fuel-tank size so it can report fuel %.
      if (ev.event === 'Loadout' && this.ship.current?.fuelCapacity) {
        this.statusTracker.setFuelCapacity(this.ship.current.fuelCapacity);
      }
      // Long-term memory folds everything too — its watermark makes bootstrap
      // replays no-ops, while genuinely new history (first run) is inherited.
      if (this.settings.memory.enabled && this.memoryReady) {
        const memEvents = this.memory.apply(ev);
        if (live && this.bootstrapped) {
          const at = Date.parse(ev.timestamp) || Date.now();
          for (const me of memEvents) this.pendingMemoryEvents.push({ ev: me, at });
        }
      }
      const changes = this.sm.apply(ev);
      if (live && this.bootstrapped) {
        this.announce(changes, ev.timestamp);
        this.tactical(ev);
        // Session over → distill it into long-term memory once the
        // chronicler (saga, scheduled below) has had its turn.
        if (ev.event === 'Shutdown' && this.settings.memory.enabled) {
          this.pendingReflectAt = Date.now() + 45_000;
          this.reflectRetries = 0;
          this.reflectManual = false;
        }
        if (ev.event === 'Docked') {
          this.maybeLedger();
          // Opt-in online route search: at most twice an hour, on docking.
          if (
            this.settings.trade.online &&
            Date.now() - this.lastRouteFetchAt > 30 * 60_000
          ) {
            void this.fetchRoute(false);
          }
        }
        // Session over → the chronicler files tonight's episode.
        if (ev.event === 'Shutdown' && this.settings.saga.enabled) {
          setTimeout(() => this.tellSaga(), 3000);
        }
      }
    }
    if (live) {
      this.lastGameActivity = Date.now();
      this.maybeAnnounceCg();
      if (this.bioTracker.dirty) this.recomputeBio(true);
      this.speakMemoryEvents();
      // Events may create stall conditions the heartbeat should see promptly.
      this.heartbeatNudges();
    } else if (this.bioTracker.dirty) {
      this.recomputeBio(false);
    }
    if (this.memory.dirty) this.persistMemory();
    this.persistTrackers();
    this.emit();
  }

  /** Persist the material + exploration ledgers to localStorage when changed. */
  private persistTrackers(): void {
    if (this.materials.dirty) {
      this.materials.dirty = false;
      try {
        localStorage.setItem('edmo.materials.v1', JSON.stringify(this.materials.toJSON()));
      } catch {
        /* still tracked in-session */
      }
    }
    if (this.explore.dirty) {
      this.explore.dirty = false;
      try {
        localStorage.setItem('edmo.explore.v1', JSON.stringify(this.explore.toJSON()));
      } catch {
        /* still tracked in-session */
      }
    }
  }

  // ------------------------------------------------------------- memory bank
  /**
   * Speak at most ONE queued memory remark, under deterministic gates:
   * per-key cooldown (engine), a global remark cooldown, and combat silence.
   * The model never decides this — flooding is structurally impossible.
   */
  private speakMemoryEvents(): void {
    if (!this.pendingMemoryEvents.length) return;
    // Keep only fresh candidates; stale gossip dies quietly.
    const now = Date.now();
    this.pendingMemoryEvents = this.pendingMemoryEvents.filter((p) => now - p.at < 5 * 60_000);
    if (!this.settings.memory.proactive) {
      this.pendingMemoryEvents = [];
      return;
    }
    if (now - this.lastCombatAt < 90_000) return; // not while being shot at
    const best = [...this.pendingMemoryEvents].sort((a, b) => b.ev.importance - a.ev.importance)[0];
    if (!best) return;
    const cooldown =
      best.ev.importance >= 3 ? 3 * 60_000 : this.settings.memory.remarkCooldownMin * 60_000;
    if (now - this.lastMemoryRemarkAt < cooldown) return; // keep queued — retry next batch
    if (!this.memory.gateAnnounce(best.ev.key, now)) {
      this.pendingMemoryEvents = this.pendingMemoryEvents.filter((p) => p !== best);
      return;
    }
    this.pendingMemoryEvents = this.pendingMemoryEvents.filter((p) => p !== best);
    this.lastMemoryRemarkAt = now;
    this.pushFeed('memory', `🧠 ${best.ev.text}`);
    this.speak(best.ev.text);
    this.addSeed(`Operator recalled: ${best.ev.text.slice(0, 120)}`);
    this.persistMemory();
  }

  private persistMemory(): void {
    if (this.memorySaving || !this.memory.dirty) return;
    this.memory.dirty = false;
    const text = JSON.stringify(this.memory.toJSON());
    if (!isTauri) {
      try {
        localStorage.setItem('edmo.memory.v1', text);
      } catch {
        /* bank still lives in-session */
      }
      return;
    }
    this.memorySaving = true;
    memorySave(text)
      .catch(() => {
        this.memory.dirty = true; // retry on the next tick
      })
      .finally(() => {
        this.memorySaving = false;
      });
  }

  // ------------------------------------------------------------ exobio leads
  private recomputeBio(announce: boolean): void {
    this.bioTracker.dirty = false;
    try {
      localStorage.setItem('edmo.bio.v1', JSON.stringify(this.bioTracker.toJSON()));
    } catch {
      /* still tracked in-session */
    }
    if (!this.settings.exobio.enabled) {
      this.bioLead = null;
      return;
    }
    const cutoff = Date.now() - 7 * 24 * 3600_000;
    for (const [k, at] of Object.entries(this.dismissedBio)) {
      if (at < cutoff) delete this.dismissedBio[k];
    }
    this.bioLead = this.bioTracker.leads(new Set(Object.keys(this.dismissedBio)))[0] ?? null;
    if (
      announce &&
      this.bioLead &&
      this.bioLead.key !== this.lastBioKeyAnnounced &&
      this.bioLead.inCurrentSystem
    ) {
      this.lastBioKeyAnnounced = this.bioLead.key;
      const b = this.bioLead;
      const genus = b.genuses.length ? ` (${b.genuses.slice(0, 3).join(', ')})` : '';
      const text = `Bio signals on ${b.body}: ${b.remaining} uncollected${genus}. Vista Genomics pays for those, commander.`;
      this.pushFeed('system', `🧬 ${text}`);
      this.speak(text);
    }
  }

  dismissBio(): void {
    if (!this.bioLead) return;
    this.dismissedBio[this.bioLead.key] = Date.now();
    try {
      localStorage.setItem('edmo.bio.dismissed.v1', JSON.stringify(this.dismissedBio));
    } catch {
      /* session-only dismissal */
    }
    this.bioLead = this.bioTracker.leads(new Set(Object.keys(this.dismissedBio)))[0] ?? null;
    this.emit();
  }

  // ------------------------------------------------------- tactical awareness
  /** Live combat/threat events that are not mission-state changes. */
  private tactical(ev: JournalEvent): void {
    const now = Date.now();
    switch (ev.event) {
      case 'ShipTargeted': {
        if (ev.TargetLocked !== true) return;
        const rank = typeof ev.PilotRank === 'string' ? ev.PilotRank : '';
        if (!['Dangerous', 'Deadly', 'Elite'].includes(rank)) return;
        const ship = (ev.Ship_Localised as string) ?? (ev.Ship as string) ?? 'contact';
        const key = `${ship}:${rank}`;
        const seen = this.recentThreats.get(key);
        if (seen !== undefined && now - seen < 3 * 60_000) return;
        this.recentThreats.set(key, now);
        const legal = typeof ev.LegalStatus === 'string' ? ev.LegalStatus : null;
        const text = `Contact: ${ship} — ${rank} pilot${legal ? `, ${legal.toLowerCase()}` : ''}. ${
          rank === 'Dangerous' ? 'Stay sharp.' : 'Disengage unless your shields are fresh.'
        }`;
        this.pushFeed('combat', text, { severity: rank === 'Dangerous' ? 'warn' : 'urgent' });
        if (rank !== 'Dangerous') this.speak(text);
        this.lastCombatAt = now;
        break;
      }
      case 'UnderAttack': {
        const target = typeof ev.Target === 'string' ? ev.Target : 'You';
        if (target === 'Fighter') return;
        this.lastCombatAt = now;
        if (now - this.lastUnderAttackNoteAt < 90_000) return;
        this.lastUnderAttackNoteAt = now;
        const text = 'Taking fire — watch your shields.';
        this.pushFeed('combat', text, { severity: 'urgent' });
        this.speak(text);
        break;
      }
      case 'Bounty':
        this.lastCombatAt = now;
        break;
      case 'DockingGranted': {
        // Pad number the instant control clears you — the single most-loved
        // voice-companion callout. Throttled so re-requests don't repeat it.
        const pad = typeof ev.LandingPad === 'number' ? ev.LandingPad : null;
        if (pad == null || now - this.lastPadAnnounced < 5_000) return;
        this.lastPadAnnounced = now;
        const station = typeof ev.StationName === 'string' ? ev.StationName : 'the station';
        const text = `Docking granted — pad ${pad}, commander.`;
        this.pushFeed('system', `🛬 ${text} (${station})`);
        this.speak(text);
        break;
      }
      case 'DockingDenied': {
        const reason = typeof ev.Reason === 'string' ? ev.Reason : '';
        const human: Record<string, string> = {
          NoSpace: 'no free pad',
          TooLarge: 'your ship is too large for this pad class',
          Hostile: 'you are hostile to this station',
          Offences: 'you have outstanding offences here',
          Distance: 'you are too far out — get closer and request again',
          ActiveFighter: 'recall your fighter first',
          NoReason: 'request denied',
        };
        const why = human[reason] ?? (reason ? reason : 'request denied');
        const text = `Docking denied — ${why}.`;
        this.pushFeed('system', `⛔ ${text}`);
        this.speak(text);
        break;
      }
      case 'FSDTarget': {
        // Next hyperspace target's star class — used for the fuel/scoop check.
        this.lastFsdStarClass = typeof ev.StarClass === 'string' ? ev.StarClass : this.lastFsdStarClass;
        break;
      }
      case 'StartJump': {
        // On a hyperspace jump, warn when fuel is low AND the destination star
        // can't refuel us (non-KGBFOAM) — the classic way expeditions strand.
        if (ev.JumpType !== 'Hyperspace') return;
        const starClass = typeof ev.StarClass === 'string' ? ev.StarClass : this.lastFsdStarClass;
        const st = this.statusTracker.current;
        const lowFuel = !!st && (st.lowFuel || (st.fuelPct != null && st.fuelPct < 0.25));
        if (lowFuel && !isScoopableStar(starClass ?? undefined)) {
          const text = `Fuel is low and the next star (class ${starClass ?? '?'}) can't be scooped — plot to a scoopable star before you strand.`;
          this.pushFeed('nudge', text, { severity: 'urgent' });
          this.speak(text);
          this.addSeed(`Close fuel call jumping to a class ${starClass ?? '?'} star`);
        }
        break;
      }
      case 'LoadGame':
        // New game session — the mining acknowledgements start fresh.
        this.sessionOreAnnounced.clear();
        this.oreMilestonesDone.clear();
        break;
      case 'SupercruiseExit': {
        // Dropping onto a ring is the start of a shift — greet it, once.
        if (ev.BodyType !== 'PlanetaryRing') return;
        if (now - this.lastRingGreetAt < 30 * 60_000) return;
        this.lastRingGreetAt = now;
        const body = typeof ev.Body === 'string' ? ev.Body : 'the ring';
        const lines = [
          `On the ring at ${body}. Call the rocks, commander — I'll keep the tally.`,
          `Dropping into ${body}. Quiet out here — just us and the ice.`,
          `${body}, then. Prospector's ready when you are.`,
        ];
        const text = lines[Math.floor(Math.random() * lines.length)];
        this.pushFeed('system', `⛏ ${text}`);
        this.speak(text);
        this.lastMiningSpokeAt = now;
        break;
      }
      case 'MiningRefined': {
        this.lastMiningAt = now;
        const ore = (ev.Type_Localised as string) ?? (ev.Type as string) ?? 'ore';
        // Session tonnage milestones — the shift-work feeling ("25 tonnes,
        // steady going"). Exact-match so bootstrap replays can never re-fire.
        for (const m of [10, 25, 50, 100, 200, 400]) {
          if (this.stats.refinedOre === m && !this.oreMilestonesDone.has(m)) {
            this.oreMilestonesDone.add(m);
            const mix = this.stats.topOres().join(' and ');
            const text = `${m} tonnes refined this session${mix ? ` — mostly ${mix}` : ''}. Steady work, commander.`;
            this.pushFeed('system', `⛏ ${text}`);
            this.speak(text);
            this.lastMiningSpokeAt = now;
            this.addSeed(`Passed the ${m}-tonne refined mark mining${mix ? ` (${mix})` : ''}`);
            return;
          }
        }
        // First of each ore this session — a quiet acknowledgement (max 4,
        // spoken only if the operator hasn't just said something).
        if (
          (this.stats.oreCounts[ore] ?? 0) === 1 &&
          !this.sessionOreAnnounced.has(ore) &&
          this.sessionOreAnnounced.size < 4
        ) {
          this.sessionOreAnnounced.add(ore);
          const text =
            this.stats.refinedOre <= 1
              ? `Refinery's live — first ${ore} coming through.`
              : `First ${ore} in the refinery.`;
          this.pushFeed('system', `⛏ ${text}`);
          if (now - this.lastMiningSpokeAt > 45_000) {
            this.speak(text);
            this.lastMiningSpokeAt = now;
          }
        }
        break;
      }
      case 'ProspectedAsteroid': {
        this.lastMiningAt = now;
        const lode =
          (ev.MotherlodeMaterial_Localised as string) ?? (ev.MotherlodeMaterial as string) ?? null;
        if (lode) {
          if (now - this.lastProspectAt < 20_000) return;
          this.lastProspectAt = now;
          const text = `Motherlode: ${lode} — crack this one.`;
          this.pushFeed('system', `⛏ ${text}`);
          this.speak(text);
          return;
        }
        // Call out rocks rich in an ore a mission needs — or, with no mining
        // contract active, anything genuinely worth the limpets: the operator
        // shouldn't go mute just because nobody is paying for the ore.
        const mats = Array.isArray(ev.Materials)
          ? (ev.Materials as Array<{ Name?: string; Name_Localised?: string; Proportion?: number }>)
          : [];
        const wanted = this.sm
          .activeMissions()
          .filter((m) => m.category === 'Mining' && m.commodity)
          .map((m) => normalizeCommodity(m.commodity!.localised));
        for (const mat of mats) {
          const name = mat.Name_Localised ?? mat.Name ?? '';
          const pct = typeof mat.Proportion === 'number' ? mat.Proportion : 0;
          if (pct >= 20 && wanted.includes(normalizeCommodity(name))) {
            if (now - this.lastProspectAt < 45_000) return;
            this.lastProspectAt = now;
            const text = `Good rock: ${Math.round(pct)}% ${name}.`;
            this.pushFeed('system', `⛏ ${text}`);
            this.speak(text);
            return;
          }
        }
        // High-value ores get called at 25%, anything at 35% — throttled
        // hard (90 s) so a busy prospector never becomes a commentary track.
        const precious = /platinum|painite|osmium|low temperature diamond|alexandrite|grandidierite|musgravite|monazite|serendibite|benitoite|rhodplumsite/i;
        for (const mat of mats) {
          const name = mat.Name_Localised ?? mat.Name ?? '';
          const pct = typeof mat.Proportion === 'number' ? mat.Proportion : 0;
          if (pct >= 35 || (pct >= 25 && precious.test(name))) {
            if (now - this.lastProspectAt < 90_000) return;
            this.lastProspectAt = now;
            const text = `That one's worth the limpets — ${Math.round(pct)}% ${name}.`;
            this.pushFeed('system', `⛏ ${text}`);
            this.speak(text);
            this.lastMiningSpokeAt = now;
            return;
          }
        }
        break;
      }
      case 'ReceiveText': {
        if (ev.Channel !== 'npc') return;
        const code = typeof ev.Message === 'string' ? ev.Message : '';
        const said = (ev.Message_Localised as string) ?? '';
        if (!said) return;
        if (/^\$(Pirate|Interdiction|CargoHunter|PassengerHunter)/.test(code)) {
          this.lastCombatAt = now;
          this.pushFeed('combat', `Hostile on comms: “${said}”`, { severity: 'warn' });
          this.addSeed(`A hostile hailed the ship: "${said}"`);
          return;
        }
        // Ambient world texture (cruise liners, military convoys, police,
        // fleeing deserters…) — collected silently as story material. Station
        // plumbing (docking chatter, no-fire-zone, channel joins) is noise.
        if (/^\$(COMMS_entered|STATION_|DockingChatter)/.test(code)) return;
        const codeKey = /^\$([A-Za-z_]+)/.exec(code)?.[1] ?? code;
        const seen = this.commsSeen.get(codeKey);
        if (seen !== undefined && now - seen < 30 * 60_000) return;
        this.commsSeen.set(codeKey, now);
        const from = (ev.From_Localised as string) || (ev.From as string) || 'unknown vessel';
        this.recentComms.push({ text: `${from}: "${said}"`, at: now });
        if (this.recentComms.length > 10) this.recentComms = this.recentComms.slice(-10);
        break;
      }
      default:
        break;
    }
  }

  private addSeed(text: string): void {
    this.seeds.push({ text, at: Date.now() });
    if (this.seeds.length > 12) this.seeds = this.seeds.slice(-12);
  }

  /** Seeds younger than two hours — stale gossip repeats itself. */
  private freshSeeds(): string[] {
    const cutoff = Date.now() - 2 * 3600_000;
    return this.seeds.filter((s) => s.at > cutoff).map((s) => s.text);
  }

  /** What the commander is doing right now, when the journal makes it obvious. */
  private currentActivity(): string | null {
    if (Date.now() - this.lastMiningAt < 10 * 60_000) {
      const ores = this.stats.topOres();
      return `mining in ${this.sm.location.system}${
        this.stats.refinedOre
          ? ` — ${this.stats.refinedOre} t refined this session${ores.length ? ` (mostly ${ores.join(', ')})` : ''}`
          : ''
      }`;
    }
    // The journal is quiet, but the operator may have SEEN what's going on.
    if (this.glanceActivity && Date.now() - this.glanceActivityAt < 8 * 60_000) {
      return `${this.glanceActivity} (seen on screen)`;
    }
    return null;
  }

  private maybeLedger(): void {
    const earned = this.stats.earnedTotal();
    if (earned === this.ledgerEarnedMark) return;
    if (Date.now() - this.lastLedgerAt < 10 * 60_000) return;
    const text = this.stats.ledgerSummary();
    if (!text) return;
    this.ledgerEarnedMark = earned;
    this.lastLedgerAt = Date.now();
    this.pushFeed('system', text);
    this.speak(text);
  }

  private maybeAnnounceCg(): void {
    if (!this.bootstrapped) return;
    for (const cg of this.sm.communityGoals) {
      if (cg.complete || this.cgAnnounced.has(cg.id)) continue;
      this.cgAnnounced.add(cg.id);
      const expiry = cg.expiry
        ? ` Ends in ${Math.max(0, Math.round((Date.parse(cg.expiry) - Date.now()) / 3_600_000))}h.`
        : '';
      const bonus = cg.bonus ? ` Bonus pool ${cg.bonus.toLocaleString('en-US')} cr.` : '';
      const you = cg.playerContribution > 0 ? ` You're in for ${cg.playerContribution.toLocaleString('en-US')}.` : '';
      this.pushFeed(
        'system',
        `📢 Community Goal: "${cg.title}" — ${cg.market} in ${cg.system}. ${cg.contributors.toLocaleString('en-US')} pilots contributing.${bonus}${expiry}${you}`,
      );
      this.speak(`A community goal is running: ${cg.title}, at ${cg.market} in ${cg.system}.`);
      this.addSeed(`A community goal "${cg.title}" is running at ${cg.market} in ${cg.system}`);
    }
  }

  private onBootstrapDone(): void {
    this.bootstrapped = true;
    const n = this.sm.activeMissions().length;
    this.pushFeed(
      'system',
      n > 0
        ? `Journal connected — ${n} active mission${n === 1 ? '' : 's'} restored.`
        : 'Journal connected — no active missions.',
    );
    this.maybeAnnounceCg();
    this.emit();
  }

  private onSnapshotFile(name: string, text: string): void {
    // Count as game liveness only if the snapshot itself is fresh — at app
    // start every snapshot file is emitted once even when ED is closed, and a
    // stale Status.json must not wake the heartbeat (it would speak nudges
    // about a session that ended hours ago).
    try {
      const ts = Date.parse((JSON.parse(text) as { timestamp?: string }).timestamp ?? '');
      if (!Number.isNaN(ts) && Math.abs(Date.now() - ts) < 120_000) {
        this.lastGameActivity = Date.now();
      }
    } catch {
      /* unparseable snapshot — no liveness signal */
    }
    if (name === 'Missions.json') {
      const evs = parseJournalLines(text);
      if (evs.length) this.sm.reconcile(evs[0]);
    } else if (name === 'NavRoute.json') {
      try {
        const nav = JSON.parse(text) as { Route?: Array<{ StarSystem?: string }> };
        const route = nav.Route ?? [];
        this.navRouteJumps = Math.max(0, route.length - 1);
        this.navRouteDest = route.length ? (route[route.length - 1].StarSystem ?? null) : null;
      } catch {
        /* keep last-good route */
      }
    }
    else if (name === 'Market.json') {
      try {
        const rec = parseMarketSnapshot(JSON.parse(text));
        if (rec && this.settings.trade.enabled) {
          this.marketMemory.record(rec);
          try {
            localStorage.setItem('edmo.markets.v1', JSON.stringify(this.marketMemory.toJSON()));
          } catch {
            /* memory still works in-session */
          }
          this.recomputeTrade();
        }
      } catch {
        /* partial write — next snapshot wins */
      }
    } else if (name === 'Status.json') {
      try {
        const ev = JSON.parse(text) as JournalEvent;
        if (ev && ev.event === 'Status') {
          const alerts = this.statusTracker.apply(ev);
          // Only voice hazards for a live session — a stale startup snapshot
          // just establishes the baseline (the tracker never alerts on its
          // first snapshot anyway).
          if (this.bootstrapped && Date.now() - this.lastGameActivity < GAME_LIVE_WINDOW_MS) {
            this.handleStatusAlerts(alerts);
          }
        }
      } catch {
        /* partial write — next snapshot wins */
      }
    } else if (name === 'Cargo.json') {
      try {
        const c = JSON.parse(text) as { Count?: number };
        this.ship.setCargo(typeof c.Count === 'number' ? c.Count : undefined);
      } catch {
        /* keep last-good cargo */
      }
    }
    // ShipLocker/Backpack/Outfitting/Shipyard/ModulesInfo/FCMaterials refresh
    // game liveness (handled above) and are available for future features.
    this.emit();
  }

  /** Speak Status.json safety alerts under a per-kind cooldown. */
  private handleStatusAlerts(alerts: StatusAlert[]): void {
    if (!alerts.length) return;
    const now = Date.now();
    for (const a of alerts) {
      const last = this.lastStatusAlertAt.get(a.kind);
      if (last !== undefined && now - last < 60_000) continue;
      this.lastStatusAlertAt.set(a.kind, now);
      this.pushFeed('combat', a.message, { severity: a.severity });
      this.speak(a.message);
      if (a.kind === 'interdiction' || a.kind === 'shields-down') this.lastCombatAt = now;
    }
  }

  // ------------------------------------------------------------ trade leads
  private recomputeTrade(): void {
    if (!this.settings.trade.enabled) {
      this.tradeOpp = null;
      return;
    }
    // Expire day-old dismissals so a still-valid lead can resurface.
    const cutoff = Date.now() - 24 * 3600_000;
    for (const [k, at] of Object.entries(this.dismissedTrades)) {
      if (at < cutoff) delete this.dismissedTrades[k];
    }
    const opps = findOpportunities(this.marketMemory, {
      minProfitPerTon: this.settings.trade.minProfitPerTon,
      exclude: new Set(Object.keys(this.dismissedTrades)),
    });
    this.tradeOpp = opps[0] ?? null;
    if (this.tradeOpp && this.tradeOpp.key !== this.lastTradeKeyAnnounced) {
      this.lastTradeKeyAnnounced = this.tradeOpp.key;
      const o = this.tradeOpp;
      const text = `Trade lead: ${o.commodity} — buy at ${o.buy.station} (${o.buy.system}) for ${o.buy.price.toLocaleString('en-US')}, sell at ${o.sell.station} (${o.sell.system}) for ${o.sell.price.toLocaleString('en-US')} · ${o.profitPerTon.toLocaleString('en-US')} cr/t.`;
      this.pushFeed('system', `💰 ${text}`);
      this.speak(
        `Trade lead, commander: ${o.commodity}. Buy at ${o.buy.station}, sell at ${o.sell.station} — about ${Math.round(o.profitPerTon / 100) * 100} credits a ton.`,
      );
      this.addSeed(`Spotted a trade lead: ${o.commodity}, ${o.buy.station} → ${o.sell.station}, ${o.profitPerTon.toLocaleString('en-US')} cr/t`);
    }
  }

  /** Query Spansh (opt-in) for a profitable route from the current station. */
  async fetchRoute(manual: boolean): Promise<void> {
    if (!isTauri || this.routeBusy) return;
    if (!this.settings.trade.online) {
      if (manual) {
        this.pushFeed(
          'system',
          'The route planner asks Spansh (community price data) and sends only your current system name. Flip it on under Trade leads below, then hit 🔄 again.',
        );
        this.setSettingsOpen(true);
      }
      this.emit();
      return;
    }
    const system = this.sm.location.system;
    if (!system || system === 'unknown') return;
    // Spansh REQUIRES a real station as the route start — and a fleet carrier
    // is not one (they're excluded from its market graph, so asking "from
    // V6W-TTJ" politely returns nothing). Docked on a carrier or in space,
    // fall back to the last real station market we saw in this system.
    const carrierName = /^[A-Z0-9]{3}-[A-Z0-9]{3}$/;
    let station = this.sm.location.station ?? null;
    if (!station || carrierName.test(station)) {
      const fallback = this.marketMemory.stationIn(system);
      if (fallback) {
        if (manual && station) {
          this.pushFeed('system', `You're on the carrier — planning the route from ${fallback} instead.`);
        }
        station = fallback;
      } else {
        // No usable start (on a carrier, or never docked here) — be honest,
        // don't let an empty/rejected reply masquerade as "no routes".
        this.pushFeed(
          'system',
          station
            ? `Routes can't start from a fleet carrier, commander — dock at a station market in ${system} once so I learn a starting point.`
            : `The route planner needs a station market as a starting point — dock somewhere in ${system} with a market and ask again.`,
        );
        this.emit();
        return;
      }
    }
    this.routeBusy = true;
    this.lastRouteFetchAt = Date.now();
    // Large-pad hulls (Cutter, Panther Clipper…) can't dock at medium/small
    // stops — constrain the planner so it never routes us somewhere we'd be
    // turned away at the pad.
    const requiresLargePad = shipRequiresLargePad(this.ship.current?.ship);
    if (manual)
      this.pushFeed(
        'system',
        `Asking Spansh for routes from ${station ?? system}…${requiresLargePad ? ' (large-pad only)' : ''} (takes up to a minute)`,
      );
    this.emit();
    try {
      const raw = await spanshTradeRoute({
        system,
        station,
        maxCargo: Math.max(8, this.stats.cargoCapacity || 64),
        capital: Math.max(1_000_000, this.stats.startCredits + this.stats.earnedTotal()),
        maxHopDistance: this.settings.trade.routeMaxHopLy,
        maxHops: 2,
        requiresLargePad,
      });
      const route = parseSpanshRoute(raw);
      this.route = route;
      this.routeIdx = 0;
      if (route) {
        const text = routeSummary(route);
        this.pushFeed('system', `🔄 ${text} (data: Spansh)`);
        this.speak(text);
        this.addSeed(`Community data pointed to a trade route: ${route.hops[0].commodity} out of ${route.hops[0].fromStation}`);
        if (this.settings.trade.autoCopyRoute) void this.copyWaypoint(0, true);
      } else {
        this.pushFeed('system', 'Spansh found no profitable route from here within the hop range.');
      }
    } catch (e) {
      this.pushFeed('system', `Route search failed: ${String(e)}`);
    } finally {
      this.routeBusy = false;
      this.emit();
    }
  }

  dismissRoute(): void {
    this.route = null;
    this.routeIdx = 0;
    this.emit();
  }

  /** Copy a hop's destination system for galaxy-map pasting (Ctrl+V there). */
  async copyWaypoint(idx: number, spoken = false): Promise<void> {
    const hop = this.route?.hops[idx];
    if (!hop) return;
    try {
      await copyText(hop.toSystem);
      this.pushFeed('system', `📋 Copied "${hop.toSystem}" — galaxy map → search → Ctrl+V.`);
      if (spoken)
        this.speak(`Waypoint ${hop.toSystem} is on your clipboard — paste it in the galaxy map.`);
    } catch (e) {
      this.pushFeed('system', `Clipboard failed: ${String(e)}`);
    }
    this.emit();
  }

  /** Advance route progress when the commander jumps into the next waypoint. */
  private onJumpForRoute(): void {
    const r = this.route;
    if (!r || this.routeIdx >= r.hops.length) return;
    const here = this.sm.location.system.toLowerCase();
    if (here !== r.hops[this.routeIdx].toSystem.toLowerCase()) return;
    this.routeIdx += 1;
    if (this.routeIdx < r.hops.length) {
      const next = r.hops[this.routeIdx];
      const said = `Waypoint reached. Next: ${next.commodity} to ${next.toStation}, ${next.toSystem}.`;
      this.pushFeed('system', `🔄 ${said}`);
      this.speak(said);
      if (this.settings.trade.autoCopyRoute) void this.copyWaypoint(this.routeIdx);
    } else {
      const done = 'Final trade waypoint reached — route complete, commander. Good business.';
      this.pushFeed('system', `🔄 ${done}`);
      this.speak(done);
      this.addSeed(`Completed a trade route for ~${r.totalProfit.toLocaleString('en-US')} cr`);
    }
  }

  dismissTrade(): void {
    if (!this.tradeOpp) return;
    this.dismissedTrades[this.tradeOpp.key] = Date.now();
    try {
      localStorage.setItem('edmo.trades.dismissed.v1', JSON.stringify(this.dismissedTrades));
    } catch {
      /* dismissal still holds for this session */
    }
    this.recomputeTrade();
    this.emit();
  }

  /** Turn live StateChanges into feed entries + speech (mirrors replay.ts). */
  private announce(changes: StateChange[], time: string): void {
    const arrivals = changes
      .filter((c) => c.kind === 'arrivedAtDestination' && c.mission)
      .map((c) => c.mission!);
    if (arrivals.length) {
      const text = arrivalNotice(arrivals);
      this.pushFeed('arrival', text, { time });
      this.speak(text);
    }
    for (const c of changes) {
      if (c.kind === 'jump') this.onJumpForRoute();
      const m = c.mission;
      if (!m) continue;
      let kind: FeedKind | null = null;
      let text = '';
      switch (c.kind) {
        case 'accepted':
          // Personal, lively briefing (LLM voice with template fallback)
          // replaces the dry form-letter line; facts live on the card.
          this.personalBriefing(m);
          break;
        case 'redirected':
          kind = 'redirect';
          text = redirectNotice(m);
          break;
        case 'completed':
          kind = 'complete';
          text = completionNotice(m);
          break;
        case 'cargo':
          kind = 'cargo';
          // Estimated acquisitions (refined/bought/scooped) tick the card bar
          // silently — announce only the moment the hold is complete.
          if (c.detail === 'collected') {
            text =
              m.cargo && m.cargo.collected >= m.cargo.total && m.cargo.total > 0
                ? cargoNotice(m)
                : '';
          } else {
            text = cargoNotice(m);
          }
          break;
        case 'failed':
          kind = 'failed';
          text = `Mission FAILED: ${m.title}.`;
          break;
        case 'abandoned':
          kind = 'abandoned';
          text = `Mission abandoned: ${m.title}.`;
          break;
        default:
          break;
      }
      if (kind && text) {
        this.pushFeed(kind, text, { time, missionId: m.id });
        if (kind !== 'cargo' || /loaded|delivered/i.test(text)) this.speak(text);
      }
      // BGS consequences arrive on the completion event (StateChange detail).
      if (c.kind === 'completed') {
        if (c.detail) this.pushFeed('system', `BGS: ${c.detail}`);
        const reduced =
          m.boardReward && m.reward < m.boardReward * 0.95
            ? `, taking a reduced package ${(m.boardReward - m.reward).toLocaleString('en-US')} cr under board`
            : '';
        this.addSeed(
          `Completed "${m.title}" for ${m.faction ?? 'a faction'} (${m.reward.toLocaleString('en-US')} cr${reduced})${c.detail ? ` — ${c.detail}` : ''}`,
        );
      }
      // Nemesis continuity: remember eliminated named targets.
      if (c.kind === 'redirected' && m.category === 'Assassinate' && m.target) {
        this.addSeed(`Eliminated ${m.target.name} (${m.target.type}) for ${m.faction ?? 'a client'}`);
      }
      // Failures sting — and make for honest storytelling.
      if (c.kind === 'failed' || c.kind === 'abandoned') {
        this.addSeed(`${c.kind === 'failed' ? 'FAILED' : 'Abandoned'} mission "${m.title}" for ${m.faction ?? 'a client'}`);
      }
      // Risk check when taking on new combat work.
      if (c.kind === 'accepted' && (m.category === 'Assassinate' || m.category === 'Massacre')) {
        const risk = this.stats.riskNote();
        if (risk) this.pushFeed('system', risk);
      }
      if (c.kind === 'accepted') {
        if (m.passengers?.wanted) {
          const warn = 'WANTED passengers aboard — avoid station scans; Silent Running on approach helps.';
          this.pushFeed('system', `⚠ ${warn}`);
          this.speak(warn);
        }
        if (m.commodity && !m.cargo) {
          this.pushFeed(
            'system',
            `🎁 Client requires ${m.commodity.count} ${m.commodity.localised} — buy it BEFORE departing.`,
          );
        }
        const shared = this.sm
          .activeMissions()
          .filter(
            (o) =>
              o.id !== m.id &&
              o.destination &&
              m.destination &&
              o.destination.system.toLowerCase() === m.destination.system.toLowerCase(),
          );
        if (shared.length) {
          this.pushFeed(
            'system',
            `Bundles with ${shared.length} other mission(s) heading to ${m.destination!.system} — combine the hand-ins.`,
          );
        }
      }
      // Often follow a fresh accept with a bit of invented scuttlebutt —
      // passengers and places especially deserve an introduction.
      if (
        c.kind === 'accepted' &&
        this.settings.chatter.enabled &&
        Math.random() < (m.passengers ? 0.6 : 0.45) &&
        Date.now() - this.lastStoryAt > 3 * 60_000
      ) {
        const accepted = m;
        setTimeout(() => this.tellStory(accepted), 12_000);
      }
      // A completed objective is a story moment too ("we got them, commander").
      if (
        c.kind === 'redirected' &&
        this.settings.chatter.enabled &&
        Math.random() < 0.25 &&
        Date.now() - this.lastStoryAt > 3 * 60_000
      ) {
        setTimeout(() => this.tellStory(), 15_000);
      }
    }
  }

  private heartbeatTick(): void {
    this.heartbeatNudges();
    this.maybeChatter();
    this.maybeReflect();
    this.maybeGlance();
    this.speakMemoryEvents();
    if (this.memory.dirty) this.persistMemory();
    // Watchdog: any entry still "streaming" that no active request owns is an
    // orphan — finalize it so the cursor never blinks forever.
    for (const e of this.feed) {
      if (e.streaming && e.id !== this.currentAiEntry?.id) {
        if (!e.text) e.text = '[interrupted]';
        e.streaming = false;
      }
    }
    this.emit(); // also refreshes gameLive + countdown-independent bits
  }

  // ------------------------------------------------------- session reflection
  /** Digest of the session for the memory-keeper — true facts only. */
  private reflectionDigest(): string | null {
    const day = this.saga.latestDay();
    const beats = day ? this.saga.beatsForDay(day) : [];
    const ledger = this.stats.ledgerSummary();
    if (beats.length < 3 && !ledger) return null;
    const lines: string[] = [
      `Session digest for ${this.memory.cmdr ? `CMDR ${this.memory.cmdr}` : 'the commander'}${
        this.memory.shipName ? `, ship at log end: ${this.memory.shipName}` : ''
      }${day ? `, ${day}` : ''}:`,
    ];
    if (ledger) lines.push(`- ${ledger}`);
    for (const b of beats.slice(-24)) lines.push(`- ${b.text}`);
    for (const s of this.freshSeeds().slice(-6)) lines.push(`- ${s}`);
    return lines.join('\n');
  }

  private maybeReflect(): void {
    if (!this.pendingReflectAt || Date.now() < this.pendingReflectAt) return;
    if (this.lmBusy) return; // saga episode still narrating — next tick
    this.pendingReflectAt = 0;
    this.runReflection(this.reflectManual);
  }

  /** Distill the session into durable memory notes (silent LLM call). */
  runReflection(manual: boolean): void {
    if (this.lmBusy) {
      if (manual) this.pushFeed('system', 'The operator is mid-thought — try again in a moment.');
      // Automatic path: retry twice at one-minute intervals, then drop.
      else if (this.reflectRetries < 2) {
        this.reflectRetries += 1;
        this.pendingReflectAt = Date.now() + 60_000;
      }
      this.emit();
      return;
    }
    const digest = this.reflectionDigest();
    if (!digest) {
      if (manual) this.pushFeed('system', 'Nothing worth remembering yet — fly a little first.');
      this.emit();
      return;
    }
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model) {
      if (manual) this.pushFeed('system', 'Memory distillation needs LM Studio running.');
      this.emit();
      return;
    }
    this.reflectManual = manual;
    this.startLlm(null, 'reflect', buildReflectionChat(
      digest,
      this.memory.cmdr,
      this.memory.notes.map((n) => n.text),
    ), 0.3, 3000, REFLECTION_FORMAT);
  }

  // ------------------------------------------------------------ screen sight
  /**
   * Periodic screen glance (opt-in). Gates, in order: setting on, shell +
   * LM up and idle, vision-capable model, game live, interval elapsed, no
   * recent combat (GPU contention + wrong moment). The glance itself is
   * silent — speaking is decided in onGlanceReply under its own cooldowns.
   */
  /** Record what the vision pipeline just did/decided, with a timestamp. */
  private noteGlance(note: string): void {
    this.glanceLog = `${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} — ${note}`;
  }

  /** Live diagnostic for Settings: last outcome, or why the glance is waiting. */
  private visionStatusLine(): string {
    const now = Date.now();
    const waiting: string[] = [];
    if (!this.lmOk) waiting.push('LM Studio offline');
    else if (!this.activeModelIsVlm()) waiting.push('active model has no vision');
    if (now - this.lastGameActivity >= GAME_LIVE_WINDOW_MS)
      waiting.push('game looks idle (no journal/status updates)');
    const cool = this.settings.vision.intervalMin * 60_000 - (now - this.lastGlanceAt);
    if (cool > 0) waiting.push(`next glance in ${Math.ceil(cool / 60_000)}m`);
    if (now - this.lastCombatAt < 2 * 60_000) waiting.push('combat hold');
    const state = waiting.length ? `waiting: ${waiting.join(' · ')}` : 'glance due on next tick';
    return this.glanceLog ? `${this.glanceLog} · ${state}` : state;
  }

  private maybeGlance(): void {
    if (!this.settings.vision.enabled || !isTauri) return;
    if (!this.lmOk || this.lmBusy || this.glanceInFlight) return;
    if (!this.activeModelIsVlm()) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    if (Date.now() - this.lastGlanceAt < this.settings.vision.intervalMin * 60_000) return;
    if (Date.now() - this.lastCombatAt < 2 * 60_000) return;
    void this.glance(false);
  }

  /** One glance now; manual = triggered from Settings, always reports back. */
  async glance(manual: boolean): Promise<void> {
    if (this.glanceInFlight) return;
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model) {
      if (manual) this.pushFeed('system', 'Screen glances need LM Studio running.');
      this.emit();
      return;
    }
    if (manual && !this.activeModelIsVlm()) {
      this.pushFeed('system', `The active model (${model}) reports no vision support — pick a VLM in the model list.`);
      this.emit();
      return;
    }
    this.glanceInFlight = true;
    this.glanceManual = manual;
    this.lastGlanceAt = Date.now();
    try {
      const dataUri = await captureScreen();
      if (this.lmBusy) return; // something else grabbed the slot mid-capture
      const cmdr = this.sm.commanderName || undefined;
      // Copilot commentary: the periodic glance SPEAKS about what it sees
      // instead of returning a silent danger verdict. The glance timer
      // (vision.intervalMin) already caps how often this can happen, so it
      // only needs a short GAP from the last spoken beat — requiring a full
      // chatter interval of silence meant commentary ~never fired in active
      // play (accept/complete stories keep resetting that clock). A manual
      // "Glance now" always gives the rich beat when commentary is on.
      const ambientGapMs = Math.min(3, Math.max(1, this.settings.chatter.intervalMin)) * 60_000;
      const wantCommentary =
        this.settings.vision.commentary &&
        (manual ||
          (this.settings.chatter.enabled && Date.now() - this.lastStoryAt >= ambientGapMs));

      // Assemble the stage-2 request (spoken commentary or silent verdict) but
      // don't fire it yet — with describeFirst on, a stage-1 screen reading runs
      // first and the operator then speaks from that reading.
      let pv: PendingVision;
      if (wantCommentary) {
        this.glanceManual = false; // consumed here; must not leak into the next verdict glance
        const activeMissions = this.sm.activeMissions().slice(0, 4);
        const missionLines = activeMissions.map(
          (m) =>
            `- ${m.category} "${m.title}"${m.destination ? ` → ${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}` : ''}`,
        );
        // Curated facts, journal-truth first. Deliberately NOT contextExtras():
        // background lines (community goals, memory recalls, trade leads) gave
        // the model places to hallucinate the commander into — it once put the
        // pilot "filling out paperwork at Peters Base" mid-flight because a CG
        // line mentioned Peters Base.
        const st = this.statusTracker.current;
        const selectedTarget = st?.supercruise ? st.destination?.name?.trim() : '';
        const knownStationTarget = !!selectedTarget && (
          activeMissions.some((m) => m.destination?.station?.toLowerCase() === selectedTarget.toLowerCase()) ||
          this.sm.getState().system?.signals.some(
            (signal) => signal.isStation && signal.name.toLowerCase() === selectedTarget.toLowerCase(),
          )
        );
        const mode = st?.docked
          ? `docked${this.sm.location.station ? ` at ${this.sm.location.station}` : ''}`
          : st?.onFoot
            ? 'on foot'
            : st?.supercruise
              ? selectedTarget
                ? `in supercruise toward ${selectedTarget}${knownStationTarget ? ' station' : ''}`
                : 'in supercruise'
              : 'flying in normal space';
        const facts = [
          `JOURNAL TRUTH: the commander is ${mode} in ${this.sm.location.system}.`,
          ...(selectedTarget
            ? [`Selected navigation target: ${selectedTarget}${knownStationTarget ? ' (station/outpost)' : ''}. The commander is travelling toward it, not docked there.`]
            : []),
          ...(st?.fuelPct != null
            ? [
                `AUTHORITATIVE TELEMETRY: main fuel ${Math.round(st.fuelPct * 100)}%${st.lowFuel || st.fuelPct < 0.25 ? ' (LOW FUEL).' : ' (healthy; no fuel warning or monitoring advice).'}`,
              ]
            : []),
          ...(this.ship.current ? [`Loadout: ${describeShip(this.ship.current)}.`] : []),
          ...(this.navRouteJumps > 0 && this.navRouteDest
            ? [`Plotted route: ${this.navRouteJumps} jump(s) to ${this.navRouteDest}.`]
            : []),
          ...(missionLines.length ? ['Active missions:', ...missionLines] : []),
        ].join('\n');
        // A copilot varies its register: sometimes the view, sometimes the
        // leg of the journey, sometimes the job. Pick from what's actually
        // happening; never repeat the previous angle when there's a choice.
        const eligible: CommentaryAngle[] = ['view'];
        if (st?.supercruise || this.navRouteJumps > 0) eligible.push('travel');
        if (activeMissions.length) eligible.push('mission');
        if (st?.docked) eligible.push('work');
        const pool = eligible.filter((a) => a !== this.lastCommentaryAngle);
        const angle = (pool.length ? pool : eligible)[
          Math.floor(Math.random() * (pool.length || eligible.length))
        ];
        this.lastCommentaryAngle = angle;
        pv = { mode: 'commentary', dataUri, cmdr, facts, angle, recent: this.recentStories };
      } else {
        const contextBits: string[] = [];
        if (this.sm.location.system !== 'unknown')
          contextBits.push(`Journal says the commander is in ${this.sm.location.system}${this.sm.docked ? ', docked' : ''}.`);
        const st = this.statusTracker.current;
        const selectedTarget = st?.supercruise ? st.destination?.name?.trim() : '';
        if (st?.fuelPct != null)
          contextBits.push(
            `AUTHORITATIVE TELEMETRY: main fuel ${Math.round(st.fuelPct * 100)}%${st.lowFuel || st.fuelPct < 0.25 ? ' (LOW FUEL).' : ' (healthy; not notable).'}`,
          );
        if (selectedTarget)
          contextBits.push(`Selected navigation target: ${selectedTarget}. The commander is travelling toward it in supercruise, not docked there.`);
        pv = { mode: 'verdict', dataUri, cmdr, context: contextBits.join(' ') };
      }

      // Stage 1: read the screen into a structured description, then speak from
      // it (onSceneDescribed). With describeFirst off, hand the raw image
      // straight to the operator — the original single-pass behaviour.
      if (this.settings.vision.describeFirst) {
        this.noteGlance('reading the screen…');
        this.startLlm(
          null,
          'describe',
          buildSceneDescriptionMessages(dataUri, cmdr) as unknown as ChatMessage[],
          0.15,
          2000, // small JSON, but reasoning models think first; truncation just falls back to the image
          SCENE_FORMAT,
        );
        // Set AFTER startLlm — its resolveOrphan() clears any stale pendingVision.
        this.pendingVision = pv;
      } else {
        this.fireVisionStage(pv, null);
      }
    } catch (e) {
      this.noteGlance(`capture failed: ${String(e).slice(0, 80)}`);
      if (manual) this.pushFeed('system', `Screen glance failed: ${String(e)}`);
      this.emit();
    } finally {
      this.glanceInFlight = false;
    }
  }

  /** Fire the operator's stage-2 pass. `scene` is the rendered stage-1 reading
   *  (text-only, faster) or null to hand the raw image straight to the model. */
  private fireVisionStage(pv: PendingVision, scene: string | null): void {
    if (pv.mode === 'commentary') {
      const entry = this.pushFeed('vision', '', { streaming: true });
      this.lastStoryAt = Date.now(); // reserve the chatter slot now we're speaking
      this.noteGlance(
        scene
          ? `commentary (${pv.angle}) — composing from the screen reading…`
          : `commentary (${pv.angle}) — looking at the screen…`,
      );
      this.startLlm(
        entry,
        'commentary',
        buildCommentaryMessages(
          pv.dataUri,
          pv.facts ?? '',
          pv.cmdr,
          pv.angle,
          pv.recent ?? [],
          scene ?? undefined,
        ) as unknown as ChatMessage[],
        0.75,
        1800,
      );
      return;
    }
    this.noteGlance(scene ? 'verdict check from the screen reading' : 'verdict check');
    // Vision messages carry OpenAI content-part arrays; the Rust proxy passes
    // content through verbatim, so the wire shape is what matters.
    this.startLlm(
      null,
      'glance',
      buildGlanceMessages(pv.dataUri, pv.context ?? '', pv.cmdr, scene ?? undefined) as unknown as ChatMessage[],
      0.3,
      2500,
      GLANCE_FORMAT,
    );
  }

  /** Stage-1 reading came back — render it and hand it to the operator. A
   *  reading that won't parse falls back to the raw image, so describeFirst can
   *  never make a glance worse than the single-pass path. */
  private onSceneDescribed(raw: string): void {
    const pv = this.pendingVision;
    this.pendingVision = null;
    if (!pv) return; // superseded mid-flight; nothing to speak
    const scene = parseSceneDescription(raw);
    const sceneText = scene ? renderSceneForOperator(scene) : null;
    this.noteGlance(
      scene
        ? `read the screen: ${scene.summary || scene.screen}`
        : 'screen reading unusable — using the image directly',
    );
    this.fireVisionStage(pv, sceneText);
  }

  /** Model verdict on a glance — deterministic no-flood gate owns the mic. */
  private onGlanceReply(raw: string): void {
    const reply = parseGlanceReply(raw);
    if (!reply) {
      this.noteGlance('verdict reply unparseable');
      return;
    }
    const st = this.statusTracker.current;
    const remark = suppressUngroundedFuelConcern(reply.remark, st?.fuelPct, st?.lowFuel);
    const notable = reply.notable && !!remark;
    this.noteGlance(`saw: ${reply.activity || 'the screen'}${notable ? ' — spoke up' : ' (nothing notable, stayed quiet)'}`);
    const manual = this.glanceManual;
    this.glanceManual = false;
    if (reply.activity && reply.activity !== 'not in the game') {
      this.glanceActivity = reply.activity;
      this.glanceActivityAt = Date.now();
    }
    if (manual) {
      // The commander asked — always answer, notable or not.
      const line = remark || `All quiet — looks like you're ${reply.activity || 'busy'}.`;
      this.pushFeed('vision', `👁 I see: ${reply.activity || 'the screen'}. ${remark}`.trim());
      this.speak(line);
      return;
    }
    if (!notable) return;
    const now = Date.now();
    if (now - this.lastGlanceRemarkAt < 10 * 60_000) return;
    if (remark === this.lastGlanceRemark) return;
    this.lastGlanceRemark = remark;
    this.lastGlanceRemarkAt = now;
    this.pushFeed('vision', `👁 ${remark}`);
    this.speak(remark);
  }

  private heartbeatNudges(): void {
    if (!this.bootstrapped || !this.journalStatus.ok) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    const nowIso = new Date().toISOString();
    const busyFocus = !!this.statusTracker.current && isBusyFocus(this.statusTracker.current.guiFocus);
    for (const n of this.hb.evaluate(this.sm.getState(), nowIso, { busyFocus })) {
      this.pushNudge(n);
    }
  }

  private recentNudges = new Map<string, number>();

  private pushNudge(n: Nudge): void {
    // Feed-level guard: identical nudge text within 4 min is noise even if the
    // heartbeat's own cooldown allowed it (e.g. re-fired under a new key).
    const now = Date.now();
    const last = this.recentNudges.get(n.message);
    if (last !== undefined && now - last < 4 * 60_000) return;
    this.recentNudges.set(n.message, now);
    if (this.recentNudges.size > 50) {
      for (const [k, t] of this.recentNudges) {
        if (now - t > 4 * 60_000) this.recentNudges.delete(k);
      }
    }
    this.pushFeed('nudge', n.message, { severity: n.severity, missionId: n.missionId });
    this.speak(n.message);
    // Serious warnings become story material — "we cut that one close".
    if (n.severity !== 'info') {
      this.addSeed(`Operator warning logged: ${n.message.slice(0, 140)}`);
    }
  }

  // ---------------------------------------------------------------- AI chat
  /** Extra grounded facts injected into every AI prompt. */
  private contextExtras(): string[] {
    const out: string[] = [];
    if (this.sm.commanderName) out.push(`The commander's name is ${this.sm.commanderName}.`);
    const cg = this.sm.communityGoals.find((g) => !g.complete);
    if (cg) out.push(`Community Goal running: "${cg.title}" at ${cg.market} in ${cg.system}.`);
    const risk = this.stats.riskNote();
    if (risk) out.push(risk);
    // Live ship telemetry (Status.json): fuel, legal state, current mode.
    const stLine = this.liveStatusLine();
    if (stLine) out.push(stLine);
    // Ship loadout (Loadout): jump range, cargo/cabins, key fittings.
    if (this.ship.current) out.push(`Loadout: ${describeShip(this.ship.current)}.`);
    // Whether the current ship can actually carry the selected mission.
    const selForFit = this.selectedMission();
    if (selForFit) {
      const fit = this.ship.fitNote(selForFit);
      if (fit) out.push(fit);
    }
    // Engineering materials + exploration value the operator can reason about.
    const matLine = this.materials.contextLine();
    if (matLine) out.push(matLine);
    const exLine = this.explore.contextLine();
    if (exLine) out.push(exLine);
    else if (this.stats.unsoldCarto >= 5)
      out.push(`${this.stats.unsoldCarto} scanned bodies of cartographic data unsold.`);
    if (this.tradeOpp) {
      const o = this.tradeOpp;
      out.push(
        `Known trade lead: ${o.commodity} — buy ${o.buy.station} (${o.buy.system}) ${o.buy.price} cr, sell ${o.sell.station} (${o.sell.system}) ${o.sell.price} cr, ${o.profitPerTon} cr/t profit.`,
      );
    }
    if (this.bioLead) {
      const b = this.bioLead;
      out.push(
        `Exobiology lead: ${b.body} (${b.system}) has ${b.remaining} uncollected bio signal(s)${b.genuses.length ? ` — ${b.genuses.slice(0, 3).join(', ')}` : ''}.`,
      );
    }
    if (this.route) out.push(`Community route data (Spansh): ${routeSummary(this.route)}`);
    // The live market in front of the commander — grounds "what should I buy
    // here?" so the operator never invents commodities. Also flags when a
    // remembered Spansh route points at something no longer stocked here.
    for (const line of this.currentMarketLines()) out.push(line);
    // Long-term memory relevant to where we are and who we're working for,
    // plus the commander profile (lifetime tallies + records).
    if (this.settings.memory.enabled) {
      const m = this.selectedMission();
      out.push(...this.memory.profileLines());
      out.push(
        ...this.memory.recallForContext(
          {
            system: this.sm.location.system !== 'unknown' ? this.sm.location.system : undefined,
            faction: m?.faction,
            targetFaction: m?.targetFaction,
          },
          Date.now(),
        ),
      );
    }
    const seen = this.currentActivity();
    if (seen?.includes('(seen on screen)')) out.push(`Right now the commander is ${seen}.`);
    return out;
  }

  /** Live ship telemetry as one line, or null when nothing is known yet. */
  private liveStatusLine(): string | null {
    const st = this.statusTracker.current;
    if (!st) return null;
    const bits: string[] = [];
    if (st.fuelPct != null) bits.push(`fuel ${Math.round(st.fuelPct * 100)}%`);
    if (st.legalState && st.legalState !== 'Clean') bits.push(`legal status ${st.legalState}`);
    if (st.docked) bits.push('docked');
    else if (st.supercruise) bits.push('in supercruise');
    else if (st.onFoot) bits.push('on foot');
    if (st.silentRunning) bits.push('running silent');
    return bits.length ? `Ship status: ${bits.join(', ')}.` : null;
  }

  /**
   * Context lines for the market the commander is docked at: a compact buy
   * list, plus a warning when a remembered Spansh route says to buy something
   * that isn't actually stocked here anymore (the stale-data trap).
   */
  private currentMarketLines(): string[] {
    const st = this.statusTracker.current;
    const station = this.sm.location.station;
    if (!st?.docked || !station) return [];
    const rec = this.marketMemory.latest({ station });
    if (!rec) return [];
    const out: string[] = [];
    const buys = rec.items.filter((i) => i.buy > 0 && i.stock > 0).sort((a, b) => b.stock - a.stock);
    if (buys.length) {
      out.push(
        `Live market here (${rec.station}): buys ${buys.slice(0, 10).map((i) => `${i.name} ${i.buy.toLocaleString('en-US')}cr`).join(', ')}.`,
      );
    } else {
      out.push(`Live market here (${rec.station}): nothing purchasable in stock right now.`);
    }
    // Stale-route trap: route starts here but the commodity is gone.
    const hop = this.route?.hops[0];
    if (hop && hop.fromStation.toLowerCase() === rec.station.toLowerCase()) {
      const stocked = rec.items.some(
        (i) => i.buy > 0 && i.stock > 0 && i.name.toLowerCase().includes(hop.commodity.toLowerCase()),
      );
      if (!stocked) {
        out.push(
          `Note: the saved Spansh route says buy ${hop.commodity} here, but this market no longer stocks it — the route is stale; re-plan or pick from what's in stock.`,
        );
      }
    }
    return out;
  }

  /** Assemble the live-data context the operator's tools read from. */
  private buildToolContext(): ToolContext {
    const state = { ...this.sm.getState(), now: new Date().toISOString() };
    const station = this.statusTracker.current?.docked ? this.sm.location.station ?? null : this.sm.location.station ?? null;
    return {
      system: this.sm.location.system,
      station,
      markets: this.marketMemory,
      ship: this.ship.current,
      shipDescription: this.ship.current ? describeShip(this.ship.current) : null,
      liveCargo: this.ship.liveCargo,
      statusLine: this.liveStatusLine(),
      missions: this.sm.activeMissions(),
      materialsLine: this.materials.contextLine(),
      exploreLine: this.explore.contextLine(),
      systemIntelLine: describeSystemIntel(state),
      planRoute: async ({ maxHops, requiresLargePad }) => {
        const raw = await spanshTradeRoute({
          system: this.sm.location.system,
          station,
          maxCargo: Math.max(8, this.stats.cargoCapacity || 64),
          capital: Math.max(1_000_000, this.stats.startCredits + this.stats.earnedTotal()),
          maxHopDistance: this.settings.trade.routeMaxHopLy,
          maxHops,
          requiresLargePad,
        });
        const route = parseSpanshRoute(raw);
        // Surface it in the route card too, so tool-planned routes are clickable.
        if (route) {
          this.route = route;
          this.routeIdx = 0;
        }
        return route;
      },
    };
  }

  /** Whether the operator may use the tool loop for this question. */
  private toolsActive(model: string | null): boolean {
    if (!isTauri || !this.lmOk || !model || !this.settings.lm.tools) return false;
    // Embedding models can't chat, let alone call tools.
    return !/embed/i.test(this.modelTypes[model] ?? '') && !/embed/i.test(model);
  }

  private activeModel(): string | null {
    if (this.settings.lm.model) return this.settings.lm.model;
    return this.lmModels.find((id) => !/embed/i.test(id)) ?? this.lmModels[0] ?? null;
  }

  private async pollLm(): Promise<void> {
    try {
      this.lmModels = await llmModels(this.settings.lm.endpoint);
      this.lmOk = this.lmModels.length > 0;
    } catch {
      this.lmModels = [];
      this.lmOk = false;
    }
    if (this.lmOk) {
      try {
        this.modelTypes = await llmModelTypes(this.settings.lm.endpoint);
      } catch {
        /* capability map stays as-is */
      }
    }
    this.emit();
  }

  selectedMission(): Mission | null {
    return this.snap.missions.find((m) => m.id === this.selectedId) ?? null;
  }

  ask(question: string, via: 'text' | 'voice' = 'text'): void {
    const q = question.trim();
    if (!q) return;
    this.pushFeed('user', via === 'voice' ? `🎤 ${q}` : q);

    const nowIso = new Date().toISOString();
    const mission = this.selectedMission();
    const state = { ...this.sm.getState(), now: nowIso };
    // The recent thread — the operator's own remarks included — goes into the
    // prompt so follow-ups ("and how far is that?") resolve naturally.
    const history = this.convo.recent(Date.now());
    this.convo.push('user', q, Date.now());

    let messages: ChatMessage[];
    if (mission) {
      messages = buildChat(mission, state, q);
      if (this.navRouteJumps > 0 && this.navRouteDest) {
        messages[1].content += `\n(Plotted route: ${this.navRouteJumps} jump(s) to ${this.navRouteDest}.)`;
      }
      for (const line of this.contextExtras()) messages[1].content += `\n(${line})`;
    } else {
      messages = [
        {
          role: 'system',
          content:
            'You are the Mission Operator for an Elite Dangerous commander. No mission is active. ' +
            'Answer briefly and practically (2-4 sentences, speakable, no markdown).',
        },
        {
          role: 'user',
          content: `Current location: ${state.location.station ? `${state.location.station}, ` : ''}${state.location.system}${state.docked ? ' (docked)' : ''}.${(() => {
            const intel = describeSystemIntel(state);
            return intel ? `\n${intel}` : '';
          })()}${this.contextExtras()
            .map((l) => `\n(${l})`)
            .join('')}\n\nCommander asks: ${q}`,
        },
      ];
    }

    // Splice the dialogue between the system prompt and the fresh question.
    messages.splice(messages.length - 1, 0, ...history);

    const entry = this.pushFeed('ai', '', { streaming: true, missionId: mission?.id });
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model) {
      this.finishAiWithFallback(entry, mission, nowIso, 'LM Studio is offline');
      return;
    }
    if (this.toolsActive(model)) this.startAgentic(entry, messages);
    else this.startLlm(entry, 'ai', messages, this.settings.lm.temperature);
  }

  // --------------------------------------------------------- agentic tool loop

  /**
   * Run an 'ai' question through the tool loop: the model may call tools to
   * read live game state (market, ship, missions…) before answering. Rounds
   * are bounded; on the very first round we retry once WITHOUT tools if the
   * backend rejects them, so tool-incapable models degrade to grounded chat.
   */
  private startAgentic(entry: FeedEntry, messages: ChatMessage[]): void {
    const withTools = messages.slice();
    // Nudge the model to prefer tools over guessing (small local models won't
    // otherwise reach for them). Appended to the existing system prompt.
    if (withTools[0]?.role === 'system') {
      withTools[0] = {
        ...withTools[0],
        content: `${withTools[0].content} You can call tools to read the commander's LIVE game data (current market, ship, missions, status, materials, exploration, and Spansh trade routes). When the answer depends on prices, stock, what to buy or sell, what's profitable here, or whether cargo fits, CALL THE RELEVANT TOOL and use its result — never guess or trust possibly-stale route data. Use get_current_market for "here". After gathering what you need, answer in 2-4 short speakable sentences with no markdown.`,
      };
    }
    this.agent = { entry, messages: withTools, rounds: 0, useTools: true };
    this.runAgentRound();
  }

  private runAgentRound(): void {
    const a = this.agent;
    if (!a) return;
    this.resolveOrphan();
    const model = this.activeModel();
    if (!model) {
      this.agent = null;
      this.finishAiWithFallback(a.entry, this.selectedMission(), new Date().toISOString(), 'no model');
      return;
    }
    const id = `q${this.askSeq++}`;
    this.currentAskId = id;
    this.currentAiEntry = a.entry;
    this.currentKind = 'ai';
    this.lmBusy = true;
    a.entry.text = ''; // fresh cursor; only the final round's prose should show
    a.entry.streaming = true;
    this.emit();
    llmChat({
      id,
      endpoint: this.settings.lm.endpoint,
      model,
      messages: a.messages,
      temperature: this.settings.lm.temperature,
      maxTokens: this.settings.lm.maxTokens,
      tools: a.useTools ? TOOL_SCHEMAS : undefined,
    }).catch((e) => this.onAiError(id, String(e)));
  }

  /** Handle a tool-call turn: execute each tool, append results, loop again. */
  private async continueAgent(text: string, toolCalls: ToolCallWire[]): Promise<void> {
    const a = this.agent;
    if (!a) return;
    a.rounds += 1;
    // Record the assistant's tool request verbatim so the model sees its own call.
    a.messages.push({ role: 'assistant', content: text ?? '', tool_calls: toolCalls });
    // Show the operator "working" in its bubble while tools run.
    a.entry.text = `🔧 ${toolCalls.map((c) => friendlyTool(c.function?.name)).join(', ')}…`;
    a.entry.streaming = true;
    this.emit();
    const ctx = this.buildToolContext();
    for (const call of toolCalls) {
      const name = call.function?.name ?? '';
      const args = call.function?.arguments ?? '';
      let result: string;
      try {
        result = await runTool(name, args, ctx);
      } catch (e) {
        result = `Error running ${name}: ${String(e)}`;
      }
      a.messages.push({ role: 'tool', tool_call_id: call.id, name, content: result });
    }
    // A newer question (or a cancel) may have replaced this run while tools ran
    // asynchronously — don't drive a superseded loop.
    if (this.agent !== a) return;
    // Past the round cap, stop offering tools so the model must answer.
    if (a.rounds >= AppCore.MAX_TOOL_ROUNDS) a.useTools = false;
    this.runAgentRound();
  }

  // ------------------------------------------------------------- voice input
  /** Push-to-talk pressed: silence the operator (barge-in) and open the mic. */
  pttDown(): void {
    if (!isTauri || this.listening) return;
    if (!this.settings.voiceInput.enabled || !this.sttOk) {
      if (!this.sttHintShown) {
        this.sttHintShown = true;
        this.pushFeed(
          'system',
          this.settings.voiceInput.enabled
            ? '🎤 Voice input needs a one-time download — Settings → Voice input.'
            : '🎤 Voice input is off — enable it in Settings → Voice input.',
        );
        this.emit();
      }
      return;
    }
    this.speaker.stop(); // the commander speaks; the operator yields the comm
    sttStart()
      .then(() => {
        this.listening = true;
        this.emit();
      })
      .catch((e) => {
        this.pushFeed('system', `🎤 ${String(e)}`);
        this.emit();
      });
  }

  /** Push-to-talk released: transcribe locally and route into the ask flow. */
  pttUp(): void {
    if (!this.listening) return;
    this.listening = false;
    this.emit();
    sttStop()
      .then((raw) => {
        const text = cleanTranscript(raw);
        if (!text) return; // a tap or silence — stay quiet, no nagging
        this.ask(text, 'voice');
      })
      .catch((e) => {
        this.pushFeed('system', `🎤 Transcription failed: ${String(e)}`);
        this.emit();
      });
  }

  /** Abort a capture without transcribing (Esc / window close). */
  pttCancel(): void {
    if (!this.listening) return;
    this.listening = false;
    void sttCancel().catch(() => undefined);
    this.emit();
  }

  /** One-time whisper.cpp + model download (user-initiated, ~150 MB). */
  async downloadStt(): Promise<void> {
    if (this.sttDownloading) return;
    this.sttDownloading = true;
    this.emit();
    try {
      await sttDownload();
      this.sttOk = await sttAvailable();
      this.pushFeed(
        'system',
        '🎤 Voice input installed. Hold Ctrl+Shift+Space (or the mic button) and talk to me, commander.',
      );
      this.speak('Voice input is live. Hold the push to talk key and speak, commander.');
    } catch (e) {
      this.pushFeed('system', `🎤 Voice input download failed: ${String(e)}`);
    } finally {
      this.sttDownloading = false;
      this.emit();
    }
  }

  /**
   * Operator chatter (fictional flavor stories). LLM when available, template
   * generator offline — either way the commander gets a story.
   */
  tellStory(focus?: Mission): void {
    const missions = this.sm.activeMissions();
    const activity = this.currentActivity();
    if (!missions.length && !this.seeds.length && !activity) {
      this.pushFeed('system', 'No active missions to gossip about yet, commander.');
      this.emit();
      return;
    }
    if (this.lmBusy) return;
    this.lastStoryAt = Date.now();
    this.seedCountAtLastStory = this.seeds.length;
    const state = { ...this.sm.getState(), now: new Date().toISOString() };
    const entry = this.pushFeed('story', '', { streaming: true, missionId: focus?.id });
    const model = this.activeModel();
    // Between contracts, gossip grows out of what the commander is DOING
    // right now (mining etc.) or recent true events.
    if (!missions.length) {
      if (!isTauri || !this.lmOk || !model) {
        entry.text = afterglowFlavor(state, Math.random, activity);
        entry.streaming = false;
        this.lastStoryText = entry.text;
        this.rememberStory(entry.text);
        this.speak(entry.text);
        this.emit();
        return;
      }
      this.startLlm(
        entry,
        'story',
        buildAfterglowChat(this.freshSeeds(), state, Math.random, {
          activity,
          avoid: this.recentStories,
          comms: this.freshComms(),
        }),
        0.9,
      );
      return;
    }
    const plan = planStory(missions, Math.random, focus);
    if (!isTauri || !this.lmOk || !model || !plan) {
      this.finishStoryFallback(entry, missions, state, focus);
      return;
    }
    this.startLlm(
      entry,
      'story',
      buildFlavorChat(
        plan,
        state,
        this.freshSeeds(),
        this.recentStories,
        this.freshComms(),
      ),
      0.9,
    );
  }

  /** Narrate a space-opera episode from today's true story beats. */
  tellSaga(): void {
    if (this.lmBusy) return;
    const day = this.saga.latestDay();
    const beats = day ? this.saga.beatsForDay(day) : [];
    if (!day || beats.length < 3) {
      this.pushFeed('system', 'The chronicler has no material yet — fly a little first, commander.');
      this.emit();
      return;
    }
    const n = (this.sagaEpisodes.at(-1)?.n ?? 0) + 1;
    const entry = this.pushFeed('saga', '', { streaming: true });
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model) {
      entry.text = beatRecap(day, beats);
      entry.streaming = false;
      this.emit();
      return;
    }
    this.pendingSaga = { n, day };
    this.startLlm(
      entry,
      'saga',
      buildEpisodeChat({
        episodeNumber: n,
        day,
        beats,
        cmdr: this.saga.cmdr || this.sm.commanderName,
        ship: this.saga.ship,
        storySoFar: this.sagaEpisodes.at(-1)?.text ?? '',
      }),
      0.85,
      // The nightly episode is the showcase piece — give it a big canvas.
      // Local model, free tokens; measured ~18s at 8192 on gemma-4-e4b.
      Math.max(this.settings.lm.maxTokens, 8192),
    );
  }

  private saveSagaEpisode(text: string): void {
    const meta = this.pendingSaga;
    this.pendingSaga = null;
    if (!meta) return;
    this.sagaEpisodes.push({ n: meta.n, day: meta.day, text, at: Date.now() });
    this.sagaEpisodes = this.sagaEpisodes.slice(-20);
    try {
      localStorage.setItem('edmo.saga.v1', JSON.stringify(this.sagaEpisodes));
    } catch {
      /* not fatal — the episode still showed in the feed */
    }
  }

  /** Finalize a still-streaming entry whose request is being superseded, so
   *  no cursor is ever left blinking in the feed. Silent requests (reflect /
   *  glance, no entry) are simply cancelled — a user ask outranks them. */
  private resolveOrphan(): void {
    if (this.currentAskId) void llmCancel(this.currentAskId).catch(() => undefined);
    const entry = this.currentAiEntry;
    if (entry && entry.streaming) {
      if (!entry.text) {
        const m = this.currentKind === 'brief' ? this.missionOfEntry(entry) : null;
        entry.text = m
          ? livelyBriefing(m, new Date().toISOString(), this.sm.commanderName || undefined, Math.random)
          : '[interrupted]';
      }
      entry.streaming = false;
    }
    // A superseded stage-1 reading has no one left to speak to — drop its
    // parked stage-2 work so it can't surface after a user ask takes the slot.
    this.pendingVision = null;
    this.currentAskId = null;
    this.currentAiEntry = null;
  }

  private startLlm(
    entry: FeedEntry | null,
    kind: 'ai' | 'story' | 'brief' | 'saga' | 'reflect' | 'glance' | 'commentary' | 'describe',
    messages: ChatMessage[],
    temperature: number,
    maxTokens?: number,
    responseFormat?: unknown,
  ): void {
    this.resolveOrphan();
    const model = this.activeModel()!;
    const id = `q${this.askSeq++}`;
    this.currentAskId = id;
    this.currentAiEntry = entry;
    this.currentKind = kind;
    this.lmBusy = true;
    this.emit();
    llmChat({
      id,
      endpoint: this.settings.lm.endpoint,
      model,
      messages,
      temperature,
      maxTokens: maxTokens ?? this.settings.lm.maxTokens,
      responseFormat,
    }).catch((e) => this.onAiError(id, String(e)));
  }

  /** Acceptance briefing in the operator's own voice; template when LM is busy/down. */
  private personalBriefing(m: Mission): void {
    const entry = this.pushFeed('briefing', '', { streaming: true, missionId: m.id });
    const state = { ...this.sm.getState(), now: new Date().toISOString() };
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model || this.lmBusy || this.currentAskId) {
      this.finishBriefFallback(entry, m);
      return;
    }
    this.startLlm(entry, 'brief', buildBriefingChat(m, state), 0.7);
  }

  private finishBriefFallback(entry: FeedEntry, m: Mission): void {
    entry.text = livelyBriefing(m, new Date().toISOString(), this.sm.commanderName || undefined, Math.random);
    entry.streaming = false;
    // NOTE: deliberately does NOT touch lmBusy — this path also runs while a
    // DIFFERENT request is in flight (two accepts in quick succession), and
    // clearing the flag here let a follow-up story hijack the busy slot and
    // orphan the first briefing's cursor.
    this.speak(entry.text);
    this.emit();
  }

  private missionOfEntry(entry: FeedEntry): Mission | null {
    return this.sm.allMissions().find((m) => m.id === entry.missionId) ?? null;
  }

  private finishStoryFallback(
    entry: FeedEntry,
    missions: Mission[],
    state: OperatorState,
    focus?: Mission,
  ): void {
    const text =
      ruleBasedFlavor(missions, state, Math.random, focus) ??
      afterglowFlavor(state, Math.random, this.currentActivity());
    entry.text = text || '[no story tonight]';
    entry.streaming = false;
    if (text) {
      this.lastStoryText = text;
      this.speak(text);
    }
    this.emit();
  }

  private maybeChatter(): void {
    const c = this.settings.chatter;
    if (!c.enabled || !this.bootstrapped || this.lmBusy) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    const hasMissions = this.sm.activeMissions().length > 0;
    const activity = this.currentActivity();
    // Between contracts the operator talks less — and only when there is NEW
    // material (fresh deeds or a current activity like mining), otherwise it
    // remixes the same gossip every interval. When the commander is actively
    // WORKING (mining shift, seen-on-screen activity) it keeps a little more
    // company than in dead-idle drift.
    const interval = (hasMissions ? 1 : activity ? 2 : 3) * c.intervalMin * 60_000;
    if (Date.now() - this.lastStoryAt < interval) return;
    // Never gossip while the commander is being shot at.
    if (Date.now() - this.lastCombatAt < 3 * 60_000) return;
    if (!hasMissions) {
      const somethingNew = this.seeds.length !== this.seedCountAtLastStory || activity !== null;
      if (!somethingNew) return;
      if (!activity && !this.freshSeeds().length) return; // no material at all
    }
    this.tellStory();
  }

  cancelAsk(): void {
    if (this.currentAskId) {
      void llmCancel(this.currentAskId).catch(() => undefined);
      this.onAiError(this.currentAskId, 'cancelled');
    }
  }

  private onAiToken(id: string, token: string): void {
    if (id !== this.currentAskId || !this.currentAiEntry) return;
    // Hold ambient vision prose until it can be checked against authoritative
    // telemetry. This prevents a small VLM's transient fuel nag from flashing
    // in the feed before the final grounded version replaces it.
    if (this.currentKind === 'commentary') return;
    this.currentAiEntry.text += token;
    this.emit();
  }

  private onAiDone(id: string, text: string, toolCalls?: ToolCallWire[]): void {
    if (id !== this.currentAskId) return;
    // Agentic 'ai' turn: if the model asked for tools, run them and loop
    // instead of finalizing. Keeps lmBusy set across the whole tool loop.
    if (this.agent && this.currentKind === 'ai' && toolCalls && toolCalls.length) {
      this.currentAskId = null;
      void this.continueAgent(text, toolCalls);
      return;
    }
    // Any final 'ai' answer ends the agentic run.
    if (this.currentKind === 'ai') this.agent = null;
    const entry = this.currentAiEntry;
    const kind = this.currentKind;
    this.currentAskId = null;
    this.currentAiEntry = null;
    this.lmBusy = false;
    // Silent kinds have no feed entry — their result is data, not prose.
    if (kind === 'reflect') {
      const kept = this.memory.addReflections(stripThink(text), Date.now());
      if (kept > 0) {
        this.persistMemory();
        this.pushFeed('memory', `🧠 Session remembered — ${kept} new ${kept === 1 ? 'memory' : 'memories'} kept.`);
      } else if (this.reflectManual) {
        this.pushFeed('system', 'Nothing new worth remembering from this session.');
      }
      this.reflectManual = false;
      this.emit();
      return;
    }
    if (kind === 'glance') {
      this.onGlanceReply(stripThink(text));
      this.emit();
      return;
    }
    // Stage-1 reading done → fire the operator's stage-2 pass (which sets
    // lmBusy/currentAskId again synchronously below).
    if (kind === 'describe') {
      this.onSceneDescribed(stripThink(text));
      this.emit();
      return;
    }
    if (!entry) return;
    const finalText = stripThink(text || entry.text);
    const mission = this.selectedMission();
    // Vision commentary: retract quietly when there's nothing worth saying
    // (screen wasn't the game, or the model came back empty).
    if (kind === 'commentary') {
      const st = this.statusTracker.current;
      const fuelGrounded = suppressUngroundedFuelConcern(finalText, st?.fuelPct, st?.lowFuel);
      const hasHazard = !!st && (
        st.inDanger || st.beingInterdicted || st.overheating || st.lowFuel || st.lowOxygen || st.lowHealth
      );
      const groundedText = suppressRoutineCoaching(fuelGrounded, hasHazard);
      if (!groundedText || /\b(?:NOT_IN_GAME|NO_BEAT)\b/.test(groundedText)) {
        this.noteGlance(
          /NO_BEAT/.test(groundedText)
            ? 'nothing specific worth interrupting for — stayed quiet'
            : finalText
              ? 'screen was not the game — stayed quiet'
              : 'commentary came back empty',
        );
        this.feed = this.feed.filter((e) => e !== entry);
      } else {
        this.noteGlance('commentary spoken');
        entry.text = `👁 ${groundedText}`;
        entry.streaming = false;
        this.lastStoryText = groundedText;
        this.rememberStory(groundedText);
        this.speak(groundedText);
      }
      this.emit();
      return;
    }
    if (finalText) {
      entry.text = finalText;
      entry.streaming = false;
      if (kind === 'saga') this.saveSagaEpisode(finalText);
      if (kind === 'story') {
        this.lastStoryText = finalText;
        this.rememberStory(finalText);
      }
      this.speak(finalText);
      this.emit();
    } else if (kind === 'saga') {
      const meta = this.pendingSaga;
      this.pendingSaga = null;
      entry.text = meta ? beatRecap(meta.day, this.saga.beatsForDay(meta.day)) : '[no episode tonight]';
      entry.streaming = false;
      this.emit();
    } else if (kind === 'story') {
      this.finishStoryFallback(entry, this.sm.activeMissions(), this.sm.getState());
    } else if (kind === 'brief') {
      const m = this.missionOfEntry(entry);
      if (m) this.finishBriefFallback(entry, m);
      else {
        entry.streaming = false;
        this.emit();
      }
    } else {
      this.finishAiWithFallback(entry, mission, new Date().toISOString(), 'empty reply');
    }
  }

  private onAiError(id: string, message: string): void {
    if (id !== this.currentAskId) return;
    // Graceful tool fallback: if the backend rejects tools on the first round
    // (model/server can't do tool calls), retry the same question once without
    // them so the answer still comes through (grounded by context instead).
    if (this.agent && this.currentKind === 'ai' && this.agent.useTools && this.agent.rounds === 0 && message !== 'cancelled') {
      this.currentAskId = null;
      this.lmBusy = false;
      this.agent.useTools = false;
      this.runAgentRound();
      return;
    }
    if (this.currentKind === 'ai') this.agent = null;
    const entry = this.currentAiEntry;
    const kind = this.currentKind;
    const mission = this.selectedMission();
    this.currentAskId = null;
    this.currentAiEntry = null;
    this.lmBusy = false;
    // A failed stage-1 reading is recoverable: hand the raw image to the
    // operator so describeFirst never loses a glance the single pass would have
    // made. (A cancel is a supersede — drop it silently.)
    if (kind === 'describe') {
      const pv = this.pendingVision;
      this.pendingVision = null;
      if (pv && message !== 'cancelled') {
        this.noteGlance(`screen reading failed (${message.slice(0, 60)}) — using the image directly`);
        this.fireVisionStage(pv, null);
      } else {
        this.glanceManual = false;
        this.emit();
      }
      return;
    }
    // Silent kinds fail silently — memory/glances must never nag.
    if (kind === 'reflect' || kind === 'glance') {
      if (kind === 'reflect' && this.reflectManual) {
        this.pushFeed('system', `Memory distillation failed: ${message}`);
      }
      if (kind === 'glance' && this.glanceManual) {
        this.pushFeed('system', `Screen glance failed: ${message}`);
      }
      this.reflectManual = false;
      this.glanceManual = false;
      this.emit();
      return;
    }
    if (!entry) return;
    if (kind === 'commentary') {
      // Ambient vision talk fails silently — retract the placeholder row.
      this.noteGlance(`commentary failed: ${message.slice(0, 80)}`);
      this.feed = this.feed.filter((e) => e !== entry);
      this.emit();
      return;
    }
    if (message === 'cancelled') {
      entry.text = '[cancelled]';
      entry.streaming = false;
      this.emit();
    } else if (kind === 'saga') {
      const meta = this.pendingSaga;
      this.pendingSaga = null;
      entry.text = meta ? beatRecap(meta.day, this.saga.beatsForDay(meta.day)) : '[no episode tonight]';
      entry.streaming = false;
      this.emit();
    } else if (kind === 'story') {
      // A story must never surface an error banner — fall back to templates.
      this.finishStoryFallback(entry, this.sm.activeMissions(), this.sm.getState());
    } else if (kind === 'brief') {
      const m = this.missionOfEntry(entry);
      if (m) this.finishBriefFallback(entry, m);
      else {
        entry.streaming = false;
        this.emit();
      }
    } else {
      this.finishAiWithFallback(entry, mission, new Date().toISOString(), `LM Studio error: ${message}`);
    }
  }

  private finishAiWithFallback(
    entry: FeedEntry,
    mission: Mission | null,
    nowIso: string,
    reason: string,
  ): void {
    if (mission && reason !== 'cancelled') {
      const advice = ruleBasedAdvice(mission, nowIso);
      entry.text = `${advice}\n[rule-based — ${reason}]`;
      this.speak(advice);
    } else {
      entry.text = `[${reason}]`;
    }
    entry.streaming = false;
    this.lmBusy = false;
    this.emit();
  }

  // ------------------------------------------------------------- UI actions
  /** Wipe the commander memory bank (Settings → Forget everything). */
  forgetMemory(): void {
    this.memory.forget();
    this.pendingMemoryEvents = [];
    this.persistMemory();
    this.pushFeed('system', '🧠 Memory bank wiped — the operator starts fresh.');
    this.emit();
  }

  private onShortcutAction(action: string): void {
    switch (action) {
      case 'ask':
        this.ask('What should I do right now?');
        break;
      case 'voice':
        this.toggleVoice();
        break;
      case 'cycle':
        this.cycleMission(1);
        break;
      case 'collapse':
        this.setCollapsed(!this.collapsed);
        break;
      case 'ptt-down':
        this.pttDown();
        break;
      case 'ptt-up':
        this.pttUp();
        break;
      default:
        break;
    }
  }

  select(id: number): void {
    this.selectedId = id;
    this.emit();
  }

  cycleMission(delta: number): void {
    const missions = this.snap.missions;
    if (!missions.length) return;
    const idx = Math.max(0, missions.findIndex((m) => m.id === this.selectedId));
    const next = missions[(idx + delta + missions.length) % missions.length];
    this.selectedId = next.id;
    this.emit();
  }

  setCollapsed(v: boolean): void {
    this.collapsed = v;
    this.emit();
  }

  setSettingsOpen(v: boolean): void {
    this.settingsOpen = v;
    this.emit();
  }

  toggleVoice(): void {
    const enabled = !this.settings.voice.enabled;
    this.updateSettings({ ...this.settings, voice: { ...this.settings.voice, enabled } });
    this.pushFeed('system', enabled ? 'Voice ON.' : 'Voice muted.');
    if (!enabled) this.speaker.stop();
    else this.speaker.test();
  }

  testVoice(): void {
    this.speaker.test();
  }

  private async refreshPiperVoices(): Promise<void> {
    try {
      this.piperVoiceList = await piperVoices();
    } catch {
      this.piperVoiceList = [];
    }
    this.emit();
  }

  /** One-click voice download (user-initiated network access to HuggingFace). */
  async downloadVoice(repoPath: string, label: string): Promise<void> {
    if (this.voiceDownloading) return;
    this.voiceDownloading = repoPath;
    this.emit();
    try {
      const name = await piperDownloadVoice(repoPath);
      await this.refreshPiperVoices();
      this.updateSettings({
        ...this.settings,
        voice: { ...this.settings.voice, engine: 'piper', piperVoice: name },
      });
      this.pushFeed('system', `Voice installed: ${label}. It's now the active operator voice.`);
      this.speaker.test();
    } catch (e) {
      this.pushFeed('system', `Voice download failed: ${String(e)}`);
    } finally {
      this.voiceDownloading = null;
      this.emit();
    }
  }

  updateSettings(next: AppSettings): void {
    const prev = this.settings;
    this.settings = next;
    saveSettings(next);
    if (isTauri && prev.hud.clickThrough !== next.hud.clickThrough) {
      void setClickThrough(next.hud.clickThrough).catch(() => undefined);
    }
    if (
      prev.journal.directory !== next.journal.directory ||
      prev.journal.bootstrapPreviousSessions !== next.journal.bootstrapPreviousSessions
    ) {
      void this.restartWatch();
    } else if (prev.journal.expiryWarningMin !== next.journal.expiryWarningMin) {
      this.hb = new Heartbeat({ expiryWarnMin: next.journal.expiryWarningMin });
    }
    if (prev.lm.endpoint !== next.lm.endpoint) void this.pollLm();
    this.emit();
  }

  /** Manual JSON import (T2.6) — paste journal lines with no game running. */
  importText(text: string): void {
    const evs: JournalEvent[] = parseJournalLines(text);
    for (const ev of evs) {
      if (ev.event === 'Missions') this.sm.reconcile(ev);
      else this.sm.apply(ev);
    }
    const n = this.sm.activeMissions().length;
    this.pushFeed('system', `Imported ${evs.length} event(s) — ${n} active mission(s).`);
    this.bootstrapped = true;
    this.emit();
  }

  private pushFeed(
    kind: FeedKind,
    text: string,
    extra: Partial<Pick<FeedEntry, 'time' | 'severity' | 'missionId' | 'streaming'>> = {},
  ): FeedEntry {
    const entry: FeedEntry = {
      id: this.feedSeq++,
      time: extra.time ?? new Date().toISOString(),
      kind,
      text,
      severity: extra.severity,
      missionId: extra.missionId,
      streaming: extra.streaming,
    };
    this.feed.push(entry);
    if (this.feed.length > 200) this.feed = this.feed.slice(-200);
    return entry;
  }
}

export const core = new AppCore();
