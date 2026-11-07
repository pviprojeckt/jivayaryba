'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const classes = new Set(['hidden']);
  return {
    value: '', checked: false, children: [], innerHTML: '', textContent: '', innerText: '',
    classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
      toggle: (name, force) => force === undefined
        ? (classes.has(name) ? (classes.delete(name), false) : (classes.add(name), true))
        : (force ? classes.add(name) : classes.delete(name), force),
      contains: (name) => classes.has(name)
    },
    appendChild(child) { this.children.push(child); },
    append(...children) { this.children.push(...children); },
    removeAttribute(name) { delete this[name]; }
  };
}

function app() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/\n\s*initCloudData\(\);\s*$/, '');
  const nodes = new Map();
  const document = {
    hidden: false,
    body: element(),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element,
    addEventListener() {},
    querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    document, window: { Telegram: null },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    localStorage: { getItem() { return null; }, setItem() {} },
    console, URL, Image: class {}, fetch() { throw new Error('Unexpected network call'); }
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  vm.runInContext('saveData = async () => true; triggerHaptic = () => {}', context);
  return { context, nodes, get: (id) => document.getElementById(id), run: (code) => vm.runInContext(code, context) };
}

test('menu buttons keep TTK, photo, weighted dishes and ordering controls', () => {
  const ui = app();
  ui.run('menuItems = [{ name: "Стейк", price: 1200, cat: "Горячее", isHosper: true, ttk: "Состав", photoId: "photo" }]; tables = { "Стол 1": { guests: [] } }');
  ui.run('renderStopList(); renderMenuDirect()');
  const management = ui.get('stopListContainer').children[0].innerHTML;
  const orderMenu = ui.get('directMenuList').children[0].innerHTML;
  assert.match(management, /openDishTtkEdit\(0\)/);
  assert.match(management, /openDishPhoto\(0\)/);
  assert.match(management, /openDishEditModal\(0\)/);
  assert.match(orderMenu, /openDishTtkView\(0\)/);
  assert.match(orderMenu, /openDishPhoto\(0\)/);
  assert.match(orderMenu, /orderMenuItemByIdx\(0, this\)/);
  assert.match(orderMenu, /100 г/);
  ui.run('orderMenuItemByIdx(0, null)');
  assert.equal(ui.get('hosperItemTitle').innerText, 'Стейк');
  assert.equal(ui.get('hospersModal').classList.contains('hidden'), false);
  ui.run('stopListSet.add("Стейк"); renderMenuDirect()');
  assert.match(ui.get('directMenuList').children.at(-1).innerHTML, /disabled/);
});

test('dish editing and TTK saving preserve its photo reference', () => {
  const ui = app();
  ui.run('menuItems = [{ name: "Борщ", price: 400, cat: "Супы", photoId: "current", photoHistory: ["old"], ttk: "Состав" }]');
  ui.run('openDishEditModal(0)');
  ui.get('dishEditName').value = 'Борщ фирменный';
  ui.get('dishEditPrice').value = '450';
  ui.run('saveDishEdit()');
  assert.equal(ui.run('menuItems[0].name'), 'Борщ фирменный');
  assert.equal(ui.run('menuItems[0].photoId'), 'current');
  assert.equal(ui.run('menuItems[0].photoHistory[0]'), 'old');
  ui.run('openDishTtkEdit(0)');
  ui.get('dishTtkEditTtk').value = 'Новый состав';
  ui.run('saveDishTtk()');
  assert.equal(ui.run('menuItems[0].ttk'), 'Новый состав');
  assert.equal(ui.run('menuItems[0].photoId'), 'current');
});

test('replacing a photo keeps earlier photos restorable', async () => {
  const ui = app();
  ui.run('menuItems = [{ name: "Борщ", price: 400, cat: "Супы", photoId: "first", photoHistory: ["older"] }]; dishPhotoIdx = 0');
  ui.run('prepareDishPhoto = async () => "jpeg"; apiPost = async () => ({ photoId: "second" }); renderDishPhoto = async () => {}');
  await ui.run('uploadDishPhoto({ type: "image/jpeg" })');
  assert.equal(ui.run('menuItems[0].photoId'), 'second');
  assert.equal(ui.run('menuItems[0].photoHistory.join(",")'), 'first,older');
  await ui.run('restorePreviousDishPhoto()');
  assert.equal(ui.run('menuItems[0].photoId'), 'first');
  assert.equal(ui.run('menuItems[0].photoHistory.join(",")'), 'older,second');
});

test('PRO opens a Telegram draft for the selected term without claiming payment', () => {
  const ui = app();
  let openedUrl = '';
  ui.context.window.open = (url) => { openedUrl = url; };
  ui.run('userId = "123456789"; openProPaymentModal(); selectTariff(365, 2490, "1 год"); openCreatorTelegramChat()');
  assert.equal(ui.get('proPaymentModal').classList.contains('hidden'), false);
  assert.equal(ui.get('paymentModalPriceVal').innerText, '2490 ₽');
  const link = new URL(openedUrl);
  assert.equal(link.origin, 'https://t.me');
  assert.equal(link.pathname, '/patricianw');
  assert.match(link.searchParams.get('text'), /Хочу купить подписку PRO на 1 год \(2\s?490 ₽\)/);
  assert.match(link.searchParams.get('text'), /Мой Telegram ID: 123456789/);
  assert.doesNotMatch(link.searchParams.get('text'), /Оплатил|чек/);
  let miniAppUrl = '';
  ui.context.window.Telegram = { WebApp: { openTelegramLink: (url) => { miniAppUrl = url; } } };
  ui.run('openCreatorTelegramChat()');
  assert.equal(miniAppUrl, openedUrl);
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  assert.match(html, /<span>Оплатить PRO<\/span>/);
  assert.doesNotMatch(html, /devCardNumberInput|copyDevCard|\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b/);
});
