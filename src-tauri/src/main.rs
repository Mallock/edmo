// ED Mission Operator — Tauri shell.
//
// Rust owns the OS-facing transport; all mission intelligence lives in the
// tested TypeScript engine on the frontend:
//   * journal directory locate + newest-file tail (poll, read-only — X.3)
//   * snapshot readers with mid-rewrite retry (Missions/Status/Cargo/NavRoute/
//     Market/ShipLocker/Backpack/Outfitting/Shipyard/ModulesInfo/FCMaterials)
//   * LM Studio streaming proxy (avoids webview CORS, keeps X.2 auditable)
//   * Piper TTS sidecar (bundled local neural voice)
//   * global shortcuts, click-through, window-geometry persistence

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime};

use futures_util::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

const SNAPSHOT_FILES: [&str; 11] = [
    "Missions.json",
    "Status.json",
    "Cargo.json",
    "NavRoute.json",
    "Market.json",
    "ShipLocker.json",
    "Backpack.json",
    "Outfitting.json",
    "Shipyard.json",
    "ModulesInfo.json",
    "FCMaterials.json",
];
const POLL_MS: u64 = 600;

// ---------------------------------------------------------------- managed state

struct WatchCtl {
    generation: Arc<AtomicU64>,
}

struct LlmCtl {
    cancels: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct ClickThrough(AtomicBool);

#[derive(Serialize, Deserialize, Clone, Copy)]
struct Geom {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
}

struct GeomState {
    cur: Mutex<Option<Geom>>,
    last_save: Mutex<Instant>,
}

// ---------------------------------------------------------------- journal watch

#[cfg(windows)]
fn default_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    PathBuf::from(home)
        .join("Saved Games")
        .join("Frontier Developments")
        .join("Elite Dangerous")
}

/// On Linux, Elite runs through Steam Proton — the journal lives inside the
/// game's Proton prefix. Probe the common Steam layouts (native, symlinked,
/// Flatpak); fall back to the first candidate so the error message shows a
/// realistic path to fix in Settings.
#[cfg(not(windows))]
fn default_dir() -> PathBuf {
    let home = PathBuf::from(std::env::var("HOME").unwrap_or_default());
    const PFX: &str = "steamapps/compatdata/359320/pfx/drive_c/users/steamuser/Saved Games/Frontier Developments/Elite Dangerous";
    let candidates = [
        home.join(".local/share/Steam").join(PFX),
        home.join(".steam/steam").join(PFX),
        home.join(".var/app/com.valvesoftware.Steam/.local/share/Steam").join(PFX),
        home.join("snap/steam/common/.local/share/Steam").join(PFX),
    ];
    candidates
        .iter()
        .find(|p| p.is_dir())
        .cloned()
        .unwrap_or_else(|| candidates[0].clone())
}

fn expand_dir(raw: &str) -> PathBuf {
    let trimmed = raw.trim();
    if let Ok(home) = std::env::var("USERPROFILE") {
        if trimmed.to_ascii_uppercase().starts_with("%USERPROFILE%") {
            return PathBuf::from(format!("{}{}", home, &trimmed["%USERPROFILE%".len()..]));
        }
    }
    if let Ok(home) = std::env::var("HOME") {
        if let Some(rest) = trimmed.strip_prefix("~/") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(trimmed)
}

/// Journal.*.log files sorted ascending by name (name embeds the timestamp).
fn list_journals(dir: &Path) -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = fs::read_dir(dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .map(|e| e.path())
                .filter(|p| {
                    let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
                    name.starts_with("Journal.") && name.ends_with(".log")
                })
                .collect()
        })
        .unwrap_or_default();
    out.sort();
    out
}

fn newest_journal(dir: &Path) -> Option<PathBuf> {
    list_journals(dir).pop()
}

/// Split a byte buffer into complete lines; returns (lines, bytes_consumed).
/// A partial trailing line (game mid-write) is left for the next poll (T1.3).
fn complete_lines(buf: &[u8]) -> (Vec<String>, u64) {
    match buf.iter().rposition(|&b| b == b'\n') {
        None => (Vec::new(), 0),
        Some(idx) => {
            let text = String::from_utf8_lossy(&buf[..=idx]);
            let lines = text
                .lines()
                .map(|l| l.trim())
                .filter(|l| !l.is_empty())
                .map(String::from)
                .collect();
            (lines, (idx + 1) as u64)
        }
    }
}

fn emit_lines(app: &AppHandle, lines: Vec<String>, live: bool) {
    for chunk in lines.chunks(1000) {
        let _ = app.emit("journal-lines", json!({ "lines": chunk, "live": live }));
    }
}

fn file_name(p: &Path) -> String {
    p.file_name().and_then(|n| n.to_str()).unwrap_or("?").to_string()
}

fn emit_status(app: &AppHandle, ok: bool, dir: &Path, file: Option<&Path>, error: Option<&str>) {
    let _ = app.emit(
        "watch-status",
        json!({
            "ok": ok,
            "dir": dir.to_string_lossy(),
            "file": file.map(file_name),
            "error": error,
        }),
    );
}

fn ids_from_missions_value(v: &serde_json::Value) -> Option<Vec<u64>> {
    Some(
        v["Active"]
            .as_array()?
            .iter()
            .filter_map(|m| m["MissionID"].as_u64())
            .collect(),
    )
}

/// MissionIDs the game last listed as active. Prefers the live Missions.json;
/// when the game is closed that file is REMOVED, so fall back to the newest
/// journal's login "Missions" event (re-stated at every session start).
fn active_mission_ids(dir: &Path) -> Option<Vec<u64>> {
    if let Ok(text) = fs::read_to_string(dir.join("Missions.json")) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
            if let Some(ids) = ids_from_missions_value(&v) {
                return Some(ids);
            }
        }
    }
    for f in list_journals(dir).iter().rev().take(3) {
        let Ok(text) = fs::read_to_string(f) else { continue };
        if let Some(line) = text.lines().rev().find(|l| l.contains("\"event\":\"Missions\"")) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(line) {
                if let Some(ids) = ids_from_missions_value(&v) {
                    return Some(ids);
                }
            }
        }
    }
    None
}

