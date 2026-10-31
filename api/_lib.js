'use strict';

/**
 * Общий модуль серверных функций (файл с «_» в начале Vercel не превращает в отдельный адрес).
 *
 * Переменные окружения (Vercel → Settings → Environment Variables):
 *  TELEGRAM_BOT_TOKEN       — токен бота из @BotFather (обязательно)
 *  SUPABASE_SECRET_KEY      — секретный ключ Supabase «sb_secret_…» (обязательно, только на сервере!)
 *  ADMIN_TELEGRAM_IDS       — ваш числовой Telegram ID; несколько — через запятую (обязательно)
 *  GEMINI_API_KEY           — ключ Gemini (для api/scan.js)
 *  SUPABASE_URL             — адрес проекта (по умолчанию подставлен ваш)
 *  CODE_PEPPER              — любая случайная строка: «соль» для хэшей промокодов (рекомендуется)
 *  INITDATA_MAX_AGE_SEC     — сколько живёт подпись Telegram, по умолчанию 3 дня
 */

const crypto = require('crypto');

const DEFAULT_SUPABASE_URL = 'https://avrtgjldydchwgtvgrqt.supabase.co';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // без похожих символов: 0/O, 1/I/L
const TRIAL_DAYS = 7;

function cfg() {
  return {
    botToken: process.env.TELEGRAM_BOT_TOKEN || '',
    supabaseUrl: (process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL).replace(/\/+$/, ''),
    supabaseKey: process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '',
    adminIds: new Set(
      (process.env.ADMIN_TELEGRAM_IDS || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d{1,15}$/.test(s))
    ),
    pepper: process.env.CODE_PEPPER || '',
    initDataMaxAge: Number(process.env.INITDATA_MAX_AGE_SEC) || 3 * 86400
  };
}

// ------------------------------------------------------------ ответы и обёртка

function send(res, status, body) {
  res.setHeader('Cache-Control', 'no-store');
  res.status(status).json(body);
}

function readBody(req) {
  const b = req.body;
  if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return b;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/** Только POST + перехват неожиданных ошибок (клиент получает понятный текст, подробности — в логах). */
function wrap(fn) {
  return async function handler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return send(res, 405, { error: 'Метод не поддерживается.' });
      }
      await fn(req, res);
    } catch (e) {
      console.error('[api] необработанная ошибка:', e && e.stack ? e.stack : e);
      if (!res.headersSent) send(res, 500, { error: 'Внутренняя ошибка сервера. Повторите позже.' });
    }
  };
}

// ------------------------------------------------------------ Telegram initData

/**
 * Проверка подписи Telegram Mini App (алгоритм из документации Telegram):
 * secret = HMAC_SHA256("WebAppData", bot_token); hash = HMAC_SHA256(secret, data_check_string).
 */
function verifyInitData(initData, botToken, maxAgeSec) {
  if (!initData || typeof initData !== 'string' || !botToken) return { ok: false, reason: 'missing' };
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash || !/^[0-9a-f]{64}$/i.test(hash)) return { ok: false, reason: 'missing' };
  params.delete('hash');

  const dataCheckString = Array.from(params.entries())
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([k, v]) => k + '=' + v)
    .join('\n');

  const secret = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const calc = crypto.createHmac('sha256', secret).update(dataCheckString).digest();
  const given = Buffer.from(hash, 'hex');
  if (calc.length !== given.length || !crypto.timingSafeEqual(calc, given)) return { ok: false, reason: 'bad_signature' };

  const authDate = Number(params.get('auth_date'));
  const age = Date.now() / 1000 - authDate;
  if (!Number.isFinite(authDate) || age < -300) return { ok: false, reason: 'bad_signature' };
  if (age > (maxAgeSec || 86400)) return { ok: false, reason: 'expired' };

  let user = null;
  try {
    user = JSON.parse(params.get('user') || 'null');
  } catch (e) {
    user = null;
  }
  if (!user || typeof user !== 'object' || !/^\d{1,15}$/.test(String(user.id))) return { ok: false, reason: 'bad_signature' };
  return { ok: true, user };
}

/** Единая проверка «кто это» для всех функций. */
function authenticate(req) {
  const c = cfg();
  if (!c.botToken) return { ok: false, status: 500, error: 'Сервер не настроен (нет TELEGRAM_BOT_TOKEN). Напишите разработчику.' };
  const h = req.headers && req.headers['x-telegram-init-data'];
  const v = verifyInitData(Array.isArray(h) ? h[0] : h, c.botToken, c.initDataMaxAge);
  if (!v.ok) {
    return {
      ok: false,
      status: 401,
      error:
        v.reason === 'expired'
          ? 'Сессия устарела. Закройте приложение и откройте его в Telegram заново.'
          : 'Откройте приложение из Telegram и попробуйте снова.'
    };
  }
  const userId = String(v.user.id);
  return { ok: true, userId, user: v.user, isAdmin: c.adminIds.has(userId) };
}

// ------------------------------------------------------------ лимит частоты (в памяти инстанса)

const buckets = new Map();
function rateLimited(key, limit, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  if (arr.length >= limit) {
    buckets.set(key, arr);
    return true;
  }
  arr.push(now);
  buckets.set(key, arr);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
    }
  }
  return false;
}

