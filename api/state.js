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
  const copy = Object.assign({}, state);
  for (const k of FORBIDDEN_KEYS) delete copy[k];
  return copy;
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
        'app_states?telegram_id=eq.' + encodeURIComponent(auth.userId) + '&select=state&limit=1'
      );
      const state = Array.isArray(rows) && rows[0] && rows[0].state ? stripProFields(rows[0].state) : null;
      if (state && body.gz === true) {
        const json = JSON.stringify(state);
        if (Buffer.byteLength(json) > GZIP_RESPONSE_MIN_BYTES) {
          return lib.send(res, 200, { stateGz: zlib.gzipSync(json).toString('base64') });
        }
      }
      return lib.send(res, 200, { state });
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
      if (typeof body.stateGz !== 'string' && Buffer.byteLength(JSON.stringify(clean)) > MAX_PLAIN_BYTES) {
        return lib.send(res, 413, { error: 'Данных слишком много. Отправьте обновлённое приложение: оно сжимает данные.' });
      }
      await lib.sb('POST', 'app_states?on_conflict=telegram_id', {
        headers: { Prefer: 'resolution=merge-duplicates,return=minimal' },
        body: { telegram_id: auth.userId, state: clean, updated_at: new Date().toISOString() }
      });
      return lib.send(res, 200, { ok: true });
    }

    return lib.send(res, 400, { error: 'Неизвестное действие.' });
  } catch (e) {
    return lib.handleDbError(res, e);
  }
});
