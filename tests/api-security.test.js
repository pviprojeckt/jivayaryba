'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
process.env.TELEGRAM_BOT_TOKEN = '123456:abcdefghijklmnopqrstuvwxyz1234567890';
process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_only';
process.env.ADMIN_TELEGRAM_IDS = '999';
process.env.GEMINI_API_KEY = 'test-only';
const lib = require('../api/_lib');
const handlers = Object.fromEntries(['state','admin','pro','scan','dish-photo'].map(n => [n, require('../api/' + n)]));
function signed(id = 42, extras = {}) {
  const p = new URLSearchParams({ auth_date: String(Math.floor(Date.now()/1000)), user: JSON.stringify({id}), ...extras });
  const secret = crypto.createHmac('sha256', 'WebAppData').update(process.env.TELEGRAM_BOT_TOKEN).digest();
  const data = [...p.entries()].sort(([a],[b]) => a.localeCompare(b)).map(([k,v]) => k+'='+v).join('\n');
  p.set('hash', crypto.createHmac('sha256', secret).update(data).digest('hex'));
  return p.toString();
}
async function call(name, body, auth = signed(), method = 'POST') {
  const res = { headers: {}, setHeader(k,v) { this.headers[k]=v; }, status(code) { this.statusCode=code; return this; }, json(body) { this.body=body; } };
  await handlers[name]({method, headers: auth ? {'x-telegram-init-data':auth} : {}, body}, res);
  return res;
}
test('Telegram signature rejects tampering, duplicates, expired/future sessions and invalid IDs', () => {
  const verify = raw => lib.verifyInitData(raw, process.env.TELEGRAM_BOT_TOKEN, 86400);
  assert.equal(verify(signed()).ok, true);
  assert.equal(verify(signed(42, {signature:'telegram-ed25519-field'})).ok, true);
  assert.equal(verify(signed().replace('%3A42','%3A43')).ok, false);
  assert.equal(verify(signed()+'&user='+encodeURIComponent('{"id":999}')).ok, false);
  assert.equal(verify(signed(42,{auth_date:String(Math.floor(Date.now()/1000)-86401)})).reason, 'expired');
  assert.equal(verify(signed(42,{auth_date:String(Math.floor(Date.now()/1000)+1000)})).ok, false);
  assert.equal(verify(signed(0)).ok, false);
});
test('every API rejects unsigned requests and unsupported methods before external work', async t => {
  t.mock.method(global,'fetch',async()=>{throw new Error('Must not reach external services');});
  for (const name of Object.keys(handlers)) {
    assert.equal((await call(name,{action:'load'},null)).statusCode,401,name);
    assert.equal((await call(name,{},null,'GET')).statusCode,405,name);
  }
});
test('admin privileges and paid scan access cannot be supplied by the client', async t => {
  let requests=0;
  t.mock.method(global,'fetch',async(url)=>{requests++; assert.match(url,/subscriptions\?telegram_id=eq\.42&/); return Response.json([]);});
  assert.equal((await call('admin',{action:'grant',isAdmin:true,targetId:'999',days:365})).statusCode,403);
  assert.equal(requests,0);
  assert.equal((await call('scan',{proUnlimited:true,imageBase64:'abcd',mimeType:'image/jpeg'})).statusCode,402);
  assert.equal(requests,1);
});
test('state is always scoped to the signed Telegram ID and subscription fields are stripped', async t => {
  let saved;
  t.mock.method(global,'fetch',async(url,opts)=>{
    if(opts.method==='GET') {
      assert.match(url,/app_states\?telegram_id=eq\.42&/);
      return Response.json([{state:{hourlyRate:280,proUnlimited:true},updated_at:'2026-11-10T00:00:00Z'}]);
    }
    saved=JSON.parse(opts.body); return new Response(null,{status:204});
  });
  const loaded=await call('state',{action:'load',userId:43});
  assert.equal(loaded.body.state.proUnlimited,undefined);
  assert.ok(loaded.body.updatedAt);
  const res=await call('state',{action:'save',userId:43,state:{hourlyRate:280,proUnlimited:true,trialUsed:true}});
  assert.equal(res.statusCode,200);
  assert.equal(saved.telegram_id,'42');
  assert.equal(saved.state.proUnlimited,undefined);
  assert.equal(saved.state.trialUsed,undefined);
});
test('state rejects malformed structures, prototype keys, oversized data and invalid gzip without writes', async t => {
  t.mock.method(global,'fetch',async()=>{throw new Error('Must not write malformed state');});
  for (const state of [[], {tables:{bad:null}}, {menuItems:[{name:'x',price:'<img>'}]}, {hourlyRate:-1}, JSON.parse('{"__proto__":{"polluted":true}}')]) {
    assert.equal((await call('state',{action:'save',state})).statusCode,400);
  }
  assert.equal((await call('state',{action:'save',state:{notes:'я'.repeat(2100000)}})).statusCode,413);
  assert.equal((await call('state',{action:'save',stateGz:'not gzip'})).statusCode,400);
  const bomb=zlib.gzipSync(Buffer.alloc(40000001,32)).toString('base64');
  assert.equal((await call('state',{action:'save',stateGz:bomb})).statusCode,400);
});
test('conditional state writes prevent stale sessions and duplicate first writes', async t => {
  let row={updated_at:'2026-11-10T00:00:00.000Z',state:{hourlyRate:280}};
  t.mock.method(global,'fetch',async(url,opts)=>{
    const u=new URL(url), data=JSON.parse(opts.body);
    if(opts.method==='PATCH') {
      assert.equal(u.searchParams.get('telegram_id'),'eq.42');
      if(u.searchParams.get('updated_at')!=='eq.'+row.updated_at) return Response.json([]);
      row=data; return Response.json([{updated_at:row.updated_at}]);
    }
    assert.match(opts.headers.Prefer,/ignore-duplicates/);
    return Response.json([]);
  });
  const old=row.updated_at;
  const first=await call('state',{action:'save',state:{hourlyRate:300},expectedUpdatedAt:old});
  assert.equal(first.statusCode,200);
  assert.notEqual(first.body.updatedAt,old);
  assert.equal((await call('state',{action:'save',state:{hourlyRate:900},expectedUpdatedAt:old})).statusCode,409);
  assert.equal(row.state.hourlyRate,300);
  assert.equal((await call('state',{action:'save',state:{hourlyRate:900},expectedUpdatedAt:null})).statusCode,409);
});
test('gzip roundtrip preserves state and database errors do not leak details', async t => {
  const state={hourlyRate:280,notes:'x'.repeat(210000)};
  t.mock.method(global,'fetch',async(url,opts)=> {
    if(opts.method==='GET') return Response.json([{state,updated_at:'v1'}]);
    assert.equal(JSON.parse(opts.body).state.notes.length,210000);
    return new Response(null,{status:204});
  });
  const saved=await call('state',{action:'save',stateGz:zlib.gzipSync(JSON.stringify(state)).toString('base64')});
  assert.equal(saved.statusCode,200);
  const loaded=await call('state',{action:'load',gz:true});
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(loaded.body.stateGz,'base64'))),state);
  t.mock.method(global,'fetch',async()=>Response.json({message:'secret internal database detail'},{status:400}));
  const failed=await call('state',{action:'load'});
  assert.equal(failed.statusCode,503);
  assert.doesNotMatch(JSON.stringify(failed.body),/secret internal/);
});
