import crypto from 'node:crypto';

export function base64UrlEncode(buf) {
  return Buffer.from(buf).toString('base64url');
}

export function base64UrlDecode(str) {
  if (typeof str !== 'string' || !/^[A-Za-z0-9_-]+$/.test(str)) {
    throw new Error('Invalid base64url encoding');
  }
  return Buffer.from(str, 'base64url');
}

function deriveAesKey(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest();
}

export function encryptWorkerToken(payload, secret, deterministicContext = '') {
  const key = deriveAesKey(secret);
  const iv = deterministicContext
    ? crypto.createHmac('sha256', key).update(deterministicContext, 'utf8').digest().subarray(0, 12)
    : crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = Buffer.from(JSON.stringify(payload), 'utf8');
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const packet = Buffer.concat([Buffer.from([0x01]), iv, encrypted, authTag]);
  return base64UrlEncode(packet);
}

export function decryptWorkerToken(token, secret) {
  const packet = base64UrlDecode(token);
  if (packet.length < 1 + 12 + 16 + 2 || packet[0] !== 0x01) {
    throw new Error('Malformed token');
  }
  const key = deriveAesKey(secret);
  const iv = packet.subarray(1, 13);
  const authTag = packet.subarray(packet.length - 16);
  const ciphertext = packet.subarray(13, packet.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  const data = JSON.parse(plaintext);
  if (!data || typeof data.exp !== 'number' || Date.now() > data.exp) {
    throw new Error('Token expired');
  }
  return data;
}

export function signPayload(payload, secret) {
  const body = base64UrlEncode(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = base64UrlEncode(
    crypto.createHmac('sha256', String(secret)).update(body, 'utf8').digest()
  );
  return `${body}.${sig}`;
}

export function verifySignedPayload(token, secret) {
  if (typeof token !== 'string') return null;
  const dot = token.indexOf('.');
  if (dot <= 0 || dot !== token.lastIndexOf('.')) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]+$/.test(body) || !/^[A-Za-z0-9_-]+$/.test(sig)) return null;

  const expected = crypto.createHmac('sha256', String(secret)).update(body, 'utf8').digest();
  let actual;
  try {
    actual = base64UrlDecode(sig);
  } catch {
    return null;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    return null;
  }
  try {
    return JSON.parse(base64UrlDecode(body).toString('utf8'));
  } catch {
    return null;
  }
}

export function makeOpaqueStoryId(rawKey, secret) {
  const hex = crypto
    .createHmac('sha256', String(secret))
    .update(`story:${String(rawKey)}`, 'utf8')
    .digest('hex');
  return `s_${hex.slice(0, 24)}`;
}

export function makeLikeHash(storyKey, secret) {
  return crypto
    .createHmac('sha256', String(secret))
    .update(`like:${String(storyKey)}`, 'utf8')
    .digest('hex')
    .slice(0, 10);
}

export function randomHex(bytes = 12) {
  return crypto.randomBytes(bytes).toString('hex');
}
