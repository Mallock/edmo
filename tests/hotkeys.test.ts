/**
 * Rebindable global shortcuts (GitHub issue #2).
 *
 * What these defend: a key press becomes a combo the Rust parser accepts
 * (src-tauri/src/hotkeys.rs tests the other half), a combo that would steal
 * an everyday key from every app is refused, and two actions cannot quietly
 * share one combo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_HOTKEYS,
  HOTKEY_ACTIONS,
  displayCombo,
  recordCombo,
  usedBy,
  type KeyPress,
} from '../src/ui/hotkeys.ts';

const press = (code: string, mods: Partial<KeyPress> = {}): KeyPress => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test('a recorded press reads the way the Rust parser spells it', () => {
  assert.deepEqual(recordCombo(press('Space', { ctrlKey: true, shiftKey: true })), {
    combo: 'Ctrl+Shift+Space',
  });
  assert.deepEqual(recordCombo(press('KeyM', { altKey: true })), { combo: 'Alt+M' });
  assert.deepEqual(recordCombo(press('Digit7', { ctrlKey: true, altKey: true })), {
    combo: 'Ctrl+Alt+7',
  });
  assert.deepEqual(recordCombo(press('Numpad5', { ctrlKey: true })), { combo: 'Ctrl+Numpad5' });
  assert.deepEqual(recordCombo(press('Backquote', { metaKey: true })), { combo: 'Super+Backquote' });
});

test('F13–F24 stand alone — the HOTAS push-to-talk the issue asked for', () => {
  assert.deepEqual(recordCombo(press('F13')), { combo: 'F13' });
  assert.deepEqual(recordCombo(press('F24')), { combo: 'F24' });
  assert.deepEqual(recordCombo(press('Pause')), { combo: 'Pause' });
  assert.deepEqual(recordCombo(press('F9', { shiftKey: true })), { combo: 'Shift+F9' });
});

test('a modifier on its own is still being built, not an answer', () => {
  assert.deepEqual(recordCombo(press('ControlLeft', { ctrlKey: true })), { waiting: true });
  assert.deepEqual(recordCombo(press('ShiftRight', { shiftKey: true })), { waiting: true });
  assert.deepEqual(recordCombo(press('MetaLeft', { metaKey: true })), { waiting: true });
});

test('a typing key needs Ctrl or Alt — bare or with Shift alone it would vanish everywhere', () => {
  assert.ok('error' in recordCombo(press('KeyV')));
  assert.ok('error' in recordCombo(press('Space')));
  assert.ok('error' in recordCombo(press('KeyV', { shiftKey: true })));
  assert.ok('error' in recordCombo(press('ArrowUp')));
});

test('keys the parser does not know are refused, not saved broken', () => {
  assert.ok('error' in recordCombo(press('IntlBackslash', { ctrlKey: true })));
  assert.ok('error' in recordCombo(press('ContextMenu', { ctrlKey: true })));
});

test('one combo cannot serve two actions, however it is spelled', () => {
  assert.equal(usedBy(DEFAULT_HOTKEYS, 'Ctrl+Shift+M', 'ptt'), 'hud');
  assert.equal(usedBy(DEFAULT_HOTKEYS, 'shift+control+keym', 'ptt'), 'hud');
  assert.equal(usedBy(DEFAULT_HOTKEYS, 'Ctrl+Shift+M', 'hud'), null, 'its own combo is not a clash');
  assert.equal(usedBy(DEFAULT_HOTKEYS, 'Ctrl+Alt+M', 'ptt'), null);
  assert.equal(usedBy({ ...DEFAULT_HOTKEYS, hud: '' }, 'Ctrl+Shift+M', 'ptt'), null, 'off is free');
});

test('every action has a default and a row in Settings', () => {
  assert.deepEqual(
    HOTKEY_ACTIONS.map((a) => a.id).sort(),
    Object.keys(DEFAULT_HOTKEYS).sort(),
  );
});

test('display: Windows calls it Win, and an empty binding is off', () => {
  assert.equal(displayCombo('Ctrl+Super+F13'), 'Ctrl+Win+F13');
  assert.equal(displayCombo(''), 'off');
  assert.equal(displayCombo('Ctrl+Shift+Space'), 'Ctrl+Shift+Space');
});
