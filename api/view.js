import {
  ensureCatalogLoaded,
  findStoryByPublicId,
  updateStoryCounterInFirestore
} from './_lib/catalog.js';
import { getConfig, isAllowedPostOrigin, readJsonBody, sendJson } from './_lib/config.js';
import { decryptWorkerToken } from './_lib/crypto.js';
import { readSession } from './_lib/session.js';

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
    const body = await readJsonBody(req);
    const storyId = String(body?.storyId || '').trim();
    const streamToken = String(body?.streamToken || '').trim();

    if (!storyId || !streamToken) {
      return sendJson(res, 400, { error: 'Invalid view request' });
    }

    let tokenData;
    try {
      tokenData = decryptWorkerToken(streamToken, config.streamSigningSecret);
    } catch {
      return sendJson(res, 403, { error: 'Invalid playback token' });
    }
    if (tokenData.k !== 'stream' || tokenData.sid !== session.sid) {
      return sendJson(res, 403, { error: 'Playback session mismatch' });
    }

    await ensureCatalogLoaded(config, false);
    let story = findStoryByPublicId(storyId);
    if (!story) {
      await ensureCatalogLoaded(config, true);
      story = findStoryByPublicId(storyId);
    }
    if (!story) {
      return sendJson(res, 404, { error: 'Story not found' });
    }

    const views = await updateStoryCounterInFirestore(story, [story.docId], 'views', 1);
    return sendJson(res, 200, { views });
  } catch (err) {
    return sendJson(res, 500, { error: 'View update failed' });
  }
}
