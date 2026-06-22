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

function extractSpec(text, pattern) {
  const m = text.match(pattern);
  if (!m) return undefined;
  return m[1].replace(/\*+/g, '').replace(/\[.*?\]/g, '').trim();
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 1: Extract script URL from game page
//  Finds: <script src="https://cjeriwek.cfd/?h=HASH&vis=ID">
// ═══════════════════════════════════════════════════════════════════════════
async function extractScriptUrl(gamePageHtml) {
  // Match the external button script
  const match = gamePageHtml.match(
    /src=['"]?(https?:\/\/[^'">\s]+\?h=[^'">\s]+&vis=\d+)['"]?/i
  );
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 2: Fetch button script → get redirect URL (tredjsc.it.com)
//  Script sets: var oldurl = 'https://tredjsc.it.com/?v=ID&s=BASE64'
// ═══════════════════════════════════════════════════════════════════════════
async function extractRedirectUrl(scriptUrl) {
  const res = await axios.get(scriptUrl, { headers: HEADERS, timeout: 10000 });
  const js = res.data;

  // Extract oldurl
  const match = js.match(/var\s+oldurl\s*=\s*['"]([^'"]+)['"]/);
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 3: Fetch redirect page → get final URL (dfbhve.it.com)
//  Page has: window.location.href = 'https://dfbhve.it.com/?suv=...'
// ═══════════════════════════════════════════════════════════════════════════
async function extractFinalUrl(redirectUrl) {
  const res = await axios.get(redirectUrl, { headers: HEADERS, timeout: 10000 });
  const html = res.data;

  // Match finalRedirectURL or window.location.href
  const match = html.match(
    /(?:finalRedirectURL|window\.location\.href)\s*=\s*['"]([^'"]+)['"]/
  );
  return match ? match[1] : null;
}

// ═══════════════════════════════════════════════════════════════════════════
//  STEP 4: Fetch final page → extract real download links
//  Page has: <input ... value="https://www.mediafire.com/...">
//            or <a href="https://mega.nz/...">
// ═══════════════════════════════════════════════════════════════════════════
async function extractDownloadLinks(finalUrl) {
  const res = await axios.get(finalUrl, { headers: HEADERS, timeout: 10000 });
  const html = res.data;
  const $ = cheerio.load(html);
  const links = [];
  const seen = new Set();

  const addLink = (url, label, type) => {
    url = (url || '').trim().replace(/&amp;/g, '&');
    if (!url || seen.has(url)) return;
    if (!isDownloadUrl(url)) return;
    seen.add(url);
    links.push({ label: (label || 'Download').trim(), url, type });
  };

  // Input fields with download URLs (most common pattern)
  $('input[type="text"], input[readonly]').each((_, el) => {
    const val = $(el).val() || $(el).attr('value') || '';
    if (isDownloadUrl(val)) {
      addLink(val, 'Direct Link', 'input');
    }
  });

  // Anchor tags
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (isDownloadUrl(href)) {
      addLink(href, $(el).text() || 'Download', 'anchor');
    }
  });

  // Regex scan entire HTML for DL host URLs
  const dlHostRx = /https?:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz|mediafire\.com|drive\.google\.com|pixeldrain\.com|1fichier\.com|gofile\.io|buzzheavier\.com|datanodes\.to|clicknupload\.co|clicknupload\.to|sendit\.cloud|rapidgator\.net|uploaded\.net|filecrypt\.cc|multiup\.io|hexupload\.net|dropapk\.to|uptobox\.com|mixdrop\.ag)[^\s"'`<>\)\]\\]+/gi;
  let m;
  while ((m = dlHostRx.exec(html)) !== null) {
    addLink(m[0].replace(/[.,;]+$/, ''), 'Auto-detected', 'regex');
  }

  return links;
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/directlink?game=GAME_URL
//  Full 4-step chain resolver
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/directlink', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) return res.status(400).json({ success: false, error: '?game= URL required' });

  const chain = { gameUrl };

  try {
    // ── Step 1: Fetch game page ──────────────────────────────────────────
    const pageRes = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const gameHtml = pageRes.data;

    // ── Step 2: Extract button script URL ───────────────────────────────
    const scriptUrl = await extractScriptUrl(gameHtml);
    if (!scriptUrl) {
      return res.json({
        success: false,
        error: 'Button script URL not found in page',
        chain,
      });
    }
    chain.scriptUrl = scriptUrl;

    // ── Step 3: Fetch script → get redirect URL ──────────────────────────
    const redirectUrl = await extractRedirectUrl(scriptUrl);
    if (!redirectUrl) {
      return res.json({
        success: false,
        error: 'Redirect URL not found in button script',
        chain,
      });
    }
    chain.redirectUrl = redirectUrl;

    // ── Step 4: Fetch redirect page → get final URL ──────────────────────
    const finalUrl = await extractFinalUrl(redirectUrl);
    if (!finalUrl) {
      return res.json({
        success: false,
        error: 'Final URL not found in redirect page',
        chain,
      });
    }
    chain.finalUrl = finalUrl;

    // ── Step 5: Fetch final page → extract real download links ───────────
    const links = await extractDownloadLinks(finalUrl);

    return res.json({
      success: true,
      count: links.length,
      chain,
      links,
      sourceUrl: gameUrl,
    });

  } catch (err) {
    return res.status(500).json({
      success: false,
      error: err.message,
      chain,
    });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/search?game=GAME_NAME
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/search', async (req, res) => {
  const gameName = (req.query.game || '').trim();
  if (!gameName) return res.status(400).json({ success: false, error: '?game= required' });

  try {
    const wpRes = await axios.get(`${BASE_URL}/wp-json/wp/v2/posts`, {
      headers: HEADERS,
      params: { search: gameName, per_page: 10, _embed: true, orderby: 'relevance' },
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
        post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
    }));

    return res.json({ success: true, count: results.length, source: 'wp-rest-api', results });
  } catch (err) {
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
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/data', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) return res.status(400).json({ success: false, error: '?game= URL required' });

  try {
    const response = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const $ = cheerio.load(response.data);

    const title =
      $('h1.entry-title').text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') || 'Unknown';

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('article img').first().attr('src') || null;

    const description =
      $('meta[property="og:description"]').attr('content') ||
      $('meta[name="description"]').attr('content') || '';

    $('nav, header nav, footer, .related-posts, .sharedaddy, script, style, noscript, .sidebar').remove();
    const rawText = $('body').text().replace(/\s+/g, ' ').replace(/\*/g, '').trim();

    let overview = '';
    const ovMatch = rawText.match(/Overview\s+(.{80,}?)(?=Technical Specifications|Mature Content Description|System Requirements|Before you start)/i);
    overview = ovMatch ? ovMatch[1].trim().substring(0, 1500) : description.substring(0, 800);

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

    const categories = [];
    $('a[rel="category tag"]').each((_, el) => {
      const cat = $(el).text().trim();
      if (cat && !categories.includes(cat)) categories.push(cat);
    });

    let minReqs = [], recReqs = [];
    const minBlock = rawText.match(/Minimum:\s*(.+?)(?=Recommended:|Click on the|Free Download$)/i);
    const recBlock = rawText.match(/Recommended:\s*(.+?)(?=Free Download|Click on the|$)/i);
    const parseReqBlock = (block) =>
      block.split(/(?=OS|Processor|Memory|Graphics|Storage|DirectX|Network|Additional|Sound)/i)
        .map(s => s.trim()).filter(s => s.length > 3);
    if (minBlock) minReqs = parseReqBlock(minBlock[1]);
    if (recBlock) recReqs = parseReqBlock(recBlock[1]);

    const screenshots = [];
    $('article img, .entry-content img, .post img, #content img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
      if (src && !src.includes('favicon') && !src.includes('logo') && !src.includes('-120x120'))
        screenshots.push(src);
    });

    res.json({
      success: true, title, image, description, overview, specs,
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
        post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
    }));

    res.json({ success: true, page, count: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Root ────────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  name: '🎮 OceanGames Scraper API',
  version: '3.0.0',
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
  console.log(`║  OceanGames API v3  — Port ${PORT}  ║`);
  console.log(`║  Black Cat Studio 🐱              ║`);
  console.log(`╚══════════════════════════════════╝`);
});

