import { encryptWorkerToken, makeOpaqueStoryId } from './crypto.js';
import { getDb } from './firebase.js';

const ARCHIVE_REFRESH_MS = 5 * 60 * 1000;
const ARCHIVE_META_TTL_MS = 5 * 60 * 1000;
const ARCHIVE_META_ERROR_RETRY_MS = 45 * 1000;
const FIRESTORE_CACHE_TTL_MS = 60 * 1000;
const ARCHIVE_DOC_PREFIX = 'pawan_archive_v1__';
const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

function getState() {
  if (!globalThis.__ptvCatalogState) {
    globalThis.__ptvCatalogState = {
      firebaseStories: [],
      firebaseFetchedAt: 0,
      firebasePromise: null,
      archiveItems: [],
      archiveFetchedAt: 0,
      archiveSearchSucceeded: false,
      archivePromise: null,
      archiveMeta: new Map(),
      archiveMetaErrors: new Map(),
      archiveMetaPromises: new Map(),
      stories: [],
      byPublicId: new Map()
    };
  }
  return globalThis.__ptvCatalogState;
}

export function buildArchiveQuery(archiveProfile) {
  return `_uploader_useritem:${archiveProfile} AND (mediatype:movies OR format:MPEG4 OR format:"h.264 IA" OR format:"h.264" OR format:WebM OR format:QuickTime OR format:Matroska OR format:"Ogg Video" OR format:"MPEG2-TS" OR format:AVI OR format:"Flash Video" OR format:"Windows Media Video" OR format:MPEG1 OR format:MPEG2 OR format:3GPP)`;
}

export function validArchiveId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,200}$/.test(value) && value !== '.' && value !== '..';
}

export function archiveDocId(identifier) {
  return ARCHIVE_DOC_PREFIX + identifier;
}

function validShareAlias(value) {
  return typeof value === 'string' && /^s_[0-9a-f]{24,32}$/.test(value);
}

function countNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, n) : 0;
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); } catch { return value; }
}

