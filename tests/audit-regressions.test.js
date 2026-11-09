'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./app-harness.cjs');
test('full checkout preserves the position of the table on the hall map', () => {
  const ui=app();
  ui.run('tables={"Стол 1":{...createEmptyTableObj(2),x:60,y:30}}; tables["Стол 1"].items=[{name:"Чай",price:100,guest:"Гость 1"}]; tables["Стол 1"].splitGroups={"Счёт":["Гость 1"]}; selectedCheckoutGroup="Счёт"; confirmBillCheckout()');
  assert.equal(ui.run('tables["Стол 1"].x'),60);
  assert.equal(ui.run('tables["Стол 1"].y'),30);
  assert.equal(ui.run('tables["Стол 1"].items.length'),0);
  assert.equal(ui.run('closedHistory[0].subtotal'),100);
});
test('untrusted history fields cannot become HTML in the rendered bill history', () => {
  const ui=app();
  ui.context.payload='<img src=x onerror=alert(1)>';
  ui.run('closedHistory=[{tableName:payload,time:payload,tip:payload,subtotal:0,paymentMethod:payload,tipType:payload,items:[]}]; renderStats()');
  const markup=ui.get('closedTablesHistory').children[0].innerHTML;
  assert.doesNotMatch(markup,/<img/);
  assert.match(markup,/&lt;img/);
});
test('non-finite and negative inputs do not enter orders, tips or guest counts', () => {
  const ui=app();
  ui.run('tables={"Стол 1":createEmptyTableObj(2)}; tableToOpenGuests="Стол 1"');
  assert.equal(ui.run('addItemToTableDirect("x",Infinity,null)'),false);
  assert.equal(ui.run('addItemToTableDirect("x",-1,null)'),false);
  ui.run('confirmGuestsCount(Infinity); confirmGuestsCount(1.5)');
  assert.equal(ui.run('tables["Стол 1"].guests'),2);
  ui.get('manualTipSumInput').value='Infinity'; ui.run('confirmManualTipModal()');
  assert.equal(ui.run('closedHistory.length'),0);
});
test('renaming a guest to another guest name cannot merge their orders', () => {
  const ui=app();
  ui.run('tables={"Стол 1":createEmptyTableObj(2)}; tables["Стол 1"].items=[{name:"Чай",price:100,guest:"Гость 1"},{name:"Кофе",price:200,guest:"Гость 2"}]; renameGuest(1); simpleModalCallback("Гость 2")');
  assert.equal(ui.run('tables["Стол 1"].guestNames[1]'),'Гость 1');
  assert.equal(ui.run('tables["Стол 1"].items[0].guest'),'Гость 1');
  assert.match(ui.alerts.at(-1),/не смешать счета/);
});
