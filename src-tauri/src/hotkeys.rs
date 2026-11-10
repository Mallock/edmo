//! Global shortcuts the commander can rebind (GitHub issue #2).
//!
//! They used to be seven hard-coded Ctrl+Shift combos, registered once at
//! launch with every failure thrown away. Ctrl+Shift+Space collides with the
//! Windows input-method switcher and with in-game binds, so for some players
//! push-to-talk simply never worked, and nothing said why.
//!
//! Now the bindings live in app-config `shortcuts.json` (next to the window
//! geometry) so they apply at launch, before the webview has loaded. A combo
//! that cannot be claimed is reported back to Settings with the reason, and
//! while Settings records a new combo every shortcut is released, so the
//! keypress reaches the page instead of firing the old action.
//!
//! Every (un)registration runs on the MAIN thread, and that is load-bearing:
//! the plugin holds its shortcut table locked while it waits for the main
//! thread to do the work, and the main thread takes that same lock to
//! dispatch a key press. Called from anywhere else, a key pressed at the
//! wrong moment deadlocks the app. On the main thread the plugin's hop is
//! inline, so the commands below are deliberately synchronous (Tauri runs
//! non-async commands on the main thread).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::Mutex;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

/// Every rebindable action and its default. Mirrors src/ui/hotkeys.ts.
pub const ACTIONS: [(&str, &str); 7] = [
    ("hud", "Ctrl+Shift+M"),
    ("ask", "Ctrl+Shift+H"),
    ("voice", "Ctrl+Shift+V"),
    ("cycle", "Ctrl+Shift+J"),
    ("collapse", "Ctrl+Shift+K"),
    ("clickthrough", "Ctrl+Shift+T"),
    ("ptt", "Ctrl+Shift+Space"),
];

#[derive(Default)]
pub struct HotkeyCtl {
    /// Registered shortcut id -> action. Read by the plugin's handler.
    live: Mutex<HashMap<u32, &'static str>>,
    /// What the commander chose, action -> combo ("" = off).
    bindings: Mutex<BTreeMap<String, String>>,
    /// Why a binding is not live, action -> reason.
    errors: Mutex<BTreeMap<String, String>>,
}

#[derive(Serialize)]
pub struct HotkeyReport {
    bindings: BTreeMap<String, String>,
    errors: BTreeMap<String, String>,
}

/// The action a fired shortcut belongs to, if it is one of ours.
pub fn action_for(app: &AppHandle, shortcut: &Shortcut) -> Option<&'static str> {
    app.state::<HotkeyCtl>().live.lock().unwrap().get(&shortcut.id()).copied()
}

fn hotkeys_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_config_dir().ok().map(|d| d.join("shortcuts.json"))
}

/// Known actions only, each with the commander's combo or the default.
fn with_defaults(mut chosen: BTreeMap<String, String>) -> BTreeMap<String, String> {
    ACTIONS
        .iter()
        .map(|(action, default)| {
            let combo = chosen.remove(*action).unwrap_or_else(|| default.to_string());
            (action.to_string(), combo.trim().to_string())
        })
        .collect()
}

fn load(app: &AppHandle) -> BTreeMap<String, String> {
    let chosen = hotkeys_path(app)
        .and_then(|p| fs::read_to_string(p).ok())
        .and_then(|text| serde_json::from_str(&text).ok())
        .unwrap_or_default();
    with_defaults(chosen)
}

fn save(app: &AppHandle, bindings: &BTreeMap<String, String>) -> Result<(), String> {
    let path = hotkeys_path(app).ok_or("no config directory")?;
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(bindings).map_err(|e| e.to_string())?;
    fs::write(path, text).map_err(|e| e.to_string())
}

fn label(action: &str) -> &'static str {
    match action {
        "hud" => "show/hide",
        "ask" => "ask",
        "voice" => "voice on/off",
        "cycle" => "cycle mission",
        "collapse" => "collapse",
        "clickthrough" => "click-through",
        "ptt" => "push-to-talk",
        _ => "another action",
    }
}

