/**
 * maxgroup.pt scraper
 * Fetches all property listings from maxgroup.pt/pt/imoveis
 * and upserts them into the local SQLite database.
 */

const axios = require('axios');
const cheerio = require('cheerio');
const db = require('./db');

const BASE_URL = 'https://maxgroup.pt';
const LISTINGS_URL = `${BASE_URL}/pt/imoveis`;

// Delay between page requests to be polite
const DELAY_MS = 1500;
const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Parse a single property card from the listings page.
 */
function parseCard($, el) {
  const $el = $(el);

  // Reference number
  const ref = $el.find('[class*="ref"], .ref, .referencia').text().trim()
    || $el.attr('data-ref')
    || $el.find('a').attr('href')?.split('/').pop()
    || null;

  // Link to detail page
  const relUrl = $el.find('a').first().attr('href') || '';
  const url = relUrl.startsWith('http') ? relUrl : BASE_URL + relUrl;

  // Title / type
  const title = $el.find('h2, h3, .title, [class*="title"], [class*="tipo"]').first().text().trim();

  // Price
  const priceRaw = $el.find('[class*="price"], [class*="preco"], .price').first().text().trim();
  const priceNum = parseFloat(priceRaw.replace(/[^0-9,]/g, '').replace(',', '.')) || 0;

  // Location
  const location = $el.find('[class*="local"], [class*="location"], [class*="cidade"]').first().text().trim();

  // Image
  const imgSrc = $el.find('img').first().attr('src') || $el.find('img').first().attr('data-src') || '';
  const imageUrl = imgSrc.startsWith('http') ? imgSrc : (imgSrc ? BASE_URL + imgSrc : '');

  // Listing type
  const tagText = $el.find('[class*="tag"], [class*="badge"], [class*="estado"]').first().text().toLowerCase();
  const listingType = tagText.includes('arrend') ? 'arrendar' : 'comprar';

  // Bedrooms / tipologia from title
  const tipoMatch = title.match(/T(\d+)/i);
  const tipologia = tipoMatch ? `T${tipoMatch[1]}` : null;
  const bedrooms = tipoMatch ? parseInt(tipoMatch[1]) : 0;

  // Agent
  const agentName = $el.find('[class*="agent"], [class*="agente"], [class*="consultor"]').first().text().trim();
  const agentPhone = $el.find('[class*="phone"], [class*="telefone"], a[href^="tel"]').first()
    .text().trim().replace(/[^0-9 +]/g, '').trim();

  return {
    ref: ref || url.split('/').pop() || String(Date.now()),
    title: title || 'Imóvel',
    type: title || 'Imóvel',
    tipologia,
    listing_type: listingType,
    price: priceNum,
    price_str: priceRaw || '—',
    location: location.split(',')[0]?.trim() || location,
    city: location.split(',')[1]?.trim() || location,
    district: '',
    area: '',
    bedrooms,
    bathrooms: 0,
    description: '',
    agent_name: agentName,
    agent_phone: agentPhone,
    agent_email: '',
    image_url: imageUrl,
    url,
  };
}

/**
 * Fetch detail page for extra info (description, area, bathrooms, agent phone).
 */
async function fetchDetail(url) {
  try {
    const { data } = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MaxgroupSync/1.0)',
        'Accept-Language': 'pt-PT,pt;q=0.9',
      },
    });
    const $ = cheerio.load(data);

    const description = $('[class*="descri"], [class*="description"], .desc').first().text().trim()
      || $('p').slice(1, 3).map((_, el) => $(el).text()).get().join(' ').trim();

    const areaMatch = $('body').text().match(/(\d+[\.,]?\d*)\s*m[²2]/i);
    const area = areaMatch ? areaMatch[1].replace(',', '.') + 'm²' : '';

    const bathText = $('[class*="wc"], [class*="banho"], [class*="bath"]').first().text().trim();
    const bathMatch = bathText.match(/\d+/);
    const bathrooms = bathMatch ? parseInt(bathMatch[0]) : 0;

    const agentPhone = $('a[href^="tel"]').first().attr('href')?.replace('tel:', '').trim()
      || $('[class*="phone"], [class*="telef"]').first().text().replace(/[^0-9 +]/g, '').trim();

    const agentName = $('[class*="agente"], [class*="agent"], [class*="consultor"]').first().text().trim();
    const agentEmail = $('a[href^="mailto"]').first().attr('href')?.replace('mailto:', '').trim() || '';

    const imageUrl = $('meta[property="og:image"]').attr('content')
      || $('[class*="gallery"], [class*="foto"] img').first().attr('src') || '';

    return { description, area, bathrooms, agent_phone: agentPhone, agent_name: agentName, agent_email: agentEmail, image_url: imageUrl };
  } catch {
    return {};
  }
}

/**
 * Fetch one page of listings and return parsed cards + whether there's a next page.
 */
