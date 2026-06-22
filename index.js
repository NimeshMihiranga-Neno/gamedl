const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://oceantogames.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

const DL_HOSTS = [
  'mega.nz', 'mega.co.nz', 'mediafire.com', 'drive.google.com',
  'pixeldrain.com', '1fichier.com', 'uptobox.com', 'dropapk.to',
  'clicknupload.co', 'clicknupload.to', 'sendit.cloud', 'datanodes.to',
  'buzzheavier.com', 'gofile.io', 'rapidgator.net', 'uploaded.net',
  'filecrypt.cc', 'multiup.io', 'hexupload.net', 'anonfiles.com',
  'uploadhaven.com', 'mixdrop.ag', 'streamlare.com',
];

function isDownloadUrl(href = '') {
  const h = href.toLowerCase();
  return DL_HOSTS.some(d => h.includes(d)) || h.startsWith('magnet:');
}

function cleanText(str = '') {
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ── Helper: extract a spec value from body text using regex ────────────────
function extractSpec(text, pattern) {
  const m = text.match(pattern);
  if (!m) return undefined;
  return m[1].replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/search?game=GAME_NAME
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const gameName = (req.query.game || '').trim();
  if (!gameName) return res.status(400).json({ success: false, error: '?game= required' });

  try {
    const wpRes = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      headers: HEADERS,
      params: {
        search: gameName,
        per_page: 10,
        _embed: true,
        orderby: 'relevance',
      },
      timeout: 15000,
    });

    const results = wpRes.data.map(post => ({
      id: post.id,
      title: cleanText(post.title?.rendered || ''),
      link: post.link,
      excerpt: cleanText(post.excerpt?.rendered || '').substring(0, 200),
      date: post.date,
      image:
        post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.medium?.source_url ||
        post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
        null,
    }));

    return res.json({ success: true, count: results.length, source: 'wp-rest-api', results });
  } catch (err) {
    // Fallback: scrape search results page
    try {
      const html = await axios.get(`${BASE_URL}/`, {
        headers: HEADERS,
        params: { s: gameName },
        timeout: 15000,
      });
      const $ = cheerio.load(html.data);
      const results = [];
      $('article, .post').each((_, el) => {
        const a = $(el).find('h2 a, h1 a').first();
        const title = a.text().trim();
        const link = a.attr('href');
        const img = $(el).find('img').first().attr('src') || null;
        const excerpt = $(el).find('.entry-summary, p').first().text().trim().substring(0, 200);
        if (title && link) results.push({ title, link, image: img, excerpt });
      });
      return res.json({ success: true, count: results.length, source: 'search-page-fallback', results });
    } catch (e) {
      return res.status(500).json({ success: false, error: e.message });
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/data?game=GAME_URL
//  Uses body-text regex parsing because site wraps content in one big <a> tag
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/data', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) return res.status(400).json({ success: false, error: '?game= URL required' });

  try {
    const response = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(response.data);

    // ── Meta tags (always reliable) ─────────────────────────────────────
    const title =
      $('h1.entry-title').text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      'Unknown';

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('article img').first().attr('src') ||
      null;

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      '';

    // ── Strip noise, get full body text ────────────────────────────────
    $('nav, header nav, footer, .related-posts, .sharedaddy, script, style, noscript, .sidebar').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').replace(/\*/g, '').trim();

    // ── Overview: text between "Overview" and "Technical Specifications" ─
    let overview = '';
    const ovMatch = rawText.match(/Overview\s+(.{80,}?)(?=Technical Specifications|Mature Content Description|System Requirements|Before you start)/i);
    if (ovMatch) {
      overview = ovMatch[1].trim().substring(0, 1500);
    } else {
      overview = description.substring(0, 800);
    }

    // ── Technical specs ─────────────────────────────────────────────────
    const specs = {};
    const sv = (p) => extractSpec(rawText, p);

    const ver = sv(/Game Version\s*[:\s]+([v\d.]+)/i);
    if (ver) specs.version = ver;

    const sz = sv(/(?:Game\s+)?Download\s+Size\s*[:\s]+([\d.]+ ?(?:GB|MB|TB))/i);
    if (sz) specs.size = sz;

    const iL = sv(/Interface Language\s*[:\s]+([A-Za-z, /]+?)(?= Audio| Game| MD5|$)/i);
    if (iL) specs.interfaceLanguage = iL.trim();

    const aL = sv(/Audio Language\s*[:\s]+([A-Za-z, /]+?)(?= Interface| Game| MD5|$)/i);
    if (aL) specs.audioLanguage = aL.trim();

    const fn = sv(/Game File Name\s*[:\s]+([^\s[\]]+\.(?:zip|rar|iso|exe))/i);
    if (fn) specs.filename = fn;

    const md5 = sv(/MD5SUM\s*[:\s]+([a-fA-F0-9]{32})/i);
    if (md5) specs.md5 = md5;

    const rp = sv(/(?:Uploader|Re\s*packer)\s*(?:Group)?\s*[:\s]+([A-Za-z0-9\- ]+?)(?= Game| Interface| MD5|$)/i);
    if (rp && rp.trim().length > 1) specs.repacker = rp.trim();

    // ── Categories: only from post meta (rel="category tag"), NOT nav ──
    const categories = [];

    // Strategy 1: WordPress standard — only set on post meta links, not nav
    $('a[rel="category tag"]').each((_, el) => {
      const cat = $(el).text().trim();
      if (cat && !categories.includes(cat)) categories.push(cat);
    });

    // Strategy 2: Fallback — links with title containing "topics" (WP post meta pattern)
    if (categories.length === 0) {
      $('a[href*="/category/"][title*="topic"]').each((_, el) => {
        const cat = $(el).text().trim();
        if (cat && !categories.includes(cat)) categories.push(cat);
      });
    }

    // Strategy 3: Look inside article / entry-meta only (not whole body)
    if (categories.length === 0) {
      $('article a[href*="/category/"], .entry-meta a[href*="/category/"], .cat-links a').each((_, el) => {
        const cat = $(el).text().trim();
        if (cat && !categories.includes(cat)) categories.push(cat);
      });
    }

    // ── System requirements from body text ──────────────────────────────
    let minReqs = [];
    let recReqs = [];

    const minBlock = rawText.match(/Minimum:\s*(.+?)(?=Recommended:|Click on the|Free Download$)/i);
    const recBlock = rawText.match(/Recommended:\s*(.+?)(?=Free Download|Click on the|Dead Cells|$)/i);

    const parseReqBlock = (block) =>
      block
        .split(/(?=OS|Processor|Memory|Graphics|Storage|DirectX|Network|Additional|Sound)/i)
        .map(s => s.trim())
        .filter(s => s.length > 3);

    if (minBlock) minReqs = parseReqBlock(minBlock[1]);
    if (recBlock) recReqs = parseReqBlock(recBlock[1]);

    // ── Screenshots: all <img> in article ───────────────────────────────
    const screenshots = [];
    $('article img, .entry-content img, .post img, #content img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src && !src.includes('favicon') && !src.includes('logo') && !src.includes('-120x120')) {
        screenshots.push(src);
      }
    });

    res.json({
      success: true,
      title,
      image,
      description,
      overview,
      specs,
      categories: [...new Set(categories)].slice(0, 15),
      systemRequirements: { minimum: minReqs, recommended: recReqs },
      screenshots: [...new Set(screenshots)].slice(0, 10),
      sourceUrl: gameUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/directlink?game=GAME_URL
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/directlink', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) return res.status(400).json({ success: false, error: '?game= URL required' });

  try {
    const response = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const html = response.data;
    const $ = cheerio.load(html);

    const links = [];
    const seen = new Set();

    // ── STRICT filter: must be truly external (not oceantogames.com) ─────
    const addLink = (href, label, type) => {
      href = (href || '').trim();
      if (!href) return;
      if (href === '#') return;
      if (href.startsWith('javascript')) return;
      if (href.startsWith('/')) return;                          // relative paths
      if (href.includes('oceantogames.com')) return;            // internal links
      if (href.includes('wordpress.com')) return;               // WP assets
      if (href.includes('gravatar.com')) return;                // avatars
      if (seen.has(href)) return;
      seen.add(href);
      links.push({ label: (label || 'Download').trim(), url: href, type });
    };

    // ── S1: <a> tags pointing to known DL hosts ──────────────────────────
    $('a').each((_, el) => {
      const href = $(el).attr('href') || '';
      if (isDownloadUrl(href)) addLink(href, $(el).text() || 'Download', 'direct');
    });

    // ── S2: onclick → window.open / location.href ────────────────────────
    $('[onclick]').each((_, el) => {
      const oc = $(el).attr('onclick') || '';
      const m = oc.match(/(?:window\.open|location(?:\.href)?\s*=)\s*['"](.+?)['"]/);
      if (m) addLink(m[1], $(el).text() || 'Download', 'onclick');
    });

    // ── S3: data-* attributes ─────────────────────────────────────────────
    $('[data-href],[data-url],[data-link],[data-download],[data-src]').each((_, el) => {
      const h = $(el).attr('data-href') || $(el).attr('data-url') ||
                $(el).attr('data-link') || $(el).attr('data-download') ||
                $(el).attr('data-src');
      if (h) addLink(h, $(el).text() || 'Download', 'data-attr');
    });

    // ── S4: iframes pointing to external pages ────────────────────────────
    $('iframe').each((_, el) => {
      const src = $(el).attr('src') || '';
      if (src) addLink(src, 'Embedded Frame', 'iframe');
    });

    // ── S5: DL host URLs anywhere in raw HTML (inside JS / JSON / attrs) ─
    const dlHostRx = /https?:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz|mediafire\.com|drive\.google\.com|docs\.google\.com\/uc|pixeldrain\.com|1fichier\.com|gofile\.io|buzzheavier\.com|datanodes\.to|clicknupload\.co|clicknupload\.to|sendit\.cloud|rapidgator\.net|uploaded\.net|filecrypt\.cc|multiup\.io|hexupload\.net|dropapk\.to|uptobox\.com|anonfiles\.com|mixdrop\.ag)[^\s"'`<>\)\]\\]+/gi;
    let m;
    while ((m = dlHostRx.exec(html)) !== null) {
      addLink(m[0].replace(/[.,;]+$/, ''), 'Auto-detected', 'html-regex');
    }

    // ── S6: <script> tags — look for URLs ending in archive extensions ───
    $('script:not([src])').each((_, el) => {
      const src = $(el).html() || '';
      const archiveRx = /https?:\/\/[^\s"'`\\]+\.(?:zip|rar|iso|exe|7z|tar|gz)[^\s"'`\\]*/gi;
      let am;
      while ((am = archiveRx.exec(src)) !== null) {
        addLink(am[0], 'Script-archive', 'script');
      }
    });

    // ── S7: keyword-matched external links (redirect/shortener wrappers) ─
    $('a').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      if (!href || seen.has(href)) return;
      // Must be truly external
      if (href.startsWith('javascript') || href.startsWith('/') ||
          href.includes('oceantogames.com')) return;

      const txt = $(el).text().toLowerCase();
      const dlKw = ['direct link', 'link 1', 'link 2', 'link 3',
                    'part 1', 'part 2', 'part 3', 'mirror',
                    'google drive', 'mega', 'mediafire', 'gdrive', 'magnet'];
      if (dlKw.some(k => txt.includes(k))) {
        addLink(href, $(el).text(), 'keyword');
      }
    });

    const jsPopupNote = links.length === 0
      ? '⚠️ No static download links found. oceantogames.com uses a JavaScript popup for downloads — static scraping cannot capture them. Use Playwright (headless browser) to click the Download button and capture the popup links.'
      : null;

    res.json({
      success: true,
      count: links.length,
      note: jsPopupNote,
      links,
      sourceUrl: gameUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/latest
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/latest', async (req, res) => {
  const page  = parseInt(req.query.page)  || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const wpRes = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      headers: HEADERS,
      params: { per_page: limit, page, _embed: true, orderby: 'date', order: 'desc' },
      timeout: 15000,
    });

    const results = wpRes.data.map(post => ({
      id: post.id,
      title: cleanText(post.title?.rendered || ''),
      link: post.link,
      excerpt: cleanText(post.excerpt?.rendered || '').substring(0, 200),
      date: post.date,
      image:
        post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.medium?.source_url ||
        post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
        null,
    }));

    res.json({ success: true, page, count: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Root ────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  name: '🎮 OceanGames Scraper API',
  version: '2.0.0',
  by: 'Black Cat Studio',
  endpoints: {
    search:     { path: '/api/search?game=GAME_NAME',   example: '/api/search?game=gta+5' },
    data:       { path: '/api/data?game=GAME_URL',       example: '/api/data?game=https://oceantogames.com/dead-cells-v20260616-free-download/' },
    directlink: { path: '/api/directlink?game=GAME_URL', example: '/api/directlink?game=https://oceantogames.com/dead-cells-v20260616-free-download/' },
    latest:     { path: '/api/latest?page=1&limit=10',  example: '/api/latest?limit=5' },
  },
}));

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════╗`);
  console.log(`║  OceanGames API v2  — Port ${PORT}  ║`);
  console.log(`║  Black Cat Studio 🐱              ║`);
  console.log(`╚══════════════════════════════════╝`);
});

