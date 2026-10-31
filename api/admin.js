'use strict';

/**
 * /api/admin — выдача доступа. Работает ТОЛЬКО для Telegram ID из ADMIN_TELEGRAM_IDS.
 * Проверка идёт на сервере по подписи Telegram: спрятать кнопку в интерфейсе мало, защищает именно эта проверка.
 *
 *  {action:'create_code', days | unlimited:true, targetId?, validDays?}  → { code } (показывается один раз, в базе только хэш)
 *  {action:'grant',       targetId, days | unlimited:true}               → сразу выдать доступ без кода
 *  {action:'lookup',      targetId}                                      → статус подписки пользователя
 *  {action:'revoke',      targetId}                                      → отозвать доступ (возврат денег и т.п.)
 */

const lib = require('./_lib');

const isTid = (v) => typeof v === 'string' && /^\d{1,15}$/.test(v);

module.exports = lib.wrap(async (req, res) => {
  const auth = lib.authenticate(req);
  if (!auth.ok) return lib.send(res, auth.status, { error: auth.error });
  if (!auth.isAdmin) return lib.send(res, 403, { error: 'Недостаточно прав.' });
  if (lib.rateLimited('admin:' + auth.userId, 60, 10 * 60 * 1000)) {
    return lib.send(res, 429, { error: 'Слишком много запросов. Подождите.' });
  }

  const body = lib.readBody(req) || {};
  const action = String(body.action || '');
  const targetId = body.targetId == null || body.targetId === '' ? null : String(body.targetId).trim();
  const unlimited = body.unlimited === true;
  const days = Number(body.days);

  const checkDuration = () => {
    if (unlimited) return true;
    return Number.isInteger(days) && days >= 1 && days <= 3660;
  };

  try {
    if (action === 'create_code') {
      if (!checkDuration()) return lib.send(res, 400, { error: 'Некорректный срок (1–3660 дней).' });
      if (targetId !== null && !isTid(targetId)) return lib.send(res, 400, { error: 'ID должен состоять только из цифр.' });
      const validDays = Math.min(365, Math.max(1, Math.floor(Number(body.validDays)) || 60));
      const expiresAt = new Date(Date.now() + validDays * 86400000).toISOString();
      const pepper = lib.cfg().pepper;

      let code = null;
      for (let i = 0; i < 3 && !code; i++) {
        const candidate = lib.generateCode();
        try {
          await lib.sb('POST', 'promo_codes', {
            headers: { Prefer: 'return=minimal' },
            body: {
              code_hash: lib.hashCode(candidate, pepper),
              days: unlimited ? null : days,
              unlimited,
              bound_telegram_id: targetId,
              created_by: auth.userId,
              expires_at: expiresAt
            }
          });
          code = candidate;
        } catch (e) {
          if (e && e.status === 409) continue; // совпадение хэша — исчезающе редко, пробуем другой код
          throw e;
        }
      }
      if (!code) return lib.send(res, 503, { error: 'Не удалось создать код. Повторите.' });

      await lib.sb('POST', 'pro_audit', {
        headers: { Prefer: 'return=minimal' },
        body: { actor: auth.userId, target: targetId, action: 'create_code', details: { days: unlimited ? null : days, unlimited } }
      });
      return lib.send(res, 200, { ok: true, code, days: unlimited ? null : days, unlimited, boundTo: targetId, expiresAt });
    }

    if (action === 'grant') {
      if (!isTid(targetId)) return lib.send(res, 400, { error: 'Введите числовой ID покупателя.' });
      if (!checkDuration()) return lib.send(res, 400, { error: 'Некорректный срок (1–3660 дней).' });
      await lib.rpc('grant_pro', { p_tid: targetId, p_days: unlimited ? null : days, p_unlimited: unlimited, p_actor: auth.userId });
      const row = await lib.getSubscription(targetId);
      return lib.send(res, 200, { ok: true, targetId, pro: lib.proView(row, false) });
    }

    if (action === 'lookup') {
      if (!isTid(targetId)) return lib.send(res, 400, { error: 'Введите числовой ID.' });
      const row = await lib.getSubscription(targetId);
      return lib.send(res, 200, { ok: true, targetId, pro: lib.proView(row, false) });
    }

    if (action === 'revoke') {
      if (!isTid(targetId)) return lib.send(res, 400, { error: 'Введите числовой ID.' });
      await lib.rpc('revoke_pro', { p_tid: targetId, p_actor: auth.userId });
      const row = await lib.getSubscription(targetId);
      return lib.send(res, 200, { ok: true, targetId, pro: lib.proView(row, false) });
    }

    return lib.send(res, 400, { error: 'Неизвестное действие.' });
  } catch (e) {
    return lib.handleDbError(res, e);
  }
});
