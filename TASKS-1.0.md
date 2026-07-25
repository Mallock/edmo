# ED Mission Operator — 1.0: the self-contained release

**Companion to:** [TASKS.md](TASKS.md) (M0–M6) · [SPEC.md](SPEC.md) · [README.md](README.md)
**Date:** 2026-07-25
**Goal:** remove the last external dependency. The installer stays small; after installation the app
can fetch its own **inference runtime** (Vulkan, optionally CUDA) and **model** on one click — the same
shape as the existing whisper.cpp download. LM Studio stays supported as a fallback and power-user path.

Legend: `[ ]` todo · `[~]` in progress · `[x]` done. Each task lists an **acceptance check**.

> **Why this is 1.0.** Two of the three AI pillars are already self-contained: Piper TTS is bundled,
> whisper.cpp STT is a one-click download. The LLM is the only piece still requiring the user to
> install a second application, pick a model, judge whether it fits, and load it. Closing that gap
> turns onboarding from a five-step setup into a single button, guarantees the copilot's vision
> capability (we choose the model), and makes the privacy story airtight — there is no endpoint to
> misconfigure.

## What already exists (the leverage)

| Capability | Where | Reuse |
|---|---|---|
| Streaming HTTP + zip extraction | `reqwest` (`stream`), `futures-util`, `zip` in `Cargo.toml` | as-is |
| Large opt-in download (Win zip / Linux tar.gz) | `stt_download`, `main.rs` ≈:890 | copy the pattern |
| Voice download to app-data | `piper_download_voice`, `main.rs` ≈:446 | copy the pattern |
| App-data dir (installed dirs untouched) | `main.rs` ≈:378 | as-is |
| GPU name + VRAM detection | `read_gpus()` / `system_specs`, `main.rs` ≈:1361 | backend + model tier choice |
| Sidecar process spawn | piper / whisper invocations | extend to a long-running server |
| **OpenAI-compatible chat client** | `llm_chat` / `stream_chat`, `bridge.ts` | **point at a different port — no protocol work** |
| Model sizing advisor | `src/ui/modelfit.ts` | pick the download tier |

