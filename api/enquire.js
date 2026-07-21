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
// Vercel hard-caps the whole request body at 4.5MB and that ceiling is NOT configurable —
// bodyParser.sizeLimit below only tells our own code how much to accept, it can't raise the
// platform limit. The old single-photo cap here (7,000,000 base64 chars ≈ 5.25MB raw) was
// already bigger than the platform allows on its own, before even counting the rest of the
// JSON body — a customer with one big enough photo could have silently hit a 413 from
// Vercel's edge, never reaching this code. Tightened per-image and added a combined cap so
// up to MAX_IMAGES photos together stay comfortably under the real 4.5MB ceiling.
const MAX_IMAGES = 5;
const MAX_IMAGE_BASE64_CHARS = 1_200_000; // ~900KB raw per photo — client compresses well under this
const MAX_TOTAL_IMAGE_BASE64_CHARS = 4_200_000; // ~3.15MB raw combined, leaves headroom under Vercel's 4.5MB body cap

// Reference photo uploads arrive as { data: 'data:image/jpeg;base64,...', name }.
// Returns a nodemailer-ready attachment, or null if absent/invalid/oversized (never blocks the enquiry).
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

// Reference photos arrive as up to MAX_IMAGES { data, name } objects. Validates and caps
// each one, and enforces a combined-size budget across all of them — anything that doesn't
// fit is dropped silently rather than failing the whole enquiry (same philosophy as the
// single-image version above).
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
  // Diagnostic recovery trace only. Vercel retains these logs for a limited time.
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

/* ---------- Email bodies ---------- */
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

/* ---------- Transports ---------- */
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
// Try the configured transport, in preference order. Returns true if the message was accepted.
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

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) { res.status(429).json({ error: 'too_many_requests' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  if (!body || typeof body !== 'object') body = {};

  // Honeypot — real users never fill this hidden field. Pretend success to bots.
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

  if (isOptinOnly) {
    if (!email && !phone) { res.status(400).json({ error: 'contact_required' }); return; }
    if (email && !EMAIL_RE.test(email)) { res.status(400).json({ error: 'bad_email' }); return; }
    if (phone && !PHONE_RE.test(phone)) { res.status(400).json({ error: 'bad_phone' }); return; }
  } else {
    if (!firstName || !lastName) { res.status(400).json({ error: 'name_required' }); return; }
    if (!PHONE_RE.test(phone)) { res.status(400).json({ error: 'bad_phone' }); return; }
    if (!EMAIL_RE.test(email)) { res.status(400).json({ error: 'bad_email' }); return; }
    if (!PLATE_RE.test(registration)) { res.status(400).json({ error: 'bad_registration' }); return; }
    if (services.length === 0) { res.status(400).json({ error: 'services_required' }); return; }
  }

  const cfg = await CONFIG.get();

  const vehicleLine = vehicle
    ? [vehicle.make, vehicle.model, vehicle.colour, vehicle.year, vehicle.fuel].filter(Boolean).join(' · ')
    : 'Not verified at submission';

  const subject = isOptinOnly
    ? 'Marketing sign-up (10% code) — ' + (email || phone)
    : 'New enquiry — ' + (services[0] || 'General') + (registration ? ' — ' + registration : '');

  const record = {
    id: 'e' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
    ts: new Date().toISOString(),
    subject: subject,
    name: (firstName + ' ' + lastName).trim(),
    phone: phone,
    email: email,
    registration: registration,
    vehicle: vehicleLine,
    services: services.join(', ') || (isOptinOnly ? 'Marketing list sign-up' : ''),
    message: message,
    optin: optin,
    source: source,
    page: page,
    hasImage: imageAttachments.length > 0,
    imageCount: imageAttachments.length,
    delivered: false
  };

  // 1) Durable capture happens before any network email attempt. If the database
  // is unavailable, continue trying email but leave an explicit runtime error.
  let persisted = false;
  try { persisted = await persistEnquiry(cfg, record); } catch (e) {
    console.error('ENQUIRY_PERSIST_FAILED:' + JSON.stringify({ id: record.id, message: e && e.message ? e.message : 'unknown' }));
  }

  // Keep a short-retention recovery trace alongside the database row.
  const captured = await enqueue(cfg, record);

  // 2) Instant business email + 3) customer confirmation (best-effort).
  let emailed = false;
  if (transportConfigured(cfg)) {
    // Business notification to the enquiries inbox (with the customer's reference photo attached, if any).
    try {
      const biz = buildBusinessEmail(record);
      emailed = await sendVia(cfg, {
        to: cfg.PRIMARY_TO, subject: record.subject,
        text: biz.text, html: biz.html, replyTo: email || undefined,
        attachments: imageAttachments.length ? imageAttachments : undefined
      });
    } catch (e) { emailed = false; }

    // Customer confirmation — never blocks the response.
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

  // The customer-facing success state remains gated on the actual business email,
  // not on the recovery log or database row.
  // Fixed 2026-07-21: previously `captured || emailed` meant a broken email transport
  // silently told every customer "we've got it" while the business received nothing.
  if (emailed) res.status(200).json({ ok: true });
  else res.status(502).json({ error: 'delivery_failed', captured: captured });
};

// Reference photos are base64-encoded in the JSON body. NOTE: Vercel hard-caps the actual
// request body at 4.5MB regardless of this setting — it is a platform limit, not something
// bodyParser.sizeLimit can raise. This was previously set to '6mb', which was never
// achievable in practice and just masked the real ceiling; set below it so our own parser
// (and MAX_IMAGE_BASE64_CHARS / MAX_TOTAL_IMAGE_BASE64_CHARS above) are the actual, honest
// limits a request will hit.
module.exports.config = { api: { bodyParser: { sizeLimit: '4mb' } } };
