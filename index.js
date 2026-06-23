const express = require('express');
const axios   = require('axios');
const cheerio = require('cheerio');
const CryptoJS = require('crypto-js');

const app  = express();
const PORT = process.env.PORT || 3000;
const BASE_URL = 'https://oceantogames.com';

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.5',
  'Connection': 'keep-alive',
};

const DL_HOSTS = [
  'mega.nz','mega.co.nz','mediafire.com','drive.google.com',
  'pixeldrain.com','1fichier.com','uptobox.com','dropapk.to',
  'clicknupload.co','clicknupload.to','sendit.cloud','datanodes.to',
  'buzzheavier.com','gofile.io','rapidgator.net','uploaded.net',
  'filecrypt.cc','multiup.io','hexupload.net','anonfiles.com',
  'uploadhaven.com','mixdrop.ag','streamlare.com',
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
//  CryptoJS AES-JSON decrypt (same as browser)
// ═══════════════════════════════════════════════════════════════════════════
function cryptoJsAesDecrypt(jsonData, passphrase) {
  try {
    const obj = typeof jsonData === 'string' ? JSON.parse(jsonData) : jsonData;
    const ct = CryptoJS.lib.CipherParams.create({
      ciphertext: CryptoJS.enc.Base64.parse(obj.ct),
    });
    if (obj.iv) ct.iv = CryptoJS.enc.Hex.parse(obj.iv);
    if (obj.s)  ct.salt = CryptoJS.enc.Hex.parse(obj.s);
    const decrypted = CryptoJS.AES.decrypt(ct, passphrase);
    return decrypted.toString(CryptoJS.enc.Utf8);
  } catch (e) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
//  Extract download links from final page (dfbhve.it.com or wickradio)
// ═══════════════════════════════════════════════════════════════════════════
function extractLinksFromHtml(html) {
  const $ = cheerio.load(html);
  const links = [];
  const seen  = new Set();

  const addLink = (url, label, type) => {
    url = (url || '').trim().replace(/&amp;/g, '&');
    if (!url || seen.has(url)) return;
    if (!isDownloadUrl(url)) return;
    seen.add(url);
    links.push({ label: (label || 'Download').trim(), url, type });
  };

  // Input fields
  $('input[type="text"], input[readonly], input').each((_, el) => {
    const val = $(el).val() || $(el).attr('value') || '';
    if (isDownloadUrl(val)) addLink(val, 'Direct Link', 'input');
  });

  // Anchors
  $('a').each((_, el) => {
    const href = $(el).attr('href') || '';
    if (isDownloadUrl(href)) addLink(href, $(el).text() || 'Download', 'anchor');
  });

  // Regex scan
  const dlRx = /https?:\/\/(?:www\.)?(?:mega\.nz|mega\.co\.nz|mediafire\.com|drive\.google\.com|pixeldrain\.com|1fichier\.com|gofile\.io|buzzheavier\.com|datanodes\.to|clicknupload\.co|clicknupload\.to|sendit\.cloud|rapidgator\.net|uploaded\.net|filecrypt\.cc|multiup\.io|hexupload\.net|dropapk\.to|uptobox\.com|mixdrop\.ag)[^\s"'`<>)\]\\]+/gi;
  let m;
  while ((m = dlRx.exec(html)) !== null) {
    const candidate = m[0].replace(/[.,;)]+$/, '');
    const alreadyCovered = [...seen].some(s => s.startsWith(candidate) || candidate.startsWith(s));
    if (!alreadyCovered) addLink(candidate, 'Auto-detected', 'regex');
  }

  return links;
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHAIN STEP 1-4: cjeriwek → tredjsc → dfbhve
// ═══════════════════════════════════════════════════════════════════════════
async function resolveChain1(gameHtml) {
  const scriptMatch = gameHtml.match(
    /src=['"]?(https?:\/\/[^'">\s]+\?h=[^'">\s]+&vis=\d+)['"]?/i
  );
  if (!scriptMatch) return null;
  const scriptUrl = scriptMatch[1];

  const scriptRes = await axios.get(scriptUrl, { headers: HEADERS, timeout: 10000 });
  const oldUrlMatch = scriptRes.data.match(/var\s+oldurl\s*=\s*['"]([^'"]+)['"]/);
  if (!oldUrlMatch) return null;
  const redirectUrl = oldUrlMatch[1];

  const redirectRes = await axios.get(redirectUrl, { headers: HEADERS, timeout: 10000 });
  const finalMatch = redirectRes.data.match(
    /(?:finalRedirectURL|window\.location\.href)\s*=\s*['"]([^'"]+)['"]/
  );
  if (!finalMatch) return null;
  const finalUrl = finalMatch[1];

  const finalRes = await axios.get(finalUrl, { headers: HEADERS, timeout: 10000 });
  const links = extractLinksFromHtml(finalRes.data);

  return { scriptUrl, redirectUrl, finalUrl, links };
}

// ═══════════════════════════════════════════════════════════════════════════
//  CHAIN STEP A-D: oceantogames wait-form → wickradio → AES decrypt
// ═══════════════════════════════════════════════════════════════════════════
async function resolveChain2(gameHtml) {
  // Extract wait-for-resource form values
  // Malformed HTML fix — grab 800 chars from wait-for-resource
  const formStart = gameHtml.indexOf('wait-for-resource');
  if (formStart < 0) return null;
  const formHtml = gameHtml.substring(formStart, formStart + 800);
  const getValue = (name) => {
    // name="X" ... value="Y" pattern
    let m = formHtml.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"'>]+)["']`, 'i'));
    if (m) return m[1];
    // value="Y" ... name="X" pattern  
    m = formHtml.match(new RegExp(`value=["']([^"'>]+)["'][^>]*name=["']${name}["']`, 'i'));
    if (m) return m[1];
    // name="X" then value="Y" on next attribute anywhere nearby
    m = formHtml.match(new RegExp(`name=["']${name}["'][\s\S]{0,50}?value=["']([^"'>]+)["']`, 'i'));
    return m ? m[1] : '';
  };

  const id       = getValue('id');
  const filename = getValue('filename');
  const filesize = getValue('filesize');

  if (!id || !filename) return null;

  // POST to wait-for-resource
  const waitRes = await axios.post(
    `${BASE_URL}/wait-for-resource/`,
    new URLSearchParams({ id, filename, filesize }).toString(),
    { headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000 }
  );
  const waitHtml = waitRes.data;

  // Extract wickradio form values
  const wickMatch = waitHtml.match(
    /<form[^>]*wickradio[^>]*>([\s\S]*?)<\/form>/i
  );
  if (!wickMatch) return null;

  const wickHtml = wickMatch[1];
  const getWickValue = (name) => {
    const m = wickHtml.match(new RegExp(`name=["']${name}["'][^>]*value=["']([^"']+)["']`, 'i'))
           || wickHtml.match(new RegExp(`value=["']([^"']+)["'][^>]*name=["']${name}["']`, 'i'));
    return m ? m[1] : '';
  };

  const w_id       = getWickValue('id')       || id;
  const w_filename = getWickValue('filename') || filename;
  const w_filesize = getWickValue('filesize') || filesize;

  // POST to wickradio
  const wickRes = await axios.post(
    'https://wickradio.com/Please-Wait.php',
    new URLSearchParams({ id: w_id, filename: w_filename, filesize: w_filesize }).toString(),
    { headers: { ...HEADERS, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': BASE_URL }, timeout: 15000 }
  );
  const wickPage = wickRes.data;

  // Extract encrypted data + key
  const encMatch  = wickPage.match(/hgeyioahwuk\s*=\s*'(\{[^']+\})'/);
  const keyMatch  = wickPage.match(/vexgoijaada\s*=\s*'([^']+)'/);

  if (!encMatch || !keyMatch) return null;

  const encData   = encMatch[1];
  const passphrase = keyMatch[1];

  // Decrypt with CryptoJS
  const decrypted = cryptoJsAesDecrypt(encData, passphrase);
  if (!decrypted) return null;

  // decrypted should be a URL
  const links = [];
  if (isDownloadUrl(decrypted)) {
    links.push({ label: 'Decrypted Link', url: decrypted, type: 'aes-decrypt' });
  } else {
    // Maybe it's JSON or HTML with links
    const extraLinks = extractLinksFromHtml(decrypted);
    links.push(...extraLinks);
  }

  return {
    formData: { id, filename, filesize },
    wickradioUrl: 'https://wickradio.com/Please-Wait.php',
    encryptedData: encData.substring(0, 50) + '...',
    passphrase,
    decrypted,
    links,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/directlink?game=GAME_URL  (tries BOTH chains)
// ═══════════════════════════════════════════════════════════════════════════
app.get('/api/directlink', async (req, res) => {
  const gameUrl = (req.query.game || '').trim();
  if (!gameUrl) return res.status(400).json({ success: false, error: '?game= URL required' });

  try {
    const pageRes  = await axios.get(gameUrl, { headers: HEADERS, timeout: 20000 });
    const gameHtml = pageRes.data;

    // Run both chains in parallel
    const [chain1Result, chain2Result] = await Promise.allSettled([
      resolveChain1(gameHtml),
      resolveChain2(gameHtml),
    ]);

    const c1 = chain1Result.status === 'fulfilled' ? chain1Result.value : null;
    const c2 = chain2Result.status === 'fulfilled' ? chain2Result.value : null;

    // Merge all links
    const allLinks = [
      ...(c1?.links || []),
      ...(c2?.links || []),
    ];

    // Deduplicate
    const seen = new Set();
    const links = allLinks.filter(l => {
      if (seen.has(l.url)) return false;
      seen.add(l.url);
      return true;
    });

    return res.json({
      success: true,
      count: links.length,
      chain1: c1 ? { scriptUrl: c1.scriptUrl, redirectUrl: c1.redirectUrl, finalUrl: c1.finalUrl } : null,
      chain2: c2 ? { formData: c2.formData, passphrase: c2.passphrase, decrypted: c2.decrypted } : null,
      links,
      sourceUrl: gameUrl,
    });

  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
//  GET /api/search
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
      id:      post.id,
      title:   cleanText(post.title?.rendered || ''),
      link:    post.link,
      excerpt: cleanText(post.excerpt?.rendered || '').substring(0, 200),
      date:    post.date,
      image:   post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.medium?.source_url
            || post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
    }));
    return res.json({ success: true, count: results.length, source: 'wp-rest-api', results });
  } catch (err) {
    try {
      const html = await axios.get(`${BASE_URL}/`, { headers: HEADERS, params: { s: gameName }, timeout: 15000 });
      const $ = cheerio.load(html.data);
      const results = [];
      $('article, .post').each((_, el) => {
        const a = $(el).find('h2 a, h1 a').first();
        const title = a.text().trim();
        const link  = a.attr('href');
        const img   = $(el).find('img').first().attr('src') || null;
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
//  GET /api/data
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
    const ver = sv(/Game Version\s*[:\s]+([v\d.]+)/i);         if (ver) specs.version = ver;
    const sz  = sv(/(?:Game\s+)?Download\s+Size\s*[:\s]+([\d.]+ ?(?:GB|MB|TB))/i); if (sz)  specs.size = sz;
    const iL  = sv(/Interface Language\s*[:\s]+([A-Za-z, /]+?)(?= Audio| Game| MD5|$)/i); if (iL)  specs.interfaceLanguage = iL.trim();
    const aL  = sv(/Audio Language\s*[:\s]+([A-Za-z, /]+?)(?= Interface| Game| MD5|$)/i);  if (aL)  specs.audioLanguage = aL.trim();
    const fn  = sv(/Game File Name\s*[:\s]+([^\s[\]]+\.(?:zip|rar|iso|exe))/i);            if (fn)  specs.filename = fn;
    const md5 = sv(/MD5SUM\s*[:\s]+([a-fA-F0-9]{32})/i);      if (md5) specs.md5 = md5;

    const categories = [];
    $('a[rel="category tag"]').each((_, el) => {
      const cat = $(el).text().trim();
      if (cat && !categories.includes(cat)) categories.push(cat);
    });

    let minReqs = [], recReqs = [];
    const minBlock = rawText.match(/Minimum:\s*(.+?)(?=Recommended:|Click on the|Free Download$)/i);
    const recBlock = rawText.match(/Recommended:\s*(.+?)(?=Free Download|Click on the|$)/i);
    const parseReq = (b) => b.split(/(?=OS|Processor|Memory|Graphics|Storage|DirectX|Network|Additional|Sound)/i).map(s => s.trim()).filter(s => s.length > 3);
    if (minBlock) minReqs = parseReq(minBlock[1]);
    if (recBlock) recReqs = parseReq(recBlock[1]);

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
      id:      post.id,
      title:   cleanText(post.title?.rendered || ''),
      link:    post.link,
      excerpt: cleanText(post.excerpt?.rendered || '').substring(0, 200),
      date:    post.date,
      image:   post._embedded?.['wp:featuredmedia']?.[0]?.media_details?.sizes?.medium?.source_url
            || post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
    }));
    res.json({ success: true, page, count: results.length, results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Root ───────────────────────────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  name: '🎮 OceanGames Scraper API',
  version: '4.0.0',
  by: 'Black Cat Studio 🐱',
  endpoints: {
    search:     '/api/search?game=GAME_NAME',
    data:       '/api/data?game=GAME_URL',
    directlink: '/api/directlink?game=GAME_URL',
    latest:     '/api/latest?page=1&limit=10',
  },
}));

app.listen(PORT, () => {
  console.log(`╔══════════════════════════════════╗`);
  console.log(`║  OceanGames API v4  — Port ${PORT}  ║`);
  console.log(`║  Black Cat Studio 🐱              ║`);
  console.log(`╚══════════════════════════════════╝`);
});