**Not yet present:** download **progress reporting** (today's downloads are await-and-done), any
long-running managed child process, and any engine abstraction in settings.

---

## M7.0 — Vision spike (GATE: do this before anything else)

The copilot's `describeFirst` pass reads the screen. That requires llama.cpp multimodal
(`--mmproj`) to work with the chosen Gemma build. If it does not, this milestone delivers a
text-only engine and vision stays on LM Studio — a materially weaker feature. Settle it first.

- [x] **T7.0.1** Manually fetch a `llama-server` Vulkan build (ggml-org/llama.cpp releases) and the
  chosen model's main GGUF + `mmproj` GGUF.
  - *Check:* `llama-server --model … --mmproj …` starts and serves `/v1/models`. ✔ b10107 Vulkan,
    **32 MB zip → 93 MB extracted**; log reports `loaded multimodal model`; ready in **~8 s**.
- [x] **T7.0.2** Drive it with the app's real payload: `buildSceneDescriptionMessages()` + a genuine
  ED screenshot, with `response_format` = `SCENE_FORMAT`.
  - *Check:* ✔ `parseSceneDescription()` accepted it; `screen=cockpit-flight`, and it read genuine
    HUD text off the frame — `LIMPET [PROSPECTOR]`, `DEPLETED`, `PULSE WAVE`, `KAUVARI INFO`.
- [x] **T7.0.3** Confirm the rest of the wire contract: token streaming (SSE), `presence_penalty` /
  `frequency_penalty`, and json_schema `response_format` for `GLANCE_FORMAT`.
  - *Check:* ✔ all three. `GLANCE_FORMAT` → `parseGlanceReply()` accepted (`activity="supercruising"`);
    penalties accepted on a copilot beat (*"Seventy-two tourists and two point four million
    credits—let us get this run home in one piece."*); SSE frames carry `delta` chunks.
- [x] **T7.0.4** Record throughput on the dev machine (tokens/s, time-to-first-token) vs LM Studio.
  - *Check:* ✔ describe **11.8 s**, glance verdict **6.2 s**, copilot beat **7.3 s** (Vulkan, `-ngl 99`,
    ctx 8192). Slower than LM Studio's CUDA path — acceptable, but see T7.2.3.

**M7.0 done when:** a scene reading + a spoken beat are produced end-to-end by a locally spawned
`llama-server`. ✔ **GATE PASSED — the bundled engine can do vision.**

### Spike findings that change the implementation

1. **The engine inherits ambient env vars.** `llama-server` picked up a `LLAMA_API_KEY` present in the
   dev environment and then 401'd every `/v1/chat/completions` call (while `/v1/models` still
   answered — a confusing failure mode). **The app must spawn with a sanitised environment and set its
   own `--api-key` to a per-session random token**, sending it as `Authorization: Bearer`. That also
   stops other local processes from using the engine. → folded into T7.4.1.
2. **Reasoning lands in `reasoning_content`, not inline `<think>` tags.** The describe call produced
   **2 826 chars of hidden reasoning** alongside 426 chars of content. `stripThink()` never sees it
   (content arrives clean — good), but token budgets must cover it, and the Rust proxy should ignore
   the field rather than concatenate it. → T7.5.2.
3. **Real sizes are bigger than estimated**: gemma-4-E4B-it Q4_K_M is **5.0 GB** + **946 MB** mmproj
   ≈ **6 GB**, not ~4 GB. Onboarding copy and the disk precheck must use the real figure.
4. **`lmstudio-community/gemma-4-E4B-it-GGUF` is ungated** and carries both files — confirms the
   mirror choice in T7.3.1.
5. **CUDA is expensive**: Vulkan **31 MB** vs CUDA **137 MB + 372 MB cudart ≈ 509 MB** (b10107, Win
   x64). Vulkan-first is the right default; CUDA stays optional.
6. **An existing LM Studio model directory can be reused** — the spike ran entirely off the user's
   already-downloaded GGUFs. Worth offering "use a model I already have" to skip the 6 GB pull. → new T7.3.4.

---

## M7.1 — Download infrastructure (shared)

A 4 GB pull needs more than the fire-and-forget helpers used for a 63 MB voice.

- [x] **T7.1.1** Progress-reporting downloader in Rust: stream via `bytes_stream()`, emit
  `download-progress { id, received, total, phase }` on an interval (not per chunk).
  - *Check:* ✔ `download_file()` streams via `bytes_stream()` and emits `engine-progress`
    every 400 ms (never per chunk); the store forwards it to the Settings bar.
- [~] **T7.1.2** Resume + integrity: HTTP range resume for interrupted transfers; verify SHA-256
  against a pinned manifest; delete and re-fetch on mismatch.
  - *Check:* ✔ resume implemented via `Range` + `.part` file, and a server that ignores Range is
    detected (`206` check) so we never append to garbage. ⚠ SHA-256 exists (`sha256_file`,
    `engine_hash_model`) but artifacts are not yet auto-verified — upstream publishes no digests
    for these, so a hash must be pinned per release before this can be `[x]`.
- [x] **T7.1.3** Cancel support and disk-space precheck (refuse to start without headroom + margin).
  - *Check:* ✔ `engine_cancel_download` flips an `AtomicBool` the stream loop honours (partial stays
    as `.part`, so the next attempt resumes it); `ensure_space()` refuses with a 1 GB margin.
- [x] **T7.1.4** A pinned **artifact manifest** (versions, URLs, sizes, hashes) in one place, so
  bumping the runtime or model is a single edit and is auditable.
  - *Check:* ✔ `runtime_artifacts()` / `model_artifacts()` in `engine.rs` are the only source of URLs;
    `LLAMA_BUILD` is a one-line bump.

**M7.1 done when:** any large artifact downloads with progress, resume, verification and cancel.

---

## M7.2 — Inference runtime acquisition

**Vulkan first.** ~30–50 MB, works on NVIDIA + AMD + Intel. CUDA is an optional upgrade: hundreds of
MB extra for NVIDIA-only benefit.

- [x] **T7.2.1** Download + extract `llama-server` (Vulkan, Windows x64) to app-data, mirroring
  `stt_download`.
  - *Check:* ✔ `engine_download_runtime` extracts only `llama-server` + libs into app-data
    (`extract_runtime_zip`), chmod +x on unix; program dirs untouched.
- [x] **T7.2.2** Backend recommendation from `read_gpus()`: NVIDIA → offer CUDA, otherwise Vulkan;
  no usable GPU → CPU with an honest speed warning.
  - *Check:* ✔ `recommend_backend()` — NVIDIA → cuda, GPU present → vulkan, none → cpu; surfaced in
    Settings as "picked for your hardware".
- [~] **T7.2.3** *(optional)* CUDA build + cudart runtime pack, with automatic fallback to Vulkan when
  the CUDA server fails to initialise.
  - *Check:* ⚠ CUDA + cudart are in the manifest and download/extract together, but automatic
    fallback-to-Vulkan on a CUDA init failure is NOT implemented, and it is untested on NVIDIA.
- [~] **T7.2.4** Runtime version pinning + an "update runtime" action that re-downloads cleanly.
  - *Check:* ⚠ the installed build is recorded (`build.txt`/`backend.txt`), but there is no
    "update runtime" action and no stale-file sweep on re-download yet.

**M7.2 done when:** the app can acquire and launch a working inference runtime with no external installs.

---

## M7.3 — Model acquisition

- [x] **T7.3.1** Pick the shipped model + quantisation and pin it. Baseline: **gemma-4-e4b Q4_K_M**
  (main GGUF + `mmproj`) — validated all session for grounding and screen/UI reading.
  - *Check:* ✔ pinned to `lmstudio-community/gemma-4-E4B-it-GGUF` (ungated, confirmed in the spike)
    with the measured 6.3 GB size and the licence string surfaced in Settings.
  - ⚠ **Use an ungated mirror.** Google's official Gemma repos on HuggingFace are licence-gated and
    will 403 an unattended download; community GGUF mirrors (`lmstudio-community`, `bartowski`,
    `unsloth`) are not. Verify the exact repo before pinning, and surface the model licence in-app.
- [~] **T7.3.2** VRAM-tiered choice via `modelfit.ts` (e.g. E2B for ~8 GB, E4B default, 12B for large
  cards), defaulting to what fits **while the game is running** (the existing budget already reserves
  ED's ~6 GB).
  - *Check:* ⚠ two tiers (E2B/E4B) carry a `needs_gb` budget and both are listed, but the UI does
    not yet auto-preselect the tier from `modelfit.ts`.
- [~] **T7.3.3** Model manager UI: installed models, sizes, delete, re-download, switch active.
  - *Check:* ⚠ list + start/download are in Settings and `engine_remove_model` exists, but there is
    no delete button wired yet.
- [~] **T7.3.4** *(from the spike)* "Use a model I already have": scan the LM Studio model dir for a
  GGUF + matching `mmproj` and offer it, skipping the 6 GB download.
  - *Check:* ⚠ `engine_scan_local_models()` walks the LM Studio tree and pairs GGUF+mmproj (the
    spike ran off exactly such a pair), and `local:<model>|<mmproj>` ids start correctly — but the
    result is not surfaced in the Settings UI yet.

**M7.3 done when:** a first-time user gets a vision-capable model sized to their machine, on one click.

---

## M7.4 — Engine lifecycle (the genuinely new part)

Today's sidecars are one-shot invocations. This is a long-running server the app owns.

- [x] **T7.4.1** Spawn `llama-server` on a free localhost port (bind `127.0.0.1` only), with flags
  derived from the tier: context size, GPU layers, `--mmproj`.
  - *Check:* ✔ binds `127.0.0.1` on a free port, `--mmproj` from the tier, **scrubs ambient
    `LLAMA_*`/`OPENAI_*` env and sets its own per-session `--api-key`** (spike finding #1), and runs
    with `CREATE_NO_WINDOW` so no console flashes.
- [x] **T7.4.2** Readiness + health: poll `/v1/models` until ready (model load is slow); surface
  "starting…" in the HUD; detect a hung start.
  - *Check:* ✔ polls `/v1/models` up to 60 s, emits `engine-ready`, and fails fast if the child
    exits during startup instead of waiting out the timeout.
- [x] **T7.4.3** Clean shutdown on app exit **and** on crash of the parent — no orphaned processes.
  - *Check:* ✔ `stop_engine()` runs from both `close_app` and the window `CloseRequested`/`Destroyed`
    handler (the X button is the common exit) — verified live: closing with **X** left
    `llama-server orphans: 0`.
    ⚠ **But a force-kill does orphan it** — discovered by `Stop-Process -Force` on the app (the Task
    Manager / hard-crash path), which bypasses every handler and left the engine running. Fixed with a
    PID file: the engine's pid is recorded on spawn, cleared on a clean stop, and
    `reap_orphan_engine()` runs at startup to kill a survivor. It matches on **both** pid and image
    name, so a recycled pid belonging to another program can never be killed by mistake.
- [~] **T7.4.4** Crash recovery with backoff, a visible error, and a one-click switch to LM Studio.
  - *Check:* ⚠ `engine_alive()` is polled in `pollLm()` and a died engine is reported in the feed
    with a pointer to Settings/LM Studio — but there is no automatic restart with backoff.
- [ ] **T7.4.5** Idle unload policy (optional): free VRAM when the game is not running.
  - *Check:* VRAM is released; the next beat restarts the engine transparently.

**M7.4 done when:** the engine starts, is monitored, recovers, and never leaks a process.

---

## M7.5 — Engine abstraction & settings

- [x] **T7.5.1** `settings.lm.engine: 'bundled' | 'lmstudio'` (default `bundled` once set up, else
  `lmstudio`), with the existing endpoint field applying to the LM Studio path.
  - *Check:* ✔ `settings.lm.engine` + `lmTarget()` resolve endpoint **and** key per request; both
    `llmChat` call sites and `llmModels` go through it. Switching to LM Studio stops the engine.
- [x] **T7.5.2** Vision capability: `llm_model_types` is LM Studio-specific; for the bundled engine the
  VLM flag is known by construction from the manifest.
  - *Check:* ✔ `activeModelIsVlm()` returns the engine's running state on the bundled path (every
    shipped tier has an mmproj); the LM Studio capability probe is skipped there.
- [x] **T7.5.3** Settings "AI engine" section: status, backend, model, download/update/remove, progress,
  and a plain-language explanation of the download size.
  - *Check:* ✔ new "AI engine" section: engine picker, hardware-picked backend, tier list with sizes,
    one-click download+start, live progress with GB/percent, cancel, stop, and a licence note.
- [x] **T7.5.4** Keep LM Studio fully supported and documented as the fallback/power-user path.
  - *Check:* ✔ `engine` defaults to `lmstudio`, so existing installs are untouched; the LM Studio
    section is still there (shown when selected).

**M7.5 done when:** either engine can be selected, and the copilot behaves identically on both.

---

### End-to-end verification (2026-07-25, no LM Studio running)

Ran the app's own pipeline against a `llama-server` spawned exactly as `engine_start()` does — own
`--api-key`, ambient `LLAMA_*`/`OPENAI_*` scrubbed — on an **AMD RX 7800 XT** (Vulkan path):

| Check | Result |
|---|---|
| No key → `/v1/chat/completions` | **401** ✔ enforced |
| Wrong key | **401** ✔ (an inherited env key can no longer get in) |
| Session key | accepted ✔ |
| Trivial generation | **1.8 s** |
| `buildSceneDescriptionMessages` + `SCENE_FORMAT` | **11.1 s**, `parseSceneDescription` ✔, read `LIMPET [PROSPECTOR]`, `DEPLETED` |
| Copilot beat (penalties, real conversation) | **6.8 s** — *"Seventy-two tourists, two point four million credits—that's a bit of a crowd for a long run through the void."* |

**With LM Studio not running at all.** Two notes for later:

- ℹ **VRAM reporting is fine in the app.** A raw WMI `AdapterRAM` query reports the 16 GB RX 7800 XT
  as 4 GB (a known 32-bit cap), but the app's own `read_gpus()` uses a better source — Settings
  correctly shows "AMD Radeon RX 7800 XT 16 GB". T7.3.2 can therefore trust it.

### Click-through in the running app (dev build, LM Studio closed)

Drove the actual UI rather than the commands:

1. Settings → the new **AI ENGINE** section renders; backend auto-detected as **vulkan** (AMD card).
2. Switched *Run the AI with* → **"This app (no other software needed)"**; the LM Studio section
   hides itself.
3. Model list shows both tiers with sizes and state: *"Gemma 4 E4B (recommended) · 5.3 GB ·
   installed"* → **Start**; the E2B tier offers *Download & start*.
4. **Start** → the app spawned `llama-server` on a free random port (56197) and the panel switched to
   *"✅ Running locally on port 56197 — gemma-4-e4b. Nothing else to install."* with **Stop the engine**.
5. Feed showed *"⚙ Starting the local AI engine…"* → *"✅ Local AI engine ready — no LM Studio needed."*
6. Asked the operator *"What ship am I flying"* → **answered from the bundled engine, grounded in the
   real journal**: *"You are flying the Tulikärpänen, an anaconda-class ship. It has a maximum jump
   range of 31.2 light-years. You also have a cargo capacity of 192 tons."*
7. Closed the app with the window **X** → `ed-mission-operator: 0`, `llama-server orphans: 0`.
   **T7.4.3 verified in the real exit path.**

### The download branch, verified for real

Then exercised `Download & start` on the **E2B tier (4.11 GB)**, which was genuinely not installed:

- Live progress rendered from the `engine-progress` stream: *"model — 2% (0.07 / 3.43 GB)"*.
- **Cancel** stopped it and **preserved** the 0.12 GB `.part`.
- **Resume** picked up at 4% (0.13 GB) instead of restarting — HTTP `Range` resume confirmed end to end.
- The commander then let it run to completion: both files landed at exactly the CDN sizes
  (**3.19 GB** + **0.92 GB**), **no `.part` left behind** (atomic rename on completion), and the engine
  started on the new tier. ✔

**UX fix that came out of this** (the commander spotted it): while downloading, the panel offered only
*Cancel*, and after cancelling the partial became invisible — the button read *"Download & start"*, so
the 0.13 GB looked lost. `ModelInfo` now reports `partial_bytes`, a paused tier reads
*"0.13 GB downloaded — paused"*, and the actions are **Resume download** / **Discard**
(`engine_discard_partial`).

*(The runtime was pre-staged in app-data and the E4B models hardlinked from the existing LM Studio
copies, so the earlier click path skipped a redundant 6 GB pull; the E2B download above was real.)*

---

## M7.6 — First-run onboarding

- [x] **T7.6.1** First-run flow: detect no AI configured → offer **"Set up the AI (≈N GB)"** with the
  recommended runtime + tier prefilled, and a clear "skip, everything else still works" exit.
  - *Check:* ✔ verified by moving the models aside to fake a fresh install: the HUD's idle panel shows
    **"Set up the AI operator? … ⬇ Set up the AI (6.0 GB, one time) | Not now"**, with the tier chosen
    from the real GPU budget (E4B on a 16 GB card). With models present the offer correctly hides.
- [x] **T7.6.2** Honest disclosure before download: size, disk use, that it is local-only and one-time.
  - *Check:* ✔ the button states the size up front, the sub-line says it comes from the models'
    official sources and that "mission tracking and voice already work without it"; nothing downloads
    until clicked, and "Not now" is remembered (localStorage).
- [x] **T7.6.3** Degrade politely at every step (no GPU, low disk, download failure, engine failure).
  - *Check:* ✔ and the fresh-install test caught a real fault: auto-resume trusted the remembered
    model id and greeted a wiped models dir with *"The AI engine could not start: that model is not
    downloaded yet"*. Now guarded — a model that is no longer on disk falls through to the setup offer
    silently. Re-verified: clean *"Starting…" → "Local AI engine ready"* with no error.

**M7.6 done when:** install → play → the copilot talks, with no external tools and no docs. ✔

---

## M7.7 — Linux parity

- [x] **T7.7.1** Linux artifacts (tar.gz) for runtime + model, honouring the AppImage/.deb sandbox and
  XDG data dirs.
  - *Check:* ✔ and this caught a real bug: the Linux artifacts were pinned as `.zip` (guessed) when
    the release actually publishes **`.tar.gz`** — Linux would have 404'd on every runtime download.
    Corrected to `llama-b10107-bin-ubuntu-vulkan-x64.tar.gz` (30 MB) / `...-ubuntu-x64.tar.gz` (15 MB),
    and `extract_runtime_archive()` now branches: zip on Windows, system `tar` on Linux (preserving
    the versioned `.so` symlinks, same reasoning as `stt_download`), flattening `build/bin` and
    chmod +x on the binary. App-data paths are already cross-platform via Tauri.
- [x] **T7.7.2** Verify the containerised build still produces working packages with the new code.
  - *Check:* ✔ the container build compiles the new `engine.rs` for Linux and bundles both packages.
    ⚠ Not *run* on a Linux host — compile + package only.

**M7.7 done when:** Linux reaches parity or ships with a documented, honest limitation. ✔ (compiles
and packages; not yet exercised on a Linux host)

---

## M7.8 — 1.0 release

- [x] **T7.8.1** Version bump to **1.0.0** across `tauri.conf.json`, `Cargo.toml`, `package.json`, and
  the site's version strings.
  - *Check:* ✔ `tauri.conf.json`, `Cargo.toml`, `package.json` and every `site/` string now read
    **1.0.0**; download links match the built filenames.
- [x] **T7.8.2** Rewrite site install steps: the LM Studio walkthrough (step 05) becomes a one-click
  in-app setup; keep LM Studio documented as the alternative.
  - *Check:* ✔ step 05 is now *"Turn on the AI operator — one button"*: Settings → AI engine → *This
    app*, with the honest 4–6 GB/resumable note, and an aside keeping LM Studio as a first-class
    alternative and driver fallback.
- [x] **T7.8.3** README/SPEC: engine architecture, the manifest, model licence, privacy statement
  updated (downloads from pinned sources on explicit click; inference stays on `127.0.0.1`).
  - *Check:* ✔ README privacy invariants rewritten to state the real shape — inference always local
    (bundled: random loopback port behind a per-session key), downloads explicit and pinned to one
    manifest, nothing fetched in the background. New **SPEC §6.0** documents the two-backend
    architecture, the manifest, and the lifecycle findings.
- [~] **T7.8.4** Clean-machine test matrix: NVIDIA / AMD / Intel-only / no-GPU × Windows / Linux.
  - *Check:* ⚠ only **AMD / Windows / Vulkan** has actually been exercised (this dev machine, end to
    end including a real 4.1 GB download). NVIDIA-CUDA, Intel, no-GPU and every Linux row are
    untested — the honest limitation to carry into 1.0.
- [x] **T7.8.5** Build and publish all three installers from one commit.
  - *Check:* ✔ built from one tree: `ED-Mission-Operator-1.0.0-setup.exe` (137.9 MB),
    `-amd64.deb` (154.1 MB), `-x86_64.AppImage` (241.6 MB); `file` confirms a valid Debian package
    and x86-64 ELF. Old 0.3.0 artifacts removed from `site/`.

**M7.8 done when:** 1.0 installs on a clean machine and works without any other software.
✔ built and documented; the clean-machine matrix (T7.8.4) remains partly untested.

---

## Risks & non-goals

**Risks**
1. **Vision via mmproj (M7.0)** — the single gate; everything else is known work.
2. **Support burden** — LM Studio currently absorbs driver bugs, VRAM OOM and crash loops. Owning the
   engine means owning those. Mitigation: keep the LM Studio path as the documented escape hatch.
3. **Download size** — ~4 GB first run. Mitigation: opt-in, resumable, tiered by VRAM.
4. **Artifact drift** — upstream release URLs and repos move. Mitigation: pinned manifest (T7.1.4).
5. **Model licence** — surface Gemma's terms in-app; download only from an ungated mirror.

**Non-goals for 1.0**
- Fine-tuning a model. *The "tuning" in this project is prompt engineering, and it already ships in
  `copilot.ts` / `glance.ts`.* A custom fine-tune is a separate project (dataset, eval, hosting).
- Bundling the model inside the installer — it stays a post-install download.
- Multi-GPU, ROCm-specific builds, or non-x64 targets.
- Replacing LM Studio. It remains first-class.

## Suggested order

`M7.0` (gate) → `M7.1` → `M7.2` (Vulkan only) → `M7.3` → `M7.4` → `M7.5` → `M7.6` → `M7.7` →
CUDA (`T7.2.3`) → `M7.8`.

**Rough effort:** 3–4 focused days to "works without LM Studio on Windows/Vulkan"; ~1 week including
CUDA, Linux parity and 1.0 release polish. The unknown is M7.0.
