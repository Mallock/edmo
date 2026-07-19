# Elite Dangerous Mission Operator — Task Plan

**Companion to:** [SPEC.md](SPEC.md) v2.0
**Date:** 2026-07-19
**Approach:** Build the **journal ingestion foundation first** and validate it against the developer's
own real journals before layering on AI, voice, and polish. Each milestone is independently testable.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Each task lists an **acceptance check**.

> **Implementation status (2026-07-19, evening).** The app is **built end-to-end**: the zero-dependency
> **TypeScript engine** (16 `node:test` tests, validated on real journals) is now hosted in a
> **Tauri 2** shell — Rust journal tail + snapshot readers + LM Studio streaming proxy + **bundled
> local Piper TTS** (en_GB Alba neural voice, fully offline) — with a **React HUD** (cards, steps,
> operator feed, chat, settings) packaged as a **single NSIS setup exe**. Deviations from the
> original plan are noted inline on each task.

---

## M0 — Project scaffold & repo hygiene

- [x] **T0.1** Initialize Tauri 2 app: React + TypeScript + Vite. *(Deviation: hand-rolled HUD CSS
  instead of Tailwind — smaller, no framework needed at this size.)*
  - *Check:* `npm run tauri dev` opens a window; hot-reload works.
- [x] **T0.2** Configure the HUD window in `tauri.conf.json`: `alwaysOnTop`, `decorations:false`,
  `skipTaskbar`, `transparent`, default size 420×680.
  - *Check:* window floats over other apps, no OS chrome, no taskbar entry.
- [~] **T0.3** Workspace tooling: Vitest→`node:test` (already in place), `cargo check` clean.
  ESLint/Prettier/clippy config not yet committed.
- [x] **T0.4** Real journal fixtures under `fixtures/journal/` for deterministic parser tests.
  - *Check:* fixtures load in tests; no real CMDR PII beyond mission content.

**M0 done when:** app builds & runs as an always-on-top window. ✔

---

## M1 — Journal ingestion foundation (the core, do this first)

