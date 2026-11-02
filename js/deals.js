const GRID_ID   = 'deals-grid';
const STATUS_ID = 'deals-status';
const TITLE_ID  = 'page-title';

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

window._imgFallback = function(img) {
  const ph = document.createElement('div');
  ph.className = 'card__img card__img--placeholder';
  ph.setAttribute('aria-hidden', 'true');
  ph.textContent = 'No image';
  img.parentNode.replaceChild(ph, img);
};

// Returns the string value of a cell by column index, or "" if missing/null.
function cellValue(row, index) {
  if (!row || !Array.isArray(row.c)) return '';
  const cell = row.c[index];
  if (cell == null || cell.v == null) return '';
  return String(cell.v).trim();
}

// Returns the formatted value of a cell by column index, or "" if missing/null.
function cellFormatted(row, index) {
  if (!row || !Array.isArray(row.c)) return '';
  const cell = row.c[index];
  if (cell == null || cell.f == null) return '';
  return String(cell.f).trim();
}

async function fetchSheetDeals() {
  if (!window.SITE_CONFIG) {
    console.error('deals.js: window.SITE_CONFIG is not defined — make sure js/config.js is loaded before js/deals.js');
    throw new Error('SITE_CONFIG missing');
  }

  const sheetId   = window.SITE_CONFIG.sheetId   || '';
  const sheetName = window.SITE_CONFIG.sheetName || 'Form Responses 1';

  if (!sheetId || sheetId === 'YOUR_SHEET_ID') return [];

  const url = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();

  const start = text.indexOf('(');
  const end   = text.lastIndexOf(')');
  if (start === -1 || end === -1) throw new Error('Unexpected response format');
  const data = JSON.parse(text.slice(start + 1, end));

  const table = data.table;
  if (!table || !Array.isArray(table.rows) || !Array.isArray(table.cols)) return [];

  // Build a label→index map (lowercase). Missing labels resolve to undefined.
  const colIndex = {};
  table.cols.forEach((col, i) => {
    const label = ((col && (col.label || col.id)) || '').toLowerCase().trim();
    if (label) colIndex[label] = i;
  });

  const idx = {
    name:     colIndex['name'],
    price:    colIndex['price'],
    category: colIndex['category'],
    link:     colIndex['affiliate link'],
    image:    colIndex['image url'],
    status:   colIndex['status'],
    ts:       colIndex['timestamp'],
  };

  const deals = [];
  for (const row of table.rows) {
    try {
      if (!row || !Array.isArray(row.c)) continue;

      const status = (idx.status !== undefined ? cellValue(row, idx.status) : '').toLowerCase();
      if (status !== 'approved') continue;

      const name         = idx.name  !== undefined ? cellValue(row, idx.name)  : '';
      const affiliateLink = idx.link !== undefined ? cellValue(row, idx.link)  : '';

      // Skip rows that have no usable name or link
      if (!name && !affiliateLink) continue;

      const rawCategory = (idx.category !== undefined ? cellValue(row, idx.category) : '') || 'general';
      const category = rawCategory.toLowerCase().trim()
        .replace(/\s+/g, '-')
        .replace(/[^a-z0-9-]/g, '')
        .replace(/^-|-$/g, '') || 'general';

      deals.push({
        name,
        price:        idx.price !== undefined ? cellValue(row, idx.price)     : '',
        category,
        affiliateLink,
        imageUrl:     idx.image !== undefined ? cellValue(row, idx.image)     : '',
        timestamp:    idx.ts    !== undefined ? cellFormatted(row, idx.ts)    : '',
      });
    } catch (rowErr) {
      console.error('deals.js: skipping malformed row', rowErr);
    }
  }

  deals.reverse();
  return deals;
}