fn watch_loop(
    app: AppHandle,
    dir: PathBuf,
    my_gen: u64,
    generation: Arc<AtomicU64>,
    bootstrap_previous: u32,
) {
    let mut current = newest_journal(&dir);
    let mut offset: u64 = 0;

    // Bootstrap: previous N sessions + the current session from the top (T1.7).
    let files = list_journals(&dir);
    let take = bootstrap_previous as usize + 1;
    let mut start = files.len().saturating_sub(take);

    // Missions can be accepted many short sessions ago; a fixed session count
    // then replays no `MissionAccepted` and the HUD shows bare placeholders.
    // Walk further back until every mission listed in Missions.json has its
    // accept event covered (capped at 20 files).
    if let Some(ids) = active_mission_ids(&dir) {
        let mut remaining: Vec<u64> = ids;
        for (i, f) in files.iter().enumerate().rev() {
            if remaining.is_empty() || files.len() - i > 20 {
                break;
            }
            if let Ok(text) = fs::read_to_string(f) {
                for line in text.lines() {
                    if !line.contains("\"event\":\"MissionAccepted\"") {
                        continue;
                    }
                    remaining.retain(|id| !line.contains(&format!("\"MissionID\":{id}")));
                }
            }
            if remaining.is_empty() {
                start = start.min(i);
                break;
            }
        }
    }
    for f in &files[start..] {
        if let Ok(bytes) = fs::read(f) {
            let (lines, consumed) = complete_lines(&bytes);
            if Some(f) == current.as_ref() {
                offset = consumed;
            }
            emit_lines(&app, lines, false);
        }
    }
    let _ = app.emit("journal-ready", json!({ "file": current.as_deref().map(file_name) }));
    emit_status(&app, true, &dir, current.as_deref(), None);

    // (len, mtime) marker per snapshot file so we only emit real changes (T1.4).
    let mut snap_seen: HashMap<&'static str, (u64, SystemTime)> = HashMap::new();

    loop {
        if generation.load(Ordering::SeqCst) != my_gen {
            return;
        }
        std::thread::sleep(Duration::from_millis(POLL_MS));

        // Newer session file appears -> re-target within one poll (T1.2).
        let newest = newest_journal(&dir);
        if newest != current {
            current = newest;
            offset = 0;
            emit_status(&app, true, &dir, current.as_deref(), None);
        }

        if let Some(path) = &current {
            if let Ok(meta) = fs::metadata(path) {
                let len = meta.len();
                if len < offset {
                    offset = 0; // truncated/rewritten — start over
                }
                if len > offset {
                    if let Ok(mut f) = fs::File::open(path) {
                        if f.seek(SeekFrom::Start(offset)).is_ok() {
                            let mut buf = Vec::new();
                            if f.read_to_end(&mut buf).is_ok() {
                                let (lines, consumed) = complete_lines(&buf);
                                offset += consumed;
                                if !lines.is_empty() {
                                    emit_lines(&app, lines, true);
                                }
                            }
                        }
                    }
                }
            }
        }

        for name in SNAPSHOT_FILES {
            let p = dir.join(name);
            let Ok(meta) = fs::metadata(&p) else { continue };
            let marker = (meta.len(), meta.modified().unwrap_or(SystemTime::UNIX_EPOCH));
            if snap_seen.get(name) == Some(&marker) {
                continue;
            }
            // Validate JSON before emitting; a mid-rewrite partial file simply
            // stays un-marked and is retried on the next poll (keep last-good).
            match fs::read_to_string(&p) {
                Ok(text) if serde_json::from_str::<serde_json::Value>(&text).is_ok() => {
                    snap_seen.insert(name, marker);
                    let _ = app.emit("snapshot", json!({ "name": name, "text": text }));
                }
                _ => {}
            }
        }
    }
}

#[tauri::command]
fn default_journal_dir() -> String {
    default_dir().to_string_lossy().to_string()
}

#[tauri::command]
fn start_watch(
    app: AppHandle,
    ctl: State<WatchCtl>,
    dir: Option<String>,
    bootstrap_previous: Option<u32>,
) -> Result<(), String> {
    let dir = match dir.as_deref() {
        Some(d) if !d.trim().is_empty() => expand_dir(d),
        _ => default_dir(),
    };
    if !dir.is_dir() {
        let msg = format!(
            "Journal directory not found: {} — run Elite Dangerous once, or set the path in Settings.",
            dir.to_string_lossy()
        );
        emit_status(&app, false, &dir, None, Some(&msg));
        return Err(msg);
    }
    let my_gen = ctl.generation.fetch_add(1, Ordering::SeqCst) + 1;
    let generation = ctl.generation.clone();
    let boot = bootstrap_previous.unwrap_or(1).min(10);
    std::thread::spawn(move || watch_loop(app, dir, my_gen, generation, boot));
    Ok(())
}

// -------------------------------------------------------------------- Piper TTS

/// Per-platform TTS resource dir: the Windows bundle carries `resources/tts`
/// (piper.exe), the Linux bundle `resources/tts-linux` (ELF piper) — see
/// tauri.linux.conf.json. Both can coexist in a dev checkout.
#[cfg(windows)]
const TTS_DIR: &str = "tts";
#[cfg(not(windows))]
const TTS_DIR: &str = "tts-linux";

fn piper_exe(root: &Path) -> PathBuf {
    root.join("piper").join(if cfg!(windows) { "piper.exe" } else { "piper" })
}

fn tts_root(app: &AppHandle) -> Option<PathBuf> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(rd) = app.path().resource_dir() {
        candidates.push(rd.join("resources").join(TTS_DIR));
        candidates.push(rd.join(TTS_DIR));
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources").join(TTS_DIR));
    candidates.into_iter().find(|p| piper_exe(p).is_file())
}

/// All directories that may hold voice models: bundled resources + user
/// downloads under the app-data dir (installed program dirs stay untouched).
fn voice_dirs(app: &AppHandle) -> Vec<PathBuf> {
    let mut dirs = Vec::new();
    if let Some(root) = tts_root(app) {
        dirs.push(root.join("voices"));
    }
    if let Ok(data) = app.path().app_data_dir() {
        dirs.push(data.join("voices"));
    }
    dirs
}