/// Release everything, claim each binding, and remember what did not take.
/// A failure never stops the rest from registering. Main thread only.
fn apply(app: &AppHandle, bindings: BTreeMap<String, String>) {
    let ctl = app.state::<HotkeyCtl>();
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let mut live: HashMap<u32, &'static str> = HashMap::new();
    let mut errors = BTreeMap::new();
    for (action, _) in ACTIONS {
        let combo = bindings.get(action).map(String::as_str).unwrap_or("");
        if combo.is_empty() {
            continue;
        }
        let Ok(shortcut) = Shortcut::from_str(combo) else {
            errors.insert(action.to_string(), format!("\"{combo}\" is not a key combination"));
            continue;
        };
        if let Some(other) = live.get(&shortcut.id()) {
            errors.insert(action.to_string(), format!("already used for {}", label(other)));
            continue;
        }
        match gs.register(shortcut) {
            Ok(()) => {
                live.insert(shortcut.id(), action);
            }
            Err(_) => {
                errors.insert(
                    action.to_string(),
                    "could not be claimed: another app or Windows already uses it".into(),
                );
            }
        }
    }
    *ctl.live.lock().unwrap() = live;
    *ctl.bindings.lock().unwrap() = bindings;
    *ctl.errors.lock().unwrap() = errors;
}

fn report(ctl: &HotkeyCtl) -> HotkeyReport {
    HotkeyReport {
        bindings: ctl.bindings.lock().unwrap().clone(),
        errors: ctl.errors.lock().unwrap().clone(),
    }
}

/// Launch (from `setup`, on the main thread): claim the saved bindings, or
/// the defaults on a fresh install.
pub fn init(app: &AppHandle) {
    apply(app, load(app));
}

#[tauri::command]
pub fn hotkeys_get(ctl: State<'_, HotkeyCtl>) -> HotkeyReport {
    report(&ctl)
}

/// Rebind, save, and say which bindings did not take.
#[tauri::command]
pub fn hotkeys_set(app: AppHandle, bindings: BTreeMap<String, String>) -> Result<HotkeyReport, String> {
    let bindings = with_defaults(bindings);
    save(&app, &bindings)?;
    apply(&app, bindings);
    Ok(report(&app.state::<HotkeyCtl>()))
}

/// Release every shortcut while Settings records a combo; claim them back
/// when it is done (or cancelled).
#[tauri::command]
pub fn hotkeys_suspend(app: AppHandle, suspended: bool) {
    let ctl = app.state::<HotkeyCtl>();
    if suspended {
        let _ = app.global_shortcut().unregister_all();
        ctl.live.lock().unwrap().clear();
    } else {
        let bindings = ctl.bindings.lock().unwrap().clone();
        apply(&app, bindings);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_fill_gaps_and_unknown_actions_drop() {
        let mut chosen = BTreeMap::new();
        chosen.insert("ptt".to_string(), " F13 ".to_string());
        chosen.insert("hud".to_string(), String::new());
        chosen.insert("bogus".to_string(), "Ctrl+B".to_string());
        let b = with_defaults(chosen);
        assert_eq!(b.len(), ACTIONS.len());
        assert_eq!(b["ptt"], "F13");
        assert_eq!(b["hud"], "", "off stays off");
        assert_eq!(b["ask"], "Ctrl+Shift+H");
        assert!(!b.contains_key("bogus"));
    }

    #[test]
    fn every_default_and_recorded_form_parses() {
        for (_, combo) in ACTIONS {
            assert!(Shortcut::from_str(combo).is_ok(), "{combo}");
        }
        // The shapes src/ui/hotkeys.ts records.
        for combo in ["F13", "Ctrl+Alt+Numpad5", "Alt+Shift+ArrowUp", "Ctrl+Super+Backquote", "Pause"] {
            assert!(Shortcut::from_str(combo).is_ok(), "{combo}");
        }
    }
}
