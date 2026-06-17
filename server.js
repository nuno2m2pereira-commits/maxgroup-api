const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');
const db = require('./db');
const { sync } = require('./scraper');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use('/api', rateLimit({ windowMs: 15 * 60 * 1000, max: 200 }));

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    service: 'RE/MAX Maxgroup API',
    properties: db.countProperties(),
    lastSync: db.getLastSyncLog(),
  });
});

// GET /api/imoveis
app.get('/api/imoveis', (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(50, parseInt(req.query.limit) || 12);
    const filters = {
      listing_type: req.query.tipo,
      tipologia:    req.query.tipologia,
      city:         req.query.city,
      q:            req.query.q,
      pmin:         req.query.pmin,
      pmax:         req.query.pmax,
      order:        req.query.order,
    };
    const all = db.getAllProperties(filters);
    const total = all.length;
    const data  = all.slice((page - 1) * limit, page * limit);
    res.json({ data, meta: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/imoveis/:id
app.get('/api/imoveis/:id', (req, res) => {
  const prop = db.getPropertyById(req.params.id);
  if (!prop) return res.status(404).json({ error: 'Imóvel não encontrado' });
  res.json(prop);
});

// GET /api/stats
app.get('/api/stats', (req, res) => {
  res.json({ ...db.getStats(), lastSync: db.getLastSyncLog() });
});

// GET /api/sync/status
app.get('/api/sync/status', (req, res) => {
  res.json(db.getSyncLogs());
});

// POST /api/sync/trigger
app.post('/api/sync/trigger', (req, res) => {
  if (req.headers['x-api-key'] !== process.env.SYNC_API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Sync started' });
  sync().catch(console.error);
});

// Sync every 6 hours
cron.schedule('0 */6 * * *', () => {
  console.log('⏰ Cron: starting scheduled sync...');
  sync().catch(console.error);
});

app.listen(PORT, async () => {
  console.log(`🚀 Maxgroup API running on port ${PORT}`);
  if (db.countProperties() === 0) {
    console.log('📦 Database empty — running initial sync...');
    sync().catch(console.error);
  } else {
    console.log(`📦 Database has ${db.countProperties()} properties.`);
  }
});
