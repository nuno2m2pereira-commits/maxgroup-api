const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE_URL = 'https://maxgroup.pt';
const LISTINGS_URL = `${BASE_URL}/pt/imoveis`;
const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

function parseCard($, el) {
  const $el = $(el);
  const relUrl = $el.find('a').first().attr('href') || '';
  const url = relUrl.startsWith('http') ? relUrl : BASE_URL + relUrl;
  const ref = url.split('/').filter(Boolean).pop() || String(Date.now());
  const title = $el.find('h2, h3, .title, [class*="title"], [class*="tipo"]').first().text().trim();
  const priceRaw = $el.find('[class*="price"], [class*="preco"], .price').first().text().trim();
  const priceNum = parseFloat(priceRaw.replace(/[^0-9]/g, '')) || 0;
  const location = $el.find('[class*="local"], [class*="location"], [class*="cidade"]').first().text().trim();
  const imgSrc = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
  const imageUrl = imgSrc.startsWith('http') ? imgSrc : (imgSrc ? BASE_URL + imgSrc : '');
  const tagText = $el.find('[class*="tag"], [class*="badge"], [class*="estado"]').first().text().toLowerCase();
  const listingType = tagText.includes('arrend') ? 'arrendar' : 'comprar';
  const tipoMatch = title.match(/T(\d+)/i);
  const tipologia = tipoMatch ? `T${tipoMatch[1]}` : null;
  const bedrooms = tipoMatch ? parseInt(tipoMatch[1]) : 0;
  const agentName = $el.find('[class*="agent"], [class*="agente"], [class*="consultor"]').first().text().trim();
  const agentPhone = $el.find('a[href^="tel"]').first().attr('href')?.replace('tel:', '') || '';

  return {
    ref, title, type: title || 'Imóvel', tipologia,
    listing_type: listingType, price: priceNum, price_str: priceRaw || '—',
    location: location.split(',')[0]?.trim() || location,
    city: location.split(',')[1]?.trim() || location,
    area: '', bedrooms, bathrooms: 0, description: '',
    agent_name: agentName, agent_phone: agentPhone,
    agent_email: '', image_url: imageUrl, url,
  };
}

async function fetchDetail(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaxgroupSync/1.0)', 'Accept-Language': 'pt-PT,pt;q=0.9' },
    });
    const $ = cheerio.load(data);
    const description = $('[class*="descri"], [class*="description"]').first().text().trim();
    const areaMatch = $('body').text().match(/(\d+[\.,]?\d*)\s*m[²2]/i);
    const area = areaMatch ? areaMatch[1].replace(',', '.') + 'm²' : '';
    const bathText = $('[class*="wc"], [class*="banho"], [class*="bath"]').first().text().trim();
    const bathMatch = bathText.match(/\d+/);
    const bathrooms = bathMatch ? parseInt(bathMatch[0]) : 0;
    const agentPhone = $('a[href^="tel"]').first().attr('href')?.replace('tel:', '').trim() || '';
    const agentName = $('[class*="agente"], [class*="agent"], [class*="consultor"]').first().text().trim();
    const agentEmail = $('a[href^="mailto"]').first().attr('href')?.replace('mailto:', '').trim() || '';
    const imageUrl = $('meta[property="og:image"]').attr('content') || '';
    return { description, area, bathrooms, agent_phone: agentPhone, agent_name: agentName, agent_email: agentEmail, image_url: imageUrl };
  } catch { return {}; }
}

async function fetchPage(pageNum = 1) {
  const url = pageNum === 1 ? LISTINGS_URL : `${LISTINGS_URL}?page=${pageNum}`;
  console.log(`  Fetching page ${pageNum}: ${url}`);
  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaxgroupSync/1.0)', 'Accept-Language': 'pt-PT,pt;q=0.9' },
  });
  const $ = cheerio.load(data);
  const selectors = ['.property-item','.imovel-item','.listing-item','[class*="property-card"]','[class*="imovel"]','.col-md-4 .card','article','.property'];
  let cards = [];
  for (const sel of selectors) {
    const found = $(sel);
    if (found.length > 1) {
      found.each((_, el) => {
        const parsed = parseCard($, el);
        if (parsed.url && parsed.url !== BASE_URL + '/') cards.push(parsed);
      });
      if (cards.length > 0) break;
    }
  }
  const hasNext = $('a[rel="next"], .pagination .next, [class*="next"]').length > 0;
  return { cards, hasNext };
}

async function sync() {
  const logId = db.startSyncLog();
  let added = 0, updated = 0, errors = 0;

  try {
    console.log('🔄 Starting sync from maxgroup.pt...');
    const seenRefs = new Set();
    let page = 1, hasNext = true;

    while (hasNext && page <= 20) {
      const { cards, hasNext: next } = await fetchPage(page);
      hasNext = next;
      console.log(`  Found ${cards.length} properties on page ${page}`);

      for (const card of cards) {
        try {
          seenRefs.add(card.ref);
          await sleep(DELAY_MS);
          const detail = await fetchDetail(card.url);
          const merged = { ...card, ...detail };
          Object.keys(merged).forEach(k => { if (merged[k] === undefined || merged[k] === null) merged[k] = ''; });
          if (!merged.bedrooms) merged.bedrooms = 0;
          if (!merged.bathrooms) merged.bathrooms = 0;
          if (!merged.price) merged.price = 0;
          const result = db.upsertProperty(merged);
          result === 'added' ? added++ : updated++;
        } catch (e) {
          console.error(`  ⚠️  Error processing ${card.ref}:`, e.message);
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
