import {
  canonicalLikeKey,
  ensureCatalogLoaded,
  findStoryByPublicId,
  getStoryLikeKeys,
  updateStoryCounterInFirestore
} from './_lib/catalog.js';
import { getConfig, isAllowedPostOrigin, readJsonBody, sendJson } from './_lib/config.js';
import { makeLikeHash } from './_lib/crypto.js';
import {
  isStoryLikedInCookie,
  readLikesSet,
  readSession,
  writeLikesSet,
  writeSession
} from './_lib/session.js';

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

    const body = await readJsonBody(req);
    const storyId = String(body?.storyId || '').trim();
    if (!storyId) {
      return sendJson(res, 400, { error: 'Invalid story ID' });
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

    const likesSet = readLikesSet(req, config);
    const allKeys = getStoryLikeKeys(story);
    const alreadyLiked = isStoryLikedInCookie(likesSet, allKeys, config);
    const wantLike = typeof body?.like === 'boolean' ? body.like : !alreadyLiked;

    if (wantLike === alreadyLiked) {
      return sendJson(res, 200, {
        likes: Number(story.likes) || 0,
        liked: alreadyLiked
      });
    }

    const likes = await updateStoryCounterInFirestore(
      story,
      [story.docId],
      'likes',
      wantLike ? 1 : -1
    );

    if (wantLike) {
      likesSet.add(makeLikeHash(canonicalLikeKey(story), config.sessionSecret));
    } else {
      for (const k of allKeys) {
        likesSet.delete(makeLikeHash(k, config.sessionSecret));
      }
    }
    writeLikesSet(req, res, likesSet, config);

    return sendJson(res, 200, { likes, liked: wantLike });
  } catch (err) {
    return sendJson(res, 500, { error: 'Like update failed' });
  }
}
