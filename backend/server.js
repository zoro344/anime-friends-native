'use strict';
require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const Parser = require('rss-parser');
const fs = require('fs');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || '*', methods: ['GET', 'POST'] } });
const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'development-only-change-this-secret';
const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const parser = new Parser({ timeout: 12000, headers: { 'User-Agent': 'AnimeFriends/1.0' } });

if (JWT_SECRET === 'development-only-change-this-secret' && process.env.NODE_ENV === 'production') {
  throw new Error('JWT_SECRET must be configured in production.');
}
fs.mkdirSync(DATA_DIR, { recursive: true });
const emptyDb = () => ({ users: [], posts: [], comments: [], votes: [], friendships: [], library: [], activities: [] });
function readDb() {
  let raw;
  try {
    raw = fs.readFileSync(DB_FILE, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return emptyDb();
    throw new Error('Cannot read database: ' + err.message);
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Database contains invalid JSON: ' + err.message);
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Database must contain a JSON object.');
  }

  const defaults = emptyDb();
  for (const key of Object.keys(defaults)) {
    if (!Object.prototype.hasOwnProperty.call(parsed, key) || !Array.isArray(parsed[key])) {
      throw new Error('Database collection is missing or invalid: ' + key);
    }
  }
  return { ...defaults, ...parsed };
}
let db = readDb();
async function writeDb(nextDb) {
  const tempFile = DB_FILE + '.tmp-' + process.pid + '-' + require('crypto').randomUUID();
  let handle;
  try {
    handle = await fs.promises.open(tempFile, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(nextDb, null, 2), 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.promises.rename(tempFile, DB_FILE);
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    await fs.promises.unlink(tempFile).catch(() => {});
    throw err;
  }
}

let saveQueue = Promise.resolve();

function updateDb(mutator) {
  const operation = saveQueue.then(async () => {
    const nextDb = structuredClone(db);
    const result = await mutator(nextDb);
    await writeDb(nextDb);
    db = nextDb;
    return result;
  });
  saveQueue = operation.catch(() => {});
  return operation;
}

async function persistChange(res, mutator) {
  try {
    return { ok: true, result: await updateDb(mutator) };
  } catch (err) {
    console.error('Database update failed:', err.message);
    res.status(500).json({
      error: true,
      message: 'Could not save data. Please try again.'
    });
    return { ok: false };
  }
}

const id = () => require('crypto').randomUUID();
const safeUser = u => ({ id: u.id, username: u.username, avatar: u.avatar || null, createdAt: u.createdAt });
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: true, message: 'Please log in again.' }); }
}
function cleanText(value, max = 4000) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors({ origin: process.env.CORS_ORIGIN || '*', credentials: false }));
app.use(express.json({ limit: '1mb' }));
app.use('/api/auth', rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));

