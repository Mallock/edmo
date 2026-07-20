/**
 * Bridge to the Tauri (Rust) backend. Every function degrades gracefully when
 * running in a plain browser (vite dev without Tauri) so the manual-import
 * panel still works without the game or the shell.
 */
import { invoke } from '@tauri-apps/api/core';
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
}): Promise<string> {
  return invoke<string>('spansh_trade_route', {
    system: opts.system,
    station: opts.station,
    maxCargo: opts.maxCargo,
    capital: opts.capital,
    maxHopDistance: opts.maxHopDistance,
    maxHops: opts.maxHops,
    requiresLargePad: opts.requiresLargePad,
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

export async function llmModels(endpoint: string): Promise<string[]> {
  return invoke<string[]>('llm_models', { endpoint });
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
  });
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
