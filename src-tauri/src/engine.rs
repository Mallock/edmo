//! Bundled AI engine — the app fetches its own llama.cpp runtime and model.
//! This is the ONLY engine: LM Studio support existed through 1.3.0 and was
//! cut deliberately (one engine the app launches, owns and can read the logs
//! of, instead of two it can only poke over HTTP).
//!
//! Design notes from the M7.0 spike, all of which shaped this module:
//!   * `llama-server` inherits ambient env (`LLAMA_API_KEY`, `LLAMA_ARG_*`) and
//!     will then 401 every chat call while `/v1/models` still answers — a very
//!     confusing failure. We scrub those and set our own per-session key.
//!   * The model is ~6 GB, so downloads stream to disk (never buffered like the
//!     150 MB whisper zip), resume on restart, and report progress.
//!   * Vulkan is 31 MB and works on every vendor; CUDA is ~509 MB with the
//!     runtime pack. Vulkan is therefore the default and CUDA an upgrade.
//!
//! Privacy is unchanged: downloads come from pinned upstream URLs on an
//! explicit click, and inference stays on 127.0.0.1.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use futures_util::StreamExt;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};

// ---------------------------------------------------------------- manifest

/// Pinned llama.cpp release. Bumping the runtime is a one-line edit here.
const LLAMA_BUILD: &str = "b10238";

/// One downloadable runtime build. `bytes` is for the pre-flight disk check and
/// the progress bar's total when the server omits Content-Length.
struct RuntimeArtifact {
    backend: &'static str,
    /// Extra archive fetched alongside the main one (CUDA needs its runtime).
    url: &'static str,
    extra_url: Option<&'static str>,
    bytes: u64,
}

fn runtime_artifacts() -> Vec<RuntimeArtifact> {
    #[cfg(windows)]
    {
        vec![
            RuntimeArtifact {
                backend: "vulkan",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10238/llama-b10238-bin-win-vulkan-x64.zip",
                extra_url: None,
                bytes: 32 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cuda",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10238/llama-b10238-bin-win-cuda-13.3-x64.zip",
                extra_url: Some("https://github.com/ggml-org/llama.cpp/releases/download/b10238/cudart-llama-bin-win-cuda-13.3-x64.zip"),
                bytes: 509 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cpu",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10238/llama-b10238-bin-win-cpu-x64.zip",
                extra_url: None,
                bytes: 17 * 1024 * 1024,
            },
        ]
    }
    #[cfg(not(windows))]
    {
        vec![
            RuntimeArtifact {
                backend: "vulkan",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10238/llama-b10238-bin-ubuntu-vulkan-x64.tar.gz",
                extra_url: None,
                bytes: 30 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cpu",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10238/llama-b10238-bin-ubuntu-x64.tar.gz",
                extra_url: None,
                bytes: 15 * 1024 * 1024,
            },
        ]
    }
}

/// A model tier.
///
/// Vision (`mmproj`) is OPTIONAL. It used to be mandatory, because the copilot
/// reads the screen — but the screen is the least of what this app knows. The
/// journal already gives it the system, the station, the faction board, the
/// cargo, the missions and every event as it happens, and the copilot has
/// always had a text-only path for exactly that (`fireCopilotBeat` with no
/// scene). Requiring an mmproj shut the door on every text-only model, which is
/// most of the ones worth trying for narrative, in exchange for a feature that
/// is opt-in and off by default.
///
/// Mirrors are deliberately UNGATED: Google's own Gemma repos are licence-gated
/// on HuggingFace and 403 an unattended download.
#[derive(Clone)]
struct ModelArtifact {
    id: &'static str,
    label: &'static str,
    /// Minimum GPU budget (GB) this tier wants while the game is also running.
    needs_gb: f32,
    url: &'static str,
    mmproj_url: Option<&'static str>,
    /// A co-trained multi-token-prediction drafter, where the family ships one.
    ///
    /// Measured on an RX 7800 XT with E4B: generation went 8 -> 15 tok/s, a
    /// comms scene 2536 -> 2011 ms and a copilot answer 9480 -> 8440 ms, for
    /// ~200 MiB of card and ~99 MB on disk. It is not a second model in the
    /// ordinary speculative-decoding sense — it shares activations with the
    /// base model, which is why something this small is worth loading at all.
    /// Output is identical to normal generation; only the speed changes.
    drafter_url: Option<&'static str>,
    bytes: u64,
    licence: &'static str,
}

