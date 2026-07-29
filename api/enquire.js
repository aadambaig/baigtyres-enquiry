// POST /api/enquire — validate, spam-guard, capture, email instantly, confirm to customer.
//
// Delivery strategy:
//   1) Durable capture: write the enquiry to Supabase before trying email. Runtime
//      logs remain a short-retention recovery trace, not durable storage.
//   2) Instant business email to PRIMARY_TO via, in order of preference:
//        a) Gmail SMTP (App Password)  — sends from the real business inbox.
//        b) Resend / Brevo transactional API — if a key is configured instead.
//   3) Automatic confirmation email to the customer (same transport), if we have their email.
// The HTTP response is a success as long as the enquiry was captured OR emailed.
//
// PROTECTED HEALTH-CHECK MODE: a request only enters health-check mode when it carries
// BOTH `synthetic_health_check: true` in the body AND a header `x-health-check-secret`
// matching the Vercel env var HEALTH_CHECK_SECRET. It runs the exact same validation
// (validateEnquiryFields), record-building (buildRecord), and persistence (persistEnquiry)
// code paths as a real enquiry, using fixed, obviously-synthetic field values that never
// come from the request body — then reads the row back, deletes it, and returns a
// structured multi-stage JSON result. It never sends email and never reaches the code
// below it in the normal flow. See handleHealthCheck().
const crypto = require('crypto');
const CONFIG = require('./_config.js');

let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch (e) { nodemailer = null; }

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (e) { createClient = null; }

const hits = new Map();
const WINDOW_MS = 10 * 60 * 1000;
const MAX_PER_WINDOW = 6;
function limited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  rec.push(now);
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.length > MAX_PER_WINDOW;
}

const PLATE_RE = /^(?:[A-Z]{2}[0-9]{2}[A-Z]{3}|[A-Z][0-9]{1,3}[A-Z]{3}|[A-Z]{3}[0-9]{1,3}[A-Z]?)$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// UK mobile numbers only, mirrors the client-side check in site.js's phoneValid().
// Server-side re-validation matters here specifically because the client check can be
// bypassed (devtools, curl, bots) — the old loose regex (any 7-20 digits/punctuation)
// let fake numbers like "1111111" straight through even if the frontend were disabled.
function ukMobileValid(v) {
  const d = String(v || '').replace(/[^\d+]/g, '').replace(/^\+44/, '0').replace(/^0044/, '0');
  return /^07\d{9}$/.test(d);
}
const PHONE_RE = { test: ukMobileValid };
const DATA_URL_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)$/;
const MAX_IMAGES = 5;
const MAX_IMAGE_BASE64_CHARS = 1_200_000;
const MAX_TOTAL_IMAGE_BASE64_CHARS = 4_200_000;

function parseImageAttachment(image) {
  if (!image || typeof image !== 'object') return null;
  const data = typeof image.data === 'string' ? image.data : '';
  if (!data || data.length > MAX_IMAGE_BASE64_CHARS) return null;
  const m = DATA_URL_RE.exec(data);
  if (!m) return null;
  const mime = m[1];
  const base64 = m[2];
  const ext = (mime.split('/')[1] || 'jpg').replace(/[^a-z0-9]/gi, '') || 'jpg';
  const safeName = clean(image.name, 80).replace(/[^a-zA-Z0-9 ._-]/g, '') || ('reference.' + ext);
  return { filename: safeName, content: base64, encoding: 'base64', contentType: mime };
}

function parseImageAttachments(images) {
  if (!Array.isArray(images)) return [];
  let totalChars = 0;
  const out = [];
  for (const image of images.slice(0, MAX_IMAGES)) {
    const data = image && typeof image.data === 'string' ? image.data : '';
    if (!data || data.length > MAX_IMAGE_BASE64_CHARS) continue;
    if (totalChars + data.length > MAX_TOTAL_IMAGE_BASE64_CHARS) continue;
    const attachment = parseImageAttachment(image);
    if (!attachment) continue;
    totalChars += data.length;
    out.push(attachment);
  }
  return out;
}

function clean(v, max) {
  return String(v == null ? '' : v).replace(/[\r\n<>]/g, ' ').trim().slice(0, max || 200);
}
function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function enqueue(cfg, record) {
  try {
    console.log('ENQUIRY_BACKUP:' + JSON.stringify(record));
    return true;
  } catch (e) {
    return false;
  }
}

