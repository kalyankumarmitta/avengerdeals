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

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildCard(deal) {
  const card = document.createElement('div');
  card.className = 'card';

  // deal.image is a repo-relative path like "images/slug.jpg", or empty string.
  const imgEl = deal.image
    ? `<img class="card__img" src="/${escapeHtml(deal.image)}" alt="${escapeHtml(deal.title)}" loading="lazy">`
    : `<div class="card__img card__img--placeholder" aria-hidden="true">No image</div>`;

  const catLabel = deal.category
    ? deal.category.charAt(0).toUpperCase() + deal.category.slice(1) : '';
  const badge = catLabel
    ? `<span class="card__badge">${escapeHtml(catLabel)}</span>` : '';

  const priceEl = deal.price
    ? `<p class="card__price">Price: ${escapeHtml(deal.price)}</p>` : '';

  const dateEl = deal.date
    ? `<time class="card__date" datetime="${escapeHtml(deal.date)}">${formatDate(deal.date)}</time>` : '';

  const grabUrl    = deal.affiliateUrl ? escapeHtml(deal.affiliateUrl) : '#';
  const urlDisplay = deal.affiliateUrl ? escapeHtml(deal.affiliateUrl) : '';

  card.innerHTML = `
    ${imgEl}
    ${badge}
    <p class="card__title">${escapeHtml(deal.title)}</p>
    ${priceEl}
    ${dateEl}
    <a class="btn-grab" href="${grabUrl}" target="_blank" rel="sponsored nofollow noopener">Grab product</a>
    ${urlDisplay ? `<a class="card__url" href="${grabUrl}" target="_blank" rel="sponsored nofollow noopener">${urlDisplay}</a>` : ''}
  `.trim();

  return card;
}

// Appends category links into .site-nav after the "All" anchor.
// Only categories that have at least one deal are shown.
// When deals is empty, only "All" remains.
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

  const categories = [...new Set(
    deals.map(d => (d.category || 'general').toLowerCase())
  )].sort();

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
    const res = await fetch('/data/deals.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    allDeals = await res.json();
  } catch (err) {
    fetchFailed = true;
    console.error('deals.js:', err);
  }

  // Always build the category nav (shows only "All" when list is empty)
  buildCategoryNav(allDeals);

  if (!grid) return; // nav-only pages (disclosure, privacy)

  if (fetchFailed) {
    if (status) {
      status.textContent = 'Could not load deals right now. Please refresh or try again later.';
      status.hidden = false;
    }
    return;
  }

  // Determine filter: URL param takes priority, then data-category attribute
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
    deals = allDeals.filter(d => (d.category || 'general').toLowerCase() === category);
  }

  deals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

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

document.addEventListener('DOMContentLoaded', loadDeals);