/// Deliberately TWO entries: the speed pick and the quality pick, both Gemma.
/// The catalogue held five models at its widest (E2B, E4B, Qwen 3.5 4B,
/// Llama 3.1 8B, GLM 4.6V) and every extra one was measured worse for this
/// app on this generation of hardware. A new entry earns its place with
/// measurements, not a spec sheet — the harnesses in scripts/ (comms-lore,
/// comms-build-probe, probeG, bench-engine) are the bar it has to clear, and
/// four candidates failed it on 2026-08-24/25 before the 12B QAT passed.
fn model_artifacts() -> Vec<ModelArtifact> {
    vec![
        ModelArtifact {
            id: "gemma-4-e4b",
            label: "Gemma 4 E4B — vision, tools, and a fast-generation helper",
            needs_gb: 4.5,
            url: "https://huggingface.co/lmstudio-community/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
            mmproj_url: Some("https://huggingface.co/lmstudio-community/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-BF16.gguf"),
            drafter_url: Some("https://huggingface.co/AtomicChat/gemma-4-E4B-it-assistant-GGUF/resolve/main/gemma-4-E4B-it-assistant.Q8_0.gguf"),
            // Measured from the CDN: 4.97 GB model + 0.92 GB mmproj + 0.10 GB drafter.
            bytes: 6_050_000_000,
            licence: "Gemma Terms of Use",
        },
        // The Qwen 3.5 9B "Defiant Fable" held a second slot for one day
        // (2026-08-24 → 25). It earned it through the full battery — comms
        // 6/6, gate 6/6, news 3/3, tool loop passed — and was removed by
        // product decision after live sessions: half E4B's speed, no screen
        // glance, and the comms prompt refinements closed the prose gap that
        // was its whole case. The battery record stays in git history; a
        // return visit starts from the same bar.
        ModelArtifact {
            id: "gemma-4-12b-qat",
            label: "Gemma 4 12B QAT — the finer voice: slower, sharper scenes (vision; fast-generation on GPU)",
            needs_gb: 8.0,
            url: "https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/gemma-4-12B-it-qat-UD-Q4_K_XL.gguf",
            mmproj_url: Some("https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/mmproj-BF16.gguf"),
            // Co-trained MTP drafter. GPU ONLY by the existing launch gate:
            // measured on the 9800X3D it made CPU comms 44% SLOWER (14.7 s vs
            // 10.2 s bare) — the third drafter to lose on the CPU path — while
            // the same co-trained design took E4B from 8 to 15 tok/s on the card.
            drafter_url: Some("https://huggingface.co/unsloth/gemma-4-12B-it-qat-GGUF/resolve/main/mtp-gemma-4-12B-it.gguf"),
            // 6.72 GB model + 0.18 GB mmproj + 0.25 GB drafter.
            //
            // Earned its slot 2026-08-25, fourth candidate through the door
            // that day (Defiant retired, official Qwen3.5-9B and a Llama MoE
            // both refused): comms 10/10 with the best scene discipline of
            // any model tested — real factions end to end, situations played
            // rather than ignored — at 10.2 s a scene on the CPU, a pace the
            // slot TTLs already absorb. Gate 5/6 (one payout miss the old
            // non-QAT 12B did not make), news 3/3, tool loop clean. This is
            // the quality tier: E4B stays the default and the speed pick.
            bytes: 7_150_000_000,
            licence: "Apache 2.0",
        },
    ]
}

// ---------------------------------------------------------------- paths

fn engine_root(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("engine");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn runtime_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(engine_root(app)?.join("runtime"))
}

fn models_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(engine_root(app)?.join("models"))
}

/// Where we remember the engine's PID, so a crashed or force-killed app can
/// still clean up its orphan on the next launch (the graceful exits handle
/// themselves; Task Manager and hard crashes do not).
/// Where the engine's stdout/stderr is kept, for diagnosing a crash after it.
fn engine_log_path(app: &AppHandle) -> PathBuf {
    engine_root(app)
        .map(|d| d.join("engine.log"))
        .unwrap_or_else(|_| PathBuf::from("engine.log"))
}

/// The tail of the engine log — what it said before it died.
#[tauri::command]
pub fn engine_log(app: AppHandle) -> String {
    let Ok(text) = fs::read_to_string(engine_log_path(&app)) else {
        return String::new();
    };
    let lines: Vec<&str> = text.lines().collect();
    lines[lines.len().saturating_sub(40)..].join("
")
}

fn pid_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(engine_root(app)?.join("engine.pid"))
}

/// Remember EVERY engine we spawn, not just the newest.
///
/// The file used to hold one pid, overwritten each start — so if two engines
/// were ever orphaned (two hard kills, or a restart-in-place that failed to
/// stop the old one), the earlier one became unreachable and lived on holding
/// gigabytes. Appending costs nothing and makes the reaper exhaustive.
fn record_pid(app: &AppHandle, pid: u32) {
    if let Ok(p) = pid_file(app) {
        let mut pids: Vec<String> = fs::read_to_string(&p)
            .unwrap_or_default()
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();
        pids.push(pid.to_string());
        // Bounded: older entries are long dead, and the list must not grow
        // without limit across a long-lived install.
        let start = pids.len().saturating_sub(8);
        let _ = fs::write(p, pids[start..].join("
"));
    }
}

fn clear_pid(app: &AppHandle) {
    if let Ok(p) = pid_file(app) {
        let _ = fs::remove_file(p);
    }
}

/// A Windows job object that kills its children when this process exits.
///
/// A shutdown hook cannot help when the app is ended from Task Manager, loses
/// power, or panics — and an orphaned llama-server holds several gigabytes of
/// RAM and the GPU allocation, which is exactly what a "somehow slower" restart
/// feels like. The PID file and the reaper below are a best-effort mop-up after
/// the fact; this stops it happening at all. Every handle to the job closes
/// when the process dies, and Windows then terminates everything inside it.
#[cfg(windows)]
mod kill_on_exit {
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::HANDLE;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        JobObjectExtendedLimitInformation,
    };

    /// Raw handle kept for the life of the process; dropping it is the trigger.
    struct Job(HANDLE);
    // The handle is only ever read, and Windows handles are process-wide.
    unsafe impl Send for Job {}
    unsafe impl Sync for Job {}

    static JOB: OnceLock<Option<Job>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 { None } else { Some(Job(h)) }
        })
        .as_ref()
        .map(|j| j.0)
    }

    /// Tie a spawned child to this process's lifetime. Failure is not fatal —
    /// the PID file and reaper still cover it, just less reliably.
    pub fn adopt(child: &Child) {
        let Some(j) = job() else { return };
        unsafe {
            AssignProcessToJobObject(j, child.as_raw_handle() as HANDLE);
        }
    }
}

