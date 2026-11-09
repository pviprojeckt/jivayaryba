'use strict';
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
function element() {
  const classes = new Set(['hidden']);
  return {
    value: '', checked: false, innerHTML: '', innerText: '', textContent: '', children: [], style: {}, disabled: false,
    classList: { add: n => classes.add(n), remove: n => classes.delete(n), contains: n => classes.has(n),
      toggle(n, flag) { const next = flag === undefined ? !classes.has(n) : flag; next ? classes.add(n) : classes.delete(n); return next; } },
    appendChild(child) { this.children.push(child); }, append(...children) { this.children.push(...children); },
    setAttribute(n, v) { this[n] = v; }, removeAttribute(n) { delete this[n]; }, addEventListener() {},
    focus() {}, blur() {}, querySelector() { return element(); }
  };
}
function app({ telegram = null, storage = new Map(), storageThrows = false } = {}) {
  const nodes = new Map(), timers = [], events = {}, alerts = [];
  const get = id => { if (!nodes.has(id)) nodes.set(id, element()); return nodes.get(id); };
  const document = { hidden: false, body: element(), getElementById: get, createElement: element,
    querySelectorAll: () => [], querySelector: () => null, addEventListener(n, cb) { (events[n] ||= []).push(cb); } };
  const context = vm.createContext({ document, window: { Telegram: telegram, innerHeight: 800 },
    localStorage: { getItem(k) { return storage.get(k) ?? null; },
      setItem(k, v) { if (storageThrows) throw new Error('QuotaExceededError'); storage.set(k, v); }, removeItem(k) { storage.delete(k); } },
    setInterval() {}, setTimeout(cb) { timers.push(cb); return timers.length; }, clearTimeout() {},
    console, URL, Image: class {}, AbortController, Blob, Response, navigator: {},
    alert: text => alerts.push(text), confirm: () => false, fetch() { throw new Error('Unexpected network request'); } });
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\n\s*initCloudData\(\);\s*$/, '');
  const run = code => vm.runInContext(code, context, { filename: 'index.html' });
  run(script);
  return { get, context, run, storage, timers, alerts, events };
}
module.exports = { app, html };
