import { getConfig, sendJson } from '../_lib/config.js';
import { encryptWorkerToken } from '../_lib/crypto.js';
import { readSession, writeSession } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  try {
    const config = getConfig();
    const session = readSession(req, config);
    if (session.isNew) {
      writeSession(req, res, session, config);
    }
    const token = encryptWorkerToken(
      { k: 'ad', sid: session.sid, exp: Date.now() + config.adWorkerTokenTtlMs },
      config.adWorkerSecret
    );
    return sendJson(res, 200, {
      adUrl: `${config.workerUrl}/ad?t=${encodeURIComponent(token)}`
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Failed to prepare ad' });
  }
}