fn list_voice_files(app: &AppHandle) -> Vec<PathBuf> {
    let mut voices: Vec<PathBuf> = voice_dirs(app)
        .iter()
        .filter_map(|d| fs::read_dir(d).ok())
        .flatten()
        .filter_map(|e| e.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("onnx"))
        .collect();
    voices.sort();
    voices
}

fn find_voice(app: &AppHandle, name: Option<&str>) -> Option<PathBuf> {
    let voices = list_voice_files(app);
    if let Some(wanted) = name {
        if let Some(v) = voices
            .iter()
            .find(|p| p.file_stem().and_then(|s| s.to_str()) == Some(wanted))
        {
            return Some(v.clone());
        }
    }
    voices.into_iter().next()
}

#[tauri::command]
fn piper_available(app: AppHandle) -> bool {
    tts_root(&app).is_some() && find_voice(&app, None).is_some()
}

/// Spawn-time env so the sidecars find their bundled shared libraries on
/// Linux (next-to-binary lookup is automatic on Windows only).
fn sidecar_env(cmd: &mut Command, dir: &Path) {
    #[cfg(not(windows))]
    cmd.env("LD_LIBRARY_PATH", dir);
    #[cfg(windows)]
    let _ = dir;
    let _ = cmd;
}

/// Installed voice names (file stems), bundled and downloaded alike.
#[tauri::command]
fn piper_voices(app: AppHandle) -> Vec<String> {
    let mut names: Vec<String> = list_voice_files(&app)
        .iter()
        .filter_map(|p| p.file_stem().and_then(|s| s.to_str()).map(String::from))
        .collect();
    names.dedup();
    names
}

/// Download a voice model (user-initiated) from the official piper-voices
/// repository into the app-data voices dir. `repo_path` is the path inside
/// the repo WITHOUT extension, e.g. "en/en_US/lessac/medium/en_US-lessac-medium".
#[tauri::command]
async fn piper_download_voice(app: AppHandle, repo_path: String) -> Result<String, String> {
    if !repo_path
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '_' | '-' | '.'))
        || repo_path.contains("..")
    {
        return Err("invalid voice path".into());
    }
    let dest_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("voices");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let name = repo_path.rsplit('/').next().unwrap_or(&repo_path).to_string();
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(600))
        .build()
        .map_err(|e| e.to_string())?;
    for ext in ["onnx", "onnx.json"] {
        let url = format!(
            "https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/{repo_path}.{ext}"
        );
        let bytes = client
            .get(&url)
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download failed: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        fs::write(dest_dir.join(format!("{name}.{ext}")), &bytes).map_err(|e| e.to_string())?;
    }
    Ok(name)
}

static TTS_SEQ: AtomicU64 = AtomicU64::new(0);