// ------------------------------------------------------------ Supabase (REST, без внешних библиотек)

/**
 * Секретный ключ нового формата (sb_secret_…) передаётся ТОЛЬКО в заголовке apikey.
 * Старый service_role (длинный JWT, начинается с eyJ) дополнительно идёт в Authorization.
 */
async function sb(method, path, opts) {
  const o = opts || {};
  const c = cfg();
  if (!c.supabaseKey) {
    const e = new Error('SUPABASE_SECRET_KEY не задан');
    e.status = 500;
    e.notConfigured = true;
    throw e;
  }
  const headers = Object.assign({ apikey: c.supabaseKey, 'Content-Type': 'application/json' }, o.headers || {});
  if (c.supabaseKey.indexOf('eyJ') === 0) headers.Authorization = 'Bearer ' + c.supabaseKey;

  const attempts = method === 'GET' ? 2 : 1; // повторяем только чтение: запись повторять небезопасно
  let lastErr = null;
  for (let i = 0; i < attempts; i++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(c.supabaseUrl + '/rest/v1/' + path, {
        method,
        headers,
        body: o.body === undefined ? undefined : JSON.stringify(o.body),
        signal: controller.signal
      });
      const text = await res.text();
      let json = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch (e) {
        json = null;
      }
      if (res.ok) return json;
      const err = new Error((json && (json.message || json.hint)) || String(text).slice(0, 200) || 'HTTP ' + res.status);
      err.status = res.status;
      err.pg = json;
      if (method === 'GET' && res.status >= 500 && i + 1 < attempts) {
        lastErr = err;
        continue;
      }
      throw err;
    } catch (e) {
      if (e && e.status) throw e;
      lastErr = e;
      if (i + 1 >= attempts) {
        const err = new Error('Нет связи с базой: ' + (e && e.message));
        err.status = 503;
        throw err;
      }
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr || new Error('Неизвестная ошибка базы');
}

const rpc = (name, args) => sb('POST', 'rpc/' + name, { body: args });

// ------------------------------------------------------------ подписки

async function getSubscription(tid) {
  const rows = await sb(
    'GET',
    'subscriptions?telegram_id=eq.' + encodeURIComponent(tid) + '&select=pro_expires_at,pro_unlimited,trial_used&limit=1'
  );
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

/** Что показываем клиенту. Админ всегда имеет доступ (чтобы вы сами не заперлись). */
function proView(row, isAdmin) {
  const unlimited = !!(row && row.pro_unlimited) || !!isAdmin;
  const ms = row && row.pro_expires_at ? Date.parse(row.pro_expires_at) : NaN;
  const expiresAt = Number.isFinite(ms) ? ms : null;
  const active = unlimited || (expiresAt !== null && expiresAt > Date.now());
  return { active, unlimited, expiresAt: unlimited ? null : expiresAt, trialUsed: !!(row && row.trial_used) };
}

// ------------------------------------------------------------ промокоды

function normalizeCode(raw) {
  let s = String(raw == null ? '' : raw).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length === 16 && s.indexOf('PULT') === 0) s = s.slice(4); // PULT-XXXX-XXXX-XXXX → XXXXXXXXXXXX
  return s;
}

function hashCode(raw, pepper) {
  return crypto.createHash('sha256').update((pepper || '') + ':' + normalizeCode(raw)).digest('hex');
}

function generateCode() {
  let s = '';
  for (let i = 0; i < 12; i++) s += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return 'PULT-' + s.slice(0, 4) + '-' + s.slice(4, 8) + '-' + s.slice(8, 12);
}

const DB_ERRORS = {
  CODE_INVALID: [400, 'Неверный промокод. Проверьте, что ввели его без ошибок.'],
  CODE_USED: [409, 'Этот промокод уже использован.'],
  CODE_EXPIRED: [410, 'Срок действия промокода истёк. Попросите выпустить новый.'],
  CODE_FOREIGN: [403, 'Этот промокод выпущен для другого пользователя.'],
  BAD_DAYS: [400, 'Некорректный срок подписки.']
};

/** Единая обработка ошибок базы: бизнес-ошибки — понятным текстом, остальное — в лог. */
function handleDbError(res, e) {
  const msg = e && e.pg && e.pg.message;
  if (msg && DB_ERRORS[msg]) return send(res, DB_ERRORS[msg][0], { error: DB_ERRORS[msg][1] });
  console.error('[db] ошибка:', e && e.status, e && e.message, e && e.pg ? JSON.stringify(e.pg) : '');
  if (e && e.notConfigured) return send(res, 500, { error: 'База данных не настроена на сервере. Напишите разработчику.' });
  return send(res, 503, { error: 'База данных временно недоступна. Повторите через минуту.' });
}

module.exports = {
  TRIAL_DAYS,
  cfg,
  send,
  readBody,
  wrap,
  verifyInitData,
  authenticate,
  rateLimited,
  sb,
  rpc,
  getSubscription,
  proView,
  normalizeCode,
  hashCode,
  generateCode,
  handleDbError
};
