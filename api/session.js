import { getConfig, sendJson } from './_lib/config.js';
import { readSession, writeSession } from './_lib/session.js';

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
    return sendJson(res, 200, { points: session.pts });
  } catch (err) {
    return sendJson(res, 500, { error: 'Server configuration error' });
  }
}
