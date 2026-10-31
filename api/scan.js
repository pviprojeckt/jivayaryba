'use strict';

/**
 * /api/scan — серверная функция ИИ-сканера меню (Gemini Vision).
 *
 * Что делает:
 *  - принимает фото меню (base64) от Mini App;
 *  - просит Gemini вернуть СТРОГО структурированный JSON: [{ name, price, cat }];
 *  - при перегрузке Google (503 "high demand"), лимитах (429), таймаутах — повторяет запрос
 *    с нарастающей паузой и переключается на запасную модель;
 *  - никогда не отдаёт клиенту сырой английский текст ошибки Google — только понятные сообщения;
 *  - пускает только проверенных пользователей Telegram с активной подпиской PRO (или пробным периодом),
 *    чтобы чужие не жгли ваш ключ Gemini.
 *
 * Переменные окружения (Vercel → Settings → Environment Variables):
 *  GEMINI_API_KEY          — ключ Gemini (обязательно)
 *  GEMINI_MODELS           — список моделей через запятую по приоритету
 *                            (по умолчанию: gemini-3.5-flash,gemini-3.1-flash-lite).
 *                            Названия моделей Google меняет и выключает старые — держите список в env,
 *                            а не в коде.
 *  (Telegram/Supabase переменные описаны в _lib.js: TELEGRAM_BOT_TOKEN, SUPABASE_SECRET_KEY, ADMIN_TELEGRAM_IDS.)
 *  SCAN_TIME_BUDGET_MS     — общий бюджет времени на один скан (по умолчанию 50000).
 *  SCAN_ATTEMPTS_PER_MODEL — попыток на модель (по умолчанию 2).
 *  SCAN_RATE_LIMIT         — макс. сканов на пользователя за 10 минут (по умолчанию 30).
 *
 * Важно: функции нужно разрешить работать дольше 10 секунд. Для Vercel — vercel.json:
 *  { "functions": { "api/scan.js": { "maxDuration": 60 } } }
 */

const lib = require('./_lib');

const GEMINI_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const DEFAULT_MODELS = ['gemini-3.5-flash', 'gemini-3.1-flash-lite'];
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/webp']);
const CATEGORIES = ['Закуски', 'Салаты', 'Супы', 'Горячее', 'Пицца', 'Десерты', 'Бар'];
const MAX_BASE64_CHARS = 4000000; // ~3 МБ картинки; у Vercel лимит тела запроса 4.5 МБ
const MAX_ITEMS = 400;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

const PROMPT = [
  'Ты — сканер ресторанных меню. На фото меню или его часть. Извлеки все блюда и напитки, у которых указана цена.',
  '',
  'Правила:',
  '1. name — только название позиции, без веса, объёма, калорий и описания состава.',
  '   Если у позиции несколько размеров/объёмов с разными ценами (например 0,3 л — 250 и 0,4 л — 300),',
  '   верни отдельные позиции и добавь объём в название: «Капучино 0,3 л».',
  '2. price — число в валюте меню, без символа валюты и без пробелов (1 200 → 1200).',
  '3. cat — ровно одна категория из списка: ' + CATEGORIES.join(', ') + '.',
  '   Напитки, кофе, чай, лимонады, пиво, вино, коктейли — «Бар». Основные блюда, паста, стейки, гарниры — «Горячее».',
  '4. Ничего не выдумывай. Если цена нечитаема или её нет — пропусти позицию.',
  '5. Игнорируй заголовки разделов, адреса, телефоны, рекламу, акции и пояснения без цены.',
  '6. Не повторяй одну и ту же позицию дважды. Названия оставляй на языке меню.',
  '',
  'Верни только JSON-массив объектов вида {"name": "...", "price": 123, "cat": "..."}.'
].join('\n');

const RESPONSE_SCHEMA = {
  type: 'ARRAY',
  items: {
    type: 'OBJECT',
    properties: {
      name: { type: 'STRING' },
      price: { type: 'NUMBER' },
      cat: { type: 'STRING', enum: CATEGORIES }
    },
    required: ['name', 'price', 'cat']
  }
};

// ---------------------------------------------------------------- конфиг

function getConfig() {
  const models = (process.env.GEMINI_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '',
    models: models.length ? models : DEFAULT_MODELS,
    budgetMs: Number(process.env.SCAN_TIME_BUDGET_MS) || 50000,
    attemptsPerModel: Math.max(1, Number(process.env.SCAN_ATTEMPTS_PER_MODEL) || 2),
    attemptTimeoutMs: Number(process.env.SCAN_ATTEMPT_TIMEOUT_MS) || 28000,
    backoffBaseMs: Number(process.env.SCAN_BACKOFF_BASE_MS) || 900,
    rateLimit: Number(process.env.SCAN_RATE_LIMIT) || 30
  };
}

