// POST /api/vehicle-lookup — confirms a UK registration against official data.
// Provider order: DVLA Vehicle Enquiry Service (if key present) → DVSA MOT History API (if creds present) → 503.
// Keys are read from runtime remote config so providers activate with no redeploy.
const CONFIG = require('./_config.js');

const PLATE_RE = /^(?:[A-Z]{2}[0-9]{2}[A-Z]{3}|[A-Z][0-9]{1,3}[A-Z]{3}|[A-Z]{3}[0-9]{1,3}[A-Z]?)$/;

const cache = new Map();
const CACHE_MS = 12 * 60 * 60 * 1000;

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const rec = (hits.get(ip) || []).filter((t) => now - t < 60 * 1000);
  rec.push(now);
  hits.set(ip, rec);
  if (hits.size > 5000) hits.clear();
  return rec.length > 12;
}

let motToken = null;

async function dvlaLookup(cfg, reg) {
  const res = await fetch('https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles', {
    method: 'POST',
    headers: { 'x-api-key': cfg.DVLA_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ registrationNumber: reg })
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error('dvla_' + res.status);
  const d = await res.json();
  return {
    source: 'DVLA',
    make: d.make || '',
    model: '',
    colour: d.colour || '',
    year: d.yearOfManufacture || '',
    fuel: d.fuelType || '',
    engine: d.engineCapacity || '',
    taxStatus: d.taxStatus || '',
    motStatus: d.motStatus || ''
  };
}

async function motLookup(cfg, reg) {
  if (!motToken || motToken.exp < Date.now()) {
    const params = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: cfg.MOT_CLIENT_ID,
      client_secret: cfg.MOT_CLIENT_SECRET,
      scope: cfg.MOT_SCOPE_URL
    });
    const tr = await fetch(cfg.MOT_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    if (!tr.ok) throw new Error('mot_token_' + tr.status);
    const td = await tr.json();
    motToken = { token: td.access_token, exp: Date.now() + (Number(td.expires_in || 3000) - 120) * 1000 };
  }
  const res = await fetch('https://history.mot.api.gov.uk/v1/trade/vehicles/registration/' + encodeURIComponent(reg), {
    headers: { Authorization: 'Bearer ' + motToken.token, 'X-API-Key': cfg.MOT_API_KEY, Accept: 'application/json' }
  });
  if (res.status === 404) return { notFound: true };
  if (!res.ok) throw new Error('mot_' + res.status);
  const d = await res.json();
  const tests = Array.isArray(d.motTests) ? d.motTests : [];
  const latest = tests[0] || null;
  let motStatus = '';
  if (latest) {
    const passed = String(latest.testResult || '').toUpperCase() === 'PASSED';
    const expiry = latest.expiryDate ? new Date(latest.expiryDate) : null;
    motStatus = passed && expiry && expiry > new Date() ? 'Valid' : 'Check MOT';
  }
  return {
    source: 'DVSA',
    make: d.make || '',
    model: d.model || '',
    colour: d.primaryColour || '',
    year: (d.firstUsedDate || d.registrationDate || '').slice(0, 4),
    fuel: d.fuelType || '',
    engine: d.engineSize || '',
    taxStatus: '',
    motStatus: motStatus
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (limited(ip)) { res.status(429).json({ error: 'too_many_requests' }); return; }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const reg = String((body && body.registration) || '').toUpperCase().replace(/\s+/g, '').slice(0, 8);
  if (!PLATE_RE.test(reg)) { res.status(400).json({ error: 'bad_registration' }); return; }

  const hit = cache.get(reg);
  if (hit && Date.now() - hit.at < CACHE_MS) { res.status(200).json(hit.data); return; }
  if (cache.size > 2000) cache.clear();

  const cfg = await CONFIG.get();
  const providers = [];
  if (cfg.DVLA_API_KEY) providers.push(dvlaLookup);
  if (cfg.MOT_CLIENT_ID && cfg.MOT_CLIENT_SECRET && cfg.MOT_API_KEY && cfg.MOT_TOKEN_URL) providers.push(motLookup);

  if (providers.length === 0) { res.status(503).json({ error: 'lookup_unavailable' }); return; }

  for (const p of providers) {
    try {
      const data = await p(cfg, reg);
      if (data.notFound) { res.status(404).json({ error: 'not_found' }); return; }
      cache.set(reg, { at: Date.now(), data });
      res.status(200).json(data);
      return;
    } catch (e) { /* try next provider */ }
  }
  res.status(503).json({ error: 'lookup_unavailable' });
};
