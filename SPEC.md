# Elite Dangerous Mission Operator — Application Specification

**Version:** 2.0
**Date:** 2026-07-18 (revised)
**Status:** Draft

> **v2.0 revision note.** v1.0 assumed mission data came from a "Frontier Connect API" with an
> "EDSM fallback". That is incorrect: Elite Dangerous exposes the commander's **active missions
> only through the local Player Journal** (`Journal.*.log`) and its companion snapshot files
> (`Missions.json`, `Status.json`, `Cargo.json`, `NavRoute.json`). Frontier's real Companion API
> (cAPI) returns profile/market/shipyard data but **not** live mission objectives, and EDSM stores
> flight logs and system data, **not** your accepted missions. This revision reworks all ingestion
> around the Journal, with field names and event flows verified against real game data captured on
> the developer's machine (see §3.1.6, §10.A, §10.B).

---

## 1. Overview

### 1.1 Purpose
The **Elite Dangerous Mission Operator** is a desktop companion application that reads the
commander's **currently active missions** directly from the game's local Player Journal, processes
them through a local LLM (via LM Studio), and delivers spoken guidance through text-to-speech — all
while an always-on-top HUD remains usable during gameplay.

### 1.2 Scope
- Ingest **active mission state** by watching the local Elite Dangerous Journal + snapshot files.
- Reconstruct each mission's full detail and derive a step timeline from the journal event flow.
- Query LM Studio (`http://127.0.0.1:1234/v1`) for analysis, recommendations, and guidance.
- Synthesize voice output via the WebView2/Edge TTS engine (with a local-only fallback).
- Render an always-on-top HUD with mission status, objectives, timers, and AI responses.
- Support the real ED mission taxonomy (courier, delivery, passenger, massacre, assassinate,
  salvage, mining, rescue, sightseeing, long-distance expedition, and more — see §10.A).

### 1.3 Non-Goals (v1)
- Direct game-memory reading or DLL hooking.
- Automated pilot control / botting.
- Writing to the game or triggering in-game actions.
- Multi-account or cloud sync.

---

## 2. Architecture

### 2.1 High-Level Diagram

```
┌──────────────────────────────────────────────────────────────┐
│                     Elite Dangerous (game)                     │
│  writes append-only Journal + live snapshot JSON files to      │
│  %USERPROFILE%\Saved Games\Frontier Developments\              │
│                 Elite Dangerous\                               │
│   Journal.<ts>.<part>.log   Missions.json   Status.json        │
│   Cargo.json   NavRoute.json   Market.json   ...               │
└───────────────────────────┬──────────────────────────────────┘
                            │ file writes (append + rewrite)
                            ▼
┌──────────────────────────────────────────────────────────────┐
│               Mission Operator — Tauri backend (Rust)          │
│  ┌────────────────┐   ┌───────────────────┐                    │
│  │ Journal Watcher│──▶│ Mission State     │                    │
│  │ (fs-notify tail│   │ Manager           │                    │
│  │  + snapshot    │   │ (accept/redirect/ │                    │
│  │  readers)      │   │  complete/fail →  │                    │
│  └────────────────┘   │  active[] + steps)│                    │
│                       └─────────┬─────────┘                    │
│                                 │ Tauri events / IPC           │
└─────────────────────────────────┼─────────────────────────────┘
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│            Mission Operator — WebView2 frontend (React)        │
│  ┌──────────┐   ┌──────────────┐   ┌───────────────────────┐   │
│  │ LM Studio│   │ TTS          │   │ Always-on-Top HUD     │   │
│  │ Client   │──▶│ Synthesizer  │──▶│ (status/objectives/   │   │
│  │ (fetch)  │   │ (speechSynth │   │  chat)                │   │
│  └────┬─────┘   │  + fallback) │   └───────────────────────┘   │
└───────┼─────────┴──────────────┴───────────────────────────────┘
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│   LM Studio API  —  http://127.0.0.1:1234/v1  (local, no cloud)│
└──────────────────────────────────────────────────────────────┘

  Optional enrichment (network, opt-in): EDSM (system coordinates /
  jump-distance estimates), Spansh (route plotting), cAPI (profile).
```

### 2.2 Technology Stack

| Layer | Technology | Rationale |
|-------|-----------|-----------|
| Desktop framework | **Tauri 2.x** (Rust backend + web frontend) | Small footprint, native `always-on-top`, and on Windows the WebView is **WebView2 = Edge Chromium**, so the Web Speech API voices are available |
| Journal watching | **Rust `notify` crate** + buffered tail reader | Robust file-change detection; handles append-only journal + full-rewrite snapshots |
| Frontend | **React + TypeScript + Vite** | Fast UI, mature ecosystem |
| Styling | **Tailwind CSS** | Rapid, responsive HUD |
| LLM client | **`fetch` → `http://127.0.0.1:1234/v1/chat/completions`** | OpenAI-compatible API from LM Studio |
| TTS engine | **`window.speechSynthesis` (Web Speech API)** primary; **local sidecar** fallback | Edge Chromium voices in-WebView; local fallback for offline/privacy (see §3.3.4) |
| Packaging | **Tauri CLI** → `.msi` / `.exe` | Native Windows distribution |

