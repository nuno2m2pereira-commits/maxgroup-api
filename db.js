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
{
  "name": "maxgroup-api",
  "version": "1.0.0",
  "description": "RE/MAX Maxgroup property listings API with auto-sync",
  "main": "server.js",
  "scripts": {
    "start": "node server.js",
    "sync": "node scraper.js"
  },
  "dependencies": {
    "axios": "^1.7.2",
    "cheerio": "^1.0.0",
    "cors": "^2.8.5",
    "express": "^4.19.2",
    "node-cron": "^3.0.3",
    "helmet": "^7.1.0",
    "express-rate-limit": "^7.3.1"
  },
  "engines": {
    "node": ">=18.0.0"
  }
}
