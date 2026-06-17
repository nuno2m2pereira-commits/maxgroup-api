/**
 * Simple JSON file database — no compilation needed, works on any platform.
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const PROPS_FILE = path.join(DATA_DIR, 'properties.json');
const LOGS_FILE = path.join(DATA_DIR, 'sync_logs.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PROPS_FILE)) fs.writeFileSync(PROPS_FILE, JSON.stringify([]));
if (!fs.existsSync(LOGS_FILE)) fs.writeFileSync(LOGS_FILE, JSON.stringify([]));

function readProps() {
  try { return JSON.parse(fs.readFileSync(PROPS_FILE, 'utf8')); }
  catch { return []; }
}

function writeProps(data) {
  fs.writeFileSync(PROPS_FILE, JSON.stringify(data, null, 2));
}

function readLogs() {
  try { return JSON.parse(fs.readFileSync(LOGS_FILE, 'utf8')); }
  catch { return []; }
}

function writeLogs(data) {
  fs.writeFileSync(LOGS_FILE, JSON.stringify(data.slice(-20), null, 2)); // keep last 20
}

const db = {
  // ── Properties ──────────────────────────────────────────────────────────

  getAllProperties(filters = {}) {
    let props = readProps().filter(p => p.active !== false);

    if (filters.listing_type) props = props.filter(p => p.listing_type === filters.listing_type);
    if (filters.tipologia)    props = props.filter(p => p.tipologia === filters.tipologia);
    if (filters.city)         props = props.filter(p =>
      (p.city || '').toLowerCase().includes(filters.city.toLowerCase()) ||
      (p.location || '').toLowerCase().includes(filters.city.toLowerCase())
    );
    if (filters.q) {
      const q = filters.q.toLowerCase();
      props = props.filter(p =>
        (p.title || '').toLowerCase().includes(q) ||
        (p.location || '').toLowerCase().includes(q) ||
        (p.city || '').toLowerCase().includes(q) ||
        (p.description || '').toLowerCase().includes(q)
      );
    }
    if (filters.pmin) props = props.filter(p => p.price >= parseFloat(filters.pmin));
    if (filters.pmax) props = props.filter(p => p.price <= parseFloat(filters.pmax));

    // Sort
    if (filters.order === 'price-asc')  props.sort((a, b) => a.price - b.price);
    if (filters.order === 'price-desc') props.sort((a, b) => b.price - a.price);
    if (!filters.order || filters.order === 'newest') {
      props.sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
    }

    return props;
  },

  getPropertyById(id) {
    return readProps().find(p => String(p.id) === String(id) && p.active !== false) || null;
  },

  getPropertyByRef(ref) {
    return readProps().find(p => p.ref === ref) || null;
  },

  upsertProperty(prop) {
    const props = readProps();
    const idx = props.findIndex(p => p.ref === prop.ref);
    const now = new Date().toISOString();

    if (idx >= 0) {
      props[idx] = { ...props[idx], ...prop, active: true, updated_at: now };
    } else {
      const newId = props.length > 0 ? Math.max(...props.map(p => p.id || 0)) + 1 : 1;
      props.push({ id: newId, ...prop, active: true, created_at: now, updated_at: now });
    }
    writeProps(props);
    return idx >= 0 ? 'updated' : 'added';
  },

  deactivateAbsent(seenRefs) {
    const props = readProps();
    const now = new Date().toISOString();
    let count = 0;
    props.forEach(p => {
      if (!seenRefs.has(p.ref) && p.active !== false) {
        p.active = false;
        p.updated_at = now;
        count++;
      }
    });
    writeProps(props);
    return count;
  },

  countProperties() {
    return readProps().filter(p => p.active !== false).length;
  },

  getStats() {
    const props = readProps().filter(p => p.active !== false);
    const cities = {};
    props.forEach(p => { if (p.city) cities[p.city] = (cities[p.city] || 0) + 1; });
    const citiesSorted = Object.entries(cities)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([city, c]) => ({ city, c }));
    return {
      total: props.length,
      comprar: props.filter(p => p.listing_type === 'comprar').length,
      arrendar: props.filter(p => p.listing_type === 'arrendar').length,
      cities: citiesSorted,
    };
  },

  // ── Sync logs ────────────────────────────────────────────────────────────

  startSyncLog() {
    const logs = readLogs();
    const id = logs.length > 0 ? Math.max(...logs.map(l => l.id)) + 1 : 1;
    const log = { id, started_at: new Date().toISOString(), status: 'running' };
    logs.push(log);
    writeLogs(logs);
    return id;
  },

  finishSyncLog(id, result) {
    const logs = readLogs();
    const log = logs.find(l => l.id === id);
    if (log) Object.assign(log, { finished_at: new Date().toISOString(), ...result });
    writeLogs(logs);
  },

  getLastSyncLog() {
    const logs = readLogs();
    return logs.length > 0 ? logs[logs.length - 1] : null;
  },

  getSyncLogs() {
    return readLogs().slice(-5).reverse();
  },
};

module.exports = db;
