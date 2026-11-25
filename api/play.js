import {
  createStreamUrlForEpisode,
  ensureArchiveMetadata,
  ensureCatalogLoaded,
  findStoryByPublicId,
  rebuildCatalog
} from './_lib/catalog.js';
import { getConfig, isAllowedPostOrigin, readJsonBody, sendJson } from './_lib/config.js';
import { readSession, writeSession } from './_lib/session.js';

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
    const episodeIndex = Number(body?.episodeIndex);
    const isRetry = body?.retry === true;

    if (!storyId || !Number.isInteger(episodeIndex) || episodeIndex < 0) {
      return sendJson(res, 400, { error: 'Invalid play request' });
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

    if (story._archiveId) {
      try {
        await ensureArchiveMetadata(story._archiveId, { priority: true, timeoutMs: 3500 });
        rebuildCatalog(config);
        story = findStoryByPublicId(story.publicId) || findStoryByPublicId(storyId) || story;
      } catch {
        // Proceed with cached/curated episode URLs if available
      }
    }

    if (!Array.isArray(story.episodes) || episodeIndex >= story.episodes.length) {
      return sendJson(res, 404, { error: 'Episode not found' });
    }

    const activeMatch =
      isRetry &&
      Array.isArray(session.ep) &&
      session.ep[0] === story.publicId &&
      session.ep[1] === episodeIndex &&
      typeof session.ep[2] === 'number' &&
      Date.now() < session.ep[2];

    if (!activeMatch) {
      if (session.pts <= 0) {
        if (session.isNew) writeSession(req, res, session, config);
        return sendJson(res, 402, { needsAd: true, points: 0 });
      }
      session.pts -= 1;
      session.ep = [story.publicId, episodeIndex, Date.now() + 30 * 60 * 1000];
      writeSession(req, res, session, config);
    } else if (session.isNew) {
      writeSession(req, res, session, config);
    }

    const stream = createStreamUrlForEpisode(story, episodeIndex, session.sid, config);
    if (!stream) {
      return sendJson(res, 404, { error: 'Video link available nahi hai.' });
    }

    return sendJson(res, 200, {
      points: session.pts,
      streamUrl: stream.streamUrl,
      streamToken: stream.streamToken,
      expiresAt: stream.expiresAt
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Failed to authorize playback' });
  }
}