app.get('/health', (_req, res) => res.json({ ok: true, service: 'anime-friends-api', version: '1.0.0' }));
app.post('/api/auth/signup', async (req, res) => {
  const username = cleanText(req.body.username, 24);
  const password = typeof req.body.password === 'string' ? req.body.password : '';
  if (!/^[a-zA-Z0-9_]{3,24}$/.test(username)) return res.status(400).json({ error: true, message: 'Username must be 3–24 characters using letters, numbers or underscore.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: true, message: 'Password must be at least 8 characters.' });
  const user = { id: id(), username, passwordHash: await bcrypt.hash(password, 12), createdAt: new Date().toISOString() };
  const saved = await persistChange(res, nextDb => {
    if (nextDb.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      return { duplicate: true };
    }
    nextDb.users.push(user);
    return { duplicate: false };
  });
  if (!saved.ok) return;
  if (saved.result.duplicate) return res.status(409).json({ error: true, message: 'That username is already taken.' });
  res.status(201).json({ token: jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' }), user: safeUser(user) });
});
app.post('/api/auth/login', async (req, res) => {
  const username = cleanText(req.body.username, 24); const password = typeof req.body.password === 'string' ? req.body.password : '';
  const user = db.users.find(u => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: true, message: 'Incorrect username or password.' });
  res.json({ token: jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '30d' }), user: safeUser(user) });
});
app.get('/api/me', auth, (req, res) => { const u = db.users.find(x => x.id === req.user.id); if (!u) return res.status(404).json({ error: true, message: 'Account not found.' }); res.json({ user: safeUser(u) }); });

app.get('/api/posts', auth, (req, res) => {
  const posts = db.posts.map(p => ({ ...p, score: db.votes.filter(v => v.postId === p.id).reduce((n, v) => n + v.value, 0), commentCount: db.comments.filter(c => c.postId === p.id).length, myVote: db.votes.find(v => v.postId === p.id && v.userId === req.user.id)?.value || 0 })).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ posts });
});
app.post('/api/posts', auth, async (req, res) => {
  const text = cleanText(req.body.text, 4000); const imageUrl = cleanText(req.body.imageUrl, 1500);
  if (!text) return res.status(400).json({ error: true, message: 'Write something before posting.' });
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) return res.status(400).json({ error: true, message: 'Image URL must use HTTPS.' });
  const post = { id: id(), userId: req.user.id, username: req.user.username, text, imageUrl: imageUrl || null, createdAt: new Date().toISOString() };
  const saved = await persistChange(res, nextDb => { nextDb.posts.push(post); });
  if (!saved.ok) return;
  io.emit('feed:new-post', post);
  res.status(201).json({ post: { ...post, score: 0, commentCount: 0 } });
});
app.post('/api/posts/:postId/vote', auth, async (req, res) => {
  const value = Number(req.body.value);
  if (![1, -1].includes(value)) return res.status(400).json({ error: true, message: 'Vote must be 1 or -1.' });

  const saved = await persistChange(res, nextDb => {
    if (!nextDb.posts.some(p => p.id === req.params.postId)) {
      return { missing: true };
    }

    const old = nextDb.votes.find(v => v.postId === req.params.postId && v.userId === req.user.id);
    if (old && old.value === value) {
      nextDb.votes = nextDb.votes.filter(v => v !== old);
    } else if (old) {
      old.value = value;
    } else {
      nextDb.votes.push({ postId: req.params.postId, userId: req.user.id, value });
    }

    return {
      missing: false,
      score: nextDb.votes.filter(v => v.postId === req.params.postId).reduce((n, v) => n + v.value, 0)
    };
  });

  if (!saved.ok) return;
  if (saved.result.missing) return res.status(404).json({ error: true, message: 'Post not found.' });
  res.json({ score: saved.result.score });
});
app.get('/api/posts/:postId/comments', auth, (req, res) => res.json({ comments: db.comments.filter(c => c.postId === req.params.postId).sort((a,b) => a.createdAt.localeCompare(b.createdAt)) }));
app.post('/api/posts/:postId/comments', auth, async (req, res) => {
  const text = cleanText(req.body.text, 1500);
  if (!text) return res.status(400).json({ error: true, message: 'Comment cannot be empty.' });

  const comment = { id: id(), postId: req.params.postId, userId: req.user.id, username: req.user.username, text, createdAt: new Date().toISOString() };
  const saved = await persistChange(res, nextDb => {
    if (!nextDb.posts.some(p => p.id === req.params.postId)) {
      return { missing: true };
    }
    nextDb.comments.push(comment);
    return { missing: false };
  });

  if (!saved.ok) return;
  if (saved.result.missing) return res.status(404).json({ error: true, message: 'Post not found.' });
  io.emit('feed:new-comment', comment);
  res.status(201).json({ comment });
});
app.get('/api/anime/search', auth, async (req, res) => {
  const query = cleanText(req.query.q, 100); if (!query) return res.json({ results: [] });
  try {
    const gql = 'query ($search: String) { Page(perPage: 20) { media(search: $search, type: ANIME, sort: POPULARITY_DESC) { id idMal format status averageScore description episodes coverImage { large } title { romaji english native } } } }';
    const response = await fetch('https://graphql.anilist.co', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, body: JSON.stringify({ query: gql, variables: { search: query } }), signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`AniList returned ${response.status}`);
    const payload = await response.json(); const media = payload.data?.Page?.media || [];
    res.json({ results: media.map(m => ({ id: m.id, malId: m.idMal, title: m.title?.english || m.title?.romaji || m.title?.native || 'Untitled', format: m.format, status: m.status, score: m.averageScore == null ? '—' : (m.averageScore / 10).toFixed(1), description: m.description || '', cover: m.coverImage?.large || '' })) });
  } catch (e) { res.status(502).json({ error: true, message: `Anime search unavailable: ${e.message}` }); }
});
app.post('/api/library', auth, async (req, res) => {
  const mediaId = cleanText(String(req.body.mediaId || ''), 30);
  const title = cleanText(req.body.title, 200);
  const cover = cleanText(req.body.cover, 1500);
  if (!mediaId || !title) return res.status(400).json({ error: true, message: 'Anime ID and title are required.' });

  const saved = await persistChange(res, nextDb => {
    let item = nextDb.library.find(x => x.userId === req.user.id && x.mediaId === mediaId);
    if (!item) {
      item = { id: id(), userId: req.user.id, mediaId, title, cover, status: 'PLANNING', createdAt: new Date().toISOString() };
      nextDb.library.push(item);
    }
    return item;
  });

  if (!saved.ok) return;
  res.status(201).json({ item: saved.result });
});
app.get('/api/library', auth, (req, res) => res.json({ items: db.library.filter(x => x.userId === req.user.id) }));