function buildCard(deal) {
  const card = document.createElement('div');
  card.className = 'card';

  const placeholder = `<div class="card__img card__img--placeholder" aria-hidden="true">No image</div>`;
  const imgEl = deal.imageUrl
    ? `<img class="card__img" src="${escapeHtml(deal.imageUrl)}" alt="${escapeHtml(deal.name)}" loading="lazy" onerror="window._imgFallback(this)">`
    : placeholder;

  const catLabel = deal.category
    ? deal.category.charAt(0).toUpperCase() + deal.category.slice(1) : '';
  const badge = catLabel
    ? `<span class="card__badge">${escapeHtml(catLabel)}</span>` : '';

  const priceEl = deal.price
    ? `<p class="card__price">Price: ${escapeHtml(deal.price)}</p>` : '';

  const dateEl = deal.price && deal.timestamp
    ? `<time class="card__date">Price as of ${escapeHtml(deal.timestamp)}</time>` : '';

  const grabUrl    = deal.affiliateLink ? escapeHtml(deal.affiliateLink) : '#';
  const urlDisplay = deal.affiliateLink ? escapeHtml(deal.affiliateLink) : '';

  card.innerHTML = `
    ${imgEl}
    ${badge}
    <p class="card__title">${escapeHtml(deal.name)}</p>
    ${priceEl}
    ${dateEl}
    <a class="btn-grab" href="${grabUrl}" target="_blank" rel="sponsored nofollow noopener">Grab product</a>
    ${urlDisplay ? `<a class="card__url" href="${grabUrl}" target="_blank" rel="sponsored nofollow noopener">${urlDisplay}</a>` : ''}
  `.trim();

  return card;
}

function buildCategoryNav(deals) {
  const nav = document.querySelector('.site-nav');
  if (!nav) return;

  const params     = new URLSearchParams(location.search);
  const currentCat = params.get('c') ? params.get('c').toLowerCase() : null;
  const isHome     = !currentCat && (
    location.pathname === '/' ||
    location.pathname.endsWith('/index.html')
  );

  const allLink = nav.querySelector('a[href="/"]');
  if (allLink) {
    if (isHome) allLink.setAttribute('aria-current', 'page');
    else allLink.removeAttribute('aria-current');
  }

  if (!deals.length) return;

  const categories = [...new Set(deals.map(d => d.category))].sort();

  categories.forEach(cat => {
    const a = document.createElement('a');
    a.href        = `/category.html?c=${encodeURIComponent(cat)}`;
    a.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    if (currentCat === cat) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  });
}

async function loadDeals() {
  const grid    = document.getElementById(GRID_ID);
  const status  = document.getElementById(STATUS_ID);
  const titleEl = document.getElementById(TITLE_ID);

  let allDeals    = [];
  let fetchFailed = false;

  try {
    allDeals = await fetchSheetDeals();
  } catch (err) {
    fetchFailed = true;
    console.error('deals.js:', err);
  }

  buildCategoryNav(allDeals);

  if (!grid) return;

  if (fetchFailed) {
    if (status) {
      status.textContent = 'Deals are unavailable right now. Please refresh or try again later.';
      status.hidden = false;
    }
    return;
  }

  const params   = new URLSearchParams(location.search);
  const category = params.get('c') ? params.get('c').toLowerCase()
                                    : (grid.dataset.category || null);

  if (titleEl && category) {
    const label = category.charAt(0).toUpperCase() + category.slice(1);
    titleEl.textContent = `${label} Deals`;
    document.title      = `${label} Deals — KDLS Deals`;
  }

  let deals = allDeals;
  if (category) {
    deals = allDeals.filter(d => d.category === category);
  }

  if (!deals.length) {
    if (status) {
      const label = category ? category.charAt(0).toUpperCase() + category.slice(1) : null;
      status.textContent = label
        ? `No ${label} deals yet — check back soon or join our Telegram channel for instant alerts!`
        : 'No deals yet — check back soon or join our Telegram channel for instant alerts!';
      status.hidden = false;
    }
    return;
  }

  if (status) status.hidden = true;
  deals.forEach(deal => grid.appendChild(buildCard(deal)));
}

function applyTelegramLinks() {
  const telegramGroupUrl = (window.SITE_CONFIG && window.SITE_CONFIG.telegramGroupUrl) || '';
  document.querySelectorAll('[data-telegram-link]').forEach(el => {
    if (telegramGroupUrl) {
      el.href = telegramGroupUrl;
    } else {
      el.hidden = true;
    }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadDeals();
  applyTelegramLinks();
});
