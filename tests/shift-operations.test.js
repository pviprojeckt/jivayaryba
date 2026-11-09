'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function element() {
  const classes = new Set(['hidden']);
  const listeners = {};
  return {
    value: '', checked: false, innerHTML: '', innerText: '', textContent: '', children: [], style: {},
    listeners, className: '',
    classList: {
      add: name => classes.add(name),
      remove: name => classes.delete(name),
      contains: name => classes.has(name),
      toggle: (name, force) => force ? classes.add(name) : classes.delete(name)
    },
    appendChild(child) { this.children.push(child); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, callback) { listeners[name] = callback; },
    setPointerCapture() {},
    getBoundingClientRect() { return this.rect || { left: 0, top: 0, width: 300, height: 600 }; }
  };
}

function app() {
  const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    .replace(/\n\s*initCloudData\(\);\s*$/, '');
  const nodes = new Map();
  const storage = new Map();
  const document = {
    hidden: false, body: element(),
    getElementById(id) { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); },
    createElement: element, addEventListener() {}, querySelectorAll() { return []; }
  };
  const context = vm.createContext({
    document, window: { Telegram: null, innerHeight: 800, crypto: { randomUUID: () => `id-${Math.random()}` } },
    localStorage: { getItem: key => storage.has(key) ? storage.get(key) : null, setItem: (key, value) => storage.set(key, value) },
    setInterval() {}, setTimeout() {}, clearTimeout() {},
    console, URL, Image: class {}, fetch() { throw new Error('Unexpected network call'); }
  });
  vm.runInContext(script, context, { filename: 'index.html' });
  vm.runInContext('realRenderTableCard=renderTableCard; realRenderTables=renderTables; realRenderMenuDirect=renderMenuDirect; realRenderStopList=renderStopList; triggerHaptic=()=>{}; renderTableCard=()=>{}; renderTables=()=>{}; renderMenuDirect=()=>{}; renderStopList=()=>{}; showStockToast=(message)=>{lastToast=message};', context);
  return { context, nodes, storage, get: id => document.getElementById(id), run: code => vm.runInContext(code, context) };
}

test('stock decrements once, auto-stops at zero, and restores only a debited portion', () => {
  const ui = app();
  ui.run('menuItems=[{name:"Сибас",price:1000,cat:"Горячее",stock:null,isHosper:true}]; tables={"Стол 1":createEmptyTableObj(2)}');
  ui.run('setItemStock(0,2)');
  assert.equal(ui.run('menuItems[0].stock'), 2);
  assert.ok(ui.run('menuItems[0].stockId'));
  ui.run('addItemToTableDirect("Сибас (350г)",3500,null,menuItems[0].stockId)');
  assert.equal(ui.run('menuItems[0].stock'), 1);
  assert.equal(ui.run('tables["Стол 1"].items[0].served'), false);
  ui.run('addItemToTableDirect("Сибас (400г)",4000,null,menuItems[0].stockId)');
  assert.equal(ui.run('menuItems[0].stock'), 0);
  assert.equal(ui.run('stopListSet.has("Сибас")'), true);
  assert.equal(ui.run('addItemToTableDirect("Сибас (500г)",5000,null,menuItems[0].stockId)'), false);
  assert.equal(ui.run('tables["Стол 1"].items.length'), 2);
  ui.run('menuItems[0].name="Сибас фирменный"; stopListSet.delete("Сибас"); stopListSet.add("Сибас фирменный"); removeItem(1)');
  assert.equal(ui.run('menuItems[0].stock'), 1);
  assert.equal(ui.run('stopListSet.has("Сибас фирменный")'), false);
  ui.run('tables["Стол 1"].items.push({name:"Старый заказ",price:100,served:false}); removeItem(1)');
  assert.equal(ui.run('menuItems[0].stock'), 1);
});

test('changing a zero stock controls the stop list without losing manual stops', () => {
  const ui = app();
  ui.run('menuItems=[{name:"Борщ",price:400,cat:"Супы"}]; setItemStock(0,0)');
  assert.equal(ui.run('stopListSet.has("Борщ")'), true);
  ui.run('toggleStopItemByIdx(0)');
  assert.equal(ui.run('stopListSet.has("Борщ")'), true);
  ui.run('setItemStock(0,2)');
  assert.equal(ui.run('stopListSet.has("Борщ")'), false);
  ui.run('toggleStopItemByIdx(0); setItemStock(0,3)');
  assert.equal(ui.run('stopListSet.has("Борщ")'), true);
  ui.run('clearItemStock(0)');
  assert.equal(ui.run('menuItems[0].stock'), null);
  assert.equal(ui.run('stopListSet.has("Борщ")'), true);
});