function archiveDownloadUrl(identifier, filename) {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${filename.split('/').map(encodeURIComponent).join('/')}`;
}

export function archiveEpisodeFromUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    let match = null;
    if (host === 'archive.org' || host === 'www.archive.org') {
      match = url.pathname.match(/^\/(?:download|stream|serve)\/([^/]+)\/(.+)$/i);
    } else if (host.endsWith('.archive.org')) {
      match = url.pathname.match(/^\/(?:\d+\/)?items\/([^/]+)\/(.+)$/i);
    }
    if (!match) return null;
    const identifier = decodePathPart(match[1]);
    if (!validArchiveId(identifier)) return null;
    return { identifier, filename: decodePathPart(match[2]) };
  } catch {
    return null;
  }
}

function canonicalArchiveFilename(filename) {
  const name = String(filename || '');
  return (name.normalize ? name.normalize('NFC') : name).replace(/\.ia\.mp4$/i, '.mp4');
}

function episodeArchiveAliases(episode, identifier) {
  const parsed = archiveEpisodeFromUrl(episode?.url);
  if (!parsed || parsed.identifier !== identifier) return [];
  const names = [parsed.filename];
  if (typeof episode.archiveOriginalName === 'string') names.push(episode.archiveOriginalName);
  return [...new Set(names.map(canonicalArchiveFilename))];
}

function isArchiveServicesImage(value) {
  return typeof value === 'string' && value.startsWith('https://archive.org/services/img/');
}

function originalDocIdIsOpaque(story) {
  const id = story?.docId || '';
  if (story?._isArchiveAuto || !/^[A-Za-z0-9]{20}$/.test(id) || /archive/i.test(id)) return false;
  const norm = v => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalizedId = norm(id);
  const title = norm(story?.name);
  const archive = norm(story?._archiveId);
  return !(title.length >= 3 && normalizedId.includes(title)) && !(archive.length >= 3 && normalizedId.includes(archive));
}

function storySortTime(story) {
  const time = story.createdAt;
  if (time && Number.isFinite(time.seconds)) return time.seconds * 1000;
  if (time instanceof Date && Number.isFinite(time.getTime())) return time.getTime();
  const fromArchive = Date.parse(story._archiveAddedAt || '');
  return Number.isFinite(fromArchive) ? fromArchive : 0;
}

function cleanArchiveItem(item) {
  if (!item || !validArchiveId(item.identifier)) return null;
  const rawTitle = Array.isArray(item.title) ? item.title[0] : item.title;
  const title = typeof rawTitle === 'string' && rawTitle.trim() ? rawTitle.trim() : item.identifier.replace(/[-_]+/g, ' ');
  return {
    identifier: item.identifier,
    title,
    addeddate: typeof item.addeddate === 'string'
      ? item.addeddate
      : (typeof item.publicdate === 'string' ? item.publicdate : '')
  };
}

function archiveEpisodesFromMetadata(identifier, data) {
  const files = Array.isArray(data?.files) ? data.files : [];
  const originalVideo = /\.(?:mp4|m4v|webm|ogv|mov|mkv|avi|mpg|mpeg|wmv|flv|ts|mts|m2ts|3gp|3g2)$/i;
  const playableVideo = /\.(?:mp4|m4v|webm|ogv)$/i;
  const safeFile = file =>
    file &&
    typeof file.name === 'string' &&
    file.name &&
    file.private !== true &&
    file.private !== 'true' &&
    !/^history\//i.test(file.name) &&
    !file.name.split('/').some(part => part === '.' || part === '..');

  const groups = new Map();
  const originalNames = new Map();
  const groupFor = name => {
    const key = canonicalArchiveFilename(name);
    if (!groups.has(key)) groups.set(key, { originalName: name, candidates: [] });
    return groups.get(key);
  };

  for (const file of files) {
    if (!safeFile(file) || file.source === 'derivative' || !originalVideo.test(file.name)) continue;
    const group = groupFor(file.name);
    if (/\.ia\.mp4$/i.test(group.originalName) && !/\.ia\.mp4$/i.test(file.name)) group.originalName = file.name;
    originalNames.set(file.name, group);
    if (playableVideo.test(file.name)) {
      group.candidates.push({ file, score: /\.ia\.mp4$/i.test(file.name) ? 30 : 20 });
    }
  }

  for (const file of files) {
    if (!safeFile(file) || file.source !== 'derivative' || !playableVideo.test(file.name)) continue;
    let group;
    if (typeof file.original === 'string' && file.original) {
      group = originalNames.get(file.original);
      if (!group) continue;
    } else {
      group = groupFor(file.name);
    }
    group.candidates.push({ file, score: /\.ia\.mp4$/i.test(file.name) ? 30 : 10 });
  }

  return [...groups.values()]
    .filter(group => group.candidates.length)
    .sort((a, b) => nameCollator.compare(a.originalName, b.originalName))
    .map((group, index) => {
      group.candidates.sort((a, b) => b.score - a.score);
      return {
        title: `Episode ${index + 1}`,
        url: archiveDownloadUrl(identifier, group.candidates[0].file.name),
        archiveOriginalName: group.originalName
      };
    });
}

function archivePosterUrl(identifier, json) {
  const files = Array.isArray(json?.files) ? json.files : [];
  const imageExt = /\.(?:jpe?g|png|webp|gif)$/i;
  const posters = files.filter(
    file =>
      file &&
      typeof file.name === 'string' &&
      file.name &&
      file.private !== true &&
      file.private !== 'true' &&
      !file.name.includes('/') &&
      imageExt.test(file.name) &&
      file.name.replace(imageExt, '').toLowerCase() === 'poster'
  );
  if (!posters.length) return '';
  posters.sort((a, b) => (a.source === 'derivative') - (b.source === 'derivative'));
  return archiveDownloadUrl(identifier, posters[0].name);
}

function parseArchiveMetadata(identifier, json) {
  if (json?.is_dark === true || !json || !json.metadata || !Array.isArray(json.files)) {
    return { status: 'unavailable', checkedAt: Date.now() };
  }
  const rawTitle = Array.isArray(json.metadata.title) ? json.metadata.title[0] : json.metadata.title;
  const parts = typeof json.dir === 'string' ? json.dir.split('/') : [];
  const validDir =
    parts.length === 4 &&
    parts[0] === '' &&
    /^\d+$/.test(parts[1]) &&
    parts[2] === 'items' &&
    parts[3] === identifier;
  const storageServers = validDir
    ? [...new Set([json.d1, json.d2, json.server].filter(host => typeof host === 'string' && /^ia\d+\.us\.archive\.org$/i.test(host)))]
    : [];
  return {
    status: 'ok',
    checkedAt: Date.now(),
    title: typeof rawTitle === 'string' ? rawTitle.trim() : '',
    episodes: archiveEpisodesFromMetadata(identifier, json),
    posterUrl: archivePosterUrl(identifier, json),
    posterChecked: true,
    storageDir: validDir ? json.dir : '',
    storageServers,
    defaultServer: storageServers.includes(json.server) ? json.server : ''
  };
}

async function fetchJsonWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: 'application/json', 'User-Agent': 'PawanTV-Server/2.0' }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function refreshFirestoreStories(force = false) {
  const state = getState();
  if (!force && state.firebaseFetchedAt > 0 && Date.now() - state.firebaseFetchedAt < FIRESTORE_CACHE_TTL_MS) {
    return state.firebaseStories;
  }
  if (state.firebasePromise) return state.firebasePromise;

  state.firebasePromise = (async () => {
    const db = getDb();
    const snap = await db.collection('stories').get();
    const docs = [];
    snap.forEach(d => docs.push({ ...d.data(), docId: d.id }));
    state.firebaseStories = docs;
    state.firebaseFetchedAt = Date.now();
    return docs;
  })().finally(() => {
    state.firebasePromise = null;
  });

  return state.firebasePromise;
}

export async function refreshArchiveCatalog(config, force = false) {
  const state = getState();
  if (!force && state.archiveFetchedAt > 0 && Date.now() - state.archiveFetchedAt < ARCHIVE_REFRESH_MS) {
    return state.archiveItems;
  }
  if (state.archivePromise) return state.archivePromise;

  state.archivePromise = (async () => {
    const query = buildArchiveQuery(config.archiveProfile);
    const found = new Map();
    let page = 1;
    let total = 0;
    do {
      const params = new URLSearchParams({ q: query, rows: '100', page: String(page), output: 'json' });
      ['identifier', 'title', 'publicdate', 'addeddate'].forEach(field => params.append('fl[]', field));
      params.append('sort[]', 'addeddate desc');
      params.append('sort[]', 'identifier asc');
      const json = await fetchJsonWithTimeout(`https://archive.org/advancedsearch.php?${params.toString()}`, 9000);
      if (!json?.response || !Array.isArray(json.response.docs) || !Number.isFinite(Number(json.response.numFound))) {
        throw new Error('Invalid Archive search response');
      }
      const docs = json.response.docs;
      total = Number(json.response.numFound);
      for (const raw of docs) {
        const item = cleanArchiveItem(raw);
        if (item) found.set(item.identifier, item);
      }
      if (!docs.length) break;
      page++;
    } while ((page - 1) * 100 < total);

    state.archiveItems = [...found.values()];
    state.archiveSearchSucceeded = true;
    state.archiveFetchedAt = Date.now();
    if (force) {
      for (const meta of state.archiveMeta.values()) {
        meta.checkedAt = 0;
      }
    }
    return state.archiveItems;
  })().finally(() => {
    state.archivePromise = null;
  });

  return state.archivePromise;
}