- [x] **T1.1** Rust: journal-directory locator. Default
  `%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\`; settings override
  (with `%USERPROFILE%` expansion); clear error when absent.
- [x] **T1.2** Rust: newest-journal selector — lexicographic `Journal.*.log` sort (name embeds the
  timestamp), re-targets within one poll (600 ms) when a newer session file appears.
- [x] **T1.3** Rust: JSON-lines tail reader. *(Deviation: 600 ms polling loop instead of the
  `notify` crate — fewer deps, equally robust, negligible CPU; behavior-equivalent.)* Tracks byte
  offset, reads only appended complete lines, tolerates a partial trailing line, resets on truncate.
- [x] **T1.4** Rust: snapshot readers for `Missions.json`, `Status.json`, `Cargo.json`,
  `NavRoute.json` — (len, mtime) change markers; JSON is validated before emit; a mid-rewrite
  partial read stays unmarked and retries next poll (keep last-good).
- [x] **T1.5** Normalized `Mission` / `MissionStep` / `Location` types shared: TS engine types are
  the single source of truth. *(Deviation: Rust ships raw journal lines; the tested TS engine does
  the folding in the webview — no duplicated model in Rust, no serde drift possible.)*
- [x] **T1.6** Event fold → mission state incl. `Missions.json` reconcile: live `Expires` refresh,
  placeholder missions for prior-session accepts, drop-if-unlisted (engine `state.ts reconcile()`).
- [x] **T1.7** Bootstrap on startup: previous `journal.bootstrap_previous_sessions` sessions + the
  current session replayed from the top, silently, then reconciled with `Missions.json`.
- [x] **T1.8** Normalized state to the frontend on every change (journal-lines / snapshot /
  watch-status / journal-ready events → engine fold → React store emit).

**M1 done when:** with ED running (or fixtures replayed), the backend produces an accurate live list
of active missions. ✔ (validated against the real journal folder)

---

## M2 — Mission typing, step synthesis & HUD display

- [x] **T2.1** Mission type detection (engine `detectType.ts`, unit-tested over the observed taxonomy).
- [x] **T2.2** Step synthesis per category (engine `steps.ts`, unit-tested incl. redirect flip).
- [x] **T2.3** HUD active-mission card: category badge + color (SPEC §5.2 palette), title,
  destination, reward, live countdown (1 s tick, warn/urgent coloring + blink).
- [x] **T2.4** Synthesized objective checklist under the card.
- [x] **T2.5** Multi-mission handling: color-coded tab strip + `Ctrl+Tab` in-window cycling +
  `Ctrl+Shift+J` global cycling.
- [x] **T2.6** Manual JSON import panel (Settings → Manual import) — works with no game and even in
  a plain browser (`npm run dev` without Tauri).
- [x] **T2.8** *(added after playtest round 3)* Kill accounting follows ED's real stacking rule:
  one kill per mission **giver** — same-giver massacres fill sequentially oldest-first, different
  givers in parallel; an assassination's `MissionRedirected` within 10 s of a `Bounty` retracts the
  massacre tick that bounty caused (the victim was the named target, not a generic pirate);
  a massacre redirect snaps progress to its full `KillCount`.
  - *Check:* 4 unit tests (`tests/killcount.test.ts`); live replay of the real 1×/2×/5× Tir stack
    matches the in-game panel exactly ("KILLS CONFIRMED 1/5" ↔ "1/5 est.").
- [x] **T2.7** *(added after playtest)* Mission detail parity with the in-game panel: parse
  `KillCount` + `TargetType_Localised`; massacre cards get a kill progress bar
  ("1/5 Pirates (est.) · Brian's Thugs") and the step reads "Eliminate 5 × Pirates … (1/5 est.)",
  done only at count/redirect — a single faction kill no longer ticks every stacked mission
  (Bounty counting is Massacre-only and capped; Assassinate completes via redirect). Cards also
  show INF/REP gain and the hand-in station (origin) for kill missions. Bootstrap now walks back
  up to 20 sessions until every active mission's `MissionAccepted` is replayed, so cards never
  degrade to placeholders after short sessions.

**M2 done when:** the HUD faithfully mirrors active missions with categories, colors, timers, steps. ✔

---

## M3 — LM Studio AI operator

- [x] **T3.1** LM Studio health: `GET /v1/models` on startup + every 20 s, auto-pick first
  non-embedding model, recovery on restart, status pill. *(Requests proxied through Rust/reqwest —
  avoids webview CORS entirely and keeps the X.2 network invariant auditable in one file.)*
- [x] **T3.7** *(added post-plan)* Machine-aware model advisor: Rust `system_specs` reads RAM
  (`GetPhysicallyInstalledSystemMemory`), CPU name and per-GPU dedicated VRAM (display-class
  registry `qwMemorySize` — accurate where WMI caps at 4 GB); `src/ui/modelfit.ts` parses parameter
  counts from model ids (dense `27b`, MoE `35b-a3b`, `8x7b`, Gemma `e2b`, `270m`), estimates Q4
  memory need, and classifies each model in the selector as fits-GPU / CPU-only / too-big, with a
  concrete "aim for ≤ N B" recommendation and an over-budget warning (Settings + footer `LM⚠`).
  Budgets are **game-aware**: while ED runs it reserves ~6 GB VRAM (renderer) and ~6 GB RAM on top
  of the OS reserve; fit labels judge the while-flying case, and the recommendation shows both
  numbers ("while flying ~12B / ED closed ~22B" on the dev rig).
  - *Check:* 7 unit tests over real LM Studio ids covering both game-running and game-closed
    budgets; live-verified on the dev rig (16 GB VRAM), 27B dense and 35B-A3B MoE marked CPU-only.
- [x] **T3.2** Chat completion with mission context injected from the normalized model
  (engine `operator.ts buildChat`).
- [x] **T3.3** SSE streaming; tokens append to the HUD feed live; cancel (■) works.
- [x] **T3.4** Category prompt templates (engine `systemPromptFor`) selected by `MissionCategory`.
- [x] **T3.5** Free-form chat input + `Ctrl+Shift+H` "what should I do?" global shortcut.
- [x] **T3.6** Error handling: unreachable/404/timeout → labelled fallback to deterministic
  rule-based advice; mission tracking never blocks on the LLM.

- [x] **T3.8** *(added post-plan)* **System intel for the AI**: `FSDJump`/`Location` system
  properties (security, allegiance, controlling faction, population) + `FSSSignalDiscovered`
  signals (Nav Beacon, RES with intensity, Combat zones, stations — fleet carriers counted
  separately so Colonia's carrier swarms don't drown real stations; USS filtered) folded into
  `OperatorState.system` and injected into every AI prompt. The stuck-hunting nudge names the
  *actual* detected RES/Nav Beacon instead of generic advice. `node scripts/intel.ts` prints the
  live picture for debugging.
  - *Check:* 4 unit tests; live-verified against the running game (Ratraii: Medium Security,
    Colonia Co-operative, Nav Beacon + 38 carriers folded correctly).

**M3 done when:** accurate, current, category-aware guidance with clean degradation. ✔

---

## M4 — Text-to-speech

- [x] **T4.1** Voice enumeration (`speechSynthesis` + `voiceschanged`); local vs cloud labelling
  (`(CLOUD)` suffix in the picker).
- [x] **T4.2** `local_voices_only` **default on**; rate/volume controls; refuses to speak rather
  than leak to a cloud voice when local-only finds no local voice.
- [x] **T4.3** Speech queue + de-dupe (3-minute window, queue serialized, never double-speaks).
- [x] **T4.4** Event-driven prompts: accept, redirect, arrival, expiry warning (via heartbeat),
  complete/fail, nudges; `Ctrl+Shift+V` global toggle.
- [x] **T4.5** Local TTS — **promoted from optional to the default engine**: bundled
  **Piper + en_GB Alba medium** neural voice (~63 MB ONNX), synthesized by a Rust sidecar,
  ~7× realtime on CPU, fully offline. System voices remain as fallback.

**M4 done when:** spoken guidance works, defaults to private local voices, never double-speaks. ✔

- [x] **T4.6** *(added post-plan)* **Operator chatter** — a separate fictional content generator
  (`src/engine/flavor.ts`): short invented rumors/backstories about single missions and mission
  *combinations*, grounded in real facts (targets, factions, cargo, rewards) but explicitly
  fiction — the prompt forbids instructions so it can never pollute guidance. Two layers: LM Studio
  at temperature 0.9, seeded template generator offline. Fires on a settings-controlled interval
  (default 10 min, game live only), ~30% chance after a mission accept, the 📖 chat-bar button, and
  Settings → "Tell one now". Spoken like all operator output; 6 unit tests.

- [x] **T4.7** *(added — "operator content" batch)* The operator now also tells the commander:
  **completion recaps** with reduced-package callouts (paid vs board price), **BGS consequences**
  from `FactionEffects` (economy/security/influence/rep trends per faction), a **session ledger**
  on docking (mission credits, bounties, crew wages, jumps/ly, unbanked bio & carto data —
  `engine/stats.ts`, resets on LoadGame), **risk checks** when accepting combat work (hull %,
  rebuy, unbanked samples), **Community Goal notices** (journal `CommunityGoal` → announce once +
  AI context), **tactical callouts** (`ShipTargeted` Dangerous/Deadly/Elite contacts,
  `UnderAttack` warnings, hostile `$Pirate` comms — new red ⚔ feed kind, spoken when serious),
  and **grounded lore**: true recent events (completions, eliminated targets, CGs, pirate hails)
  become seeds the story generator may weave in; between contracts an "afterglow" story mode
  gossips about recent deeds. Chatter pauses for 3 min after any combat signal.
  - *Check:* 10 unit tests (stats/bgs/CG/seeds); live ledger matches the real session
    ("4 missions 816,702 cr · 9 bounties 1,139,150 cr · crew took 106,170 cr…"); live CG parsed
    ("Colonia Council… 8,838 pilots, 35M cr bonus").

- [x] **T4.8** *(added — passengers/mining/combinations)* **VIP gift commodities** (real journal:
  VIP accepts carry `Commodity`+`Count`, e.g. "1 Clothing for Armand Goodwin") — shown on the card
  (🎁 Bring:), spoken in the briefing, and a buy-before-departing note on accept; **WANTED
  passenger warning** (spoken) on accept; **shared-destination bundling** note when a new mission
  heads where others already do; **cross-mission AI context** — every prompt now lists the rest of
  the board (dest, needs, expiry) so "what first?" can reason about combinations; **cargo
  acquisition estimates**: `MiningRefined`/`MarketBuy`/`CollectCargo` tick the acquire step and
  card bar (sequential fill, name-normalized across journal spellings, CargoDepot stays
  authoritative), announcing only when the hold is complete; **prospector callouts** (Motherlode
  always, ≥20% of a mission ore throttled) and refined tonnage in the session ledger.
  - *Check:* 4 unit tests (`tests/cargogain.test.ts`) + stats/context assertions; live session
    ledger verified (9 missions, 1,821,953 cr, 236,850 cr crew wages).

- [x] **T4.9** *(added — personal operator)* Accept-briefings are now **personal and lively**: the
  commander's name is read from `LoadGame`/`Commander` events; each accept produces an
  operator-voice briefing — LLM-delivered ("trusted wingman" persona, temp 0.7, facts-only prompt)
  with per-category hand-written template fallback (exact pay/destination, tight-timer and
  gift-commodity mentions). Spoken once; the dry form-letter line is gone. The name also flows
  into ask/story prompts so the AI addresses the commander directly.
  - *Check:* 4 unit tests; live-verified with the real "80 Aid Workers" accept — template:
    "80 AidWorker souls boarding, Commander M'allock… Timer's tight — 3h 19m."

- [x] **T4.10** *(added — Orville-voice chatter)* Stories are now first-person operator banter in
  the spirit of The Orville — warm, wry, humane, addressed to the commander by name. Dedicated
  **passenger angles** (galley talk, the life left behind — 60% for passenger missions) and
  **place angles** (the destination past the brochure), system intel fed into story prompts, and
  an explicit instruction to build on ironic connections to recent true deeds ("hauling refugees
  right after clearing out the pirates who displaced them"). More talking: default interval 10→6
  min, accept-stories at 45% (60% with passengers), 25% after completed objectives.
  - *Check:* live samples on the real Aid Workers run — place: "whatever brochure pictures of
    TolaGarf's Junkyard they send us are going to be wildly misleading…"; passenger: "…the
    dinners eaten at home, the kids who get to go to school again."

- [x] **T4.11** *(added — The Saga)* A **space-opera serial** narrated from the real journal:
  `engine/saga.ts` extracts story beats (accepts, aggregated bounty streaks, dockings, hand-ins,
  redirects, pirate hails, taking fire — with commander + ship name), and the LLM narrates
  numbered third-person episodes (~180-250 words, evocative title, cliffhanger hook) with
  "story so far" continuity carried between episodes. Episodes persist across app restarts
  (numbering continues; last 20 kept), render as bordered 📜 blocks in the feed, and are spoken.
  Triggers: automatically when the game session ends (`Shutdown`, toggleable), the 📜 chat-bar
  button, and Settings → "Narrate today so far". Offline fallback = plain chronicle recap.
  `node scripts/saga-proto.ts` narrates from the terminal using the same engine module.
  - *Check:* 4 unit tests; concept live-verified earlier ("The Crimson Tide of Ratraii" episodes
    generated from the real 7-18/7-19 sessions with correct events, credits and continuity).

- [x] **T6.8** *(added — trade leads)* The operator remembers every commodities market the
  commander opens (`Market.json` snapshot → `engine/trade.ts` MarketMemory, 40 markets persisted
  across sessions) and cross-references prices: when a spread clears the threshold (default
  5,000 cr/t, both ends ≥50 stock/demand, prices ≤48 h old, different stations) it announces the
  lead once (feed + spoken) and shows a dismissible green **TRADE LEAD** card — ✕ hides that lead
  for 24 h and the next-best surfaces. Threshold + on/off in Settings; the current lead also
  rides into every AI prompt so "what should I do?" can weigh it.
  - *Check:* 4 unit tests; real Market.json parses (Sakai Mineralogic Hub, Tir — 37 rows).

- [x] **T6.9** *(added — exobio leads)* Twin of the trade leads for exobiology: every body whose
  FSS/DSS scan shows **biological signals** is remembered (with genera once mapped, landable +
  distance from the Scan event), `ScanOrganic` Analyse events tick off what's been sampled, and
  bodies with uncollected signals surface as a dismissible cyan **🧬 EXOBIO LEAD** card —
  current-system bodies first, spoken only when the lead is in the system you're in. Dismissals
  hold for 7 days; 120 bodies persist across sessions; the lead rides into AI prompts.
  - *Check:* 4 unit tests (discovery, genus enrichment, sampling completion, ranking/exclusion).

- [x] **T4.12** *(added — voice pack)* **Two bundled offline voices** (Alba + Northern English
  male) with a proper Piper voice picker, plus a **catalog of 6 more** (Lessac, Amy, Joe, Ryan-high,
  Cori-high, Jenny) as one-click downloads — fetched once from the official piper-voices repo into
  the app-data dir on the user's explicit request, then fully offline forever. A downloaded voice
  auto-selects and speaks a test line. `piper_speak` is voice-aware; downloads never touch the
  install directory.
  - *Check:* male voice synthesizes (175 KB WAV test); catalog URLs verified live.

- [x] **T4.13** *(added — comms & warnings feed the lore)* The journal's NPC comms (598 lines in
  the real logs: military convoys, cruise liners, police patrols, fleeing deserters…) now feed the
  narrative: interesting transmissions are collected silently (station plumbing filtered,
  per-kind dedupe) and offered to the story prompts as "overheard on local comms" texture; truly
  dramatic ones (under-fire calls, near-death smugglers, deserters fleeing, hunters) plus
  **mission failures/abandonments** become saga chronicle beats; and the operator's own serious
  warnings (expiry urgencies, stuck-hunting) become story seeds — "we cut that one close" is now
  tellable. Hostile-comms combat callouts widened to cargo/passenger hunters.
  - *Check:* unit test (failure + drama beats, once-per-kind); comms inventory verified against
    the real journal.

> **Heartbeat noise fixes (post-release polish):** session-start `Location` now resets the idle
> clock (previously the first live tick reported hours of "idle" carried over from the prior
> session); stacked kill missions aggregate into **one** stuck-hunting nudge (previously 4 near-
> identical messages); and the feed has a 4-minute identical-nudge guard.

- [x] **T4.14** *(added — the memory bank)* **Persistent commander memory** (`engine/memory.ts`,
  app-data `memory.json` via Rust with atomic write-then-rename; localStorage in browser mode).
  Three layers: (1) **deterministic ledgers** folded from the journal — per-faction contract
  history, per-system visits/deaths, personal records (richest mission, biggest bounty, best
  session, longest jump), ranks — replay-safe via a timestamp watermark (bootstrap refolds are
  no-ops; the first run inherits full replayed history); (2) **distilled notes** — at `Shutdown`
  (45 s after the saga, retried around a busy LM) the model condenses the session digest
  (ledger + saga beats + seeds) into 0-4 one-line memories through a schema-constrained
  `response_format: json_schema` call, near-duplicate-rejected and auto-anchored to known
  systems/factions; (3) **recall + proactive remarks** — relevant memory lines ride into every
  AI prompt, and returning to a system that killed you / breaking a record / faction milestones
  / promotions produce spoken remarks. **No-flood is structural**: the model never decides when
  to speak — per-key 24 h announce gates + a global cooldown (importance-3: 3 min, routine:
  settings, default 15 min) + 90 s combat silence + max one remark per event burst, all in
  deterministic code. Settings: enable/proactive/cooldown, "Distill session now", "Forget
  everything". New 🧠 feed kind.
  - *Check:* 10 unit tests (`tests/memory.test.ts`: replay safety, same-second bursts, records,
    milestones, session records, death/return gating, promotions, recall filtering, reflection
    parse/dedupe/anchor, persistence round-trip); live-verified against LM Studio (gemma-4-e4b):
    digest → 2 valid anchored notes, recall surfaces them in-system. Capability probes: 4/4
    correct speak/silent decisions on the restraint test; JSON valid every run (needs
    max_tokens ≥ ~2500 — gemma-4's hidden reasoning burns 700-800 tokens before the JSON).
  - *Live app run (0.2.0 release check):* first-run bootstrap inherited the commander's real
    history from 10 replayed sessions — 28 missions, 44 jumps, 21 systems (Tir ×11), 11
    factions, all four records — and the on-screen demos passed: "What do you remember about
    me?" answered from the bank (top faction named), "Distill session" kept 4 correctly
    anchored memories, "Glance now" honestly reported "not in the game" on a desktop screen.
    **Bug found & fixed during the live run:** journal timestamps have 1 s resolution and
    bursts share a second (every FSDJump lands in the same second as arrival comms), so the
    original `at <= watermark` replay guard silently ate the second event of every such pair
    (all 44 jumps, 21 of 28 missions). Fix: strict `<` plus a `watermarkSeen` set of exact
    events within the watermark second (persisted, so restarts stay replay-safe) — regression
    test added. Also added `profileLines()` (lifetime tallies + records) to every AI prompt so
    "what do you remember about me?" works with no mission selected.
  - *Ship-attribution fix (user playtest):* the commander runs a named fleet (rahtari the
    Type-8 hauler, kaivuri the Lakon miner, Tulikärpänen the combat Anaconda…) and the digest
    stamped the whole day with the LAST-seen ship — a distilled memory credited kaivuri with
    rahtari's Superconductors delivery. Fixed three ways: (1) memory keeps a **per-ship ledger**
    (missions/bounties/jumps credited to the ship in use at event time, folded from
    LoadGame/Loadout/SetUserShipName) and the profile line feeds it to every AI prompt;
    (2) saga: ship *changes* become chronicle beats ("Took the helm of the rahtari (type8)")
    so multi-ship days stay attributable in episodes and reflection digests; (3) the reflection
    prompt orders time-correct ship attribution and the digest header says "ship at log end".
    The live bank on disk was patched (wrong note corrected + true ships ledger injected).
    - *Check:* 2 new tests (per-ship credit across a swap; helm-change beat once, not on
      re-stated Loadout); real-journal fold verifies rahtari 13 missions / kaivuri 0 missions
      13 jumps / Tulikärpänen 9 bounties — matching the commander's actual fleet roles.
      Ships also carry their hull type (`[lakonminer]`, `[Type8]`) so the AI resolves "the
      mining ship" to a name — live-verified: "The kaivuri is our dedicated mining vessel.
      As for hauling, the rahtari has logged 13 missions."

- [x] **T4.16** *(added — the companion: dialogue + ears)* **Talk to the operator, Jarvis-style.**
  (1) **Dialogue memory** (`engine/convo.ts` ConvoBuffer): the last ~10 turns — commander
  questions AND everything the operator says (answers, stories, memory remarks, warnings — all
  spoken output routes through a `speak()` wrapper) — are spliced into every ask prompt, so
  follow-ups ("and the mining ship?", "what did you mean?") resolve against the actual thread.
  15-min freshness window; consecutive operator lines collapse; long stories recalled as a
  ≤300-char gist. (2) **Voice input (opt-in, default OFF)**: hold `Ctrl+Shift+Space` (global,
  works with the game focused — the shortcut handler now processes Released edges) or the
  chat-bar 🎤 hold-to-talk button; Rust captures the default mic via **cpal** (any format,
  downmixed to mono, 30 s hard cap), writes a temp WAV (hound) and transcribes with a
  **whisper.cpp sidecar** (v1.9.1 CPU build + base.en model, one-time ~150 MB download on the
  user's click into app-data/stt — exact same pattern as the Piper voice catalog; zip crate
  extracts only whisper-cli.exe + runtime DLLs). Transcript → `cleanTranscript` (strips
  [BLANK_AUDIO]-style noise) → the normal ask pipeline with 🎤-prefixed feed line → spoken
  answer. Pressing PTT silences the operator mid-sentence (barge-in). Privacy: mic is live only
  while the key is held; audio never leaves the machine; temp WAV deleted immediately.
  - *Check:* capability probe first — whisper.cpp transcribed a bundled-Piper-spoken test
    phrase near-verbatim in **0.97 s** on CPU; 5 ConvoBuffer/cleanTranscript unit tests (87
    total); live in-app: the ~150 MB download ran through the Settings button, and a
    PTT-captured clip went mic → cpal → whisper → ask → spoken answer grounded in live journal
    context ("docked at Eol Prou PC-K c9-221, an Anarchy system with five fleet carriers
    nearby"). Dialogue memory live-verified with a typed follow-up chain.

- [x] **T4.17** *(added — mining companionship, user playtest: "operator is pretty silent"
  while ice-mining with no missions)* Journal check confirmed the gap: with no mining CONTRACT
  active, prospector callouts required mission ores and stories ran at the 3× no-mission
  interval — an entire Tritium/Bromellite shift passed in silence. Now, all deterministic and
  hard-throttled: **ring-drop greeting** (`SupercruiseExit` BodyType PlanetaryRing, 3 rotating
  lines, ≥30 min apart), **first-of-each-ore acknowledgement** ("First Bromellite in the
  refinery." — max 4/session, 45 s speech gap, exact `oreCounts===1` so replays can't re-fire),
  **session tonnage milestones** (10/25/50/100/200/400 t with the ore mix, once each, exact-match
  so a mid-session restart skips passed marks; each becomes a story seed), **missionless
  good-rock callouts** ("That one's worth the limpets — 41% Tritium": any ore ≥35%, the
  high-value set ≥25%, 90 s throttle; mission-ore rule unchanged and takes priority), and the
  no-mission story cadence tightens 3×→2× interval while an activity (mining/glance) is live.
  All lines route through `speak()` → dialogue memory, so "how much have we refined?" follows
  up naturally.
  - *Check:* 87 tests green; slice shipped compile-clean but **not live-verified** — the
    commander was mid-session with the installed build while this landed; it activates on the
    next operator restart.

- [x] **T6.10** *(added — "why does Spansh find nothing but Inara shows 26M/trip routes?")*
  Root cause found by replaying the exact query against the live API: the commander was docked
  on their **fleet carrier (V6W-TTJ)** and `fetchRoute` passed the current station as the route
  start — but the API *requires* `system`+`station` (undocked queries have 400'd all along,
  surfacing as "Spansh rejected the query"), and a carrier start with `allow_player_owned=0`
  returns `status:ok` with an **empty result**, which the HUD mistranslated as "no profitable
  route within hop range". Same moment, Inara (queried by system) showed 582-margin routes.
  Fixes: (1) carrier/undocked-aware start — fall back to the freshest REAL station market in
  the current system from MarketMemory (`stationIn()`, registration-plate names excluded), with
  a feed note ("You're on the carrier — planning from Sakai Mineralogic Hub instead"); when no
  station is known, an honest explanation instead of a fake "no routes". (2) **Inara-style
  profit calculator**: the parser now keeps each hop's shopping list (top 3 by total profit —
  per-ton alone misleads when supply caps the amount) with amount, buy→sell prices, margin %
  and per-commodity take; the route card renders calculator rows ("163 t Military Grade
  Fabrics · buy 93 → sell 12,215 · +12,122/t (13,034%) = +1,975,886 cr") plus cr/trip per hop;
  hops now lead with the biggest EARNER.
  - *Check:* live API replay proved carrier-start empty vs real-station 2-hop 1.99M cr route
    (Tir → Luchtaine → Ratraii); that captured reply is the new parser fixture (calculator
    fields + margin math asserted); `stationIn` tests incl. carrier exclusion; 89 tests green.

- [x] **T7.1** *(added — Linux build, FleetComm asked: "wish there were more linux friendly
  tools")* **The app now builds and runs on Linux.** Portability work: journal auto-detect
  probes the Steam **Proton prefix** (`compatdata/359320/pfx/drive_c/users/steamuser/Saved
  Games/…` under `~/.local/share/Steam`, `~/.steam`, Flatpak, Snap) + `~/` expansion in the
  settings override; per-OS Piper (`resources/tts-linux/piper/piper` ELF, bundled via
  **tauri.linux.conf.json** resource override so neither installer carries the other OS's
  binaries; `scripts/fetch-tts.sh` = bash twin of the ps1); whisper.cpp uses the official
  `whisper-bin-ubuntu-x64.tar.gz` (system `tar` extraction so the .so symlinks survive;
  `LD_LIBRARY_PATH` set when spawning both sidecars); `system_specs` reads /proc/meminfo +
  cpuinfo (GPU VRAM unknown → advisor judges by RAM); screen glances stay Windows-only
  (settings show "(Windows only for now)", checkbox disabled via UA sniff); zip/image/base64
  crates moved to Windows-only deps. Linux bundles: **.deb + AppImage** targets.
  - *Check (WSL2 Ubuntu 24.04, rustc 1.97):* clean release build in 1m50s; **the HUD launched
    and rendered under WSLg** with the Proton-path error message exactly as designed; headless
    on Linux: **89/89 engine tests pass**, ELF Piper synthesized speech, and the Linux
    whisper-cli (extracted with the app's exact tar flags) transcribed that Piper clip
    correctly — the full voice loop works on Linux. Windows `cargo check` stays clean.
    Wayland caveat documented (global shortcuts/PTT key need X11; HUD buttons work anywhere).
  - *Emoji tofu (user caught it from a live WSLg screenshot):* the icon buttons rendered as
    empty boxes — no emoji font on minimal systems. Fixed: emoji fallbacks appended to both
    CSS font stacks, and the .deb now **Depends: fonts-noto-color-emoji** (verified appended
    to Tauri's defaults, not replacing them); re-render under WSLg confirmed the icons.
  - *AppImage:* linuxdeploy's dependency walk fails on piper's sibling-dir .so files — fixed
    by pruning piper's unused helper binaries (espeak-ng, piper_phonemize — fetch-tts.sh does
    it permanently) AND exporting `LD_LIBRARY_PATH` to the piper dirs for the bundling run.
    **Both bundles ship**: `.deb` 147 MB + `.AppImage` 212 MB → site/ alongside the exe.

- [x] **T4.15** *(added — operator sight)* **Screen glances (opt-in, default OFF)**: Rust
  `capture_screen` (GDI BitBlt — compiled code, no AMSI flags, works over borderless games) →
  ≤1280 px JPEG q60 data-URI, in-memory only → the local VLM judges
  `{activity, notable, remark}` (schema-constrained). The activity feeds `currentActivity()` so
  stories/advice know what the commander is doing even when the journal is quiet; spoken ONLY
  when the model flags notable AND a 10-min cooldown + last-remark dedupe agree. Gates before
  any capture: setting on, LM idle, VLM-capable model (`/api/v0/models` type map, optimistic
  when the API is absent), game live, interval elapsed (default 5 min), 2 min clear of combat.
  `ChatMsg.content` generalized to JSON (OpenAI content parts) and `response_format` passthrough
  added to the streaming proxy. Settings warn when the active model lacks vision; "Glance now"
  button always reports. New 👁 feed kind.
  - *Check:* glance message/parse unit tests; live-verified: the VLM read a real app screenshot
    in ~6 s and correctly returned `"not in the game", notable=false` for a non-game screen —
    the restraint contract holds end-to-end.

---

## M5 — HUD polish & interaction

- [x] **T5.1** Collapsed (compact bar w/ nearest mission + timer) / expanded / minimized
  (hidden window, `Ctrl+Shift+M` restores).
- [x] **T5.2** Draggable (`data-tauri-drag-region`) + geometry persisted Rust-side
  (`geometry.json`, throttled writes); resizable (min 320×480); opacity & font-scale settings.
- [x] **T5.3** Click-through toggle (`set_ignore_cursor_events`) — settings checkbox +
  `Ctrl+Shift+T` global rescue toggle.
- [x] **T5.4** Global shortcuts. *(Deviation: spec's `Ctrl+M`/`Ctrl+Tab` global combos would steal
  everyday shortcuts from other apps → moved to `Ctrl+Shift+M/H/V/J/K/T`; in-window `Esc` and
  `Ctrl+Tab` kept as specced.)*
- [x] **T5.5** Category color coding + status footer (missions count, JRNL ● live/idle/down,
  LM ●, PIPER/VOICE ●, current location).
- [x] **T5.6** Settings UI covering the wired config schema (LM, voice, HUD, journal, import).

**M5 done when:** the HUD is comfortable over a running game session. ✔

---

## M6 — Enrichment, history & release

- [ ] **T6.1** Optional EDSM enrichment (opt-in) — deferred to v1.1 (100% offline for v1).
- [x] **T6.2** Optional Spansh route plotting — **shipped as the online trade-route planner**
  (user asked for "Inara" routes; Inara exposes no public trade-search API, so Spansh's community
  planner is used — same EDDN-fed price data). **Opt-in, default OFF**: sends only the current
  system/station name; routes are auto-sized to the ship's cargo hold (`Loadout.CargoCapacity`)
  and bankroll, hop range configurable (default 40 ly). Fetches on docking (≤2×/hour) or via
  "Find a route from here"; results show as a dismissible violet 🔄 card (per-hop commodity,
  stations, ly, cr/ton, price age), get spoken, feed the AI context, and seed the stories.
  *(API gotcha: booleans must be sent as `0`/`1` — the string `"false"` parses as true.)*
  **Waypoint clipboard automation** (EDMC-style — ED offers no external route-plot API, and
  keystroke injection into the game was rejected as fragile): each hop has a 📋 copy button, and
  with auto-copy on (default) the first waypoint lands on the clipboard when a route is found;
  every jump into the current waypoint strikes it through, copies the next system, and announces
  it — in-game it's just Galaxy Map → search → Ctrl+V → Enter. Rust `copy_text` uses the
  clipboard-manager plugin so copying works even while the game window has focus.
  - *Check:* 3 parser tests against a captured live reply (Tir → Alberta → Luchtaine, Grain at
    13,304 cr/ton); live probe verified end-to-end during development.
- [ ] **T6.3** Mission history & stats — deferred to v1.1 (`NavRoute.json` jump count already feeds
  AI context).
- [ ] **T6.4** Persist `state/active.json` + `history.json` — deferred (bootstrap replay restores
  state in well under a second, reducing the need for a cache).
- [ ] **T6.5** Accessibility pass — aria labels/roles are in; high-contrast & large-text beyond
  font-scale still open.
- [x] **T6.6** Packaging: **NSIS single-file setup exe** (per-user, no admin, WebView2
  auto-provisioned, Piper + voice bundled as resources). *(Deviation: NSIS over `.msi` — single
  self-contained exe matches the "click one executable" goal better than WiX.)*
- [x] **T6.7** User guide (README): setup for LM Studio, journal location, TTS privacy notes,
  shortcuts, dev workflow.

---

## Cross-cutting / definition of done

- [x] **X.1** Parser resilience: unknown journal events ignored (engine skips unknown `event`
  values; corrupt/partial lines dropped); the raw accept event is retained per mission.
- [~] **X.2** Privacy invariant: by construction the only outbound calls are to the configured LM
  endpoint (default `127.0.0.1:1234`) — all network code lives in `src-tauri/src/main.rs`
  (reqwest) and `engine/lmstudio.ts` (CLI only). Formal network-trace verification still to run.
- [x] **X.3** Never write to the ED Saved Games directory: the watcher opens journal/snapshot
  files read-only; no write API touches that path anywhere in the codebase.
- [~] **X.4** Regression fixtures: core categories covered by the 16 engine tests; the full §10.A
  taxonomy sweep remains open.
- [~] **X.5** Performance: 600 ms poll + offset tail reads only appended bytes; spot-check on a
  long session pending.

---

## Suggested build order & dependencies

```
M0 ─▶ M1 ─▶ M2 ─▶ M3 ─▶ M4 ─▶ M5 ─▶ M6
             │
             └▶ (M3 and M4 can proceed in parallel once M2 exposes normalized missions)
```

**Critical path:** ✔ walked in order; M1 validated against the real journals before UI/AI/voice.

---

## Open questions for the developer

1. **TTS default:** ~~local-only vs cloud Natural voices~~ → resolved: bundled **Piper** local
   neural voice is the default; cloud voices opt-in and labelled.
2. **History depth on bootstrap:** default 1 previous session (settings 0–10). Full-history import
   for stats remains a v1.1 idea (T6.3).
3. **Enrichment:** deferred entirely — v1 is 100% offline except LM Studio.
4. **Kill-mission progress:** inferred kills are tracked (`Bounty`/`FactionKillBond` vs
   `TargetFaction`) and shown on the card as "N kill(s)" — best-effort, plus redirect flip.
