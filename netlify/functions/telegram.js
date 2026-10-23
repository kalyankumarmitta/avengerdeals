// Telegram webhook — manual deal entry via labelled fields or legacy format.
// Accepts photo (caption) or text messages from the owner.
// Commits product image and deal data to the repo via the GitHub Contents API.
// Node 18+ only — no npm dependencies.

'use strict';

const DEALS_PATH   = 'data/deals.json';
const AMAZON_HOSTS = new Set(['amazon.in', 'www.amazon.in', 'amzn.in', 'amzn.to', 'a.co']);
const SHORT_HOSTS  = new Set(['amzn.in', 'amzn.to', 'a.co']);

// ── Security helpers ───────────────────────────────────────────────────────────

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Only accept https:// URLs to block javascript: and data: URIs.
function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' ? url : null;
  } catch {
    return null;
  }
}

// ── Amazon URL helpers ─────────────────────────────────────────────────────────

function isAmazonHost(hostname) {
  return AMAZON_HOSTS.has(hostname.toLowerCase());
}

// Follow redirects (short links: amzn.in, amzn.to, a.co) and return the final URL.
async function resolveUrl(url) {
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.url;
  } catch {
    return url;
  }
}

// Extract a 10-char ASIN from /dp/ASIN or /gp/product/ASIN path segments.
function extractAsin(url) {
  try {
    const pathname = new URL(url).pathname;
    const m = pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})/i);
    return m ? m[1].toUpperCase() : null;
  } catch {
    return null;
  }
}

// ── Text / field-parsing helpers ───────────────────────────────────────────────

function extractCategoryFromHashtag(text) {
  const m = text.match(/#([a-zA-Z]\w*)/);
  if (!m) return 'general';
  return m[1].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'general';
}

function stripHashtags(text) {
  return text.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();
}

// Normalise a category label: lowercase, trim, spaces → hyphens, strip non-alnum.
function normalizeCategory(cat) {
  if (!cat) return 'general';
  const n = cat.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-|-$/g, '');
  return n || 'general';
}

// Parse a message body.
// Labelled format (preferred):
//   Name: Stainless Steel Kettle
//   Price: ₹1,299
//   Category: Kitchen
//   Link: https://amzn.in/d/xxx
// Legacy fallback (no labels detected):
//   first line = Amazon URL, remaining lines = name, #hashtag = category
function parseMessageText(text) {
  if (!text || !text.trim()) return { name: null, price: null, category: null, link: null };

  const lines = text.split('\n').map(l => l.trim()).filter(l => l);

  const labelPattern = /^(name|price|category|link)\s*:/i;
  if (lines.some(l => labelPattern.test(l))) {
    const fields = {};
    for (const line of lines) {
      const m = line.match(/^(\w+)\s*:\s*([\s\S]+)$/i);
      if (m) fields[m[1].toLowerCase()] = m[2].trim();
    }
    return {
      name:     fields['name']     || null,
      price:    fields['price']    || null,
      category: fields['category'] || null,
      link:     fields['link']     || null,
    };
  }

  // Legacy: first non-empty line = link, rest = name, #hashtag = category
  const link     = lines[0] || null;
  const nameRaw  = lines.slice(1).join(' ').trim();
  const name     = nameRaw ? stripHashtags(nameRaw) || null : null;
  const category = extractCategoryFromHashtag(text);
  return { name, price: null, category, link };
}

// ── Telegram API helpers ───────────────────────────────────────────────────────

async function sendTelegramMessage(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !chatId) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (err) {
    console.error('Telegram send error:', err.message);
  }
}

