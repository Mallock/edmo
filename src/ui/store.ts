/**
 * AppCore — the HUD's single state container. Wires the Rust transport
 * (journal tail + snapshots + LLM proxy + Piper TTS) into the tested TS
 * engine (MissionStateManager, Heartbeat, Operator) and exposes an immutable
 * snapshot for React via subscribe/getSnapshot.
 */
import {
  MissionStateManager,
  normalizeCommodity,
  rankCommunityGoals,
  type StateChange,
} from '../engine/state.ts';
import { Heartbeat, type Nudge, type NudgeSeverity } from '../engine/heartbeat.ts';
import { parseJournalLine, parseJournalLines } from '../engine/parse.ts';
import {
  arrivalNotice,
  buildBriefingChat,
  categoryGuidance,
  missionContext,
  cargoNotice,
  completionNotice,
  describeSystemIntel,
  livelyBriefing,
  redirectNotice,
  ruleBasedAdvice,
  idleAskSystem,
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
  type MarketRecord,
  type TradeOpportunity,
} from '../engine/trade.ts';
import { BioTracker, type BioLead } from '../engine/exobio.ts';
import {
  StatusTracker,
  isBusyFocus,
  isScoopableStar,
  remainingRouteJumps,
  type StatusAlert,
} from '../engine/status.ts';
import { ShipTracker, describeShip, shipRequiresLargePad } from '../engine/ship.ts';
import { MaterialsTracker } from '../engine/materials.ts';
import { CarrierTracker, type CarrierSnapshot } from '../engine/carrier.ts';
import { DockingDenials, explainDenial } from '../engine/docking.ts';
import { placeFacts, placeOf, postPlaces, regionChanged, type Place } from '../engine/place.ts';
import {
  CarrierJumpAnnouncer,
  CarrierJumpTracker,
  describePhase,
  type CarrierJumpState,
} from '../engine/carrierjump.ts';
import {
  fmtLy,
  nextWaypoint,
  parseCarrierPlot,
  parseShipPlot,
  plotContextLine,
  plotProgress,
  plotSummary,
  remaining as plotRemaining,
  reprice,
  type PlotKind,
  type PlottedRoute,
} from '../engine/plotter.ts';
import {
  ConstructionTracker,
  architectFacts,
  buildShoppingList,
  commodityKey,
  coversFromMarket,
  describeCoverage,
  describeDepot,
  tonsRemaining,
  tonsRequired,
  type DepotState,
  type ShoppingGroup,
} from '../engine/architect.ts';
import {
  acceptNews,
  buildNewsBrief,
  buildNewsChat,
  desksFor,
  marketPulse,
  newsDue,
  newsMaxTokens,
  trimCast,
  type CastMember,
  type NewsItem,
  type PriceMemory,
} from '../engine/news.ts';
import { buildShipPanel, type ShipPanel } from '../engine/shippanel.ts';
import { ExploreTracker, classifyBody, type ExploreLead } from '../engine/explore.ts';
import {
  DeathClock,
  DeathClockAnnouncer,
  WOD_BODY,
  WOD_SYSTEM,
  phaseOf,
  speakableDur,
  type DeathClockMarkKind,
  type DeathClockState,
} from '../engine/deathclock.ts';
import { parseProspectTarget, matchesProspect, type ProspectTarget } from '../engine/mining.ts';
import {
  SampleRangeTracker,
  SampleCounter,
  describeBioHaul,
  describeBioSale,
  parseBioSale,
} from '../engine/exobiorange.ts';
import {
  extractPlaces,
  findFabricatedPlace,
  findVoiceViolation,
} from '../engine/factcheck.ts';
import { loreForSystem } from '../engine/lore.ts';
import { momentOf, CombatStreak } from '../engine/moments.ts';
import { SessionArc } from '../engine/arc.ts';
import {
  profileFor,
  suppressThinkingFor,
  suppressThinkingForGate,
  reasoningBudgetFor,
} from '../engine/modelprofile.ts';
import {
  DEFAULT_FILTERS,
  applyOwnObservations,
  bestSink,
  bestSinksByCommodity,
  legsToDestination,
  describeTradeFind,
  buildLeg,
  cheapestSources,
  rankLegs,
  type RouteFilters,
  type TradeFind,
} from '../engine/traderoute.ts';
import {
  describeUnusable,
  parseSpanshRoute,
  routeSummary,
  staleHops,
  unusableStops,
  type TradeRoute,
} from '../engine/spansh.ts';
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
  stripFillerTics,
  suppressRoutineCoaching,
  suppressUngroundedFuelConcern,
  type CommentaryAngle,
} from '../engine/glance.ts';
import {
  CopilotConversation,
  buildCopilotSystem,
  estimateTokens,
  buildBeatGateChat,
  parseBeatGate,
  pickBeatAngle,
  beatAngleHint,
  speakableCredits,
  roundCreditsForSpeech,
  copilotReactsTo,
  copilotDensityGapMs,
  isNearDuplicate,
  overusedTopic,
  topicOf,
  type BeatTopic,
  isSilenceVerdict,
  stripVerdict,
  copilotSilenceGapMs,
  type BeatAngle,
  type ReactionTier,
} from '../engine/copilot.ts';
import { ConvoBuffer, cleanTranscript, toolExchangeOf } from '../engine/convo.ts';
import { TOOL_SCHEMAS, runTool, type ToolContext } from '../engine/tools.ts';
import type { ChatMessage } from '../engine/lmstudio.ts';
import type { JournalEvent, Mission, OperatorState } from '../engine/types.ts';
import {
  captureScreen,
  isTauri,
  llmCancel,
  llmChat,
  llmQuick,
  llmModels,
  llmModelTypes,
  ardentMarket,
  type ArdentMarketRow,
  ardentSystemCommodities,
  ardentTradeCandidates,
  ardentStationPads,
  ardentTradeTo,
  engineLog,
  galnetHeadlines,
  edastroSystem,
  engineStatus,
  engineDownloadRuntime,
  engineDownloadModel,
  engineCancelDownload,
  engineDiscardPartial,
  engineStart,
  engineStop,
  engineAlive,
  onEngineProgress,
  type EngineStatus,
  type EngineProgress,
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
  journalScanHistory,
  journalOrganicHistory,
  piperAvailable,
  piperDownloadVoice,
  piperVoices,
  copyText,
  setClickThrough,
  spanshTradeRoute,
  spanshShipRoute,
  spanshCarrierRoute,
  startWatch,
  sttAvailable,
  sttCancel,
  sttDownload,
  sttStart,
  sttStop,
  systemSpecs,
  type ChatMessageWire,
  type ToolCallWire,
} from './bridge.ts';
import {
  classifyModel,
  gpuBudgetGb,
  gpuLayerBudget,
  shouldKeepVisionOnCpu,
  type ModelFit,
  type SystemSpecs,
} from './modelfit.ts';

/** Layer count assumed when sizing a partial GPU offload. The bundled tiers
 *  are 4-9B transformers, which all sit in the 30-48 range; the estimate only
 *  has to be close, because a wrong guess costs a few layers either way and
 *  llama.cpp clamps the rest. */
const MODEL_LAYERS_ESTIMATE = 40;
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

/** Everything the Plotter tab renders — data only; the actions live on core. */
export interface PlotterView {
  kind: PlotKind;
  /** What the commander typed, '' when they have typed nothing. */
  target: string;
  /** Where the game says they are heading, offered as the placeholder. */
  suggestion: string | null;
  route: PlottedRoute | null;
  /** Index of the waypoint they are standing on. */
  idx: number;
  busy: boolean;
  error: string | null;
  /** Spansh's detour dial for ship routes (1–100). */
  efficiency: number;
  /** Tritium the commander says is in the carrier's hold. */
  inHold: number;
  /** Whether the Spansh opt-in is on. */
  online: boolean;
  /** The system a plot would start from, or null when there isn't one. */
  from: string | null;
  /** Why there is no starting point. */
  fromNote: string | null;
  shipRange: number | null;
  shipCargo: number | null;
  carrier: CarrierSnapshot | null;
  /** Lockdown / cooldown clock state. The card recomputes the phase from this
   *  every second — the snapshot only rebuilds on the 15 s heartbeat. */
  jumpState: CarrierJumpState;
}

/** Everything the News tab renders — data only; actions live on core. */
export interface NewsView {
  system: string;
  /** Stories about where the commander is now, newest first. */
  items: NewsItem[];
  /** Older editions from systems left behind. */
  archive: NewsItem[];
  busy: boolean;
  error: string | null;
  lastAt: number | null;
  everyMin: number;
  enabled: boolean;
}

/** Everything the Architect tab renders — data only; actions live on core. */
export interface ArchitectView {
  depot: DepotState;
  /** The prioritised tree: deliver-now, buy-here, nearby, unknown, done. */
  groups: ShoppingGroup[];
  totalRequired: number;
  totalRemaining: number;
  /** Docked at THIS site right now — contributions can be made. */
  atSite: boolean;
  /** Community lookups are opt-in; without them the tree can only see here. */
  online: boolean;
  scanning: boolean;
  /** How many commodities the last scan covered, and when it ran. */
  scannedAt: number | null;
  scanError: string | null;
  cargoCapacity: number | null;
  /** Tons in the hold right now, for the trip arithmetic. */
  holdUsed: number | null;
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
  /** Bundled AI engine state (null when unknown / not in the shell). */
  engine: EngineStatus | null;
  /** Live download progress for the engine setup, or null when idle. */
  engineProgress: EngineProgress | null;
  /** First-run prompt: the recommended tier to offer, or null when the AI is
   *  already set up, unavailable, or the commander said "not now". */
  aiSetupOffer: { modelId: string; label: string; gb: string; backend: string } | null;
  trade: TradeOpportunity | null;
  bio: BioLead | null;
  /** Live ship telemetry from Status.json, or null before any snapshot. */
  shipStatus: HudShipStatus | null;
  /** Highest-value unmapped body known this session, or null. */
  exploreLead: ExploreLead | null;
  route: TradeRoute | null;
  tradeRun: TradeFind | null;
  /** World of Death landing clock — non-null while the tab should show
   *  (in the system, or calibrated with a route plotted there). */
  deathClock: { state: DeathClockState; inSystem: boolean } | null;
  /** Spansh-style route plotting for the ship or the carrier. */
  plotter: PlotterView;
  /** The construction shopping list — null until a depot has been seen. */
  architect: ArchitectView | null;
  /** The local wire, or null when the feature is switched off. */
  news: NewsView | null;
  /** Which panel fills the card area: missions (default), clock, plotter,
   *  the system architect's shopping list, or the local news wire. */
  view: 'missions' | 'deathclock' | 'plotter' | 'architect' | 'news';
  shipPanel: ShipPanel;
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
  return (
    text
      .replace(/<think>[\s\S]*?<\/think>/gi, '')
      // An ORPHAN closing tag: when the server caps thinking itself
      // (--reasoning-budget 0) the model is cut off mid-thought and emits the
      // close with no opener, so the pair rule above misses it and everything
      // before it is reasoning that leaked into the spoken line. Observed on
      // GLM-4.6V: "That's a good haul. Keep moving.</think>NO_BEAT" — the beat
      // AND the verdict, in one string, with the real answer after the tag.
      .replace(/^[\s\S]*?<\/think>/i, '')
      // ...and a stray opener with no close: everything after it is thought.
      .replace(/<think>[\s\S]*$/i, '')
      .trim()
  );
}

/** Plain-English berth type from the journal's StationType. */
function stationKind(type: unknown): string {
  const t = typeof type === 'string' ? type.toLowerCase() : '';
  if (!t) return '';
  if (t === 'coriolis' || t === 'orbis' || t === 'ocellus') return `a ${t} starport`;
  if (t === 'outpost') return 'an outpost';
  if (t === 'fleetcarrier') return 'a fleet carrier';
  if (t === 'asteroidbase') return 'an asteroid base';
  if (t === 'megaship') return 'a megaship';
  if (t.includes('planet') || t.includes('surface')) return 'a surface port';
  return '';
}

/**
 * What a station really is, out of the Docked event: its dominant economy and
 * berth type. This is the antidote to name-reading — the journal states the
 * economy outright, so there is never a reason to guess it from the sign.
 */