// ---------------------------------------------------------------- разбор ответа модели

function stripFences(text) {
  return String(text || '')
    .replace(/^\s*```(?:json)?\s*/i, '')
    .replace(/\s*```\s*$/i, '')
    .trim();
}

/** Парсит JSON; если ответ обрезан (MAX_TOKENS), спасает все полностью записанные объекты. */
function parseModelJson(text) {
  const clean = stripFences(text);
  if (!clean) return null;
  try {
    return JSON.parse(clean);
  } catch (e) {
    const start = clean.indexOf('[');
    if (start === -1) return null;
    let end = clean.lastIndexOf('}');
    while (end > start) {
      try {
        return JSON.parse(clean.slice(start, end + 1) + ']');
      } catch (err) {
        end = clean.lastIndexOf('}', end - 1);
      }
    }
    return null;
  }
}

function toPrice(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  let s = String(raw == null ? '' : raw).replace(/[\s\u00a0\u202f]/g, '').replace(/[^\d.,]/g, '');
  if (!s) return NaN;
  if (/^\d{1,3}([.,]\d{3})+$/.test(s)) s = s.replace(/[.,]/g, '');
  else s = s.replace(',', '.');
  return Number(s);
}

function sanitizeItems(arr) {
  const out = [];
  const seen = new Set();
  for (const it of arr) {
    if (!it || typeof it !== 'object') continue;
    const name = String(it.name == null ? '' : it.name).replace(/\s+/g, ' ').trim().slice(0, 120);
    const price = toPrice(it.price);
    if (!name || !Number.isFinite(price) || price <= 0 || price > 50000) continue;
    const cat = CATEGORIES.includes(it.cat) ? it.cat : '';
    const key = name.toLowerCase() + '|' + Math.round(price);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name, price: Math.round(price), cat });
    if (out.length >= MAX_ITEMS) break;
  }
  return out;
}

function extractItems(json) {
  const cand = json && Array.isArray(json.candidates) ? json.candidates[0] : null;
  if (!cand || !cand.content || !Array.isArray(cand.content.parts)) return null;
  const text = cand.content.parts
    .filter((p) => p && typeof p.text === 'string' && !p.thought)
    .map((p) => p.text)
    .join('');
  const parsed = parseModelJson(text);
  let arr = null;
  if (Array.isArray(parsed)) arr = parsed;
  else if (parsed && Array.isArray(parsed.items)) arr = parsed.items;
  else if (parsed && Array.isArray(parsed.menu)) arr = parsed.menu;
  return arr ? sanitizeItems(arr) : null;
}

// ---------------------------------------------------------------- вызов Gemini

