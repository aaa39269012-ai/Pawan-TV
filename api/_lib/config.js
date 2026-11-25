const REQUIRED_VARS = [
  'ARCHIVE_PROFILE',
  'CF_WORKER_URL',
  'STREAM_SIGNING_SECRET',
  'AD_WORKER_SECRET',
  'SESSION_SECRET',
  'OPAQUE_ID_SECRET'
];

export function getConfig() {
  for (const key of REQUIRED_VARS) {
    if (!process.env[key] || !String(process.env[key]).trim()) {
      throw new Error(`Missing required environment variable: ${key}`);
    }
  }
  const workerUrl = String(process.env.CF_WORKER_URL).trim().replace(/\/+$/, '');
  const publicUrl = String(process.env.PUBLIC_APP_URL || '').trim().replace(/\/+$/, '');
  return {
    archiveProfile: String(process.env.ARCHIVE_PROFILE).trim(),
    workerUrl,
    streamSigningSecret: String(process.env.STREAM_SIGNING_SECRET).trim(),
    adWorkerSecret: String(process.env.AD_WORKER_SECRET).trim(),
    sessionSecret: String(process.env.SESSION_SECRET).trim(),
    opaqueIdSecret: String(process.env.OPAQUE_ID_SECRET).trim(),
    publicAppUrl: publicUrl,
    maxPoints: 5,
    streamTokenTtlMs: 15 * 60 * 1000,   // 15 minutes
    posterTokenTtlMs: 24 * 60 * 60 * 1000, // 24 hours (bucketed for CDN caching)
    adWorkerTokenTtlMs: 2 * 60 * 1000,  // 2 minutes
    adChallengeTtlMs: 5 * 60 * 1000,    // 5 minutes
    minAdWatchMs: 3500                  // Minimum server-side elapsed wall-clock time
  };
}

export function sendJson(res, status, data, extraHeaders = {}) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  for (const [k, v] of Object.entries(extraHeaders)) {
    res.setHeader(k, v);
  }
  res.end(JSON.stringify(data));
}

export async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') {
    return req.body;
  }
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > 65536) throw new Error('Payload too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

export function isAllowedPostOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers['x-forwarded-host'] || req.headers.host || '';
  if (origin) {
    try {
      const originUrl = new URL(origin);
      const allowedOrigins = new Set();
      if (host) {
        allowedOrigins.add(`https://${host.toLowerCase()}`);
        allowedOrigins.add(`http://${host.toLowerCase()}`);
      }
      if (process.env.PUBLIC_APP_URL) {
        allowedOrigins.add(new URL(process.env.PUBLIC_APP_URL).origin.toLowerCase());
      }
      if (!allowedOrigins.has(originUrl.origin.toLowerCase())) {
        return false;
      }
    } catch {
      return false;
    }
  }
  const fetchSite = String(req.headers['sec-fetch-site'] || '').toLowerCase();
  if (fetchSite && fetchSite !== 'same-origin' && fetchSite !== 'same-site' && fetchSite !== 'none') {
    return false;
  }
  return true;
}

export function isHttpsRequest(req) {
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  if (proto) return proto === 'https';
  return Boolean(req.socket?.encrypted);
}