export async function ensureArchiveMetadata(identifier, options = {}) {
  if (!validArchiveId(identifier)) throw new Error('Invalid Archive item');
  const state = getState();
  const cached = state.archiveMeta.get(identifier);
  if (!options.force && cached && Date.now() - cached.checkedAt < ARCHIVE_META_TTL_MS) {
    return cached;
  }
  const lastErr = state.archiveMetaErrors.get(identifier) || 0;
  if (!options.priority && !options.force && Date.now() - lastErr < ARCHIVE_META_ERROR_RETRY_MS) {
    if (cached) return cached;
    throw new Error('Metadata retry pending');
  }
  const existing = state.archiveMetaPromises.get(identifier);
  if (existing) return existing;

  const p = (async () => {
    try {
      const json = await fetchJsonWithTimeout(
        `https://archive.org/metadata/${encodeURIComponent(identifier)}`,
        options.timeoutMs || 7000
      );
      const parsed = parseArchiveMetadata(identifier, json);
      state.archiveMeta.set(identifier, parsed);
      state.archiveMetaErrors.delete(identifier);
      return parsed;
    } catch (err) {
      state.archiveMetaErrors.set(identifier, Date.now());
      if (cached) return cached;
      throw err;
    } finally {
      state.archiveMetaPromises.delete(identifier);
    }
  })();

  state.archiveMetaPromises.set(identifier, p);
  return p;
}

