/**
 * Bridge to the Tauri (Rust) backend. Every function degrades gracefully when
 * running in a plain browser (vite dev without Tauri) so the manual-import
 * panel still works without the game or the shell.
 */
import { invoke } from '@tauri-apps/api/core';
import type { MarketRow } from '../engine/traderoute.ts';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const isTauri =
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface JournalLinesPayload {
  lines: string[];
  live: boolean;
}

export interface SnapshotPayload {
  name: string; // "Missions.json" | "Status.json" | "Cargo.json" | "NavRoute.json"
  text: string;
}

export interface WatchStatusPayload {
  ok: boolean;
  dir: string;
  file: string | null;
  error: string | null;
}

export type ShortcutAction = 'ask' | 'voice' | 'cycle' | 'collapse' | 'ptt-down' | 'ptt-up';

export interface LlmTokenPayload {
  id: string;
  token: string;
}

export interface LlmDonePayload {
  id: string;
  text: string;
  /** Tool calls the model requested this turn (empty when it just answered). */
  tool_calls?: ToolCallWire[];
}

export interface LlmErrorPayload {
  id: string;
  message: string;
}

/** One tool call the model requested (OpenAI shape); `arguments` is JSON text. */
export interface ToolCallWire {
  id: string;
  type?: string;
  function: { name: string; arguments: string };
}

export interface ChatMessageWire {
  role: string;
  /** Plain text, or OpenAI content parts for vision messages. */
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string } }
      >;
  /** Assistant turn that requested tools. */
  tool_calls?: ToolCallWire[];
  /** Tool result message — the call it answers. */
  tool_call_id?: string;
  name?: string;
}

export async function defaultJournalDir(): Promise<string> {
  return invoke<string>('default_journal_dir');
}

export async function systemSpecs(): Promise<import('./modelfit.ts').SystemSpecs> {
  return invoke('system_specs');
}

export async function startWatch(
  dir: string | null,
  bootstrapPrevious: number,
): Promise<void> {
  await invoke('start_watch', { dir, bootstrapPrevious });
}

export async function setClickThrough(enabled: boolean): Promise<void> {
  await invoke('set_click_through', { enabled });
}

export async function closeApp(): Promise<void> {
  await invoke('close_app');
}

/** Put text on the OS clipboard (galaxy-map waypoint pasting). */
export async function copyText(text: string): Promise<void> {
  await invoke('copy_text', { text });
}

export async function piperAvailable(): Promise<boolean> {
  return invoke<boolean>('piper_available');
}

/** Installed Piper voice names (bundled + downloaded). */
export async function piperVoices(): Promise<string[]> {
  return invoke<string[]>('piper_voices');
}

/** Download a voice from the official piper-voices repo (user-initiated). */
export async function piperDownloadVoice(repoPath: string): Promise<string> {
  return invoke<string>('piper_download_voice', { repoPath });
}

/** Opt-in Spansh trade-route query; resolves to the raw results JSON. */
export async function spanshTradeRoute(opts: {
  system: string;
  station: string | null;
  maxCargo: number;
  capital: number;
  maxHopDistance: number;
  maxHops: number;
  requiresLargePad: boolean;
  /** Reject markets not reported within this many days. */
  maxPriceAgeDays: number;
}): Promise<string> {
  return invoke<string>('spansh_trade_route', {
    system: opts.system,
    station: opts.station,
    maxCargo: opts.maxCargo,
    capital: opts.capital,
    maxHopDistance: opts.maxHopDistance,
    maxHops: opts.maxHops,
    requiresLargePad: opts.requiresLargePad,
    maxPriceAgeDays: opts.maxPriceAgeDays,
  });
}

/** Synthesize with a local Piper model; resolves to a WAV ArrayBuffer. */
export async function piperSpeak(
  text: string,
  lengthScale: number,
  voice: string | null,
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>('piper_speak', { text, lengthScale, voice });
}

export async function llmModels(endpoint: string, apiKey?: string | null): Promise<string[]> {
  return invoke<string[]>('llm_models', { endpoint, apiKey: apiKey ?? null });
}

/** Model id → type ("vlm" | "llm" | "embeddings") from LM Studio's REST API.
 *  Empty when the endpoint doesn't expose it (older LM Studio). */
export async function llmModelTypes(endpoint: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>('llm_model_types', { endpoint });
}

