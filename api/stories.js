import {
  ensureCatalogLoaded,
  rebuildCatalog,
  serializeStoryCard,
  warmupInitialMetadata
} from './_lib/catalog.js';
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

    const url = new URL(req.url, 'http://localhost');
    const force = url.searchParams.get('sync') === '1';

    const { stories, firestoreOk, archiveOk } = await ensureCatalogLoaded(config, force);
    await warmupInitialMetadata(stories, 12, 2400);
    const updatedStories = rebuildCatalog(config);

    return sendJson(res, 200, {
      points: session.pts,
      stories: updatedStories.map(s => serializeStoryCard(s, config)),
      syncWarning: !firestoreOk || !archiveOk
    });
  } catch (err) {
    return sendJson(res, 500, { error: 'Catalog load failed' });
  }
}
