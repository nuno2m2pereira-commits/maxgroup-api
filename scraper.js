/**
 * Puppeteer-based scraper for maxgroup.pt
 * Renders JavaScript, waits for property cards to load,
 * then extracts all listings including pagination.
 */

const puppeteer = require('puppeteer');
const db = require('./db');

const BASE_URL = 'https://maxgroup.pt';
const LISTINGS_URL = `${BASE_URL}/pt/imoveis`;
const DELAY_MS = 2000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getBrowser() {
  return puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--no-first-run',
      '--no-zygote',
      '--single-process',
      '--disable-extensions',
    ],
  });
}

/**
 * Extract all property cards from the current page DOM.
 */
async function extractCards(page) {
  return page.evaluate((BASE_URL) => {
    const cards = [];

    // Try multiple possible card selectors
    const selectors = [
      '.property-item', '.imovel', '.listing-item',
      '[class*="property"]', '[class*="imovel"]',
      '.col-md-4', '.col-sm-6', '.col-lg-4',
      'article', '.card',
    ];

    let elements = [];
    for (const sel of selectors) {
      const found = document.querySelectorAll(sel);
      // Must have price-like content and a link
      const valid = Array.from(found).filter(el =>
        el.querySelector('a') &&
        (el.textContent.includes('€') || el.textContent.includes('Ref') || el.textContent.match(/T\d/))
      );
      if (valid.length > 2) { elements = valid; break; }
    }

    elements.forEach(el => {
      const link = el.querySelector('a');
      const url = link ? (link.href.startsWith('http') ? link.href : BASE_URL + link.getAttribute('href')) : '';
      const ref = el.querySelector('[class*="ref"], .ref')?.textContent.trim()
        || url.split('/').filter(Boolean).pop() || '';

      const titleEl = el.querySelector('h2, h3, h4, [class*="title"], [class*="tipo"], [class*="type"]');
      const title = titleEl?.textContent.trim() || '';

      const priceEl = el.querySelector('[class*="price"], [class*="preco"], .price, [class*="valor"]');
      const priceRaw = priceEl?.textContent.trim() || '';
      const priceNum = parseFloat(priceRaw.replace(/[^0-9]/g, '')) || 0;

      const locEl = el.querySelector('[class*="local"], [class*="location"], [class*="cidade"], [class*="zone"]');
      const location = locEl?.textContent.trim() || '';

      const img = el.querySelector('img');
      const imageUrl = img?.src || img?.dataset?.src || '';

      const tagEl = el.querySelector('[class*="tag"], [class*="badge"], [class*="tipo-negocio"], [class*="estado"]');
      const tagText = tagEl?.textContent.toLowerCase() || '';
      const listingType = tagText.includes('arrend') ? 'arrendar' : 'comprar';

      const tipoMatch = title.match(/T(\d+)/i) || url.match(/T(\d+)/i);
      const tipologia = tipoMatch ? `T${tipoMatch[1]}` : '';
      const bedrooms = tipoMatch ? parseInt(tipoMatch[1]) : 0;

      const agentEl = el.querySelector('[class*="agent"], [class*="agente"], [class*="consultor"]');
      const agentName = agentEl?.textContent.trim() || '';

      const phoneEl = el.querySelector('a[href^="tel"]');
      const agentPhone = phoneEl?.getAttribute('href')?.replace('tel:', '').trim() || '';

      if (url && url !== BASE_URL + '/' && url.length > BASE_URL.length + 3) {
        cards.push({
          ref: ref || url.split('/').pop(),
          title, type: title || 'Imóvel', tipologia,
          listing_type: listingType,
          price: priceNum, price_str: priceRaw || '—',
          location: location.split(',')[0]?.trim() || location,
          city: location.split(',')[1]?.trim() || location,
          area: '', bedrooms, bathrooms: 0,
          description: '', agent_name: agentName,
          agent_phone: agentPhone, agent_email: '',
          image_url: imageUrl, url,
        });
      }
    });

    return cards;
  }, BASE_URL);
}

/**
 * Extract detail info from a property page.
 */