function mergeCuratedEpisodes(existingEpisodes, discoveredEpisodes, identifier) {
  const existing = Array.isArray(existingEpisodes) ? existingEpisodes.slice() : [];
  const known = new Set();
  existing.forEach(ep => episodeArchiveAliases(ep, identifier).forEach(key => known.add(key)));
  for (const episode of discoveredEpisodes || []) {
    const aliases = episodeArchiveAliases(episode, identifier);
    if (aliases.some(key => known.has(key))) continue;
    existing.push(episode);
    aliases.forEach(key => known.add(key));
  }
  return existing;
}

function storyArchiveIdentifiers(story) {
  const ids = new Set();
  const episodes = Array.isArray(story.episodes) ? story.episodes : [];
  for (const ep of episodes) {
    const info = archiveEpisodeFromUrl(ep?.url);
    if (info) ids.add(info.identifier);
  }
  return ids;
}

function isOurAutoDocument(story) {
  return story?._pawanArchiveAuto === true && validArchiveId(story.archiveId) && story.docId === archiveDocId(story.archiveId);
}

function computePublicStoryId(story, config) {
  if (validShareAlias(story._shareAlias)) return story._shareAlias;
  if (originalDocIdIsOpaque(story)) return story.docId;
  if (story._archiveId) return makeOpaqueStoryId(`ia:${story._archiveId}`, config.opaqueIdSecret);
  return makeOpaqueStoryId(`doc:${story.docId}`, config.opaqueIdSecret);
}

export function rebuildCatalog(config) {
  const state = getState();
  const archiveById = new Map(state.archiveItems.map(item => [item.identifier, item]));
  const autoDocs = new Map();
  const curated = [];
  const claimed = new Map();

  for (const source of state.firebaseStories) {
    if (isOurAutoDocument(source)) autoDocs.set(source.archiveId, source);
    else curated.push(source);
  }

  for (const story of curated) {
    for (const identifier of storyArchiveIdentifiers(story)) {
      if (!claimed.has(identifier)) claimed.set(identifier, []);
      claimed.get(identifier).push(story.docId);
    }
  }

  const nextStories = curated.map(source => {
    const episodes = Array.isArray(source.episodes) ? source.episodes : [];
    const ids = [...storyArchiveIdentifiers(source)];
    const id = ids.length === 1 ? ids[0] : '';
    const safe =
      id &&
      (archiveById.has(id) || autoDocs.has(id)) &&
      claimed.get(id)?.length === 1 &&
      episodes.length &&
      episodes.every(ep => archiveEpisodeFromUrl(ep?.url)?.identifier === id);
    const meta = safe ? state.archiveMeta.get(id) : null;
    const autoStats = safe ? autoDocs.get(id) : null;
    const item = {
      ...source,
      episodes: meta?.status === 'ok' ? mergeCuratedEpisodes(episodes, meta.episodes, id) : episodes.slice(),
      views: countNumber(source.views) + countNumber(autoStats?.views),
      likes: countNumber(source.likes) + countNumber(autoStats?.likes),
      _archiveId: safe ? id : '',
      _archiveAddedAt: safe ? (archiveById.get(id)?.addeddate || '') : '',
      _autoStatsId: autoStats ? autoStats.docId : '',
      _shareAlias: validShareAlias(source._pawanShareId) ? source._pawanShareId : '',
      _autoShareAlias: validShareAlias(autoStats?._pawanShareId) ? autoStats._pawanShareId : '',
      _isArchiveAuto: false
    };
    item.publicId = computePublicStoryId(item, config);
    return item;
  });

  if (!state.archiveSearchSucceeded) {
    autoDocs.forEach((source, id) => {
      if (!archiveById.has(id)) {
        archiveById.set(id, { identifier: id, title: source.name || id, addeddate: '' });
      }
    });
  }

  for (const [id, item] of archiveById) {
    if (claimed.has(id)) continue;
    const meta = state.archiveMeta.get(id);
    if (meta?.status === 'unavailable') continue;
    const source = autoDocs.get(id);
    const fallbackEpisodes = Array.isArray(source?.episodes) ? source.episodes : [];
    const entry = {
      ...(source || {}),
      docId: archiveDocId(id),
      name: source?.name || meta?.title || item.title,
      poster: (source?.poster && !isArchiveServicesImage(source.poster) ? source.poster : '') || (meta?.status === 'ok' ? meta.posterUrl || '' : ''),
      folder: source?.folder || 'Series',
      desc: source?.desc || '',
      episodes: meta?.status === 'ok' ? meta.episodes : fallbackEpisodes,
      views: countNumber(source?.views),
      likes: countNumber(source?.likes),
      _archiveId: id,
      _archiveAddedAt: item.addeddate,
      _isArchiveAuto: true,
      _shareAlias: validShareAlias(source?._pawanShareId) ? source._pawanShareId : '',
      _archiveMetadataKnown: meta?.status === 'ok'
    };
    entry.publicId = computePublicStoryId(entry, config);
    nextStories.push(entry);
  }

  nextStories.sort((a, b) => storySortTime(b) - storySortTime(a));

  const lookup = new Map();
  for (const s of nextStories) {
    lookup.set(s.publicId, s);
    if (s._shareAlias) lookup.set(s._shareAlias, s);
    if (s._autoShareAlias) lookup.set(s._autoShareAlias, s);
    if (originalDocIdIsOpaque(s)) lookup.set(s.docId, s);
    if (s._archiveId) {
      lookup.set(makeOpaqueStoryId(`ia:${s._archiveId}`, config.opaqueIdSecret), s);
    }
  }

  state.stories = nextStories;
  state.byPublicId = lookup;
  return nextStories;
}