#[tauri::command]
async fn piper_speak(
    app: AppHandle,
    text: String,
    length_scale: Option<f32>,
    voice: Option<String>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || -> Result<Vec<u8>, String> {
        let root = tts_root(&app).ok_or("Piper TTS resources not found")?;
        let exe = piper_exe(&root);
        let voice = find_voice(&app, voice.as_deref()).ok_or("No .onnx voice model found")?;
        let ls = length_scale.unwrap_or(1.0).clamp(0.4, 3.0);
        let out = std::env::temp_dir().join(format!(
            "edmo-tts-{}-{}.wav",
            std::process::id(),
            TTS_SEQ.fetch_add(1, Ordering::SeqCst)
        ));

        // One utterance per stdin line — collapse whitespace to a single line.
        let line: String = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if line.is_empty() {
            return Err("empty text".into());
        }

        let mut cmd = Command::new(&exe);
        cmd.arg("--model")
            .arg(&voice)
            .arg("--output_file")
            .arg(&out)
            .arg("--length_scale")
            .arg(format!("{ls}"))
            .arg("--sentence_silence")
            .arg("0.25")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        if let Some(dir) = exe.parent() {
            sidecar_env(&mut cmd, dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let mut child = cmd.spawn().map_err(|e| format!("piper spawn failed: {e}"))?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(line.as_bytes());
            let _ = stdin.write_all(b"\n");
        }
        let status = child.wait().map_err(|e| format!("piper wait failed: {e}"))?;
        if !status.success() {
            let _ = fs::remove_file(&out);
            return Err(format!("piper exited with {status}"));
        }
        let wav = fs::read(&out).map_err(|e| format!("read wav failed: {e}"))?;
        let _ = fs::remove_file(&out);
        Ok(wav)
    })
    .await
    .map_err(|e| format!("tts task failed: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

// ------------------------------------------------------------- LM Studio proxy

#[derive(Serialize, Deserialize, Clone)]
struct ChatMsg {
    role: String,
    // Plain string for text chat, or an OpenAI content-part array for vision
    // messages ({type:"text"}/{type:"image_url"}) — passed through verbatim.
    content: serde_json::Value,
}

#[tauri::command]
async fn llm_models(endpoint: String) -> Result<Vec<String>, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/v1/models", endpoint.trim_end_matches('/'));
    let v: serde_json::Value = client
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    Ok(v["data"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|m| m["id"].as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default())
}

async fn stream_chat(
    app: &AppHandle,
    id: &str,
    endpoint: &str,
    model: &str,
    messages: &[ChatMsg],
    temperature: f32,
    max_tokens: u32,
    response_format: Option<serde_json::Value>,
    cancel: Arc<AtomicBool>,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(300))
        .build()
        .map_err(|e| e.to_string())?;
    let url = format!("{}/v1/chat/completions", endpoint.trim_end_matches('/'));
    let mut body = json!({
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": true,
    });
    if let Some(rf) = response_format {
        body["response_format"] = rf;
    }
    let resp = client
        .post(url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("LM Studio unreachable: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        return Err(match status.as_u16() {
            404 => "no model loaded (404)".to_string(),
            code => format!("HTTP {code}"),
        });
    }

    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    let mut full = String::new();
    // Reasoning models stream hidden thinking as `reasoning_content` deltas.
    // We don't show it, but tracking it lets us tell "model starved by its own
    // thinking budget" apart from a genuinely empty reply.
    let mut reasoned = false;
    fn finish(full: String, reasoned: bool) -> Result<String, String> {
        if full.trim().is_empty() && reasoned {
            return Err(
                "the model spent its whole token budget on hidden reasoning — raise Max tokens \
                 or pick a non-reasoning (instruct) model"
                    .into(),
            );
        }
        Ok(full)
    }
    while let Some(chunk) = stream.next().await {
        if cancel.load(Ordering::SeqCst) {
            return Err("cancelled".into());
        }
        let chunk = chunk.map_err(|e| format!("stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(pos) = buf.find('\n') {
            let line: String = buf.drain(..=pos).collect();
            let line = line.trim();
            let Some(data) = line.strip_prefix("data:") else { continue };
            let data = data.trim();
            if data == "[DONE]" {
                return finish(full, reasoned);
            }
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(data) {
                let delta = &v["choices"][0]["delta"];
                if delta["reasoning_content"].as_str().is_some_and(|s| !s.is_empty()) {
                    reasoned = true;
                }
                let tok = delta["content"]
                    .as_str()
                    .or_else(|| v["choices"][0]["message"]["content"].as_str())
                    .unwrap_or("");
                if !tok.is_empty() {
                    full.push_str(tok);
                    let _ = app.emit("llm-token", json!({ "id": id, "token": tok }));
                }
            }
        }
    }
    finish(full, reasoned)
}

#[tauri::command]
async fn llm_chat(
    app: AppHandle,
    ctl: State<'_, LlmCtl>,
    id: String,
    endpoint: String,
    model: String,
    messages: Vec<ChatMsg>,
    temperature: Option<f32>,
    max_tokens: Option<u32>,
    response_format: Option<serde_json::Value>,
) -> Result<(), String> {
    let cancel = Arc::new(AtomicBool::new(false));
    ctl.cancels.lock().unwrap().insert(id.clone(), cancel.clone());
    let result = stream_chat(
        &app,
        &id,
        &endpoint,
        &model,
        &messages,
        temperature.unwrap_or(0.3),
        max_tokens.unwrap_or(2048),
        response_format,
        cancel,
    )
    .await;
    ctl.cancels.lock().unwrap().remove(&id);
    match result {
        Ok(text) => {
            let _ = app.emit("llm-done", json!({ "id": id, "text": text }));
        }
        Err(message) => {
            let _ = app.emit("llm-error", json!({ "id": id, "message": message }));
        }
    }
    Ok(())
}

#[tauri::command]
fn llm_cancel(ctl: State<LlmCtl>, id: String) {
    if let Some(flag) = ctl.cancels.lock().unwrap().get(&id) {
        flag.store(true, Ordering::SeqCst);
    }
}

/// Model capabilities from LM Studio's richer REST API (`/api/v0/models`):
/// id → type ("vlm" | "llm" | "embeddings"). Empty map when the endpoint is
/// unavailable (older LM Studio) — callers must degrade gracefully.
#[tauri::command]
async fn llm_model_types(endpoint: String) -> HashMap<String, String> {
    let mut out = HashMap::new();
    let Ok(client) = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(3))
        .timeout(Duration::from_secs(6))
        .build()
    else {
        return out;
    };
    let url = format!("{}/api/v0/models", endpoint.trim_end_matches('/'));
    let Ok(resp) = client.get(url).send().await else { return out };
    let Ok(v) = resp.json::<serde_json::Value>().await else { return out };
    if let Some(arr) = v["data"].as_array() {
        for m in arr {
            if let (Some(id), Some(ty)) = (m["id"].as_str(), m["type"].as_str()) {
                out.insert(id.to_string(), ty.to_string());
            }
        }
    }
    out
}

// ------------------------------------------------------------- memory bank IO

fn memory_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("memory.json"))
}