async function extractDetail(page, url) {
  try {
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 20000 });
    await sleep(1000);

    return page.evaluate(() => {
      const description = document.querySelector(
        '[class*="descri"], [class*="description"], [class*="texto"], .desc, [itemprop="description"]'
      )?.textContent.trim() || '';

      const areaMatch = document.body.textContent.match(/(\d+[\.,]?\d*)\s*m[²2]/i);
      const area = areaMatch ? areaMatch[1].replace(',', '.') + 'm²' : '';

      const bathText = document.querySelector('[class*="wc"], [class*="banho"], [class*="bath"]')?.textContent || '';
      const bathMatch = bathText.match(/\d+/);
      const bathrooms = bathMatch ? parseInt(bathMatch[0]) : 0;

      const phoneLink = document.querySelector('a[href^="tel"]');
      const agentPhone = phoneLink?.getAttribute('href')?.replace('tel:', '').trim() || '';

      const agentEl = document.querySelector('[class*="agente"], [class*="agent"], [class*="consultor"]');
      const agentName = agentEl?.textContent.trim() || '';

      const emailLink = document.querySelector('a[href^="mailto"]');
      const agentEmail = emailLink?.getAttribute('href')?.replace('mailto:', '').trim() || '';

      const ogImage = document.querySelector('meta[property="og:image"]')?.getAttribute('content') || '';
      const galleryImg = document.querySelector('[class*="gallery"] img, [class*="foto"] img, [class*="slider"] img')?.src || '';
      const imageUrl = ogImage || galleryImg || '';

      return { description, area, bathrooms, agent_phone: agentPhone, agent_name: agentName, agent_email: agentEmail, image_url: imageUrl };
    });
  } catch (e) {
    console.error(`  Detail error for ${url}:`, e.message);
    return {};
  }
}

/**
 * Check if there's a next page button and click it, or return false.
 */
async function goToNextPage(page) {
  try {
    const nextBtn = await page.$('a[rel="next"], .pagination .next, [class*="next"]:not([disabled]), a[aria-label="Next"]');
    if (!nextBtn) return false;
    await nextBtn.click();
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
    await sleep(DELAY_MS);
    return true;
  } catch {
    return false;
  }
}

/**
 * Main sync function.
 */
async function sync() {
  const logId = db.startSyncLog();
  let added = 0, updated = 0, errors = 0;
  let browser;

  try {
    console.log('🔄 Starting Puppeteer sync from maxgroup.pt...');
    browser = await getBrowser();
    const page = await browser.newPage();

    // Set realistic headers
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1366, height: 768 });

    // Block images/fonts to speed up
    await page.setRequestInterception(true);
    page.on('request', req => {
      if (['font', 'stylesheet'].includes(req.resourceType())) {
        req.abort();
      } else {
        req.continue();
      }
    });

    console.log(`  Loading: ${LISTINGS_URL}`);
    await page.goto(LISTINGS_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await sleep(DELAY_MS);

    // Accept cookies if banner appears
    try {
      const cookieBtn = await page.$('[class*="cookie"] button, #cookie-accept, .accept-cookies');
      if (cookieBtn) await cookieBtn.click();
      await sleep(500);
    } catch {}

    const seenRefs = new Set();
    let pageNum = 1;

    while (pageNum <= 20) {
      console.log(`  Extracting page ${pageNum}...`);
      const cards = await extractCards(page);
      console.log(`  Found ${cards.length} properties on page ${pageNum}`);

      if (cards.length === 0 && pageNum === 1) {
        console.log('  ⚠️  No cards found — dumping page title for debug');
        const title = await page.title();
        console.log('  Page title:', title);
      }

      // Open detail page in a second tab for each card
      const detailPage = await browser.newPage();
      await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
      await detailPage.setRequestInterception(true);
      detailPage.on('request', req => {
        if (['font', 'stylesheet', 'image'].includes(req.resourceType())) req.abort();
        else req.continue();
      });

      for (const card of cards) {
        try {
          seenRefs.add(card.ref);
          const detail = await extractDetail(detailPage, card.url);
          const merged = { ...card, ...detail };

          // Clean up undefined/null
          Object.keys(merged).forEach(k => {
            if (merged[k] === undefined || merged[k] === null) merged[k] = '';
          });
          if (!merged.bedrooms) merged.bedrooms = 0;
          if (!merged.bathrooms) merged.bathrooms = 0;
          if (!merged.price) merged.price = 0;

          const result = db.upsertProperty(merged);
          result === 'added' ? added++ : updated++;
          console.log(`  ${result === 'added' ? '➕' : '🔄'} ${merged.ref} — ${merged.title || 'untitled'}`);
        } catch (e) {
          console.error(`  ⚠️  Error: ${e.message}`);
          errors++;
        }
        await sleep(800);
      }

      await detailPage.close();

      // Try next page
      const hasNext = await goToNextPage(page);
      if (!hasNext) break;
      pageNum++;
    }

    await browser.close();

    const removed = db.deactivateAbsent(seenRefs);
    db.finishSyncLog(logId, { status: 'success', added, updated, removed });
    console.log(`✅ Sync complete — added: ${added}, updated: ${updated}, removed: ${removed}, errors: ${errors}`);
    return { added, updated, removed, errors };

  } catch (err) {
    if (browser) await browser.close().catch(() => {});
    db.finishSyncLog(logId, { status: 'error', error: err.message });
    console.error('❌ Sync failed:', err.message);
    throw err;
  }
}

module.exports = { sync };
if (require.main === module) {
  sync().then(() => process.exit(0)).catch(() => process.exit(1));
}