let supabase = null;
let supabaseKey = '';
function getSupabase(cfg) {
  if (!createClient || !cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return null;
  const key = cfg.SUPABASE_URL + '|' + cfg.SUPABASE_SERVICE_ROLE_KEY;
  if (supabase && supabaseKey === key) return supabase;
  try {
    supabase = createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
    supabaseKey = key;
    return supabase;
  } catch (e) {
    return null;
  }
}

async function persistEnquiry(cfg, record) {
  const db = getSupabase(cfg);
  if (!db) return false;
  const { error } = await db.from('enquiries').insert({
    id: record.id,
    name: record.name,
    contact: { phone: record.phone, email: record.email },
    vehicle_registration: record.registration,
    service_requested: record.services ? record.services.split(', ') : [],
    message: record.message,
    submitted_at: record.ts,
    email_sent: false
  });
  if (!error) return true;
  console.error('ENQUIRY_PERSIST_FAILED:' + JSON.stringify({ id: record.id, message: error.message }));
  return false;
}

async function markEmailSent(cfg, id) {
  const db = getSupabase(cfg);
  if (!db) return false;
  const { error } = await db.from('enquiries').update({ email_sent: true }).eq('id', id);
  if (!error) return true;
  console.error('ENQUIRY_EMAIL_FLAG_FAILED:' + JSON.stringify({ id: id, message: error.message }));
  return false;
}

function validateEnquiryFields(f) {
  if (f.isOptinOnly) {
    if (!f.email && !f.phone) return 'contact_required';
    if (f.email && !EMAIL_RE.test(f.email)) return 'bad_email';
    if (f.phone && !PHONE_RE.test(f.phone)) return 'bad_phone';
    return null;
  }
  if (!f.firstName || !f.lastName) return 'name_required';
  if (!PHONE_RE.test(f.phone)) return 'bad_phone';
  if (!EMAIL_RE.test(f.email)) return 'bad_email';
  if (!PLATE_RE.test(f.registration)) return 'bad_registration';
  if (f.services.length === 0) return 'services_required';
  return null;
}

function buildRecord(f, idPrefix) {
  const prefix = idPrefix || 'e';
  const vehicleLine = f.vehicle
    ? [f.vehicle.make, f.vehicle.model, f.vehicle.colour, f.vehicle.year, f.vehicle.fuel].filter(Boolean).join(' · ')
    : 'Not verified at submission';

  const subject = f.isOptinOnly
    ? 'Marketing sign-up (10% code) — ' + (f.email || f.phone)
    : 'New enquiry — ' + (f.services[0] || 'General') + (f.registration ? ' — ' + f.registration : '');

  return {
    id: prefix + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    ts: new Date().toISOString(),
    subject: subject,
    name: (f.firstName + ' ' + f.lastName).trim(),
    phone: f.phone,
    email: f.email,
    registration: f.registration,
    vehicle: vehicleLine,
    services: f.services.join(', ') || (f.isOptinOnly ? 'Marketing list sign-up' : ''),
    message: f.message,
    optin: f.optin,
    source: f.source,
    page: f.page,
    hasImage: f.imageAttachments.length > 0,
    imageCount: f.imageAttachments.length,
    delivered: false
  };
}

function buildBusinessEmail(record) {
  const rows = [
    ['Name', record.name], ['Phone', record.phone], ['Email', record.email],
    ['Registration', record.registration], ['Vehicle', record.vehicle],
    ['Services', record.services], ['Message', record.message],
    ['Reference photos', record.imageCount ? (record.imageCount + ' photo' + (record.imageCount === 1 ? '' : 's') + ' attached to this email') : 'None'],
    ['Marketing opt-in', record.optin ? 'YES — send offers' : 'No'],
    ['Received', record.ts], ['Sent from', record.page || record.source]
  ];
  const text = 'New Baig Tyres enquiry\n\n' + rows.map(([k, v]) => k + ': ' + (v || '-')).join('\n');
  const html = '<h2 style="font-family:Arial,sans-serif">New Baig Tyres enquiry</h2>' +
    '<table cellpadding="7" style="border-collapse:collapse;font-family:Arial,sans-serif;font-size:14px">' +
    rows.map(([k, v]) => '<tr><td style="background:#f2f4f7;font-weight:bold;border:1px solid #e2e6ea">' +
      htmlEscape(k) + '</td><td style="border:1px solid #e2e6ea">' + htmlEscape(v || '-') + '</td></tr>').join('') +
    '</table>';
  return { text, html };
}

function buildCustomerEmail(record, cfg) {
  const code = cfg.OFFER_CODE || 'WELCOME10';
  const firstName = (record.name || '').split(' ')[0] || 'there';
  const offer = record.optin
    ? '<p style="margin:16px 0;padding:14px 16px;background:#eaf5ff;border:1px solid #bfe0ff;border-radius:8px;font-family:Arial,sans-serif">' +
      'Thanks for joining our list — here is <b>10% off your first order</b>. Quote code <b style="letter-spacing:1px">' +
      htmlEscape(code) + '</b> when you book.</p>'
    : '';
  if (record.source === 'optin_popup') {
    const text = 'Thanks for joining the Baig Tyres list!\n\nHere is 10% off your first order — quote code ' + code +
      ' when you book.\n\nBaig Tyres Ltd, Unit 4, Derwent Close, Worcester, WR4 9TY\n01905 731396';
    const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:520px">' +
      '<h2>You\'re on the list ✓</h2>' +
      '<p>Thanks for signing up. Here is <b>10% off your first order</b>:</p>' +
      '<p style="font-size:22px;letter-spacing:2px;font-weight:bold;background:#0D76BD;color:#fff;display:inline-block;padding:10px 18px;border-radius:8px">' +
      htmlEscape(code) + '</p>' +
      '<p>Quote it when you book your body kit, custom exhaust or alloy wheel repair.</p>' +
      '<hr style="border:none;border-top:1px solid #e2e6ea;margin:20px 0">' +
      '<p style="font-size:13px;color:#666">Baig Tyres Ltd · Unit 4, Derwent Close, Worcester, WR4 9TY · <a href="tel:01905731396">01905 731396</a></p></div>';
    return { subject: 'Your 10% code — Baig Tyres', text, html };
  }
  const summary = [
    ['Registration', record.registration], ['Vehicle', record.vehicle],
    ['Services', record.services], ['Your message', record.message]
  ].filter(([, v]) => v && v !== 'Not verified at submission');
  const text = 'Hi ' + firstName + ',\n\nThanks for your enquiry to Baig Tyres — we\'ve received it and will call or WhatsApp you back within one working day (during working hours).\n\n' +
    summary.map(([k, v]) => k + ': ' + v).join('\n') +
    (record.optin ? '\n\nAs a thank you for joining our list, here is 10% off your first order — code ' + code + '.' : '') +
    '\n\nBaig Tyres Ltd, Unit 4, Derwent Close, Worcester, WR4 9TY\n01905 731396';
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;color:#111;max-width:520px">' +
    '<h2>Thanks, ' + htmlEscape(firstName) + ' — we\'ve got your enquiry ✓</h2>' +
    '<p>We\'ll call or WhatsApp you back within one working day (during working hours). Here\'s a copy of what you sent us:</p>' +
    '<table cellpadding="7" style="border-collapse:collapse;font-size:14px">' +
    summary.map(([k, v]) => '<tr><td style="background:#f2f4f7;font-weight:bold;border:1px solid #e2e6ea">' +
      htmlEscape(k) + '</td><td style="border:1px solid #e2e6ea">' + htmlEscape(v) + '</td></tr>').join('') +
    '</table>' + offer +
    '<p>Need us sooner? Call <a href="tel:01905731396">01905 731396</a>.</p>' +
    '<hr style="border:none;border-top:1px solid #e2e6ea;margin:20px 0">' +
    '<p style="font-size:13px;color:#666">Baig Tyres Ltd · Unit 4, Derwent Close, Worcester, WR4 9TY</p></div>';
  return { subject: 'We\'ve got your enquiry — Baig Tyres', text, html };
}

let gmailTransport = null;
let gmailKey = '';
function getGmailTransport(cfg) {
  if (!nodemailer || !cfg.GMAIL_USER || !cfg.GMAIL_APP_PASSWORD) return null;
  const key = cfg.GMAIL_USER + '|' + cfg.GMAIL_APP_PASSWORD;
  if (gmailTransport && gmailKey === key) return gmailTransport;
  gmailTransport = nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: cfg.GMAIL_USER, pass: String(cfg.GMAIL_APP_PASSWORD).replace(/\s+/g, '') }
  });
  gmailKey = key;
  return gmailTransport;
}
async function sendGmail(cfg, msg) {
  const t = getGmailTransport(cfg);
  if (!t) return false;
  await t.sendMail({
    from: '"Baig Tyres" <' + cfg.GMAIL_USER + '>',
    to: msg.to, subject: msg.subject, text: msg.text, html: msg.html,
    replyTo: msg.replyTo || undefined,
    attachments: msg.attachments || undefined
  });
  return true;
}
async function sendResend(cfg, msg) {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + cfg.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: cfg.RESEND_FROM, to: [msg.to], reply_to: msg.replyTo || undefined, subject: msg.subject, text: msg.text, html: msg.html })
  });
  return res.ok;
}
async function sendBrevo(cfg, msg) {
  const res = await fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': cfg.BREVO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      sender: { email: cfg.BREVO_SENDER_EMAIL, name: cfg.BREVO_SENDER_NAME },
      to: [{ email: msg.to }], replyTo: msg.replyTo ? { email: msg.replyTo } : undefined,
      subject: msg.subject, textContent: msg.text, htmlContent: msg.html
    })
  });
  return res.ok;
}
async function sendVia(cfg, msg) {
  try {
    if (cfg.GMAIL_APP_PASSWORD && nodemailer) return await sendGmail(cfg, msg);
    if (cfg.RESEND_API_KEY) return await sendResend(cfg, msg);
    if (cfg.BREVO_API_KEY && cfg.BREVO_SENDER_EMAIL) return await sendBrevo(cfg, msg);
  } catch (e) { /* fall through */ }
  return false;
}
function transportConfigured(cfg) {
  return !!((cfg.GMAIL_APP_PASSWORD && nodemailer) || cfg.RESEND_API_KEY || (cfg.BREVO_API_KEY && cfg.BREVO_SENDER_EMAIL));
}