/// Kill an engine left behind by a previous run. Only ever targets a live
/// process whose image is our own `llama-server`, so a recycled PID belonging to
/// something else is never touched.
pub fn reap_orphan_engine(app: &AppHandle) {
    let Ok(path) = pid_file(app) else { return };
    let Ok(text) = fs::read_to_string(&path) else { return };
    let _ = fs::remove_file(&path);
    // Every engine this install ever started and did not cleanly stop. Only
    // pids we spawned ourselves are ever touched — never a sweep by name or
    // path, which would take out a second copy of the app, or LM Studio.
    for line in text.lines() {
        let Ok(pid) = line.trim().parse::<u32>() else { continue };
        kill_if_engine(pid);
    }
}

/// Kill one pid, but only if it is still a llama-server. A pid the OS has since
/// recycled onto some other program must survive untouched.
fn kill_if_engine(pid: u32) {
    #[cfg(windows)]
    {
        // /FI on both PID and image name: a stale PID reused by another program
        // will not match, so nothing else can be killed by accident.
        let mut cmd = Command::new("taskkill");
        cmd.args(["/F", "/FI", &format!("PID eq {pid}"), "/FI", "IMAGENAME eq llama-server.exe"])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
        let _ = cmd.status();
    }
    #[cfg(not(windows))]
    {
        // Verify the process really is ours before signalling it.
        let ok = fs::read_to_string(format!("/proc/{pid}/comm"))
            .map(|c| c.trim() == "llama-server")
            .unwrap_or(false);
        if ok {
            let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
        }
    }
}

fn server_exe(dir: &Path) -> PathBuf {
    dir.join(if cfg!(windows) { "llama-server.exe" } else { "llama-server" })
}

/// The extracted runtime, if a usable `llama-server` is present.
fn installed_runtime(app: &AppHandle) -> Option<PathBuf> {
    let dir = runtime_dir(app).ok()?;
    let exe = server_exe(&dir);
    exe.is_file().then_some(dir)
}

// ---------------------------------------------------------------- state

#[derive(Default)]
pub struct EngineCtl {
    /// Set to cancel the download in flight.
    pub cancel: Arc<AtomicBool>,
    pub proc: Mutex<Option<RunningEngine>>,
}

pub struct RunningEngine {
    child: Child,
    port: u16,
    api_key: String,
    model_id: String,
}

#[derive(Serialize)]
pub struct EngineStatus {
    runtime_installed: bool,
    runtime_backend: Option<String>,
    /// llama.cpp build actually on disk (from build.txt), when known.
    runtime_build: Option<String>,
    /// The build this app is pinned to — what a fresh install would fetch.
    runtime_latest: String,
    /// An older runtime is installed than the one we ship against. It keeps
    /// working, so this is an offer rather than an error: build.txt has been
    /// written since the first release and never read, which meant a bumped
    /// pin only ever reached NEW installs while everyone else silently stayed
    /// on the old build forever.
    runtime_outdated: bool,
    recommended_backend: String,
    models: Vec<ModelInfo>,
    running: bool,
    port: Option<u16>,
    api_key: Option<String>,
    running_model: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct ModelInfo {
    id: String,
    label: String,
    /// Bytes on disk once installed, or the download size when not.
    bytes: u64,
    installed: bool,
    /// Bytes already fetched into a `.part` file — lets the UI say "resume"
    /// instead of pretending a cancelled download never happened.
    partial_bytes: u64,
    /// Present for models discovered outside our own directory (LM Studio).
    external_path: Option<String>,
    needs_gb: f32,
    licence: String,
    /**
     * Can this model actually SEE?
     *
     * Reported from the projector file on disk, not from the catalogue's
     * intent, because that is the thing the engine will or will not have been
     * launched with. The app used to take vision for granted on the bundled
     * engine — every shipped model had an mmproj, and the code said so — and
     * making the projector optional quietly broke that: the screen glance kept
     * firing at a text-only model and the server answered every one with
     * `image input is not supported`, which read from the outside as an
     * operator that had simply gone quiet.
     */
    vision: bool,
}

// ---------------------------------------------------------------- downloader

#[derive(Serialize, Clone)]
struct Progress<'a> {
    phase: &'a str,
    received: u64,
    total: u64,
}

fn emit_progress(app: &AppHandle, phase: &str, received: u64, total: u64) {
    let _ = app.emit("engine-progress", Progress { phase, received, total });
}

/// Stream a URL to `dest`, resuming a partial `.part` file when present and
/// reporting progress at a human interval (never per chunk). Cancellable.
async fn download_file(
    app: &AppHandle,
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
    phase: &str,
    cancel: &AtomicBool,
) -> Result<(), String> {
    if dest.is_file() {
        return Ok(()); // already have it
    }
    let part = dest.with_extension("part");
    let have = fs::metadata(&part).map(|m| m.len()).unwrap_or(0);

    let mut req = client.get(url);
    if have > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={have}-"));
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("download failed: {e}"))?;

    // A server that ignores Range restarts the file — do not append to garbage.
    let resuming = resp.status() == reqwest::StatusCode::PARTIAL_CONTENT && have > 0;
    let total = resp.content_length().unwrap_or(0) + if resuming { have } else { 0 };
    let mut received = if resuming { have } else { 0 };

    let mut file = fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(resuming)
        .truncate(!resuming)
        .open(&part)
        .map_err(|e| e.to_string())?;

    let mut stream = resp.bytes_stream();
    let mut last = Instant::now();
    emit_progress(app, phase, received, total);
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::Relaxed) {
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("download failed: {e}"))?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        received += chunk.len() as u64;
        if last.elapsed() >= Duration::from_millis(400) {
            emit_progress(app, phase, received, total);
            last = Instant::now();
        }
    }
    file.flush().map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&part, dest).map_err(|e| e.to_string())?;
    emit_progress(app, phase, received, total.max(received));
    Ok(())
}

