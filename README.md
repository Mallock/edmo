# Elite Dangerous — Mission Operator

An **always-on-top HUD** companion for Elite Dangerous. It reads your **active missions** live from
the Player Journal, shows them as cards with synthesized objective checklists and countdown timers,
gives **AI operator guidance** via a local LLM (LM Studio), speaks with a **bundled local neural
voice** (Piper), and runs a **proactive heartbeat** that nudges you when you stall.

Everything runs on your machine. No cloud, no telemetry, no account.

```
┌────────────────────────────────────┐
│  ⬢ MISSION OPERATOR        ⚙ ▁ ✕  │   ← draggable, always on top
├────────────────────────────────────┤
│  ASSASSINATE · EG Union            │
│  Assassinate Known Pirate: LazerFX │
│  → Hyperion Monolith 001 · Aoesta  │
│  1,564,280 cr        ⏱ 9h 12m     │
│  [✓] Travel to target system       │
│  [✓] Eliminate LazerFX             │
│  [ ] Return & hand in              │
├────────────────────────────────────┤
│  21:14  💡 You've been in Bingui   │
│         8 min without engaging …   │
│  21:22  🎯 Target eliminated.      │
│         Return to Malchiodi City…  │
├────────────────────────────────────┤
│  [ Ask the operator…          ] ➤🔊│
│  3 missions · JRNL● LM● PIPER●     │
└────────────────────────────────────┘
```

## Install & run (one click)

Grab **`ED Mission Operator_0.1.0_x64-setup.exe`** (built via `npm run tauri build`, output in
`src-tauri/target/release/bundle/nsis/`), double-click it, done. It installs per-user (no admin),
including the offline voice, and starts the HUD. Optional extras:

1. **LM Studio** (for AI guidance): start the local server at `http://127.0.0.1:1234` and load any
   chat model. The HUD auto-detects it — the `LM` pill goes green. Not sure which model your rig
   can handle? Open **Settings → AI operator**: the app reads your **RAM, CPU and GPU VRAM** and
   annotates every model in the selector (`✓ fits GPU` / `◐ CPU only (slow)` / `⚠ TOO BIG`), with a
   concrete "aim for ≤ N B parameters" recommendation. If the active model looks too big, the
   footer shows `LM⚠` and Settings explains why.
2. **Elite Dangerous**: just play. The HUD auto-finds
   `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\` and follows the newest
   journal. Run ED in **Borderless/Windowed** mode so the overlay can sit on top.

Without the game running you can still try it: **Settings → Manual import**, paste journal lines.

## The voice — local TTS model, fully offline

The app bundles **[Piper](https://github.com/rhasspy/piper)** with the **en_GB "Alba" medium**
neural voice (~63 MB ONNX model). Synthesis runs ~7× faster than realtime on CPU, entirely offline —
mission text never leaves your machine (unlike Windows "Natural" voices, which are cloud-backed).

- Default engine: **Piper** (private, no network).
- Fallback/alternative: Windows system voices, with **local-voices-only on by default** — cloud
  voices are filtered out and clearly labelled `(CLOUD)` if you opt in.
- Spoken events: mission accepted, redirect, arrival at hand-in, completion/failure, expiry
  warnings, and heartbeat nudges. A queue with de-duplication guarantees nothing is spoken twice.

## The heartbeat (proactive assist)

| Rule | Fires when |
|------|-----------|
| `idle-docked` | Docked > 5 min with hand-ins waiting elsewhere |
| `idle-space` | Drifting with no jumps > 6 min (not on final approach) |
| `stuck-hunting` | In a kill-mission's target system > 8 min without engaging |
| `expiry` | A mission is close to expiring — warns, then escalates to urgent |

Nudges have cooldowns (no spam), escalate in severity, and are spoken. They only run while the game
is actually live (journal/status activity in the last 90 s).

## The memory bank (long-term)

The operator **remembers you across sessions** in a local `memory.json` (app-data dir):

- **Ledgers, folded straight from the journal** — per-faction contract history, per-system visit
  counts and deaths, personal records (richest mission, biggest bounty, best session, longest
  jump), ranks. Replay-safe: a timestamp watermark means bootstrap re-reads never double-count,
  and the very first run inherits your recent history from the replayed sessions.
- **Distilled memories** — at session end the local model condenses the day into a few durable
  one-line memories (close calls, firsts, relationship shifts) through a schema-constrained JSON
  call, de-duplicated and anchored to systems/factions.
- **Recall** — the relevant slice (your history with this faction, what happened in this system)
  rides into every AI prompt, so "what should I do?" knows who you are.
- **Proactive remarks** — returning to a system where you lost a ship, breaking a record, hitting
  a faction milestone. The *decision* to speak is deterministic code (per-key 24 h gates, a global
  cooldown, combat silence — at most one remark per event burst), so it structurally cannot flood.

**Screen glances (opt-in, off by default):** every few minutes the operator captures a downscaled
screenshot and asks the local vision model what you're doing. The sighting feeds story/advice
context; it speaks **only** when the model flags something genuinely notable *and* a 10-minute
cooldown + dedupe gate agrees. The screenshot goes only to your LM endpoint and is never saved.
All loaded LM Studio models on the dev rig (gemma-4, qwen3.6) report vision capability; the
Settings panel warns when the active model doesn't.

## Talking to the operator

- **Dialogue memory** — the operator keeps the recent conversation thread: your questions, its
  answers, *and its own remarks* (stories, warnings, memory call-outs). Follow-ups like *"and how
  far is that?"* or *"what did you mean?"* resolve against what was actually said. Threads go
  stale after 15 minutes of silence; long stories are recalled as a gist.
- **Voice input (opt-in)** — hold `Ctrl+Shift+Space` (works while the game has focus) or the 🎤
  button, speak, release. Recording is captured natively (cpal) and transcribed by a local
  **whisper.cpp** sidecar (base.en model, one-time ~150 MB download on your click — same pattern
  as the extra Piper voices). Pressing push-to-talk also silences the operator mid-sentence
  (barge-in), Jarvis-style. Your voice never leaves the machine; clips are transcribed from a
  temp file that is deleted immediately.

## Global shortcuts

| Keys | Action |
|------|--------|
| `Ctrl+Shift+M` | Show / hide the HUD |
| `Ctrl+Shift+H` | Ask the operator "What should I do right now?" |
| `Ctrl+Shift+V` | Toggle voice |
| `Ctrl+Shift+J` | Cycle active mission |
| `Ctrl+Shift+K` | Collapse / expand |
| `Ctrl+Shift+T` | Toggle click-through (HUD ignores the mouse) |
| `Ctrl+Shift+Space` *(hold)* | Push-to-talk — speak to the operator (needs Voice input enabled) |

In-window: `Esc` collapses, `Ctrl+Tab` cycles missions, `Enter` sends chat.
(The spec's `Ctrl+M`/`Ctrl+Tab` global bindings were deliberately shifted to `Ctrl+Shift+…` so the
HUD never steals everyday shortcuts from other apps.)

## Architecture

```
src/engine/          TypeScript mission intelligence (zero deps, Node 22.6+, 16 tests)
  types.ts             Normalized Mission model
  parse.ts             JSON-lines parsing (browser-safe)
  detectType.ts        Mission category + BGS state from internal Name
  steps.ts             Objective checklist synthesis (the game emits none)
  state.ts             MissionStateManager — event fold + Missions.json reconcile
  operator.ts          Rule-based guidance + LLM prompt builders per category
  heartbeat.ts         Proactive-assist monitor (4 rules, cooldown/escalation)
  memory.ts            CommanderMemory — persistent ledgers/records/notes,
                       replay-safe fold, recall, gated proactive remarks,
                       LLM session-reflection prompt + JSON folding
  glance.ts            Screen-glance prompts (vision) + reply parsing
  convo.ts             ConvoBuffer — short-term dialogue memory (follow-ups
                       work) + whisper transcript cleaning
  lmstudio.ts          LM Studio client (used by the Node replay CLI)
