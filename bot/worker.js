// Cloudflare Worker — Telegram bot for deal entry.
// Set these secrets in the Cloudflare dashboard (Workers > Settings > Variables):
//   TELEGRAM_BOT_TOKEN        — bot token from @BotFather
//   OWNER_TELEGRAM_ID         — numeric Telegram user ID of the owner
//   GITHUB_TOKEN              — fine-grained PAT with repo contents write access
//   GITHUB_REPO               — "owner/repo" e.g. "acme/deals"
//   TELEGRAM_WEBHOOK_SECRET   — secret token set when registering the webhook

'use strict';

const DEALS_PATH   = 'data/deals.json';
const AMAZON_HOSTS = new Set([
  'amazon.in', 'www.amazon.in', 'amzn.in', 'amzn.to', 'a.co',
  'link.amazon', 'link.amazon.in',
]);

// ── Encoding helpers ───────────────────────────────────────────────────────────

function base64Encode(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function base64EncodeBytes(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function base64Decode(b64) {
  return decodeURIComponent(escape(atob(b64)));
}

// ── Security helpers ───────────────────────────────────────────────────────────

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

function slugify(name) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60);
}

function normalizeCategory(cat) {
  if (!cat) return 'general';
  const n = cat.toLowerCase().trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-|-$/g, '');
  return n || 'general';
}

function parseFields(text) {
  const fields = {};
  if (!text) return fields;
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-zA-Z](?:[a-zA-Z ]*[a-zA-Z])?)\s*:\s*(.+)$/);
    if (m) fields[m[1].toLowerCase().trim()] = m[2].trim();
  }
  return {
    name:     fields['name']                          || null,
    price:    fields['price']                         || null,
    category: fields['category']                      || null,
    link:     fields['affiliate link'] || fields['link'] || null,
  };
}

// ── Telegram API helpers ───────────────────────────────────────────────────────