export async function ensureCatalogLoaded(config, force = false) {
  const results = await Promise.allSettled([
    refreshFirestoreStories(force),
    refreshArchiveCatalog(config, force)
  ]);
  const firestoreOk = results[0].status === 'fulfilled';
  const archiveOk = results[1].status === 'fulfilled';
  const stories = rebuildCatalog(config);
  return { stories, firestoreOk, archiveOk };
}

export async function warmupInitialMetadata(stories, limit = 12, budgetMs = 2500) {
  const state = getState();
  const candidates = stories
    .filter(s => s._archiveId && !state.archiveMeta.has(s._archiveId))
    .slice(0, limit);
  if (!candidates.length) return;

  const deadline = Promise.race([
    Promise.allSettled(
      candidates.map(s => ensureArchiveMetadata(s._archiveId, { timeoutMs: 2200 }))
    ),
    new Promise(resolve => setTimeout(resolve, budgetMs))
  ]);
  await deadline;
}

export function findStoryByPublicId(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  return getState().byPublicId.get(id.trim()) || null;
}

export function sanitizeFolder(folder) {
  const text = String(folder || '').trim();
  if (!text || /^internet\s*archive$/i.test(text)) return 'Series';
  return text;
}

export function makePosterProxyUrl(poster, config) {
  if (typeof poster !== 'string' || !poster.trim()) return '';
  const trimmed = poster.trim();
  if (/^data:image\//i.test(trimmed)) return trimmed;
  if (isArchiveServicesImage(trimmed)) return '';
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    const bucketMs = config.posterTokenTtlMs;
    const exp = Math.ceil(Date.now() / bucketMs) * bucketMs + bucketMs;
    const token = encryptWorkerToken(
      { k: 'poster', u: u.href, exp },
      config.streamSigningSecret,
      `poster:${exp}:${u.href}`
    );
    return `${config.workerUrl}/poster?t=${encodeURIComponent(token)}`;
  } catch {
    return '';
  }
}

export function serializeStoryCard(story, config) {
  const metaKnown = Boolean(!story._isArchiveAuto || story._archiveMetadataKnown || story.episodes.length);
  return {
    id: story.publicId,
    name: String(story.name || ''),
    poster: makePosterProxyUrl(story.poster, config),
    folder: sanitizeFolder(story.folder),
    desc: String(story.desc || ''),
    episodeCount: metaKnown ? story.episodes.length : null,
    metaKnown,
    views: countNumber(story.views),
    likes: countNumber(story.likes)
  };
}