async function callGemini(model, cfg, imageBase64, mimeType, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(GEMINI_BASE + '/' + encodeURIComponent(model) + ':generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cfg.apiKey },
      body: JSON.stringify({
        contents: [
          {
            role: 'user',
            parts: [{ text: PROMPT }, { inline_data: { mime_type: mimeType, data: imageBase64 } }]
          }
        ],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16000,
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA
        }
      }),
      signal: controller.signal
    });
    const raw = await res.text();
    let json = null;
    try {
      json = JSON.parse(raw);
    } catch (e) {
      /* не JSON — оставим raw для логов */
    }
    return { ok: res.ok, status: res.status, json, raw };
  } finally {
    clearTimeout(timer);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Перебирает модели и повторяет запросы, пока не получится или не кончится бюджет времени. */
async function scanWithFallback(cfg, imageBase64, mimeType) {
  const started = Date.now();
  const failures = []; // { model, status, note }
  const timeLeft = () => cfg.budgetMs - (Date.now() - started);

  for (const model of cfg.models) {
    for (let attempt = 1; attempt <= cfg.attemptsPerModel; attempt++) {
      if (timeLeft() < 4000) return { items: null, failures, outOfTime: true };

      let retry = false;
      try {
        const r = await callGemini(model, cfg, imageBase64, mimeType, Math.min(cfg.attemptTimeoutMs, timeLeft() - 500));
        if (r.ok) {
          const items = extractItems(r.json);
          if (items) return { items, model, failures };
          const blocked = r.json && r.json.promptFeedback && r.json.promptFeedback.blockReason;
          failures.push({ model, status: 'bad_output', note: blocked ? 'blocked:' + blocked : 'unparseable' });
          retry = !blocked && attempt < cfg.attemptsPerModel; // модель иногда отдаёт мусор — одна повторная попытка
        } else {
          const msg = r.json && r.json.error && r.json.error.message ? r.json.error.message : String(r.raw).slice(0, 200);
          failures.push({ model, status: r.status, note: msg });
          retry = RETRYABLE_STATUSES.has(r.status);
          // 404 = модель выключена/не существует, 400/401/403 = проблема запроса или ключа: повтор не поможет.
        }
      } catch (e) {
        failures.push({ model, status: e && e.name === 'AbortError' ? 'timeout' : 'network', note: String(e && e.message) });
        retry = true;
      }

      if (!retry) break; // к следующей модели
      const pause = cfg.backoffBaseMs * Math.pow(2, attempt - 1) + Math.random() * 300;
      if (timeLeft() > pause + 4000) await sleep(pause);
    }
  }
  return { items: null, failures };
}

// ---------------------------------------------------------------- HTTP-обработчик

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

async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(res, 405, { error: 'Метод не поддерживается.' });
  }

  const cfg = getConfig();
  if (!cfg.apiKey) {
    console.error('[scan] GEMINI_API_KEY не задан в переменных окружения');
    return send(res, 500, { error: 'Сканер не настроен на сервере. Напишите разработчику.' });
  }

  // 1) Кто это: только проверенный пользователь Telegram (подпись проверяется на сервере)
  const auth = lib.authenticate(req);
  if (!auth.ok) return send(res, auth.status, { error: auth.error });

  // 2) Лимит частоты на пользователя
  if (lib.rateLimited('scan:' + auth.userId, cfg.rateLimit, 10 * 60 * 1000)) {
    return send(res, 429, { error: 'Слишком много сканирований подряд. Подождите несколько минут.' });
  }

  // 2.1) Подписка: сканер стоит денег, поэтому только PRO / пробный период / админ
  if (!auth.isAdmin) {
    let row = null;
    try {
      row = await lib.getSubscription(auth.userId);
    } catch (e) {
      console.error('[scan] не удалось проверить подписку:', e && e.message);
      return send(res, 503, { error: 'Не удалось проверить подписку. Повторите через минуту.' });
    }
    if (!lib.proView(row, false).active) {
      return send(res, 402, { error: 'Для сканирования нужна активная подписка PRO. Активируйте промокод в приложении.' });
    }
  }

  // 3) Валидация входа
  const body = readBody(req);
  if (!body) return send(res, 400, { error: 'Некорректный запрос.' });
  const imageBase64 = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/^data:[^,]+,/, '') : '';
  const mimeType = typeof body.mimeType === 'string' ? body.mimeType.toLowerCase() : '';
  if (!ALLOWED_MIME.has(mimeType)) return send(res, 400, { error: 'Поддерживаются только фото JPG, PNG и WEBP.' });
  if (!imageBase64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) return send(res, 400, { error: 'Фото повреждено. Попробуйте другое.' });
  if (imageBase64.length > MAX_BASE64_CHARS) return send(res, 413, { error: 'Фото слишком большое. Сделайте снимок поменьше.' });

  // 4) Сканирование с повторами и запасными моделями
  const result = await scanWithFallback(cfg, imageBase64, mimeType);

  if (result.items) {
    if (result.failures.length) {
      console.warn('[scan] успех после сбоев:', JSON.stringify(result.failures), '→ модель', result.model);
    }
    if (result.items.length === 0) {
      return send(res, 422, { error: 'На фото не нашлось блюд с ценами. Сфотографируйте меню ровнее и крупнее.' });
    }
    return send(res, 200, { items: result.items, model: result.model });
  }

  console.error('[scan] все попытки неудачны:', JSON.stringify(result.failures));
  const statuses = result.failures.map((f) => f.status);
  const authLike = statuses.length > 0 && statuses.every((s) => s === 401 || s === 403 || s === 404 || s === 400);
  if (authLike) {
    return send(res, 500, { error: 'Сканер временно недоступен из-за настроек сервера. Напишите разработчику.' });
  }
  if (statuses.length > 0 && statuses.every((s) => s === 429)) {
    return send(res, 429, { error: 'Достигнут лимит запросов к ИИ. Подождите минуту и повторите.' });
  }
  if (statuses.every((s) => s === 'bad_output')) {
    return send(res, 502, { error: 'ИИ не смог разобрать это фото. Попробуйте сфотографировать меню ближе и ровнее.' });
  }
  return send(res, 503, { error: 'ИИ-сервис Google сейчас перегружен. Мы уже пробовали несколько раз — повторите через минуту.' });
}

module.exports = handler;
module.exports._internals = {
  parseModelJson,
  sanitizeItems,
  extractItems,
  scanWithFallback,
  getConfig
};
