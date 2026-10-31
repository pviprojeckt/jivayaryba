'use strict';

/**
 * /api/state — облачное хранилище данных пользователя (вместо прямого доступа браузера к Supabase).
 *  {action:'load'}            → { state }
 *  {action:'save', state:{…}} → { ok:true }
 * Ключ записи — ПРОВЕРЕННЫЙ Telegram ID, поэтому читать и перезаписывать чужие данные нельзя.
 * Поля подписки из состояния вырезаются: статус PRO живёт только в таблице subscriptions.
 */

const lib = require('./_lib');

const MAX_STATE_BYTES = 4000000; // лимит тела запроса у Vercel — 4.5 МБ
const FORBIDDEN_KEYS = ['proUnlimited', 'proExpiresAt', 'trialUsed', 'usedPromoCodes'];

function stripProFields(state) {
  if (!state || typeof state !== 'object') return state;
  const copy = Object.assign({}, state);
  for (const k of FORBIDDEN_KEYS) delete copy[k];
  return copy;
}

module.exports = lib.wrap(async (req, res) => {
  const auth = lib.authenticate(req);
  if (!auth.ok) return lib.send(res, auth.status, { error: auth.error });

  const body = lib.readBody(req) || {};
  const action = String(body.action || '');

  try {
    if (action === 'load') {
      const rows = await lib.sb(
        'GET',
        'app_states?telegram_id=eq.' + encodeURIComponent(auth.userId) + '&select=state&limit=1'
      );
      const state = Array.isArray(rows) && rows[0] && rows[0].state ? stripProFields(rows[0].state) : null;
      return lib.send(res, 200, { state });
    }

    if (action === 'save') {
      const state = body.state;
      if (!state || typeof state !== 'object' || Array.isArray(state)) {
        return lib.send(res, 400, { error: 'Некорректные данные.' });
      }
      const clean = stripProFields(state);
      if (JSON.stringify(clean).length > MAX_STATE_BYTES) {
        return lib.send(res, 413, { error: 'Данных слишком много. Заархивируйте старые смены.' });
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
