const fs = require("node:fs");
const path = require("node:path");

const sqlite3 = require("sqlite3");
const { open } = require("sqlite");

const { config } = require("../config");

let dbPromise = null;

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

async function getDb() {
  if (dbPromise) return dbPromise;

  ensureDirForFile(config.dbPath);
  dbPromise = open({
    filename: config.dbPath,
    driver: sqlite3.Database
  });

  const db = await dbPromise;
  await db.exec(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS session_bindings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id TEXT,
      phone TEXT,
      proxy_ip TEXT,
      profile_id TEXT,
      status TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_session_bindings_phone ON session_bindings(phone);
    CREATE INDEX IF NOT EXISTS idx_session_bindings_proxy ON session_bindings(proxy_ip);
    CREATE INDEX IF NOT EXISTS idx_session_bindings_bot ON session_bindings(bot_id);
  `);

  return db;
}

async function closeDb() {
  if (!dbPromise) return;
  const db = await dbPromise;
  await db.close();
  dbPromise = null;
}

module.exports = { getDb, closeDb };


