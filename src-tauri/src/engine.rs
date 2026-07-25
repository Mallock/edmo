//! Bundled AI engine — the app fetches its own llama.cpp runtime and model so
//! LM Studio becomes optional rather than required (TASKS-1.0.md, M7.1–M7.4).
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
const LLAMA_BUILD: &str = "b10107";

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
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-vulkan-x64.zip",
                extra_url: None,
                bytes: 32 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cuda",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cuda-13.3-x64.zip",
                extra_url: Some("https://github.com/ggml-org/llama.cpp/releases/download/b10107/cudart-llama-bin-win-cuda-13.3-x64.zip"),
                bytes: 509 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cpu",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-win-cpu-x64.zip",
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
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-ubuntu-vulkan-x64.tar.gz",
                extra_url: None,
                bytes: 30 * 1024 * 1024,
            },
            RuntimeArtifact {
                backend: "cpu",
                url: "https://github.com/ggml-org/llama.cpp/releases/download/b10107/llama-b10107-bin-ubuntu-x64.tar.gz",
                extra_url: None,
                bytes: 15 * 1024 * 1024,
            },
        ]
    }
}

/// A model tier. Vision (`mmproj`) is required — the copilot reads the screen.
/// Mirrors are deliberately UNGATED: Google's own Gemma repos are licence-gated
/// on HuggingFace and 403 an unattended download.
#[derive(Clone)]
struct ModelArtifact {
    id: &'static str,
    label: &'static str,
    /// Minimum GPU budget (GB) this tier wants while the game is also running.
    needs_gb: f32,
    url: &'static str,
    mmproj_url: &'static str,
    bytes: u64,
    licence: &'static str,
}

fn model_artifacts() -> Vec<ModelArtifact> {
    vec![
        ModelArtifact {
            id: "gemma-4-e2b",
            label: "Gemma 4 E2B (smallest, 8 GB cards)",
            needs_gb: 2.5,
            url: "https://huggingface.co/lmstudio-community/gemma-4-E2B-it-GGUF/resolve/main/gemma-4-E2B-it-Q4_K_M.gguf",
            mmproj_url: "https://huggingface.co/lmstudio-community/gemma-4-E2B-it-GGUF/resolve/main/mmproj-gemma-4-E2B-it-BF16.gguf",
            // Measured from the CDN: 3.19 GB model + 0.92 GB mmproj.
            bytes: 4_150_000_000,
            licence: "Gemma Terms of Use",
        },
        ModelArtifact {
            id: "gemma-4-e4b",
            label: "Gemma 4 E4B (recommended)",
            needs_gb: 4.5,
            url: "https://huggingface.co/lmstudio-community/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf",
            mmproj_url: "https://huggingface.co/lmstudio-community/gemma-4-E4B-it-GGUF/resolve/main/mmproj-gemma-4-E4B-it-BF16.gguf",
            // Measured from the CDN: 4.97 GB model + 0.92 GB mmproj.
            bytes: 5_950_000_000,
            licence: "Gemma Terms of Use",
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
fn pid_file(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(engine_root(app)?.join("engine.pid"))
}

fn record_pid(app: &AppHandle, pid: u32) {
    if let Ok(p) = pid_file(app) {
        let _ = fs::write(p, pid.to_string());
    }
}

fn clear_pid(app: &AppHandle) {
    if let Ok(p) = pid_file(app) {
        let _ = fs::remove_file(p);
    }
}

/// Kill an engine left behind by a previous run. Only ever targets a live
/// process whose image is our own `llama-server`, so a recycled PID belonging to
/// something else is never touched.
pub fn reap_orphan_engine(app: &AppHandle) {
    let Ok(path) = pid_file(app) else { return };
    let Ok(text) = fs::read_to_string(&path) else { return };
    let _ = fs::remove_file(&path);
    let Ok(pid) = text.trim().parse::<u32>() else { return };
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
            let installed = path.is_file() && mdir.join(format!("{}.mmproj.gguf", m.id)).is_file();
            // Sum any partial transfers so an interrupted download is visible.
            let part = |n: String| fs::metadata(mdir.join(n)).map(|x| x.len()).unwrap_or(0);
            let partial_bytes = if installed {
                0
            } else {
                part(format!("{}.part", m.id))
                    + part(format!("{}.mmproj.part", m.id))
                    + if path.is_file() { fs::metadata(&path).map(|x| x.len()).unwrap_or(0) } else { 0 }
            };
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
            }
        })
        .collect();
    let proc = ctl.proc.lock().unwrap();
    EngineStatus {
        runtime_installed: runtime.is_some(),
        runtime_backend: fs::read_to_string(
            runtime_dir(&app).unwrap_or_default().join("backend.txt"),
        )
        .ok()
        .map(|s| s.trim().to_string()),
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
    download_file(
        &app,
        &client,
        art.mmproj_url,
        &dir.join(format!("{}.mmproj.gguf", art.id)),
        "mmproj",
        &cancel,
    )
    .await?;
    emit_progress(&app, "model-done", 1, 1);
    Ok(())
}

#[tauri::command]
pub fn engine_remove_model(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{model_id}.gguf")));
    let _ = fs::remove_file(dir.join(format!("{model_id}.mmproj.gguf")));
    Ok(())
}

/// Throw away an interrupted transfer and reclaim the disk (the "Discard"
/// beside a paused download).
#[tauri::command]
pub fn engine_discard_partial(app: AppHandle, model_id: String) -> Result<(), String> {
    let dir = models_dir(&app)?;
    let _ = fs::remove_file(dir.join(format!("{model_id}.part")));
    let _ = fs::remove_file(dir.join(format!("{model_id}.mmproj.part")));
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
    cmd.arg("--model")
        .arg(&model)
        .arg("--mmproj")
        .arg(&mmproj)
        .arg("--host")
        .arg("127.0.0.1")
        .arg("--port")
        .arg(port.to_string())
        .arg("--api-key")
        .arg(&key)
        .arg("--ctx-size")
        .arg(ctx_size.unwrap_or(8192).to_string())
        .arg("-ngl")
        .arg(gpu_layers.unwrap_or(99).to_string())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
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

fn resolve_model_paths(app: &AppHandle, model_id: &str) -> Result<(PathBuf, PathBuf), String> {
    // An external (LM Studio) pair is passed through as "local:<model>|<mmproj>".
    if let Some(rest) = model_id.strip_prefix("local:") {
        let (m, mm) = rest.split_once('|').ok_or("malformed local model id")?;
        return Ok((PathBuf::from(m), PathBuf::from(mm)));
    }
    let dir = models_dir(app)?;
    let model = dir.join(format!("{model_id}.gguf"));
    let mmproj = dir.join(format!("{model_id}.mmproj.gguf"));
    if !model.is_file() || !mmproj.is_file() {
        return Err("that model is not downloaded yet".into());
    }
    Ok((model, mmproj))
}

pub fn stop_engine(ctl: &EngineCtl) {
    if let Some(mut p) = ctl.proc.lock().unwrap().take() {
        let _ = p.child.kill();
        let _ = p.child.wait();
    }
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