export async function llmChat(opts: {
  id: string;
  endpoint: string;
  model: string;
  messages: ChatMessageWire[];
  temperature: number;
  maxTokens: number;
  responseFormat?: unknown; // OpenAI response_format (json_schema) passthrough
  tools?: unknown; // OpenAI tools manifest; enables the tool loop
  presencePenalty?: number; // discourage repeated topics (copilot anti-looping)
  frequencyPenalty?: number; // discourage repeated tokens (copilot anti-looping)
  apiKey?: string | null; // bundled engine's per-session key; null for LM Studio
}): Promise<void> {
  await invoke('llm_chat', {
    id: opts.id,
    endpoint: opts.endpoint,
    model: opts.model,
    messages: opts.messages,
    temperature: opts.temperature,
    maxTokens: opts.maxTokens,
    responseFormat: opts.responseFormat ?? null,
    tools: opts.tools ?? null,
    presencePenalty: opts.presencePenalty ?? null,
    frequencyPenalty: opts.frequencyPenalty ?? null,
    apiKey: opts.apiKey ?? null,
  });
}

// ------------------------------------------------------------ bundled engine
// The app can fetch its own llama.cpp runtime + model so LM Studio is optional
// (TASKS-1.0.md). Everything still speaks the OpenAI API on 127.0.0.1, so the
// chat path above is unchanged — only the endpoint and key differ.

export interface EngineModelInfo {
  id: string;
  label: string;
  bytes: number;
  installed: boolean;
  /** Bytes already fetched into a `.part` — >0 means a download can resume. */
  partial_bytes: number;
  /** Set for models found outside our own dir (e.g. an LM Studio download). */
  external_path: string | null;
  needs_gb: number;
  licence: string;
}

export interface EngineStatus {
  runtime_installed: boolean;
  runtime_backend: string | null;
  recommended_backend: string;
  models: EngineModelInfo[];
  running: boolean;
  port: number | null;
  api_key: string | null;
  running_model: string | null;
}

export interface EngineProgress {
  phase: string;
  received: number;
  total: number;
}

export async function engineStatus(gpus: string[]): Promise<EngineStatus> {
  return invoke<EngineStatus>('engine_status', { gpus });
}

/** GGUF+mmproj pairs already on disk (LM Studio), reusable without a big pull. */
export async function engineScanLocalModels(): Promise<EngineModelInfo[]> {
  return invoke<EngineModelInfo[]>('engine_scan_local_models');
}

export async function engineDownloadRuntime(backend: string): Promise<void> {
  await invoke('engine_download_runtime', { backend });
}

export async function engineDownloadModel(modelId: string): Promise<void> {
  await invoke('engine_download_model', { modelId });
}

export async function engineRemoveModel(modelId: string): Promise<void> {
  await invoke('engine_remove_model', { modelId });
}

/** Drop an interrupted transfer and reclaim the disk. */
export async function engineDiscardPartial(modelId: string): Promise<void> {
  await invoke('engine_discard_partial', { modelId });
}

export async function engineCancelDownload(): Promise<void> {
  await invoke('engine_cancel_download');
}

export async function engineStart(modelId: string, ctxSize?: number): Promise<EngineStatus> {
  return invoke<EngineStatus>('engine_start', { modelId, ctxSize: ctxSize ?? null });
}

export async function engineStop(): Promise<void> {
  await invoke('engine_stop');
}

export async function engineAlive(): Promise<boolean> {
  return invoke<boolean>('engine_alive');
}

/** Tail of the engine's own log — what it said before it died. */
export async function engineLog(): Promise<string> {
  return invoke<string>('engine_log');
}

export function onEngineProgress(cb: Cb<EngineProgress>): Promise<UnlistenFn> {
  return sub('engine-progress', cb);
}

/** Galnet headlines (opt-in). Sends nothing about the commander — a plain GET
 *  of the same public feed the website serves. */
export interface GalnetItem { title: string; date: string; lead: string }
export async function galnetHeadlines(limit = 8): Promise<GalnetItem[]> {
  return JSON.parse(await invoke<string>('galnet_headlines', { limit })) as GalnetItem[];
}

/** One galaxy-wide market row from Ardent Insight (EDDN-sourced, anonymous). */
export interface ArdentMarketRow {
  station: string;
  system: string;
  distanceLy: number | null;
  price: number | null;
  stock: number | null;
  demand: number | null;
  pad: string | null;
  carrier: boolean;
  updatedAt: string | null;
}

/** Opt-in galaxy-wide commodity lookup; sends only the system + commodity. */
export async function ardentMarket(
  system: string,
  commodity: string,
  side: 'buy' | 'sell',
): Promise<ArdentMarketRow[]> {
  return JSON.parse(await invoke<string>('ardent_market', { system, commodity, side })) as ArdentMarketRow[];
}

/** Origin exports + destination imports, for a run the commander already plans. */
export interface DirectedCandidates {
  origin: string;
  destination: string;
  originKnown: boolean;
  destinationKnown: boolean;
  sources: MarketRow[];
  sinks: MarketRow[];
}

/** Opt-in directed trade search. Sends only the two system names. */
export async function ardentTradeTo(
  origin: string,
  destination: string,
  minVolume: number,
): Promise<DirectedCandidates> {
  return JSON.parse(
    await invoke<string>('ardent_trade_to', { origin, destination, minVolume }),
  ) as DirectedCandidates;
}