function describeStation(ev: JournalEvent): string {
  const kind = stationKind(ev.StationType);
  const econ =
    typeof ev.StationEconomy_Localised === 'string' ? ev.StationEconomy_Localised.toLowerCase() : '';
  if (!econ) return kind;
  return kind ? `${kind.replace(/^an? /, (m) => m)} — ${econ}` : econ;
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
    find_market_in_galaxy: 'searching the galaxy',
    find_trade_run: 'hunting a trade run',
    get_galnet_news: 'reading the Galnet wire',
    survey_system: 'checking the exploration catalogue',
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

  /** The whole plotted route, in order, as NavRoute.json listed it (element 0 is
   *  the system it was plotted FROM). Kept because Elite never rewrites that
   *  file mid-route, so progress must be derived from the ship's position. */
  private navRoute: string[] = [];
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
  /** The living copilot's running session conversation (null until the first
   *  event/beat; reset on session restart). Fed by game events + screen
   *  readings so the model reacts in full session context. */
  private copilot: CopilotConversation | null = null;
  /** True while an in-flight commentary beat came from the copilot conversation
   *  (so its reply is recorded back as the assistant turn). */
  private copilotBeatInFlight = false;
  /** The newest event handed to the copilot — the line the speak/skip gate is
   *  asked about when a reaction follows. */
  private lastCopilotEventLine = '';
  /** True while the speak/skip gate is deciding, so a burst of events cannot
   *  stack several gate calls (and several beats) on top of each other. */
  private beatGateInFlight = false;
  /** Automatic engine restarts since the last successful one, and when the last
   *  was attempted — bounds a crash loop without capping a long night. */
  private engineRestarts = 0;
  private lastEngineRestartAt = 0;
  /** The question an in-flight ask is answering, so the reply can be
   *  committed into the copilot thread as a matching exchange. */
  private lastAskedQuestion: string | null = null;
  /** The next beat is the chatter cadence's story, not an event reaction. */
  private storyBeatPending = false;
  /** Beats since the running tally was last put in front of the model — it is
   *  background, and shown every beat it becomes the only subject there is. */
  private beatsSinceTally = 0;
  /** The session's story — chapters, turns, mood — computed in arc.ts. */
  private sessionArc = new SessionArc();
  /** The fight being fought right now, told once when it ends (moments.ts). */
  private combatStreak = new CombatStreak();
  /** Last new-vocabulary moment, so an identical one inside ten minutes
   *  (every-leg fuel top-offs especially) stays unspoken. */
  private lastMomentLine = '';
  private lastMomentAt = 0;
  /** The exact messages of the in-flight copilot beat, kept so a beat that
   *  invents a place can be resampled once before we give up on it. */
  private copilotRetryMsgs: ChatMessage[] | null = null;
  private copilotRetried = false;
  /** Places the copilot is allowed to name this beat (built at fire time). */
  private copilotAllowedPlaces = new Set<string>();
  /** Last region the persona was built for — see refreshPlaceIfRegionChanged. */
  private lastPlace: Place | null = null;
  /** Last time the copilot actually fired a beat (glance OR event reaction) —
   *  the shared cadence clock that keeps involvement from flooding. */
  private lastCopilotBeatAt = 0;
  /** Valuable worlds the copilot has already reacted to this session (by body
   *  name) — so a scan and its later DSS map each fire at most once. */
  private copilotSeenBodies = new Set<string>();
  /** The session tally last shown to the copilot; repeated verbatim it becomes
   *  the thing it talks about instead of what is actually happening. */
  private lastStateTally = '';
  /** "Move 500 m before the next sample" — Odyssey's clonal colony radius. */
  private sampleRange = new SampleRangeTracker();
  private sampleCount = new SampleCounter();
  /** Whether the commander owns a fleet carrier, and what it runs on. */
  private carrier = (() => {
    const t = new CarrierTracker();
    try {
      t.load(JSON.parse(localStorage.getItem('edmo.carrier.v1') ?? 'null'));
    } catch {
      /* start empty */
    }
    return t;
  })();
  /** Doors already known to be shut. Persisted — a carrier locked to its
   *  owner's squadron is still locked next session, and market data will keep
   *  advertising it either way. */
  private denials = (() => {
    const d = new DockingDenials();
    try {
      d.load(JSON.parse(localStorage.getItem('edmo.denials.v1') ?? '[]'));
    } catch {
      /* start with every door assumed open */
    }
    return d;
  })();
  /**
   * The carrier's own two clocks: the ~16 min lockdown after plotting a jump,
   * and the 5 min cooldown after arriving. Persisted, because a lockdown
   * outlives an app restart and the commander is usually off doing something
   * else while it runs.
   */
  private jumpClock = (() => {
    const t = new CarrierJumpTracker();
    try {
      t.load(JSON.parse(localStorage.getItem('edmo.carrierjump.v1') ?? 'null'));
    } catch {
      /* clocks re-learn themselves from the next jump */
    }
    return t;
  })();
  private jumpAnnouncer = new CarrierJumpAnnouncer();
  /** Last phase kind announced in the feed — so the tick only writes on change. */
  private lastJumpPhaseKind = '';
  /** Last trade run the operator found, shown as a dismissible card. */
  private tradeRun: TradeFind | null = null;
  /** The World of Death landing clock. Calibration persists — the orbit is
   *  periodic, so one good scan keeps timing windows across sessions. */
  private deathClock = (() => {
    const d = new DeathClock();
    try {
      d.load(JSON.parse(localStorage.getItem('edmo.deathclock.v1') ?? 'null'));
    } catch {
      /* start uncalibrated */
    }
    return d;
  })();
  private deathAnnouncer = new DeathClockAnnouncer();
  /**
   * The colonisation build. Persisted, because the requirement is stated only
   * on the contribution panel at the site: a commander who undocks to go
   * shopping cannot read the list again until they fly back to it.
   */
  private construction = (() => {
    const c = new ConstructionTracker();
    try {
      c.load(JSON.parse(localStorage.getItem('edmo.construction.v1') ?? 'null'));
    } catch {
      /* the next depot event restates the whole list anyway */
    }
    return c;
  })();
  /** Commodity key → where it can be bought, from the galaxy scan. */
  private architectSources = new Map<string, ArdentMarketRow[]>();
  private architectScanning = false;
  private architectScannedAt: number | null = null;
  private architectScanError: string | null = null;
  /** The system the scan was run from — a jump invalidates its distances. */
  private architectScanFrom: string | null = null;
  /** Depot state already announced, so the shopping list is called out once. */
  private saidDepot = '';
  /** Last market-covers-the-build line said, so re-reading a board is silent. */
  private saidMarketCover = '';
  /** Commodity key → tons in the hold, from Cargo.json's Inventory. */
  private cargoManifest = new Map<string, number>();
  /**
   * The local wire. Persisted per system, because a paper the commander opens
   * after a relog should not be blank while it waits for the next edition.
   */
  private news: NewsItem[] = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('edmo.news.v1') ?? '[]') as NewsItem[];
      return Array.isArray(raw) ? raw.slice(-30) : [];
    } catch {
      return [];
    }
  })();
  /**
   * The paper's standing cast — the teams, bars and people it has invented and
   * is now committed to. Persisted with the stories, because a dock league
   * that fields different teams every edition is not a league.
   */
  private newsCast: CastMember[] = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('edmo.newscast.v1') ?? '[]') as CastMember[];
      return Array.isArray(raw) ? trimCast(raw) : [];
    } catch {
      return [];
    }
  })();
  /**
   * Last price seen per station+commodity, so the economy desk can report a
   * MOVE rather than a listing. The market memory itself only holds the
   * current board — record() overwrites — so without this there is nothing to
   * compare against and every price is "steel costs 3,456".
   */
  private newsPrices: PriceMemory = (() => {
    try {
      const raw = JSON.parse(localStorage.getItem('edmo.newsprices.v1') ?? '{}') as PriceMemory;
      return raw && typeof raw === 'object' ? raw : {};
    } catch {
      return {};
    }
  })();
  /** Editions filed, so the desk rotation moves on each time. */
  private newsEdition = 0;
  private newsAt: number | null = null;
  private newsBusy = false;
  private newsError: string | null = null;
  /** Which panel fills the card area; the clock and plotter are offered as tabs. */
  private view: 'missions' | 'deathclock' | 'plotter' | 'architect' | 'news' = 'missions';

  // ------------------------------------------------------------- the plotter
  /**
   * A plotted route outlives the app: a carrier run to Colonia is forty-six
   * jumps over several evenings, and losing the list on restart would mean
   * re-plotting from wherever the carrier happens to be — with the tritium
   * already spent. Persisted whole, position and all.
   */
  private plotSaved: {
    route?: PlottedRoute | null;
    idx?: number;
    kind?: PlotKind;
    hold?: number;
    efficiency?: number;
  } = (() => {
    try {
      return JSON.parse(localStorage.getItem('edmo.plot.v1') ?? '{}');
    } catch {
      return {};
    }
  })();
  private plot: PlottedRoute | null = (() => {
    // A route from an older build (or a half-written storage entry) would blow
    // up the card on its first render, which is a worse first impression than
    // an empty plotter. Anything that is not clearly a route is discarded.
    const r = this.plotSaved.route;
    return r && Array.isArray(r.waypoints) && r.waypoints.length > 1 ? r : null;
  })();
  private plotIdx = this.plotSaved.idx ?? 0;
  private plotKind: PlotKind = this.plotSaved.kind === 'carrier' ? 'carrier' : 'ship';
  private plotTarget = '';
  private plotEfficiency = this.plotSaved.efficiency ?? 60;
  /** Tritium the commander says is in the carrier's hold. The journal reports
   *  the hold's TONNAGE but never what is in it, so this one has to be told. */
  private plotHold = this.plotSaved.hold ?? 0;
  private plotBusy = false;
  private plotError: string | null = null;
  /**
   * The tool calls and results from the LAST answered question.
   *
   * Tool output used to live only inside one question's agentic loop and was
   * thrown away with it, so a follow-up about the numbers had nothing to read.
   * Asked "where can I buy tritium cheapest" and then "how much have they got
   * in storage", the operator answered that it could not know — while the stock
   * figure had been in the tool result it had just discarded. Carrying the last
   * exchange forward fixes that without unbounded growth: one question's worth,
   * replaced each time.
   */
  private lastToolExchange: ChatMessage[] = [];
  /**
   * What a station really is, keyed by name: "refinery outpost", "industrial
   * Coriolis". Station NAMES lie — Neugebauer Mines is a refinery, not a mine —
   * and a model given only a name will read the name as a fact.
   */
  private stationFacts = new Map<string, string>();
  // --- the copilot's read on how the run is GOING (state, not events) ---
  /** When live play started — fatigue is a long shift, not a long app uptime. */
  private sessionStartAt = 0;
  /** Jumps since the last time we were docked — the grind of a long haul. */
  private jumpsSinceDock = 0;
  /** Consecutive mission wins / losses — mood, reset by the other outcome. */
  private winStreak = 0;
  private lossStreak = 0;
  /** How many times we've docked at each station this session (route repeat). */
  private dockVisits = new Map<string, number>();
  /** What the commander told the operator to watch for while mining ("looking
   *  for tritium at 20%"), or null. Set from the ask box; cleared on restart. */
  private prospectTarget: ProspectTarget | null = null;

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
  /** What the last few beats were ABOUT, for the same-subject gate. */
  private recentTopics: BeatTopic[] = [];
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
    // Subjects run deeper than wording: a stuck record is audible long before
    // the words repeat, so the topic ring remembers more beats than the text
    // ring does.
    this.recentTopics.push(topicOf(text));
    if (this.recentTopics.length > 6) this.recentTopics = this.recentTopics.slice(-6);
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
      engine: this.engine,
      engineProgress: this.engineProgress,
      aiSetupOffer: this.aiSetupOffer(),
      trade: this.tradeOpp,
      bio: this.bioLead,
      shipStatus: this.hudShipStatus(),
      exploreLead: this.explore.leads()[0] ?? null,
      route: this.route,
      tradeRun: this.tradeRun,
      deathClock: (() => {
        const inSystem = this.inWodSystem();
        // Also worth a tab while flying TOWARD it with a calibrated clock —
        // that is exactly when a commander times the arrival.
        const routed =
          this.deathClock.state.epochMs != null &&
          (this.navRouteDest ?? '').trim().toLowerCase() === WOD_SYSTEM.toLowerCase();
        return inSystem || routed ? { state: this.deathClock.state, inSystem } : null;
      })(),
      plotter: this.plotterView(),
      architect: this.architectView(),
      news: this.settings.news.enabled ? this.newsView() : null,
      view: this.view,
      shipPanel: this.shipPanel(),
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
   *  — a failed glance is silent, so optimism costs nothing. On the bundled
   *  engine vision is known by construction: every shipped model has an mmproj
   *  (T7.5.2), so the "no vision" warning can never fire spuriously. */
  private activeModelIsVlm(): boolean {
    if (this.settings.lm.engine === 'bundled') return this.engine?.running ?? false;
    const m = this.activeModel();
    if (!m) return false;
    const ty = this.modelTypes[m];
    return ty === undefined ? true : ty === 'vlm';
  }

  // ------------------------------------------------------- bundled AI engine
  /** Last known state of the app's own llama.cpp engine (null until polled). */
  private engine: EngineStatus | null = null;
  private engineProgress: EngineProgress | null = null;

  /** Where chat requests actually go, and the key they need. The bundled engine
   *  serves OpenAI-compatible endpoints on a random loopback port behind a
   *  per-session token; LM Studio needs no auth. */
  private lmTarget(): { endpoint: string; apiKey: string | null } {
    if (this.settings.lm.engine === 'bundled' && this.engine?.running && this.engine.port) {
      return { endpoint: `http://127.0.0.1:${this.engine.port}`, apiKey: this.engine.api_key };
    }
    return { endpoint: this.settings.lm.endpoint, apiKey: null };
  }

  /** Refresh engine status (installed runtime, models, whether it's serving). */
  async refreshEngine(): Promise<void> {
    if (!isTauri) return;
    try {
      this.engine = await engineStatus(this.specs?.gpus.map((g) => g.name) ?? []);
    } catch {
      this.engine = null;
    }
    this.emit();
  }

  /**
   * Refresh a stale llama.cpp runtime at startup, before the engine is asked
   * to serve anything.
   *
   * The pinned build had been bumped exactly never in a way that reached an
   * existing install: engine.rs wrote build.txt on every download and nothing
   * ever read it back, so the first runtime a machine fetched was the one it
   * kept. Runs BEFORE the model auto-resume below so the new binary is the one
   * that starts, and stays silent unless there is actually something to do.
   */
  private async maybeUpdateRuntime(): Promise<void> {
    if (!isTauri) return;
    const e = this.engine;
    if (!e?.runtime_installed || !e.runtime_outdated) return;
    if (!this.settings.lm.autoUpdateRuntime) {
      this.pushFeed(
        'system',
        `A newer inference runtime is available (${e.runtime_build ?? 'unknown'} → ${e.runtime_latest}). Settings → AI engine to update.`,
      );
      return;
    }
    const backend = e.runtime_backend ?? e.recommended_backend;
    this.pushFeed('system', `⬇ Updating the inference runtime (${e.runtime_build ?? 'unknown'} → ${e.runtime_latest})…`);
    try {
      // Nothing has started the engine yet at this point in boot, but a
      // resumed session could still be holding the exe — Windows will not let
      // the archive overwrite a running binary.
      if (e.running) await engineStop();
      await engineDownloadRuntime(backend);
      await this.refreshEngine();
      this.pushFeed('system', `✅ Inference runtime updated to ${e.runtime_latest}.`);
    } catch (err) {
      // A failed update must never block the session: the old runtime is still
      // on disk and still works.
      this.pushFeed('system', `Runtime update skipped (${String(err)}) — keeping ${e.runtime_build ?? 'the current build'}.`);
    }
  }

  async engineSetup(backend: string, modelId: string): Promise<void> {
    if (!isTauri) return;
    try {
      // Refresh a stale runtime on the same click that would have installed a
      // missing one. build.txt has been written since the first release and
      // never read, so a bumped pin only ever reached new installs — everyone
      // else stayed on whatever they first downloaded. The archive is ~32 MB
      // and extraction overwrites in place, so this is cheap and safe.
      if (!this.engine?.runtime_installed) {
        this.pushFeed('system', `⬇ Downloading the inference runtime (${backend})…`);
        await engineDownloadRuntime(backend);
      } else if (this.engine.runtime_outdated) {
        this.pushFeed(
          'system',
          `⬇ Updating the inference runtime (${this.engine.runtime_build ?? 'unknown'} → ${this.engine.runtime_latest})…`,
        );
        // Windows will not let the archive overwrite llama-server.exe while it
        // is running, and extraction would fail half-done. Stop first; the
        // model start at the end of this function brings it back.
        if (this.engine.running) await engineStop();
        await engineDownloadRuntime(backend);
      }
      const model = this.engine?.models.find((m) => m.id === modelId);
      if (!modelId.startsWith('local:') && !model?.installed) {
        this.pushFeed('system', `⬇ Downloading ${model?.label ?? modelId} — this is the big one.`);
        await engineDownloadModel(modelId);
      }
      await this.refreshEngine();
      await this.engineStartModel(modelId);
    } catch (e) {
      this.pushFeed('system', `AI setup failed: ${String(e)}`);
      this.emit();
    }
  }

  /**
   * Context window to give the engine. 8K was leaving very little headroom: a
   * screen-reading call is text + 1–2.5k image tokens + up to 2k generated
   * (plus gemma's hidden reasoning), and the living copilot keeps a whole
   * session. Measured on a 16 GB card, 32K loads as fast as 8K, so scale it to
   * the GPU budget the game leaves us rather than hardcoding the floor.
   */
  private engineCtxSize(): number {
    const budget = this.specs ? gpuBudgetGb(this.specs, true) : 0;
    if (budget >= 8) return 32768;
    if (budget >= 5) return 16384;
    return 8192;
  }

  async engineStartModel(modelId: string): Promise<void> {
    if (!isTauri) return;
    this.pushFeed('system', '⚙ Starting the local AI engine…');
    try {
      // Fit the engine around the game, not the other way round: the layer
      // budget and the vision-on-CPU choice both come from the GPU headroom
      // Elite leaves us. Before this the launcher always sent every layer to
      // the card, whatever the settings panel's own advisor was warning.
      const info = this.engine?.models.find((m) => m.id === modelId);
      const modelGb = info ? info.bytes / 1e9 : 0;
      const layers = gpuLayerBudget(this.specs, modelGb, MODEL_LAYERS_ESTIMATE, true);
      const visionOnCpu = shouldKeepVisionOnCpu(this.specs, true);
      // Some models cannot be told to skip reasoning per-request without
      // crashing the driver; they get it capped at launch instead.
      const budget = reasoningBudgetFor(profileFor(modelId));
      this.engine = await engineStart(modelId, this.engineCtxSize(), layers, visionOnCpu, budget);
      this.settings = { ...this.settings, lm: { ...this.settings.lm, engine: 'bundled', bundledModel: modelId } };
      saveSettings(this.settings);
      this.pushFeed('system', '✅ Local AI engine ready — no LM Studio needed.');
      await this.pollLm();
    } catch (e) {
      this.pushFeed('system', `The AI engine could not start: ${String(e)}`);
    }
    this.emit();
  }

  async engineShutdown(): Promise<void> {
    if (!isTauri) return;
    try {
      await engineStop();
    } catch {
      /* already gone */
    }
    await this.refreshEngine();
  }

  /** Has the commander waved the first-run AI offer away this install? */
  private aiSetupDismissed = localStorage.getItem('edmo.ai.setup.dismissed') === '1';

  /**
   * The first-run offer: shown only when there is genuinely nothing to talk to
   * — no bundled engine running, no LM Studio answering — and we have a tier
   * that fits. Everything else in the app works without it, so this is an
   * invitation, never a wall.
   */
  private aiSetupOffer(): { modelId: string; label: string; gb: string; backend: string } | null {
    if (!isTauri || this.aiSetupDismissed) return null;
    if (this.lmOk || this.engine?.running) return null;
    const e = this.engine;
    if (!e || e.models.some((m) => m.installed)) return null;
    // Pick the biggest tier that still fits beside the game, else the smallest.
    const budget = this.specs ? gpuBudgetGb(this.specs, true) : 0;
    const fits = e.models.filter((m) => m.needs_gb <= budget);
    const pick = (fits.length ? fits : e.models).reduce((a, b) => (a.needs_gb > b.needs_gb ? a : b));
    const runtimeGb = e.runtime_installed ? 0 : 0.1;
    return {
      modelId: pick.id,
      label: pick.label,
      gb: (pick.bytes / 1e9 + runtimeGb).toFixed(1),
      backend: e.runtime_backend ?? e.recommended_backend,
    };
  }

  /** One-button first-run setup: runtime (if needed) + model + start. */
  async startAiSetup(): Promise<void> {
    const offer = this.aiSetupOffer();
    if (!offer) return;
    await this.engineSetup(offer.backend, offer.modelId);
  }

  dismissAiSetup(): void {
    this.aiSetupDismissed = true;
    try {
      localStorage.setItem('edmo.ai.setup.dismissed', '1');
    } catch {
      /* the offer simply returns next launch */
    }
    this.emit();
  }

  /** Discard a paused download's partial file, then refresh the list. */
  async engineDiscardPartial(modelId: string): Promise<void> {
    if (!isTauri) return;
    await engineDiscardPartial(modelId).catch(() => undefined);
    await this.refreshEngine();
  }

  async engineCancel(): Promise<void> {
    if (isTauri) await engineCancelDownload().catch(() => undefined);
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
        onEngineProgress((p) => {
          // 'phase-done' markers clear the bar; everything else drives it.
          this.engineProgress = /-done$/.test(p.phase) ? null : p;
          this.emit();
        }),
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

      void this.refreshEngine()
        .then(() => this.maybeUpdateRuntime())
        .then(() => {
        // Auto-resume the bundled engine the user last chose, so the copilot is
        // ready without a visit to Settings.
        const { engine, bundledModel } = this.settings.lm;
        // Only resume a model that is actually still on disk — a remembered id
        // whose files were removed must fall through to the setup offer quietly,
        // not greet the commander with a start failure.
        const stillInstalled =
          !!bundledModel &&
          (bundledModel.startsWith('local:') ||
            (this.engine?.models.some((m) => m.id === bundledModel && m.installed) ?? false));
        if (engine === 'bundled' && stillInstalled && !this.engine?.running) {
          void this.engineStartModel(bundledModel!);
        } else {
          void this.pollLm();
        }
      });
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
    this.resetCopilot(); // fresh session → fresh conversation
    this.copilotSeenBodies.clear();
    this.deathAnnouncer = new DeathClockAnnouncer(); // clock itself persists
    this.view = 'missions';
    this.deathClockSweepDone = false; // directory may have changed — sweep again
    this.deathClockFssHinted = false;
    this.prospectTarget = null;
    this.sessionStartAt = 0;
    this.jumpsSinceDock = 0;
    this.winStreak = 0;
    this.lossStreak = 0;
    this.dockVisits.clear();
    void this.sweepDeathClockHistory();
    void this.sweepBioHistory();
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
      this.carrier.apply(ev);
      // The lockdown / cooldown clocks. Folded for every event so a bootstrap
      // replay restores a jump that is still counting down.
      if (ev.event.startsWith('Carrier')) {
        this.jumpClock.apply(ev);
        try {
          localStorage.setItem('edmo.carrierjump.v1', JSON.stringify(this.jumpClock.toJSON()));
        } catch {
          /* the clock still runs for this session */
        }
        if (live && this.bootstrapped && ev.event === 'CarrierJumpRequest') {
          const dest = this.jumpClock.destination;
          const line = describePhase(this.jumpClock.phase(Date.now()));
          if (dest && line) {
            this.pushFeed('system', `🕐 ${line}`);
            this.speak(line);
          }
        }
      }
      // The colonisation shopping list. Folded always, so a bootstrap replay
      // restores the requirement without flying back to the site; announced and
      // scanned only when it happens live.
      if (this.construction.apply(ev)) {
        try {
          localStorage.setItem('edmo.construction.v1', JSON.stringify(this.construction.toJSON()));
        } catch {
          /* the list still stands for this session */
        }
        if (live && this.bootstrapped) this.announceConstruction();
      }
      // Remember doors that stay shut (and forget one that opens on a Docked).
      if (this.denials.apply(ev, this.sm.location.system)) {
        try {
          localStorage.setItem('edmo.denials.v1', JSON.stringify(this.denials.toJSON()));
        } catch {
          /* the refusal still holds for this session */
        }
      }
      this.ship.apply(ev);
      this.materials.apply(ev);
      this.explore.apply(ev);
      // Any scan of the World of Death recalibrates its landing clock — even
      // one replayed from an old journal, since the orbit is periodic.
      if (this.deathClock.apply(ev)) {
        this.persistDeathClock();
        if (live && this.bootstrapped) this.announceDeathClockCalibrated('your scan');
      }
      // Teach the status tracker the fuel-tank size so it can report fuel %.
      if (ev.event === 'Loadout' && this.ship.current?.fuelCapacity) {
        this.statusTracker.setFuelCapacity(this.ship.current.fuelCapacity);
      }
      // Route cancelled in-game. Without this the last plotted route lingered
      // and the operator kept counting down jumps to a destination the commander
      // had already abandoned.
      if (ev.event === 'NavRouteClear') {
        this.navRoute = [];
        this.navRouteJumps = 0;
        this.navRouteDest = null;
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
      // Position on the plotted route, recomputed AFTER the state manager has
      // moved the commander. Runs during bootstrap too, so a route restored
      // from last session opens at the waypoint they are actually standing on.
      if (
        ev.event === 'FSDJump' ||
        ev.event === 'Location' ||
        ev.event === 'CarrierJump' ||
        ev.event === 'CarrierLocation'
      ) {
        this.onArrivalForPlot(live && this.bootstrapped);
        // Crossing into another region rewrites who the operator is and where
        // they sit — otherwise a run that started in Colonia is still being
        // told it is in Colonia twenty thousand light-years later.
        if (live && this.bootstrapped) this.refreshPlaceIfRegionChanged();
      }
      if (live && this.bootstrapped) {
        this.announce(changes, ev.timestamp);
        this.tactical(ev);
        this.noteMoment(ev);
        // Session over → distill it into long-term memory once the
        // chronicler (saga, scheduled below) has had its turn.
        if (ev.event === 'Shutdown' && this.settings.memory.enabled) {
          this.pendingReflectAt = Date.now() + 45_000;
          this.reflectRetries = 0;
          this.reflectManual = false;
        }
        if (ev.event === 'LoadGame') this.carrier.resetSession();
        if (ev.event === 'CarrierLocation' || ev.event === 'CarrierStats' || ev.event === 'Docked') {
          try {
            localStorage.setItem('edmo.carrier.v1', JSON.stringify(this.carrier.toJSON()));
          } catch {
            /* storage full or unavailable — ownership is re-learned next session */
          }
        }
        if (ev.event === 'Docked') {
          // Fatigue resets in a docking bay; note how often we've been here.
          this.jumpsSinceDock = 0;
          const where = typeof ev.StationName === 'string' ? ev.StationName : this.sm.location.station;
          if (where) {
            this.dockVisits.set(where, (this.dockVisits.get(where) ?? 0) + 1);
            const fact = describeStation(ev);
            if (fact) this.stationFacts.set(where, fact);
          }
          this.maybeLedger();
        }
        // Session over → the chronicler files tonight's episode.
        if (ev.event === 'Shutdown' && this.settings.saga.enabled) {
          setTimeout(() => this.tellSaga(), 3000);
        }
      }
    }
    if (live) {
      if (!this.sessionStartAt) this.sessionStartAt = Date.now(); // fatigue clock
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

  // ------------------------------------------------------------- death clock
  private inWodSystem(): boolean {
    return this.sm.location.system.trim().toLowerCase() === WOD_SYSTEM.toLowerCase();
  }

  private persistDeathClock(): void {
    try {
      localStorage.setItem('edmo.deathclock.v1', JSON.stringify(this.deathClock.toJSON()));
    } catch {
      /* a re-scan recalibrates in seconds */
    }
  }

  /** One phrase for "where the window is right now", for feed + voice. */
  private deathClockNow(): string | null {
    const p = phaseOf(this.deathClock.state, Date.now());
    if (!p) return null;
    if (p.zone === 'clear') return `the window is open — ${speakableDur(p.countdownS)} until leave-by`;
    if (p.zone === 'board') return `the window is closing — ${speakableDur(p.countdownS)} left`;
    return `the next landing window opens in ${speakableDur(p.opensInS)}`;
  }

  /** The magic moment: a scan of A 1 just set the clock by itself. Speaks only
   *  when it matters (game live, in the system) and primes the announcer so the
   *  next tick doesn't repeat the same picture as an arrival call. */
  private announceDeathClockCalibrated(origin: string): void {
    const now = this.deathClockNow();
    if (!now) return;
    const text = `Death clock calibrated from ${origin}: ${now}.`;
    this.pushFeed('system', `☠ ${text}`);
    if (Date.now() - this.lastGameActivity < GAME_LIVE_WINDOW_MS && this.inWodSystem()) {
      this.speak(text);
      this.copilotEvent(`EVENT: The World of Death landing clock calibrated (${origin}) — ${now}.`);
      this.deathAnnouncer.prime(phaseOf(this.deathClock.state, Date.now()), true);
    }
  }

  /** Whether this launch already swept the journal history for an old A 1 scan. */
  private deathClockSweepDone = false;
  /** The one-time organic-sample backfill has run this watch. */
  private bioSweepDone = false;
  /** FSS coaching said this session ("tuned to it — now zoom in"). */
  private deathClockFssHinted = false;

  /**
   * The "it just works" path: with no fix on the clock, sweep the ENTIRE
   * journal history on disk for any past scan of A 1. The orbit is periodic,
   * so a fly-by from months ago is still an exact calibration — and the
   * session bootstrap never replays that far back. Runs once per watch start,
   * in the background; a live scan later still supersedes it.
   */
  private async sweepDeathClockHistory(): Promise<void> {
    if (!isTauri || this.deathClockSweepDone) return;
    this.deathClockSweepDone = true;
    if (this.deathClock.state.epochMs != null) return;
    try {
      const lines = await journalScanHistory(this.settings.journal.directory, WOD_BODY, 3);
      for (const line of lines) {
        const ev = parseJournalLine(line);
        if (ev && this.deathClock.apply(ev)) {
          this.persistDeathClock();
          const when = new Date(this.deathClock.state.calibratedAt ?? 0).toLocaleDateString();
          this.announceDeathClockCalibrated(`your old scan of A 1 (${when})`);
          this.emit();
          return;
        }
      }
    } catch {
      /* no history or no shell — the live scan path still calibrates */
    }
  }

  /**
   * Edge-triggered landing-window calls (window open / leave-by / closed /
   * opens-soon), spoken only while the game is live and the commander is in
   * the system. Runs on the 15 s heartbeat and immediately on jump events.
   */
  private maybeDeathClock(): void {
    const live = Date.now() - this.lastGameActivity < GAME_LIVE_WINDOW_MS;
    const alerts = this.deathAnnouncer.tick(
      phaseOf(this.deathClock.state, Date.now()),
      live && this.inWodSystem(),
    );
    for (const a of alerts) {
      this.pushFeed('nudge', `☠ ${a.message}`, { severity: a.severity });
      this.speak(a.message);
      if (a.kind !== 'opens-soon') this.copilotEvent(`EVENT: ${a.message}`);
    }
    if (alerts.length) this.emit();
  }

  /**
   * The carrier's jump clocks: the two edges worth interrupting for.
   *
   * A minute before departure (be aboard, or don't be) and the moment the
   * cooldown clears (the next hop can be plotted). Everything between is on
   * the card as a digital counter — the point of the cooldown clock is that
   * the commander can go and mine the tritium for the next hop and be told
   * when it is worth coming back.
   */
  private maybeCarrierJump(): void {
    const now = Date.now();
    const phase = this.jumpClock.phase(now);
    if (phase.kind !== this.lastJumpPhaseKind) {
      this.lastJumpPhaseKind = phase.kind;
      if (phase.kind === 'cooldown') this.copilotEvent('EVENT: The carrier has arrived and is cooling down.');
    }
    const live = now - this.lastGameActivity < GAME_LIVE_WINDOW_MS;
    if (!live) return;
    const say = this.jumpAnnouncer.next(phase);
    if (say) {
      this.pushFeed('nudge', `🕐 ${say}`, { severity: 'info' });
      this.speak(say);
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
    // Records and returns are session milestones — a personal-best jump means
    // the commander is out exploring. Context only: the memory line above is
    // the spoken one, so the copilot never doubles it.
    this.copilotEvent(`EVENT: ${best.ev.text}`);
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

  /**
   * Backfill every organic sample ever taken, from the journals on disk.
   *
   * A sample is permanent; the bootstrap replay is one session deep. Standing
   * on HIP 71120 2 e — four genera, Tussock Cultro logged there in August 2025
   * — the app counted the 2025 receipt as missing and reported one more genus
   * uncollected than was really down there. Runs once per watch start, in the
   * background, and is silent: it only ever REMOVES phantom work, so there is
   * nothing to announce.
   */
  private async sweepBioHistory(): Promise<void> {
    if (!isTauri || this.bioSweepDone) return;
    this.bioSweepDone = true;
    try {
      const lines = await journalOrganicHistory(this.settings.journal.directory);
      let found = 0;
      for (const line of lines) {
        const ev = parseJournalLine(line);
        if (!ev) continue;
        this.bioTracker.apply(ev);
        found++;
      }
      if (found && this.bioTracker.dirty) {
        this.recomputeBio(false);
        this.emit();
      }
    } catch {
      /* no history or no shell — live samples still count */
    }
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
      // Once DSS mapping names the genera we can turn "there is life here" into
      // the decision the commander actually faces: worth landing, and how much
      // walking. Before that, all we honestly have is a signal count.
      const haul = b.genuses.length ? describeBioHaul(b.genuses, b.untouched) : null;
      const text = haul
        ? `Bio on ${b.body}. ${haul.text}`
        : `Bio signals on ${b.body}: ${b.remaining} uncollected${genus}. Vista Genomics pays for those, commander.`;
      this.pushFeed('system', `🧬 ${text}`);
      this.speak(text);
      // Exploration is a change of activity, not a footnote — tell the copilot,
      // or it keeps talking about hand-ins while the commander is out scanning.
      this.copilotEvent(`EVENT: Bio signals found on ${b.body} — ${b.remaining} uncollected${genus}.`);
      this.copilotReact('discovery', 'copilot — reacting to bio signals…');
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
        // Hand over what the station actually IS. Without it the model reads the
        // NAME as a fact and invents the rest ("Neugebauer Mines… a little
        // mining spot" — it is a refinery).
        const known = this.stationFacts.get(station);
        const kind = known ?? stationKind(ev.StationType);
        this.copilotEvent(
          `EVENT: Docking granted — pad ${pad} at ${station}${kind ? `, ${kind}` : ''}.`,
        );
        this.copilotReact('arrival', 'copilot — reacting to docking clearance…');
        break;
      }
      case 'DockingDenied': {
        // RestrictedAccess was missing from this table, so a locked carrier
        // made the operator read the raw enum out loud — "Docking denied,
        // RestrictedAccess" — which tells a commander nothing about whether to
        // try again or fly somewhere else.
        const why = explainDenial(typeof ev.Reason === 'string' ? ev.Reason : '');
        const station = typeof ev.StationName === 'string' ? ev.StationName : '';
        const text = `Docking denied — ${why}.`;
        this.pushFeed('system', `⛔ ${text}${station ? ` (${station})` : ''}`);
        this.speak(text);
        this.copilotEvent(`EVENT: Docking denied at ${station || 'a station'} — ${why}.`);
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
        this.copilotSeenBodies.clear();
        break;
      case 'FSSBodySignals': {
        // Tuned to the World of Death in the FSS with no fix yet: the one
        // moment a commander is a single zoom away from calibrating the clock.
        // Tuning alone writes THIS event but no Scan — coach the last step.
        if (this.deathClock.state.epochMs != null || this.deathClockFssHinted) break;
        const body = typeof ev.BodyName === 'string' ? ev.BodyName : '';
        if (body.trim().toLowerCase() !== WOD_BODY.toLowerCase()) break;
        this.deathClockFssHinted = true;
        const text =
          "That's the World of Death on your scanner — zoom in and complete the scan, and the death clock sets itself.";
        this.pushFeed('nudge', `☠ ${text}`, { severity: 'info' });
        this.speak(text);
        break;
      }
      case 'FSDJump':
      case 'Location': {
        // The World of Death gets its clock the moment the commander arrives —
        // the tab opens itself and the operator reads the window out loud.
        const sys = typeof ev.StarSystem === 'string' ? ev.StarSystem : '';
        const wod = sys.trim().toLowerCase() === WOD_SYSTEM.toLowerCase();
        if (wod) this.view = 'deathclock';
        else if (this.view === 'deathclock') this.view = 'missions';
        this.maybeDeathClock();
        break;
      }
      case 'Scan': {
        // A notable WORLD found — the copilot pipes up for the ones that make
        // an explorer sit forward (not every auto-scanned rock), once each.
        const { tier, terraformable } = classifyBody(ev);
        if (!['earthlike', 'water', 'ammonia', 'terraformable'].includes(tier)) break;
        const body = typeof ev.BodyName === 'string' ? ev.BodyName : 'a body';
        if (this.copilotSeenBodies.has(body)) break;
        this.copilotSeenBodies.add(body);
        const pc = typeof ev.PlanetClass === 'string' ? ev.PlanetClass : tier;
        this.copilotEvent(
          `EVENT: Scanned ${body} — ${pc}${terraformable && !/terraform/i.test(pc) ? ', terraformable' : ''}.`,
        );
        this.copilotReact('discovery', 'copilot — reacting to a notable world…');
        break;
      }
      case 'SAAScanComplete': {
        // DSS surface map finished — the payoff moment. React only for the
        // valuable worlds we already flagged, so mapping filler bodies is quiet.
        const body = typeof ev.BodyName === 'string' ? ev.BodyName : 'that body';
        if (!this.copilotSeenBodies.has(body)) break;
        this.copilotEvent(`EVENT: Finished surface-mapping ${body}.`);
        this.copilotReact('discovery', 'copilot — reacting to a completed map…');
        break;
      }
      case 'FSSDiscoveryScan': {
        // The honk: the moment a commander starts working a system. This is the
        // clearest signal that the run has turned to exploration, so the copilot
        // stops talking about finished hand-ins.
        const sys = typeof ev.SystemName === 'string' ? ev.SystemName : this.sm.location.system;
        const bodies = typeof ev.BodyCount === 'number' ? ev.BodyCount : null;
        this.copilotEvent(
          `EVENT: Discovery scan of ${sys}${bodies ? ` — ${bodies} bodies detected` : ''}. The commander is exploring.`,
        );
        this.copilotReact('discovery', 'copilot — reacting to a discovery scan…');
        break;
      }
      case 'ScanOrganic': {
        const genus = (ev.Genus_Localised as string) ?? (ev.Genus as string) ?? 'an organism';
        const species = (ev.Species_Localised as string) ?? genus;
        const st = this.statusTracker.current;
        // Odyssey needs three samples of a species, each taken outside the
        // previous one's clonal colony radius. Missing that distance rejects the
        // sample, so call the number the moment the sample lands.
        const taken = this.sampleCount.note(species, String(ev.ScanType));
        if (taken != null) {
          // The third sample needs no walk — the analysis follows on its own a
          // few seconds later. Telling the commander to hike another 800 m here
          // is the one thing worse than saying nothing.
          if (taken >= 3) {
            this.sampleRange.clear();
            const text = `Sample 3 of 3 — ${species}. That's the set.`;
            this.pushFeed('system', `🧬 ${text}`);
            this.speak(text);
            this.copilotEvent(`EVENT: Took the third and last ${species} sample; the set is complete.`);
            break;
          }
          if (st?.latitude != null && st.longitude != null && st.planetRadius) {
            const fix = this.sampleRange.sample(species, st.latitude, st.longitude, st.planetRadius, taken);
            const text = `Sample ${taken} of 3 — ${species}. Move at least ${fix.requiredM} m before the next one.`;
            this.pushFeed('system', `🧬 ${text}`);
            this.speak(text);
            this.copilotEvent(`EVENT: Took sample ${taken}/3 of ${species}; needs ${fix.requiredM} m before the next.`);
          }
          break;
        }
        if (ev.ScanType !== 'Analyse') break;
        // Set banked. Say what is still uncollected on this rock, or the
        // copilot will cheerfully suggest leaving with two genera still down
        // there.
        this.sampleRange.clear();
        const left = this.bioTracker.uncollectedOn(ev.SystemAddress, ev.Body);
        this.copilotEvent(
          `EVENT: Completed the ${species} sample set — three of three.` +
            (left.length
              ? ` Still uncollected on this body: ${left.join(', ')}.`
              : ' That is every species on this body.'),
        );
        this.copilotReact('discovery', 'copilot — reacting to a completed sample set…');
        break;
      }
      case 'SellOrganicData': {
        // The payday the whole exobiology loop exists for. It used to pass in
        // total silence: this event carries no TotalEarnings, so nothing in the
        // app had a number to react to.
        const sale = parseBioSale(ev.BioData);
        if (!sale) break;
        const text = describeBioSale(sale);
        this.pushFeed('system', `🧬 ${text}`);
        this.speak(text);
        this.copilotEvent(
          `EVENT: Sold biology at Vista Genomics for ${Math.round(sale.total).toLocaleString('en-US')} cr` +
            ` — ${sale.species.join(', ')}` +
            (sale.firstLogs
              ? `; ${sale.firstLogs} first log(s), worth ${Math.round(sale.bonus).toLocaleString('en-US')} cr of the total.`
              : '.'),
        );
        this.copilotReact('mission', 'copilot — reacting to a bio payday…');
        break;
      }
      case 'MultiSellExplorationData':
      case 'SellExplorationData': {
        const earned = typeof ev.TotalEarnings === 'number' ? ev.TotalEarnings : null;
        if (!earned) break;
        this.copilotEvent(
          `EVENT: Sold cartographic data for ${Math.round(earned).toLocaleString('en-US')} cr.`,
        );
        this.copilotReact('discovery', 'copilot — reacting to a data sale…');
        break;
      }
      case 'FSSAllBodiesFound': {
        // Every body in the system charted — a tidy milestone for an explorer.
        const sys = typeof ev.SystemName === 'string' ? ev.SystemName : this.sm.location.system;
        const count = typeof ev.Count === 'number' ? ev.Count : null;
        this.copilotEvent(`EVENT: Fully scanned ${sys}${count ? ` — all ${count} bodies charted` : ''}.`);
        this.copilotReact('discovery', 'copilot — reacting to a charted system…');
        break;
      }
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
        // Context only (no beat) — the copilot now knows a mining shift started
        // and can weave it into later beats and callbacks.
        this.copilotEvent(`EVENT: Dropped onto the ring at ${body} — a mining shift begins.`);
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
            // Context for callbacks ("that's more than the last ring") — the
            // deterministic line above is the spoken one; no doubled beat.
            this.copilotEvent(`EVENT: ${m} tonnes refined this shift${mix ? `, mostly ${mix}` : ''}.`);
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
          // A core is the standout of a shift — let the copilot add its take
          // (the quick mechanical call above stays, like docking's pad number).
          this.copilotEvent(`EVENT: Prospected a ${lode} core asteroid — worth cracking.`);
          this.copilotReact('discovery', 'copilot — reacting to a core find…');
          return;
        }
        // Call out rocks rich in an ore a mission needs — or, with no mining
        // contract active, anything genuinely worth the limpets: the operator
        // shouldn't go mute just because nobody is paying for the ore.
        const mats = Array.isArray(ev.Materials)
          ? (ev.Materials as Array<{ Name?: string; Name_Localised?: string; Proportion?: number }>)
          : [];
        // Highest priority: a rock matching what the COMMANDER asked us to watch
        // for ("looking for tritium at 20%"). Their explicit goal outranks the
        // generic ore calls, and the copilot chimes in with its own take.
        if (this.prospectTarget) {
          for (const mat of mats) {
            const name = mat.Name_Localised ?? mat.Name ?? '';
            const pct = typeof mat.Proportion === 'number' ? mat.Proportion : 0;
            if (matchesProspect(name, pct, this.prospectTarget)) {
              if (now - this.lastProspectAt < 20_000) return;
              this.lastProspectAt = now;
              this.lastMiningSpokeAt = now;
              const text = `There's your ${this.prospectTarget.commodity} — ${Math.round(pct)}%.`;
              this.pushFeed('system', `⛏ ${text}`);
              this.speak(text);
              this.copilotEvent(`EVENT: Prospected ${Math.round(pct)}% ${name} — the ${this.prospectTarget.commodity} the commander is hunting.`);
              this.copilotReact('discovery', 'copilot — reacting to a target rock…');
              return;
            }
          }
        }
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
        // Keep the WHOLE route: Elite does not rewrite this file as the
        // commander flies, so the count has to be derived from where the ship
        // actually is on each jump, not from the file's length.
        this.navRoute = route.map((r) => r.StarSystem ?? '').filter(Boolean);
        this.navRouteDest = this.navRoute.length ? this.navRoute[this.navRoute.length - 1] : null;
        this.recomputeNavRoute();
      } catch {
        /* keep last-good route */
      }
    }
    else if (name === 'Market.json') {
      try {
        const rec = parseMarketSnapshot(JSON.parse(text));
        if (rec && this.settings.trade.enabled) {
          const known = this.marketMemory.byId(rec.marketId);
          this.marketMemory.record(rec);
          try {
            localStorage.setItem('edmo.markets.v1', JSON.stringify(this.marketMemory.toJSON()));
          } catch {
            /* memory still works in-session */
          }
          this.recomputeTrade();
          // Every docking is a survey. In a system nobody has reported to EDDN
          // this is the ONLY way the build ever learns what is on sale here.
          this.noteMarketForBuild(rec, known?.at ?? null);
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
            this.checkSampleRange();
          }
        }
      } catch {
        /* partial write — next snapshot wins */
      }
    } else if (name === 'Cargo.json') {
      try {
        const c = JSON.parse(text) as {
          Count?: number;
          Inventory?: Array<{ Name?: string; Name_Localised?: string; Count?: number }>;
        };
        this.ship.setCargo(typeof c.Count === 'number' ? c.Count : undefined);
        // The manifest, not just the tonnage: a construction site wants to know
        // that the 16 t aboard is water it is asking for, not bromellite.
        const manifest = new Map<string, number>();
        for (const i of c.Inventory ?? []) {
          const key = commodityKey(i.Name ?? i.Name_Localised ?? '');
          if (key && typeof i.Count === 'number') manifest.set(key, (manifest.get(key) ?? 0) + i.Count);
        }
        this.cargoManifest = manifest;
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
      // The deterministic layer already spoke this; record it so the living
      // copilot has continuity (and won't re-raise it) at its next beat.
      this.copilotEvent(`EVENT: ${a.message}`);
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
  /** The at-a-glance readout shown where the duplicate buttons used to be. */
  private shipPanel(): ShipPanel {
    const st = this.statusTracker.current;
    return buildShipPanel({
      ship: this.ship.current,
      liveCargo: this.ship.liveCargo ?? null,
      fuelPct: st?.fuelPct ?? null,
      hullHealth: this.stats.hullHealth,
      unsoldBio: this.stats.unsoldBio,
      unsoldCartoValue: this.explore.unsoldValue(),
      carrier: this.carrierLine(),
      session: {
        jumps: this.stats.jumps,
        distanceLy: this.stats.distanceLy,
        earned: this.stats.earnedTotal(),
      },
    });
  }

  /** "V6W-TTJ · Tir" when they own a carrier, else null. */
  private carrierLine(): string | null {
    const line = this.carrier.contextLine();
    if (!line) return null;
    const call = /fleet carrier (\S+)/.exec(line)?.[1] ?? null;
    const where = /parked in ([^.]+)/.exec(line)?.[1] ?? null;
    if (!call && !where) return 'owned';
    return [call, where].filter(Boolean).join(' · ');
  }

  /**
   * Look for a trade route. Only ever reached from a button or a question —
   * the operator used to do this by itself on every docking, which put a
   * suggestion on screen in the middle of whatever the commander was actually
   * doing. Trade help happens when it is asked for.
   */
  async fetchRoute(): Promise<void> {
    if (!isTauri || this.routeBusy) return;
    if (!this.settings.trade.online) {
      {
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
        if (station) {
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
    // Large-pad hulls (Cutter, Panther Clipper…) can't dock at medium/small
    // stops — constrain the planner so it never routes us somewhere we'd be
    // turned away at the pad.
    const requiresLargePad = shipRequiresLargePad(this.ship.current?.ship);
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
        maxPriceAgeDays: DEFAULT_FILTERS.maxAgeDays,
      });
      const parsed = parseSpanshRoute(raw);
      const route = parsed ? await this.vetRoute(parsed, true) : null;
      this.route = route;
      this.routeIdx = 0;
      if (route) {
        const text = routeSummary(route);
        this.pushFeed('system', `🔄 ${text} (data: Spansh)`);
        this.speak(text);
        this.addSeed(`Community data pointed to a trade route: ${route.hops[0].commodity} out of ${route.hops[0].fromStation}`);
        if (this.settings.trade.autoCopyRoute) void this.copyWaypoint(0, true);
      } else {
        // Spansh wants a closed loop and often has none. The one-way search
        // usually does, so the button does not dead-end the way it used to.
        await this.suggestRunAfterNoLoop();
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

  // ==========================================================================
  // The Plotter tab — Spansh for the ship (neutron highway) and the carrier.
  //
  // The carrier half is the reason this exists. The game will not plot a
  // carrier route at all: every hop is a system name typed by hand into the
  // carrier panel, and nothing in the game tells you whether the tritium
  // aboard covers the trip. So the tab does the two things the game refuses
  // to — the list, and the fuel — and puts the next system on the clipboard.
  // ==========================================================================

  /**
   * Whose position a route's progress is measured by.
   *
   * A carrier route is the CARRIER's progress, not the commander's. They are
   * frequently not aboard when it jumps — off mining the tritium for the next
   * hop, usually — and tracking their ship would leave the list frozen at the
   * departure system for the whole trip.
   */
  private plotReferenceSystem(route: PlottedRoute): string {
    return route.kind === 'carrier'
      ? (this.carrier.snapshot().system ?? this.sm.location.system)
      : this.sm.location.system;
  }

  /**
   * Where the commander is, for the persona and the setting primer.
   *
   * Recomputed rather than cached: it is three subtractions and a square root,
   * and a cache would be one more thing to invalidate on every jump.
   */
  private currentPlace(): Place {
    return placeOf(this.sm.location.system, this.sm.getState().system?.coords ?? null);
  }

  /**
   * Swap the persona when the commander crosses into a different region.
   *
   * The system prompt is built ONCE when the conversation starts, so without
   * this a run that began in Colonia would still be told it was in Colonia
   * 20,000 ly later. Only a region change rebuilds it — doing it per jump would
   * churn the prompt (and its cache) for no gain.
   */
  private refreshPlaceIfRegionChanged(): void {
    const place = this.currentPlace();
    if (!regionChanged(this.lastPlace, place)) return;
    const was = this.lastPlace;
    this.lastPlace = place;
    if (!this.copilot) return;
    this.copilot.setSystem(
      buildCopilotSystem(this.sm.commanderName || undefined, {
        epic: this.settings.chatter.epic,
        place,
      }),
    );
    // Worth a beat: crossing out of inhabited space (or back into it) is one of
    // the few genuine changes of character a run has.
    if (was && was.region !== 'unknown' && place.region !== 'unknown') {
      this.copilotEvent(`EVENT: Chapter turn — crossed from ${was.regionName} into ${place.regionName}.`);
    }
  }

  /** Where a plot starts from, and why it might not be able to. */
  private plotOrigin(): { from: string | null; note: string | null } {
    if (this.plotKind === 'carrier') {
      if (!this.carrier.owned()) return { from: null, note: 'No fleet carrier in your journal yet.' };
      const sys = this.carrier.snapshot().system;
      return sys
        ? { from: sys, note: null }
        : { from: null, note: 'I have not seen where your carrier is parked — open the carrier panel once.' };
    }
    const here = this.sm.location.system;
    return here && here !== 'unknown'
      ? { from: here, note: null }
      : { from: null, note: 'No position yet — the journal has not said where you are.' };
  }

  /**
   * The destination to offer before they type one.
   *
   * The plotted nav route's endpoint first: if they have already told the game
   * where they are going, asking again is a question with a known answer. A
   * mission destination is the next best guess.
   */
  private plotSuggestion(): string | null {
    if (this.navRouteDest) return this.navRouteDest;
    // The board directly, NOT selectedMission(): that one reads the LAST
    // snapshot, and this runs while the FIRST one is being built. Reaching
    // through it here threw inside the constructor — so `core` was never
    // created, React never mounted, and the HUD came up as a window that
    // painted nothing and answered nothing.
    const sel = this.sm.activeMissions().find((m) => m.id === this.selectedId);
    const dest = sel?.destination?.system;
    return dest && dest !== this.sm.location.system ? dest : null;
  }

  // ------------------------------------------------------------- the local wire
  /**
   * What is true in this system right now, as a brief the model may print from.
   *
   * Everything here comes from the journal: the faction board with influence,
   * the stations honked in the FSS, the construction sites being supplied, the
   * markets the commander has actually read. The model chooses among these and
   * writes them up; anything it adds is treated as a fabrication and dropped.
   */
  private newsBrief(): string[] {
    const system = this.sm.location.system;
    const state = this.sm.getState();
    const depot = this.construction.depot;
    const inSystem = (depot?.system ?? '').toLowerCase() === system.toLowerCase();
    return buildNewsBrief(system, state.system, {
      construction:
        depot && inSystem && !depot.complete
          ? [
              {
                station: depot.station ?? 'the construction site',
                remaining: tonsRemaining(depot),
                pct: depot.progress * 100,
                top: [...depot.resources]
                  .filter((r) => r.remaining > 0)
                  .sort((a, b) => b.remaining - a.remaining)
                  .slice(0, 3)
                  .map((r) => r.name),
              },
            ]
          : undefined,
      markets: this.marketMemory
        .all()
        .filter((m) => m.system.toLowerCase() === system.toLowerCase())
        .slice(0, 4)
        .map((m) => ({
          station: m.station,
          sells: m.items.filter((i) => i.buy > 0 && i.stock > 0).slice(0, 4).map((i) => i.name),
        })),
      goals: this.sm.communityGoals
        .filter((g) => g.system.toLowerCase() === system.toLowerCase())
        .map((g) => ({ title: g.title, market: g.market, contributors: g.contributors })),
      // The commander is a local trader in this paper, never its subject.
      commanderDid: this.newsCommanderNotes(),
      // What the boards have actually done since we last read them.
      pulse: this.newsPulse(),
      // Crime-desk material that is actually true: doors shut in this system.
      denials: this.denials
        .toJSON()
        .filter((d) => (d.system ?? '').toLowerCase() === system.toLowerCase())
        .slice(0, 3)
        .map((d) => d.station),
      // The paper's own continuity.
      cast: this.newsCast,
      previously: this.news.filter((n) => n.system === system).slice(0, 6).map((n) => n.headline),
    });
  }

  /**
   * The market report: what moved, where the spread is, who is paying.
   *
   * Reads the boards we have visited in this system and compares them against
   * the last prices we saw there. The comparison is only committed once an
   * edition is actually published (see refreshNews), so a story can say "up 8%"
   * and the next edition still has the old number to measure the NEXT move
   * from — updating on every read would flatten every price to "unchanged".
   */
  private newsPulse(): string[] {
    const system = this.sm.location.system;
    const here = this.marketMemory
      .all()
      .filter((m) => m.system.toLowerCase() === system.toLowerCase());
    return marketPulse(here, this.newsPrices).lines;
  }

  /** One or two things the commander has actually done here, for colour. */
  private newsCommanderNotes(): string[] {
    const out: string[] = [];
    if (this.stats.refinedOre) {
      out.push(`a trader refined ${this.stats.refinedOre} t of ore in this system today`);
    }
    const depot = this.construction.depot;
    if (depot && depot.progress > 0) {
      const done = depot.resources.filter((r) => r.remaining <= 0).length;
      if (done) out.push(`${done} of the site's commodity lines have been delivered in full`);
    }
    return out.slice(0, 2);
  }

  /** Write an edition. Silent on failure — a paper that cannot print says nothing. */
  async refreshNews(force = false): Promise<void> {
    if (!this.settings.news.enabled || this.newsBusy) return;
    if (!this.lmOk || !this.activeModel()) {
      this.newsError = 'The local AI engine is not running, so there is nobody to write it.';
      this.emit();
      return;
    }
    const system = this.sm.location.system;
    if (!system || system === 'unknown') return;
    if (!force && !newsDue(this.newsAt, this.settings.news.everyMin, Date.now())) return;
    const brief = this.newsBrief();
    // A masthead alone is not a paper: without faction or station facts there
    // is nothing to write about that would not be invented.
    if (brief.length < 3) {
      this.newsError = `Not enough is known about ${system} yet — honk the system and dock somewhere.`;
      this.emit();
      return;
    }
    this.newsBusy = true;
    this.newsError = null;
    this.emit();
    try {
      const recent = this.news.filter((n) => n.system === system).map((n) => n.headline);
      // One desk per story, rotated per edition — the variety is scheduled
      // rather than hoped for, the same way beat angles are.
      const desks = desksFor(brief, this.newsEdition).slice(0, this.settings.news.perEdition);
      const raw = await llmQuick({
        ...this.lmTarget(),
        model: this.activeModel()!,
        messages: buildNewsChat(
          brief,
          this.settings.news.perEdition,
          recent,
          desks,
          this.settings.news.tone,
        ) as unknown as ChatMessageWire[],
        // MUST be set: llmQuick defaults to eight tokens (see newsMaxTokens).
        maxTokens: newsMaxTokens(this.settings.news.perEdition),
        noThinking: suppressThinkingForGate(profileFor(this.activeModel())),
        // A paper on temperature 0 files the same edition from the same brief
        // for ever; the gate's default is exactly wrong here.
        temperature: 0.85,
        // Prose, not a verdict — and the game is holding the GPU. Measured on
        // this machine WITH Elite running: 7.86 tokens/second, against 60 on
        // an idle card. One edition took 99.9 s and the 15 s default had long
        // since given up, which is what made the tab look permanently broken.
        timeoutSecs: 180,
        // Say what actually went wrong. Swallowing this is why a stopped
        // engine looked identical to an unparseable reply.
        strict: true,
      });
      const { items, rejected, cast } = acceptNews(raw, {
        brief,
        system,
        at: new Date().toISOString(),
        recentHeadlines: recent,
        max: this.settings.news.perEdition,
        desks,
        cast: this.newsCast,
      });
      this.newsEdition += 1;
      // Only now do the prices we just reported on become "what we last saw".
      // Committing them at read time would mean every board is always
      // unchanged by the time an edition is written.
      if (items.length) {
        const here = this.marketMemory
          .all()
          .filter((m) => m.system.toLowerCase() === system.toLowerCase());
        this.newsPrices = marketPulse(here, this.newsPrices).next;
        try {
          localStorage.setItem('edmo.newsprices.v1', JSON.stringify(this.newsPrices));
        } catch {
          /* the comparison still holds for this session */
        }
      }
      if (items.length && this.settings.news.speak) this.readBulletin(items);
      if (cast.length) {
        this.newsCast = cast;
        try {
          localStorage.setItem('edmo.newscast.v1', JSON.stringify(cast));
        } catch {
          /* the cast still stands for this session */
        }
      }
      for (const r of rejected) this.noteGlance(`news — dropped a story, ${r}`);
      if (items.length) {
        this.news = [...items, ...this.news].slice(0, 30);
        try {
          localStorage.setItem('edmo.news.v1', JSON.stringify(this.news));
        } catch {
          /* the edition still stands for this session */
        }
      } else {
        // "Nothing printable" covered two very different failures — every
        // story rejected, versus the model returning nothing usable at all —
        // and only one of them is the wire working as designed.
        this.newsError = rejected.length
          ? `Every story was spiked this cycle (${rejected[0]}).`
          : 'The model returned nothing the wire could parse. Try another edition.';
      }
      this.newsAt = Date.now();
    } catch (e) {
      this.newsError = `The wire did not answer (${String(e).slice(0, 70)}).`;
    } finally {
      this.newsBusy = false;
      this.emit();
    }
  }

  /**
   * Read an edition out, in the newsreader's voice.
   *
   * Queued one story at a time rather than as a single block: the speaker
   * serialises utterances, so a stop() lands between stories instead of the
   * commander having to sit through the whole bulletin. The masthead goes
   * first because the voice change is the cue that this is not the operator.
   */
  private readBulletin(items: readonly NewsItem[]): void {
    const voice = this.settings.news.voice;
    this.speaker.speak(`${items[0].system} local wire.`, voice);
    for (const n of items) this.speaker.speak(`${n.headline}. ${n.body}`, voice);
  }

  /** Read the current edition on demand (the tab's speaker button). */
  readNewsAloud(): void {
    const items = this.news.filter((n) => n.system === this.sm.location.system);
    if (items.length) this.readBulletin(items);
  }

  private newsView(): NewsView {
    const system = this.sm.location.system;
    return {
      system,
      items: this.news.filter((n) => n.system === system),
      archive: this.news.filter((n) => n.system !== system).slice(0, 8),
      busy: this.newsBusy,
      error: this.newsError,
      lastAt: this.newsAt,
      everyMin: this.settings.news.everyMin,
      enabled: this.settings.news.enabled,
    };
  }

  // ------------------------------------------------------- the system architect
  /**
   * The market at the station under the ship, when there is one.
   *
   * A construction site has a commodity market of its own, and so does the
   * station the commander happens to be docked at while planning — "can I buy
   * it without moving" is the first question the tree has to answer.
   */
  private localMarketRecord(): MarketRecord | null {
    if (!this.statusTracker.current?.docked) return null;
    const station = this.sm.location.station;
    if (!station) return null;
    return this.marketMemory.latest({ station, system: this.sm.location.system });
  }

  private architectView(): ArchitectView | null {
    const depot = this.construction.depot;
    if (!depot) return null;
    const capacity = this.stats.cargoCapacity || this.ship.current?.cargoCapacity || null;
    const groups = buildShoppingList(depot, {
      cargo: this.cargoManifest,
      localMarket: this.localMarketRecord(),
      visited: this.marketMemory.all(),
      sources: this.architectSources,
      cargoCapacity: capacity,
    });
    return {
      depot,
      groups,
      totalRequired: tonsRequired(depot),
      totalRemaining: tonsRemaining(depot),
      atSite: !!this.statusTracker.current?.docked && this.sm.location.station === depot.station,
      online: this.settings.external.ardent,
      scanning: this.architectScanning,
      scannedAt: this.architectScannedAt,
      scanError: this.architectScanError,
      cargoCapacity: capacity,
      holdUsed: this.ship.liveCargo ?? null,
    };
  }

  /**
   * A market just read — tell the commander if it covers the build.
   *
   * Ardent has never heard of a system colonised last week, so for the site's
   * own system the commander's dockings ARE the market data. Announced only
   * when the station is new to us or its stock has moved, so re-reading the
   * same board on every undock/redock stays silent.
   */
  private noteMarketForBuild(rec: MarketRecord, knownAt: string | null): void {
    const depot = this.construction.depot;
    if (!depot || depot.complete) return;
    const covers = coversFromMarket(depot, rec);
    if (!covers.length) return;
    const inSystem = rec.system.toLowerCase() === (depot.system ?? '').toLowerCase();
    const fingerprint = `${rec.marketId}:${covers.map((c) => `${c.name}${c.stock}`).join(',')}`;
    if (this.saidMarketCover === fingerprint) return;
    this.saidMarketCover = fingerprint;
    const line = describeCoverage(rec.station, covers, inSystem);
    if (!line) return;
    this.pushFeed('nudge', `🏗 ${line}`, { severity: 'info' });
    // Worth interrupting for only when it is a genuinely new find in the
    // build's own system — a re-read of a known board is a feed line, not a
    // voice line.
    if (inSystem && !knownAt) {
      this.speak(line);
      this.copilotEvent(`EVENT: ${line}`);
    }
    this.emit();
  }

  /**
   * Say the list once, when it appears — and only when something changed.
   *
   * The depot event repeats on every contribution and every re-dock, so keying
   * the callout on the numbers rather than the event is what keeps it from
   * becoming the carrier-jump nag all over again.
   */
  private announceConstruction(): void {
    const depot = this.construction.depot;
    if (!depot) return;
    const key = `${depot.marketId}:${tonsRemaining(depot)}`;
    if (this.saidDepot === key) return;
    const first = !this.saidDepot.startsWith(`${depot.marketId}:`);
    this.saidDepot = key;
    const groups = buildShoppingList(depot, {
      cargo: this.cargoManifest,
      localMarket: this.localMarketRecord(),
      visited: this.marketMemory.all(),
      sources: this.architectSources,
    });
    const line = describeDepot(depot, groups);
    if (!line) return;
    // Every contribution re-fires the depot event. The full brief is worth
    // speaking when the site first opens; after that the panel carries it.
    if (first) {
      this.pushFeed('nudge', `🏗 ${line}`, { severity: 'info' });
      this.speak(line);
      this.copilotEvent(`EVENT: ${line}`);
      void this.architectScan(false);
    } else {
      this.pushFeed('system', `🏗 ${line}`);
    }
    this.emit();
  }

  /**
   * Find somewhere to buy what the site still wants.
   *
   * One Ardent lookup per outstanding commodity — seventeen of them for a
   * first-day build — so they go three at a time rather than in one burst, and
   * anything the commander can already buy where they are standing is skipped
   * entirely. Re-scanning is cheap to ask for and expensive to do, so a scan
   * from the same system inside ten minutes is reused.
   */
  async architectScan(force = true): Promise<void> {
    const depot = this.construction.depot;
    if (!depot || this.architectScanning) return;
    if (!this.settings.external.ardent) {
      this.architectScanError =
        'Galaxy-wide lookups are off. Settings → Community data turns them on (it sends only a system name and a commodity).';
      this.emit();
      return;
    }
    const from = this.sm.location.system;
    if (!from || from === 'unknown') {
      this.architectScanError = 'Current system unknown — nothing to measure distances from yet.';
      this.emit();
      return;
    }
    const fresh =
      this.architectScannedAt != null &&
      Date.now() - this.architectScannedAt < 10 * 60_000 &&
      this.architectScanFrom === from;
    if (!force && fresh) return;
    const local = this.localMarketRecord();
    const soldHere = new Set(
      (local?.items ?? []).filter((i) => i.buy > 0 && i.stock > 0).map((i) => commodityKey(i.name)),
    );
    const wanted = depot.resources.filter(
      (r) => r.remaining > 0 && !soldHere.has(r.key) && (this.cargoManifest.get(r.key) ?? 0) < r.remaining,
    );
    if (!wanted.length) {
      this.architectScannedAt = Date.now();
      this.architectScanFrom = from;
      this.emit();
      return;
    }
    this.architectScanning = true;
    this.architectScanError = null;
    this.emit();
    const found = new Map<string, ArdentMarketRow[]>();
    let failed = 0;

    // The build's OWN system first, in one request. The per-commodity lookup
    // used below asks for "nearby" markets, which excludes the system it is
    // given — so without this the panel could not see a crater outpost holding
    // 371,309 t of steel two hundred thousand Ls from the site, and routed the
    // commander 76 ly instead. One request covers every commodity here.
    const home = depot.system;
    if (home) {
      try {
        const rows = await ardentSystemCommodities(home);
        for (const row of rows) {
          const key = commodityKey(row.commodity);
          if (!key) continue;
          const at = found.get(key);
          if (at) at.push(row);
          else found.set(key, [row]);
        }
      } catch {
        // Not fatal: the nearby sweep below still runs.
        this.architectScanError = `Could not read the markets in ${home} — showing out-of-system sellers only.`;
      }
    }

    // Anything the home system already covers needs no galaxy search.
    const covered = new Set(
      [...found.entries()].filter(([, rows]) => rows.some((r) => (r.stock ?? 0) > 0)).map(([k]) => k),
    );
    const queue = [...wanted.filter((r) => !covered.has(r.key))];
    const searched = queue.length; // the workers drain the queue
    const worker = async (): Promise<void> => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        try {
          // Ardent names commodities exactly the way commodityKey spells them:
          // 'liquidoxygen', 'fruitandvegetables'. Verified against the live API.
          found.set(next.key, await ardentMarket(from, next.key, 'buy'));
        } catch {
          failed++;
        }
      }
    };
    try {
      await Promise.all([worker(), worker(), worker()]);
      // Replace wholesale rather than merge: a rescan from a new system must
      // not leave last system's distances sitting under the new ones.
      this.architectSources = found;
      this.architectScannedAt = Date.now();
      this.architectScanFrom = from;
      if (failed) {
        this.architectScanError = `${failed} of ${searched} lookups failed — those rows are unsearched, not empty.`;
      }
    } finally {
      this.architectScanning = false;
      this.emit();
    }
  }

  private plotterView(): PlotterView {
    const origin = this.plotOrigin();
    return {
      kind: this.plotKind,
      target: this.plotTarget,
      suggestion: this.plotSuggestion(),
      route: this.plot,
      idx: this.plotIdx,
      busy: this.plotBusy,
      error: this.plotError,
      efficiency: this.plotEfficiency,
      inHold: this.plotHold,
      online: this.settings.trade.online,
      from: origin.from,
      fromNote: origin.note,
      shipRange: this.ship.current?.maxJumpRange ?? null,
      shipCargo: this.stats.cargoCapacity || this.ship.current?.cargoCapacity || null,
      carrier: this.carrier.owned() ? this.carrier.snapshot() : null,
      jumpState: this.jumpClock.state,
    };
  }

  setPlotKind(kind: PlotKind): void {
    this.plotKind = kind;
    this.plotError = null;
    this.emit();
  }

  setPlotTarget(target: string): void {
    this.plotTarget = target;
    this.emit();
  }

  setPlotEfficiency(efficiency: number): void {
    this.plotEfficiency = Math.min(100, Math.max(1, Math.round(efficiency)));
    this.emit();
  }

  /** Tritium in the carrier's hold — re-prices the plotted route in place. */
  setPlotHold(tons: number): void {
    this.plotHold = Math.max(0, Math.round(tons));
    // Re-run the arithmetic on the route already on screen: the answer to
    // "am I short" changes the moment they tell us what is aboard, and making
    // them re-plot (another minute of Spansh) to learn it would be absurd.
    if (this.plot) this.plot = reprice(this.plot, this.carrierFuelInput());
    this.persistPlot();
    this.emit();
  }

  /** Flip the Spansh opt-in from the plotter, so nobody hunts for Settings. */
  enableSpansh(): void {
    this.updateSettings({ ...this.settings, trade: { ...this.settings.trade, online: true } });
    this.pushFeed('system', 'Spansh route planning is on — it sends system names and nothing else.');
    this.emit();
  }

  /** What the carrier knows about itself, for the tritium arithmetic. */
  private carrierFuelInput() {
    const c = this.carrier.snapshot();
    return {
      inTank: c.fuelLevel ?? 0,
      inHold: this.plotHold,
      shipCargo: this.stats.cargoCapacity || this.ship.current?.cargoCapacity || null,
      freeSpace: c.freeSpace,
    };
  }

  /** Ask Spansh for a route to the target system, for the ship or the carrier. */
  async plotRoute(): Promise<void> {
    if (!isTauri || this.plotBusy) return;
    if (!this.settings.trade.online) {
      this.plotError = 'Spansh route planning is off — turn it on above.';
      this.emit();
      return;
    }
    const origin = this.plotOrigin();
    const to = (this.plotTarget || this.plotSuggestion() || '').trim();
    if (!origin.from || !to) {
      this.plotError = origin.note ?? 'Give me a destination system.';
      this.emit();
      return;
    }
    if (to.toLowerCase() === origin.from.toLowerCase()) {
      this.plotError = `You are already in ${origin.from}, commander.`;
      this.emit();
      return;
    }

    const kind = this.plotKind;
    this.plotBusy = true;
    this.plotError = null;
    this.pushFeed(
      'system',
      `🧭 Plotting a ${kind === 'carrier' ? 'carrier' : 'neutron'} route ${origin.from} → ${to}…`,
    );
    this.emit();
    try {
      let route: PlottedRoute | null = null;
      if (kind === 'carrier') {
        const c = this.carrier.snapshot();
        const raw = await spanshCarrierRoute({
          source: origin.from,
          destinations: [to],
          // Mass drives the burn. Unknown usage would understate the fuel, and
          // an understated fuel figure is how a carrier ends up stranded — so
          // fall back to a laden 15,000 t rather than an empty hull.
          capacityUsed: c.usedCapacity ?? 15_000,
          currentFuel: c.fuelLevel ?? 0,
          tritiumAmount: this.plotHold,
        });
        route = parseCarrierPlot(raw, this.carrierFuelInput());
      } else {
        // The game reports the laden range in Loadout; without one, Spansh's
        // own default of 50 ly is the honest guess and the card says so.
        const raw = await spanshShipRoute({
          from: origin.from,
          to,
          range: this.ship.current?.maxJumpRange ?? 50,
          efficiency: this.plotEfficiency,
        });
        route = parseShipPlot(raw);
      }
      if (!route) {
        this.plotError = `Spansh found no ${kind === 'carrier' ? 'carrier' : 'neutron'} route to ${to}. Check the spelling, or try the other mode.`;
        this.plot = null;
        this.pushFeed('system', `🧭 ${this.plotError}`);
      } else {
        this.plot = route;
        this.plotIdx = plotProgress(route, this.plotReferenceSystem(route)) ?? 0;
        this.view = 'plotter';
        const text = plotSummary(route);
        this.pushFeed('system', `🧭 ${text} (data: Spansh)`);
        this.speak(text);
        this.addSeed(
          `Plotted a ${kind === 'carrier' ? 'carrier' : 'neutron'} route to ${route.destination} — ${route.totalJumps} jumps`,
        );
        // Straight onto the clipboard: the first thing they do next is paste it.
        if (this.settings.trade.autoCopyRoute) void this.copyPlotWaypoint(this.plotIdx + 1);
      }
      this.persistPlot();
    } catch (e) {
      this.plotError = String(e);
      this.pushFeed('system', `🧭 Route plot failed: ${String(e)}`);
    } finally {
      this.plotBusy = false;
      this.emit();
    }
  }

  /** Put one waypoint on the clipboard — galaxy map, or the carrier panel. */
  async copyPlotWaypoint(idx: number, spoken = false): Promise<void> {
    const w = this.plot?.waypoints[idx];
    if (!w) return;
    const where = this.plot?.kind === 'carrier' ? 'carrier panel' : 'galaxy map';
    try {
      await copyText(w.system);
      this.pushFeed('system', `📋 Copied "${w.system}" — paste it into the ${where}.`);
      if (spoken) this.speak(`Next waypoint is ${w.system}. It is on your clipboard.`);
    } catch (e) {
      this.pushFeed('system', `Clipboard failed: ${String(e)}`);
    }
    this.emit();
  }

  clearPlot(): void {
    this.plot = null;
    this.plotIdx = 0;
    this.plotError = null;
    this.persistPlot();
    if (this.view === 'plotter') this.view = 'missions';
    this.emit();
  }

  private persistPlot(): void {
    try {
      localStorage.setItem(
        'edmo.plot.v1',
        JSON.stringify({
          route: this.plot,
          idx: this.plotIdx,
          kind: this.plotKind,
          hold: this.plotHold,
          efficiency: this.plotEfficiency,
        }),
      );
    } catch {
      /* storage full — the route still holds for this session */
    }
  }

  /**
   * Move the marker along the plotted route when the commander arrives.
   *
   * Only advances on a system it actually recognises: a ship route's waypoints
   * are the supercharge stars, with ten ordinary jumps between them, so most
   * arrivals are correctly "nowhere on the list" and must leave the marker
   * where it is rather than resetting to the start.
   */
  private onArrivalForPlot(live: boolean): void {
    if (!this.plot) return;
    // A carrier route is the CARRIER's progress, not the commander's. They are
    // frequently not aboard when it jumps — off mining the tritium for the next
    // hop, usually — and tracking their ship would leave the list frozen at the
    // departure system for the whole trip.
    const at = plotProgress(this.plot, this.plotReferenceSystem(this.plot));
    if (at === null || at === this.plotIdx) return;
    const advanced = at > this.plotIdx;
    this.plotIdx = at;
    this.persistPlot();
    if (!live || !advanced) return;
    const next = nextWaypoint(this.plot, at);
    if (next) {
      const left = plotRemaining(this.plot, at);
      const said =
        `${this.plot.kind === 'carrier' ? 'Carrier waypoint' : 'Waypoint'} reached. Next: ${next.system}` +
        `${next.neutron ? ', a neutron — supercharge there' : ''}. ` +
        `${left.jumps} jump${left.jumps === 1 ? '' : 's'} and ${fmtLy(left.ly)} to ${this.plot.destination}.`;
      this.pushFeed('system', `🧭 ${said}`);
      this.speak(said);
      if (this.settings.trade.autoCopyRoute) void this.copyPlotWaypoint(at + 1);
    } else {
      const done = `${this.plot.destination} — that's the end of the plot, commander.`;
      this.pushFeed('system', `🧭 ${done}`);
      this.speak(done);
      this.addSeed(`Reached ${this.plot.destination} at the end of a plotted route`);
    }
  }

  /**
   * Recount the jumps left on the plotted route from the ship's actual position.
   *
   * Must run on every jump, not just when NavRoute.json is re-read: the file is
   * written once at plot time and never updated, so anything derived from its
   * length alone is wrong from the first jump onward. Off-route (the commander
   * deviated, or has not joined the route yet) keeps the last-good figure —
   * better a slightly old count than a confidently wrong one.
   */
  private recomputeNavRoute(): void {
    if (!this.navRoute.length) {
      this.navRouteJumps = 0;
      this.navRouteDest = null;
      return;
    }
    const left = remainingRouteJumps(this.navRoute, this.sm.location.system);
    if (left === null) return;
    this.navRouteJumps = left;
    // Arrived: drop the route so nothing keeps counting down from zero.
    if (left === 0) {
      this.navRoute = [];
      this.navRouteDest = null;
    }
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
      this.copilotEvent(`EVENT: ${text}`);
      this.copilotReact('arrival', 'copilot — reacting to arrival…');
    }
    for (const c of changes) {
      if (c.kind === 'jump') {
        this.jumpsSinceDock += 1;
        this.onJumpForRoute();
        // Recount BEFORE the beat fires — the copilot reads navRouteJumps out of
        // the STATE line, so a stale count becomes a wrong spoken number.
        this.recomputeNavRoute();
        this.copilotEvent(`EVENT: FSD jump to ${this.sm.location.system}.`);
        this.copilotReact('travel', 'copilot — reacting to the jump…');
      }
      const m = c.mission;
      if (!m) continue;
      let kind: FeedKind | null = null;
      let text = '';
      switch (c.kind) {
        case 'accepted':
          // Personal, lively briefing (LLM voice with template fallback)
          // replaces the dry form-letter line; facts live on the card.
          this.personalBriefing(m);
          this.copilotEvent(
            `EVENT: Accepted "${m.title}"${m.destination ? ` → ${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}` : ''}.`,
          );
          this.copilotReact('mission', 'copilot — reacting to a new job…');
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
        // Feed the living copilot the notable lifecycle beats (skip noisy cargo
        // ticks) so it can react to hand-ins and setbacks in context.
        if (kind !== 'cargo') {
          this.copilotEvent(`EVENT: ${text}`);
          this.copilotReact('mission', `copilot — reacting to ${kind}…`);
        }
      }
      // Mood: a run of clean hand-ins reads differently from a run of losses.
      if (c.kind === 'completed') {
        this.winStreak += 1;
        this.lossStreak = 0;
      } else if (c.kind === 'failed' || c.kind === 'abandoned') {
        this.lossStreak += 1;
        this.winStreak = 0;
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
    this.maybeDeathClock();
    this.maybeCarrierJump();
    // The wire keeps its own clock. Never while the model is busy talking —
    // an edition is a background errand and must not delay a spoken beat.
    if (
      this.settings.news.enabled &&
      !this.lmBusy &&
      !this.copilotBeatInFlight &&
      newsDue(this.newsAt, this.settings.news.everyMin, Date.now())
    ) {
      void this.refreshNews(false);
    }
    this.maybeChatter();
    this.maybeReflect();
    this.maybeGlance();
    this.maybeCombatAftermath();
    this.maybeCopilotIdle();
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
    // Same rule as the idle beat: mid-walk between samples, the one line that
    // matters is the tracker's "far enough". A glance here lands on a commander
    // trudging across rock and reliably produces a paraphrase of the distance
    // call, one second before the real one.
    if (this.sampleRange.active()) return;
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
        const facts = this.buildCopilotFacts();
        // Register angle is used only by the describeFirst-off stateless
        // fallback; the living copilot conversation ignores it.
        const st = this.statusTracker.current;
        const eligible: CommentaryAngle[] = ['view'];
        if (st?.supercruise || this.navRouteJumps > 0) eligible.push('travel');
        if (this.sm.activeMissions().length) eligible.push('mission');
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

  // ------------------------------------------------------- living copilot
  /** Lazily create the session conversation with the current commander's name. */
  private ensureCopilot(): void {
    if (this.copilot) return;
    this.lastPlace = this.currentPlace();
    const system = buildCopilotSystem(this.sm.commanderName || undefined, {
      epic: this.settings.chatter.epic,
      place: this.lastPlace,
    });
    // Bound the transcript against the window the engine is ACTUALLY running,
    // not a fixed turn count. The system prompt is ~2,900 tokens and an 8 GB
    // card runs at ctx 8192, so a long session there would otherwise walk the
    // prompt past the window; the old 400-turn cap allowed ~10,400 tokens of
    // transcript with no idea how big a turn was.
    //
    // Half the remaining room, so the per-beat context (NOW, STATE, arc, mood,
    // angle, lore, a screen reading) and the reply both have somewhere to live.
    const ctx = this.engineCtxSize();
    const budget = Math.max(1000, Math.floor((ctx - estimateTokens(system) - 600) / 2));
    this.copilot = new CopilotConversation(system, 400, budget);
  }

  /** Drop the running conversation (new session / journal restart). */
  private resetCopilot(): void {
    this.copilot = null;
    this.copilotBeatInFlight = false;
  }

  /**
   * The journal moments outside the curated vocabulary — interdictions,
   * neutron boosts, promotions, deaths, wings, on-foot — plus the fight
   * aggregator. Live-only by call site: a bootstrap replay must not narrate
   * last month.
   */
  private noteMoment(ev: JournalEvent): void {
    const now = Date.now();
    // The session's story folds first — a chapter turn (mining shift → passenger
    // work, the rings → the community goal) is the one moment a story remark is
    // always earned, so it lands as a mission-tier beat of its own.
    const turn = this.sessionArc.apply(ev, now);
    if (turn) {
      this.copilotEvent(turn);
      this.copilotReact('mission', 'copilot — a chapter turns…');
    }
    // The fight folds silently; it is told ONCE, after it ends. Kills also
    // arm the ambient combat-quiet gate, same as the tactical layer.
    if (this.combatStreak.apply(ev, now)) {
      this.lastCombatAt = now;
      return;
    }
    // A jump, docking or death ends a fight by definition — file the aftermath
    // as an event NOW so it rides into that beat instead of firing its own.
    if (ev.event === 'FSDJump' || ev.event === 'Docked' || ev.event === 'Died') {
      const fought = this.combatStreak.flush(now, true);
      if (fought) this.copilotEvent(fought);
    }
    const m = momentOf(ev, { fuelCapacity: this.ship.current?.fuelCapacity });
    if (!m) return;
    // The same sight twice in a row is once too many — the tank refills every
    // leg, and a wing rejoin after a relog is not news either.
    if (m.line === this.lastMomentLine && now - this.lastMomentAt < 10 * 60_000) return;
    this.lastMomentLine = m.line;
    this.lastMomentAt = now;
    this.copilotEvent(m.line);
    this.copilotReact(m.tier, `copilot — reacting to ${ev.event}…`);
  }

  /** The fight went quiet on its own (no jump or docking ended it): tell it.
   *  flush() unlocks at COMBAT_QUIET_MS — the same window as copilotReact's
   *  combat gate, so the reaction is allowed at exactly the moment the
   *  aftermath becomes tellable. */
  private maybeCombatAftermath(): void {
    const line = this.combatStreak.flush(Date.now());
    if (!line) return;
    this.copilotEvent(line);
    this.copilotReact('mission', 'copilot — the dust settles…');
  }

  /** Record a game event into the living copilot's session context. Only kept
   *  while copilot commentary is on — that's the feature's on-switch. */
  private copilotEvent(line: string): void {
    if (!this.settings.vision.commentary) return;
    this.ensureCopilot();
    // Events are built from the same notice strings the feed shows, so they
    // arrive carrying exact figures ("971,646 cr") — which this model size
    // garbles into a wrong spoken number ("ninety-seven grand" for that one).
    // The feed and Piper keep the exact figure; only the prompt is rounded.
    this.copilot?.recordEvent(roundCreditsForSpeech(line));
    // The event the speak/skip gate will be asked about, if a reaction follows.
    // Only a real EVENT is gateable: the gate classifies things that HAPPENED,
    // and handing it "COMMANDER SAID: …" or the operator's own briefing would
    // ask it a question it was never calibrated on.
    // Rounded, so the gate judges exactly the text the operator will be shown.
    if (line.startsWith('EVENT:')) this.lastCopilotEventLine = roundCreditsForSpeech(line);
  }

  /** Compact authoritative "current state" line sent with each copilot beat so
   *  the model is always anchored to NOW, not just accumulated history. */
  private copilotNowLine(): string {
    const st = this.statusTracker.current;
    const target = st?.supercruise ? st.destination?.name?.trim() : '';
    const mode = st?.docked
      ? `docked${this.sm.location.station ? ` at ${this.sm.location.station}` : ''}`
      : st?.onFoot
        ? 'on foot'
        : st?.supercruise
          ? target
            ? `in supercruise toward ${target}`
            : 'in supercruise'
          : 'flying in normal space';
    const bits = [`${mode} in ${this.sm.location.system}`];
    if (st?.fuelPct != null)
      bits.push(`fuel ${Math.round(st.fuelPct * 100)}%${st.lowFuel || st.fuelPct < 0.25 ? ' (LOW)' : ''}`);
    // Attach the live job(s) to every beat so the operator always has REAL log
    // facts to be colourful about (payout, destination) — grounding beats
    // inventing atmosphere on thin moments, and survives history trimming.
    // Rounded, speakable credits — a small local model garbles exact figures
    // ("2,424,592" → "twenty-four point two million"), stating wrong numbers.
    // Shared with the event stream via speakableCredits, so both say it the
    // same way and neither can drift from the other.
    const money = speakableCredits;
    const jobs = this.sm
      .activeMissions()
      .slice(0, 3)
      .map((m) => {
        const dest = m.destination
          ? ` → ${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}`
          : '';
        return `${m.category} "${m.title}"${dest}${m.reward ? `, ${money(m.reward)}` : ''}`;
      });
    const base = `${bits.join(', ')}.`;
    const withJobs = jobs.length ? `${base} Current job(s): ${jobs.join('; ')}.` : base;
    // Standing spoken goal stays in view so the copilot keeps it in mind.
    return this.prospectTarget
      ? `${withJobs} Commander is hunting ${this.prospectTarget.commodity} at ${this.prospectTarget.minPct}%+.`
      : withJobs;
  }

  /** A per-beat length target, sampled short — real speech is mostly a few
   *  words, so most beats should be too; the model matches this hint. */
  private copilotLengthHint(): string {
    const r = Math.random();
    if (r < 0.5) return 'LENGTH: a few words, six at most.';
    if (r < 0.85) return 'LENGTH: one short sentence.';
    return 'LENGTH: up to two sentences, only if it earns them.';
  }

  /**
   * Non-money material for this beat: an angle, plus the facts that angle needs.
   *
   * Only angles we can actually FEED are offered — asking for the ship angle
   * with no loadout on file is an invitation to invent one. Everything here is
   * journal truth the app already folds; this is a curated slice, deliberately
   * not contextExtras(), whose background lines (CGs, trade leads) once gave the
   * model places to hallucinate the commander into.
   */
  private copilotAngleBlock(): string {
    const available: BeatAngle[] = [];
    const facts: string[] = [];

    const ship = this.ship.current ? describeShip(this.ship.current) : null;
    if (ship) {
      available.push('ship');
      facts.push(`SHIP: ${ship}${this.ship.liveCargo != null ? `, ${this.ship.liveCargo} t in the hold` : ''}.`);
    }

    // The clock is only an angle when something is actually running down.
    const soonest = this.sm
      .activeMissions()
      .map((m) => (m.expiry ? Date.parse(m.expiry) - Date.now() : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b)[0];
    const hours = this.sessionStartAt ? (Date.now() - this.sessionStartAt) / 3_600_000 : 0;
    if (soonest !== undefined || hours >= 2) available.push('clock');

    const client = this.sm.activeMissions().find((m) => m.faction)?.faction;
    if (client) {
      available.push('client');
      facts.push(`CLIENT: this work was posted by ${client}.`);
    }

    // What this place actually IS — the antidote to reading a station's name as
    // a description of it, which the prompt bans and the fact fence cannot catch.
    const intel = describeSystemIntel(this.sm.getState());
    if (intel) {
      available.push('place');
      facts.push(intel);
    }
    // ...and what this place is FAMOUS for, when it is famous. Curated canon
    // (lore.ts): the one true story a place carries beats any amount of
    // invented atmosphere, and the habitual-claim tic was measured to fire
    // almost only on beats that had nothing real to say about a place.
    const lore = loreForSystem(this.sm.location.system);
    if (lore && !available.includes('place')) available.push('place');
    // Real geography — region, distance from Sol, how far out they are. This is
    // the material that stops the model reaching for the operator's own office
    // every time it wants something concrete to say.
    const where = placeFacts(this.currentPlace());
    if (where) {
      facts.push(where);
      if (!available.includes('place')) available.push('place');
    }

    if (this.copilot?.hasHistory()) {
      available.push('callback');
      // The operator's own watch — only once the session has some shape, so
      // the first words of a session are about the commander, not the coffee.
      available.push('self');
    }
    if (this.navRouteJumps > 0 && this.navRouteDest) available.push('ahead');

    // Community Goals — the CONCLUSION, never the raw board (given the board,
    // the model recommended the MOST contested goal 6 of 6 times; ranking lives
    // in rankCommunityGoals). Offered as an ANGLE, not a standing fact, and
    // never mid-shift: as an every-beat fact it hijacked a whole live mining
    // session — "you know the routine at Paxton Landing", "Einheriar work
    // paying dividends again", beat after beat, a full ring system away from
    // either place. Same law as the STATE tally: a fact present on every beat
    // becomes the only subject. Opportunity talk belongs to the moments between
    // work, not on top of it — the fact itself is attached below, only when the
    // opening angle is actually drawn.
    const rank = rankCommunityGoals(this.sm.communityGoals);
    const midShift = /mining/i.test(this.currentActivity() ?? '');
    if (rank && !midShift) available.push('opening');

    // Long-term memory — who the commander is to these people, and what has
    // happened to them here before. The single richest non-money source there
    // is, and until now the ambient voice never saw any of it.
    // Docking is worth its own angle while the ship is actually on a pad. On a
    // construction run that is a dozen arrivals an hour, and without it they
    // all came out as 'place' beats about the station rather than the arrival.
    if (this.statusTracker.current?.docked) available.push('dock');

    // A story beat asks for scuttlebutt explicitly; ordinary beats never draw
    // it, so the long form only appears on the chatter cadence.
    const angle = this.storyBeatPending ? 'story' : pickBeatAngle(available, Math.random);
    this.storyBeatPending = false;

    // Long-term memory — who the commander is to these people, and what has
    // happened to them here before. The single richest non-money source there
    // is, and until now the ambient voice never saw any of it.
    //
    // The visit tally rides ONLY on a callback beat. It is true on every beat
    // once a commander settles in, and a fact present on every beat becomes the
    // only subject: a hauling session produced "Nine times in two days?", "and
    // you still haven't found an exit sign", "the view's big enough for nine
    // visits" and "you're stuck in the routine". Fourth proof of the same law,
    // after the running tally, the community goals and the local lore.
    if (this.settings.memory.enabled) {
      const m = this.selectedMission();
      const recall = this.memory
        .recallForContext(
          {
            system: this.sm.location.system !== 'unknown' ? this.sm.location.system : undefined,
            faction: m?.faction,
            targetFaction: m?.targetFaction,
          },
          Date.now(),
          { includeVisits: angle === 'callback' },
        )
        .slice(0, 3);
      if (recall.length) facts.push(...recall.map((r) => `HISTORY: ${r}`));
    }
    if (angle === 'story') {
      const seeds = this.freshSeeds();
      if (seeds.length) {
        facts.push(['RECENT TRUE EVENTS:', ...seeds.slice(-6).map((x) => `- ${x}`)].join('\n'));
      }
      const comms = this.freshComms();
      if (comms.length) facts.push(`OVERHEARD ON LOCAL COMMS (real): ${comms.slice(-3).join(' · ')}`);
    }
    // The lore rides ONLY on a place beat. Pushed as a standing fact it became
    // the subject of everything: a live session mentioned Jaques the cyborg
    // bartender in five separate beats — "the whole region runs off a story
    // about a bartender", "the sheer audacity of a bartender jumpstarting a
    // colony", "it's a strange life for a cyborg bartender". True, and still
    // the same anecdote four times too often. A fact present on every beat
    // becomes the only subject; that is now three separate proofs of the same
    // law (the tally, the community goals, and this).
    if (angle === 'place' && lore) {
      facts.push(`LOCAL LORE (true, common knowledge): ${lore}`);
    }
    if (angle === 'opening' && rank) {
      const q = rank.quietest;
      const mine = q.playerContribution > 0 ? ' The commander has already put work into this one.' : '';
      facts.push(
        `COMMUNITY GOAL WORTH TAKING: of the ${rank.count} running, ${q.system} is the least contested — ` +
          `hand in at ${q.market}, only ${q.contributors.toLocaleString('en-US')} pilots on it, so the biggest ` +
          `share of the payout.${mine}` +
          (rank.busiest
            ? ` The crowded one is ${rank.busiest.system} with ${rank.busiest.contributors.toLocaleString('en-US')}.`
            : ''),
      );
    }
    return [...facts, beatAngleHint(angle, this.currentPlace())].filter(Boolean).join('\n');
  }

  /** A compact STATE line so the same event reads differently under different
   *  conditions — how the session has gone, and the pressure of the run ahead.
   *  Gives the model something to be a person ABOUT, not just an event to echo. */
  private copilotStateLine(): string {
    const s = this.stats;
    const money = (n: number) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${n}`);
    const parts: string[] = [];
    // The running tally is background, and it is the ONLY hard number present on
    // a quiet beat — so a model told to hang its colour on real facts will recite
    // it forever ("eight runs, thirteen million" three beats running). Include it
    // only when it has actually moved since the last beat; otherwise it is not news.
    const tally =
      s.missionsCompleted || s.earnedTotal() > 0 || s.refinedOre > 0
        ? `${s.missionsCompleted} job(s) done, ${money(s.earnedTotal())} cr banked` +
          // "Refined this session" is a lifetime-of-session counter, NOT what is
          // in the hold — and read as cargo it produced "a solid spot to turn
          // that 206 tonnes into credits" to a commander who had already moved
          // the lot to their carrier. State the hold alongside it.
          `${s.refinedOre ? `, ${s.refinedOre} t refined this session (hold right now: ${this.ship.liveCargo ?? 0} t)` : ''}, ${s.jumps} jump(s)`
        : '';
    // "Changed since last beat" was too weak a filter: on a hand-in run the
    // tally moves EVERY beat, so it was present every beat, and the takings
    // became the only subject the operator had. Show it every fourth beat at
    // most — a scoreboard is not news, and the angle block now carries the
    // material it was standing in for.
    this.beatsSinceTally += 1;
    if (tally && tally !== this.lastStateTally && this.beatsSinceTally >= 4) {
      this.lastStateTally = tally;
      this.beatsSinceTally = 0;
      parts.push(tally);
    }
    // Fatigue — a long shift, and a long haul between docking bays.
    const hours = this.sessionStartAt ? (Date.now() - this.sessionStartAt) / 3_600_000 : 0;
    if (hours >= 2) parts.push(`${Math.floor(hours)}+ hours into this shift`);
    if (this.jumpsSinceDock >= 5) parts.push(`${this.jumpsSinceDock} jumps since the last dock`);
    // Mood — a run of clean hand-ins, or a run of setbacks.
    if (this.winStreak >= 3) parts.push(`${this.winStreak} clean hand-ins in a row`);
    if (this.lossStreak >= 2) parts.push(`${this.lossStreak} jobs lost in a row`);
    // Pressure — the legs still to fly, and the tightest clock on the board.
    if (this.navRouteJumps > 0 && this.navRouteDest)
      parts.push(`${this.navRouteJumps} jump(s) still to run to ${this.navRouteDest}`);
    const soonest = this.sm
      .activeMissions()
      .map((m) => (m.expiry ? Date.parse(m.expiry) - Date.now() : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b)[0];
    if (soonest !== undefined && soonest < 30 * 60_000)
      parts.push(`tightest deadline in ${Math.max(1, Math.round(soonest / 60_000))} min — pressure on`);
    // The ship's own condition, when it is worth caring about.
    if (s.hullHealth < 0.9) parts.push(`hull at ${Math.round(s.hullHealth * 100)}%`);
    // Route repeat — the same bay, over and over.
    const here = this.sm.location.station;
    const visits = here ? (this.dockVisits.get(here) ?? 0) : 0;
    if (visits >= 3) parts.push(`this is visit ${visits} to ${here} today`);
    return parts.length ? `STATE — ${parts.join('; ')}.` : '';
  }

  /** The places the copilot may legitimately name this beat, gathered
   *  generously: current location, mission destinations, the plotted route,
   *  in-system stations, and every place it was already told about (its
   *  transcript) — so callbacks pass and only true inventions get caught. */
  private buildAllowedPlaces(): Set<string> {
    const s = new Set<string>();
    const add = (v?: string | null) => { if (v && v !== 'unknown') s.add(v); };
    add(this.sm.location.system);
    add(this.sm.location.station);
    add(this.navRouteDest);
    for (const m of this.sm.activeMissions()) {
      add(m.destination?.system);
      add(m.destination?.station);
    }
    for (const sig of this.sm.getState().system?.signals ?? []) if (sig.isStation) add(sig.name);
    // Landmarks the persona itself names (Jaques Station, when posted there).
    // Without this the operator mentioning its OWN office reads as a fabricated
    // place and the beat gets dropped.
    for (const p of postPlaces(this.currentPlace())) add(p);
    if (this.copilot)
      for (const turn of this.copilot.transcript())
        if (turn.role === 'user') for (const p of extractPlaces(turn.content)) s.add(p);
    return s;
  }

  /** Curated, journal-truth-first session facts that seed the copilot's opener.
   *  Deliberately NOT contextExtras() — background lines (CGs, trade leads) once
   *  gave the model places to hallucinate the commander into. */
  private buildCopilotFacts(): string {
    const activeMissions = this.sm.activeMissions().slice(0, 4);
    const missionLines = activeMissions.map(
      (m) =>
        `- ${m.category} "${m.title}"${m.destination ? ` → ${m.destination.station ? `${m.destination.station}, ` : ''}${m.destination.system}` : ''}`,
    );
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
    return [
      `JOURNAL TRUTH: the commander is ${mode} in ${this.sm.location.system}.`,
      ...(selectedTarget
        ? [`Selected navigation target: ${selectedTarget}${knownStationTarget ? ' (station/outpost)' : ''}. The commander is travelling toward it, not docked there.`]
        : []),
      ...(st?.fuelPct != null
        ? [`AUTHORITATIVE TELEMETRY: main fuel ${Math.round(st.fuelPct * 100)}%${st.lowFuel || st.fuelPct < 0.25 ? ' (LOW FUEL).' : ' (healthy; no fuel warning or monitoring advice).'}`]
        : []),
      ...(this.ship.current ? [`Loadout: ${describeShip(this.ship.current)}.`] : []),
      ...(this.navRouteJumps > 0 && this.navRouteDest
        ? [`Plotted route: ${this.navRouteJumps} jump(s) to ${this.navRouteDest}.`]
        : []),
      ...(missionLines.length ? ['Active missions:', ...missionLines] : []),
    ].join('\n');
  }

  /** Is the living copilot the voice right now? When it is, nothing else may
   *  speak in the operator's name — one channel, one person. */
  private copilotIsLive(): boolean {
    return this.settings.vision.commentary && isTauri && this.lmOk;
  }

  /** Fire one copilot beat into the running conversation — the shared path for
   *  both a screen glance (scene = the reading) and an event reaction (scene =
   *  null, text-only, no screenshot). Seeds the opener on first use. */
  private fireCopilotBeat(scene: string | null, note?: string): void {
    this.ensureCopilot();
    const cp = this.copilot!;
    if (cp.isEmpty()) cp.recordEvent(`SESSION STATE:\n${this.buildCopilotFacts()}`);
    const entry = this.pushFeed('vision', '', { streaming: true });
    this.lastStoryAt = Date.now(); // reserve the chatter slot
    this.lastCopilotBeatAt = Date.now();
    this.copilotBeatInFlight = true;
    // Compose the beat context: current NOW + a STATE line + a length target
    // (+ an optional framing note, e.g. a quiet stretch with no event behind it).
    // These ride in the ephemeral turn (only events are committed to history).
    // The story and the operator's own state, computed (arc.ts) — the model
    // colours them, it never derives them.
    const hours = this.sessionStartAt ? (Date.now() - this.sessionStartAt) / 3_600_000 : 0;
    const ctx = [
      note,
      this.copilotNowLine(),
      this.copilotStateLine(),
      this.sessionArc.arcLine() ?? '',
      this.sessionArc.moodLine(Date.now(), hours),
      this.copilotAngleBlock(),
      this.copilotLengthHint(),
    ]
      .filter(Boolean)
      .join('\n');
    // Keep the exact messages + the places it may name, so a beat that invents
    // a station can be resampled once (validated in onAiDone).
    const msgs = cp.messagesForBeat(ctx, scene) as unknown as ChatMessage[];
    this.copilotRetryMsgs = msgs;
    this.copilotRetried = false;
    this.copilotAllowedPlaces = this.buildAllowedPlaces();
    // Anything we deliberately told it THIS beat is fair game to name. The
    // committed transcript covers past beats, but the ephemeral context — the
    // lore line's "The Brig", a memory note's system, a screen reading's OCR'd
    // station — would otherwise be flagged as fabrication for repeating what
    // we just said.
    for (const p of extractPlaces(ctx)) this.copilotAllowedPlaces.add(p);
    if (scene) for (const p of extractPlaces(scene)) this.copilotAllowedPlaces.add(p);
    this.startLlm(
      entry,
      'commentary',
      msgs,
      0.7,
      1800,
      undefined,
      // Full-session history feeds prior beats back, and how hard a model
      // echoes it varies by family: gemma needs a nudge, GLM and Qwen3-VL need
      // roughly double. modelprofile.ts carries the measured strength.
      profileFor(this.activeModel()).penalties,
    );
  }

  /**
   * How tense the run is right now, 0 (drifting) .. 1 (on the edge). Drives the
   * beat density: silent through the boring middle, close together when a clock
   * is running down or the ship is in trouble.
   */
  private copilotPressure(): number {
    let p = 0;
    const st = this.statusTracker.current;
    // A deadline inside the half hour is the strongest source of tension.
    const soonest = this.sm
      .activeMissions()
      .map((m) => (m.expiry ? Date.parse(m.expiry) - Date.now() : NaN))
      .filter((ms) => Number.isFinite(ms) && ms > 0)
      .sort((a, b) => a - b)[0];
    if (soonest !== undefined && soonest < 30 * 60_000) p += 0.5 * (1 - soonest / (30 * 60_000));
    if (this.navRouteJumps > 0) p += Math.min(0.15, this.navRouteJumps * 0.05);
    if (st?.lowFuel || (st?.fuelPct != null && st.fuelPct < 0.25)) p += 0.3;
    if (this.stats.hullHealth < 0.8) p += 0.2;
    if (Date.now() - this.lastCombatAt < 5 * 60_000) p += 0.3;
    if (st?.beingInterdicted || st?.inDanger || st?.overheating) p += 0.4;
    return Math.max(0, Math.min(1, p));
  }

  /**
   * Nothing has happened for a long while — speak into the silence anyway, the
   * way a crewmate on a long haul does. No event, no screenshot: the operator
   * opens something from the session state, or stays quiet.
   */
  private maybeCopilotIdle(): void {
    if (!this.settings.vision.commentary || !isTauri) return;
    if (!this.lmOk || this.lmBusy || this.glanceInFlight) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    if (Date.now() - this.lastCombatAt < 60_000) return;
    // Mid-walk between samples the commander is listening for one specific
    // call — "far enough". An ambient beat here either talks over it or, worse,
    // paraphrases it ("almost there on the samples"), which reads as the
    // distance call and is not one. The tracker owns this stretch.
    if (this.sampleRange.active()) return;
    // Only once the session has something to be about, and only after a genuine
    // stretch of quiet (measured from the last beat OR any spoken line).
    if (!this.copilot?.hasHistory()) return;
    const quiet = Math.max(this.lastCopilotBeatAt, this.lastStoryAt);
    if (Date.now() - quiet < copilotSilenceGapMs(this.settings.vision.involvement)) return;
    this.noteGlance('copilot — speaking into a quiet stretch…');
    this.fireCopilotBeat(null, 'QUIET STRETCH: nothing has happened for a while.');
  }

  /**
   * Walking away from a bio sample: say when the clonal colony radius has been
   * cleared, once, so the commander knows the next sample will count. Status.json
   * updates continuously on foot, so this is effectively live.
   */
  private checkSampleRange(): void {
    const st = this.statusTracker.current;
    if (!st?.latitude || st.longitude == null) return;
    const u = this.sampleRange.update(st.latitude, st.longitude);
    if (!u || u.kind !== 'ready') return;
    const text = `Far enough — ${Math.round(u.distanceM)} m out. The next ${u.species} sample will count.`;
    this.pushFeed('system', `🧬 ${text}`);
    this.speak(text);
    this.copilotEvent(`EVENT: Cleared the ${u.species} colony radius — ${Math.round(u.distanceM)} m from the last sample.`);
  }

  /**
   * Galnet and the exploration catalogue are TOOLS, not feeds.
   *
   * Both were tempting to poll on a timer, but the copilot's fact fence
   * (`buildAllowedPlaces()`) is derived from its own transcript: pipe headlines
   * or catalogue entries in unprompted and you whitelist a hundred places the
   * commander has never been, inviting exactly the hallucination the fence
   * exists to stop. On demand the model has to ask, and the answer arrives
   * labelled as someone else's report rather than something it witnessed.
   */
  /** A game event happened — let the copilot react in-conversation (text-only,
   *  no screenshot) if the player's involvement level and cadence allow. This is
   *  what makes the copilot feel present between screen glances. */
  private copilotReact(tier: ReactionTier, note: string): void {
    if (!this.settings.vision.commentary || !isTauri) return;
    if (!this.lmOk || this.lmBusy || this.glanceInFlight || this.beatGateInFlight) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    if (Date.now() - this.lastCombatAt < 60_000) return; // don't cut into a fight
    const inv = this.settings.vision.involvement;
    if (!copilotReactsTo(inv, tier)) return;
    // Density, not a metronome: the tenser the run, the closer the beats.
    if (Date.now() - this.lastCopilotBeatAt < copilotDensityGapMs(inv, this.copilotPressure())) return;
    // A contract accepted, redirected, handed in or lost always earns a word —
    // and the gate is measurably wrong about that one class (it voted SKIP on
    // an accepted delivery), so it never gets to rule on it.
    if (tier === 'mission' || !this.lastCopilotEventLine) {
      this.noteGlance(note);
      this.fireCopilotBeat(null);
      return;
    }
    void this.gateThenReact(note);
  }

  /** Ask the cheap classifier whether this moment is worth a line, then beat.
   *  ~90 ms against the ~530 ms beat it can save, so it pays for itself the
   *  first time it says no. Fire-and-forget: nothing awaits a copilot beat. */
  private async gateThenReact(note: string): Promise<void> {
    const line = this.lastCopilotEventLine;
    this.beatGateInFlight = true;
    let speak = true;
    try {
      const verdict = await llmQuick({
        ...this.lmTarget(),
        model: this.activeModel()!,
        messages: buildBeatGateChat(line) as unknown as ChatMessageWire[],
        // The gate is a one-word answer, so reasoning is pure cost (92 ms with
        // the flag, seconds without) — but on families where the flag is unsafe
        // it must still be omitted. That is a different question from what the
        // spoken beats want, so it has its own rule.
        noThinking: suppressThinkingForGate(profileFor(this.activeModel())),
      });
      speak = parseBeatGate(verdict);
    } finally {
      this.beatGateInFlight = false;
    }
    if (!speak) {
      // Stay quiet, and leave the event pending — it rides into whatever the
      // operator does say next, exactly as an unspoken beat always has.
      this.noteGlance('copilot — nothing worth saying about that.');
      return;
    }
    // The world moved while we were asking; re-check what the gate raced past.
    if (!this.settings.vision.commentary || !this.lmOk || this.lmBusy || this.glanceInFlight) return;
    if (Date.now() - this.lastGameActivity >= GAME_LIVE_WINDOW_MS) return;
    this.noteGlance(note);
    this.fireCopilotBeat(null);
  }

  /** Gate a hazard-free screen glance before generating a beat for it. Judged
   *  on the freshest pending EVENT when one is waiting (the beat will carry it,
   *  and events are what the gate is calibrated on), else on the scene summary. */
  private async gateThenGlance(scene: string): Promise<void> {
    if (this.beatGateInFlight) return;
    const pendingEvent = (this.copilot?.pendingCount() ?? 0) > 0 && this.lastCopilotEventLine;
    const line = pendingEvent
      ? this.lastCopilotEventLine
      : `SCREEN SIGHTING: ${scene.match(/- Summary: (.+)/)?.[1] ?? scene.slice(0, 200)}`;
    this.beatGateInFlight = true;
    let speak = true;
    try {
      const verdict = await llmQuick({
        ...this.lmTarget(),
        model: this.activeModel()!,
        messages: buildBeatGateChat(line) as unknown as ChatMessageWire[],
        // The gate is a one-word answer, so reasoning is pure cost (92 ms with
        // the flag, seconds without) — but on families where the flag is unsafe
        // it must still be omitted. That is a different question from what the
        // spoken beats want, so it has its own rule.
        noThinking: suppressThinkingForGate(profileFor(this.activeModel())),
      });
      speak = parseBeatGate(verdict);
    } finally {
      this.beatGateInFlight = false;
    }
    if (!speak) {
      this.noteGlance('glance — nothing on screen worth a word.');
      return;
    }
    if (!this.settings.vision.commentary || !this.lmOk || this.lmBusy || this.glanceInFlight) return;
    this.noteGlance('copilot — looking at the screen…');
    this.fireCopilotBeat(scene);
  }

  /** Fire the operator's stage-2 pass. `scene` is the rendered stage-1 reading
   *  (text-only, faster) or null to hand the raw image straight to the model. */
  private fireVisionStage(pv: PendingVision, scene: string | null): void {
    if (pv.mode === 'commentary') {
      // Living copilot: with a screen reading, the beat comes from the running
      // session conversation — fireCopilotBeat owns the feed entry, seeding and
      // flags (shared with event reactions).
      if (scene) {
        // The same speak/skip gate the event path uses — glances went around
        // it, and a mining session showed why that can't stand: parked in a
        // ring, every glance sees rocks, and every glance spoke ("Asteroid
        // boulders scattered across the void", "That cloud cover looks thick
        // enough to chew through a freighter"). A visible hazard bypasses the
        // gate; scenery has to earn a word.
        if (!scene.includes('Visible hazards: none apparent')) {
          this.noteGlance('copilot — looking at the screen…');
          this.fireCopilotBeat(scene);
          return;
        }
        void this.gateThenGlance(scene);
        return;
      }
      // describeFirst off / reading failed → stateless single-shot over the image.
      const entry = this.pushFeed('vision', '', { streaming: true });
      this.lastStoryAt = Date.now(); // reserve the chatter slot now we're speaking
      this.copilotBeatInFlight = false;
      this.noteGlance(`commentary (${pv.angle}) — looking at the screen…`);
      this.startLlm(
        entry,
        'commentary',
        buildCommentaryMessages(
          pv.dataUri,
          pv.facts ?? '',
          pv.cmdr,
          pv.angle,
          pv.recent ?? [],
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
      // The commander asked — always answer, notable or not. A remark that
      // trips a voice fence is dropped rather than spoken, but the answer still
      // lands: staying silent is not an option when someone asked directly.
      const clean = findVoiceViolation(remark) ? '' : remark;
      const line = clean || `All quiet — looks like you're ${reply.activity || 'busy'}.`;
      this.pushFeed('vision', `👁 I see: ${reply.activity || 'the screen'}. ${clean}`.trim());
      this.speak(line);
      return;
    }
    if (!notable) return;
    // The voice fences. This path used to skip them entirely and speak straight
    // to the feed, which is how "We're running on fumes" reached a live session
    // — the collective-pronoun rule catches that line, it was simply never
    // asked. There is no resample here (the glance prompt is one-shot against a
    // screenshot), so a violation just means staying quiet.
    const violation = findVoiceViolation(remark);
    if (violation) {
      this.noteGlance(`dropped a glance remark — ${violation.fence} "${violation.detail}"`);
      return;
    }
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
    // Canonical lore for where the commander is and where the job points —
    // asked about Jaques Station while docked AT Jaques Station, the operator
    // used to answer "the founder is not part of the current manifest data".
    const localLore = loreForSystem(this.sm.location.system);
    if (localLore) out.push(`Local lore (true): ${localLore}`);
    const destSystem = this.selectedMission()?.destination?.system;
    if (destSystem && destSystem.toLowerCase() !== this.sm.location.system.toLowerCase()) {
      const destLore = loreForSystem(destSystem);
      if (destLore) out.push(`Destination lore (true): ${destLore}`);
    }
    // Ranked, not raw: asked "what should I do?" with four goals running, the
    // old line named one at random and dropped the counts. Handing over the raw
    // board instead makes the model recommend the busiest goal — so hand over
    // the answer (see rankCommunityGoals).
    const rank = rankCommunityGoals(this.sm.communityGoals);
    if (rank) {
      const q = rank.quietest;
      out.push(
        `Community Goals: ${rank.count} running. Least contested is "${q.title}" at ${q.market} in ${q.system} ` +
          `(${q.contributors.toLocaleString('en-US')} pilots — the biggest share of the payout)` +
          (rank.busiest ? `; most contested is ${rank.busiest.system} (${rank.busiest.contributors.toLocaleString('en-US')} pilots).` : '.'),
      );
    }
    const risk = this.stats.riskNote();
    if (risk) out.push(risk);
    // The build the commander is hauling for. Without the ranked plan in front
    // of it the model can only repeat the seventeen-line requirement back.
    const depot = this.construction.depot;
    if (depot && !depot.complete) {
      const facts = architectFacts(
        depot,
        buildShoppingList(depot, {
          cargo: this.cargoManifest,
          localMarket: this.localMarketRecord(),
          sources: this.architectSources,
          cargoCapacity: this.stats.cargoCapacity || this.ship.current?.cargoCapacity || null,
        }),
      );
      if (facts) out.push(facts);
    }
    // Carrier ownership changes what a hold full of tritium MEANS.
    const carrier = this.carrier.contextLine();
    if (carrier) out.push(carrier);
    // Doors already tried and shut — market data cannot see access, so this is
    // the only record that a "best price" is one the commander cannot reach.
    const shut = this.denials.contextLine();
    if (shut) out.push(shut);
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
    // The plotted trip, so the operator follows the same route the commander
    // is flying — and knows about a tritium shortfall before advising on it.
    if (this.plot) out.push(plotContextLine(this.plot, this.plotIdx));
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

  /**
   * Fetch trade candidates around the current system and rank them with the
   * pure engine. Ardent has no route endpoint, so the shell gathers what the
   * origin sells plus the best sinks for the most promising goods, and the
   * pairing happens here where it is testable.
   */
  private async findTradeRun(opts: {
    origin: string;
    atStation?: string;
    destination: string;
    maxDistanceLy: number;
    minVolume: number;
    minPad: number;
    cargo: number;
  }): Promise<TradeFind> {
    const origin = opts.origin || this.sm.location.system;
    const filters: RouteFilters = {
      minPad: opts.minPad,
      minVolume: opts.minVolume,
      cargo: opts.cargo,
      maxAgeDays: DEFAULT_FILTERS.maxAgeDays,
    };
    const now = Date.now();
    // Everything we have seen with our own eyes, which outranks a community
    // report of the same station whenever our visit is the newer one.
    const seen = this.marketMemory.all().map((m) => ({
      station: m.station,
      system: m.system,
      at: m.at,
      items: m.items,
    }));
    let find: TradeFind;
    if (opts.destination) {
      // Directed: two requests and an intersection, no probing heuristic.
      const raw = await ardentTradeTo(origin, opts.destination, opts.minVolume);
      const sources = cheapestSources(applyOwnObservations(raw.sources, seen), filters, now);
      const sinks = bestSinksByCommodity(applyOwnObservations(raw.sinks, seen), filters, origin, now);
      find = {
        legs: legsToDestination(sources, sinks, filters, now),
        originKnown: raw.originKnown !== false,
        destination: opts.destination,
        destinationKnown: raw.destinationKnown !== false,
        atStation: opts.atStation || undefined,
        checked: sinks.size,
        candidates: sources.size,
        filters,
        origin,
      };
    } else {
      const raw = await ardentTradeCandidates(origin, opts.maxDistanceLy, opts.minVolume, 8);
      const sources = cheapestSources(applyOwnObservations(raw.sources, seen), filters, now);
      const legs = [...sources.values()].map((src) => {
        const sink = bestSink(applyOwnObservations(raw.sinks[src.commodity] ?? [], seen), filters, origin, now);
        return sink ? buildLeg(src, sink, filters, now) : null;
      });
      find = {
        legs: rankLegs(legs),
        originKnown: raw.originKnown !== false,
        atStation: opts.atStation || undefined,
        checked: raw.checked,
        candidates: raw.candidates,
        filters,
        origin,
      };
    }
    // Surface it as a card too: the spoken answer scrolls away with the feed,
    // but the destination is something the commander needs on screen while they
    // fly it, and needs to paste into the galaxy map.
    this.tradeRun = find.legs.length ? find : null;
    this.emit();
    return find;
  }

  /**
   * Check a Spansh route against what the ship can actually do, before the
   * commander is sent to fly it.
   *
   * Spansh's only pad control is a large-pad boolean and its response carries no
   * pad size, so a medium hull gets routed to small-pad settlements — which is
   * how a Type-8 ended a route on "docking denied, your ship is too large for
   * this pad class". Ardent knows the pads; ask it about each system on the
   * route and throw the route away if any stop is unusable.
   *
   * Returns the route when it is flyable, or null when it is not.
   */
  private async vetRoute(route: TradeRoute, speak: boolean): Promise<TradeRoute | null> {
    // Belt and braces on freshness: max_price_age is sent to Spansh, but a
    // client-side check costs nothing and does not depend on their filtering.
    const stale = staleHops(route, DEFAULT_FILTERS.maxAgeDays);
    if (stale.length) {
      if (speak)
        this.pushFeed(
          'system',
          `Ignoring that route — its prices are ${Math.round(stale[0].marketAgeh / 24)} days old, so the profit is fiction.`,
        );
      return null;
    }
    if (!this.settings.external.ardent) return route;
    const minPad = shipRequiresLargePad(this.ship.current?.ship) ? 3 : 2;
    const systems = [...new Set(route.hops.flatMap((h) => [h.fromSystem, h.toSystem]))].filter(Boolean);
    const padsBySystem: Record<string, Record<string, number>> = {};
    for (const sys of systems) {
      try {
        padsBySystem[sys] = await ardentStationPads(sys);
      } catch {
        // Unknown is not the same as too small — leave that system unchecked.
      }
    }
    const bad = unusableStops(route, padsBySystem, minPad);
    if (!bad.length) return route;
    this.pushFeed('system', `⛔ ${describeUnusable(bad, minPad)}`);
    if (speak) this.speak(describeUnusable(bad, minPad));
    return null;
  }

  /**
   * Spansh came back empty. Offer the plain buy-here/sell-there run instead —
   * "no loop" was technically true and practically useless while a 44,000 cr/t
   * run sat thirty light years away.
   */
  private async suggestRunAfterNoLoop(): Promise<void> {
    if (!this.settings.external.ardent) {
      this.pushFeed(
        'system',
        'Spansh found no profitable loop from here. Turn on galaxy-wide markets in Settings → Community data and I can look for a one-way run instead.',
      );
      return;
    }
    this.pushFeed('system', 'No closed loop from here — looking for a one-way run…');
    this.emit();
    try {
      const find = await this.findTradeRun({
        origin: this.sm.location.system,
        atStation: this.sm.location.station ?? '',
        destination: '',
        maxDistanceLy: this.settings.trade.routeMaxHopLy,
        minVolume: DEFAULT_FILTERS.minVolume,
        minPad: shipRequiresLargePad(this.ship.current?.ship) ? 3 : DEFAULT_FILTERS.minPad,
        cargo: this.ship.current?.cargoCapacity || this.stats.cargoCapacity || DEFAULT_FILTERS.cargo,
      });
      const best = find.legs[0];
      if (!best) {
        this.pushFeed('system', describeTradeFind(find));
        return;
      }
      const text = `${best.commodity} out of ${best.fromStation} — ${best.profitPerTon.toLocaleString('en-US')} a ton into ${best.toStation}, ${best.distanceLy} light years out.`;
      this.pushFeed('system', `💱 ${text} (data: Ardent)`);
      this.speak(text);
      this.addSeed(`Community data pointed to a run: ${best.commodity} out of ${best.fromStation}`);
      if (this.settings.trade.autoCopyRoute) void this.copyRunDestination(0);
    } catch (e) {
      this.pushFeed('system', `Run search failed: ${String(e)}`);
    }
  }

  dismissTradeRun(): void {
    this.tradeRun = null;
    this.emit();
  }

  /** Copy one run's destination system for galaxy-map pasting (Ctrl+V there). */
  async copyRunDestination(idx: number): Promise<void> {
    const leg = this.tradeRun?.legs[idx];
    if (!leg) return;
    try {
      await copyText(leg.toSystem);
      this.pushFeed('system', `📋 Copied "${leg.toSystem}" — galaxy map → search → Ctrl+V.`);
    } catch (e) {
      this.pushFeed('system', `Clipboard failed: ${String(e)}`);
    }
    this.emit();
  }

  /** Assemble the live-data context the operator's tools read from. */
  private buildToolContext(): ToolContext {
    const state = { ...this.sm.getState(), now: new Date().toISOString() };
    const station = this.statusTracker.current?.docked ? this.sm.location.station ?? null : this.sm.location.station ?? null;
    return {
      system: this.sm.location.system,
      station,
      markets: this.marketMemory,
      // Opt-in only: null keeps the tool advertised but honestly unavailable,
      // so the model explains how to enable it instead of inventing prices.
      galaxyMarket: this.settings.external.ardent
        ? (commodity, side, nearSystem) =>
            ardentMarket(nearSystem || this.sm.location.system, commodity, side)
        : null,
      findTradeRun: this.settings.external.ardent
        ? (opts) => this.findTradeRun(opts)
        : null,
      galnetNews: this.settings.external.galnet ? () => galnetHeadlines(6) : null,
      systemSurvey: this.settings.external.edastro ? (name) => edastroSystem(name) : null,
      ship: this.ship.current,
      shipDescription: this.ship.current ? describeShip(this.ship.current) : null,
      liveCargo: this.ship.liveCargo,
      statusLine: this.liveStatusLine(),
      missions: this.sm.activeMissions(),
      materialsLine: this.materials.contextLine(),
      exploreLine: this.explore.contextLine(),
      systemIntelLine: describeSystemIntel(state),
      // "Where is tritium cheapest" is really "where do I buy the 4,865 t my
      // plotted carrier route needs" — so the market tool gets to see the
      // shortfall and can rule out sellers who cannot fill it.
      // Carriers honked in this system, so a callsign from market data can be
      // reported as the name the nav panel actually shows.
      systemSignals: state.system?.signals ?? [],
      dockingDenied: (station, system) => this.denials.note(station, system),
      commodityNeed: (commodity) => {
        const t = this.plot?.tritium;
        if (!t || t.shortfall <= 0) return null;
        return /tritium/i.test(commodity) ? t.shortfall : null;
      },
      planRoute: async ({ maxHops, requiresLargePad }) => {
        const raw = await spanshTradeRoute({
          system: this.sm.location.system,
          station,
          maxCargo: Math.max(8, this.stats.cargoCapacity || 64),
          capital: Math.max(1_000_000, this.stats.startCredits + this.stats.earnedTotal()),
          maxHopDistance: this.settings.trade.routeMaxHopLy,
          maxHops,
          requiresLargePad,
          maxPriceAgeDays: DEFAULT_FILTERS.maxAgeDays,
        });
        const parsed = parseSpanshRoute(raw);
        // The tool path gets the same vetting as the button: a route the ship
        // cannot dock at is not an answer, it is a wasted trip.
        const route = parsed ? await this.vetRoute(parsed, false) : null;
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

  /** Restart a crashed engine and report what killed it. Separate from pollLm
   *  so the poll is never blocked behind a model load. */
  private async reviveEngine(modelId: string): Promise<void> {
    // Say WHY, if it left a reason. Without this the only record of the last
    // crash was a Windows fault bucket.
    const why = await engineLog().catch(() => '');
    const fatal = why
      .split('\n')
      .filter((l: string) => /error|failed|out of memory|oom|assert|abort|exception/i.test(l))
      .slice(-2);
    if (fatal.length) this.pushFeed('system', `Engine log: ${fatal.join(' | ').slice(0, 300)}`);
    try {
      await this.engineStartModel(modelId);
      // A restart that sticks resets the budget: an eight-hour session should
      // get three attempts per crash, not three for the whole night.
      if (this.engine?.running) this.engineRestarts = 0;
    } catch {
      this.pushFeed('system', 'Could not restart the engine — Settings → AI engine, or switch to LM Studio.');
    }
  }

  private async pollLm(): Promise<void> {
    // The bundled engine can die under us (driver crash, OOM) — notice it here
    // so the HUD's LM dot tells the truth instead of every request timing out.
    if (this.settings.lm.engine === 'bundled' && this.engine?.running && isTauri) {
      const alive = await engineAlive().catch(() => false);
      if (!alive) {
        const crashedModel = this.settings.lm.bundledModel;
        this.engine = { ...this.engine, running: false, port: null, api_key: null };
        // Bring it back by itself.
        //
        // llama.cpp dies of a stack overflow (Windows 0xC00000FD) after hours
        // of a long session — confirmed from a live crash whose engine.log ends
        // mid-decode with no error at all, and whose only trace is the Windows
        // fault bucket naming ntdll.dll. That is a fault inside the engine, not
        // something this app can prevent; what it CAN do is stop making the
        // commander notice. Before this they opened Settings and restarted by
        // hand, twice in one session, mid-flight.
        //
        // Bounded and spaced so a genuinely broken install (missing model, bad
        // runtime) surfaces as a message instead of an infinite restart loop.
        const canRetry =
          !!crashedModel &&
          this.engineRestarts < 3 &&
          Date.now() - this.lastEngineRestartAt > 60_000;
        if (canRetry) {
          this.engineRestarts += 1;
          this.lastEngineRestartAt = Date.now();
          this.pushFeed('system', '⚙ The local AI engine stopped — bringing it back…');
          void this.reviveEngine(crashedModel!);
          return;
        }
        this.pushFeed('system', 'The local AI engine stopped — restart it in Settings, or switch to LM Studio.');
        // Say WHY, if it left a reason. Without this the only record of the
        // last crash was a Windows fault bucket.
        const why = await engineLog().catch(() => '');
        const fatal = why
          .split('\n')
          .filter((l: string) => /error|failed|out of memory|oom|assert|abort|exception/i.test(l))
          .slice(-2);
        if (fatal.length) this.pushFeed('system', `Engine log: ${fatal.join(' | ').slice(0, 300)}`);
      }
    }
    const { endpoint, apiKey } = this.lmTarget();
    try {
      this.lmModels = await llmModels(endpoint, apiKey);
      this.lmOk = this.lmModels.length > 0;
    } catch {
      this.lmModels = [];
      this.lmOk = false;
    }
    // The capability map is an LM Studio REST extra; the bundled engine knows
    // its own models are vision-capable by construction.
    if (this.lmOk && this.settings.lm.engine !== 'bundled') {
      try {
        this.modelTypes = await llmModelTypes(this.settings.lm.endpoint);
      } catch {
        /* capability map stays as-is */
      }
    }
    this.emit();
  }

  selectedMission(): Mission | null {
    // Optional chain on purpose: this reads the last published snapshot, so
    // anything called from INSIDE buildSnapshot() sees it undefined on the very
    // first build. The cost of being wrong here is one null; the cost of
    // throwing is the whole HUD failing to mount.
    return this.snap?.missions.find((m) => m.id === this.selectedId) ?? null;
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
    // Splice the previous answer's lookups back in, so "how much do they have"
    // can be read off the figures rather than refused or re-guessed.
    const priorLookups = this.lastToolExchange;
    this.convo.push('user', q, Date.now());
    // The living copilot hears the commander too — record what they said so its
    // ambient beats take it on board (goals, preferences, whatever it is).
    // Held so the ANSWER can be committed beside it as one exchange.
    this.lastAskedQuestion = q;
    this.copilotEvent(`COMMANDER SAID: ${q}`);
    // A spoken prospecting goal ("looking for tritium at 20%") becomes a target
    // the operator watches for as they mine.
    const target = parseProspectTarget(q);
    if (target) {
      this.prospectTarget = target;
      this.pushFeed('system', `⛏ Watching for ${target.commodity} at ${target.minPct}%+ — I'll flag the rocks.`);
    }

    // Build this as an ORDINARY CHAT: a system prompt that carries the persona
    // AND everything the app knows about the live game, then real user/assistant
    // turns, then whatever the commander actually typed — verbatim.
    //
    // It used to jam the whole fact-blob into the user turn on every question,
    // so each message read as if the commander had recited the market at
    // themselves before speaking. That is what made a bare "yes" answer about
    // commodity prices: the biggest thing in the "user" message was a price
    // list, so that is what got answered. Facts belong in the system prompt as
    // standing knowledge the operator simply HAS; the user turn is speech.
    const events = this.copilot?.recentEvents(20) ?? [];
    const knowledge: string[] = [];
    if (events.length) {
      knowledge.push(
        ['WHAT HAS BEEN HAPPENING (newest last):', ...events.map((e) => `- ${e.replace(/^EVENT: /, '')}`)].join('\n'),
      );
    }
    knowledge.push(
      `WHERE THEY ARE: ${state.location.station ? `${state.location.station}, ` : ''}${state.location.system}${state.docked ? ' (docked)' : ''}.`,
    );
    if (mission) knowledge.push(`THE ACTIVE CONTRACT:
${missionContext(mission, state)}`);
    const intel = describeSystemIntel(state);
    if (intel) knowledge.push(intel);
    if (this.navRouteJumps > 0 && this.navRouteDest) {
      knowledge.push(`Plotted route: ${this.navRouteJumps} jump(s) to ${this.navRouteDest}.`);
    }
    if (this.plot) knowledge.push(plotContextLine(this.plot, this.plotIdx));
    knowledge.push(...this.contextExtras());

    // The SAME operator that has been talking all session, in answering mode —
    // not a second, more assistant-shaped personality. The commander could hear
    // the seam between the two prompts ("You've earned your permanent address
    // here" vs "Community goals are a good way to build local reputation"), and
    // the seam was literally two system prompts.
    //
    // The category guidance still rides along when a contract is active: it is
    // procedure the operator knows, not a personality.
    const persona =
      buildCopilotSystem(this.sm.commanderName || undefined, {
        epic: this.settings.chatter.epic,
        place: this.currentPlace(),
        mode: 'answer',
      }) + (mission ? ` ${categoryGuidance(mission.category)}` : '');
    const system =
      `${persona}

` +
      `LIVE GAME DATA — everything below is true right now and is YOURS to use freely. ` +
      `Bring up whatever is actually relevant to what they said; you do not need permission ` +
      `to talk about their ship, their cargo, the market, the contracts or the system. ` +
      `Just do not recite it when they were only making conversation.

` +
      knowledge.join('\n');

    // ONE THREAD. The conversation the model sees is the copilot's own
    // transcript — the beats it actually spoke and the events behind them —
    // not a parallel dialogue buffer that merely shares some text.
    //
    // This is what "what thing?" needs: the operator said "That old thing has
    // seen some miles", and unless that line is literally the previous
    // assistant turn, the question has no antecedent and the model reaches for
    // whatever else it can act on (a market lookup, every time).
    const thread: ChatMessage[] = this.copilotIsLive()
      ? (this.copilot?.recentTurns(16) ?? []).map((t) => ({ role: t.role, content: t.content }))
      : (this.convo.recent(Date.now()) as ChatMessage[]);
    const messages: ChatMessage[] = [
      { role: 'system', content: system },
      ...thread,
      { role: 'user', content: q },
    ];

    // The thread above already carries the dialogue; only the previous
    // question's tool results still need to ride in front of the new one, so a
    // follow-up about those figures can read them off rather than re-fetch.
    if (priorLookups.length) messages.splice(messages.length - 1, 0, ...priorLookups);

    const entry = this.pushFeed('ai', '', { streaming: true, missionId: mission?.id });
    const model = this.activeModel();
    if (!isTauri || !this.lmOk || !model) {
      this.finishAiWithFallback(entry, mission, nowIso, 'LM Studio is offline');
      return;
    }
    // Tools stay available on every turn and the model decides — the same
    // "auto" behaviour a chat client gives it. Gating them by question shape
    // only ever guessed wrong about what the commander might want looked up.
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
        content: `${withTools[0].content} You can call tools to read the commander's LIVE game data (current market, ship, missions, status, materials, exploration, Spansh trade routes) and, when they ask, the Galnet news wire and the community exploration catalogue. When the answer depends on prices, stock, what to buy or sell, what's profitable here, whether cargo fits, what is happening in the galaxy, or what has already been catalogued in some system, CALL THE RELEVANT TOOL and use its result — never guess or trust possibly-stale route data. Use get_current_market for "here". After gathering what you need, answer in 2-4 short speakable sentences with no markdown. If the commander is TELLING you something rather than asking — their plan, what the cargo is for, how it is going — take it on board and answer in kind: acknowledge it, add something you actually know that helps. Do not turn a remark into a sales pitch, and never argue with a plan they have already made.`,
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
      ...this.lmTarget(),
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
    // ONE operator. When the living copilot is running it already has the
    // session, the persona and the memory, so a story is just a longer beat
    // from it — not a second voice.
    //
    // Reported live: the copilot was mid-run calling the commander by name
    // while a separate stateless story opened "Commander, the word travels…"
    // about the very community goals the copilot's own opening angle covers.
    // Two operators, one channel. The standalone prompts below stay for when
    // the copilot is off (commentary disabled, or the model is down), which is
    // exactly when a second voice cannot collide with a first.
    if (this.copilotIsLive()) {
      this.lastStoryAt = Date.now();
      this.seedCountAtLastStory = this.seeds.length;
      this.storyBeatPending = true;
      this.noteGlance('copilot — a bit of dock talk…');
      this.fireCopilotBeat(null, 'STORY BEAT: tell a piece of scuttlebutt from this run.');
      return;
    }
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
          epic: this.settings.chatter.epic,
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
        { epic: this.settings.chatter.epic },
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
    penalties?: { presence: number; frequency: number },
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
      ...this.lmTarget(),
      model,
      messages,
      temperature,
      maxTokens: maxTokens ?? this.settings.lm.maxTokens,
      responseFormat,
      presencePenalty: penalties?.presence,
      frequencyPenalty: penalties?.frequency,
      // Hidden reasoning is decided per MODEL, not hardcoded (modelprofile.ts).
      // Gemma wants it off for chatter (5.1 s -> 0.5 s a beat, and the reasoned
      // lines were worse) but ON for the ask path, where a plan has an order to
      // get right. Qwen3.5 needs it off for JSON too, or schema calls return
      // nothing. GLM must never be sent this flag at all — that request crashes
      // the AMD Vulkan driver, so its reasoning is capped at the engine instead.
      noThinking: suppressThinkingFor(
        profileFor(model),
        responseFormat ? 'json' : kind === 'ai' ? 'ask' : 'chatter',
      ),
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
    // The briefing hears the session too, so a fourth identical courier run is
    // not introduced with the same fresh face as the first.
    this.startLlm(entry, 'brief', buildBriefingChat(m, state, this.copilot?.recentEvents(10) ?? []), 0.7);
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
    // Any final 'ai' answer ends the agentic run. Keep what it looked up, so
    // the next question can be about those numbers.
    if (this.currentKind === 'ai') {
      if (this.agent) this.lastToolExchange = toolExchangeOf(this.agent.messages);
      this.agent = null;
    }
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
      const groundedText = stripFillerTics(suppressRoutineCoaching(fuelGrounded, hasHazard));
      const fromCopilot = this.copilotBeatInFlight;
      this.copilotBeatInFlight = false;
      // Fact fence: a copilot beat that names a station it was never told about
      // is confident fiction. Resample once, then drop to NO_BEAT rather than
      // let it through — trust matters more than a beat.
      // A decline only counts when it IS the reply. Matching the token anywhere
      // threw away real beats: reported live on a hauling beat that came back
      // "That's a good haul. Keep moving." with NO_BEAT stuck on the end, and
      // the commander got silence instead of the line.
      const speakable = !isSilenceVerdict(groundedText);
      // Every fence runs on EVERY commentary beat. They used to run only on
      // conversation-path beats — and the raw-image fallback (screen reading
      // failed to parse, or describeFirst off) walked straight past all of
      // them: a live session surfaced "We'll pick a bearing off those
      // formations" (collective) and a Paxton-Landing word salad from exactly
      // that path. A beat is a beat; the voice rules do not care which prompt
      // produced it.
      if (speakable) {
        // One retry, and only for conversation beats: copilotRetryMsgs belongs
        // to the LAST fireCopilotBeat, so resampling it for a raw-image beat
        // would answer a different prompt than the one that misfired.
        const resample = (note: string): boolean => {
          if (!fromCopilot || this.copilotRetried || !this.copilotRetryMsgs) return false;
          this.copilotRetried = true;
          this.copilotBeatInFlight = true;
          this.noteGlance(note);
          this.startLlm(entry, 'commentary', this.copilotRetryMsgs, 0.85, 1800, undefined, profileFor(this.activeModel()).resamplePenalties);
          return true;
        };
        const dropBeat = (note: string): void => {
          this.noteGlance(note);
          if (fromCopilot) this.copilot?.recordSilent();
          this.feed = this.feed.filter((e) => e !== entry);
          this.emit();
        };
        // Say-it-again gate: the model re-serves the same fact in fresh words
        // when nothing new has happened. Dropping is better than repeating.
        if (isNearDuplicate(groundedText, this.recentStories)) {
          dropBeat('dropped a beat — too close to one just spoken');
          return;
        }
        // Same-subject gate. isNearDuplicate compares WORDS, and the operator
        // can say one thing five ways without repeating a single one: "Nine
        // times in two days?", "you still haven't found an exit sign", "the
        // view's big enough for nine visits", "you're stuck in the routine".
        // Every one of those passed the word check in a live session. Resample
        // first — the model usually has something else to say if asked again.
        const topic = topicOf(groundedText);
        if (overusedTopic(topic, this.recentTopics)) {
          if (resample(`resampling — third beat in a row about "${topic}"`)) return;
          dropBeat(`dropped a beat — nothing new to say about "${topic}"`);
          return;
        }
        // The voice fences, in one decision shared with the glance path:
        //   lifted     — a phrase copied out of its own instructions is not an
        //                observation, and lands wrong as often as not.
        //   collective — "we/us/our" is the model slipping out of its own skin
        //                and into play-by-play.
        //   habitual   — "Jaques Station always smells like recycled air", a
        //                claim it cannot know. Measured to fire almost only on
        //                beats with nothing real to say, so catching it really
        //                catches an empty beat.
        const violation = findVoiceViolation(groundedText);
        if (violation) {
          const { fence, detail } = violation;
          const [retry, drop] = {
            lifted: [`parroted the example "${detail}"`, `parroted "${detail}"`],
            collective: [`said "${detail}" instead of speaking for itself`, `collective "${detail}"`],
            habitual: [`invented an atmosphere: "${detail}"`, `nothing to say but "${detail}"`],
          }[fence];
          if (resample(`resampling — ${retry}`)) return;
          dropBeat(`dropped a beat — ${drop}`);
          return;
        }
        // Fact fence — conversation beats only: copilotAllowedPlaces is built
        // per copilot beat, so judging a raw-image beat against it would flag
        // places that beat WAS legitimately told about in its own prompt.
        if (fromCopilot) {
          const invented = findFabricatedPlace(groundedText, this.copilotAllowedPlaces);
          if (invented) {
            if (resample(`resampling — invented place "${invented}"`)) return;
            dropBeat(`dropped a beat — invented place "${invented}"`);
            return;
          }
        }
      }
      if (isSilenceVerdict(groundedText)) {
        this.noteGlance(
          /NO_BEAT/.test(groundedText)
            ? 'nothing specific worth interrupting for — stayed quiet'
            : finalText
              ? 'screen was not the game — stayed quiet'
              : 'commentary came back empty',
        );
        if (fromCopilot) this.copilot?.recordSilent();
        this.feed = this.feed.filter((e) => e !== entry);
      } else {
        this.noteGlance('commentary spoken');
        // A real beat with the decline token stuck to it: say the beat, drop
        // the token. Applied to what is SPOKEN and to what the conversation
        // remembers, so "NO_BEAT" never lands in the transcript as the
        // operator's own words and teaches it that is a thing it says.
        const spoken = stripVerdict(groundedText);
        if (fromCopilot) this.copilot?.recordSpoken(stripVerdict(finalText));
        entry.text = `👁 ${spoken}`;
        entry.streaming = false;
        this.lastStoryText = spoken;
        this.rememberStory(spoken);
        this.speak(spoken);
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
      // A briefing is the operator speaking, so the operator should remember
      // saying it: without this the copilot could introduce a contract and then,
      // two beats later, remark on it as if hearing about it for the first time.
      if (kind === 'brief') this.copilotEvent(`OPERATOR SAID: ${finalText}`);
      // An answer to the commander belongs in the SAME thread the beats live
      // in — otherwise the next question ("what thing?", "why?") arrives with
      // the exchange it refers to missing, which is exactly how a follow-up
      // ended up answered with market data.
      if (kind === 'ai' && this.lastAskedQuestion) {
        this.copilot?.recordExchange(this.lastAskedQuestion, finalText);
        this.lastAskedQuestion = null;
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
      // Close the dangling copilot user turn so the transcript stays alternating.
      if (this.copilotBeatInFlight) this.copilot?.recordSilent();
      this.copilotBeatInFlight = false;
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
    this.view = 'missions';
    this.emit();
  }

  cycleMission(delta: number): void {
    const missions = this.snap.missions;
    if (!missions.length) return;
    const idx = Math.max(0, missions.findIndex((m) => m.id === this.selectedId));
    const next = missions[(idx + delta + missions.length) % missions.length];
    this.selectedId = next.id;
    this.view = 'missions';
    this.emit();
  }

  setView(v: 'missions' | 'deathclock' | 'plotter' | 'architect' | 'news'): void {
    this.view = v;
    // Opening the list is the moment the commander wants to know where to buy
    // — but only ask the network if nothing usable was fetched recently.
    if (v === 'architect') void this.architectScan(false);
    // Opening the paper is a request for today's edition, if one is due.
    if (v === 'news') void this.refreshNews(false);
    this.emit();
  }

  /** Manual death-clock calibration from the tab ("this is happening now"). */
  deathClockMark(kind: DeathClockMarkKind): void {
    this.deathClock.mark(kind, Date.now());
    this.persistDeathClock();
    if (kind === 'clear') {
      this.pushFeed('system', '☠ Death clock cleared.');
    } else {
      const now = this.deathClockNow();
      if (now) this.pushFeed('system', `☠ Death clock set — ${now}.`);
    }
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

  /** Hear the newsreader before committing to it. */
  testNewsVoice(): void {
    this.speaker.test(this.settings.news.voice ?? this.settings.voice.piperVoice);
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
    if (prev.chatter.epic !== next.chatter.epic) {
      this.copilot?.setSystem(
        buildCopilotSystem(this.sm.commanderName || undefined, {
          epic: next.chatter.epic,
          place: this.currentPlace(),
        }),
      );
    }
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
      if (this.deathClock.apply(ev)) this.persistDeathClock();
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