/// The commander's long-term memory bank — a real file in the app-data dir so
/// it survives webview storage resets and stays user-inspectable.
#[tauri::command]
fn memory_load(app: AppHandle) -> Result<String, String> {
    let path = memory_path(&app)?;
    match fs::read_to_string(&path) {
        Ok(text) => Ok(text),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn memory_save(app: AppHandle, text: String) -> Result<(), String> {
    let path = memory_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // Write-then-rename so a crash mid-write can't corrupt the bank.
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

// ----------------------------------------------------------- voice input (STT)
//
// Push-to-talk: cpal records the default microphone while the key is held,
// then a local whisper.cpp sidecar (downloaded on the user's explicit click,
// like the extra Piper voices) transcribes — the commander's voice never
// leaves this machine. Mirrors the Piper pattern: CLI sidecar, app-data dir.

struct SttCtl {
    rec: Mutex<Option<ActiveRec>>,
}

struct ActiveRec {
    stop: Arc<AtomicBool>,
    buf: Arc<Mutex<Vec<f32>>>,
    rate: Arc<AtomicU64>,
    handle: std::thread::JoinHandle<()>,
}

fn stt_dir(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app.path().app_data_dir().map_err(|e| e.to_string())?.join("stt"))
}

fn stt_paths(app: &AppHandle) -> Result<(PathBuf, PathBuf), String> {
    let dir = stt_dir(app)?;
    let exe = if cfg!(windows) { "whisper-cli.exe" } else { "whisper-cli" };
    Ok((dir.join(exe), dir.join("ggml-base.en.bin")))
}

#[tauri::command]
fn stt_available(app: AppHandle) -> bool {
    stt_paths(&app).map(|(exe, model)| exe.is_file() && model.is_file()).unwrap_or(false)
}

/// One-time download of the speech-recognition sidecar (user-initiated):
/// whisper.cpp CPU build + the base.en model (~150 MB total), into app-data.
#[tauri::command]
async fn stt_download(app: AppHandle) -> Result<(), String> {
    let dir = stt_dir(&app)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(900))
        .build()
        .map_err(|e| e.to_string())?;

    #[cfg(windows)]
    {
        let zip_bytes = client
            .get("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip")
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download failed: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes.as_ref()))
            .map_err(|e| format!("bad archive: {e}"))?;
        for i in 0..archive.len() {
            let mut f = archive.by_index(i).map_err(|e| e.to_string())?;
            let name = f.name().rsplit('/').next().unwrap_or("").to_string();
            // Only the CLI and its runtime DLLs — not the demo/test binaries.
            let keep = name == "whisper-cli.exe"
                || name == "whisper.dll"
                || (name.starts_with("ggml") && name.ends_with(".dll"));
            if !keep {
                continue;
            }
            let mut out = Vec::new();
            f.read_to_end(&mut out).map_err(|e| e.to_string())?;
            fs::write(dir.join(&name), &out).map_err(|e| e.to_string())?;
        }
    }
    #[cfg(not(windows))]
    {
        // The Linux release is a tarball with symlinked .so versions — let the
        // system tar extract it so the links survive.
        let tgz = client
            .get("https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-ubuntu-x64.tar.gz")
            .send()
            .await
            .map_err(|e| format!("download failed: {e}"))?
            .error_for_status()
            .map_err(|e| format!("download failed: {e}"))?
            .bytes()
            .await
            .map_err(|e| format!("download failed: {e}"))?;
        let tmp = std::env::temp_dir().join(format!("edmo-stt-{}.tar.gz", std::process::id()));
        fs::write(&tmp, &tgz).map_err(|e| e.to_string())?;
        let status = Command::new("tar")
            .arg("-xzf")
            .arg(&tmp)
            .arg("-C")
            .arg(&dir)
            .arg("--strip-components=1")
            .arg("--wildcards")
            .arg("whisper-bin-ubuntu-x64/whisper-cli")
            .arg("whisper-bin-ubuntu-x64/lib*")
            .status()
            .map_err(|e| format!("tar failed: {e}"))?;
        let _ = fs::remove_file(&tmp);
        if !status.success() {
            return Err(format!("archive extraction failed ({status})"));
        }
    }

    let model = client
        .get("https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin")
        .send()
        .await
        .map_err(|e| format!("model download failed: {e}"))?
        .error_for_status()
        .map_err(|e| format!("model download failed: {e}"))?
        .bytes()
        .await
        .map_err(|e| format!("model download failed: {e}"))?;
    fs::write(dir.join("ggml-base.en.bin"), &model).map_err(|e| e.to_string())?;
    Ok(())
}

/// Begin capturing the default microphone (push-to-talk pressed).
#[tauri::command]
fn stt_start(ctl: State<SttCtl>) -> Result<(), String> {
    use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
    let mut rec = ctl.rec.lock().unwrap();
    if rec.is_some() {
        return Ok(()); // already listening (key auto-repeat)
    }
    let stop = Arc::new(AtomicBool::new(false));
    let buf = Arc::new(Mutex::new(Vec::<f32>::new()));
    let rate = Arc::new(AtomicU64::new(0));
    let (tx, rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let (stop2, buf2, rate2) = (stop.clone(), buf.clone(), rate.clone());
    let handle = std::thread::spawn(move || {
        let host = cpal::default_host();
        let Some(device) = host.default_input_device() else {
            let _ = tx.send(Err("no microphone found".into()));
            return;
        };
        let Ok(config) = device.default_input_config() else {
            let _ = tx.send(Err("microphone has no usable input format".into()));
            return;
        };
        let channels = config.channels() as usize;
        rate2.store(config.sample_rate().0 as u64, Ordering::SeqCst);
        // Downmix to mono while collecting; whisper-cli resamples any rate.
        let sink = buf2;
        let push = move |samples: &[f32]| {
            let mut b = sink.lock().unwrap();
            for frame in samples.chunks(channels.max(1)) {
                b.push(frame.iter().sum::<f32>() / frame.len() as f32);
            }
        };
        let err_fn = |_e: cpal::StreamError| {};
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _| push(data),
                err_fn,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| s as f32 / 32768.0).collect();
                    push(&f);
                },
                err_fn,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.into(),
                move |data: &[u16], _| {
                    let f: Vec<f32> = data.iter().map(|&s| (s as f32 - 32768.0) / 32768.0).collect();
                    push(&f);
                },
                err_fn,
                None,
            ),
            other => {
                let _ = tx.send(Err(format!("unsupported microphone format {other:?}")));
                return;
            }
        };
        match stream {
            Ok(s) => {
                if s.play().is_err() {
                    let _ = tx.send(Err("microphone stream failed to start".into()));
                    return;
                }
                let _ = tx.send(Ok(()));
                let started = Instant::now();
                // Hard cap so a lost key-up can't record forever.
                while !stop2.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(30) {
                    std::thread::sleep(Duration::from_millis(30));
                }
                drop(s);
            }
            Err(e) => {
                let _ = tx.send(Err(format!("microphone open failed: {e}")));
            }
        }
    });
    match rx.recv_timeout(Duration::from_secs(3)) {
        Ok(Ok(())) => {
            *rec = Some(ActiveRec { stop, buf, rate, handle });
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => Err("microphone start timed out".into()),
    }
}

