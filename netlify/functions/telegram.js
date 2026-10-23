// Telegram webhook — receives channel posts, appends to data/deals.json,
// and commits a generated HTML post page, all via the GitHub Contents API.
// Node 18+ fetch only — no npm dependencies.
//
// Required env vars:
//   TELEGRAM_SECRET      — secret token set when registering the webhook
//   GITHUB_TOKEN         — fine-grained PAT with contents: write on this repo
//   GITHUB_REPO          — "owner/repo-name"
//   TELEGRAM_CHANNEL_URL — full URL of your public Telegram channel
//   AMAZON_ASSOCIATE_TAG — your Associates tag (e.g. yoursite-21)

const KNOWN_CATEGORIES = ['kitchen', 'home', 'tools'];
const DEALS_PATH = 'data/deals.json';

// ── Hashtag helpers ────────────────────────────────────────────────────────────

function extractCategory(text) {
  const match = text.match(/#(\w+)/i);
  if (match && KNOWN_CATEGORIES.includes(match[1].toLowerCase())) {
    return match[1].toLowerCase();
  }
  return 'general';
}

function stripHashtags(text) {
  return text.replace(/#\w+/g, '').replace(/\s{2,}/g, ' ').trim();
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
}

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

// Append/replace the Associates tag on Amazon and amzn URLs.
function tagAmazonUrl(url, tag) {
  if (!url || !tag) return url;
  try {
    const u = new URL(url);
    if (/amazon\.|amzn\./i.test(u.hostname)) {
      u.searchParams.set('tag', tag);
      return u.toString();
    }
  } catch {}
  return url;
}

// ── Post HTML template ─────────────────────────────────────────────────────────

function formatDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', {
    year: 'numeric', month: 'long', day: 'numeric',
  });
}

function postHtml(deal, channelUrl) {
  const safeTitle    = escapeHtml(deal.title);
  const safeCategory = escapeHtml(deal.category);
  const safePrice    = deal.price ? escapeHtml(deal.price) : null;
  const safeWas      = deal.was  ? escapeHtml(deal.was)   : null;
  const safeAmazon   = safeUrl(deal.amazonUrl) || '#';
  const safeChannel  = safeUrl(channelUrl) || '#';

  const pricing = safePrice
    ? `<p class="card__price">${safePrice}${safeWas ? ` <span class="was">${safeWas}</span>` : ''}</p>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${safeTitle} — KDLS Deals</title>
  <link rel="stylesheet" href="/css/style.css">
  <style>
    .post-wrap { max-width: 640px; }
    .post-meta { font-size: .85rem; color: var(--muted); margin-bottom: 1rem; }
    .post-actions { display: flex; flex-wrap: wrap; gap: .75rem; margin-top: 1.25rem; }
    .btn-amazon {
      display: inline-flex; align-items: center; gap: .5rem;
      background: #ff9900; color: #111; font-size: .9rem; font-weight: 700;
      padding: .6rem 1.1rem; border-radius: 8px; transition: background .15s;
    }
    .btn-amazon:hover { background: #e68a00; text-decoration: none; color: #111; }
    .disclosure-note {
      margin-top: 1.5rem; padding: .75rem 1rem;
      background: var(--surface); border: 1px solid var(--border);
      border-radius: 8px; font-size: .8rem; color: var(--muted);
    }
  </style>
</head>
<body>

<header class="site-header">
  <div class="container">
    <a href="/" class="site-name">KDLS Deals</a>
    <nav class="site-nav" aria-label="Main">
      <a href="/">All</a>
    </nav>
  </div>
</header>

<main>
  <div class="container post-wrap">
    <span class="card__badge">${safeCategory}</span>
    <h1 style="margin-top:.5rem;margin-bottom:.5rem;font-size:1.4rem;line-height:1.3;">${safeTitle}</h1>
    <p class="post-meta">Posted <time datetime="${escapeHtml(deal.date)}">${formatDate(deal.date)}</time></p>

    ${pricing}

    <div class="post-actions">
      <a class="btn-amazon"
         href="${escapeHtml(safeAmazon)}"
         rel="sponsored nofollow"
         target="_blank">
        Check on Amazon
      </a>
      <a class="btn-telegram"
         href="${escapeHtml(safeChannel)}"
         target="_blank"
         rel="noopener noreferrer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M21.05 2.27L2.29 9.43c-1.3.5-1.28 1.21-.24 1.52l4.84 1.51 11.2-7.08c.53-.32 1.01-.15.61.21L8.35 15.3l-.31 4.98c.45 0 .65-.2.9-.44l2.16-2.1 4.49 3.32c.83.46 1.43.22 1.63-.77l2.95-13.93c.3-1.18-.45-1.71-1.12-1.09z"/>
        </svg>
        Join our Telegram channel
      </a>
    </div>

    <p class="disclosure-note">
      This page contains affiliate links. If you buy through them we may earn a small commission
      at no extra cost to you. See our <a href="/disclosure">Affiliate Disclosure</a>.
    </p>
  </div>
</main>

<footer class="site-footer">
  <div class="container">
    <span>&copy; ${new Date().getFullYear()} KDLS Deals</span>
    <nav class="footer-links" aria-label="Footer">
      <a href="/disclosure">Affiliate Disclosure</a>
      <a href="/privacy">Privacy Policy</a>
    </nav>
  </div>
</footer>

<script src="/js/deals.js" defer></script>
</body>
</html>
`;
}

