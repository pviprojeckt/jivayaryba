'use strict';

/**
 * /api/state — облачное хранилище данных пользователя (вместо прямого доступа браузера к Supabase).
 *  {action:'load', gz?:true}               → { state } или { stateGz } (gzip+base64, если данных много и клиент умеет)
 *  {action:'save', state:{…}}              → { ok:true }
 *  {action:'save', stateGz:'<gzip+base64>'} → { ok:true }  (сжатие нужно, чтобы архив смен не упёрся в лимит 4.5 МБ запроса)
 * Ключ записи — ПРОВЕРЕННЫЙ Telegram ID, поэтому читать и перезаписывать чужие данные нельзя.
 * Поля подписки из состояния вырезаются: статус PRO живёт только в таблице subscriptions.
 */

const zlib = require('zlib');
const lib = require('./_lib');

const MAX_PLAIN_BYTES = 4000000;      // лимит тела запроса у Vercel — 4.5 МБ (считаем в байтах, кириллица = 2 байта)
const MAX_GZ_BASE64_CHARS = 4400000;  // сжатое тело тоже ограничено лимитом запроса
const MAX_UNPACKED_BYTES = 40000000;  // защита от «бомбы»: во сколько раз можно распаковать
const GZIP_RESPONSE_MIN_BYTES = 200000;
const FORBIDDEN_KEYS = ['proUnlimited', 'proExpiresAt', 'trialUsed', 'usedPromoCodes'];

function stripProFields(state) {
  if (!state || typeof state !== 'object') return state;
  const copy = { ...state };
  for (const k of FORBIDDEN_KEYS) delete copy[k];
  return copy;
}

// Не даём записать структуру, которая ломает загрузку приложения или меняет прототипы.
function validState(state) {
  const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
  const safeTree = (value, depth = 0) => {
    if (depth > 30) return false;
    if (!value || typeof value !== 'object') return typeof value !== 'number' || Number.isFinite(value);
    return Object.keys(value).every(key => !['__proto__', 'prototype', 'constructor'].includes(key)
      && safeTree(value[key], depth + 1));
  };
  const list = (value, check) => Array.isArray(value) && value.every(check);
  const amount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const item = value => object(value) && typeof value.name === 'string' && amount(value.price);
  const bill = value => object(value) && amount(value.tip) && amount(value.subtotal)
    && (value.items === undefined || list(value.items, item));
  if (!object(state) || !safeTree(state)) return false;
  if (state.tables !== undefined && (!object(state.tables) || !Object.values(state.tables).every(t =>
    object(t) && list(t.items, item) && Number.isInteger(t.guests) && t.guests >= 1 && t.guests <= 100
    && (t.guestNames === undefined || object(t.guestNames))
    && (t.splitGroups === undefined || (object(t.splitGroups) && Object.values(t.splitGroups).every(g => list(g, n => typeof n === 'string'))))))) return false;
  if (state.menuItems !== undefined && !list(state.menuItems, item)) return false;
  if (state.closedHistory !== undefined && !list(state.closedHistory, bill)) return false;
  if (state.shiftArchive !== undefined && !list(state.shiftArchive, s => object(s)
    && typeof s.dateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s.dateKey)
    && amount(s.totalEarned) && (s.items === undefined || list(s.items, bill)))) return false;
  if (state.stopListSet !== undefined && !list(state.stopListSet, s => typeof s === 'string')) return false;
  return ['hourlyRate', 'salesPercent', 'shiftTipGoal'].every(key => state[key] === undefined || amount(state[key]));
}

module.exports = lib.wrap(async (req, res) => {
  const auth = lib.authenticate(req);
  if (!auth.ok) return lib.send(res, auth.status, { error: auth.error, reason: auth.reason });

  const body = lib.readBody(req) || {};
  const action = String(body.action || '');

  try {
    if (action === 'load') {
      const rows = await lib.sb(
        'GET',
        'app_states?telegram_id=eq.' + encodeURIComponent(auth.userId) + '&select=state,updated_at&limit=1'
      );
      const state = Array.isArray(rows) && rows[0] && rows[0].state ? stripProFields(rows[0].state) : null;
      const updatedAt = Array.isArray(rows) && rows[0] ? rows[0].updated_at : null;
      if (state && body.gz === true) {
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > GZIP_RESPONSE_MIN_BYTES) {
          return lib.send(res, 200, { stateGz: zlib.gzipSync(json).toString('base64'), updatedAt });
        }
      }
      return lib.send(res, 200, { state, updatedAt });
    }

    if (action === 'save') {
      let state = body.state;
      if (typeof body.stateGz === 'string') {
        if (body.stateGz.length > MAX_GZ_BASE64_CHARS) return lib.send(res, 413, { error: 'Данных слишком много.' });
        try {
          const raw = zlib.gunzipSync(Buffer.from(body.stateGz, 'base64'), { maxOutputLength: MAX_UNPACKED_BYTES });
          state = JSON.parse(raw.toString('utf8'));
        } catch (e) {
          return lib.send(res, 400, { error: 'Некорректные данные.' });
        }
      }
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return lib.send(res, 400, { error: 'Некорректные данные.' });
      }
      const clean = stripProFields(state);
      if (!validState(clean)) return lib.send(res, 400, { error: 'Некорректная структура данных. Предыдущие данные в облаке сохранены.' });
      if (typeof body.stateGz !== 'string' && Buffer.byteLength(JSON.stringify(clean)) > MAX_PLAIN_BYTES) {
        return lib.send(res, 413, { error: 'Данных слишком много. Отправьте обновлённое приложение: оно сжимает данные.' });
      }
      const updatedAt = new Date(Math.max(Date.now(), (Date.parse(body.expectedUpdatedAt) || 0) + 1)).toISOString();
      // Новые клиенты передают версию, чтобы две сессии не затирали изменения друг друга.
      if (Object.hasOwn(body, 'expectedUpdatedAt')) {
        const expected = body.expectedUpdatedAt;
        if (expected !== null && (typeof expected !== 'string' || !Number.isFinite(Date.parse(expected)))) {
          return lib.send(res, 400, { error: 'Некорректная версия данных.' });
        }
        const rows = expected === null
          ? await lib.sb('POST', 'app_states?on_conflict=telegram_id&select=updated_at', {
              headers: { Prefer: 'resolution=ignore-duplicates,return=representation' },
              body: { telegram_id: auth.userId, state: clean, updated_at: updatedAt }
            })
          : await lib.sb('PATCH', 'app_states?telegram_id=eq.' + encodeURIComponent(auth.userId)
              + '&updated_at=eq.' + encodeURIComponent(expected) + '&select=updated_at', {
              headers: { Prefer: 'return=representation' },
              body: { state: clean, updated_at: updatedAt }
            });
        if (!Array.isArray(rows) || !rows.length) return lib.send(res, 409, { error: 'Данные изменились в другой сессии. Откройте статус облака, чтобы выбрать нужную копию.' });
        return lib.send(res, 200, { ok: true, updatedAt: rows[0].updated_at });
      }
      // Совместимость с уже открытыми сессиями предыдущей версии.
      await lib.sb('POST', 'app_states?on_conflict=telegram_id', {
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { telegram_id: auth.userId, state: clean, updated_at: updatedAt }
      });
      return lib.send(res, 200, { ok: true, updatedAt });
    }

    return lib.send(res, 400, { error: 'Неизвестное действие.' });
  } catch (e) {
    return lib.handleDbError(res, e);
  }
});
