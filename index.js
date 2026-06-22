const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://oceantogames.com';

// ─── Headers to mimic a real browser ───────────────────────────────────────
const HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  Connection: 'keep-alive',
  'Upgrade-Insecure-Requests': '1',
};

// ─── Known direct-download hosting domains ──────────────────────────────────
const DL_HOSTS = [
  'mega.nz', 'mega.co.nz',
  'mediafire.com',
  'drive.google.com', 'docs.google.com',
  'pixeldrain.com',
  '1fichier.com',
  'uptobox.com',
  'dropapk.to',
  'clicknupload.co', 'clicknupload.to',
  'sendit.cloud',
  'datanodes.to',
  'buzzheavier.com',
  'gofile.io',
  'rapidgator.net',
  'uploaded.net',
  'mixdrop.ag',
  'streamlare.com',
  'torrent',
  'magnet:',
  'filecrypt.cc',
  'multiup.io',
  'userscloud.com',
  'hexupload.net',
  'anonfiles.com',
  'uploadhaven.com',
];

// ─── Helper: check if a URL is a download link ──────────────────────────────
function isDownloadUrl(href = '') {
  const h = href.toLowerCase();
  return DL_HOSTS.some((d) => h.includes(d));
}

// ─── Helper: clean HTML text ─────────────────────────────────────────────────
function cleanText(str = '') {
  return str.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/search?game=GAME_NAME
//  Uses WordPress REST API to search posts by title/content
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const gameName = (req.query.game || '').trim();
  if (!gameName) {
    return res.status(400).json({ success: false, error: '?game= parameter required' });
  }

  try {
    // WordPress REST API endpoint – searches both title & content
    const wpRes = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      headers: HEADERS,
      params: {
        search: gameName,
        per_page: 10,
        _fields: 'id,title,link,excerpt,date',
        _embed: 'wp:featuredmedia',
      },
      timeout: 15000,
    });

    if (!Array.isArray(wpRes.data) || wpRes.data.length === 0) {
      // Fallback: scrape the WordPress search page
      const searchPageRes = await axios.get(`${BASE_URL}/`, {
        headers: HEADERS,
        params: { s: gameName },
        timeout: 15000,
      });

      const $ = cheerio.load(searchPageRes.data);
      const fallbackResults = [];

      $('article, .post').each((i, el) => {
        const titleEl = $(el).find('h2 a, h1 a').first();
        const title = titleEl.text().trim();
        const link = titleEl.attr('href');
        const img =
          $(el).find('img').first().attr('src') ||
          $(el).find('img').first().attr('data-src') ||
          null;
        const excerpt = cleanText($(el).find('.entry-summary, .entry-excerpt, p').first().text());

        if (title && link) fallbackResults.push({ title, link, image: img, excerpt });
      });

      return res.json({
        success: true,
        count: fallbackResults.length,
        source: 'search-page-fallback',
        results: fallbackResults,
      });
    }

    // Parse WP REST API results
    const results = wpRes.data.map((post) => ({
      id: post.id,
      title: cleanText(post.title?.rendered || ''),
      link: post.link,
      excerpt: cleanText(post.excerpt?.rendered || ''),
      date: post.date,
      image:
        post._embedded?.['wp:featuredmedia']?.[0]?.source_url ||
        null,
    }));

    res.json({ success: true, count: results.length, source: 'wp-rest-api', results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/data?game=GAME_URL
//  Scrapes the game page and returns full details
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/data', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) {
    return res.status(400).json({ success: false, error: '?game= URL parameter required' });
  }

  try {
    const response = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(response.data);

    // ── Title ────────────────────────────────────────────────────────────
    const title =
      $('h1.entry-title').text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      'Unknown';

    // ── Thumbnail / Cover Image ──────────────────────────────────────────
    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('.entry-content img').first().attr('src') ||
      $('article img').first().attr('src') ||
      null;

    // ── Short description (from og:description) ──────────────────────────
    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') ||
      '';

    // ── Full overview text ───────────────────────────────────────────────
    const content = $('.entry-content');
    // Remove nav / related posts sections
    content.find('.related-posts, .sharedaddy, script, style').remove();

    const overview = cleanText(content.text())
      .split('Technical Specifications')[0]
      .replace(/Download Now/gi, '')
      .trim()
      .substring(0, 1200);

    // ── Technical specs from bold text or list items ─────────────────────
    const specs = {};
    const specPatterns = {
      version: /Game Version\s*[:=]\s*(.+)/i,
      size: /(?:Game\s+)?Download\s+Size\s*[:=]\s*(.+)/i,
      interfaceLanguage: /Interface Language\s*[:=]\s*(.+)/i,
      audioLanguage: /Audio Language\s*[:=]\s*(.+)/i,
      filename: /Game File Name\s*[:=]\s*(.+)/i,
      md5: /MD5SUM\s*[:=]\s*([a-fA-F0-9]{32})/i,
      repacker: /(?:Uploader|Re ?packer)\s*(?:Group)?\s*[:=]\s*(.+)/i,
    };

    content.find('li, p, strong, b').each((_, el) => {
      const text = $(el).text().replace(/\s+/g, ' ').trim();
      for (const [key, pattern] of Object.entries(specPatterns)) {
        if (!specs[key]) {
          const m = text.match(pattern);
          if (m) specs[key] = m[1].trim();
        }
      }
    });

    // ── System requirements ──────────────────────────────────────────────
    const minReqs = [];
    const recReqs = [];

    let inMinimum = false;
    let inRecommended = false;

    content.find('li, p').each((_, el) => {
      const text = $(el).text().trim();
      if (/minimum/i.test(text)) { inMinimum = true; inRecommended = false; return; }
      if (/recommended/i.test(text)) { inRecommended = true; inMinimum = false; return; }

      const fields = ['OS', 'Processor', 'Memory', 'Graphics', 'Storage', 'DirectX', 'Network', 'Additional'];
      if (fields.some(f => text.startsWith(f))) {
        if (inMinimum) minReqs.push(text);
        else if (inRecommended) recReqs.push(text);
      }
    });

    // ── Categories / genres ──────────────────────────────────────────────
    const categories = [];
    $('a[rel="category tag"], .cat-links a, .entry-categories a').each((_, el) => {
      const cat = $(el).text().trim();
      if (cat) categories.push(cat);
    });

    // ── All screenshots ──────────────────────────────────────────────────
    const screenshots = [];
    content.find('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && !src.includes('favicon') && !src.includes('logo')) {
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
      categories,
      systemRequirements: {
        minimum: minReqs,
        recommended: recReqs,
      },
      screenshots: [...new Set(screenshots)].slice(0, 10),
      sourceUrl: gameUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/directlink?game=GAME_URL
//  Scrapes the game page and extracts all direct download links
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/directlink', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) {
    return res.status(400).json({ success: false, error: '?game= URL parameter required' });
  }

  try {
    const response = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(response.data);

    const links = [];
    const seen = new Set();

    // ── Strategy 1: All <a> tags that point to DL hosts ──────────────────
    $('a').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      const text = $(el).text().trim() || 'Download';

      if (!href || href === '#' || seen.has(href)) return;

      if (isDownloadUrl(href)) {
        seen.add(href);
        links.push({ label: text, url: href, type: 'direct' });
      }
    });

    // ── Strategy 2: onclick handlers that open a URL ──────────────────────
    $('[onclick]').each((_, el) => {
      const onclick = $(el).attr('onclick') || '';
      const match = onclick.match(/(?:window\.open|location\.href)\s*=?\s*['"](.+?)['"]/);
      if (match) {
        const href = match[1];
        if (!seen.has(href)) {
          seen.add(href);
          links.push({ label: $(el).text().trim() || 'Download', url: href, type: 'onclick' });
        }
      }
    });

    // ── Strategy 3: Look for redirect / shortener wrappers ────────────────
    $('a').each((_, el) => {
      const href = ($(el).attr('href') || '').trim();
      const text = $(el).text().trim().toLowerCase();

      if (!href || href === '#' || seen.has(href)) return;
      if (href.startsWith(BASE_URL)) return; // internal link

      const dlKeywords = ['download', 'click here', 'get game', 'direct link',
                          'link 1', 'link 2', 'link 3', 'part 1', 'part 2', 'part 3',
                          'google drive', 'mega', 'mediafire', 'torrent'];

      if (dlKeywords.some(k => text.includes(k))) {
        seen.add(href);
        links.push({ label: $(el).text().trim(), url: href, type: 'keyword-match' });
      }
    });

    // ── Strategy 4: Find data-href / data-url attributes ─────────────────
    $('[data-href], [data-url], [data-link]').each((_, el) => {
      const href = $(el).attr('data-href') || $(el).attr('data-url') || $(el).attr('data-link');
      if (href && !seen.has(href)) {
        seen.add(href);
        links.push({ label: $(el).text().trim() || 'Download', url: href, type: 'data-attr' });
      }
    });

    // ── Strategy 5: iframes (some sites embed download in iframe) ─────────
    $('iframe').each((_, el) => {
      const src = $(el).attr('src');
      if (src && !seen.has(src)) {
        seen.add(src);
        links.push({ label: 'Embedded Frame', url: src, type: 'iframe' });
      }
    });

    if (links.length === 0) {
      return res.json({
        success: true,
        count: 0,
        message: 'No direct download links found. The links may be loaded via JavaScript. Try visiting the page manually.',
        links: [],
        sourceUrl: gameUrl,
      });
    }

    res.json({
      success: true,
      count: links.length,
      links,
      sourceUrl: gameUrl,
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/latest  – Latest games from IPC Games category
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/latest', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 10, 50);

  try {
    const wpRes = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      headers: HEADERS,
      params: {
        categories_exclude: '',   // all categories
        per_page: limit,
        page,
        _fields: 'id,title,link,excerpt,date',
        _embed: 'wp:featuredmedia',
        orderby: 'date',
        order: 'desc',
      },
      timeout: 15000,
    });

    const results = wpRes.data.map((post) => ({
      id: post.id,
      title: cleanText(post.title?.rendered || ''),
      link: post.link,
      excerpt: cleanText(post.excerpt?.rendered || ''),
      date: post.date,
      image: post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
    }));

    res.json({ success: true, page, count: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  Root – API docs
// ═══════════════════════════════════════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    name: '🎮 OceanGames Scraper API',
    version: '1.0.0',
    by: 'Black Cat Studio',
    endpoints: {
      search: {
        path: '/api/search?game=GAME_NAME',
        description: 'Search for games by name',
        example: '/api/search?game=gta+5',
      },
      data: {
        path: '/api/data?game=GAME_URL',
        description: 'Get full details of a game by its page URL',
        example: '/api/data?game=https://oceantogames.com/dead-cells-v20260616-free-download/',
      },
      directlink: {
        path: '/api/directlink?game=GAME_URL',
        description: 'Extract direct download links from a game page',
        example: '/api/directlink?game=https://oceantogames.com/dead-cells-v20260616-free-download/',
      },
      latest: {
        path: '/api/latest?page=1&limit=10',
        description: 'Get the latest games',
        example: '/api/latest?page=1&limit=5',
      },
    },
  });
});

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════╗`);
  console.log(`║   OceanGames API  — Port ${PORT}    ║`);
  console.log(`║   Black Cat Studio 🐱             ║`);
  console.log(`╚══════════════════════════════════╝`);
});