/// SHA-256 of a file, streamed (these are multi-GB).
fn sha256_file(path: &Path) -> Result<String, String> {
    let mut f = fs::File::open(path).map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    std::io::copy(&mut f, &mut hasher).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", hasher.finalize()))
}

/// Free space on the volume holding `path`, in bytes (best-effort).
#[cfg(windows)]
fn free_space(path: &Path) -> Option<u64> {
    use std::os::windows::ffi::OsStrExt;
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut free: u64 = 0;
    // GetDiskFreeSpaceExW via the already-linked kernel32.
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetDiskFreeSpaceExW(
            lpDirectoryName: *const u16,
            lpFreeBytesAvailableToCaller: *mut u64,
            lpTotalNumberOfBytes: *mut u64,
            lpTotalNumberOfFreeBytes: *mut u64,
        ) -> i32;
    }
    let ok = unsafe { GetDiskFreeSpaceExW(wide.as_ptr(), &mut free, std::ptr::null_mut(), std::ptr::null_mut()) };
    (ok != 0).then_some(free)
}

#[cfg(not(windows))]
fn free_space(_path: &Path) -> Option<u64> {
    None // best-effort only; the download still fails cleanly if the disk fills
}

fn ensure_space(dir: &Path, need: u64) -> Result<(), String> {
    if let Some(free) = free_space(dir) {
        // Keep a 1 GB margin so we never fill the user's system volume.
        if free < need + 1024 * 1024 * 1024 {
            return Err(format!(
                "not enough disk space — need about {:.1} GB free, have {:.1} GB",
                (need as f64) / 1e9,
                (free as f64) / 1e9
            ));
        }
    }
    Ok(())
}

/// Extract a llama.cpp release archive: a zip on Windows, a tarball on Linux.
/// Linux releases carry versioned `.so` symlinks, so the system `tar` does that
/// job (the same reasoning as `stt_download`) rather than a Rust tar crate.
fn extract_runtime_archive(path: &Path, dir: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let bytes = fs::read(path).map_err(|e| e.to_string())?;
        extract_runtime_zip(&bytes, dir)
    }
    #[cfg(not(windows))]
    {
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(path)
            .arg("-C")
            .arg(dir)
            .arg("--strip-components=1")
            .status()
            .map_err(|e| format!("tar failed: {e}"))?;
        if !status.success() {
            return Err("could not unpack the runtime archive".into());
        }
        // Releases nest the payload under build/bin/ — flatten what we need.
        for sub in ["build/bin", "bin"] {
            let nested = dir.join(sub);
            if nested.is_dir() {
                if let Ok(entries) = fs::read_dir(&nested) {
                    for e in entries.flatten() {
                        let from = e.path();
                        if let Some(name) = from.file_name() {
                            let _ = fs::rename(&from, dir.join(name));
                        }
                    }
                }
            }
        }
        use std::os::unix::fs::PermissionsExt;
        let exe = server_exe(dir);
        if exe.is_file() {
            let _ = fs::set_permissions(&exe, fs::Permissions::from_mode(0o755));
        }
        Ok(())
    }
}

