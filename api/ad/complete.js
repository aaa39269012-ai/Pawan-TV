import {
  createStreamUrlForEpisode,
  ensureArchiveMetadata,
  ensureCatalogLoaded,
  findStoryByPublicId,
  rebuildCatalog
} from '../_lib/catalog.js';
import { getConfig, isAllowedPostOrigin, readJsonBody, sendJson } from '../_lib/config.js';
import { verifySignedPayload } from '../_lib/crypto.js';
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
    const body = await readJsonBody(req);
    const challengeToken = String(body?.challengeToken || '');

    const payload = verifySignedPayload(challengeToken, config.sessionSecret);
    const now = Date.now();
    if (
      !payload ||
      payload.k !== 'ad_challenge' ||
      payload.sid !== session.sid ||
      typeof payload.jti !== 'string' ||
      !payload.jti ||
      payload.jti === session.jti ||
      typeof payload.iat !== 'number' ||
      typeof payload.exp !== 'number' ||
      now > payload.exp ||
      now - payload.iat < config.minAdWatchMs ||
      now - (session.adAt || 0) < config.minAdWatchMs
    ) {
      return sendJson(res, 403, { error: 'Ad verification failed' });
    }

    session.pts = Math.min(config.maxPoints, session.pts + 5);
    session.jti = payload.jti;
    session.adAt = now;

    const storyId = typeof body?.storyId === 'string' ? body.storyId.trim() : '';
    const episodeIndex = body?.episodeIndex;
    if (storyId && Number.isInteger(episodeIndex) && episodeIndex >= 0) {
      await ensureCatalogLoaded(config, false);
      let story = findStoryByPublicId(storyId);
      if (!story) {
        await ensureCatalogLoaded(config, true);
        story = findStoryByPublicId(storyId);
      }
      if (story?._archiveId) {
        try {
          await ensureArchiveMetadata(story._archiveId, { priority: true, timeoutMs: 3500 });
          rebuildCatalog(config);
          story = findStoryByPublicId(story.publicId) || findStoryByPublicId(storyId) || story;
        } catch {}
      }
      if (story && Array.isArray(story.episodes) && episodeIndex < story.episodes.length) {
        const stream = createStreamUrlForEpisode(story, episodeIndex, session.sid, config);
        if (stream) {
          session.pts = Math.max(0, session.pts - 1);
          session.ep = [story.publicId, episodeIndex, now + 30 * 60 * 1000];
          writeSession(req, res, session, config);
          return sendJson(res, 200, {
            points: session.pts,
            streamUrl: stream.streamUrl,
            streamToken: stream.streamToken,
            expiresAt: stream.expiresAt
          });
        }
      }
    }

    writeSession(req, res, session, config);
    return sendJson(res, 200, { points: session.pts });
  } catch (err) {
    return sendJson(res, 500, { error: 'Ad completion failed' });
  }
}
