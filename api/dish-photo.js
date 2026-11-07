'use strict';

/** Фото блюд: закрытый бакет Supabase, отдельный путь для каждого проверенного Telegram ID. */
const crypto = require('crypto');
const lib = require('./_lib');

const BUCKET = 'pult-dish-photos';
const MAX_PHOTO_BYTES = 700000;
const PHOTO_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function storageRequest(method, path, body, contentType) {
  const cfg = lib.cfg();
  if (!cfg.supabaseKey) throw new Error('SUPABASE_SECRET_KEY не задан');
  const headers = { apikey: cfg.supabaseKey };
  if (cfg.supabaseKey.startsWith('eyJ')) headers.Authorization = 'Bearer ' + cfg.supabaseKey;
  if (contentType) headers['Content-Type'] = contentType;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(cfg.supabaseUrl + '/storage/v1/' + path, {
      method, headers, body, signal: controller.signal
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || 'Ошибка хранилища');
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    clearTimeout(timer);
  }
}

async function ensurePrivateBucket() {
  try {
    const bucket = await storageRequest('GET', 'bucket/' + BUCKET);
    if (bucket.public) throw new Error('Бакет фотографий должен быть закрытым.');
    return;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  try {
    await storageRequest('POST', 'bucket', JSON.stringify({
      id: BUCKET, name: BUCKET, public: false,
      file_size_limit: MAX_PHOTO_BYTES, allowed_mime_types: ['image/jpeg']
    }), 'application/json');
  } catch (error) {
    if (error.status !== 409) throw error;
    const bucket = await storageRequest('GET', 'bucket/' + BUCKET);
    if (bucket.public) throw new Error('Бакет фотографий должен быть закрытым.');
  }
}

async function signedPhotoUrl(userId, photoId) {
  const objectPath = userId + '/' + photoId + '.jpg';
  const result = await storageRequest('POST',
    'object/sign/' + BUCKET + '/' + objectPath,
    JSON.stringify({ expiresIn: 600 }), 'application/json');
  const raw = result.signedURL || result.signedUrl;
  if (typeof raw !== 'string') throw new Error('Хранилище не вернуло ссылку на фото.');
  const base = lib.cfg().supabaseUrl;
  const normalized = raw.startsWith('/object/') ? '/storage/v1' + raw
    : raw.startsWith('object/') ? '/storage/v1/' + raw : raw;
  const url = new URL(normalized, base);
  if (url.origin !== new URL(base).origin ||
      url.pathname !== '/storage/v1/object/sign/' + BUCKET + '/' + objectPath) {
    throw new Error('Хранилище вернуло некорректную ссылку.');
  }
  return url.href;
}

module.exports = lib.wrap(async (req, res) => {
  const auth = lib.authenticate(req);
  if (!auth.ok) return lib.send(res, auth.status, { error: auth.error, reason: auth.reason });
  const body = lib.readBody(req) || {};

  try {
    if (body.action === 'view') {
      if (typeof body.photoId !== 'string' || !PHOTO_ID.test(body.photoId)) {
        return lib.send(res, 400, { error: 'Некорректный номер фото.' });
      }
      const url = await signedPhotoUrl(auth.userId, body.photoId);
      return lib.send(res, 200, { url });
    }

    if (body.action === 'upload') {
      if (lib.rateLimited('dish-photo:' + auth.userId, 120, 3600000)) {
        return lib.send(res, 429, { error: 'Слишком много фото за час. Попробуйте позже.' });
      }
      const image = body.image;
      if (typeof image !== 'string' || image.length > Math.ceil(MAX_PHOTO_BYTES * 4 / 3) + 4 ||
          !/^[A-Za-z0-9+/]+={0,2}$/.test(image)) {
        return lib.send(res, 400, { error: 'Некорректное фото.' });
      }
      const bytes = Buffer.from(image, 'base64');
      if (bytes.length < 5 || bytes.length > MAX_PHOTO_BYTES || bytes[0] !== 0xff ||
          bytes[1] !== 0xd8 || bytes[2] !== 0xff ||
          bytes[bytes.length - 2] !== 0xff || bytes[bytes.length - 1] !== 0xd9) {
        return lib.send(res, 400, { error: 'Загрузите фото JPG размером до 700 КБ.' });
      }
      await ensurePrivateBucket();
      const photoId = crypto.randomUUID();
      await storageRequest('POST', 'object/' + BUCKET + '/' + auth.userId + '/' + photoId + '.jpg', bytes, 'image/jpeg');
      // Фото уже сохранено: даже если ссылка временно не выдаётся, возвращаем ID для сохранения в меню.
      let url = null;
      try { url = await signedPhotoUrl(auth.userId, photoId); } catch (error) {
        console.error('[dish-photo] ссылка:', error.message);
      }
      return lib.send(res, 200, { photoId, url });
    }

    return lib.send(res, 400, { error: 'Неизвестное действие.' });
  } catch (error) {
    if (error.status === 404) return lib.send(res, 404, { error: 'Фото не найдено.' });
    console.error('[dish-photo] ошибка:', error.status || '-', error.message);
    return lib.send(res, 503, { error: 'Не удалось сохранить или открыть фото. Попробуйте ещё раз.' });
  }
});