async function sendTelegramMessage(chatId, text, token) {
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

async function getTelegramFilePath(fileId, token) {
  const res  = await fetch(
    `https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`,
  );
  const data = await res.json();
  if (!data.ok) throw new Error(`getFile: ${data.description}`);
  return data.result.file_path;
}

async function downloadTelegramFile(filePath, token) {
  const res = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!res.ok) throw new Error(`Photo download ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

// ── GitHub Contents API helpers ────────────────────────────────────────────────

function ghHeaders(token) {
  return {
    Authorization:          `Bearer ${token}`,
    Accept:                 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
}

async function ghGet(url, headers) {
  const res = await fetch(url, { headers });
  if (res.status === 404) return { data: null, sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  return { data, sha: data.sha };
}

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

async function ghDelete(url, headers, sha, commitMessage) {
  const res = await fetch(url, {
    method:  'DELETE',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body:    JSON.stringify({ message: commitMessage, sha }),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`GitHub DELETE ${res.status}: ${errText.slice(0, 200)}`);
  }
  return res.json();
}

async function readDealsFile(url, headers) {
  const { data, sha } = await ghGet(url, headers);
  if (!data) return { deals: [], sha: null };
  const deals = JSON.parse(base64Decode(data.content.replace(/\n/g, '')));
  return { deals, sha };
}

// ── Main handler ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') {
      return new Response('Method Not Allowed', { status: 405 });
    }

    const secret = env.TELEGRAM_WEBHOOK_SECRET;
    if (secret && request.headers.get('x-telegram-bot-api-secret-token') !== secret) {
      return new Response('Unauthorized', { status: 401 });
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return new Response('Bad Request', { status: 400 });
    }

    const message = update.message || update.channel_post;
    if (!message) return new Response('OK', { status: 200 });

    const hasPhoto = Array.isArray(message.photo) && message.photo.length > 0;
    const hasText  = typeof message.text === 'string';
    if (!hasPhoto && !hasText) return new Response('OK', { status: 200 });

    // Silently ignore messages from anyone other than the owner.
    const ownerId = env.OWNER_TELEGRAM_ID;
    if (ownerId && message.from && String(message.from.id) !== String(ownerId)) {
      return new Response('OK', { status: 200 });
    }

    const botToken   = env.TELEGRAM_BOT_TOKEN;
    const ownerChatId = message.chat?.id;
    const rawText     = hasPhoto ? (message.caption || '') : (message.text || '');

    const repo      = env.GITHUB_REPO;
    const ghToken   = env.GITHUB_TOKEN;
    const headers   = ghHeaders(ghToken);
    const repoBase  = `https://api.github.com/repos/${repo}/contents`;

    // ── /delete command ──────────────────────────────────────────────────────
    if (hasText && rawText.startsWith('/delete')) {
      const arg = rawText.slice('/delete'.length).trim();
      if (!arg) {
        await sendTelegramMessage(ownerChatId, 'Usage: /delete <id or name>', botToken);
        return new Response('OK', { status: 200 });
      }

      const dealsApiUrl = `${repoBase}/${DEALS_PATH}`;
      let deals, dealsSha;
      try {
        ({ deals, sha: dealsSha } = await readDealsFile(dealsApiUrl, headers));
      } catch (err) {
        await sendTelegramMessage(ownerChatId, `Error reading deals: ${err.message}`, botToken);
        return new Response('Internal Server Error', { status: 500 });
      }

      const argLower = arg.toLowerCase();
      const deal = deals.find(d => d.id === arg) ||
                   deals.find(d => d.title.toLowerCase() === argLower);

      if (!deal) {
        await sendTelegramMessage(ownerChatId, `No deal found for: ${arg}`, botToken);
        return new Response('OK', { status: 200 });
      }

      try {
        const updated = deals.filter(d => d.id !== deal.id);
        const encoded = base64Encode(JSON.stringify(updated, null, 2) + '\n');
        await ghPut(dealsApiUrl, headers, encoded, dealsSha, `delete deal: ${deal.id}`);
      } catch (err) {
        await sendTelegramMessage(ownerChatId, `Error updating deals: ${err.message}`, botToken);
        return new Response('Internal Server Error', { status: 500 });
      }

      try {
        const imageApiUrl = `${repoBase}/images/${deal.id}.jpg`;
        const { sha: imgSha } = await ghGet(imageApiUrl, headers);
        if (imgSha) {
          await ghDelete(imageApiUrl, headers, imgSha, `delete image: ${deal.id}`);
        }
      } catch (err) {
        console.error('Image delete error:', err.message);
      }

      await sendTelegramMessage(ownerChatId, `Deleted: ${deal.title}`, botToken);
      return new Response('OK', { status: 200 });
    }
    // ── end /delete ──────────────────────────────────────────────────────────

    const fields  = parseFields(rawText);
    const missing = [];
    if (!fields.name) missing.push('Name');
    if (!fields.link) missing.push('Affiliate Link');
    if (!hasPhoto)    missing.push('photo');

    if (missing.length > 0) {
      await sendTelegramMessage(ownerChatId, `Missing: ${missing.join(', ')}.`, botToken);
      return new Response('OK', { status: 200 });
    }

    const affiliateUrl = safeHttpsUrl(fields.link);
    if (!affiliateUrl) {
      await sendTelegramMessage(ownerChatId, 'Invalid link. Please use a valid https:// Amazon URL.', botToken);
      return new Response('OK', { status: 200 });
    }

    let parsedHost;
    try {
      parsedHost = new URL(affiliateUrl).hostname.toLowerCase();
    } catch {
      await sendTelegramMessage(ownerChatId, 'Invalid link URL.', botToken);
      return new Response('OK', { status: 200 });
    }
    if (!AMAZON_HOSTS.has(parsedHost)) {
      await sendTelegramMessage(ownerChatId, 'Only Amazon affiliate links are supported.', botToken);
      return new Response('OK', { status: 200 });
    }

    const slug     = slugify(fields.name);
    const category = normalizeCategory(fields.category);
    const date     = new Date().toISOString().slice(0, 10);

    // Download and commit product image.
    let imagePath = '';
    try {
      const largestPhoto    = message.photo[message.photo.length - 1];
      const filePath        = await getTelegramFilePath(largestPhoto.file_id, botToken);
      const imageBytes      = await downloadTelegramFile(filePath, botToken);
      const imageApiUrl     = `${repoBase}/images/${slug}.jpg`;
      const { sha: imgSha } = await ghGet(imageApiUrl, headers);
      await ghPut(imageApiUrl, headers, base64EncodeBytes(imageBytes), imgSha, `image: ${slug}`);
      imagePath = `images/${slug}.jpg`;
    } catch (err) {
      console.error('Photo save error:', err.message);
      await sendTelegramMessage(ownerChatId, `Error saving photo: ${err.message}`, botToken);
      return new Response('Internal Server Error', { status: 500 });
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

    try {
      const dealsApiUrl     = `${repoBase}/${DEALS_PATH}`;
      const { deals, sha }  = await readDealsFile(dealsApiUrl, headers);
      const filtered        = deals.filter(d => d.id !== slug);
      filtered.unshift(newDeal);
      const encoded = base64Encode(JSON.stringify(filtered, null, 2) + '\n');
      await ghPut(dealsApiUrl, headers, encoded, sha, `deal: ${slug} — ${fields.name}`);
    } catch (err) {
      console.error('GitHub error:', err.message);
      await sendTelegramMessage(ownerChatId, `Error saving deal: ${err.message}`, botToken);
      return new Response('Internal Server Error', { status: 500 });
    }

    const displayCategory = category.charAt(0).toUpperCase() + category.slice(1);
    await sendTelegramMessage(ownerChatId, `Published: ${fields.name} in ${displayCategory}`, botToken);
    return new Response('OK', { status: 200 });
  },
};
