// GET /api/cron/health-check — weekly synthetic end-to-end enquiry health check,
// invoked automatically by Vercel Cron (see the `crons` entry in vercel.json).
//
// Auth: Vercel Cron sends `Authorization: Bearer ${CRON_SECRET}` automatically whenever
// the CRON_SECRET env var is set on the project — this is Vercel's own documented cron
// auth convention, not a custom scheme. We verify the supplied bearer token against
// process.env.CRON_SECRET via SHA-256 + timingSafeEqual (constant-time, so neither
// presence/absence nor length of the real secret leaks through response timing). The
// secret itself is never logged, echoed in a response, or hard-coded here — it exists
// only as a Vercel project environment variable.
//
// What this proves, in order: the deployed function is reachable; a synthetic enquiry
// that matches the real validation rules is accepted; it is actually written to the
// Supabase `enquiries` table (not just logged); the real business-notification email
// transport (Gmail SMTP / Resend / Brevo — whichever is configured) genuinely sends;
// the `email_sent` flag Supabase now carries on real rows is set exactly the way a real
// enquiry would set it; and the synthetic row is deleted afterward so it never appears
// in genuine enquiry reporting. Reuses the exact validation/persistence/email functions
// from api/enquire.js (via its `_internal` export) rather than a hand-rolled copy, so
// this test can't quietly drift from what a real customer submission actually does.
//
// On any failing stage this also emails a plain-text alert to the business inbox using
// the same production transport real enquiries use (never on success — a clean weekly
// run stays silent). One inherent limitation: if the failure IS the email transport
// itself being broken, that alert obviously can't get out either — in that case the
// non-2xx response recorded in Vercel's own Cron Jobs history/runtime logs is the
// signal to watch instead.
const crypto = require('crypto');
const {
  CONFIG,
  validateEnquiryFields,
  buildBusinessEmail,
  sendVia,
  transportConfigured,
  persistEnquiry,
  markEmailSent,
  getSupabase
} = require('../enquire.js')._internal;

function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const h = req.headers['authorization'];
  if (typeof h !== 'string') return '';
  const m = /^Bearer\s+(.+)$/.exec(h);
  return m ? m[1] : '';
}

// healthcheck-YYYYMMDD-HHMMSS, UTC. Deterministic and human-greppable in the Supabase
// table/logs if a run is ever left to investigate manually.
function healthCheckId(now) {
  const pad = (n) => String(n).padStart(2, '0');
  return 'healthcheck-' + now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate()) +
    '-' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds());
}

function recommendedAction(errorCode) {
  switch (errorCode) {
    case 'config_missing':
      return 'CRON_SECRET is not set for this Vercel environment — add it in Project Settings -> Environment Variables and redeploy.';
    case 'supabase_not_configured':
      return 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are missing or @supabase/supabase-js failed to load — check Vercel env vars and the deployed build.';
    case 'supabase_insert_failed':
    case 'supabase_read_failed':
      return 'Check Supabase project status and SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in Vercel env vars — the enquiries table may be unreachable, its schema may have changed, or the free Supabase project may have been paused for inactivity.';
    case 'email_delivery_failed':
      return 'Check GMAIL_APP_PASSWORD (or RESEND_API_KEY / BREVO_API_KEY+BREVO_SENDER_EMAIL) in Vercel env vars — the Gmail app password may have been revoked or rotated, or the fallback provider key may be invalid.';
    case 'email_flag_not_set':
      return 'The email sent but the Supabase update that flips email_sent failed — check Supabase connectivity and the enquiries table schema.';
    case 'cleanup_failed':
      return 'A synthetic test row was left in the enquiries table — delete it manually by the id in this alert.';
    default:
      return 'Check Vercel runtime logs for this function (api/cron/health-check) for the full error.';
  }
}