function cleanArticleDescription(value) {
  if (typeof value !== 'string') return '';

  value = decodeArticleEntities(value);

  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .replace(/([([{])\s+/g, '$1')
    .replace(/\s+([)\]}])/g, '$1')
    .replace(/(\w)\s+(['’])([sS]\b)/g, '$1$2$3')
    .trim();
}

function extractArticleImage(item) {
  const candidates = [
    item.enclosure?.url,
    item['media:thumbnail']?.url,
    item['media:thumbnail']?.$?.url,
    item['media:content']?.url,
    item['media:content']?.$?.url
  ];

  const html = [
    item.content,
    item.contentEncoded,
    item['content:encoded']
  ].filter(value => typeof value === 'string').join(' ');

  const match = html.match(/<img\b[^>]*\bsrc=["']([^"']+)["']/i);
  if (match) candidates.push(match[1]);

  return candidates.find(url =>
    typeof url === 'string' && /^https:\/\//i.test(url.trim())
  )?.trim() || null;
}


// Article-page metadata extraction with a six-hour in-memory cache.
const articleMetadataCache = new Map();
const ARTICLE_CACHE_TTL = 6 * 60 * 60 * 1000;

function decodeArticleEntities(value) {
  const entities = {
    amp: '&', quot: '"', apos: "'", '#39': "'",
    nbsp: ' ', hellip: '…', mdash: '—', ndash: '–',
    lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
    copy: '©', reg: '®'
  };

  return String(value || '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === '#') {
        const hex = entity[1]?.toLowerCase() === 'x';
        const number = parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(number) ? String.fromCodePoint(number) : match;
      }
      return entities[entity.toLowerCase()] ?? match;
    });
}

function getMetaContent(html, wantedName) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];

  for (const tag of tags) {
    const attrs = {};
    for (const match of tag.matchAll(
      /([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g
    )) {
      attrs[match[1].toLowerCase()] =
        match[2] ?? match[3] ?? match[4] ?? '';
    }

    const key = (attrs.property || attrs.name || '').toLowerCase();
    if (key === wantedName.toLowerCase() && attrs.content) {
      return decodeArticleEntities(attrs.content.trim());
    }
  }

  return '';
}

async function fetchArticleMetadata(articleUrl) {
  try {
    const parsedUrl = new URL(articleUrl);
    if (parsedUrl.protocol !== 'https:') return null;

    const cached = articleMetadataCache.get(articleUrl);
    if (cached && Date.now() - cached.time < ARTICLE_CACHE_TTL) {
      return cached.data;
    }

    const response = await fetch(articleUrl, {
      headers: { 'User-Agent': 'AnimeFriends/1.0 (article metadata)' },
      signal: AbortSignal.timeout(10000),
      redirect: 'error'
    });

    if (!response.ok) return null;

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/html')) return null;

    const length = Number(response.headers.get('content-length') || 0);
    if (length > 2 * 1024 * 1024) return null;

    const html = await response.text();
    if (html.length > 2 * 1024 * 1024) return null;

    // Extract readable paragraphs from the actual article body.
    let fullDescription = '';

    // Anime News Network uses a table-based review layout.
    const reviewMarker = html.indexOf('Review:</td>');

    if (/animenewsnetwork\.com$/i.test(parsedUrl.hostname) && reviewMarker !== -1) {
      const zoneStart = html.indexOf('<div class="text-zone">', reviewMarker);

      if (zoneStart !== -1) {
        const contentStart = html.indexOf('>', zoneStart) + 1;
        const zoneEnd = html.indexOf('</div></td>', contentStart);

        if (zoneEnd !== -1) {
          const bodyHtml = html.slice(contentStart, zoneEnd);

          const paragraphs = [...bodyHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
            .map(match => cleanArticleDescription(match[1]))
            .filter(Boolean);

          fullDescription = paragraphs.join('\n\n').slice(0, 12000);
        }
      }
    }

    // Anime Corner and other WordPress-style article pages.
    if (!fullDescription) {
      const bodyStart = html.search(/class=["'][^"']*entry-content[^"']*["']/i);

      if (bodyStart !== -1) {
        const articleStart = html.indexOf('>', bodyStart) + 1;
        const articleEnd = html.indexOf('</article>', articleStart);
        const bodyHtml = html.slice(
          articleStart,
          articleEnd === -1 ? Math.min(html.length, articleStart + 150000) : articleEnd
        );

        const paragraphs = [...bodyHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
          .map(match => cleanArticleDescription(match[1]))
          .filter(Boolean);

        fullDescription = paragraphs.join('\n\n').slice(0, 12000);
      }
    }

    const description =
      fullDescription ||
      getMetaContent(html, 'og:description') ||
      getMetaContent(html, 'twitter:description');

    let imageUrl =
      getMetaContent(html, 'og:image') ||
      getMetaContent(html, 'twitter:image');

    if (imageUrl) {
      try {
        imageUrl = new URL(imageUrl, articleUrl).href;
        if (new URL(imageUrl).protocol !== 'https:') imageUrl = null;
      } catch {
        imageUrl = null;
      }
    }

    const data = { description, imageUrl };
    articleMetadataCache.set(articleUrl, { time: Date.now(), data });
    return data;
  } catch {
    return null;
  }
}

async function enrichArticleMetadata(items) {
  const result = items.map(item => ({ ...item }));
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < result.length) {
      const index = nextIndex++;
      const item = result[index];
      const metadata = await fetchArticleMetadata(item.url);

      if (metadata) {
        if (metadata.description) {
          result[index].description = cleanArticleDescription(metadata.description);
        }
        if (metadata.imageUrl) {
          result[index].imageUrl = metadata.imageUrl;
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(4, result.length) }, () => worker())
  );

  return result;
}

function classifyNewsCategories(title, summary) {
  const text = `${title} ${summary}`.toLowerCase();
  const categories = [];

  if (/\b(announces?|announcement|reveals?|unveils?|confirmed|confirmation|officially announced)\b/i.test(text)) {
    categories.push('announcements');
  }

  if (/\b(trailer|teaser|pv|promotional video)\b/i.test(text)) {
    categories.push('trailers');
  }

  if (/\b(release date|premiere date|premieres? on|debut(?:s|ing)? on|launch(?:es)? on|air(?:s|ing)? on|scheduled to (?:release|premiere))\b/i.test(text)) {
    categories.push('release_date');
  }

  return categories;
}
app.get('/api/news', auth, async (req, res) => {
  // Accept a comma- or newline-separated list, while keeping the legacy single URL.
  const configuredUrls = [
    ...(process.env.ANIME_NEWS_RSS_URLS || '').split(/[\n,]+/),
    process.env.ANIME_NEWS_RSS_URL || ''
  ].map(value => value.trim()).filter(Boolean);
  const uniqueUrls = [...new Set(configuredUrls)];
  if (!uniqueUrls.length) {
    return res.json({
      items: [],
      notice: 'Configure ANIME_NEWS_RSS_URLS (multiple feeds) or ANIME_NEWS_RSS_URL (one feed) on the backend to enable news.'
    });
  }

  const results = await Promise.allSettled(uniqueUrls.map(async rssUrl => {
    // RSS sources are trusted server configuration; require HTTPS to avoid unsafe URL schemes.
    let parsedUrl;
    try { parsedUrl = new URL(rssUrl); } catch { throw new Error('Invalid RSS URL'); }
    if (parsedUrl.protocol !== 'https:') throw new Error('RSS feed URL must use HTTPS');

    // Fetch first so malformed ampersands in publisher XML can be repaired
    // before rss-parser sees the document. Preserve XML's five predefined
    // entities and numeric character references; escape other ampersands.
    const response = await fetch(parsedUrl.toString(), {
      headers: { 'User-Agent': 'AnimeFriends/1.0', 'Accept': 'application/rss+xml, application/xml, text/xml, */*' },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow'
    });
    if (!response.ok) throw new Error(`RSS server returned HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') {
      throw new Error('RSS feed redirected to a non-HTTPS URL');
    }
    const xml = await response.text();
    if (xml.length > 5 * 1024 * 1024) throw new Error('RSS feed is larger than 5 MB');
    const repairedXml = xml.replace(/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, '&amp;');
    const feed = await parser.parseString(repairedXml);
    const rawSource = cleanText(feed.title, 120) || parsedUrl.hostname;
    const source = /animecorner\.me/i.test(parsedUrl.hostname)
  ? 'Anime Corner'
  : rawSource;
    const items = (feed.items || []).map(item => ({
      title: cleanText(item.title, 300),
      url: typeof item.link === 'string' ? item.link.trim() : '',
      source,
      summary: cleanText(item.contentSnippet || item.content || '', 600),
      description: cleanArticleDescription(
        item.contentEncoded ||
        item['content:encoded'] ||
        item.content ||
        item.summary ||
        item.contentSnippet ||
        ''
      ),
      imageUrl: extractArticleImage(item),
      categories: classifyNewsCategories(
        cleanText(item.title, 300),
        cleanText(item.contentSnippet || item.content || '', 600)
      ),
      publishedAt: item.isoDate || item.pubDate || ''
    })).filter(item => item.title && /^https:\/\//i.test(item.url));
    return { source, items };
  }));

  const successfulFeeds = results.filter(result => result.status === 'fulfilled').map(result => result.value);
  const failures = results.map((result, index) => result.status === 'rejected'
    ? { url: uniqueUrls[index], message: cleanText(result.reason?.message || 'Feed unavailable', 240) }
    : null).filter(Boolean);

  if (!successfulFeeds.length) {
    return res.status(502).json({ error: true, message: 'All configured anime news feeds are unavailable.', failures });
  }

  const seen = new Set();
  const mergedItems = successfulFeeds.flatMap(feed => feed.items).filter(item => {
    let key = item.url;
    try {
      const url = new URL(item.url);
      url.hash = '';
      for (const parameter of [...url.searchParams.keys()]) {
        if (/^(utm_|fbclid$|gclid$)/i.test(parameter)) url.searchParams.delete(parameter);
      }
      key = url.toString().replace(/\/$/, '');
    } catch { /* The HTTPS filter above already rejects malformed URLs. */ }
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
    }).sort((a, b) => {
    const aTime = Date.parse(a.publishedAt);
    const bTime = Date.parse(b.publishedAt);
    if (!Number.isFinite(aTime)) return Number.isFinite(bTime) ? 1 : 0;
    if (!Number.isFinite(bTime)) return -1;
    return bTime - aTime;
  });

  const sortOrder = String(req.query.sort || 'newest').toLowerCase();

  if (!['newest', 'oldest'].includes(sortOrder)) {
    return res.status(400).json({
      error: true,
      message: 'Sort must be newest or oldest.'
    });
  }

  if (sortOrder === 'oldest') {
    mergedItems.reverse();
  }

    const requestedSource = cleanText(req.query.source || '', 120).toLowerCase();
  const searchQuery = cleanText(req.query.q || '', 100).toLowerCase();
  const requestedCategory = cleanText(req.query.category || '', 40).toLowerCase();

  const allowedCategories = ['announcements', 'trailers', 'release_date'];

  if (requestedCategory && !allowedCategories.includes(requestedCategory)) {
    return res.status(400).json({
      error: true,
      message: 'Category must be announcements, trailers or release_date.'
    });
  }

  const filteredItems = mergedItems.filter(item => {
    const matchesSource = !requestedSource ||
      item.source.toLowerCase() === requestedSource;

    const matchesSearch = !searchQuery ||
      item.title.toLowerCase().includes(searchQuery) ||
      item.summary.toLowerCase().includes(searchQuery);

    const matchesCategory = !requestedCategory ||
      item.categories.includes(requestedCategory);

    return matchesSource && matchesSearch && matchesCategory;
  });

  const page = req.query.page === undefined ? 1 : Number(req.query.page);
const limit = req.query.limit === undefined ? 30 : Number(req.query.limit);

  if (!Number.isInteger(page) || page < 1) {
    return res.status(400).json({
      error: true,
      message: 'Page must be a positive integer.'
    });
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 30) {
    return res.status(400).json({
      error: true,
      message: 'Limit must be between 1 and 30.'
    });
  }

  const total = filteredItems.length;
  const startIndex = (page - 1) * limit;
  const paginatedItems = filteredItems.slice(startIndex, startIndex + limit);

  res.json({
    items: await enrichArticleMetadata(paginatedItems),
    sources: successfulFeeds.map(feed => feed.source),
    categories: ['announcements', 'trailers', 'release_date'],
    pagination: {
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
      hasMore: startIndex + limit < total
    },
    ...(failures.length ? { warnings: failures } : {})
  });
});

// Watchium bridge. The Watchium API token stays on this server, never in the Android APK.
app.post('/api/watchium/rooms', auth, async (req, res) => {
  const watchiumUrl = (process.env.WATCHIUM_SERVER_URL || '').replace(/\/$/, '');
  const apiToken = process.env.WATCHIUM_API_TOKEN || '';
  if (!watchiumUrl) return res.status(503).json({ error: true, message: 'Watchium is not configured on this backend. Set WATCHIUM_SERVER_URL and WATCHIUM_API_TOKEN.' });
  const { provider, providerUserId, username, avatarUrl, content } = req.body || {};
  if (!['anilist', 'mal', 'simkl'].includes(String(provider).toLowerCase())) return res.status(400).json({ error: true, message: 'Provider must be anilist, mal or simkl.' });
  if (!providerUserId || !username || !content?.animeTitle || !Number.isInteger(Number(content?.episodeNumber)) || !content?.animeId) return res.status(400).json({ error: true, message: 'Missing Watchium account, anime ID or episode details.' });
  const allowedIdentities = (process.env.WATCHIUM_ALLOWED_IDENTITIES || '').split(',').map(x => x.trim().toLowerCase()).filter(Boolean);
  const identityKey = `${String(provider).toLowerCase()}:${String(providerUserId)}`.toLowerCase();
  if (!allowedIdentities.includes(identityKey)) return res.status(403).json({ error: true, message: 'This provider identity is not approved for Watchium room creation on this server. Configure WATCHIUM_ALLOWED_IDENTITIES after verifying account ownership.' });
  const servers = content.availableServers;
  if (!Array.isArray(servers) || !servers.length || servers.some(s => { try { const u = new URL(s.url || ''); return !['http:', 'https:'].includes(u.protocol) || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/i.test(u.hostname); } catch { return true; } })) return res.status(400).json({ error: true, message: 'A valid, reachable HTTP(S) episode stream is required. Local/private proxy streams cannot be shared.' });
  try {
    const headers = { 'Content-Type': 'application/json', ...(apiToken ? { 'X-API-Token': apiToken } : {}) };
    const loginResponse = await fetch(`${watchiumUrl}/api/auth/login`, { method: 'POST', headers, body: JSON.stringify({ provider: String(provider).toLowerCase(), providerUserId: String(providerUserId), username: String(username), avatarUrl: avatarUrl || null }), signal: AbortSignal.timeout(15000) });
    const loginData = await loginResponse.json().catch(() => ({}));
    if (!loginResponse.ok || !loginData.token) return res.status(502).json({ error: true, message: `Watchium login failed (${loginResponse.status}). Check provider identity and server configuration.` });
    const createResponse = await fetch(`${watchiumUrl}/api/watch-party`, { method: 'POST', headers: { ...headers, Authorization: `Bearer ${loginData.token}` }, body: JSON.stringify({ content, maxMembers: 10 }), signal: AbortSignal.timeout(20000) });
    const createData = await createResponse.json().catch(() => ({}));
    if (!createResponse.ok || !createData.code) return res.status(502).json({ error: true, message: `Watchium room creation failed (${createResponse.status}). ${createData.message || ''}`.trim() });
    res.status(201).json({ code: String(createData.code), deepLink: `anymex://watchium/join/${String(createData.code)}`, note: 'The AnymeX app must be installed and the user must be logged into a compatible provider account there.' });
  } catch (e) { res.status(502).json({ error: true, message: `Could not reach Watchium: ${e.message}` }); }
});

app.get('/api/friends', auth, (req, res) => {
  const ids = new Set(db.friendships.filter(f => f.status === 'accepted' && (f.from === req.user.id || f.to === req.user.id)).map(f => f.from === req.user.id ? f.to : f.from));
  res.json({ friends: db.users.filter(u => ids.has(u.id)).map(safeUser) });
});
app.post('/api/friends/request', auth, async (req, res) => {
  const username = cleanText(req.body.username, 24).toLowerCase();
  const target = db.users.find(u => u.username.toLowerCase() === username);
  if (!target || target.id === req.user.id) return res.status(404).json({ error: true, message: 'User not found.' });

  const saved = await persistChange(res, nextDb => {
    const currentTarget = nextDb.users.find(u => u.id === target.id);
    if (!currentTarget) return { missing: true };
    const exists = nextDb.friendships.some(f =>
      [f.from, f.to].includes(req.user.id) && [f.from, f.to].includes(target.id)
    );
    if (exists) return { duplicate: true };

    nextDb.friendships.push({
      id: id(),
      from: req.user.id,
      to: target.id,
      status: 'pending',
      createdAt: new Date().toISOString()
    });
    return { missing: false, duplicate: false };
  });

  if (!saved.ok) return;
  if (saved.result.missing) return res.status(404).json({ error: true, message: 'User not found.' });
  if (saved.result.duplicate) return res.status(409).json({ error: true, message: 'A friendship or request already exists.' });
  res.status(201).json({ ok: true });
});
app.get('/api/friends/requests', auth, (req, res) => res.json({ requests: db.friendships.filter(f => f.to === req.user.id && f.status === 'pending').map(f => ({ ...f, user: safeUser(db.users.find(u => u.id === f.from) || {}) })) }));
app.post('/api/friends/requests/:id/accept', auth, async (req, res) => {
  const saved = await persistChange(res, nextDb => {
    const friendship = nextDb.friendships.find(x =>
      x.id === req.params.id &&
      x.to === req.user.id &&
      x.status === 'pending'
    );
    if (!friendship) return false;
    friendship.status = 'accepted';
    return true;
  });

  if (!saved.ok) return;
  if (!saved.result) return res.status(404).json({ error: true, message: 'Request not found.' });
  res.json({ ok: true });
});

io.use((socket, next) => { try { socket.user = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET); next(); } catch { next(new Error('unauthorized')); } });
io.on('connection', socket => {
  socket.join(`user:${socket.user.id}`);
  socket.on('feed:subscribe', () => socket.join('feed'));
});

server.listen(PORT, process.env.HOST || '0.0.0.0', () => console.log(`Anime Friends API listening on ${process.env.HOST || '0.0.0.0'}:${PORT}`));
