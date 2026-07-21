// Server-side configuration.
// This file is not served as an endpoint (underscore prefix).
//
// HISTORY: this used to also merge in a remote "config blob" (jsonblob.com) so
// credentials could be updated without a redeploy. That blob (and the separate
// durable-queue blob referenced elsewhere) went dead — jsonblob's free tier
// expires blobs (observed: 24h from creation), so it was never a safe place to
// keep anything long-lived. Removed 2026-07-13. Config now comes from real
// Vercel project environment variables only (Project Settings -> Environment
// Variables) — set a key there and it's live on the next deploy.

const STATIC = {
  // Enquiry delivery.
  PRIMARY_TO: 'enquiries.baigtyres@gmail.com',            // the business inbox (FormSubmit activation click enables direct delivery)

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
  MOT_TOKEN_URL: '',

  // Durable enquiry storage. Use the service-role key only in this server-side
  // function; never expose it to the browser as a NEXT_PUBLIC/VITE variable.
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: ''
};

let cached = null;

async function get() {
  // Precedence: process.env (non-empty) > static defaults. No external fetch,
  // no cache expiry needed — env vars don't change mid-invocation.
  if (cached) return cached;
  const merged = Object.assign({}, STATIC);
  for (const k of Object.keys(STATIC)) {
    if (process.env[k]) merged[k] = process.env[k];
  }
  cached = merged;
  return merged;
}

module.exports = { get };
