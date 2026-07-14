// Server-side configuration + runtime remote config.
// This file is not served as an endpoint (underscore prefix).
//
// WHY REMOTE CONFIG: production redeploys for this project are constrained, so
// endpoints read a small JSON "config blob" at runtime (cached ~60s). That means
// credentials that arrive later — the DVSA MOT API key (submitted 2026-07-09,
// ~5 working days), a DVLA key, or a transactional-email key (Resend/Brevo) —
// can be dropped into the blob and go live within a minute, no redeploy needed.

const STATIC = {
  // Enquiry delivery.
  PRIMARY_TO: 'enquiries.baigtyres@gmail.com',            // the business inbox (FormSubmit activation click enables direct delivery)
  MIRROR_TO: '879a714de78a33e7f7ff4dceaf23dfa9',          // activated FormSubmit alias -> owner's Gmail (already live)
  SITE_ORIGIN: 'https://baigtyres-services.vercel.app',

  // Durable capture queue: every enquiry is written here first so no lead is ever lost,
  // even if all email paths are down. A delivery worker forwards from this queue.
  QUEUE_BLOB: 'https://jsonblob.com/api/jsonBlob/019f45cc-e11e-741e-b505-8b2117aee241',

  // ---- Email delivery ----
  // Preferred: send straight from the business Gmail over SMTP using a Google App Password.
  // Add GMAIL_APP_PASSWORD to the config blob and enquiries send INSTANTLY, direct to
  // PRIMARY_TO, and each customer gets an automatic confirmation email — no redeploy.
  GMAIL_USER: 'enquiries.baigtyres@gmail.com',
  GMAIL_APP_PASSWORD: '',
  // Send the customer an automatic "we've got your enquiry" confirmation (needs a sender above).
  CUSTOMER_CONFIRM: '1',
  OFFER_CODE: 'WELCOME10',

  // Optional transactional-email providers (used instead of Gmail if a key is present).
  RESEND_API_KEY: '',
  RESEND_FROM: 'Baig Tyres <onboarding@resend.dev>',
  BREVO_API_KEY: '',
  BREVO_SENDER_EMAIL: '',
  BREVO_SENDER_NAME: 'Baig Tyres Website',

  // Vehicle lookup providers.
  DVLA_API_KEY: '',
  MOT_CLIENT_ID: '',
  MOT_CLIENT_SECRET: '',
  MOT_API_KEY: '',
  MOT_SCOPE_URL: 'https://tapi.dvsa.gov.uk/.default',
  MOT_TOKEN_URL: ''
};

// Remote config blob — merged over STATIC at runtime.
const CONFIG_BLOB = 'https://jsonblob.com/api/jsonBlob/019f45b7-c9ef-7e76-a8b0-23cd7817d867';

let cached = null;
let cachedAt = 0;
const TTL_MS = 60 * 1000;

async function get() {
  const now = Date.now();
  if (cached && now - cachedAt < TTL_MS) return cached;
  let remote = {};
  try {
    const r = await fetch(CONFIG_BLOB, { headers: { Accept: 'application/json' } });
    if (r.ok) remote = await r.json();
  } catch (e) { /* fall back to static + env */ }
  // Precedence: remote blob (non-empty) > process.env > static defaults.
  const merged = Object.assign({}, STATIC);
  for (const k of Object.keys(STATIC)) {
    if (process.env[k]) merged[k] = process.env[k];
    if (remote && remote[k] !== undefined && remote[k] !== null && remote[k] !== '') merged[k] = remote[k];
  }
  cached = merged;
  cachedAt = now;
  return merged;
}

module.exports = { get };
