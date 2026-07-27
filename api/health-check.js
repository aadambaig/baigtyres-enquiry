// POST /api/health-check — protected synthetic-row round-trip check against Supabase.
// Intended to be called weekly by Zapier so a broken enquiry-delivery pipeline (Supabase
// misconfigured, table renamed, credentials rotated, etc.) can't fail silently between
// real customer enquiries. Never touches real enquiry rows and never sends email.
//
// Auth: requires header `x-health-check-secret` to match the Vercel project env var
// HEALTH_CHECK_SECRET. Compared via SHA-256 digest + crypto.timingSafeEqual so neither
// the presence/absence nor the length of the real secret leaks through response timing.
//
// Only SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are read from api/_config.js — the same
// two keys api/enquire.js already reads from there. HEALTH_CHECK_SECRET is read directly
// from process.env so this endpoint stays fully independent of the customer enquiry flow;
// _config.js and enquire.js are untouched by this change.
const crypto = require('crypto');
const CONFIG = require('./_config.js');

let createClient = null;
try { ({ createClient } = require('@supabase/supabase-js')); } catch (e) { createClient = null; }

// Fixed-length-hash comparison: avoids both value differences AND length differences
// being observable via timing, which raw timingSafeEqual on unequal-length buffers can't
// do (it throws instead of comparing).
function secretsMatch(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string' || !supplied || !expected) return false;
  const a = crypto.createHash('sha256').update(supplied).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

function getSupabase(cfg) {
  if (!createClient || !cfg.SUPABASE_URL || !cfg.SUPABASE_SERVICE_ROLE_KEY) return null;
  try {
    return createClient(cfg.SUPABASE_URL, cfg.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { autoRefreshToken: false, persistSession: false }
    });
  } catch (e) {
    return null;
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const expectedSecret = process.env.HEALTH_CHECK_SECRET;
  if (!expectedSecret) {
    res.status(503).json({
      ok: false,
      error: 'config_missing',
      message: 'HEALTH_CHECK_SECRET is not set for this Vercel environment.',
      stages: { vercel: true, supabase_insert: false, supabase_read: false, cleanup: false }
    });
    return;
  }

  const suppliedSecret = req.headers['x-health-check-secret'];
  if (!secretsMatch(suppliedSecret, expectedSecret)) {
    res.status(401).json({
      ok: false,
      error: 'unauthorized',
      stages: { vercel: true, supabase_insert: false, supabase_read: false, cleanup: false }
    });
    return;
  }

  const stages = { vercel: true, supabase_insert: false, supabase_read: false, cleanup: false };
  const checkedAt = new Date().toISOString();
  const marker = 'HEALTHCHECK_' + Date.now().toString(36) + '_' + crypto.randomBytes(6).toString('hex');
  const rowId = 'hc' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36);

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

  // Clearly synthetic, never-real values. Phone is an Ofcom-reserved fictional-use
  // number (07700 900000–900999); email uses the .invalid TLD reserved by RFC 2606.
  const syntheticRow = {
    id: rowId,
    name: 'Synthetic Health Check',
    contact: {
      phone: '07700900123',
      email: 'synthetic-health-check@baigtyres.invalid'
    },
    vehicle_registration: 'HC26XYZ',
    service_requested: ['Synthetic health check'],
    message: marker,
    submitted_at: checkedAt,
    email_sent: false
  };

  // Insert.
  let insertError = null;
  try {
    const { error } = await db.from('enquiries').insert(syntheticRow);
    insertError = error || null;
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

  // Read back the exact row.
  let readRow = null;
  let readError = null;
  try {
    const { data, error } = await db.from('enquiries').select('id, message').eq('id', rowId).maybeSingle();
    readRow = data || null;
    readError = error || null;
  } catch (e) {
    readError = e;
  }
  const readOk = !readError && !!readRow && readRow.id === rowId && readRow.message === marker;
  stages.supabase_read = readOk;

  // Cleanup is attempted regardless of read outcome, so a failed read never leaves the
  // synthetic row behind to pollute genuine enquiry reporting.
  let cleanupError = null;
  try {
    const { error } = await db.from('enquiries').delete().eq('id', rowId);
    cleanupError = error || null;
  } catch (e) {
    cleanupError = e;
  }
  stages.cleanup = !cleanupError;

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
      message: 'Synthetic row was inserted and verified but could not be deleted — check the enquiries table manually for id ' + rowId + '.',
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
};
