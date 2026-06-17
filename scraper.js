/**
 * Scraper for maxgroup.pt
 * Uses axios + multiple URL patterns to capture all listings.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE_URL = 'https://maxgroup.pt';
const DELAY_MS = 1000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pt-PT,pt;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Connection': 'keep-alive',
};

// All listing URLs to try (buy + rent + different pages)
function buildUrls() {
  const urls = [];
  // Base listing pages
  const bases = [
    `${BASE_URL}/pt/imoveis`,
    `${BASE_URL}/pt/imoveis/comprar`,
    `${BASE_URL}/pt/imoveis/arrendar`,
    `${BASE_URL}/en/properties`,
    `${BASE_URL}/en/properties/buy`,
    `${BASE_URL}/en/properties/rent`,
  ];
  for (const base of bases) {
    urls.push(base);
    for (let p = 2; p <= 10; p++) {
      urls.push(`${base}?page=${p}`);
      urls.push(`${base}/page/${p}`);
    }
  }
  return [...new Set(urls)];
}

function parseCard($, el) {
  const $el = $(el);
  const link = $el.find('a[href*="imovel"], a[href*="property"], a[href*="imov"]').first()
    || $el.find('a').first();
  const relUrl = link.attr('href') || '';
  if (!relUrl || relUrl === '#' || relUrl === '/') return null;
  const url = relUrl.startsWith('http') ? relUrl : BASE_URL + relUrl;

  // Skip non-property links
  if (!url.includes('imovel') && !url.includes('propert') && !url.includes('/pt/') && !url.includes('/en/')) return null;

  const ref = $el.find('[class*="ref"], .referencia, [class*="codigo"]').first().text().trim()
    || url.split('/').filter(Boolean).pop()
    || String(Date.now());

  const title = $el.find('h2, h3, h4, [class*="title"], [class*="titulo"], [class*="tipo"]').first().text().trim();
  const priceRaw = $el.find('[class*="price"], [class*="preco"], [class*="valor"]').first().text().trim()
    || $el.find('strong, b').filter((_, e) => $(e).text().includes('€')).first().text().trim();
  const priceNum = parseFloat((priceRaw || '').replace(/[^0-9]/g, '')) || 0;

  const location = $el.find('[class*="local"], [class*="location"], [class*="cidade"], [class*="morada"]').first().text().trim()
    || $el.find('address').first().text().trim();

  const imgEl = $el.find('img').first();
  const imageUrl = imgEl.attr('src') || imgEl.attr('data-src') || imgEl.attr('data-lazy') || '';
  const fullImage = imageUrl.startsWith('http') ? imageUrl : (imageUrl ? BASE_URL + imageUrl : '');

  const tagText = $el.find('[class*="tag"], [class*="badge"], [class*="negocio"], [class*="tipo-"]').first().text().toLowerCase();
  const listingType = tagText.includes('arrend') || url.includes('arrend') || url.includes('rent') ? 'arrendar' : 'comprar';

  const tipoMatch = title.match(/T(\d+)/i);
  const tipologia = tipoMatch ? `T${tipoMatch[1]}` : '';
  const bedrooms = tipoMatch ? parseInt(tipoMatch[1]) : 0;

  const agentName = $el.find('[class*="agent"], [class*="agente"], [class*="consultor"]').first().text().trim();
  const agentPhone = $el.find('a[href^="tel"]').first().attr('href')?.replace('tel:', '') || '';

  return {
    ref, title: title || 'Imóvel',
    type: title || 'Imóvel', tipologia,
    listing_type: listingType,
    price: priceNum, price_str: priceRaw || '—',
    location: (location.split(',')[0] || location).trim(),
    city: (location.split(',')[1] || '').trim(),
    area: '', bedrooms, bathrooms: 0,
    description: '', agent_name: agentName,
    agent_phone: agentPhone, agent_email: '',
    image_url: fullImage, url,
  };
}

async function fetchPage(url) {
  try {
    const { data, status } = await axios.get(url, { headers: HEADERS, timeout: 15000 });
    if (status !== 200) return [];
    const $ = cheerio.load(data);

    // Try selectors from most to least specific
    const selectors = [
      '.property-item', '.imovel-item', '.listing-item',
      '[class*="property-card"]', '[class*="imovel-card"]',
      '.properties-list .item', '.listings .item',
      '.col-md-4', '.col-sm-6', '.col-lg-4',
      'article.property', 'article',
      '.card[class*="prop"]', '.card',
    ];

    let cards = [];
    for (const sel of selectors) {
      const found = $(sel);
      if (found.length < 2) continue;

      const parsed = [];
      found.each((_, el) => {
        const card = parseCard($, el);
        if (card) parsed.push(card);
      });

      if (parsed.length > 1) {
        cards = parsed;
        console.log(`  Selector "${sel}" found ${parsed.length} cards`);
        break;
      }
    }

    // Also look for links that look like property detail pages
    if (cards.length === 0) {
      $('a[href]').each((_, el) => {
        const href = $(el).attr('href') || '';
        if ((href.includes('/imovel/') || href.includes('/property/')) && !href.includes('#')) {
          const url2 = href.startsWith('http') ? href : BASE_URL + href;
          const text = $(el).closest('div, article, li').text().trim();
          if (text.includes('€') || text.match(/T\d/)) {
            cards.push({
              ref: href.split('/').pop(),
              title: $(el).text().trim() || 'Imóvel',
              type: 'Imóvel', tipologia: '',
              listing_type: href.includes('arrend') ? 'arrendar' : 'comprar',
              price: 0, price_str: '—',
              location: '', city: '',
              area: '', bedrooms: 0, bathrooms: 0,
              description: '', agent_name: '',
              agent_phone: '', agent_email: '',
              image_url: '', url: url2,
            });
          }
        }
      });
    }

    return cards;
  } catch (e) {
    if (e.response?.status === 404) return null; // page doesn't exist
    console.error(`  Error fetching ${url}:`, e.message);
    return [];
  }
}

async function fetchDetail(url) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 12000 });
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
  } catch {
    return {};
  }
}

async function sync() {
  const logId = db.startSyncLog();
  let added = 0, updated = 0, errors = 0;

  try {
    console.log('🔄 Starting sync from maxgroup.pt...');
    const seenRefs = new Set();
    const allCards = new Map(); // ref -> card (deduplicate)

    const urls = buildUrls();
    console.log(`  Will try ${urls.length} URLs...`);

    for (const url of urls) {
      const cards = await fetchPage(url);
      if (cards === null) continue; // 404, skip rest of this pattern
      if (cards.length === 0) { await sleep(300); continue; }

      for (const card of cards) {
        if (!allCards.has(card.ref)) {
          allCards.set(card.ref, card);
        }
      }
      console.log(`  Total unique so far: ${allCards.size}`);
      await sleep(DELAY_MS);
    }

    console.log(`📦 Total unique properties found: ${allCards.size}`);

    // Fetch details for each property
    for (const [ref, card] of allCards) {
      try {
        seenRefs.add(ref);
        await sleep(800);
        const detail = await fetchDetail(card.url);
        const merged = { ...card, ...detail };

        Object.keys(merged).forEach(k => {
          if (merged[k] === undefined || merged[k] === null) merged[k] = '';
        });
        if (!merged.bedrooms) merged.bedrooms = 0;
        if (!merged.bathrooms) merged.bathrooms = 0;
        if (!merged.price) merged.price = 0;

        const result = db.upsertProperty(merged);
        result === 'added' ? added++ : updated++;
        console.log(`  ${result === 'added' ? '➕' : '🔄'} ${ref} — ${merged.title}`);
      } catch (e) {
        console.error(`  ⚠️  Error: ${e.message}`);
        errors++;
      }
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
