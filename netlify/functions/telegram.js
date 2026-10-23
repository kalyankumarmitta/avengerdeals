// Telegram webhook — manual deal entry via labelled caption fields.
// Accepts photo + caption from the owner only.
// Commits product image and deal data to the repo via the GitHub Contents API.
// Node 18+ only — no npm dependencies.

'use strict';

const DEALS_PATH   = 'data/deals.json';
const AMAZON_HOSTS = new Set(['amazon.in', 'www.amazon.in', 'amzn.in', 'amzn.to', 'a.co', 'link.amazon', 'link.amazon.in']);

// ── Security helpers ───────────────────────────────────────────────────────────

// Only accept https:// URLs.
function safeHttpsUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url.startsWith('http') ? url : `https://${url}`);
    return u.protocol === 'https:' ? u.href : null;
  } catch {
    return null;
  }
}

// ── Text helpers ───────────────────────────────────────────────────────────────

// slug: lowercase, non-alphanumeric → hyphen, max 60 chars.
function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

// category: lowercase, trim, spaces → hyphens, strip special chars.
function normalizeCategory(cat) {
  if (!cat) return 'general';
  const n = cat.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-|-$/g, '');
  return n || 'general';
}

// Parse labelled fields from a caption or text body.
// Recognised keys (case-insensitive): Name, Price, Category, Affiliate Link, Link.
function parseFields(text) {
  const fields = {};
  if (!text) return fields;
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z](?:[a-zA-Z ]*[a-zA-Z])?)\s*:\s*(.+)$/);
    if (m) fields[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return {
    name:     fields['name']              || null,
    price:    fields['price']             || null,
    category: fields['category']          || null,
    link:     fields['affiliate link'] || fields['link'] || null,
  };
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
  const res   = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile: ${data.description}`);
  return data.result.file_path;
}

// Downloads a Telegram file and returns a Buffer.
// The download URL contains the bot token and is used only inside this function.
// It is never written to any committed file or returned in any response.
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

// PUT (create or update) a file; content must already be base64-encoded.
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

  // Accept only photo or text messages; silently ignore everything else.
  const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
  const hasText  = typeof message.text === 'string';
  if (!hasPhoto && !hasText) return { statusCode: 200, body: 'OK' };

  // Owner check: ignore messages from anyone other than the configured owner.
  const ownerId = process.env.OWNER_TELEGRAM_ID;
  if (ownerId && message.from && String(message.from.id) !== String(ownerId)) {
    return { statusCode: 200, body: 'OK' };
  }

  const ownerChatId = message.chat?.id;
  const rawText     = hasPhoto ? (message.caption || '') : (message.text || '');

  // Parse labelled fields.
  const fields = parseFields(rawText);

  // Validate required fields.
  const missing = [];
  if (!fields.name) missing.push('Name');
  if (!fields.link) missing.push('Affiliate Link');
  if (!hasPhoto)    missing.push('photo');

  if (missing.length > 0) {
    await sendTelegramMessage(ownerChatId, `Missing: ${missing.join(', ')}.`);
    return { statusCode: 200, body: 'OK' };
  }

  // Validate Amazon link — accept only the listed domains; do not modify the link.
  const affiliateUrl = safeHttpsUrl(fields.link);
  if (!affiliateUrl) {
    await sendTelegramMessage(ownerChatId, 'Invalid link. Please use a valid https:// Amazon URL.');
    return { statusCode: 200, body: 'OK' };
  }
  let parsedHost;
  try {
    parsedHost = new URL(affiliateUrl).hostname.toLowerCase();
  } catch {
    await sendTelegramMessage(ownerChatId, 'Invalid link URL.');
    return { statusCode: 200, body: 'OK' };
  }
  if (!AMAZON_HOSTS.has(parsedHost)) {
    await sendTelegramMessage(ownerChatId, 'Only Amazon affiliate links are supported.');
    return { statusCode: 200, body: 'OK' };
  }

  const slug     = slugify(fields.name);
  const category = normalizeCategory(fields.category);
  const date     = new Date().toISOString().slice(0, 10);

  // GitHub API setup.
  const repo      = process.env.GITHUB_REPO;
  const token     = process.env.GITHUB_TOKEN;
  const ghHeaders = {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const repoBase = `https://api.github.com/repos/${repo}/contents`;

  // Download and commit product image (photo is required, so hasPhoto is always true here).
  let imagePath = '';
  try {
    const largestPhoto    = message.photo[message.photo.length - 1];
    const filePath        = await getTelegramFilePath(largestPhoto.file_id);
    const imageBuffer     = await downloadTelegramFile(filePath);
    const imageApiUrl     = `${repoBase}/images/${slug}.jpg`;
    const { sha: imgSha } = await ghGet(imageApiUrl, ghHeaders);
    await ghPut(imageApiUrl, ghHeaders, imageBuffer.toString('base64'), imgSha, `image: ${slug}`);
    imagePath = `images/${slug}.jpg`;
  } catch (err) {
    console.error('Photo save error:', err.message);
    await sendTelegramMessage(ownerChatId, `Error saving photo: ${err.message}`);
    return { statusCode: 500, body: 'Internal Server Error' };
  }

  const newDeal = {
    id:          slug,
    title:       fields.name,
    image:       imagePath,
    price:       fields.price || null,
    category,
    affiliateUrl,
    date,
  };

  // Save to data/deals.json — deduplicate by id, newest first.
  try {
    const dealsApiUrl = `${repoBase}/${DEALS_PATH}`;
    const { deals, sha } = await readDealsFile(dealsApiUrl, ghHeaders);
    const filtered = deals.filter(d => d.id !== slug);
    filtered.unshift(newDeal);
    const encoded = Buffer.from(JSON.stringify(filtered, null, 2) + '\n').toString('base64');
    await ghPut(dealsApiUrl, ghHeaders, encoded, sha, `deal: ${slug} — ${fields.name}`);
  } catch (err) {
    console.error('GitHub error:', err.message);
    await sendTelegramMessage(ownerChatId, `Error saving deal: ${err.message}`);
    return { statusCode: 500, body: 'Internal Server Error' };
  }

  const displayCategory = category.charAt(0).toUpperCase() + category.slice(1);
  const siteUrl = process.env.SITE_URL || 'https://avengerdeals.netlify.app';
  await sendTelegramMessage(ownerChatId, `Published: ${fields.name} in ${displayCategory}\n${siteUrl}`);
  return { statusCode: 200, body: 'OK' };
};
