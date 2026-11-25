import { getConfig, isAllowedPostOrigin, sendJson } from '../_lib/config.js';
import { encryptWorkerToken, randomHex, signPayload } from '../_lib/crypto.js';
import { readSession, writeSession } from '../_lib/session.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (!isAllowedPostOrigin(req)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const config = getConfig();
    const session = readSession(req, config);
    if (session.isNew) {
      writeSession(req, res, session, config);
    }

    const now = Date.now();
    const challengeToken = signPayload(
      {
        k: 'ad_challenge',
        sid: session.sid,
        jti: randomHex(8),
        iat: now,
        exp: now + config.adChallengeTtlMs
      },
      config.sessionSecret
    );

    const workerToken = encryptWorkerToken(
      { k: 'ad', sid: session.sid, exp: now + config.adWorkerTokenTtlMs },
      config.adWorkerSecret
    );

    return sendJson(res, 200, {
      challengeToken,
      adUrl: `${config.workerUrl}/ad?t=${encodeURIComponent(workerToken)}`
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Failed to start ad session' });
  }
}
