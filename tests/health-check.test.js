// Isolated Node test script for api/enquire.js's health-check mode.
// No test framework (jest/mocha) exists in this repo, so this runs standalone:
//   node tests/health-check.test.js
//
// It mocks @supabase/supabase-js and nodemailer via the require cache BEFORE requiring
// enquire.js, so no real network/Supabase/email calls happen. It proves:
//   - an unauthenticated health-check request (bad/missing secret) is rejected
//   - a normal customer request's validation/response codes are unchanged
//   - an authenticated synthetic request exercises insert -> read -> delete
//   - no email send function is ever invoked during a health-check request
//   - the synthetic row does not remain in the mock table afterwards
'use strict';
const assert = require('assert');
const path = require('path');
const Module = require('module');

let failures = 0;
let passes = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log('  ok - ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL - ' + name);
    console.log('    ' + (e && e.message ? e.message : e));
  }
}
async function checkAsync(name, fn) {
  try {
    await fn();
    passes++;
    console.log('  ok - ' + name);
  } catch (e) {
    failures++;
    console.log('  FAIL - ' + name);
    console.log('    ' + (e && e.message ? e.message : e));
  }
}

// ---- Mock table + mock Supabase client ----
const mockTable = new Map(); // id -> row
let sendMailCalls = 0;
let fetchCalls = 0;

function makeMockSupabaseClient() {
  return {
    from(tableName) {
      assert.strictEqual(tableName, 'enquiries');
      return {
        insert(row) {
          mockTable.set(row.id, row);
          return Promise.resolve({ error: null });
        },
        select() {
          return {
            eq(col, val) {
              return {
                maybeSingle() {
                  const row = mockTable.get(val);
                  return Promise.resolve({ data: row ? { id: row.id, message: row.message } : null, error: null });
                }
              };
            }
          };
        },
        delete() {
          return {
            eq(col, val) {
              mockTable.delete(val);
              return Promise.resolve({ error: null });
            }
          };
        },
        update() {
          return { eq: () => Promise.resolve({ error: null }) };
        }
      };
    }
  };
}

// Inject mocks into the require cache before enquire.js requires them.
function injectMock(moduleName, exportsObj) {
  const fakePath = path.join(__dirname, '__mock__' + moduleName.replace(/[^a-zA-Z0-9]/g, '_') + '.js');
  const fakeModule = new Module(fakePath, module);
  fakeModule.exports = exportsObj;
  fakeModule.loaded = true;
  Module._cache[fakePath] = fakeModule;
  // Patch Module._resolveFilename so require('@supabase/supabase-js') / require('nodemailer')
  // resolve to our fake path instead of hitting node_modules.
  const original = Module._resolveFilename;
  Module._resolveFilename = function (request, ...rest) {
    if (request === moduleName) return fakePath;
    return original.call(this, request, ...rest);
  };
}

injectMock('@supabase/supabase-js', {
  createClient: () => makeMockSupabaseClient()
});
injectMock('nodemailer', {
  createTransport: () => ({
    sendMail: () => { sendMailCalls++; return Promise.resolve(); }
  })
});

// Also stub global fetch (used by Resend/Brevo transports) so any accidental email
// attempt is visible as a call count rather than a real network request.
global.fetch = (...args) => { fetchCalls++; return Promise.resolve({ ok: true }); };

// Point _config.js's Supabase keys somewhere so getSupabase() returns our mock client,
// and give it a health-check secret to test against.
process.env.SUPABASE_URL = 'https://mock.supabase.local';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'mock-service-role-key';
process.env.HEALTH_CHECK_SECRET = 'test-secret-do-not-use-in-prod';

const handler = require('../api/enquire.js');

function makeRes() {
  const res = {
    statusCode: null,
    body: null,
    headers: {},
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
    setHeader(k, v) { this.headers[k] = v; }
  };
  return res;
}
let ipCounter = 0;
function makeReq({ headers, body }) {
  // Each call gets its own synthetic source IP so the module's pre-existing, unmodified
  // per-IP rate limiter (6 requests / 10 min) never interferes between unrelated test
  // cases — mirrors how distinct real customers/Zapier calls would arrive from Vercel.
  ipCounter++;
  const finalHeaders = Object.assign({ 'x-forwarded-for': '203.0.113.' + (ipCounter % 250) }, headers || {});
  return { method: 'POST', headers: finalHeaders, body: body || {} };
}