/// Extract the files we actually need from a llama.cpp release zip (the binary
/// plus its DLLs/shared objects — not the sample and test executables).
#[cfg(windows)]
fn extract_runtime_zip(bytes: &[u8], dir: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| format!("bad archive: {e}"))?;
    for i in 0..archive.len() {
        let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
        if f.is_dir() {
            continue;
        }
        let name = f.name().rsplit('/').next().unwrap_or("").to_string();
        let keep = name == "llama-server"
            || name == "llama-server.exe"
            || name.ends_with(".dll")
            || name.contains(".so");
        if !keep || name.is_empty() {
            continue;
        }
        let mut out = Vec::new();
        std::io::Read::read_to_end(&mut f, &mut out).map_err(|e| e.to_string())?;
        let dest = dir.join(&name);
        fs::write(&dest, &out).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if name == "llama-server" {
                let _ = fs::set_permissions(&dest, fs::Permissions::from_mode(0o755));
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------- commands

/// Which backend this machine should prefer, from the GPU report.
pub fn recommend_backend(gpu_names: &[String]) -> String {
    let has_nvidia = gpu_names.iter().any(|n| n.to_lowercase().contains("nvidia"));
    if has_nvidia {
        "cuda".into()
    } else if gpu_names.is_empty() {
        "cpu".into()
    } else {
        "vulkan".into()
    }
}

#[tauri::command]
pub fn engine_status(app: AppHandle, ctl: State<'_, EngineCtl>, gpus: Vec<String>) -> EngineStatus {
    status_of(&app, &ctl, gpus)
}

/// The status body, callable internally (a `State` cannot be cloned, and the
/// lock must never be held across a re-entrant call).
fn status_of(app: &AppHandle, ctl: &EngineCtl, gpus: Vec<String>) -> EngineStatus {
    let app = app.clone();
    let runtime = installed_runtime(&app);
    let mdir = models_dir(&app).unwrap_or_default();
    let models = model_artifacts()
        .iter()
        .map(|m| {
            let path = mdir.join(format!("{}.gguf", m.id));
            let installed = path.is_file()
                && (m.mmproj_url.is_none() || mdir.join(format!("{}.mmproj.gguf", m.id)).is_file());
            // Sum any partial transfers so an interrupted download is visible.
            let part = |n: String| fs::metadata(mdir.join(n)).map(|x| x.len()).unwrap_or(0);
            let partial_bytes = if installed {
                0
            } else {
                part(format!("{}.part", m.id))
                    + part(format!("{}.mmproj.part", m.id))
                    + part(format!("{}.drafter.part", m.id))
                    + if path.is_file() { fs::metadata(&path).map(|x| x.len()).unwrap_or(0) } else { 0 }
            };
            let has_vision = mdir.join(format!("{}.mmproj.gguf", m.id)).is_file();
            ModelInfo {
                id: m.id.into(),
                label: m.label.into(),
                bytes: if installed {
                    fs::metadata(&path).map(|x| x.len()).unwrap_or(m.bytes)
                } else {
                    m.bytes
                },
                installed,
                partial_bytes,
                external_path: None,
                needs_gb: m.needs_gb,
                licence: m.licence.into(),
                vision: has_vision,
            }
        })
        .collect();
    let proc = ctl.proc.lock().unwrap();
    let rt_dir = runtime_dir(&app).unwrap_or_default();
    let runtime_build = fs::read_to_string(rt_dir.join("build.txt"))
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());
    EngineStatus {
        runtime_installed: runtime.is_some(),
        runtime_backend: fs::read_to_string(rt_dir.join("backend.txt"))
            .ok()
            .map(|s| s.trim().to_string()),
        // A runtime with no build.txt predates the marker entirely — that is
        // older than anything we ship, so it counts as outdated too.
        runtime_outdated: runtime.is_some()
            && runtime_build.as_deref() != Some(LLAMA_BUILD),
        runtime_build,
        runtime_latest: LLAMA_BUILD.to_string(),
        recommended_backend: recommend_backend(&gpus),
        models,
        running: proc.is_some(),
        port: proc.as_ref().map(|p| p.port),
        api_key: proc.as_ref().map(|p| p.api_key.clone()),
        running_model: proc.as_ref().map(|p| p.model_id.clone()),
    }
}

/// T7.3.4 — reuse a GGUF the user already downloaded (e.g. via LM Studio),
/// skipping a multi-GB pull. Only pairs with a matching `mmproj` qualify: the
/// copilot needs vision.
#[tauri::command]
pub fn engine_scan_local_models() -> Vec<ModelInfo> {
    let mut found = Vec::new();
    let Some(home) = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME")) else {
        return found;
    };
    let root = PathBuf::from(home).join(".lmstudio").join("models");
    let mut stack = vec![root];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        let mut ggufs: Vec<PathBuf> = Vec::new();
        for e in entries.flatten() {
            let p = e.path();
            if p.is_dir() {
                stack.push(p);
            } else if p.extension().and_then(|x| x.to_str()) == Some("gguf") {
                ggufs.push(p);
            }
        }
        // A usable pair: one mmproj + one non-mmproj model in the same folder.
        let is_mm = |p: &PathBuf| {
            p.file_name()
                .and_then(|n| n.to_str())
                .map(|n| n.to_lowercase().contains("mmproj"))
                .unwrap_or(false)
        };
        let mmproj = ggufs.iter().find(|p| is_mm(p)).cloned();
        let model = ggufs.iter().find(|p| !is_mm(p)).cloned();
        if let (Some(mm), Some(md)) = (mmproj, model) {
            let bytes = fs::metadata(&md).map(|m| m.len()).unwrap_or(0);
            found.push(ModelInfo {
                id: format!("local:{}", md.display()),
                label: md
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("local model")
                    .to_string(),
                bytes,
                installed: true,
                partial_bytes: 0,
                external_path: Some(format!("{}|{}", md.display(), mm.display())),
                needs_gb: (bytes as f32 / 1e9) + 1.0,
                licence: "as provided by the model publisher".into(),
                // Only pairs WITH a projector are discovered here, so this
                // branch is vision-capable by construction.
                vision: true,
            });
        }
    }
    found
}

#[tauri::command]
pub fn engine_cancel_download(ctl: State<'_, EngineCtl>) {
    ctl.cancel.store(true, Ordering::Relaxed);
}

#[tauri::command]
pub async fn engine_download_runtime(
    app: AppHandle,
    ctl: State<'_, EngineCtl>,
    backend: String,
) -> Result<(), String> {
    let art = runtime_artifacts()
        .into_iter()
        .find(|a| a.backend == backend)
        .ok_or_else(|| format!("unknown backend '{backend}' for this platform"))?;
    let dir = runtime_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ensure_space(&dir, art.bytes)?;

    let cancel = ctl.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    let ext = if art.url.ends_with(".tar.gz") { "tar.gz" } else { "zip" };
    let tmp = dir.join(format!("runtime.{ext}"));
    download_file(&app, &client, art.url, &tmp, "runtime", &cancel).await?;
    emit_progress(&app, "extracting", 0, 0);
    extract_runtime_archive(&tmp, &dir)?;
    let _ = fs::remove_file(&tmp);

    if let Some(extra) = art.extra_url {
        let tmp2 = dir.join("runtime-extra.zip");
        download_file(&app, &client, extra, &tmp2, "runtime-extra", &cancel).await?;
        emit_progress(&app, "extracting", 0, 0);
        extract_runtime_archive(&tmp2, &dir)?;
        let _ = fs::remove_file(&tmp2);
    }

    if !server_exe(&dir).is_file() {
        return Err("runtime archive did not contain llama-server".into());
    }
    fs::write(dir.join("backend.txt"), &backend).map_err(|e| e.to_string())?;
    fs::write(dir.join("build.txt"), LLAMA_BUILD).map_err(|e| e.to_string())?;
    emit_progress(&app, "runtime-done", 1, 1);
    Ok(())
}

