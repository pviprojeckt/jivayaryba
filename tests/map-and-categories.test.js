'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./app-harness.cjs');

test('map editing restores Telegram swipes when leaving by each navigation path', () => {
  const calls = [];
  const WebApp = {
    ready() {},
    expand() {},
    isVersionAtLeast: () => true,
    disableVerticalSwipes() { calls.push('disable'); this.isVerticalSwipesEnabled = false; },
    enableVerticalSwipes() { calls.push('enable'); this.isVerticalSwipesEnabled = true; }
  };
  const ui = app({ telegram: { WebApp } });
  ui.run('loadLocalFallback(); setHallViewMode("map"); toggleMapEditMode(); toggleMapEditMode()');
  ui.run('toggleMapEditMode(); switchTab("stopList")');
  ui.run('openMapFromConstructor(); setHallViewMode("grid")');
  ui.run('openMapFromConstructor(); openHallConstructorModal()');
  assert.deepEqual(calls, Array(4).fill(['disable', 'enable']).flat());
  assert.equal(ui.run('isMapEditMode'), false);
  WebApp.isVerticalSwipesEnabled = false;
  ui.run('setHallViewMode("map"); toggleMapEditMode(); switchTab("stopList")');
  assert.equal(calls.length, 8);
  assert.equal(WebApp.isVerticalSwipesEnabled, false);
});

test('a new empty category persists across sessions and case variants are rejected', () => {
  const ui = app();
  ui.run('userId="42"; loadLocalFallback(); openCategoryModal()');
  ui.get('categoryName').value = '  Авторские   коктейли ';
  ui.run('saveCategory(); openCategoryModal()');
  ui.get('categoryName').value = 'АВТОРСКИЕ КОКТЕЙЛИ';
  ui.run('saveCategory()');
  assert.match(ui.get('categoryError').textContent, /уже есть/);
  assert.equal(ui.get('categoryModal').classList.contains('hidden'), false);
  const snapshot = JSON.parse(ui.storage.get('fish_pro_state_v3:42')).state;
  assert.deepEqual(snapshot.customCategories, ['Авторские коктейли']);
  assert.equal(snapshot.menuItems.some(item => item.cat === 'Авторские коктейли'), false);
  const reopened = app({ storage: ui.storage });
  reopened.run('userId="42"; loadLocalFallback(); openDishEditModal(null)');
  assert.ok(reopened.get('dishEditCats').children.some(button => button.textContent === 'Авторские коктейли'));
});

test('older dishes keep categories that were already present in saved menu items', () => {
  const ui = app();
  ui.run('applyAppState({menuItems:[{name:"Матча",price:250,cat:"Чай"}]}); openDishEditModal(0)');
  assert.equal(ui.run('dishEditCat'), 'Чай');
  ui.get('dishEditPrice').value = '260';
  ui.run('saveDishEdit()');
  assert.equal(ui.run('menuItems[0].cat'), 'Чай');
  assert.equal(ui.run('menuItems[0].price'), 260);
});
