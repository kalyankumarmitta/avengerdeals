const GRID_ID   = 'deals-grid';
const STATUS_ID = 'deals-status';

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
    <p class="card__title">
      <a href="/posts/${deal.url}">${deal.title}</a>
    </p>
    <time class="card__date" datetime="${deal.date}">${formatDate(deal.date)}</time>
    ${pricing}
    <a class="btn-telegram" href="/posts/${deal.url}">See deal &rarr;</a>
  `.trim();

  return card;
}

async function loadDeals() {
  const grid   = document.getElementById(GRID_ID);
  const status = document.getElementById(STATUS_ID);
  if (!grid) return;

  const category = grid.dataset.category || null;

  try {
    const res = await fetch('/data/deals.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    let deals = await res.json();

    if (category) {
      deals = deals.filter(d => (d.category || 'general').toLowerCase() === category.toLowerCase());
    }

    // Sort newest first
    deals.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

    if (deals.length === 0) {
      if (status) {
        const label = category
          ? category.charAt(0).toUpperCase() + category.slice(1)
          : null;
        status.textContent = label
          ? `No ${label} deals yet — check back soon or join our Telegram channel for instant alerts!`
          : 'No deals yet — check back soon or join our Telegram channel for instant alerts!';
        status.hidden = false;
      }
      return;
    }

    if (status) status.hidden = true;
    deals.forEach(deal => grid.appendChild(buildCard(deal)));

  } catch (err) {
    if (status) {
      status.textContent = 'Could not load deals right now. Please refresh or try again later.';
      status.hidden = false;
    }
    console.error('deals.js:', err);
  }
}

document.addEventListener('DOMContentLoaded', loadDeals);