(async () => {
  console.log('Health-check mode:');

  await checkAsync('unauthenticated health-check request (missing secret) is rejected with 401', async () => {
    const req = makeReq({ body: { synthetic_health_check: true } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 401);
    assert.strictEqual(res.body.ok, false);
    assert.strictEqual(res.body.error, 'unauthorized');
  });

  await checkAsync('unauthenticated health-check request (wrong secret) is rejected with 401', async () => {
    const req = makeReq({ headers: { 'x-health-check-secret': 'wrong' }, body: { synthetic_health_check: true } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 401);
  });

  await checkAsync('flagged-but-unauthenticated request never reaches the database', async () => {
    const sizeBefore = mockTable.size;
    const req = makeReq({ body: { synthetic_health_check: true } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(mockTable.size, sizeBefore, 'an unauthenticated flagged request must not touch the enquiries table at all');
  });

  await checkAsync('authenticated synthetic request succeeds end-to-end with all stages true', async () => {
    const sendMailBefore = sendMailCalls;
    const fetchBefore = fetchCalls;
    const req = makeReq({
      headers: { 'x-health-check-secret': 'test-secret-do-not-use-in-prod' },
      body: { synthetic_health_check: true }
    });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200, 'expected 200, got ' + res.statusCode + ' body=' + JSON.stringify(res.body));
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.marker && res.body.marker.startsWith('HEALTHCHECK_'));
    assert.ok(res.body.checked_at);
    assert.deepStrictEqual(res.body.stages, {
      vercel: true,
      validation: true,
      record_created: true,
      supabase_insert: true,
      supabase_read: true,
      email_suppressed: true,
      cleanup: true
    });
    assert.strictEqual(sendMailCalls, sendMailBefore, 'no email should ever be sent during a health check');
    assert.strictEqual(fetchCalls, fetchBefore, 'no Resend/Brevo HTTP call should ever be made during a health check');
  });

  await checkAsync('no synthetic row remains in the table after a successful health check', async () => {
    const remaining = [...mockTable.values()].filter((r) => r.message && r.message.startsWith('HEALTHCHECK_'));
    assert.strictEqual(remaining.length, 0, 'expected zero leftover synthetic rows, found ' + remaining.length);
  });

  await checkAsync('Cache-Control: no-store is set on health-check responses', async () => {
    const req = makeReq({
      headers: { 'x-health-check-secret': 'test-secret-do-not-use-in-prod' },
      body: { synthetic_health_check: true }
    });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.headers['Cache-Control'], 'no-store');
  });

  console.log('\nNormal customer enquiry flow (unchanged behaviour):');

  await checkAsync('missing name fields still returns 400 name_required (unchanged validation)', async () => {
    const req = makeReq({ body: { phone: '07700900123', email: 'a@b.com', registration: 'AB12CDE', services: ['Alloy wheel repair'] } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'name_required');
  });

  await checkAsync('bad phone still returns 400 bad_phone (unchanged validation)', async () => {
    const req = makeReq({ body: { firstName: 'Jane', lastName: 'Doe', phone: '123', email: 'a@b.com', registration: 'AB12CDE', services: ['Alloy wheel repair'] } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 400);
    assert.strictEqual(res.body.error, 'bad_phone');
  });

  await checkAsync('honeypot field still short-circuits to 200 ok:true (unchanged bot-trap behaviour)', async () => {
    const req = makeReq({ body: { company: 'I am a bot', firstName: 'Bot', lastName: 'Bot' } });
    const res = makeRes();
    await handler(req, res);
    assert.strictEqual(res.statusCode, 200);
    assert.deepStrictEqual(res.body, { ok: true });
  });

  await checkAsync('valid real enquiry with no email transport configured returns 502 delivery_failed (unchanged — transport is empty in this sandbox)', async () => {
    const req = makeReq({ body: { firstName: 'Jane', lastName: 'Doe', phone: '07700900123', email: 'jane@example.com', registration: 'AB12CDE', services: ['Alloy wheel repair'] } });
    const res = makeRes();
    await handler(req, res);
    // No GMAIL_APP_PASSWORD/RESEND_API_KEY/BREVO_API_KEY set in this test env, so
    // transportConfigured() is false and the real handler's own logic returns 502 —
    // this is existing, unmodified behaviour being asserted, not a health-check concern.
    assert.strictEqual(res.statusCode, 502);
    assert.strictEqual(res.body.error, 'delivery_failed');
    // But the row should still have been persisted via the real Supabase mock.
    const persistedRows = [...mockTable.values()].filter((r) => r.contact && r.contact.email === 'jane@example.com');
    assert.strictEqual(persistedRows.length, 1, 'real enquiry should still be captured in Supabase even though email delivery is unconfigured');
  });

  console.log('\n' + passes + ' passed, ' + failures + ' failed');
  if (failures > 0) process.exit(1);
})();
