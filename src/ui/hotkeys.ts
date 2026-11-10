/**
 * Global shortcuts the commander can rebind (GitHub issue #2).
 *
 * Rust owns the live registration and the saved file (app-config
 * shortcuts.json, so the keys work before this webview has loaded). This
 * module is what the Settings drawer needs on top: what each action is
 * called, how a key press becomes a combo the Rust parser accepts, and which
 * combos would do more harm than good.
 */

export type HotkeyAction = 'ptt' | 'hud' | 'ask' | 'voice' | 'cycle' | 'collapse' | 'clickthrough';

/** Action -> combo, '' = off. */
export type HotkeyBindings = Record<HotkeyAction, string>;

/** In the order Settings lists them: the one people actually rebind first. */
export const HOTKEY_ACTIONS: readonly { id: HotkeyAction; label: string }[] = [
  { id: 'ptt', label: 'Push-to-talk (hold)' },
  { id: 'hud', label: 'Show / hide HUD' },
  { id: 'ask', label: 'Ask "what now?"' },
  { id: 'voice', label: 'Voice on / off' },
  { id: 'cycle', label: 'Cycle mission' },
  { id: 'collapse', label: 'Collapse / expand' },
  { id: 'clickthrough', label: 'Click-through' },
];

/** Must match ACTIONS in src-tauri/src/hotkeys.rs. */
export const DEFAULT_HOTKEYS: HotkeyBindings = {
  ptt: 'Ctrl+Shift+Space',
  hud: 'Ctrl+Shift+M',
  ask: 'Ctrl+Shift+H',
  voice: 'Ctrl+Shift+V',
  cycle: 'Ctrl+Shift+J',
  collapse: 'Ctrl+Shift+K',
  clickthrough: 'Ctrl+Shift+T',
};

/** The parts of a KeyboardEvent recording needs. */
export interface KeyPress {
  code: string;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  metaKey: boolean;
}

export type Recorded = { combo: string } | { waiting: true } | { error: string };

const MODIFIER_CODE = /^(Control|Shift|Alt|Meta|OS)(Left|Right)?$/;

const NAMED_KEYS = new Set([
  'Space', 'Enter', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'Pause', 'ScrollLock', 'PrintScreen', 'CapsLock', 'NumLock', 'Backquote', 'Backslash',
  'BracketLeft', 'BracketRight', 'Comma', 'Period', 'Slash', 'Semicolon', 'Quote', 'Minus', 'Equal',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'MediaPlayPause', 'MediaStop',
  'MediaTrackNext', 'MediaTrackPrevious', 'AudioVolumeUp', 'AudioVolumeDown', 'AudioVolumeMute',
]);

/**
 * Keys nobody types with, so they may stand alone. F13–F24 matter most: no
 * keyboard has them, which is exactly why HOTAS software maps buttons to
 * them — a stick button for push-to-talk that steals nothing from the game.
 */
const BARE_OK = /^(F([1-9]|1[0-9]|2[0-4])|Pause|ScrollLock|Insert)$/;

/** A KeyboardEvent.code as the global-hotkey parser spells it, or null. */
function keyName(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  if (/^Numpad([0-9]|Add|Subtract|Multiply|Divide|Decimal|Enter|Equal)$/.test(code)) return code;
  return NAMED_KEYS.has(code) ? code : null;
}

/**
 * One keydown while Settings is listening. A modifier on its own means the
 * commander is still building the combo; Escape is handled by the caller
 * (it cancels), so it never arrives here as a binding.
 */
export function recordCombo(e: KeyPress): Recorded {
  if (MODIFIER_CODE.test(e.code)) return { waiting: true };
  const key = keyName(e.code);
  if (!key) return { error: 'That key cannot be a global shortcut.' };
  const mods = [
    e.ctrlKey && 'Ctrl',
    e.altKey && 'Alt',
    e.shiftKey && 'Shift',
    e.metaKey && 'Super',
  ].filter((m): m is string => !!m);
  // A global shortcut swallows its keys in EVERY app, the game included.
  // Shift alone does not make a typing key safe — Shift+A is just "A".
  if (!(e.ctrlKey || e.altKey || e.metaKey) && !BARE_OK.test(key)) {
    return {
      error: mods.length
        ? 'Add Ctrl or Alt. With Shift alone, that key would stop typing everywhere.'
        : 'Add Ctrl or Alt. On its own, that key would stop working everywhere else.',
    };
  }
  return { combo: [...mods, key].join('+') };
}

/** Comparable form: case, spelling and modifier order do not matter. */
function comboKey(combo: string): string {
  const parts = combo.split('+').map((p) => p.trim().toUpperCase());
  const key = (parts.pop() ?? '').replace(/^(KEY|DIGIT)(?=.$)/, '');
  const mods = parts.map((m) => (m === 'CONTROL' ? 'CTRL' : m === 'CMD' || m === 'COMMAND' ? 'SUPER' : m));
  return [...mods.sort(), key].join('+');
}

/** The other action already on this combo, if any. */
export function usedBy(
  bindings: HotkeyBindings,
  combo: string,
  self: HotkeyAction,
): HotkeyAction | null {
  const want = comboKey(combo);
  for (const { id } of HOTKEY_ACTIONS) {
    if (id !== self && bindings[id] && comboKey(bindings[id]) === want) return id;
  }
  return null;
}

/** How a combo reads in the UI: "Ctrl+Shift+Space", "Win+F13", "off". */
export function displayCombo(combo: string | undefined): string {
  if (!combo) return 'off';
  return combo.replace(/\bSuper\b/, 'Win');
}

export function actionLabel(id: HotkeyAction): string {
  return HOTKEY_ACTIONS.find((a) => a.id === id)?.label ?? id;
}