/**
 * Landing-pad size per station in one system (opt-in). Spansh returns no pad
 * data, so this is the only way to know whether a routed stop is dockable.
 */
export async function ardentStationPads(system: string): Promise<Record<string, number>> {
  return JSON.parse(await invoke<string>('ardent_station_pads', { system })) as Record<string, number>;
}

/** Raw material for a trade search: what the origin sells, and where it sells. */
export interface TradeCandidates {
  origin: string;
  /** False when Ardent has no record of the origin system (404). */
  originKnown: boolean;
  sources: MarketRow[];
  sinks: Record<string, MarketRow[]>;
  checked: number;
  candidates: number;
}

/**
 * Opt-in trade search around one system. Sends the origin system name and the
 * commodity names probed — nothing about the commander.
 */
export async function ardentTradeCandidates(
  system: string,
  maxDistance: number,
  minVolume: number,
  probe: number,
): Promise<TradeCandidates> {
  return JSON.parse(
    await invoke<string>('ardent_trade_candidates', {
      system,
      maxDistance,
      minVolume,
      probe,
    }),
  ) as TradeCandidates;
}

/** One body with organics reported by other commanders (EDAstro / GEC). */
export interface EdAstroOrganicBody {
  body: string; subType: string | null; landable: boolean | null;
  gravity: number | null; distanceLs: number | null; species: string[];
}

export interface EdAstroSystem {
  system: string; bodyCount: number | null; planets: number; landablePlanets: number;
  earthLikes: number | null; waterWorlds: number | null; ammoniaWorlds: number | null;
  terraformables: number | null; fssProgress: number | null;
  bodiesWithOrganics: EdAstroOrganicBody[];
}

/** Opt-in exploration catalogue lookup; sends only the system name. */
export async function edastroSystem(name: string): Promise<EdAstroSystem> {
  return JSON.parse(await invoke<string>('edastro_system', { name })) as EdAstroSystem;
}

/** Load the persistent commander memory bank (app-data memory.json). */
export async function memoryLoad(): Promise<string> {
  return invoke<string>('memory_load');
}

export async function memorySave(text: string): Promise<void> {
  await invoke('memory_save', { text });
}

/** One screen glance: primary display → ≤1280px JPEG data URI (in-memory only). */
export async function captureScreen(): Promise<string> {
  return invoke<string>('capture_screen');
}

// ---------------------------------------------------------------- voice input

/** True when the whisper.cpp sidecar + model are installed. */
export async function sttAvailable(): Promise<boolean> {
  return invoke<boolean>('stt_available');
}

/** One-time ~150 MB download of whisper.cpp + base.en (user-initiated). */
export async function sttDownload(): Promise<void> {
  await invoke('stt_download');
}

/** Start recording the default microphone (push-to-talk pressed). */
export async function sttStart(): Promise<void> {
  await invoke('stt_start');
}

/** Stop recording and transcribe; '' when too short / no speech. */
export async function sttStop(): Promise<string> {
  return invoke<string>('stt_stop');
}

/** Discard an in-flight recording. */
export async function sttCancel(): Promise<void> {
  await invoke('stt_cancel');
}

export async function llmCancel(id: string): Promise<void> {
  await invoke('llm_cancel', { id });
}

type Cb<T> = (payload: T) => void;

async function sub<T>(event: string, cb: Cb<T>): Promise<UnlistenFn> {
  return listen<T>(event, (e) => cb(e.payload));
}

export function onJournalLines(cb: Cb<JournalLinesPayload>): Promise<UnlistenFn> {
  return sub('journal-lines', cb);
}
export function onJournalReady(cb: Cb<{ file: string | null }>): Promise<UnlistenFn> {
  return sub('journal-ready', cb);
}
export function onSnapshot(cb: Cb<SnapshotPayload>): Promise<UnlistenFn> {
  return sub('snapshot', cb);
}
export function onWatchStatus(cb: Cb<WatchStatusPayload>): Promise<UnlistenFn> {
  return sub('watch-status', cb);
}
export function onShortcut(cb: Cb<{ action: ShortcutAction }>): Promise<UnlistenFn> {
  return sub('shortcut', cb);
}
export function onClickThrough(cb: Cb<{ enabled: boolean }>): Promise<UnlistenFn> {
  return sub('click-through', cb);
}
export function onLlmToken(cb: Cb<LlmTokenPayload>): Promise<UnlistenFn> {
  return sub('llm-token', cb);
}
export function onLlmDone(cb: Cb<LlmDonePayload>): Promise<UnlistenFn> {
  return sub('llm-done', cb);
}
export function onLlmError(cb: Cb<LlmErrorPayload>): Promise<UnlistenFn> {
  return sub('llm-error', cb);
}
