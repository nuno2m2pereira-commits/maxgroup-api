const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const db = require('./db');
const { sync } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

// ── MIDDLEWARE ──────────────────────────────────────────────────────────────
app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' })); // Allow any origin (website + app)
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 min
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ── HELPERS ─────────────────────────────────────────────────────────────────
function buildFilters(query) {
  const conditions = ['active = 1'];
  const params = [];

  if (query.tipo) {
    conditions.push('listing_type = ?');
    params.push(query.tipo);
  }
  if (query.tipologia) {
    conditions.push('tipologia = ?');
    params.push(query.tipologia);
  }
  if (query.city) {
    conditions.push('(city LIKE ? OR location LIKE ?)');
    params.push(`%${query.city}%`, `%${query.city}%`);
  }
  if (query.q) {
    conditions.push('(title LIKE ? OR location LIKE ? OR city LIKE ? OR description LIKE ?)');
    const like = `%${query.q}%`;
    params.push(like, like, like, like);
  }
  if (query.pmin) {
    conditions.push('price >= ?');
    params.push(parseFloat(query.pmin));
  }
  if (query.pmax) {
    conditions.push('price <= ?');
    params.push(parseFloat(query.pmax));
  }

  return { conditions, params };
}

// ── ROUTES ───────────────────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  const last = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 1`).get();
  const total = db.prepare(`SELECT COUNT(*) as c FROM properties WHERE active=1`).get();
  res.json({
    status: 'ok',
    service: 'RE/MAX Maxgroup API',
    properties: total.c,
    lastSync: last,
  });
});

// GET /api/imoveis — list with filters + pagination
app.get('/api/imoveis', (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 12);
    const offset = (page - 1) * limit;

    const { conditions, params } = buildFilters(req.query);
    const where = conditions.join(' AND ');

    const orderMap = {
      'price-asc':  'price ASC',
      'price-desc': 'price DESC',
      'newest':     'updated_at DESC',
    };
    const order = orderMap[req.query.order] || 'updated_at DESC';

    const total = db.prepare(`SELECT COUNT(*) as c FROM properties WHERE ${where}`).get(...params).c;
    const rows = db.prepare(
      `SELECT * FROM properties WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);

    res.json({
      data: rows,
      meta: {
        total,
        page,
        limit,
        pages: Math.ceil(total / limit),
      },
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/imoveis/:id — single property
app.get('/api/imoveis/:id', (req, res) => {
  const prop = db.prepare(`SELECT * FROM properties WHERE id = ? AND active = 1`).get(req.params.id);
  if (!prop) return res.status(404).json({ error: 'Imóvel não encontrado' });
  res.json(prop);
});

// GET /api/imoveis/ref/:ref — by reference number
app.get('/api/imoveis/ref/:ref', (req, res) => {
  const prop = db.prepare(`SELECT * FROM properties WHERE ref = ?`).get(req.params.ref);
  if (!prop) return res.status(404).json({ error: 'Imóvel não encontrado' });
  res.json(prop);
});

// GET /api/stats — summary stats
app.get('/api/stats', (req, res) => {
  const total     = db.prepare(`SELECT COUNT(*) as c FROM properties WHERE active=1`).get().c;
  const comprar   = db.prepare(`SELECT COUNT(*) as c FROM properties WHERE active=1 AND listing_type='comprar'`).get().c;
  const arrendar  = db.prepare(`SELECT COUNT(*) as c FROM properties WHERE active=1 AND listing_type='arrendar'`).get().c;
  const cities    = db.prepare(`SELECT city, COUNT(*) as c FROM properties WHERE active=1 GROUP BY city ORDER BY c DESC LIMIT 10`).all();
  const lastSync  = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 1`).get();
  res.json({ total, comprar, arrendar, cities, lastSync });
});

// GET /api/sync/status — last sync info
app.get('/api/sync/status', (req, res) => {
  const logs = db.prepare(`SELECT * FROM sync_log ORDER BY id DESC LIMIT 5`).all();
  res.json(logs);
});

// POST /api/sync/trigger — manually trigger a sync (protect with API key)
app.post('/api/sync/trigger', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== process.env.SYNC_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Run async, respond immediately
  res.json({ message: 'Sync started' });
  sync().catch(console.error);
});

// ── CRON JOB — sync every 6 hours ────────────────────────────────────────────
// '0 */6 * * *' = at minute 0 past every 6th hour
cron.schedule('0 */6 * * *', async () => {
  console.log('⏰ Cron: starting scheduled sync...');
  try {
    await sync();
  } catch (err) {
    console.error('Cron sync error:', err.message);
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`🚀 Maxgroup API running on port ${PORT}`);

  // Run initial sync on startup if DB is empty
  const count = db.prepare(`SELECT COUNT(*) as c FROM properties`).get().c;
  if (count === 0) {
    console.log('📦 Database empty — running initial sync...');
    sync().catch(console.error);
  } else {
    console.log(`📦 Database has ${count} properties. Next sync in up to 6 hours.`);
  }
});