test('served status updates legacy items and the compact active-table list', () => {
  const ui = app();
  ui.run('tables={"Стол 1":createEmptyTableObj(2)}; tables["Стол 1"].items=[{name:"Борщ",price:400},{name:"Чай",price:200}]');
  ui.run('renderMyTables()');
  assert.match(ui.get('myActiveTablesList').children[0].innerHTML, /Подано: 0\/2/);
  assert.match(ui.get('myActiveTablesList').children[0].innerHTML, /toggleItemServedByTableIdx\(0, 0\)/);
  ui.run('toggleItemServedByTableIdx(0,0)');
  assert.equal(ui.run('tables["Стол 1"].items[0].served'), true);
  assert.match(ui.get('myActiveTablesList').children[1].innerHTML, /Подано: 1\/2/);
  ui.run('markAllItemsServed()');
  assert.equal(ui.run('tables["Стол 1"].items.every(item=>item.served)'), true);
});

test('map places old tables separately and saves pointer placement and view mode', async () => {
  const ui = app();
  ui.run('tables={}; for(let i=1;i<=15;i++) tables["Стол "+i]=createEmptyTableObj(2); ensureTableMapCoords()');
  const positions = ui.run('Object.values(tables).map(t=>`${t.x},${t.y}`)');
  assert.equal(new Set(positions).size, 15);
  assert.equal(ui.run('Object.values(tables).every(t=>t.x>=2&&t.x<=70&&t.y>=2&&t.y<=82)'), true);
  ui.run('for(let i=16;i<=100;i++) tables["Стол "+i]=createEmptyTableObj(2); ensureTableMapCoords()');
  assert.equal(new Set(ui.run('Object.values(tables).map(t=>`${t.x},${t.y}`)')).size, 100);
  ui.run('tables["Стол 1"].x=50; ensureTableMapCoords()');
  assert.equal(ui.run('tables["Стол 1"].x'), 50);

  ui.run('isMapEditMode=true; renderHallMap(["Стол 1"], {free:"free-dot",ok:"ok-dot",warn:"warn-dot",alert:"alert-dot"})');
  const widget = ui.get('hallMapCanvasContainer').children[0];
  const event = (x, y) => ({ pointerId: 7, clientX: x, clientY: y, preventDefault() {} });
  widget.listeners.pointerdown(event(10, 10));
  widget.listeners.pointermove(event(160, 250));
  widget.listeners.pointerup(event(160, 250));
  assert.equal(ui.run('tables["Стол 1"].x'), 50);
  assert.equal(ui.run('tables["Стол 1"].y'), 40);

  ui.run('sendStateToCloud=async state=>{savedState=JSON.parse(JSON.stringify(state))}; hallViewMode="map"; saveData()');
  await ui.run('saveQueue');
  assert.equal(ui.storage.get('fish_pro_hall_view_mode'), 'map');
  assert.equal(ui.run('savedState.hallViewMode'), 'map');
  assert.equal(ui.run('savedState.tables["Стол 1"].y'), 40);
});

test('the three screens expose the new controls with old orders and a limited menu', () => {
  const ui = app();
  ui.run('tables={"Стол 1":createEmptyTableObj(2)}; tables["Стол 1"].items=[{name:"Борщ",price:400}]; menuItems=[{name:"Борщ",price:400,cat:"Супы",stock:3}]; normalizeMenuStock()');
  ui.run('realRenderTableCard(); realRenderStopList(); realRenderMenuDirect()');
  assert.match(ui.get('servedProgress').innerHTML, /Подано блюд: 0 из 1/);
  assert.match(ui.get('currentTableItems').children[0].innerHTML, /toggleItemServed\(currentTable, 0\)/);
  assert.match(ui.get('stopListContainer').children[0].innerHTML, /Остаток: 3 шт\./);
  assert.match(ui.get('directMenuList').children[0].innerHTML, /Осталось: 3 шт\./);
  ui.run('hallViewMode="map"; realRenderTables()');
  assert.equal(ui.get('hallMapCanvasContainer').classList.contains('hidden'), false);
  assert.equal(ui.get('tablesGrid').classList.contains('hidden'), true);
  const widget = ui.get('hallMapCanvasContainer').children[0];
  widget.onclick();
  assert.equal(ui.run('tableToOpenGuests'), 'Стол 1');
});
