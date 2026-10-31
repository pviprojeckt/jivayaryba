'use strict';

/**
 * /api/pro — статус подписки и активация промокода.
 *  POST {action:'status'}               → { userId, isAdmin, pro:{active,unlimited,expiresAt,trialUsed} }
 *  POST {action:'redeem', code:'...'}   → активирует промокод PULT-XXXX-XXXX-XXXX или TEST (7 дней, один раз)
 * Личность пользователя берётся ТОЛЬКО из проверенной подписи Telegram, а не из того, что прислал клиент.
 */

const lib = require('./_lib');

module.exports = lib.wrap(async (req, res) => {
  const auth = lib.authenticate(req);
  if (!auth.ok) return lib.send(res, auth.status, { error: auth.error });

  const body = lib.readBody(req) || {};
  const action = String(body.action || 'status');

  try {
    if (action === 'status') {
      const row = await lib.getSubscription(auth.userId);
      return lib.send(res, 200, { userId: auth.userId, isAdmin: auth.isAdmin, pro: lib.proView(row, auth.isAdmin) });
    }

    if (action === 'redeem') {
      if (lib.rateLimited('redeem:' + auth.userId, 10, 10 * 60 * 1000)) {
        return lib.send(res, 429, { error: 'Слишком много попыток. Подождите несколько минут.' });
      }
      const code = lib.normalizeCode(body.code);
      if (!code) return lib.send(res, 400, { error: 'Введите промокод.' });

      let kind = 'code';
      if (code === 'TEST') {
        kind = 'trial';
        const r = await lib.rpc('start_trial', { p_tid: auth.userId, p_days: lib.TRIAL_DAYS });
        const started = Array.isArray(r) && r[0] && r[0].out_started === true;
        if (!started) {
          return lib.send(res, 409, { error: 'Пробный период уже использован на этом аккаунте. Оформите подписку.' });
        }
      } else {
        await lib.rpc('redeem_promo', { p_hash: lib.hashCode(code, lib.cfg().pepper), p_tid: auth.userId });
      }

      const row = await lib.getSubscription(auth.userId);
      return lib.send(res, 200, {
        ok: true,
        kind,
        userId: auth.userId,
        isAdmin: auth.isAdmin,
        pro: lib.proView(row, auth.isAdmin)
      });
    }

    return lib.send(res, 400, { error: 'Неизвестное действие.' });
  } catch (e) {
    return lib.handleDbError(res, e);
  }
});
