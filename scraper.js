const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE_URL = 'https://maxgroup.pt';
const LISTINGS_URL = `${BASE_URL}/pt/imoveis`;
const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'pt-PT,pt;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function parseCard($, el) {
  const $el = $(el);
  const relUrl = $el.find('a[href]').first().attr('href') || '';
  const url = relUrl.startsWith('http') ? relUrl : BASE_URL + relUrl;
  if (!url || url === BASE_URL || url === BASE_URL + '/') return null;

  const ref = $el.find('[class*="ref"], .ref, [data-ref]').first().text().trim()
    || url.split('/').filter(Boolean).pop() || String(Date.now());

  const title = $el.find('h2, h3, h4, [class*="title"], [class*="tipo"], [class*="type"], [class*="designa"]')
    .first().text().trim();

  const priceRaw = $el.find('[class*="price"], [class*="preco"], [class*="valor"], .price')
    .first().text().trim();
  const priceNum = parseFloat(priceRaw.replace(/[^\d]/g, '')) || 0;

  const location = $el.find('[class*="local"], [class*="location"], [class*="cidade"], [class*="zone"], [class*="zona"]')
    .first().text().trim();

  const imgEl = $el.find('img[src], img[data-src]').first();
  const imgSrc = imgEl.attr('src') || imgEl.attr('data-src') || '';
  const imageUrl = imgSrc.startsWith('http') ? imgSrc : imgSrc ? BASE_URL + imgSrc : '';

  const tagText = $el.find('[class*="tag"], [class*="badge"], [class*="negocio"], [class*="estado"], [class*="tipo-neg"]')
    .first().text().toLowerCase();
  const listingType = tagText.includes('arrend') || title.toLowerCase().includes('arrend') ? 'arrendar' : 'comprar';

  const tipoMatch = (title + ' ' + url).match(/T(\d+)/i);
  const tipologia = tipoMatch ? `T${tipoMatch[1]}` : '';
  const bedrooms = tipoMatch ? parseInt(tipoMatch[1]) : 0;

  const agentName = $el.find('[class*="agent"], [class*="agente"], [class*="consultor"], [class*="mediador"]')
    .first().text().trim();
  const agentPhone = $el.find('a[href^="tel"]').first().attr('href')?.replace('tel:', '').trim() || '';

  return {
    ref, title, type: title || 'Imóvel', tipologia,
    listing_type: listingType,
    price: priceNum, price_str: priceRaw || '—',
    location: location.split(',')[0]?.trim() || location,
    city: location.split(',')[1]?.trim() || location,
    area: '', bedrooms, bathrooms: 0, description: '',
    agent_name: agentName, agent_phone: agentPhone,
    agent_email: '', image_url: imageUrl, url,
  };
}

async function fetchDetail(url) {
  try {
    const { data } = await axios.get(url, { timeout: 10000, headers: HEADERS });
    const $ = cheerio.load(data);

    const description = $('[class*="descri"], [class*="description"], [class*="texto"], [itemprop="description"]')
      .first().text().trim();

    const bodyText = $('body').text();
    const areaMatch = bodyText.match(/(\d+[\.,]?\d*)\s*m[²2]/i);
    const area = areaMatch ? areaMatch[1].replace(',', '.') + 'm²' : '';

    const bathText = $('[class*="wc"], [class*="banho"], [class*="bath"]').first().text();
    const bathMatch = bathText.match(/\d+/);
    const bathrooms = bathMatch ? parseInt(bathMatch[0]) : 0;

    const agentPhone = $('a[href^="tel"]').first().attr('href')?.replace('tel:', '').trim() || '';
    const agentName = $('[class*="agente"], [class*="agent"], [class*="consultor"]').first().text().trim();
    const agentEmail = $('a[href^="mailto"]').first().attr('href')?.replace('mailto:', '').trim() || '';
    const imageUrl = $('meta[property="og:image"]').attr('content')
      || $('[class*="gallery"] img, [class*="foto"] img').first().attr('src') || '';

    return { description, area, bathrooms, agent_phone: agentPhone, agent_name: agentName, agent_email: agentEmail, image_url: imageUrl };
  } catch { return {}; }
}

async function fetchPage(pageNum = 1) {
  const url = pageNum === 1 ? LISTINGS_URL : `${LISTINGS_URL}?pag=${pageNum}`;
  console.log(`  Fetching page ${pageNum}: ${url}`);
  const { data } = await axios.get(url, { timeout: 15000, headers: HEADERS });
  const $ = cheerio.load(data);

  // Try multiple selectors, pick the one with most valid property cards
  const selectors = [
    '.property-item', '.imovel-item', '.listing-item',
    '[class*="property-card"]', '[class*="imovel"]',
    '.col-md-4', '.col-sm-6', '.col-lg-4',
    'article', '.card', '.item',
  ];

  let cards = [];
  for (const sel of selectors) {
    const found = $(sel);
    const parsed = [];
    found.each((_, el) => {
      const card = parseCard($, el);
      if (card) parsed.push(card);
    });
    if (parsed.length > cards.length) cards = parsed;
  }

  // Remove duplicates by ref
  const seen = new Set();
  cards = cards.filter(c => { if (seen.has(c.ref)) return false; seen.add(c.ref); return true; });

  // Check for next page
  const hasNext = $('a[rel="next"], .pagination .next, [class*="proxima"], [class*="next"]').length > 0
    || $(`a[href*="pag=${pageNum + 1}"]`).length > 0;

  return { cards, hasNext };
}

async function sync() {
  const logId = db.startSyncLog();
  let added = 0, updated = 0, errors = 0;

  try {
    console.log('🔄 Starting sync from maxgroup.pt...');
    const seenRefs = new Set();
    let page = 1, hasNext = true;

    while (hasNext && page <= 30) {
      let result;
      try {
        result = await fetchPage(page);
      } catch (e) {
        console.error(`  ⚠️  Failed to fetch page ${page}:`, e.message);
        break;
      }

      const { cards, hasNext: next } = result;
      hasNext = next;
      console.log(`  Found ${cards.length} properties on page ${page}`);

      for (const card of cards) {
        try {
          seenRefs.add(card.ref);
          await sleep(DELAY_MS);
          const detail = await fetchDetail(card.url);
          const merged = { ...card, ...detail };
          Object.keys(merged).forEach(k => { if (merged[k] == null) merged[k] = ''; });
          if (!merged.bedrooms) merged.bedrooms = 0;
          if (!merged.bathrooms) merged.bathrooms = 0;
          if (!merged.price) merged.price = 0;
          const r = db.upsertProperty(merged);
          r === 'added' ? added++ : updated++;
          console.log(`  ${r === 'added' ? '➕' : '🔄'} ${merged.ref} — ${merged.title}`);
        } catch (e) {
          console.error(`  ⚠️  Error on ${card.ref}:`, e.message);
          errors++;
        }
      }

      if (hasNext) { page++; await sleep(DELAY_MS); }
    }

    const removed = db.deactivateAbsent(seenRefs);
    db.finishSyncLog(logId, { status: 'success', added, updated, removed });
    console.log(`✅ Sync complete — added: ${added}, updated: ${updated}, removed: ${removed}, errors: ${errors}`);
    return { added, updated, removed, errors };

  } catch (err) {
    db.finishSyncLog(logId, { status: 'error', error: err.message });
    console.error('❌ Sync failed:', err.message);
    throw err;
  }
}

module.exports = { sync };
if (require.main === module) {
  sync().then(() => process.exit(0)).catch(() => process.exit(1));
}