async function sendFailureAlert(cfg, { errorCode, message, id, checkedAt, stages, httpStatus }) {
  if (!transportConfigured(cfg)) return false; // nothing we can do — no transport configured at all
  const failedStages = Object.keys(stages).filter((k) => stages[k] === false);
  const text = 'Baig Tyres weekly enquiry health check FAILED\n\n' +
    'Timestamp: ' + checkedAt + '\n' +
    'HTTP status: ' + httpStatus + '\n' +
    'Error: ' + errorCode + '\n' +
    'Message: ' + message + '\n' +
    'Synthetic row id: ' + id + '\n' +
    'Failed stage(s): ' + (failedStages.length ? failedStages.join(', ') : '(see stages below)') + '\n' +
    'Full stages: ' + JSON.stringify(stages) + '\n\n' +
    'Recommended action: ' + recommendedAction(errorCode) + '\n\n' +
    'This is an automated alert from the weekly Vercel Cron health check (/api/cron/health-check). No customer was affected.';
  try {
    return await sendVia(cfg, { to: cfg.PRIMARY_TO, subject: 'ALERT: Baig Tyres enquiry health check FAILED — ' + errorCode, text: text, html: '<pre style="font-family:monospace;white-space:pre-wrap">' + text.replace(/&/g, '&amp;').replace(/</g, '&lt;') + '</pre>' });
  } catch (e) {
    return false;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const now = new Date();
  const checkedAt = now.toISOString();
  const stages = {
    vercel: true,
    authorized: false,
    validation: false,
    supabase_insert: false,
    email_sent: false,
    supabase_read: false,
    email_flag_verified: false,
    cleanup: false
  };

  const expectedSecret = process.env.CRON_SECRET;
  if (!expectedSecret) {
    console.error('CRON_HEALTHCHECK_FAILED:' + JSON.stringify({ error: 'config_missing', checked_at: checkedAt }));
    res.status(503).json({ ok: false, error: 'config_missing', message: 'CRON_SECRET is not set for this Vercel environment.', checked_at: checkedAt, stages });
    return;
  }

  if (!secretsMatch(bearerToken(req), expectedSecret)) {
    console.error('CRON_HEALTHCHECK_FAILED:' + JSON.stringify({ error: 'unauthorized', checked_at: checkedAt }));
    res.status(401).json({ ok: false, error: 'unauthorized', checked_at: checkedAt, stages });
    return;
  }
  stages.authorized = true;

  const id = healthCheckId(now);
  const cfg = await CONFIG.get();

  // Fixed, obviously-synthetic values — never taken from any request input (this route
  // takes no body at all; Vercel Cron sends a plain GET). Phone is an Ofcom-reserved
  // fictional-use number (07700 900000–900999); email uses the .invalid TLD reserved by
  // RFC 2606, so it can never collide with or email a real customer.
  const fields = {
    firstName: 'Baig Tyres',
    lastName: 'System Test',
    phone: '07700900123',
    email: 'synthetic-health-check@baigtyres.invalid',
    registration: 'HC26XYZ',
    services: ['Synthetic health check'],
    isOptinOnly: false
  };

  async function fail(httpStatus, errorCode, message) {
    console.error('CRON_HEALTHCHECK_FAILED:' + JSON.stringify({ error: errorCode, message, id, checked_at: checkedAt, stages }));
    await sendFailureAlert(cfg, { errorCode, message, id, checkedAt, stages, httpStatus });
    res.status(httpStatus).json({ ok: false, error: errorCode, message, id, checked_at: checkedAt, stages });
  }

  // Runs the exact same validation real enquiries go through — proves the live rules
  // (UK mobile format, plate format, required fields) still accept a well-formed
  // submission, not a hand-rolled approximation of them.
  const validationError = validateEnquiryFields(fields);
  if (validationError) { await fail(500, 'synthetic_payload_invalid', validationError); return; }
  stages.validation = true;

  const record = {
    id: id,
    ts: checkedAt,
    subject: 'HEALTH CHECK — automated weekly check, no action needed unless this run alerted a failure',
    name: fields.firstName + ' ' + fields.lastName,
    phone: fields.phone,
    email: fields.email,
    registration: fields.registration,
    vehicle: 'Not verified at submission',
    services: fields.services.join(', '),
    message: 'AUTOMATED WEEKLY HEALTH CHECK — NO CUSTOMER FOLLOW-UP REQUIRED',
    optin: false, // never subscribes the synthetic identity to marketing
    source: 'health_check',
    page: '',
    hasImage: false,
    imageCount: 0,
    delivered: false
  };

  const db = getSupabase(cfg);
  if (!db) { await fail(500, 'supabase_not_configured', 'Supabase client unavailable — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set and @supabase/supabase-js is installed.'); return; }

  // 1) Insert through the exact same persistEnquiry() function real enquiries use.
  let insertOk = false;
  try { insertOk = await persistEnquiry(cfg, record); } catch (e) { insertOk = false; }
  if (!insertOk) { await fail(502, 'supabase_insert_failed', 'Could not write the synthetic row to the enquiries table.'); return; }
  stages.supabase_insert = true;

  // 2) Real send attempt to the real business inbox via the exact same sendVia()/
  // buildBusinessEmail() real enquiries use — a health check that never actually calls
  // the transport proves nothing about whether Gmail/Resend/Brevo credentials still
  // work. Never sends a customer confirmation (there is no real customer to confirm to).
  let emailed = false;
  if (transportConfigured(cfg)) {
    try {
      const biz = buildBusinessEmail(record);
      emailed = await sendVia(cfg, { to: cfg.PRIMARY_TO, subject: record.subject, text: biz.text, html: biz.html });
    } catch (e) { emailed = false; }
  }
  stages.email_sent = emailed;

  if (emailed) {
    try { await markEmailSent(cfg, record.id); } catch (e) { /* independently verified by the read-back below */ }
  }

  // 3) Read the row back by its known, deterministic id and confirm both the message
  // text and the email_sent flag — the strongest signal already present in the schema
  // that a real enquiry's email genuinely went out, not just that this function thinks it did.
  let readRow = null;
  let readError = null;
  try {
    const { data, error } = await db.from('enquiries').select('id, message, email_sent').eq('id', record.id).maybeSingle();
    readRow = data || null;
    readError = error || null;
  } catch (e) { readError = e; }
  const readOk = !readError && !!readRow && readRow.id === record.id && readRow.message === record.message;
  stages.supabase_read = readOk;
  stages.email_flag_verified = readOk && readRow.email_sent === true;

  // 4) Cleanup always runs now that we know a row was inserted, regardless of what
  // failed above — a failed email or a failed read must never leave a fake row behind
  // to pollute genuine enquiry reporting.
  let cleanupError = null;
  try {
    const { error } = await db.from('enquiries').delete().eq('id', record.id);
    cleanupError = error || null;
  } catch (e) { cleanupError = e; }
  stages.cleanup = !cleanupError;

  if (!readOk) {
    await fail(502, 'supabase_read_failed', 'Synthetic row did not read back correctly after insert.' + (cleanupError ? ' Cleanup also failed — check the enquiries table manually for id ' + record.id + '.' : ' Cleanup was attempted.'));
    return;
  }
  if (!emailed) {
    await fail(502, 'email_delivery_failed', 'Business notification email was not sent — check GMAIL_APP_PASSWORD / RESEND_API_KEY / BREVO_* env vars.');
    return;
  }
  if (!stages.email_flag_verified) {
    await fail(502, 'email_flag_not_set', 'The email appeared to send but enquiries.email_sent was not set on the row.');
    return;
  }
  if (cleanupError) {
    await fail(502, 'cleanup_failed', 'Synthetic row was inserted and fully verified but could not be deleted — check the enquiries table manually for id ' + record.id + '.');
    return;
  }

  console.log('CRON_HEALTHCHECK_OK:' + JSON.stringify({ id, checked_at: checkedAt }));
  res.status(200).json({ ok: true, id, checked_at: checkedAt, stages });
};