/// Stop capturing and transcribe (push-to-talk released). Empty string when
/// the clip was too short or contained no speech.
#[tauri::command]
async fn stt_stop(app: AppHandle, ctl: State<'_, SttCtl>) -> Result<String, String> {
    let Some(active) = ctl.rec.lock().unwrap().take() else {
        return Ok(String::new());
    };
    tauri::async_runtime::spawn_blocking(move || -> Result<String, String> {
        active.stop.store(true, Ordering::SeqCst);
        let _ = active.handle.join();
        let samples = std::mem::take(&mut *active.buf.lock().unwrap());
        let rate = active.rate.load(Ordering::SeqCst) as u32;
        if rate == 0 || (samples.len() as u64) < (rate as u64) * 35 / 100 {
            return Ok(String::new()); // under ~0.35 s — a tap, not speech
        }
        let (exe, model) = stt_paths(&app)?;
        if !exe.is_file() || !model.is_file() {
            return Err("speech recognition not installed".into());
        }
        let wav_path = std::env::temp_dir().join(format!(
            "edmo-stt-{}-{}.wav",
            std::process::id(),
            TTS_SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        let spec = hound::WavSpec {
            channels: 1,
            sample_rate: rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };
        let mut writer = hound::WavWriter::create(&wav_path, spec).map_err(|e| e.to_string())?;
        for s in &samples {
            writer
                .write_sample((s.clamp(-1.0, 1.0) * 32767.0) as i16)
                .map_err(|e| e.to_string())?;
        }
        writer.finalize().map_err(|e| e.to_string())?;

        let threads = std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4).min(8);
        let mut cmd = Command::new(&exe);
        cmd.arg("-m")
            .arg(&model)
            .arg("-f")
            .arg(&wav_path)
            .arg("-nt")
            .arg("-np")
            .arg("--language")
            .arg("en")
            .arg("-t")
            .arg(threads.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        if let Some(dir) = exe.parent() {
            sidecar_env(&mut cmd, dir);
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        let out = cmd.output().map_err(|e| format!("whisper spawn failed: {e}"))?;
        let _ = fs::remove_file(&wav_path);
        if !out.status.success() {
            return Err(format!("whisper exited with {}", out.status));
        }
        Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
    })
    .await
    .map_err(|e| format!("stt task failed: {e}"))?
}

/// Discard an in-flight capture without transcribing.
#[tauri::command]
fn stt_cancel(ctl: State<SttCtl>) {
    if let Some(active) = ctl.rec.lock().unwrap().take() {
        active.stop.store(true, Ordering::SeqCst);
        let _ = active.handle.join();
    }
}

// -------------------------------------------------------------- screen glance

/// Capture the primary screen as BGRA pixels via GDI (compiled code — no
/// AMSI/script-capture flags, works over borderless-fullscreen games).
#[cfg(windows)]
fn capture_primary_bgra() -> Result<(Vec<u8>, u32, u32), String> {
    use windows_sys::Win32::Graphics::Gdi::{
        BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC,
        GetDIBits, ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT,
        DIB_RGB_COLORS, SRCCOPY,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
    unsafe {
        let w = GetSystemMetrics(SM_CXSCREEN);
        let h = GetSystemMetrics(SM_CYSCREEN);
        if w <= 0 || h <= 0 {
            return Err("no primary screen".into());
        }
        let screen_dc = GetDC(std::ptr::null_mut());
        if screen_dc.is_null() {
            return Err("GetDC failed".into());
        }
        let mem_dc = CreateCompatibleDC(screen_dc);
        let bmp = CreateCompatibleBitmap(screen_dc, w, h);
        let old = SelectObject(mem_dc, bmp as _);
        let blit_ok = BitBlt(mem_dc, 0, 0, w, h, screen_dc, 0, 0, SRCCOPY | CAPTUREBLT);
        let mut info: BITMAPINFO = std::mem::zeroed();
        info.bmiHeader.biSize = std::mem::size_of::<BITMAPINFOHEADER>() as u32;
        info.bmiHeader.biWidth = w;
        info.bmiHeader.biHeight = -h; // negative = top-down rows
        info.bmiHeader.biPlanes = 1;
        info.bmiHeader.biBitCount = 32;
        info.bmiHeader.biCompression = BI_RGB as u32;
        let mut buf = vec![0u8; w as usize * h as usize * 4];
        let got = if blit_ok != 0 {
            GetDIBits(
                mem_dc,
                bmp,
                0,
                h as u32,
                buf.as_mut_ptr() as *mut _,
                &mut info,
                DIB_RGB_COLORS,
            )
        } else {
            0
        };
        SelectObject(mem_dc, old);
        DeleteObject(bmp as _);
        DeleteDC(mem_dc);
        ReleaseDC(std::ptr::null_mut(), screen_dc);
        if got == 0 {
            return Err("screen capture failed (BitBlt/GetDIBits)".into());
        }
        Ok((buf, w as u32, h as u32))
    }
}

/// One glance: capture → downscale to ≤1280 px wide → JPEG q60 → data URI.
/// The image lives only in memory and only travels to the local LM endpoint.
#[tauri::command]
async fn capture_screen() -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<String, String> {
        #[cfg(not(windows))]
        {
            return Err("screen glance is Windows-only".into());
        }
        #[cfg(windows)]
        {
            use base64::Engine;
            let (bgra, w, h) = capture_primary_bgra()?;
            let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
            for px in bgra.chunks_exact(4) {
                rgb.extend_from_slice(&[px[2], px[1], px[0]]);
            }
            let img: image::RgbImage = image::ImageBuffer::from_raw(w, h, rgb)
                .ok_or("bad capture buffer")?;
            let target_w = 1280u32.min(w);
            let target_h = (h as u64 * target_w as u64 / w as u64).max(1) as u32;
            let small = image::imageops::thumbnail(&img, target_w, target_h);
            let mut jpeg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, 60)
                .encode_image(&small)
                .map_err(|e| e.to_string())?;
            Ok(format!(
                "data:image/jpeg;base64,{}",
                base64::engine::general_purpose::STANDARD.encode(&jpeg)
            ))
        }
    })
    .await
    .map_err(|e| format!("capture task failed: {e}"))?
}

// ---------------------------------------------------------------- machine specs

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct GpuInfo {
    name: String,
    vram_mb: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct SystemSpecs {
    total_ram_mb: u64,
    cpu_cores: u32,
    cpu_name: String,
    gpus: Vec<GpuInfo>,
}

#[cfg(windows)]
fn read_ram_mb() -> u64 {
    let mut kb: u64 = 0;
    let ok = unsafe {
        windows_sys::Win32::System::SystemInformation::GetPhysicallyInstalledSystemMemory(&mut kb)
    };
    if ok != 0 {
        kb / 1024
    } else {
        0
    }
}

#[cfg(windows)]
fn read_cpu_name() -> String {
    windows_registry::LOCAL_MACHINE
        .open(r"HARDWARE\DESCRIPTION\System\CentralProcessor\0")
        .and_then(|k| k.get_string("ProcessorNameString"))
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// Dedicated VRAM per GPU from the display-class registry keys.
/// `HardwareInformation.qwMemorySize` (QWORD) is accurate where the old WMI
/// `AdapterRAM` caps at 4 GB; fall back to the legacy DWORD value.
#[cfg(windows)]
fn read_gpus() -> Vec<GpuInfo> {
    let mut out: Vec<GpuInfo> = Vec::new();
    let Ok(class) = windows_registry::LOCAL_MACHINE
        .open(r"SYSTEM\CurrentControlSet\Control\Class\{4d36e968-e325-11ce-bfc1-08002be10318}")
    else {
        return out;
    };
    let Ok(subkeys) = class.keys() else { return out };
    for name in subkeys {
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue; // skip "Properties" etc.
        }
        let Ok(sub) = class.open(&name) else { continue };
        let vram_bytes = sub
            .get_u64("HardwareInformation.qwMemorySize")
            .ok()
            .or_else(|| sub.get_u32("HardwareInformation.MemorySize").ok().map(u64::from))
            .unwrap_or(0);
        let desc = sub.get_string("DriverDesc").unwrap_or_default();
        let vram_mb = vram_bytes / (1024 * 1024);
        if desc.is_empty() || vram_mb < 256 {
            continue; // virtual/basic display adapters
        }
        match out.iter_mut().find(|g| g.name == desc) {
            Some(g) => g.vram_mb = g.vram_mb.max(vram_mb),
            None => out.push(GpuInfo { name: desc, vram_mb }),
        }
    }
    out.sort_by(|a, b| b.vram_mb.cmp(&a.vram_mb));
    out
}

#[cfg(not(windows))]
fn read_ram_mb() -> u64 {
    fs::read_to_string("/proc/meminfo")
        .ok()
        .and_then(|text| {
            text.lines().find(|l| l.starts_with("MemTotal:")).and_then(|l| {
                l.split_whitespace().nth(1).and_then(|kb| kb.parse::<u64>().ok())
            })
        })
        .map(|kb| kb / 1024)
        .unwrap_or(0)
}

#[cfg(not(windows))]
fn read_cpu_name() -> String {
    fs::read_to_string("/proc/cpuinfo")
        .ok()
        .and_then(|text| {
            text.lines()
                .find(|l| l.starts_with("model name"))
                .and_then(|l| l.split(':').nth(1).map(|s| s.trim().to_string()))
        })
        .unwrap_or_default()
}

/// VRAM detection is Windows-registry based; on Linux the model advisor
/// simply shows no GPU line and judges by RAM alone.
#[cfg(not(windows))]
fn read_gpus() -> Vec<GpuInfo> {
    Vec::new()
}

#[tauri::command]
fn system_specs() -> SystemSpecs {
    SystemSpecs {
        total_ram_mb: read_ram_mb(),
        cpu_cores: std::thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(0),
        cpu_name: read_cpu_name(),
        gpus: read_gpus(),
    }
}

// ------------------------------------------------------------- Spansh (opt-in)

/// Ask Spansh's community trade-route planner for a profitable route from the
/// commander's current station. OPT-IN ONLY — sends the system/station name to
/// spansh.co.uk, nothing else. Jobs queue server-side, so this submits and
/// polls (their API answers in ~30-90 s).
#[tauri::command]
async fn spansh_trade_route(
    system: String,
    station: Option<String>,
    max_cargo: u32,
    capital: u64,
    max_hop_distance: u32,
    max_hops: u32,
) -> Result<String, String> {
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(30))
        .user_agent("ED-Mission-Operator/0.1 (companion HUD)")
        .build()
        .map_err(|e| e.to_string())?;

    let mut form: Vec<(&str, String)> = vec![
        ("system", system),
        ("capital", capital.to_string()),
        ("max_cargo", max_cargo.to_string()),
        ("max_hops", max_hops.clamp(1, 4).to_string()),
        ("max_hop_distance", max_hop_distance.clamp(5, 200).to_string()),
        ("max_system_distance", "3000".into()),
        // Booleans MUST be 0/1 — the API parses "false" as truthy.
        ("requires_large_pad", "0".into()),
        ("allow_prohibited", "0".into()),
        ("allow_planetary", "1".into()),
        ("allow_player_owned", "0".into()),
        ("unique", "0".into()),
        ("permit", "0".into()),
    ];
    if let Some(st) = station.filter(|s| !s.trim().is_empty()) {
        form.push(("station", st));
    }

    let submit: serde_json::Value = client
        .post("https://spansh.co.uk/api/trade/route")
        .form(&form)
        .send()
        .await
        .map_err(|e| format!("Spansh unreachable: {e}"))?
        .json()
        .await
        .map_err(|e| format!("Spansh reply unreadable: {e}"))?;
    let job = submit["job"]
        .as_str()
        .ok_or_else(|| format!("Spansh rejected the query: {submit}"))?
        .to_string();

    // Poll for up to ~3 minutes.
    for _ in 0..60 {
        tokio::time::sleep(Duration::from_secs(3)).await;
        let body = client
            .get(format!("https://spansh.co.uk/api/results/{job}"))
            .send()
            .await
            .map_err(|e| format!("Spansh poll failed: {e}"))?
            .text()
            .await
            .map_err(|e| e.to_string())?;
        let v: serde_json::Value = serde_json::from_str(&body).unwrap_or_default();
        match v["status"].as_str() {
            Some("queued") | Some("processing") => continue,
            _ => return Ok(body),
        }
    }
    Err("Spansh is busy — route search timed out".into())
}

// ------------------------------------------------------------------ window bits

#[tauri::command]
fn set_click_through(app: AppHandle, ct: State<ClickThrough>, enabled: bool) -> Result<(), String> {
    let win = app.get_webview_window("main").ok_or("no main window")?;
    win.set_ignore_cursor_events(enabled).map_err(|e| e.to_string())?;
    ct.0.store(enabled, Ordering::SeqCst);
    let _ = app.emit("click-through", json!({ "enabled": enabled }));
    Ok(())
}

/// Put text on the OS clipboard (used for galaxy-map waypoint pasting) —
/// plugin-based so it works even while the game window has focus.
#[tauri::command]
fn copy_text(app: AppHandle, text: String) -> Result<(), String> {
    use tauri_plugin_clipboard_manager::ClipboardExt;
    app.clipboard().write_text(text).map_err(|e| e.to_string())
}

#[tauri::command]
fn close_app(app: AppHandle) {
    save_geometry(&app);
    app.exit(0);
}

fn geom_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("geometry.json"))
}