// Returns the server-side file_path for a Telegram file_id.
async function getTelegramFilePath(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res   = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`);
  const data  = await res.json();
  if (!data.ok) throw new Error(`getFile: ${data.description}`);
  return data.result.file_path;
}

// Downloads a Telegram file by its file_path and returns a Buffer.
// The download URL contains the bot token; it is never stored or returned to clients.
async function downloadTelegramFile(filePath) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res   = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Photo download ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ── GitHub Contents API helpers ────────────────────────────────────────────────

// GET a file; returns { data, sha } or { data: null, sha: null } on 404.
async function ghGet(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  return { data, sha: data.sha };
}

// PUT (create or update) a file; content must be base64-encoded.
async function ghPut(url, headers, encodedContent, sha, commitMessage) {
  const body = { message: commitMessage, content: encodedContent };
  if (sha) body.sha = sha;
  const res = await fetch(url, {
    method:  'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub PUT ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function readDealsFile(url, headers) {
  const { data, sha } = await ghGet(url, headers);
  if (!data) return { deals: [], sha: null };
  const deals = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { deals, sha };
}

// ── Main handler ───────────────────────────────────────────────────────────────

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const secret = process.env.TELEGRAM_SECRET;
  if (secret && event.headers['x-telegram-bot-api-secret-token'] !== secret) {
    return { statusCode: 401, body: 'Unauthorized' };
  }

  let update;
  try {
    update = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: 'Bad Request' };
  }

  const message = update.message || update.channel_post;
  if (!message) return { statusCode: 200, body: 'OK' };

  // Accept only photo or text messages; ignore everything else (sticker, voice, …).
  const hasPhoto   = Array.isArray(message.photo) && message.photo.length > 0;
  const hasText    = typeof message.text === 'string';
  if (!hasPhoto && !hasText) return { statusCode: 200, body: 'OK' };

  const rawText = hasPhoto ? (message.caption || '') : message.text;

  // Owner check: ignore messages from anyone other than the configured owner.
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (ownerId && message.from && String(message.from.id) !== String(ownerId)) {
    return { statusCode: 200, body: 'OK' };
  }

  const ownerChatId = message.chat?.id;

  // Parse the message body.
  const parsed = parseMessageText(rawText);

  // Validate required fields.
  if (!parsed.name) {
    await sendTelegramMessage(ownerChatId,
      'Missing field: Name. Include "Name: Product Title" in your message.');
    return { statusCode: 200, body: 'OK' };
  }
  if (!parsed.link) {
    await sendTelegramMessage(ownerChatId,
      'Missing field: Link. Include "Link: https://amzn.in/..." in your message.');
    return { statusCode: 200, body: 'OK' };
  }

  // Validate Amazon-only link.
  const fullUrl = parsed.link.startsWith('http') ? parsed.link : `https://${parsed.link}`;
  let parsedHost;
  try {
    parsedHost = new URL(fullUrl).hostname.toLowerCase();
  } catch {
    await sendTelegramMessage(ownerChatId, 'Invalid link. Please use an Amazon URL.');
    return { statusCode: 200, body: 'OK' };
  }

  if (!isAmazonHost(parsedHost)) {
    await sendTelegramMessage(ownerChatId, 'Only Amazon links are supported.');
    return { statusCode: 200, body: 'OK' };
  }

  // Resolve short links and extract ASIN.
  const resolvedUrl = SHORT_HOSTS.has(parsedHost) ? await resolveUrl(fullUrl) : fullUrl;
  const asin        = extractAsin(resolvedUrl);

  if (!asin) {
    await sendTelegramMessage(ownerChatId,
      'Could not extract ASIN. Use a direct product page URL (/dp/ or /gp/product/).');
    return { statusCode: 200, body: 'OK' };
  }

  const amazonTag    = process.env.AMAZON_TAG || '';
  const affiliateUrl = `https://www.amazon.in/dp/${asin}${amazonTag ? `?tag=${amazonTag}` : ''}`;
  const date         = new Date().toISOString().slice(0, 10);
  const category     = normalizeCategory(parsed.category);
  const price        = parsed.price || null;

  // GitHub API setup.
  const repo      = process.env.GITHUB_REPO;
  const token     = process.env.GITHUB_TOKEN;
  const ghHeaders = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const repoBase = `https://api.github.com/repos/${repo}/contents`;

  // Download and commit product image if a photo was sent.
  let imagePath = '';
  if (hasPhoto) {
    try {
      const largestPhoto  = message.photo[message.photo.length - 1];
      const filePath      = await getTelegramFilePath(largestPhoto.file_id);
      const imageBuffer   = await downloadTelegramFile(filePath);
      const imageApiUrl   = `${repoBase}/images/${asin}.jpg`;
      const { sha: imgSha } = await ghGet(imageApiUrl, ghHeaders);
      await ghPut(imageApiUrl, ghHeaders, imageBuffer.toString('base64'), imgSha, `image: ${asin}`);
      imagePath = `images/${asin}.jpg`;
    } catch (err) {
      console.error('Photo save error:', err.message);
      await sendTelegramMessage(ownerChatId,
        `Warning: could not save photo — ${err.message}. Publishing without image.`);
    }
  }

  const newDeal = {
    asin,
    title:      parsed.name,
    image:      imagePath,
    price,
    priceAsOf:  price ? date : null,
    category,
    affiliateUrl,
    date,
  };

  // Update data/deals.json: remove existing entry for same ASIN, prepend new one.
  try {
    const dealsApiUrl = `${repoBase}/${DEALS_PATH}`;
    const { deals, sha } = await readDealsFile(dealsApiUrl, ghHeaders);
    const filtered = deals.filter(d => d.asin !== asin);
    filtered.unshift(newDeal);
    const encoded = Buffer.from(JSON.stringify(filtered, null, 2) + '\n').toString('base64');
    await ghPut(dealsApiUrl, ghHeaders, encoded, sha, `deal: ${asin} — ${parsed.name}`);
  } catch (err) {
    console.error('GitHub error:', err.message);
    await sendTelegramMessage(ownerChatId, `Error saving deal: ${err.message}`);
    return { statusCode: 500, body: 'Internal Server Error' };
  }

  const siteUrl = process.env.SITE_URL || 'https://avengerdeals.netlify.app';
  await sendTelegramMessage(ownerChatId, `Published: ${parsed.name} in ${category}\n${siteUrl}`);
  return { statusCode: 200, body: 'OK' };
};