src/ui/              React HUD (Vite) — cards, steps, feed, chat, settings
  modelfit.ts          Machine-spec model advisor (params parsed from model ids,
                       Q4 memory estimate vs detected RAM/VRAM budgets)
src-tauri/           Rust shell:
  journal tail (poll @600ms, read-only), snapshot readers w/ mid-rewrite retry,
  LM Studio streaming proxy (SSE → events, avoids webview CORS),
  Piper TTS sidecar, global shortcuts, click-through, geometry persistence
scripts/replay.ts    Journal-replay CLI demo (works without the app)
```

The Rust layer only moves bytes; **all mission logic is the tested TS engine**, shared verbatim
between the HUD and the Node CLI.

## Development

```bash
npm install
npm test                  # engine test suite (node:test, real journal fixtures)
npm run replay -- --fixture   # replay a real session in the terminal
npm run fetch:tts         # downloads Piper + Alba voice into src-tauri/resources/tts
npm run tauri dev         # HUD with hot reload
npm run tauri build       # produces the NSIS single-file installer
```

Rust toolchain (MSVC) required for the app shell; the engine alone needs only Node 22.6+.

### Linux

The app builds and runs on Linux (X11 recommended). ED's journals live inside the Steam Proton
prefix — auto-detected at
`~/.local/share/Steam/steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/…`
(plus `.steam`, Flatpak and Snap layouts); override in Settings if yours differs.

```bash
sudo apt install build-essential curl pkg-config libssl-dev libgtk-3-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf libasound2-dev
bash scripts/fetch-tts.sh   # Linux Piper + voices into src-tauri/resources/tts-linux
npm install
npm run tauri build         # produces .deb + .AppImage (tauri.linux.conf.json)
```

Platform notes: voice input uses the whisper.cpp Ubuntu build (same one-click download);
global shortcuts (incl. push-to-talk key) need X11 — on Wayland use the HUD's buttons and the
🎤 hold-button; screen glances are Windows-only for now.

## Privacy invariants

- The ED journal directory is opened **read-only**; the app never writes there (X.3).
- With the default settings the only network traffic is `127.0.0.1:1234` (LM Studio) (X.2).
- TTS is local by default (bundled Piper); cloud voices require an explicit opt-in and are labelled.
- No telemetry, no analytics, no cloud sync.

## Status

See [TASKS.md](TASKS.md) for the milestone ledger and [SPEC.md](SPEC.md) for the full specification.
Remaining (v1.1 candidates): EDSM/Spansh enrichment (opt-in), mission history & stats panel,
accessibility pass, kill-count inference display.