### 2.3 Why Tauri over Electron?
- Bundle ~5 MB vs ~150 MB; lower memory footprint (the player already runs a 3D game).
- Native window API for `always-on-top` / decorations / click-through without extra modules.
- Rust backend is a natural home for file watching and safe JSON parsing off the UI thread.
- On Windows the WebView is WebView2 (Edge Chromium), so `speechSynthesis` and the Edge Natural
  voices work without bundling a browser.

---

## 3. Core Features

### 3.1 Mission Data Ingestion (Journal-based)

#### 3.1.1 Source of truth: the Player Journal + snapshot files

Elite Dangerous writes, in real time, to a per-user directory:

```
Windows:  %USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\
```

The directory location is fixed by the game and is **not** configurable in-game; it can be
overridden in app settings for non-standard installs (e.g. a moved "Saved Games" folder).

Relevant files:

| File | Nature | Use |
|------|--------|-----|
| `Journal.<timestamp>.<part>.log` | **Append-only, JSON-lines** (one JSON object per line). A new file is created each game session; a session may roll to `.02`, `.03` parts. | Authoritative event stream: mission accept/redirect/complete/fail/abandon, cargo depot progress, jumps, docking. |
| `Missions.json` | Full-file **rewrite** snapshot | Fast list of currently `Active` / `Failed` / `Complete` mission IDs with names and an `Expires` countdown (seconds). Written when missions change; **absent when the commander has no mission history this session.** |
| `Status.json` | Full-file rewrite, high-frequency | Real-time flags (docked, landed, in supercruise, low fuel, etc.), current system, fuel, cargo count. |
| `Cargo.json` | Full-file rewrite | Current cargo hold contents (for delivery/mining/collect missions). |
| `NavRoute.json` | Full-file rewrite | The commander's plotted galaxy-map route (systems + coordinates). Used for route/threat context. |
| `Market.json`, `ModulesInfo.json`, `Outfitting.json`, `Shipyard.json`, `ShipLocker.json`, `Backpack.json` | Full-file rewrite | Secondary context (e.g. commodity prices for trade advice). |

> **Format note.** Journal lines are individual JSON objects terminated by newline. The snapshot
> `*.json` files contain a single (sometimes pretty-printed) JSON object and are rewritten wholesale,
> so they must be read with a small read-retry to avoid catching a partial write.

#### 3.1.2 Ingestion strategy

1. **Locate** the journal directory (default path above; overridable in settings).
2. **Select the active journal** = the `Journal.*.log` with the newest timestamp; re-select when a
   newer file appears (new session).
3. **Bootstrap** on startup by replaying the current session's journal from the top (and, optionally,
   the previous N journals) to rebuild active-mission state, since `Missions.json` alone lacks full
   detail. Reconcile against `Missions.json` for the authoritative active-ID set and live `Expires`.
4. **Tail** the active journal: on file-change, read appended lines, parse each event, update state.
5. **Watch snapshots** (`Missions.json`, `Status.json`, `Cargo.json`, `NavRoute.json`) for rewrites
   and refresh derived state (timers, cargo progress, current location).
6. **Emit** a normalized `MissionState` to the frontend over Tauri IPC on every change.

All watching and parsing happens in the **Rust backend** (off the UI thread) using the `notify`
crate; the frontend only receives normalized state.

#### 3.1.3 Mission lifecycle events (the real event flow)

State is built by folding these journal events (field names verified against real journals):

