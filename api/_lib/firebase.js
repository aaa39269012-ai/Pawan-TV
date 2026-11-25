import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

let cachedDb = null;

function parseServiceAccount() {
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  let jsonStr = '';
  if (b64 && String(b64).trim()) {
    jsonStr = Buffer.from(String(b64).trim(), 'base64').toString('utf8');
  } else if (raw && String(raw).trim()) {
    jsonStr = String(raw).trim();
  } else {
    throw new Error('Missing FIREBASE_SERVICE_ACCOUNT or FIREBASE_SERVICE_ACCOUNT_BASE64');
  }
  const parsed = JSON.parse(jsonStr);
  if (typeof parsed.private_key === 'string') {
    parsed.private_key = parsed.private_key.replace(/\\n/g, '\n');
  }
  return parsed;
}

export function getDb() {
  if (globalThis.__ptvMockDb) return globalThis.__ptvMockDb;
  if (cachedDb) return cachedDb;
  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(parseServiceAccount()) });
  cachedDb = getFirestore(app);
  return cachedDb;
}
