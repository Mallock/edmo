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
import { parseSpanshRoute, routeSummary, type TradeRoute } from '../engine/spansh.ts';
import {
  CommanderMemory,
  REFLECTION_FORMAT,
  buildReflectionChat,
  type MemoryEvent,
} from '../engine/memory.ts';
import {
  GLANCE_FORMAT,
  buildGlanceMessages,
  parseGlanceReply,
} from '../engine/glance.ts';
import { ConvoBuffer, cleanTranscript } from '../engine/convo.ts';
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
  private currentKind: 'ai' | 'story' | 'brief' | 'saga' | 'reflect' | 'glance' = 'ai';
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
  private lastGlanceRemark = '';
  private lastGlanceRemarkAt = 0;
  private glanceManual = false;
  private glanceInFlight = false;

  private stats = new SessionStats();
  private saga = new SagaTracker();
  private lastMiningAt = 0;
  private lastStoryText = '';
  private seedCountAtLastStory = 0;
  /** Interesting NPC comms overheard recently — ambient story texture. */
  private recentComms: Array<{ text: string; at: number }> = [];
  private commsSeen = new Map<string, number>();

  private freshComms(): string[] {
    const cutoff = Date.now() - 45 * 60_000;
    return this.recentComms.filter((c) => c.at > cutoff).map((c) => c.text);
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
        onLlmDone((p) => this.onAiDone(p.id, p.text)),
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
    this.emit();
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
    }
    // Status.json / Cargo.json currently only refresh game liveness.
    this.emit();
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
    if (manual) this.pushFeed('system', `Asking Spansh for routes from ${station ?? system}… (takes up to a minute)`);
    this.emit();
    try {
      const raw = await spanshTradeRoute({
        system,
        station,
        maxCargo: Math.max(8, this.stats.cargoCapacity || 64),
        capital: Math.max(1_000_000, this.stats.startCredits + this.stats.earnedTotal()),
        maxHopDistance: this.settings.trade.routeMaxHopLy,
        maxHops: 2,
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
      const context = this.sm.location.system !== 'unknown'
        ? `Journal says the commander is in ${this.sm.location.system}${this.sm.docked ? ', docked' : ''}.`
        : '';
      // Vision messages carry OpenAI content-part arrays; the Rust proxy
      // passes content through verbatim, so the wire shape is what matters.
      this.startLlm(
        null,
        'glance',
        buildGlanceMessages(dataUri, context, this.sm.commanderName || undefined) as unknown as ChatMessage[],
        0.3,
        2500,
        GLANCE_FORMAT,
      );
    } catch (e) {
      if (manual) this.pushFeed('system', `Screen glance failed: ${String(e)}`);
      this.emit();
    } finally {
      this.glanceInFlight = false;
    }
  }

  /** Model verdict on a glance — deterministic no-flood gate owns the mic. */
  private onGlanceReply(raw: string): void {
    const reply = parseGlanceReply(raw);
    if (!reply) return;
    const manual = this.glanceManual;
    this.glanceManual = false;
    if (reply.activity && reply.activity !== 'not in the game') {
      this.glanceActivity = reply.activity;
      this.glanceActivityAt = Date.now();
    }
    if (manual) {
      // The commander asked — always answer, notable or not.
      const line = reply.remark || `All quiet — looks like you're ${reply.activity || 'busy'}.`;
      this.pushFeed('vision', `👁 I see: ${reply.activity || 'the screen'}. ${reply.remark}`.trim());
      this.speak(line);
      return;
    }
    if (!reply.notable || !reply.remark) return;
    const now = Date.now();
    if (now - this.lastGlanceRemarkAt < 10 * 60_000) return;
    if (reply.remark === this.lastGlanceRemark) return;
    this.lastGlanceRemark = reply.remark;
    this.lastGlanceRemarkAt = now;
    this.pushFeed('vision', `👁 ${reply.remark}`);
    this.speak(reply.remark);
  }

  private heartbeatNudges(): void {
    if (!this.bootstrapped || !this.journalStatus.ok) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    const nowIso = new Date().toISOString();
    for (const n of this.hb.evaluate(this.sm.getState(), nowIso)) {
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
    if (this.stats.unsoldCarto >= 5)
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
    this.startLlm(entry, 'ai', messages, this.settings.lm.temperature);
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
        this.speak(entry.text);
        this.emit();
        return;
      }
      this.startLlm(
        entry,
        'story',
        buildAfterglowChat(this.freshSeeds(), state, Math.random, {
          activity,
          avoid: this.lastStoryText || undefined,
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
        this.lastStoryText || undefined,
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
      Math.max(this.settings.lm.maxTokens, 3072),
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
    this.currentAskId = null;
    this.currentAiEntry = null;
  }

  private startLlm(
    entry: FeedEntry | null,
    kind: 'ai' | 'story' | 'brief' | 'saga' | 'reflect' | 'glance',
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
    this.currentAiEntry.text += token;
    this.emit();
  }

  private onAiDone(id: string, text: string): void {
    if (id !== this.currentAskId) return;
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
    if (!entry) return;
    const finalText = stripThink(text || entry.text);
    const mission = this.selectedMission();
    if (finalText) {
      entry.text = finalText;
      entry.streaming = false;
      if (kind === 'saga') this.saveSagaEpisode(finalText);
      if (kind === 'story') this.lastStoryText = finalText;
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
    const entry = this.currentAiEntry;
    const kind = this.currentKind;
    const mission = this.selectedMission();
    this.currentAskId = null;
    this.currentAiEntry = null;
    this.lmBusy = false;
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