| Event | Meaning | Key fields consumed |
|-------|---------|---------------------|
| `Missions` | Session snapshot of all missions | `Active[]`, `Failed[]`, `Complete[]`, each `{MissionID, Name, PassengerMission, Expires}` |
| `MissionAccepted` | New mission taken | `MissionID`, `Name`, `LocalisedName`, `Faction`, `DestinationSystem`, `DestinationStation`, `Expiry`, `Reward`, and type-specific fields (see §3.1.4) |
| `MissionRedirected` | **Objective/destination changed** (e.g. after a kill you're sent to hand in) | `MissionID`, `NewDestinationSystem`, `NewDestinationStation`, `OldDestinationSystem`, `OldDestinationStation` |
| `CargoDepot` | Delivery/collect/wing progress tick | `MissionID`, `UpdateType` (`Collect`/`Deliver`/`WingUpdate`), `ItemsCollected`, `ItemsDelivered`, `TotalItemsToDeliver`, `Progress` |
| `MissionCompleted` | Handed in | `MissionID`, `Reward`, `MaterialsReward[]`, `FactionEffects[]` |
| `MissionFailed` | Failed (usually expiry) | `MissionID`, `Name`, `LocalisedName` |
| `MissionAbandoned` | Abandoned by player | `MissionID`, `Name`, `LocalisedName` |
| `FSDJump` / `Location` / `CarrierJump` | Current system changed | `StarSystem`, `StarPos` |
| `Docked` / `Undocked` | At/left a station | `StationName`, `StarSystem`, `MarketID` |
| `Bounty` / `FactionKillBond` | Combat progress (massacre/assassinate) | `Target`, `VictimFaction`, `Rewards[]` |

> **There is no per-mission "steps" field in the game.** ED does not emit an objective checklist.
> The app **derives** steps from the event flow (§3.1.5). Progress for massacre/kill missions is
> not directly counted in the mission object — it must be inferred from `Bounty`/`FactionKillBond`
> events tagged to the target faction, then confirmed by the eventual `MissionRedirected`
> (redirect-to-handin) and `MissionCompleted`.

#### 3.1.4 Mission type detection

The mission **type is not a clean enum in the game** — it is encoded in the internal `Name` string,
e.g. `Mission_Courier_Expansion`, `Mission_PassengerVIP_CEO_EXPANSION`, `Mission_Assassinate`,
`MISSION_Salvage_Illegal`. Detection rules:

1. Lower-case the `Name` (the game uses both `Mission_` and `MISSION_` prefixes).
2. Strip the `mission_` prefix and any trailing `_name`.
3. The **first token** is the family: `courier`, `delivery`, `deliverywing`, `passengerbulk`,
   `passengervip`, `sightseeing`, `longdistanceexpedition`, `massacre`, `assassinate`, `salvage`,
   `collect`, `mining`, `rescue`, …
4. Remaining tokens are modifiers: the government/BGS state (`_expansion`, `_democracy`, `_war`,
   `_civilwar`, `_boom`, `_election`, `_bust`, `_outbreak`, `_conflict`) and passenger sub-flavor
   (`_ceo`, `_tourist`, `_explorer`, `_security_arriving`, `_refugee_leaving`, `_medical_arriving`,
   …).
5. Cross-check flags: `PassengerMission: true` ⇒ passenger family; presence of `Target`/`TargetType`
   ⇒ assassinate/kill; presence of `Commodity`+`Count` with a `TargetFaction` ⇒ delivery/collect.

Map the detected family to a normalized app category for prompt selection and HUD color coding.

#### 3.1.5 Derived mission model & step synthesis

```typescript
interface Mission {
  id: number;                 // MissionID (numeric in the journal)
  internalName: string;       // e.g. "Mission_Assassinate"
  title: string;              // LocalisedName, e.g. "Assassinate Known Pirate: LazerFX"
  category: MissionCategory;  // normalized family (see below)
  bgsState?: string;          // "Expansion" | "War" | "Boom" | ... (parsed from Name)
  faction?: string;           // giving faction
  targetFaction?: string;     // TargetFaction (delivery/kill)
  origin?: Location;          // where accepted (from context at accept time)
  destination?: Location;     // current destination (updated by MissionRedirected)
  reward: number;             // credits
  influence?: string;         // "+", "++", ...
  reputation?: string;        // "+", "++", ...
  wing: boolean;
  expiry: string | null;      // ISO timestamp (Expiry); null if none
  expiresInSec?: number;      // from Missions.json Expires (live countdown)

  // type-specific (present when applicable)
  commodity?: { name: string; localised: string; count: number };
  passengers?: { count: number; type: string; vip: boolean; wanted: boolean };
  target?: { name: string; type: string };

  // derived progress
  cargo?: { collected: number; delivered: number; total: number; progress: number };
  steps: MissionStep[];       // SYNTHESIZED, not from the game
  state: MissionState;        // ACTIVE | REDIRECTED | COMPLETE | FAILED | ABANDONED
  raw: Record<string, unknown>; // original MissionAccepted for debugging / prompts
}

interface Location { system: string; station?: string; }
interface MissionStep { label: string; done: boolean; source: 'accept'|'cargodepot'|'redirect'|'complete'; }

type MissionState = 'ACTIVE' | 'REDIRECTED' | 'COMPLETE' | 'FAILED' | 'ABANDONED';

type MissionCategory =
  | 'Courier' | 'Delivery' | 'DeliveryWing'
  | 'PassengerBulk' | 'PassengerVIP' | 'Sightseeing' | 'LongDistanceExpedition'
  | 'Massacre' | 'Assassinate'
  | 'Salvage' | 'Collect' | 'Mining' | 'Rescue'
  | 'Other';
```

**Step synthesis rules (examples):**

- *Courier / Delivery:* `Travel to {DestinationSystem}` → `Dock at {DestinationStation}` →
  (`Deliver {count} {commodity}` from `CargoDepot`) → `Hand in`. Cargo steps tick from `CargoDepot`
  `ItemsDelivered/TotalItemsToDeliver`.
- *Assassinate / Massacre:* `Travel to {DestinationSystem}` → `Eliminate {target/count}` (progress
  from `Bounty`/`FactionKillBond`) → **`MissionRedirected`** → `Return to {NewDestinationStation}` →
  `Hand in`.
- *Passenger:* `Board {count} {type} passengers` → `Travel to {DestinationSystem}` →
  `Dock at {DestinationStation}` → `Complete`. Sightseeing adds intermediate `Visit {beacon}` steps
  emitted as `MissionRedirected` hops.

#### 3.1.6 Worked example (real captured data)

An assassination mission from the developer's own journal, showing accept → redirect:

```json
// MissionAccepted
{ "event":"MissionAccepted", "Faction":"EG Union", "Name":"Mission_Assassinate",
  "LocalisedName":"Assassinate Known Pirate: LazerFX",
  "TargetType":"$MissionUtil_FactionTag_PirateLord;", "TargetType_Localised":"Known Pirate",
  "TargetFaction":"Clan of Hors", "DestinationSystem":"Crucis Sector SO-R a4-0",
  "DestinationStation":"Ohm City", "Target":"LazerFX",
  "Expiry":"2025-06-19T10:46:27Z", "Reward":1564280, "MissionID":1019940338 }

// MissionRedirected — after the kill, hand-in destination changes
{ "event":"MissionRedirected", "MissionID":1019940338, "Name":"Mission_Assassinate",
  "LocalisedName":"Assassinate Known Pirate: LazerFX",
  "NewDestinationStation":"Hyperion Monolith 001 - Sheparts Legacy", "NewDestinationSystem":"Aoesta",
  "OldDestinationStation":"", "OldDestinationSystem":"Crucis Sector SO-R a4-0" }
```

Normalized to the app model, this becomes: category `Assassinate`, target `LazerFX` (Known Pirate,
faction *Clan of Hors*), reward 1,564,280 cr, steps `Travel to Crucis Sector SO-R a4-0` →
`Eliminate LazerFX` → `Return to Aoesta / Hyperion Monolith 001` → `Hand in`, with the third step
unlocked by the `MissionRedirected` event.

#### 3.1.7 Supplementary / optional input methods

| Method | Description | Priority |
|--------|-------------|----------|
| **Journal watcher** | Watch local Journal + snapshot files (above) | **Primary — always on** |
| **Manual JSON import** | Paste a `MissionAccepted`/`Missions` JSON blob for testing or for a machine without the game | Convenience / testing |
| **EDSM (opt-in, network)** | Look up system coordinates to estimate jump distance/route length. *EDSM does not provide your missions.* | Optional enrichment |
| **Spansh (opt-in, network)** | Neutron/road-to-riches route plotting for long hauls | Optional enrichment |
| **cAPI / Frontier Auth (opt-in)** | OAuth profile/market data. *Does not include live mission objectives.* | Optional, later |

### 3.2 LM Studio Integration

#### 3.2.1 Endpoint
```
POST http://127.0.0.1:1234/v1/chat/completions
```

#### 3.2.2 Model selection
Do not hard-code `"model": "auto"`. On startup call `GET /v1/models`, take the first loaded model id
(or a user-chosen one) and use it in requests. If the list is empty, surface "no model loaded".

#### 3.2.3 Request format (grounded in real mission data)
```json
{
  "model": "<id from /v1/models>",
  "messages": [
    { "role": "system", "content": "You are a Mission Operator for Elite Dangerous. Give clear, concise, step-by-step guidance for the commander's active mission. Use correct ED terminology. The pilot is flying — keep it short and speakable." },
    { "role": "user", "content": "Mission (Assassinate): Assassinate Known Pirate 'LazerFX' (faction Clan of Hors) at Ohm City, Crucis Sector SO-R a4-0. Reward 1,564,280 cr. Expires 2025-06-19T10:46:27Z. Current system: Aoesta. After the kill you'll be redirected to hand in at Hyperion Monolith 001, Aoesta." }
  ],
  "temperature": 0.3,
  "max_tokens": 1024,
  "stream": false
}
```

The user-message payload is generated from the normalized `Mission` model, so the LLM always sees
accurate, current fields (destination reflects the latest `MissionRedirected`, timers reflect
`Missions.json`).

#### 3.2.4 Prompt templates by category
Each `MissionCategory` has a tailored system prompt:
- **Courier / Delivery / DeliveryWing:** route + jump range + cargo-space check + hand-in reminder.
- **Massacre / Assassinate:** target/faction, where to find them (RES/CZ/nav beacon), redirect-to-handin.
- **PassengerBulk / PassengerVIP / Sightseeing:** cabin class + count, VIP/wanted handling, comfort/interdiction notes, beacon hops.
- **Salvage / Collect:** where the cargo drops, limpet/collector needs, hand-in.
- **Mining:** ore type + quantity, refining, best sell/hand-in.
- **LongDistanceExpedition:** jump range, fuel/scoop, long-range planning.

#### 3.2.5 Streaming
Support SSE (`"stream": true`, `Accept: text/event-stream`); concatenate tokens into the HUD chat
in real time.

#### 3.2.6 Connection management
- **Health check:** `GET /v1/models` on startup and every 30 s.
- **Auto-reconnect:** exponential backoff 1 s → 2 s → 4 s → … cap 30 s.
- **Offline mode:** keep showing live mission state (which comes from files, not the LLM); queue AI
  requests until LM Studio returns.
- **Timeout:** default 30 s/request, adjustable.

### 3.3 Text-to-Speech Integration

#### 3.3.1 Voice enumeration
```typescript
const voices = speechSynthesis.getVoices(); // populate after 'voiceschanged'
// On Windows WebView2 this includes Edge "…Online (Natural)" voices plus local SAPI voices.
```

#### 3.3.2 Voice features
| Feature | Details |
|---------|---------|
| Voice selection | Dropdown from all available voices |
| Rate | 0.5×–3× |
| Pitch | ±2 semitones |
| Volume | 0–100 % (independent of system) |
| Auto-pause | Pause TTS when the game window loses focus (optional) |
| Queue | Prompts queue and play sequentially |
| De-dupe | Skip repeated output for the same mission step |

#### 3.3.3 Voice prompts by event
| Event | Voice action |
|-------|-------------|
| `MissionAccepted` | Read title, destination, key objective, reward |
| `MissionRedirected` | Read the new objective/destination |
| `CargoDepot` progress | Optional "X of Y delivered" |
| Player asks for help | Speak the AI response |
| Mission near expiry | Alert prompt (configurable threshold) |
| `MissionCompleted`/`MissionFailed` | Short confirmation/alert |

#### 3.3.4 Privacy caveat & local fallback (IMPORTANT — corrects v1.0)
The Edge **"… Online (Natural)"** voices are **cloud** voices: the text is sent to Microsoft's
servers to be synthesized. Using them for mission text means **mission text leaves the machine**,
which contradicts the "no data leaves the machine" goal.

Therefore:
- The app must **label** each voice as **local** or **online (cloud)** in the picker.
- A **"local voices only"** setting (default **on** for privacy) restricts selection to on-device
  voices (local Edge Natural offline voices where installed, otherwise SAPI voices).
- Optional **local sidecar** fallback: bundle a local TTS engine (e.g. an `edge-tts`-style offline
  synthesizer or Windows SAPI via a Rust command) for fully offline, private speech.

### 3.4 Always-on-Top HUD

#### 3.4.1 Window configuration (Tauri, Rust)
```rust
let win = app.get_webview_window("mission-hud").unwrap();
win.set_always_on_top(true)?;
win.set_decorations(false)?;              // custom chrome
win.set_skip_taskbar(true)?;
win.set_size(LogicalSize::new(420.0, 680.0))?;
win.set_position(LogicalPosition::new(1200.0, 100.0))?; // NOTE: position, not size (v1.0 bug)
```
> Prefer declaring these in `tauri.conf.json` (`alwaysOnTop`, `decorations`, `skipTaskbar`,
> `transparent`) and only adjust at runtime for user-driven changes.

#### 3.4.2 HUD layout
```
┌────────────────────────────────────┐
│  ⚙ MISSION OPERATOR         ▣  ✕    │  ← header (draggable)
├────────────────────────────────────┤
│  ASSASSINATE · EG Union            │  ← active mission card
│  Assassinate Known Pirate: LazerFX │
│  → Ohm City [Crucis Sector SO-R…]  │
│  1,564,280 cr   |   expires 9h 12m │
├────────────────────────────────────┤
│  Objective:                        │  ← synthesized steps
│  [✓] Travel to target system       │
│  [ ] Eliminate LazerFX             │
│  [ ] Return & hand in (after kill) │
├────────────────────────────────────┤
│  AI Operator:                      │  ← chat / response panel
│  "LazerFX runs with Clan of Hors — │
│   check the RES and nav beacon.    │
│   After the kill you'll be sent to │
│   hand in at Aoesta."              │
│  [🎤 Speak] [📋 Copy] [🔄 Retry]    │
├────────────────────────────────────┤
│  Missions: 3 active · LM ● · TTS ● │  ← footer / status
└────────────────────────────────────┘
```

#### 3.4.3 HUD states
| State | Description |
|-------|-------------|
| Collapsed | Compact bar: current mission category + nearest expiry timer |
| Expanded | Full HUD |
| Minimized | Hidden; tray/taskbar badge |
| Focused | Chat input active |
| Multi-mission | List/carousel when several missions are active (common — passenger stacking) |

#### 3.4.4 Interaction
- **Draggable**, position persisted.
- **Click-through** toggle (ignore cursor) so the HUD never steals clicks from the game.
- **Keyboard shortcuts** (global, via Tauri global-shortcut):
  - `Ctrl+M` toggle HUD · `Ctrl+Shift+H` "what should I do?" · `Ctrl+Shift+V` toggle voice ·
    `Ctrl+Tab` cycle active mission · `Esc` collapse · `Enter` send chat.
- **Resizing**: min 320×480.

### 3.5 Mission Assistance Features

#### 3.5.1 AI-powered analysis
| Feature | Description |
|---------|-------------|
| Route context | Combine `NavRoute.json` (plotted route) + optional EDSM coords to estimate jumps/distance |
| Threat assessment | Flag likely danger (anarchy systems, wanted passengers, war zones) from mission + BGS-state modifier |
| Cargo/space check | Compare mission `Count`/`PassengerCount` against `Cargo.json`/ship state |
| Faction/BGS context | Explain influence/reputation effects from the parsed BGS state |
| Redirect awareness | Tell the player the hand-in changes after a kill (from redirect events) |
| Economic advice | Suggest markets from `Market.json` for trade/mining |

#### 3.5.2 Manual query interface
Natural-language questions ("fastest route?", "net profit after fuel?", "prerequisites?",
"threats along the route?"), answered with current mission + file context injected.

#### 3.5.3 Mission history & tracking
- Log accepted/completed/failed/abandoned missions from the journal.
- Credits earned per category; completion rate; expiry-loss rate.
- Filter by category, faction, BGS state, or date.

---

## 4. Technical Requirements

### 4.1 System requirements
| Requirement | Minimum | Recommended |
|-------------|---------|-------------|
| OS | Windows 10 (64-bit) | Windows 11 |
| WebView2 runtime | Installed (ships with Win 11; auto-provisioned by Tauri) | Latest |
| RAM | 4 GB | 8 GB |
| Storage | 200 MB | 500 MB |
| Network | Localhost only (LM Studio). Optional outbound for EDSM/Spansh if enabled. | — |
| LM Studio | Running, API enabled, a model loaded | 7B+ instruct model |
| Elite Dangerous | Installed and run at least once (so the journal directory exists) | — |

### 4.2 LM Studio configuration
1. Start the local server (`http://127.0.0.1:1234`).
2. Load a chat model.
3. App reads the model id from `/v1/models`.

### 4.3 Journal availability
No configuration needed if ED uses the default Saved Games path. The app auto-detects it; a settings
field allows overriding for relocated Saved Games folders or Steam/Epic edge cases. The game must
have been run at least once for the directory and journals to exist.

### 4.4 Security & privacy
| Concern | Mitigation |
|---------|-----------|
| LLM is local | All reasoning stays on-device via LM Studio |
| Journal is local | Read-only file access; the app never writes to the game directory |
| **TTS cloud leak** | **Online (Natural) voices send text to Microsoft.** Default to **local voices only**; clearly label cloud voices; offer a local TTS sidecar (see §3.3.4) |
| Optional network calls | EDSM/Spansh/cAPI are **opt-in**, off by default, and only send the minimum (system names/coords) |
| No telemetry | Zero analytics; no cloud sync |
| Data at rest | Stored under the app data dir (§4.5) |

### 4.5 Data storage
```
%APPDATA%\mission-operator\            (Tauri app-data dir)
├── config.json          # settings, voice prefs, HUD geometry
├── state\
│   ├── active.json       # last computed active missions (cache/restore)
│   └── history.json      # completed / failed / abandoned log
└── cache\
    └── last_analysis.json
```
The app **reads** the game journal from Saved Games but **never writes** there.

---

## 5. UI/UX Design

### 5.1 Visual design
| Element | Style |
|---------|-------|
| Theme | Dark, ED cockpit aesthetic |
| Colors | Navy `#0a1628` bg, amber `#f0a030` accent, cyan `#40d0f0` highlight |
| Typography | `Inter` body, `JetBrains Mono` for coordinates/credits/timers |
| HUD style | Semi-transparent panel, subtle border glow |
| Font scaling | 80 %–150 % |

### 5.2 HUD color coding by category
| Category | Accent |
|----------|--------|
| Courier / Delivery | Amber `#f0a030` |
| Massacre / Assassinate | Red `#e03030` |
| Salvage / Collect | Cyan `#40d0f0` |
| Rescue | Green `#40e060` |
| Mining | Orange `#f08030` |
| PassengerVIP / Sightseeing | Purple `#a060f0` |
| PassengerBulk | Blue `#4080f0` |
| Other | Gray `#808090` |

### 5.3 Accessibility
High-contrast toggle · large-text mode (≥150 %) · independent voice volume · keyboard-only nav ·
screen-reader labels on all interactive elements.

---

## 6. Integration Details

### 6.1 LM Studio API

**Health / model list**
```
GET http://127.0.0.1:1234/v1/models
→ { "object":"list", "data":[ { "id":"<loaded-model>", "object":"model", "owned_by":"user" } ] }
```

**Chat completion** — see §3.2.3.

**Error handling**
| Error | Action |
|-------|--------|
| `ECONNREFUSED` | "LM Studio not running" banner; reconnect loop |
| `404` / `500` | "No model loaded"; prompt to load one |
| `timeout` | Retry once with extended timeout, then error |
| Bad JSON | Log; retry with a simplified prompt |

### 6.2 Journal ingestion (the real "mission API")

- **Directory:** `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\` (overridable).
- **Watch:** newest `Journal.*.log` (append tail) + `Missions.json`, `Status.json`, `Cargo.json`,
  `NavRoute.json` (rewrite).
- **Events:** see §3.1.3. **Snapshot files:** see §3.1.1.
- **Reference:** Frontier's official *Journal Manual* documents every event and field.

### 6.3 Optional enrichment APIs (opt-in, network)
- **EDSM** `https://www.edsm.net/api-v1/system?systemName=…&showCoordinates=1` → coordinates for
  jump-distance estimates. (Does **not** provide missions.)
- **Spansh** route-plotting API for long hauls / neutron routes.
- **cAPI / Frontier Auth** OAuth for profile/market (later; not for missions).

---

## 7. Configuration

```json
{
  "lm_studio": {
    "endpoint": "http://127.0.0.1:1234",
    "model": null,
    "temperature": 0.3,
    "max_tokens": 1024,
    "timeout_ms": 30000,
    "api_key": null
  },
  "voice": {
    "enabled": true,
    "selected_voice": null,
    "local_voices_only": true,
    "rate": 1.0,
    "pitch": 0,
    "volume": 80,
    "auto_pause_on_focus_loss": true
  },
  "hud": {
    "always_on_top": true,
    "click_through": false,
    "position": { "x": 1200, "y": 100 },
    "size": { "width": 420, "height": 680 },
    "opacity": 0.95,
    "font_scale": 1.0,
    "theme": "dark",
    "color_code_missions": true
  },
  "journal": {
    "directory": null,
    "auto_detect": true,
    "bootstrap_previous_sessions": 1,
    "expiry_warning_min": 30
  },
  "enrichment": {
    "edsm_enabled": false,
    "spansh_enabled": false
  },
  "shortcuts": {
    "toggle_hud": "Ctrl+M",
    "ask_ai": "Ctrl+Shift+H",
    "toggle_voice": "Ctrl+Shift+V",
    "cycle_mission": "Ctrl+Tab",
    "collapse_hud": "Escape"
  }
}
```
> `journal.directory: null` + `auto_detect: true` ⇒ use the default Saved Games path.
> `voice.model`/`lm_studio.model: null` ⇒ auto-pick the first loaded LM Studio model.

---

## 8. Development Roadmap

### Phase 1 — Foundation & journal ingestion (MVP, ~4 weeks)
- [ ] Tauri 2 scaffold (React + TS + Vite + Tailwind), always-on-top HUD window.
- [ ] Rust Journal Watcher: locate dir, select newest journal, tail appended lines, watch snapshots.
- [ ] Event fold → normalized `Mission` model (accept/redirect/complete/fail/abandon + CargoDepot).
- [ ] Mission type detection from `Name`; step synthesis per category.
- [ ] Basic HUD: active-mission list, card, synthesized steps, live expiry timers.
- [ ] Manual JSON import (paste events) for testing on machines without the game.

### Phase 2 — AI operator (~3 weeks)
- [ ] LM Studio client (health, `/v1/models`, chat, SSE streaming, reconnect/offline).
- [ ] Category prompt templates; inject normalized mission + file context.
- [ ] "What should I do?" flow + free-form chat.

### Phase 3 — Voice & polish (~3 weeks)
- [ ] TTS with voice enumeration, local/cloud labeling, `local_voices_only` default, queue, de-dupe.
- [ ] Event-driven voice prompts (accept/redirect/expiry).
- [ ] HUD collapse/expand, multi-mission cycling, click-through, color coding, font scaling.
- [ ] Keyboard shortcuts (global).

### Phase 4 — Enrichment, history & release (~4 weeks)
- [ ] Optional EDSM/Spansh enrichment (jump-distance, route plotting), opt-in.
- [ ] Mission history & stats (credits/category, completion & expiry rates).
- [ ] Local TTS sidecar fallback.
- [ ] Accessibility pass; settings UI; `.msi` installer; user guide.

---

## 9. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Journal dir not found / game never run | No mission data | Auto-detect + settings override; clear "run the game once" guidance; manual import |
| Missing full detail (`Missions.json` alone is sparse) | Incomplete cards | Bootstrap by replaying the journal; reconcile IDs/expiry with `Missions.json` |
| Snapshot partial-read (mid-rewrite) | Parse errors | Read-retry with backoff; keep last-good state |
| No native "steps" from the game | Objective list is inferred | Derive from event flow; label as guidance; always show raw destination/target |
| Massacre/kill progress not in mission object | Wrong "X/Y killed" | Infer from `Bounty`/`FactionKillBond`; fall back to "in progress until redirected" |
| LM Studio not running | No AI | Mission tracking still works from files; "AI unavailable" banner; reconnect |
| **Cloud TTS leak** | Privacy violation | Default local-only voices; label cloud voices; local sidecar fallback |
| ED journal format changes | Parser breaks | Versioned parser; unknown events ignored; raw event retained; graceful degrade to snapshot+manual |
| Model quality varies | Poor advice | Disclaimer; user selects the LM Studio model |

---

## 10. Appendix

### A. Real mission taxonomy (observed in-game)

Internal `Name` families seen in live journals (case-insensitive; `Mission_`/`MISSION_` prefix),
grouped into normalized categories. Modifiers after the family denote the BGS state
(`_Expansion`, `_War`, `_CivilWar`, `_Boom`, `_Election`, `_Bust`, `_Outbreak`, `_Conflict`,
`_Democracy`) and passenger flavor.

| Normalized category | Example internal names | Notes |
|---------------------|------------------------|-------|
| **Courier** | `Mission_Courier`, `Mission_Courier_Expansion`, `Mission_Courier_Democracy`, `Mission_Courier_Service` | Data/small-package delivery; `TargetFaction` set |
| **Delivery** | `Mission_Delivery`, `Mission_Delivery_Agriculture`, `Mission_Delivery_Cooperative`, `Mission_Delivery_Democracy` | Commodity + `Count`; uses `CargoDepot` |
| **DeliveryWing** | `Mission_DeliveryWing_Outbreak` | Multi-part wing delivery; `CargoDepot` `WingUpdate` |
| **PassengerBulk** | `Mission_PassengerBulk`, `…_SECURITY_ARRIVING`, `…_REFUGEE_LEAVING`, `…_MEDICAL_ARRIVING`, `…_BUSINESS_ARRIVING`, `…_AIDWORKER_ARRIVING`, `…_POLITICIAN_ARRIVING`, `…_PRISONEROFWAR_LEAVING` | `PassengerCount`, `PassengerType`; `PassengerMission:true` |
| **PassengerVIP** | `Mission_PassengerVIP`, `…_CEO_EXPANSION`, `…_Explorer_EXPANSION`, `…_Tourist_ELECTION`, `…_General_WAR`, `…_Celebrity_ELECTION`, `…_HeadofState_BUST` | VIP cabins; may be `PassengerWanted` |
| **Sightseeing** | `Mission_Sightseeing`, `Mission_Sightseeing_Tourist_BOOM` | Beacon hops via `MissionRedirected` |
| **LongDistanceExpedition** | `Mission_LongDistanceExpedition_Explorer_Boom` | Very long range; high reward |
| **Massacre** | `Mission_Massacre`, `Mission_Massacre_Conflict_CivilWar` | Kill N of a faction; progress via `Bounty`/`FactionKillBond` |
| **Assassinate** | `Mission_Assassinate`, `Mission_Assassinate_Legal_War`, `Mission_Assassinate_Legal_Corporate`, `Mission_Assassinate_RankFed` | Named `Target` + `TargetType`; redirect-to-handin |
| **Salvage** | `Mission_Salvage`, `MISSION_Salvage_Illegal`, `MISSION_Salvage_Expansion`, `MISSION_Salvage_Refinery` | Recover cargo; note upper/lower-case prefix |
| **Collect** | `Mission_Collect`, `Mission_Collect_Bust` | Source + deliver commodity |
| **Mining** | `Mission_Mining`, `Mission_Mining_Expansion` | Ore type + quantity |
| **Rescue** | `Mission_Rescue_Planet` | Rescue survivors |

### B. Journal events consumed (with key fields)

| Event | Key fields |
|-------|-----------|
| `Missions` | `Active[] {MissionID,Name,PassengerMission,Expires}`, `Failed[]`, `Complete[]` |
| `MissionAccepted` | `MissionID, Name, LocalisedName, Faction, DestinationSystem, DestinationStation, Expiry, Reward, Influence, Reputation, Wing` + `Commodity/Commodity_Localised/Count` (delivery), `Target/TargetType/TargetFaction` (kill), `PassengerCount/PassengerType/PassengerVIPs/PassengerWanted` (passenger) |
| `MissionRedirected` | `MissionID, NewDestinationSystem, NewDestinationStation, OldDestinationSystem, OldDestinationStation` |
| `CargoDepot` | `MissionID, UpdateType, CargoType(_Localised), Count, ItemsCollected, ItemsDelivered, TotalItemsToDeliver, Progress` |
| `MissionCompleted` | `MissionID, Faction, Reward, MaterialsReward[], FactionEffects[]` |
| `MissionFailed` / `MissionAbandoned` | `MissionID, Name, LocalisedName` |
| `FSDJump` / `Location` / `CarrierJump` | `StarSystem, StarPos` |
| `Docked` / `Undocked` | `StationName, StarSystem, MarketID` |
| `Bounty` / `FactionKillBond` | `Target, VictimFaction, Rewards[]/Faction` (kill-mission progress) |

Companion snapshot files: `Missions.json`, `Status.json`, `Cargo.json`, `NavRoute.json`,
`Market.json`, `ShipLocker.json`, `Backpack.json`, `Outfitting.json`, `Shipyard.json`,
`ModulesInfo.json`, `FCMaterials.json`.

### C. TTS voices (Windows / WebView2)
`speechSynthesis.getVoices()` returns, on Windows WebView2: Edge **"… Online (Natural)"** voices
(**cloud** — see §3.3.4) and **local** SAPI/offline voices. Examples: *Microsoft Aria/Guy/Zira
Online (Natural)* (en-US), *Hazel/George/Libby Online (Natural)* (en-GB), *Selma/Harri* (fi-FI),
plus installed local voices. The app labels each as local vs cloud and defaults to local-only.

### D. Glossary
| Term | Definition |
|------|-----------|
| **Player Journal** | ED's append-only JSON-lines event log written to Saved Games |
| **Snapshot files** | `Missions.json`/`Status.json`/etc., rewritten wholesale on change |
| **MissionRedirected** | Journal event that changes a mission's destination (e.g. redirect to hand in) |
| **CargoDepot** | Journal event reporting delivery/collect/wing cargo progress |
| **BGS** | Background Simulation — faction states (war, boom, election, …) encoded in mission names |
| **cAPI** | Frontier Companion API (profile/market/shipyard; **not** missions) |
| **EDSM** | Elite Dangerous Star Map — community system/flight-log database (**not** your missions) |
| **WebView2** | Windows Edge-Chromium web runtime that hosts the Tauri frontend |
| **TTS / HUD / SSE** | Text-to-Speech / Heads-Up Display / Server-Sent Events |
| **Tauri** | Rust-backend + web-frontend desktop app framework |