// ── GitHub Contents API helpers ────────────────────────────────────────────────

async function readDealsFile(apiBase, headers) {
  const res = await fetch(apiBase, { headers });
  // Treat a missing file as an empty list rather than a hard error.
  if (res.status === 404) return { content: [], sha: null };
  if (!res.ok) throw new Error(`GitHub GET ${res.status}`);
  const data = await res.json();
  const content = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
  return { content, sha: data.sha };
}

async function writeDealsFile(apiBase, headers, deals, sha, commitMessage) {
  const encoded = Buffer.from(JSON.stringify(deals, null, 2) + '\n').toString('base64');
  const body = { message: commitMessage, content: encoded };
  // Omit sha when creating a new file; include it when updating an existing one.
  if (sha) body.sha = sha;
  const res = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT ${res.status}`);
}

async function upsertPostFile(apiBase, headers, html, commitMessage) {
  let sha;
  const getRes = await fetch(apiBase, { headers });
  if (getRes.ok) {
    const existing = await getRes.json();
    sha = existing.sha;
  }

  const encoded = Buffer.from(html).toString('base64');
  const body = { message: commitMessage, content: encoded };
  if (sha) body.sha = sha;

  const res = await fetch(apiBase, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GitHub PUT post ${res.status}`);
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
  if (!message || !message.text) {
    return { statusCode: 200, body: 'OK' };
  }

  const rawText = message.text;
  const category = extractCategory(rawText);
  const title    = stripHashtags(rawText);
  const date     = new Date().toISOString().slice(0, 10);
  const url      = slugify(title);

  // Extract first URL from message entities then validate and tag it.
  const urlEntity = (message.entities || []).find(e => e.type === 'url');
  const rawAmazon = urlEntity
    ? rawText.slice(urlEntity.offset, urlEntity.offset + urlEntity.length)
    : null;
  const amazonUrl = tagAmazonUrl(safeUrl(rawAmazon), process.env.AMAZON_ASSOCIATE_TAG);

  const newDeal = { title, date, url, category, ...(amazonUrl && { amazonUrl }) };

  const repo       = process.env.GITHUB_REPO;
  const token      = process.env.GITHUB_TOKEN;
  const channelUrl = process.env.TELEGRAM_CHANNEL_URL || '#';
  const ghHeaders  = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };

  try {
    const dealsApiBase = `https://api.github.com/repos/${repo}/contents/${DEALS_PATH}`;
    const { content: deals, sha } = await readDealsFile(dealsApiBase, ghHeaders);
    deals.push(newDeal);
    await writeDealsFile(dealsApiBase, ghHeaders, deals, sha, `Add deal: ${title}`);

    const postApiBase = `https://api.github.com/repos/${repo}/contents/posts/${url}.html`;
    await upsertPostFile(postApiBase, ghHeaders, postHtml(newDeal, channelUrl), `Add post: ${title}`);
  } catch (err) {
    console.error('telegram.js GitHub error:', err.message);
    // Return 500 so Telegram retries, but log the cause.
    return { statusCode: 500, body: 'Internal Server Error' };
  }

  return { statusCode: 200, body: 'OK' };
};
