'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

process.env.TELEGRAM_BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwxyz1234567890';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
const handler = require('../api/dish-photo');

function initData(userId) {
  const fields = new URLSearchParams({ auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: userId }) });
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const data = [...fields.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => k + '=' + v).join('\n');
  fields.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return fields.toString();
}

async function call(body, userId = '42', signed = true) {
  const res = {
    statusCode: 200,
    setHeader() {},
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.body = payload; return this; }
  };
  await handler({ method: 'POST', headers: signed ? { 'x-telegram-init-data': initData(userId) } : {}, body }, res);
  return res;
}

test('uploads a JPEG only to a private user folder and signs it for the owner', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  let bucketCreated = false;
  const objects = new Set();
  global.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    assert.equal(options.headers.apikey, 'sb_secret_test_only');
    assert.equal(options.headers.Authorization, undefined);
    if (path.endsWith('/bucket/pult-dish-photos') && options.method === 'GET') {
      return Response.json(bucketCreated ? { public: false } : { message: 'not found' }, { status: bucketCreated ? 200 : 404 });
    }
    if (path.endsWith('/bucket') && options.method === 'POST') {
      const bucket = JSON.parse(options.body);
      assert.equal(bucket.public, false);
      assert.equal(bucket.allowed_mime_types[0], 'image/jpeg');
      bucketCreated = true;
      return Response.json({ name: bucket.name });
    }
    if (path.includes('/object/pult-dish-photos/') && options.method === 'POST') {
      assert.match(path, /\/object\/pult-dish-photos\/42\/[0-9a-f-]+\.jpg$/);
      assert.equal(options.headers['Content-Type'], 'image/jpeg');
      objects.add(path.replace('/storage/v1/object/', ''));
      return Response.json({ Key: path });
    }
    if (path.includes('/object/sign/pult-dish-photos/') && options.method === 'POST') {
      const object = path.replace('/storage/v1/object/sign/', '');
      if (!objects.has(object)) return Response.json({ message: 'not found' }, { status: 404 });
      return Response.json({ signedURL: path.replace('/storage/v1', '') + '?token=test' });
    }
    throw new Error('Unexpected storage request: ' + path);
  };

  const image = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0xff, 0xd9]).toString('base64');
  const upload = await call({ action: 'upload', image });
  assert.equal(upload.statusCode, 200);
  assert.match(upload.body.photoId, /^[0-9a-f-]{36}$/);
  assert.match(upload.body.url, /\/pult-dish-photos\/42\//);
  assert.equal(bucketCreated, true);

  const ownView = await call({ action: 'view', photoId: upload.body.photoId });
  assert.equal(ownView.statusCode, 200);
  assert.equal(ownView.body.url, upload.body.url);
  const foreignView = await call({ action: 'view', photoId: upload.body.photoId }, '43');
  assert.equal(foreignView.statusCode, 404);
  assert.equal(objects.size, 1);
});

test('rejects unsigned requests and invalid photo data before touching storage', async (t) => {
  const originalFetch = global.fetch;
  t.after(() => { global.fetch = originalFetch; });
  global.fetch = async () => { throw new Error('Storage must not be called'); };
  assert.equal((await call({ action: 'view', photoId: crypto.randomUUID() }, '42', false)).statusCode, 401);
  assert.equal((await call({ action: 'view', photoId: '../43/photo.jpg' })).statusCode, 400);
  assert.equal((await call({ action: 'upload', image: Buffer.from('not a JPEG').toString('base64') })).statusCode, 400);
});