#[tauri::command]
pub async fn engine_download_model(
    app: AppHandle,
    ctl: State<'_, EngineCtl>,
    model_id: String,
) -> Result<(), String> {
    let art = model_artifacts()
        .into_iter()
        .find(|m| m.id == model_id)
        .ok_or_else(|| format!("unknown model '{model_id}'"))?;
    let dir = models_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    ensure_space(&dir, art.bytes)?;

    let cancel = ctl.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;

    download_file(&app, &client, art.url, &dir.join(format!("{}.gguf", art.id)), "model", &cancel)
        .await?;
    if let Some(mm) = art.mmproj_url {
        download_file(&app, &client, mm, &dir.join(format!("{}.mmproj.gguf", art.id)), "mmproj", &cancel)
            .await?;
    }
    // The MTP drafter is an OPTIMISATION, so its failure must not fail the
    // download. It roughly doubles generation speed when present, and when it
    // is absent the launcher simply omits the speculative flags and the engine
    // runs exactly as it did before. Making this fatal would turn a 99 MB
    // nicety into a reason a 6 GB download has to be started again.
    if let Some(url) = art.drafter_url {
        let path = dir.join(format!("{}.drafter.gguf", art.id));
        if let Err(e) = download_file(&app, &client, url, &path, "drafter", &cancel).await {
            let _ = fs::remove_file(&path);
            eprintln!("drafter download skipped: {e}");
        }
    }
    emit_progress(&app, "model-done", 1, 1);
    Ok(())
}

/// Fetch the MTP drafter for an ALREADY-INSTALLED model, if it is missing.
///
/// Without this the speed-up would only ever reach fresh installs. A commander
/// who downloaded the model before drafters existed has a complete, valid
/// install — model and mmproj both present — so nothing in the normal download
/// path would ever run again, and they would sit at half the generation speed
/// for ever unless they deleted six gigabytes and started over.
///
/// Called on engine start and deliberately quiet: it returns Ok(false) when
/// there is nothing to do, when the model has no drafter, or when the fetch
/// fails. A missing drafter costs speed, never correctness — the launcher just
/// omits the speculative flags.
#[tauri::command]
pub async fn engine_ensure_drafter(
    app: AppHandle,
    ctl: State<'_, EngineCtl>,
    model_id: String,
) -> Result<bool, String> {
    let Some(art) = model_artifacts().into_iter().find(|m| m.id == model_id) else {
        return Ok(false);
    };
    let Some(url) = art.drafter_url else { return Ok(false) };
    let dir = models_dir(&app)?;
    // Only for a model that is actually installed — never pull a 99 MB drafter
    // for something the commander has not chosen to download.
    if !dir.join(format!("{}.gguf", art.id)).is_file() {
        return Ok(false);
    }
    let path = dir.join(format!("{}.drafter.gguf", art.id));
    if path.is_file() {
        return Ok(false);
    }
    let cancel = ctl.cancel.clone();
    cancel.store(false, Ordering::Relaxed);
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(15))
        .build()
        .map_err(|e| e.to_string())?;
    match download_file(&app, &client, url, &path, "drafter", &cancel).await {
        Ok(()) => Ok(true),
        Err(e) => {
            let _ = fs::remove_file(&path);
            eprintln!("drafter top-up skipped: {e}");
            Ok(false)
        }
    }
}

#[tauri::command]
pub fn engine_remove_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{model_id}.gguf")));
    let _ = fs::remove_file(dir.join(format!("{model_id}.mmproj.gguf")));
    // The MTP drafter goes with it, or "remove" leaves 99 MB behind for a model
    // that is no longer there.
    let _ = fs::remove_file(dir.join(format!("{model_id}.drafter.gguf")));
    Ok(())
}

/// Throw away an interrupted transfer and reclaim the disk (the "Discard"
/// beside a paused download).
#[tauri::command]
pub fn engine_discard_partial(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{model_id}.part")));
    let _ = fs::remove_file(dir.join(format!("{model_id}.mmproj.part")));
    let _ = fs::remove_file(dir.join(format!("{model_id}.drafter.part")));
    // A finished main file with no mmproj is also an incomplete install.
    if !dir.join(format!("{model_id}.mmproj.gguf")).is_file() {
        let _ = fs::remove_file(dir.join(format!("{model_id}.gguf")));
    }
    Ok(())
}

/// Verify an installed model's integrity by hashing it (slow; user-initiated).
#[tauri::command]
pub fn engine_hash_model(app: AppHandle, model_id: String) -> Result<String, String> {
    sha256_file(&models_dir(&app)?.join(format!("{model_id}.gguf")))
}

// ---------------------------------------------------------------- lifecycle

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .ok()
        .and_then(|l| l.local_addr().ok())
        .map(|a| a.port())
        .unwrap_or(8099)
}

/// A per-session loopback token. Not cryptographic secrecy — it stops other
/// local processes from quietly using the engine, and (crucially) pins the key
/// so an inherited `LLAMA_API_KEY` cannot lock us out of our own server.
fn session_key() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mut hasher = Sha256::new();
    hasher.update(nanos.to_le_bytes());
    hasher.update(std::process::id().to_le_bytes());
    format!("{:x}", hasher.finalize())[..32].to_string()
}

