import { isHttpsRequest } from './config.js';
import { makeLikeHash, randomHex, signPayload, verifySignedPayload } from './crypto.js';

const SESSION_COOKIE = 'ptv_session';
const LIKES_COOKIE = 'ptv_likes';
const MAX_LIKE_HASHES = 120;

export function parseCookies(req) {
  const header = req.headers.cookie;
  const out = Object.create(null);
  if (!header || typeof header !== 'string') return out;
  const parts = header.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const name = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (!name) continue;
    try {
      out[name] = decodeURIComponent(val);
    } catch {
      out[name] = val;
    }
  }
  return out;
}

function formatCookie(name, value, maxAgeSec, https) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    `Max-Age=${maxAgeSec}`,
    'HttpOnly',
    'SameSite=Lax'
  ];
  if (https) parts.push('Secure');
  return parts.join('; ');
}

export function appendSetCookie(res, cookieStr) {
  const existing = res.getHeader('Set-Cookie');
  if (!existing) {
    res.setHeader('Set-Cookie', [cookieStr]);
  } else if (Array.isArray(existing)) {
    res.setHeader('Set-Cookie', [...existing, cookieStr]);
  } else {
    res.setHeader('Set-Cookie', [String(existing), cookieStr]);
  }
}

export function readSession(req, config) {
  const cookies = parseCookies(req);
  const raw = cookies[SESSION_COOKIE];
  if (raw) {
    const data = verifySignedPayload(raw, config.sessionSecret);
    if (
      data &&
      data.v === 1 &&
      typeof data.sid === 'string' &&
      /^[a-f0-9]{16}$/.test(data.sid) &&
      Number.isInteger(data.pts) &&
      data.pts >= 0 &&
      data.pts <= config.maxPoints
    ) {
      return {
        isNew: false,
        v: 1,
        sid: data.sid,
        pts: data.pts,
        jti: typeof data.jti === 'string' ? data.jti : '',
        adAt: Number.isFinite(data.adAt) ? data.adAt : 0,
        ep: Array.isArray(data.ep) && data.ep.length === 3 ? data.ep : null
      };
    }
  }
  return {
    isNew: true,
    v: 1,
    sid: randomHex(8),
    pts: config.maxPoints,
    jti: '',
    adAt: 0,
    ep: null
  };
}

export function writeSession(req, res, session, config) {
  const payload = {
    v: 1,
    sid: session.sid,
    pts: Math.max(0, Math.min(config.maxPoints, Math.floor(session.pts))),
    jti: session.jti || '',
    adAt: Number.isFinite(session.adAt) ? session.adAt : 0
  };
  if (
    Array.isArray(session.ep) &&
    session.ep.length === 3 &&
    typeof session.ep[2] === 'number' &&
    session.ep[2] > Date.now()
  ) {
    payload.ep = session.ep;
  }
  const signed = signPayload(payload, config.sessionSecret);
  appendSetCookie(res, formatCookie(SESSION_COOKIE, signed, 30 * 24 * 60 * 60, isHttpsRequest(req)));
}

export function readLikesSet(req, config) {
  const cookies = parseCookies(req);
  const raw = cookies[LIKES_COOKIE];
  if (raw) {
    const data = verifySignedPayload(raw, config.sessionSecret);
    if (data && data.v === 1 && Array.isArray(data.ids)) {
      return new Set(data.ids.filter(x => typeof x === 'string' && /^[a-f0-9]{10}$/.test(x)).slice(-MAX_LIKE_HASHES));
    }
  }
  return new Set();
}

export function isStoryLikedInCookie(likesSet, storyKeys, config) {
  return storyKeys.some(key => likesSet.has(makeLikeHash(key, config.sessionSecret)));
}

export function writeLikesSet(req, res, likesSet, config) {
  const ids = [...likesSet].slice(-MAX_LIKE_HASHES);
  const signed = signPayload({ v: 1, ids }, config.sessionSecret);
  appendSetCookie(res, formatCookie(LIKES_COOKIE, signed, 365 * 24 * 60 * 60, isHttpsRequest(req)));
}