fn save_geometry(app: &AppHandle) {
    let Some(path) = geom_path(app) else { return };
    let state: State<GeomState> = app.state();
    let cur = *state.cur.lock().unwrap();
    if let Some(g) = cur {
        if let Some(parent) = path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(text) = serde_json::to_string(&g) {
            let _ = fs::write(path, text);
        }
    }
}

fn toggle_visibility(app: &AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        match win.is_visible() {
            Ok(true) => {
                let _ = win.hide();
            }
            _ => {
                let _ = win.show();
                let _ = win.set_focus();
            }
        }
    }
}

fn emit_shortcut(app: &AppHandle, action: &str) {
    let _ = app.emit("shortcut", json!({ "action": action }));
}

// ------------------------------------------------------------------------ main

fn main() {
    let sc = |code: Code| Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), code);
    let sc_hud = sc(Code::KeyM);
    let sc_ask = sc(Code::KeyH);
    let sc_voice = sc(Code::KeyV);
    let sc_cycle = sc(Code::KeyJ);
    let sc_collapse = sc(Code::KeyK);
    let sc_clickthrough = sc(Code::KeyT);
    let sc_ptt = sc(Code::Space);

    tauri::Builder::default()
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, shortcut, event| {
                    // Push-to-talk is hold-shaped: both edges matter.
                    if shortcut == &sc_ptt {
                        emit_shortcut(
                            app,
                            if event.state() == ShortcutState::Pressed { "ptt-down" } else { "ptt-up" },
                        );
                        return;
                    }
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &sc_hud {
                        toggle_visibility(app);
                    } else if shortcut == &sc_ask {
                        emit_shortcut(app, "ask");
                    } else if shortcut == &sc_voice {
                        emit_shortcut(app, "voice");
                    } else if shortcut == &sc_cycle {
                        emit_shortcut(app, "cycle");
                    } else if shortcut == &sc_collapse {
                        emit_shortcut(app, "collapse");
                    } else if shortcut == &sc_clickthrough {
                        let ct: State<ClickThrough> = app.state();
                        let next = !ct.0.load(Ordering::SeqCst);
                        let _ = set_click_through(app.clone(), app.state(), next);
                    }
                })
                .build(),
        )
        .manage(WatchCtl { generation: Arc::new(AtomicU64::new(0)) })
        .manage(LlmCtl { cancels: Mutex::new(HashMap::new()) })
        .manage(SttCtl { rec: Mutex::new(None) })
        .manage(ClickThrough(AtomicBool::new(false)))
        .manage(GeomState {
            cur: Mutex::new(None),
            last_save: Mutex::new(Instant::now()),
        })
        .invoke_handler(tauri::generate_handler![
            default_journal_dir,
            system_specs,
            start_watch,
            piper_available,
            piper_voices,
            piper_download_voice,
            piper_speak,
            llm_models,
            llm_model_types,
            llm_chat,
            memory_load,
            memory_save,
            capture_screen,
            stt_available,
            stt_download,
            stt_start,
            stt_stop,
            stt_cancel,
            spansh_trade_route,
            copy_text,
            llm_cancel,
            set_click_through,
            close_app
        ])
        .setup(move |app| {
            // Restore persisted window geometry (T5.2) before the user sees it.
            let handle = app.handle().clone();
            if let (Some(path), Some(win)) = (geom_path(&handle), app.get_webview_window("main")) {
                if let Ok(text) = fs::read_to_string(path) {
                    if let Ok(g) = serde_json::from_str::<Geom>(&text) {
                        if g.w >= 320 && g.h >= 400 && g.x > -20000 && g.y > -20000 {
                            let _ = win.set_position(tauri::PhysicalPosition::new(g.x, g.y));
                            let _ = win.set_size(tauri::PhysicalSize::new(g.w, g.h));
                            *app.state::<GeomState>().cur.lock().unwrap() = Some(g);
                        }
                    }
                }
            }
            for shortcut in [sc_hud, sc_ask, sc_voice, sc_cycle, sc_collapse, sc_clickthrough, sc_ptt] {
                // A conflict with another app must not be fatal.
                let _ = app.global_shortcut().register(shortcut);
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let app = window.app_handle();
            let state: State<GeomState> = app.state();
            match event {
                tauri::WindowEvent::Moved(pos) => {
                    let mut cur = state.cur.lock().unwrap();
                    let size = window.inner_size().ok();
                    let g = cur.get_or_insert(Geom { x: 0, y: 0, w: 420, h: 680 });
                    g.x = pos.x;
                    g.y = pos.y;
                    if let Some(s) = size {
                        if s.width >= 50 && s.height >= 50 {
                            g.w = s.width;
                            g.h = s.height;
                        }
                    }
                }
                tauri::WindowEvent::Resized(size) => {
                    if size.width >= 50 && size.height >= 50 {
                        let mut cur = state.cur.lock().unwrap();
                        let pos = window.outer_position().ok();
                        let g = cur.get_or_insert(Geom { x: 0, y: 0, w: 420, h: 680 });
                        g.w = size.width;
                        g.h = size.height;
                        if let Some(p) = pos {
                            g.x = p.x;
                            g.y = p.y;
                        }
                    }
                }
                tauri::WindowEvent::CloseRequested { .. } | tauri::WindowEvent::Destroyed => {
                    save_geometry(app);
                    return;
                }
                _ => return,
            }
            // Throttled write-through so a drag doesn't hammer the disk.
            let mut last = state.last_save.lock().unwrap();
            if last.elapsed() > Duration::from_secs(2) {
                *last = Instant::now();
                drop(last);
                save_geometry(app);
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running ED Mission Operator");
}
