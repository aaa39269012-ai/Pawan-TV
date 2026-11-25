import {
  ensureArchiveMetadata,
  ensureCatalogLoaded,
  findStoryByPublicId,
  getStoryLikeKeys,
  makePosterProxyUrl,
  rebuildCatalog,
  sanitizeFolder
} from './_lib/catalog.js';
import { getConfig, sendJson } from './_lib/config.js';
import { isStoryLikedInCookie, readLikesSet, readSession, writeSession } from './_lib/session.js';

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

    const url = new URL(req.url, 'http://localhost');
    const id = String(url.searchParams.get('id') || '').trim();
    if (!id || id.length > 256 || /[\/\u0000-\u001f\u007f]/.test(id)) {
      return sendJson(res, 400, { error: 'Invalid story ID' });
    }

    await ensureCatalogLoaded(config, false);
    let story = findStoryByPublicId(id);
    if (!story) {
      // Force reload once in case this instance's catalog cache is stale
      await ensureCatalogLoaded(config, true);
      story = findStoryByPublicId(id);
    }
    if (!story) {
      return sendJson(res, 404, { error: 'Story not found' });
    }

    if (story._isArchiveAuto && story._archiveId) {
      try {
        const meta = await ensureArchiveMetadata(story._archiveId, { priority: true });
        if (meta.status === 'unavailable') {
          rebuildCatalog(config);
          return sendJson(res, 404, { error: 'Story unavailable' });
        }
        rebuildCatalog(config);
        story = findStoryByPublicId(story.publicId) || findStoryByPublicId(id) || story;
      } catch {
        if (!story.episodes?.length) {
          return sendJson(res, 503, { error: 'Episodes load nahi hue. Dobara try karein.' });
        }
      }
    }

    const likesSet = readLikesSet(req, config);
    const liked = isStoryLikedInCookie(likesSet, getStoryLikeKeys(story), config);

    return sendJson(res, 200, {
      points: session.pts,
      story: {
        id: story.publicId,
        name: String(story.name || ''),
        poster: makePosterProxyUrl(story.poster, config),
        folder: sanitizeFolder(story.folder),
        desc: String(story.desc || ''),
        views: Number(story.views) || 0,
        likes: Number(story.likes) || 0,
        liked,
        episodes: (story.episodes || []).map((ep, index) => ({
          index,
          title: String(ep?.title || `Episode ${index + 1}`)
        }))
      }
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Failed to load story' });
  }
}
