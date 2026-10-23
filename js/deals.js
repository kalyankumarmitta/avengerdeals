const GRID_ID   = 'deals-grid';
const STATUS_ID = 'deals-status';
const TITLE_ID  = 'page-title';

function formatDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function buildCard(deal) {
  const card = document.createElement('div');
  card.className = 'card';

  const badge = deal.category
    ? `<span class="card__badge">${deal.category}</span>` : '';

  const pricing = deal.price
    ? `<p class="card__price">${deal.price}${deal.was ? ` <span class="was">${deal.was}</span>` : ''}</p>`
    : '';

  card.innerHTML = `
    ${badge}
    <p class="card__title"><a href="/posts/${deal.url}">${deal.title}</a></p>
    <time class="card__date" datetime="${deal.date}">${formatDate(deal.date)}</time>
    ${pricing}
    <a class="btn-telegram" href="/posts/${deal.url}">See deal &rarr;</a>
  `.trim();

  return card;
}

// Appends category links into .site-nav after the "All" anchor.
// Only categories present in the current deals array are shown.
// When deals is empty, only "All" remains in the nav.
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
    a.href      = `/category.html?c=${encodeURIComponent(cat)}`;
    a.textContent = cat.charAt(0).toUpperCase() + cat.slice(1);
    if (currentCat === cat) a.setAttribute('aria-current', 'page');
    nav.appendChild(a);
  });
}

async function loadDeals() {
  const grid    = document.getElementById(GRID_ID);
  const status  = document.getElementById(STATUS_ID);
  const titleEl = document.getElementById(TITLE_ID);

  let allDeals   = [];
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

  if (!grid) return; // navigation-only pages (disclosure, privacy, post pages)

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

  // Update the page title dynamically on category pages
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
