# Elite Dangerous — Mission Operator

**Home page & downloads: [edmo.blinkki.com](https://edmo.blinkki.com)**

An **always-on-top HUD** companion for Elite Dangerous. It reads your **active missions** live from
the Player Journal, shows them as cards with synthesized objective checklists and countdown timers,
gives **AI operator guidance** via a local LLM (its own bundled llama.cpp engine, or LM Studio if you
prefer), speaks with a **bundled local neural
voice** (Piper), and runs a **proactive heartbeat** that nudges you when you stall.

Alongside the mission cards there are five tabs for the panels the game keeps somewhere you cannot
read while flying: a **route plotter** (neutron highway for the ship, the whole carrier trip jump by
jump, tritium counted), an **orrery** showing where this system's bodies are right now, the **World
of Death** landing-window clock, a **system architect** shopping list for colonisation builds, and a
**local wire** that writes fictional news about the system you are actually in.

Everything runs on your machine. No cloud, no telemetry, no account.

<p align="center">
  <img src="site/img/hud-missions.png" width="300" alt="The HUD showing four active missions restored from the journal, with an assassination card, its synthesized objectives and a live countdown">
  &nbsp;
  <img src="site/img/hud-architect.png" width="282" alt="The system architect tab: 6,703 tons wanted across seventeen commodities, grouped under 'In HIP 71120 — no jump', with a line expanded to show five sellers, their prices and how old each report is">
</p>
<p align="center">
  <sub><b>Mission cards</b> — objectives the game never shows &nbsp;·&nbsp;
  <b>System architect</b> — 6,703 t of build, sorted into a shopping run</sub>
</p>

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

Download it from **[edmo.blinkki.com](https://edmo.blinkki.com)** — or build it yourself with
`npm run tauri build` (output in `src-tauri/target/release/bundle/nsis/`). Double-click, done. It installs per-user (no admin),
including the offline voice, and starts the HUD. Optional extras:

1. **AI engine** — either let the app install its own (Settings → AI engine → *This app*: it fetches a
   llama.cpp runtime + a Gemma GGUF with vision, ~4–6 GB one time, resumable), **or** use
   **LM Studio**: start the local server at `http://127.0.0.1:1234` and load any
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
- The **local wire** can be read by a *different* voice (Settings → Local wire → newsreader voice),
  so a bulletin does not sound like the operator talking about the news. The voice travels with
  each queued utterance, not with the settings, so an operator line and a bulletin can be queued
  together without borrowing each other's voice.

## The local wire — fictional news for the system you are in

Galnet reports the galaxy; nothing reports the system you are standing in. The 📰 tab writes it,
using your own local model, from a brief of things the journal says are **true right now**: the
faction board with real influence figures, the stations and signals, the markets you have read, the
construction sites, and the doors that have refused you docking.

<p align="center">
  <img src="site/img/hud-news.png" width="520" alt="The local wire for HIP 71120: three stories tagged Civic, Industry and Economy, reporting real faction influence figures, extraction activity and commodity prices read from the journal">
</p>
<p align="center">
  <sub>Every figure here came out of the journal — the model chose among them and wrote them up.</sub>
</p>

- **Six desks take turns** — civic, industry, economy, crime, sport, life — so it reads as a paper
  rather than an almanac. A desk only opens when the brief can support it.
- **The economy desk is a real market report.** A price with nothing to compare it against is a
  listing, so the wire keeps its own price memory: what a commodity did since you last read that
  board, the spread between two stations, and who is paying over the odds.
- **It may invent people, teams and bars; it may not invent a faction, a station or a price.**
  Anything it makes up is checked against the brief, and a new name shaped like a real place is
  dropped unprinted.
- **It remembers what it invented.** The dock-crew league keeps the same two teams from one edition
  to the next; the cast is persisted and offered back to the model as continuity.
- **House style** is switchable: *wry* (a veteran correspondent who has read every announcement
  these people ever issued and believed none of them) or *straight* reporting.

Off by default — it costs one model call per edition. Cadence runs from every 10 minutes to hourly,
or Off with a **New edition** button in the tab.

## The orrery — where everything is, right now

Every `Scan` since game v4.0 U14 carries the body's whole Keplerian element set — semi-major axis,
eccentricity, inclination, argument of periapsis, ascending node, mean anomaly and period, with the
scan timestamp as the epoch. That is enough to place the body at any instant, so the 🪐 tab is a
closed form rather than a simulation: warping time evaluates the same equations at a different `t`,
and nothing drifts because nothing integrates.

- **Top-down, deliberately.** Three dimensions in a 420 px panel buys a camera angle to fiddle with
  and loses the thing the panel is for. Inclination is applied and then projected, so a steeply
  inclined moon draws where it really is from above.
- **Distances are compressed per level**, which is what keeps a moon visible around a planet 400 ls
  from its star. Order is preserved, spacing is not — and the card says which mode it is in, always.
  A **true distances** toggle shows the real thing, with the inner system collapsed onto the star,
  because that is where it is.
- **Overlaps are separated, because separation is the point.** A map answers "what is here, and
  what is near what"; two moons drawn as one dot answer neither. Bodies that would collide are
  relaxed apart, deterministically (no jitter between frames) and within a hard displacement
  budget, so each stays recognisably on its own orbit ring — and the selected body draws a leader
  back to its true position rather than letting the ring quietly disagree with the dot. Measured on
  a real 36-body system: **21 overlapping pairs before, none after, mean displacement 2.7 px.**
  It does not run in true-distance mode; that mode exists to be believed.
- **Every body is named**, not just the stars — you cannot look up "the green one". Each name is
  offered four berths around its body and takes the first that clashes with neither another name
  nor any body; one with nowhere to go is skipped rather than stacked. That skip is what makes
  zooming worth doing: berths open as bodies spread, so the names fill in as you go (24 of 36 at
  full-system view, 35 zoomed in, and none overlapping at either).
- **Lit from their own star.** Each body is shaded with the terminator facing the star that
  actually lights it — nearest star, which matters in a binary — so the day side on screen is the
  day side in the game. That direction comes from the same elements as the positions, making it
  the one part of a drawn planet that is derived rather than invented. Measured: lit limb within
  **1.4°** of the true bearing.
- **Surfaces are generated, not downloaded.** Elite ships no texture maps and this app ships no
  asset files, so planets are painted from the one thing the journal does state — their class.
  Icy reads as ice, gas giants get bands, metal-rich goes ochre. It is `feTurbulence` (Perlin
  noise the browser composites on the GPU) baked into one `<pattern>` per class, so the cost is
  fixed no matter how many bodies a system has, and it only switches on past 2.2× zoom where
  there is a surface big enough to see. The grain is invention and is kept generic on purpose;
  nothing claims to be a photograph of that particular world.
- **Landable worlds keep their green**, now as a rim rather than a fill, so painting bodies by
  class did not cost the one fact on the map you can act on.
- **Follow keeps the camera on your ship.** A toggle glues the centre of the map to the marker —
  parked chevron or in-flight band — so a zoomed-in view tracks the whole leg instead of watching
  the one thing you care about slide out of frame. Grabbing the map disengages it, because a drag
  is the statement that you want to look somewhere else; double-click (frame the system) lets go
  too.
- **Scroll to zoom, drag to pan**, double-click to reframe. Zoom is anchored on the pointer, and
  bodies grow sub-linearly with it (`^0.55`) — visible enough to have a surface, never so large
  that two planets fill the panel.
- **The ship is drawn parked, not just in flight.** Docked or dropped somewhere, a filled cyan
  chevron marks the exact dock — filled because an arrival is a fact the journal stated, where the
  in-flight marker is hollow because it is an estimate. Flying toward somewhere the map cannot
  place yet (a station never visited), the card says so instead of going silent. The history
  sweep also collects every dock ever visited — `Docked`, `ApproachSettlement`, station
  `Location`/`SupercruiseExit` lines — so stations from old sessions are on the map at boot,
  and it folds them through a state-free path so replaying last year's arrivals cannot teleport
  the live ship.
- **Docks are on the map too.** Stations, outposts, settlements and construction depots, as small
  amber marks beside the body they belong to. They are not bodies and never receive a `Scan`, so
  they have no orbit to place them by — a surface port states its world outright
  (`ApproachSettlement` gives the `BodyID` and even a latitude), while an orbital one is matched to
  the body it orbits by distance from the arrival star, which both measure: Anders City reports
  970.04 ls and its world 970.0. Anything that cannot be matched within a few light-seconds is left
  undrawn rather than parked beside the wrong planet, and **fleet carriers are excluded outright**
  — they jump, and this table is persisted.
- **Your ship, as honestly as it can be drawn.** Elite reports no in-system position — Status.json
  carries flags, fuel, cargo and the nav target, and nothing else — so a moving dot would be the
  only invented number on the map. Instead the leg you are flying is drawn from where you dropped
  to supercruise toward whatever you have targeted (read live, so retargeting follows), and your
  progress along it is shown as **a band, not a point**: somewhere between the fastest and slowest
  legs actually recorded in your own journals. Measured across those journals, distance barely
  predicts duration at all — 0.2 ls took 8 s, 0.8 ls took 134 s, and the same 4,697 ls run took
  137 s, 162 s and 304 s on different days, giving a best-fit curve a mean error of 112%. So the
  band is wide because the truth is wide, it slides as you fly, and it is replaced by fact the
  moment you arrive.
- **Tap a body for its card.** Distances, orbital period, eccentricity, surface temperature,
  atmosphere, volcanism, tidal lock — and **gravity in G**, amber past 2 and red past 3, because
  that is the number that writes off ships rather than trivia. Landable bodies list their
  **surface materials richest first, each annotated with how many you already carry**, since the
  materials tracker has been folding your grid all along. Rarity does the shouting, not the
  percentage: iron at 21% stays grey while you hold 300 of it; *tellurium at 1% with none held* is
  the line worth flying for. First footfall is called out where nobody has walked yet.
- **Only what you scanned — but everything you ever scanned.** No EDSM, no backfill, no bodies
  placed "approximately" at periapsis. The honk carries no orbits (`FSSDiscoveryScan` reports how
  many bodies exist and lists signal sources; the elements only ever ride on a `Scan`), and the
  session bootstrap replays one journal or two. So arriving in a system re-reads the **whole
  journal history on disk** for that system's address — 126 scans across 510 files in under a
  second, in one real case — and the map is complete before you touch the FSS. Elements are
  constants: a body scanned in 2025 is in the same orbit today, and Kepler propagates from any
  epoch, so old scans are as good as new ones.

Elite's parent chains do not mean what they look like, and the tab handles all of it: belt clusters
whose parent is a `Ring` that never gets scanned, `BodyID:0` as a real star with no `Parents` at all,
barycentres that only exist because some moon three levels down mentioned them, and bodies scanned
before their parents. The traps and the additive parent-chain simplification are documented in
CMDR TerjeRu's MIT-licensed [Orrery](https://github.com/TerjeRu/orrery) — credit where it is due;
the implementation here is this codebase's own.

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

<p align="center">
  <img src="site/img/hud-memory.png" width="300" alt="The operator answering 'What do you remember about me?' from its long-term memory, then distilling the session into new memories">
  &nbsp;
  <img src="site/img/hud-operator.png" width="300" alt="The operator feed showing proactive heartbeat nudges about hunting grounds alongside a streaming AI answer">
</p>
<p align="center">
  <sub><b>The memory</b> — ask it what it remembers about you &nbsp;·&nbsp;
  <b>Operator feed</b> — a heartbeat nudge and a live answer</sub>
</p>

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
src/engine/          TypeScript mission intelligence (zero deps, Node 22.6+, 495 tests)
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
  architect.ts         Colonisation shopping list — depot requirement folded
                       into an ordered plan (hold / here / this system / galaxy)
  news.ts              Local wire — grounded brief, six desks, price memory,
                       persistent invented cast, fabrication guard
  plotter.ts           Neutron + fleet-carrier route plotting and tritium maths
  orrery.ts            System map — Keplerian elements folded from Scans,
                       parent-chain summation, per-level distance compression
  deathclock.ts        World of Death landing windows from any past scan
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
- **Inference is always local.** With the bundled engine, chat traffic goes to `127.0.0.1` on a
  random loopback port, behind a per-session API key; with LM Studio it is `127.0.0.1:1234` (X.2).
- **Downloads are pinned, and models are explicit.** The inference runtime (llama.cpp releases) and
  the model (an ungated GGUF mirror) come only from URLs pinned in one manifest
  (`src-tauri/src/engine.rs`). The multi-GB model is fetched only on a click, never automatically.
  The one exception is the ~32 MB runtime archive: when the app ships against a newer pinned
  llama.cpp build than the one on disk, it refreshes it at startup and says so in the feed — the
  build marker was previously written and never read, so an install kept its first runtime forever
  and silently missed every upstream fix. Turn it off with **Settings → AI engine → auto-update
  runtime** to keep the strict nothing-unasked behaviour.
- TTS is local by default (bundled Piper); cloud voices require an explicit opt-in and are labelled.
- No telemetry, no analytics, no cloud sync.

## Status

See [TASKS.md](TASKS.md) for the milestone ledger and [SPEC.md](SPEC.md) for the full specification.
Remaining (v1.1 candidates): EDSM/Spansh enrichment (opt-in), mission history & stats panel,
accessibility pass, kill-count inference display.