#[tauri::command]
pub async fn engine_start(
    app: AppHandle,
    ctl: State<'_, EngineCtl>,
    model_id: String,
    gpu_layers: Option<i32>,
    ctx_size: Option<u32>,
    vision_on_cpu: Option<bool>,
    reasoning_budget: Option<i32>,
) -> Result<EngineStatus, String> {
    // Idempotent: already serving this model is success, not an error. Compute
    // under a short-lived lock — status_of() locks again, so the guard must be
    // dropped before we call it.
    let already = {
        let guard = ctl.proc.lock().unwrap();
        guard.as_ref().map(|p| p.model_id == model_id).unwrap_or(false)
    };
    if already {
        return Ok(status_of(&app, &ctl, vec![]));
    }
    stop_engine(&ctl);

    let dir = installed_runtime(&app).ok_or("the inference runtime is not installed yet")?;
    let (model, mmproj) = resolve_model_paths(&app, &model_id)?;
    let port = free_port();
    let key = session_key();

    let mut cmd = Command::new(server_exe(&dir));
    cmd.arg("--model").arg(&model);
    if let Some(mm) = &mmproj {
        cmd.arg("--mmproj").arg(mm);
    }
    cmd.arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--api-key")
        .arg(&key)
        .arg("--ctx-size")
        .arg(ctx_size.unwrap_or(8192).to_string())
        // One slot, explicitly. llama.cpp defaults to FOUR, which lets several
        // generations decode on the GPU at once — and the app can briefly have
        // two in flight, because superseding a request cancels it
        // asynchronously and the old one keeps going until its next chunk. Two
        // decodes plus a running game is a frame hitch. With one slot the
        // server serialises them instead, and the whole context belongs to the
        // single request rather than being shared four ways.
        .arg("--parallel")
        .arg("1")
        .arg("-ngl")
        .arg(gpu_layers.unwrap_or(99).to_string())
        // Quantise the K/V cache to 8 bits. Measured on an RX 7800 XT with
        // gemma-4-e4b at ctx 32768: 3818 -> 3563 MiB on the card and 7542 ->
        // 6997 MiB of RAM, with comms and copilot latency unchanged inside
        // run-to-run noise. Near-lossless at q8_0 — it is q4 that costs
        // accuracy — so this is memory handed back to the game for nothing.
        //
        // Worth recording what did NOT work, so it is not retried: cutting
        // --ctx-size from 32768 to 8192 saved only ~430 MiB, because Gemma's
        // grouped-query plus sliding-window attention makes its KV cache small
        // to begin with. The context length is not where the VRAM goes; the
        // weights are.
        .arg("-ctk")
        .arg("q8_0")
        .arg("-ctv")
        .arg("q8_0");

    // Multi-token prediction, when this model shipped a drafter and it actually
    // downloaded. Measured on an RX 7800 XT with gemma-4-e4b: generation 8 ->
    // 15 tok/s, a comms scene 2536 -> 2011 ms, a copilot answer 9480 -> 8440
    // ms, for ~200 MiB of card. Three draft tokens, not five: at five the
    // rejection rate ate the gain and it measured slower (13 tok/s).
    //
    // Absent drafter, absent flags — an install from before this existed keeps
    // working exactly as it did.
    //
    // Never on the processor. Speculative decoding wins by verifying several
    // drafted tokens in ONE batched forward pass, which is a GPU's trick; on
    // the CPU the draft costs about what it saves and measured slower — a
    // comms scene went 1706 -> 2168 ms with the drafter attached at -ngl 0.
    let on_gpu = gpu_layers.unwrap_or(99) > 0;
    let drafter = models_dir(&app)
        .map(|d| d.join(format!("{model_id}.drafter.gguf")))
        .ok()
        .filter(|p| on_gpu && p.is_file());
    if let Some(path) = drafter {
        cmd.arg("--spec-type")
            .arg("draft-mtp")
            .arg("--spec-draft-model")
            .arg(&path)
            .arg("--spec-draft-n-max")
            .arg("3")
            .arg("-ngld")
            .arg("99");
    }
    // Keep the vision projector off the card unless asked otherwise. It only
    // runs when a screen glance fires (opt-in, off by default), and measured on
    // an RX 7800 XT it costs 0.9-2.2 GB of VRAM for no gain to the text beats
    // the operator actually speaks with — the cheapest headroom the app can
    // hand back to the game's renderer.
    if vision_on_cpu.unwrap_or(false) {
        cmd.arg("--no-mmproj-offload");
    }
    // Cap hidden reasoning at the SERVER for models that cannot be told to skip
    // it per-request. GLM-4.6V faults the AMD Vulkan driver the moment a request
    // carries `chat_template_kwargs: {enable_thinking:false}` — reproduced 3/3,
    // and unfixed by a newer llama.cpp, -fa off, --cache-reuse 0 or
    // --kv-unified. Capping here instead is stable 8/8 and just as fast, at the
    // cost of needing a restart to change (which is why it is a launch flag).
    if let Some(budget) = reasoning_budget {
        cmd.arg("--reasoning-budget").arg(budget.to_string());
    }
    // Keep the engine's own log. It was going to /dev/null, so when the server
    // died mid-session the only record anywhere was a Windows crash bucket —
    // 0xC00000FD, a stack overflow inside llama.cpp, which no amount of staring
    // at our own code would have revealed. Truncated each start so it stays
    // small and always describes the run that is actually going.
    //
    // Rotate before truncating: when the engine crashes mid-session the user's
    // next click is Restart, and truncation was destroying the one log that
    // said why it died (it happened live — "engine stopped", restarted, and
    // the evidence was gone). engine.prev.log always holds the previous run.
    let log_path = engine_log_path(&app);
    let _ = fs::rename(&log_path, log_path.with_extension("prev.log"));
    match fs::File::create(&log_path) {
        Ok(f) => {
            let err = f.try_clone().unwrap_or_else(|_| f.try_clone().expect("dup"));
            cmd.stdout(Stdio::from(f)).stderr(Stdio::from(err));
        }
        Err(_) => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }
    // Spike finding #1: scrub ambient llama/OpenAI env so the server cannot
    // pick up a foreign API key or CLI defaults and reject our own calls.
    for var in [
        "LLAMA_API_KEY",
        "LLAMA_BASE_URL",
        "LLAMA_MODEL",
        "OPENAI_API_KEY",
        "OPENAI_BASE_URL",
    ] {
        cmd.env_remove(var);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let child = cmd.spawn().map_err(|e| format!("could not start the engine: {e}"))?;
    // Bind it to this process's lifetime before anything else can go wrong.
    #[cfg(windows)]
    kill_on_exit::adopt(&child);
    record_pid(&app, child.id());
    *ctl.proc.lock().unwrap() = Some(RunningEngine {
        child,
        port,
        api_key: key.clone(),
        model_id: model_id.clone(),
    });

    // Readiness: model load is slow (~8 s in the spike, more on cold cache).
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(5))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("http://127.0.0.1:{port}/v1/models");
    for _ in 0..120 {
        // Surface a crash immediately rather than waiting out the timeout.
        {
            let mut guard = ctl.proc.lock().unwrap();
            if let Some(p) = guard.as_mut() {
                if let Ok(Some(status)) = p.child.try_wait() {
                    *guard = None;
                    return Err(format!("the engine exited during startup ({status})"));
                }
            } else {
                return Err("engine start was superseded".into());
            }
        }
        if client.get(&url).send().await.map(|r| r.status().is_success()).unwrap_or(false) {
            let _ = app.emit("engine-ready", json!({ "port": port, "model": model_id }));
            return Ok(status_of(&app, &ctl, vec![]));
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    stop_engine(&ctl);
    Err("the engine did not become ready in time".into())
}

/// The model file, and its vision projector if it has one.
///
/// A missing projector is no longer an error. Text-only models are the majority
/// of what is worth trying for prose, and the copilot reads the journal — the
/// system, the station, the faction board, the cargo, every event — with or
/// without a screenshot. What it loses is the opt-in screen glance, which is
/// off by default anyway.
fn resolve_model_paths(app: &AppHandle, model_id: &str) -> Result<(PathBuf, Option<PathBuf>), String> {
    // An external (LM Studio) pair is passed through as "local:<model>|<mmproj>";
    // the mmproj half may be empty for a text-only model.
    if let Some(rest) = model_id.strip_prefix("local:") {
        let (m, mm) = rest.split_once('|').unwrap_or((rest, ""));
        let vision = if mm.is_empty() { None } else { Some(PathBuf::from(mm)) };
        return Ok((PathBuf::from(m), vision));
    }
    let dir = models_dir(app)?;
    let model = dir.join(format!("{model_id}.gguf"));
    if !model.is_file() {
        return Err("that model is not downloaded yet".into());
    }
    let mmproj = dir.join(format!("{model_id}.mmproj.gguf"));
    Ok((model, mmproj.is_file().then_some(mmproj)))
}

pub fn stop_engine(ctl: &EngineCtl) {
    if let Some(mut p) = ctl.proc.lock().unwrap().take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
}

/// Stop the engine AND forget its pid. The bare `stop_engine` leaves the file
/// behind, so after a clean exit the reaper spends its one slot chasing a dead
/// process instead of a real orphan.
pub fn stop_engine_and_clear(app: &AppHandle, ctl: &EngineCtl) {
    stop_engine(ctl);
    clear_pid(app);
}

#[tauri::command]
pub fn engine_stop(app: AppHandle, ctl: State<'_, EngineCtl>) {
    stop_engine(&ctl);
    clear_pid(&app);
}

/// Liveness poll for the HUD: reports whether the child is still alive, so a
/// crashed engine surfaces instead of silently timing out every request.
#[tauri::command]
pub fn engine_alive(ctl: State<'_, EngineCtl>) -> bool {
    let mut guard = ctl.proc.lock().unwrap();
    let dead = match guard.as_mut() {
        Some(p) => matches!(p.child.try_wait(), Ok(Some(_))),
        None => return false,
    };
    if dead {
        *guard = None;
        return false;
    }
    true
}

#[cfg(test)]
mod tests {
    use super::model_artifacts;

    #[test]
    fn bundled_catalog_is_deliberate() {
        // Every entry here walked through the measurement battery — this test
        // is the door. E4B is the default (fastest, vision, tools, drafter);
        // the 12B QAT is the quality tier, earned 2026-08-25 on scene
        // discipline. Both are Gemma: one profile, one set of quirks.
        let models = model_artifacts();
        assert_eq!(models.len(), 2);

        let e4b = &models[0];
        assert_eq!(e4b.id, "gemma-4-e4b");
        assert!(e4b.mmproj_url.is_some(), "E4B ships a vision projector");
        assert!(e4b.drafter_url.is_some(), "the MTP drafter is part of the tier");

        let qat = &models[1];
        assert_eq!(qat.id, "gemma-4-12b-qat");
        // The id must keep matching the Gemma profile pattern in
        // modelprofile.ts (/gemma[-_ ]?4/i) — it carries the family's
        // thinking and penalty settings.
        assert!(qat.id.contains("gemma-4"));
        assert!(qat.mmproj_url.is_some(), "the 12B sees the screen");
        assert!(qat.drafter_url.is_some(), "MTP pays on the GPU path");
    }
}