async function fetchPage(pageNum = 1) {
  const url = pageNum === 1 ? LISTINGS_URL : `${LISTINGS_URL}?page=${pageNum}`;
  console.log(`  Fetching page ${pageNum}: ${url}`);

  const { data } = await axios.get(url, {
    timeout: 15000,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; MaxgroupSync/1.0)',
      'Accept-Language': 'pt-PT,pt;q=0.9',
    },
  });

  const $ = cheerio.load(data);

  // Try common card selectors
  const selectors = [
    '.property-item', '.imovel-item', '.listing-item',
    '[class*="property-card"]', '[class*="imovel"]',
    '.col-md-4 .card', '.col-sm-6 .item',
    'article', '.property',
  ];

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

  // Check for next page
  const hasNext = $('a[rel="next"], .pagination .next, [class*="next"]').length > 0;

  return { cards, hasNext };
}

/**
 * Main sync function — call this to run a full scrape.
 */
async function sync() {
  const logStmt = db.prepare(`INSERT INTO sync_log (status) VALUES ('running')`);
  const logId = logStmt.run().lastInsertRowid;

  let added = 0, updated = 0, errors = 0;

  try {
    console.log('🔄 Starting sync from maxgroup.pt...');

    const upsert = db.prepare(`
      INSERT INTO properties (ref, title, type, tipologia, listing_type, price, price_str,
        location, city, area, bedrooms, bathrooms, description,
        agent_name, agent_phone, agent_email, image_url, url, updated_at)
      VALUES (@ref, @title, @type, @tipologia, @listing_type, @price, @price_str,
        @location, @city, @area, @bedrooms, @bathrooms, @description,
        @agent_name, @agent_phone, @agent_email, @image_url, @url, datetime('now'))
      ON CONFLICT(ref) DO UPDATE SET
        title       = excluded.title,
        type        = excluded.type,
        listing_type= excluded.listing_type,
        price       = excluded.price,
        price_str   = excluded.price_str,
        location    = excluded.location,
        city        = excluded.city,
        area        = CASE WHEN excluded.area != '' THEN excluded.area ELSE properties.area END,
        bedrooms    = excluded.bedrooms,
        bathrooms   = CASE WHEN excluded.bathrooms > 0 THEN excluded.bathrooms ELSE properties.bathrooms END,
        description = CASE WHEN excluded.description != '' THEN excluded.description ELSE properties.description END,
        agent_name  = CASE WHEN excluded.agent_name != '' THEN excluded.agent_name ELSE properties.agent_name END,
        agent_phone = CASE WHEN excluded.agent_phone != '' THEN excluded.agent_phone ELSE properties.agent_phone END,
        image_url   = CASE WHEN excluded.image_url != '' THEN excluded.image_url ELSE properties.image_url END,
        url         = excluded.url,
        active      = 1,
        updated_at  = datetime('now')
    `);

    const existingRefs = new Set(
      db.prepare('SELECT ref FROM properties').all().map(r => r.ref)
    );
    const seenRefs = new Set();

    let page = 1;
    let hasNext = true;

    while (hasNext && page <= 20) { // max 20 pages safety limit
      const { cards, hasNext: next } = await fetchPage(page);
      hasNext = next;

      console.log(`  Found ${cards.length} properties on page ${page}`);

      for (const card of cards) {
        try {
          seenRefs.add(card.ref);

          // Fetch detail for richer data (throttled)
          await sleep(DELAY_MS);
          const detail = await fetchDetail(card.url);
          const merged = { ...card, ...detail };

          // Ensure no undefined values
          Object.keys(merged).forEach(k => {
            if (merged[k] === undefined || merged[k] === null) merged[k] = '';
          });
          if (!merged.bedrooms) merged.bedrooms = 0;
          if (!merged.bathrooms) merged.bathrooms = 0;
          if (!merged.price) merged.price = 0;

          const wasExisting = existingRefs.has(merged.ref);
          upsert.run(merged);
          wasExisting ? updated++ : added++;
        } catch (e) {
          console.error(`  ⚠️  Error processing ${card.ref}:`, e.message);
          errors++;
        }
      }

      if (hasNext) {
        page++;
        await sleep(DELAY_MS);
      }
    }

    // Mark properties not seen in this sync as inactive
    const removed = db.prepare(`
      UPDATE properties SET active = 0, updated_at = datetime('now')
      WHERE ref NOT IN (${[...seenRefs].map(() => '?').join(',')})
      AND active = 1
    `).run([...seenRefs]).changes;

    // Update sync log
    db.prepare(`
      UPDATE sync_log SET status='success', finished_at=datetime('now'),
        added=?, updated=?, removed=? WHERE id=?
    `).run(added, updated, removed, logId);

    console.log(`✅ Sync complete — added: ${added}, updated: ${updated}, removed: ${removed}, errors: ${errors}`);
    return { added, updated, removed, errors };

  } catch (err) {
    db.prepare(`
      UPDATE sync_log SET status='error', finished_at=datetime('now'), error=? WHERE id=?
    `).run(err.message, logId);
    console.error('❌ Sync failed:', err.message);
    throw err;
  }
}

module.exports = { sync };

// Allow running directly: node scraper.js
if (require.main === module) {
  sync().then(() => process.exit(0)).catch(() => process.exit(1));
}