function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

async function handleHealthCheck(req, res) {
  const stages = { vercel: true, validation: false, record_created: false, supabase_insert: false, supabase_read: false, email_suppressed: true, cleanup: false };
  const checkedAt = new Date().toISOString();

  const expectedSecret = process.env.HEALTH_CHECK_SECRET;
  if (!expectedSecret) {
    res.status(503).json({
      ok: false,
      error: 'config_missing',
      message: 'HEALTH_CHECK_SECRET is not set for this Vercel environment.',
      checked_at: checkedAt,
      stages
    });
    return;
  }

  const suppliedSecret = req.headers['x-health-check-secret'];
  if (!secretsMatch(suppliedSecret, expectedSecret)) {
    res.status(401).json({ ok: false, error: 'unauthorized', checked_at: checkedAt, stages });
    return;
  }

  const marker = 'HEALTHCHECK_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');

  const fields = {
    firstName: 'Synthetic',
    lastName: 'Health Check',
    phone: '07700900123',
    email: 'synthetic-health-check@baigtyres.invalid',
    registration: 'HC26XYZ',
    services: ['Synthetic health check'],
    message: marker,
    optin: false,
    source: 'health_check',
    page: '',
    vehicle: null,
    imageAttachments: [],
    isOptinOnly: false
  };

  const validationError = validateEnquiryFields(fields);
  if (validationError) {
    res.status(500).json({
      ok: false,
      error: 'synthetic_payload_invalid',
      message: validationError,
      marker,
      checked_at: checkedAt,
      stages
    });
    return;
  }
  stages.validation = true;

  const record = buildRecord(fields, 'hc');
  stages.record_created = true;

  const cfg = await CONFIG.get();
  const db = getSupabase(cfg);
  if (!db) {
    res.status(500).json({
      ok: false,
      error: 'supabase_not_configured',
      message: 'Supabase client unavailable — check SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are set and @supabase/supabase-js is installed.',
      marker,
      checked_at: checkedAt,
      stages
    });
    return;
  }

  let insertError = null;
  try {
    const ok = await persistEnquiry(cfg, record);
    if (!ok) insertError = new Error('persistEnquiry returned false');
  } catch (e) {
    insertError = e;
  }

  if (insertError) {
    res.status(502).json({
      ok: false,
      error: 'supabase_insert_failed',
      message: 'Could not write the synthetic row to the enquiries table.',
      marker,
      checked_at: checkedAt,
      stages
    });
    return;
  }
  stages.supabase_insert = true;

  let readRow = null;
  let readError = null;
  try {
    const { data, error } = await db.from('enquiries').select('id, message').eq('id', record.id).maybeSingle();
    readRow = data || null;
    readError = error || null;
  } catch (e) {
    readError = e;
  }
  const readOk = !readError && !!readRow && readRow.id === record.id && readRow.message === marker;
  stages.supabase_read = readOk;

  let cleanupError = null;
  try {
    const { error } = await db.from('enquiries').delete().eq('id', record.id);
    cleanupError = error || null;
  } catch (e) {
    cleanupError = e;
  } finally {
    stages.cleanup = !cleanupError;
  }

  if (!readOk) {
    res.status(502).json({
      ok: false,
      error: 'supabase_read_failed',
      message: 'Synthetic row did not read back correctly after insert.',
      marker,
      checked_at: checkedAt,
      stages
    });
    return;
  }

  if (cleanupError) {
    res.status(502).json({
      ok: false,
      error: 'cleanup_failed',
      message: 'Synthetic row was inserted and verified but could not be deleted — check the enquiries table manually for id ' + record.id + '.',
      marker,
      checked_at: checkedAt,
      stages
    });
    return;
  }

  res.status(200).json({
    ok: true,
    marker,
    checked_at: checkedAt,
    stages
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) { res.status(429).json({ error: 'too_many_requests' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  if (body.synthetic_health_check === true) {
    await handleHealthCheck(req, res);
    return;
  }

  if (clean(body.company, 50)) { res.status(200).json({ ok: true }); return; }

  const firstName = clean(body.firstName, 60);
  const lastName = clean(body.lastName, 60);
  const phone = clean(body.phone, 25);
  const email = clean(body.email, 120);
  const registration = clean(body.registration, 10).toUpperCase().replace(/\s+/g, '');
  const message = clean(body.message, 1500);
  const services = Array.isArray(body.services) ? body.services.slice(0, 12).map((s) => clean(s, 60)).filter(Boolean) : [];
  const optin = body.marketing_optin === true;
  const source = clean(body.source, 30) || 'enquiry_form';
  const page = clean(body.page, 40);
  const vehicle = body.vehicle && typeof body.vehicle === 'object' ? body.vehicle : null;
  const imageAttachments = parseImageAttachments(body.images);

  const isOptinOnly = source === 'optin_popup';

  const validationError = validateEnquiryFields({ firstName, lastName, phone, email, registration, services, isOptinOnly });
  if (validationError) { res.status(400).json({ error: validationError }); return; }

  const cfg = await CONFIG.get();

  const record = buildRecord({ firstName, lastName, phone, email, registration, vehicle, services, message, optin, source, page, imageAttachments, isOptinOnly }, 'e');

  let persisted = false;
  try { persisted = await persistEnquiry(cfg, record); } catch (e) {
    console.error('ENQUIRY_PERSIST_FAILED:' + JSON.stringify({ id: record.id, message: e && e.message ? e.message : 'unknown' }));
  }

  const captured = await enqueue(cfg, record);

  let emailed = false;
  if (transportConfigured(cfg)) {
    try {
      const biz = buildBusinessEmail(record);
      emailed = await sendVia(cfg, {
        to: cfg.PRIMARY_TO, subject: record.subject,
        text: biz.text, html: biz.html, replyTo: email || undefined,
        attachments: imageAttachments.length ? imageAttachments : undefined
      });
    } catch (e) { emailed = false; }

    if (String(cfg.CUSTOMER_CONFIRM) === '1' && email && EMAIL_RE.test(email)) {
      try {
        const cust = buildCustomerEmail(record, cfg);
        await sendVia(cfg, { to: email, subject: cust.subject, text: cust.text, html: cust.html, replyTo: cfg.PRIMARY_TO });
      } catch (e) { /* confirmation is non-critical */ }
    }
  }

  if (emailed && persisted) {
    try { await markEmailSent(cfg, record.id); } catch (e) {
      console.error('ENQUIRY_EMAIL_FLAG_FAILED:' + JSON.stringify({ id: record.id, message: e && e.message ? e.message : 'unknown' }));
    }
  }

  if (emailed) res.status(200).json({ ok: true });
  else res.status(502).json({ error: 'delivery_failed', captured: captured });
};

module.exports.config = { api: { bodyParser: { sizeLimit: '4mb' } } };