export function buildEpisodeSources(episode) {
  const primary = typeof episode?.url === 'string' ? episode.url.trim() : '';
  if (!primary) return [];
  const info = archiveEpisodeFromUrl(primary);
  const metadata = info ? getState().archiveMeta.get(info.identifier) : null;
  if (
    !info ||
    !metadata?.storageDir ||
    !Array.isArray(metadata.storageServers) ||
    info.filename.split('/').some(part => part === '.' || part === '..')
  ) {
    return [primary];
  }
  const parts = metadata.storageDir.split('/');
  if (
    parts.length !== 4 ||
    parts[0] !== '' ||
    !/^\d+$/.test(parts[1]) ||
    parts[2] !== 'items' ||
    parts[3] !== info.identifier
  ) {
    return [primary];
  }
  let host = '';
  try { host = new URL(primary).hostname.toLowerCase(); } catch {}
  const usualHost = host === 'archive.org' || host === 'www.archive.org' ? metadata.defaultServer : host;
  const servers = metadata.storageServers
    .filter(server => typeof server === 'string' && /^ia\d+\.us\.archive\.org$/i.test(server))
    .slice()
    .sort((a, b) => (a === usualHost ? 1 : 0) - (b === usualHost ? 1 : 0));
  const encodedName = info.filename.split('/').map(encodeURIComponent).join('/');
  const urls = servers.map(server => `https://${server}${metadata.storageDir}/${encodedName}`);
  return [...new Set([primary, ...urls])];
}

export function createStreamUrlForEpisode(story, episodeIndex, sessionSid, config) {
  const episode = story?.episodes?.[episodeIndex];
  if (!episode) return null;
  const sources = buildEpisodeSources(episode);
  if (!sources.length) return null;
  const exp = Date.now() + config.streamTokenTtlMs;
  const token = encryptWorkerToken(
    { k: 'stream', u: sources, sid: sessionSid, exp },
    config.streamSigningSecret
  );
  return {
    streamToken: token,
    streamUrl: `${config.workerUrl}/stream?t=${encodeURIComponent(token)}`,
    expiresAt: exp
  };
}

export function canonicalLikeKey(story) {
  if (!story) return '';
  return story._archiveId ? `ia:${story._archiveId}` : `doc:${story.docId}`;
}

export function getStoryLikeKeys(story) {
  if (!story) return [];
  return [...new Set([canonicalLikeKey(story), story.publicId, story.docId, story._autoStatsId].filter(Boolean))];
}

export function autoStoryDocument(story, field, delta) {
  const sourceEpisodes = Array.isArray(story.episodes) ? story.episodes : [];
  let episodes = sourceEpisodes.map(ep => ({
    title: String(ep?.title || ''),
    url: String(ep?.url || ''),
    ...(typeof ep?.archiveOriginalName === 'string' ? { archiveOriginalName: ep.archiveOriginalName } : {})
  }));
  if (Buffer.byteLength(JSON.stringify(episodes), 'utf8') > 600000) episodes = [];
  const date = new Date(story._archiveAddedAt || Date.now());
  return {
    _pawanArchiveAuto: true,
    archiveId: story._archiveId,
    name: String(story.name || story._archiveId),
    poster: String(story.poster && !isArchiveServicesImage(story.poster) ? story.poster : ''),
    folder: String(story.folder || 'Internet Archive'),
    desc: String(story.desc || ''),
    episodes,
    views: field === 'views' ? Math.max(0, delta) : 0,
    likes: field === 'likes' ? Math.max(0, delta) : 0,
    createdAt: Number.isFinite(date.getTime()) ? date : new Date()
  };
}

export async function updateStoryCounterInFirestore(story, targets, field, delta) {
  const db = getDb();
  let newTotal = 0;
  await db.runTransaction(async transaction => {
    const records = [];
    for (const targetId of targets) {
      const ref = db.collection('stories').doc(targetId);
      records.push({ targetId, ref, snapshot: await transaction.get(ref) });
    }
    for (const record of records) {
      const isAutoTarget = !!story._archiveId && record.targetId === archiveDocId(story._archiveId);
      if (record.snapshot.exists) {
        const data = record.snapshot.data();
        if (isAutoTarget && !isOurAutoDocument({ ...data, docId: record.targetId })) {
          throw new Error('Auto story ID belongs to another record');
        }
        const nextVal = Math.max(0, countNumber(data[field]) + delta);
        transaction.update(record.ref, { [field]: nextVal });
        newTotal += nextVal;
      } else {
        if (!isAutoTarget || !story._isArchiveAuto || delta < 0) {
          throw new Error('Story record not found');
        }
        const docData = autoStoryDocument(story, field, delta);
        transaction.set(record.ref, docData);
        newTotal += docData[field];
      }
    }
  });
  // Update local memory cache immediately
  const state = getState();
  state.firebaseFetchedAt = 0;
  if (field === 'views') story.views = Math.max(0, countNumber(story.views) + delta);
  if (field === 'likes') story.likes = Math.max(0, countNumber(story.likes) + delta);
  return field === 'views' ? story.views : story.likes;
}
