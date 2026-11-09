'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./app-harness.cjs');
function client(status = 'missed', version = true) {
  const events = {};
  let adds = 0;
  const tg = { initData: 'test-signed-session', ready() {}, expand() {}, isVersionAtLeast: () => version,
    onEvent(n, cb) { events[n] = cb; }, checkHomeScreenStatus(cb) { cb(status); }, addToHomeScreen() { adds++; } };
  return { tg, events, adds: () => adds, status: s => { status = s; } };
}
test('shortcut stays hidden outside Telegram, on older clients and unsupported devices', () => {
  for (const tg of [null, client('missed', false).tg, client('unsupported').tg]) {
    const ui = app({ telegram: tg && { WebApp: tg } });
    assert.equal(ui.get('homeScreenShortcut').classList.contains('hidden'), true);
    ui.run('addAppToHomeScreen()');
  }
});
test('supported status shows the button; installation only runs after a click and resists double clicks', () => {
  for (const status of ['missed', 'unknown']) {
    const api = client(status), ui = app({ telegram: { WebApp: api.tg } });
    assert.equal(ui.get('homeScreenShortcut').classList.contains('hidden'), false);
    assert.equal(api.adds(), 0);
    ui.run('addAppToHomeScreen(); addAppToHomeScreen()');
    assert.equal(api.adds(), 1);
    assert.equal(ui.get('homeScreenShortcutButton').disabled, true);
    ui.timers.at(-1)();
    assert.equal(ui.get('homeScreenShortcutButton').disabled, false);
    assert.equal(ui.get('homeScreenShortcutLabel').textContent, 'Добавить на главный экран');
    ui.run('addAppToHomeScreen()');
    assert.equal(api.adds(), 2);
  }
});
test('confirmed installation disables repeat; unknown status does not erase the success event', () => {
  const api = client('unknown'), ui = app({ telegram: { WebApp: api.tg } });
  ui.run('addAppToHomeScreen()');
  api.events.homeScreenAdded();
  ui.timers.at(-1)();
  assert.equal(ui.get('homeScreenShortcutLabel').textContent, 'Уже на главном экране');
  assert.equal(ui.get('homeScreenShortcutButton').disabled, true);
  api.status('missed'); api.events.activated();
  assert.equal(ui.get('homeScreenShortcutButton').disabled, false);
  api.status('unknown'); api.events.activated();
  assert.equal(ui.get('homeScreenShortcutButton').disabled, false);
});
test('already installed and failed API calls are handled without breaking the app', () => {
  const api = client('added'), ui = app({ telegram: { WebApp: api.tg } });
  assert.equal(ui.get('homeScreenShortcutButton').disabled, true);
  api.status('missed'); api.events.activated();
  api.tg.addToHomeScreen = () => { throw new Error('unavailable'); };
  ui.run('addAppToHomeScreen()');
  assert.match(ui.get('homeScreenShortcutHint').textContent, /Не удалось/);
  assert.equal(ui.get('homeScreenShortcutButton').disabled, false);
});
