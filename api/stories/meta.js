import {
  ensureArchiveMetadata,
  ensureCatalogLoaded,
  findStoryByPublicId,
  rebuildCatalog,
  serializeStoryCard
} from '../_lib/catalog.js';
import { getConfig, isAllowedPostOrigin, readJsonBody, sendJson } from '../_lib/config.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }
  if (!isAllowedPostOrigin(req)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }
  try {
    const config = getConfig();
    const body = await readJsonBody(req);
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter(x => typeof x === 'string' && x.trim().length > 0 && x.length <= 128).slice(0, 12)
      : [];
    if (!ids.length) {
      return sendJson(res, 200, { items: [] });
    }

    await ensureCatalogLoaded(config, false);
    const targets = [];
    for (const id of ids) {
      const story = findStoryByPublicId(id);
      if (story?._archiveId) targets.push({ publicId: story.publicId, archiveId: story._archiveId });
    }

    const uniqueArchiveIds = [...new Set(targets.map(t => t.archiveId))];
    await Promise.race([
      Promise.allSettled(uniqueArchiveIds.map(id => ensureArchiveMetadata(id, { timeoutMs: 4000 }))),
      new Promise(resolve => setTimeout(resolve, 4500))
    ]);

    rebuildCatalog(config);
    const items = [];
    for (const id of ids) {
      const updated = findStoryByPublicId(id);
      if (updated) {
        items.push(serializeStoryCard(updated, config));
      }
    }
    return sendJson(res, 200, { items });
  } catch (err) {
    return sendJson(res, 500, { error: 'Metadata hydrate failed' });
  }
}
