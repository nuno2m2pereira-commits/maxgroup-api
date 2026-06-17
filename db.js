const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'maxgroup.db');

// Ensure data directory exists
const fs = require('fs');
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma('journal_mode = WAL');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS properties (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    ref         TEXT UNIQUE,
    title       TEXT,
    type        TEXT,
    tipologia   TEXT,
    listing_type TEXT,     -- 'comprar' | 'arrendar'
    price       REAL,
    price_str   TEXT,
    location    TEXT,
    city        TEXT,
    district    TEXT,
    area        TEXT,
    bedrooms    INTEGER DEFAULT 0,
    bathrooms   INTEGER DEFAULT 0,
    description TEXT,
    agent_name  TEXT,
    agent_phone TEXT,
    agent_email TEXT,
    image_url   TEXT,
    url         TEXT,
    active      INTEGER DEFAULT 1,
    created_at  TEXT DEFAULT (datetime('now')),
    updated_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    status      TEXT,
    added       INTEGER DEFAULT 0,
    updated     INTEGER DEFAULT 0,
    removed     INTEGER DEFAULT 0,
    error       TEXT
  );
`);

module.exports = db;
