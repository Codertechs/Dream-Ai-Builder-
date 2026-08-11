const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'app.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS plans (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    price_cents INTEGER NOT NULL,
    interval TEXT NOT NULL DEFAULT 'month',
    description TEXT,
    stripe_price_id TEXT,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    stripe_session_id TEXT UNIQUE,
    customer_email TEXT,
    plan_id TEXT,
    amount_cents INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Seed default plans on first run
const existing = db.prepare('SELECT COUNT(*) AS n FROM plans').get();
if (existing.n === 0) {
  const insert = db.prepare(`
    INSERT INTO plans (id, name, price_cents, interval, description, stripe_price_id, active)
    VALUES (@id, @name, @price_cents, @interval, @description, @stripe_price_id, 1)
  `);
  const seed = db.transaction((plans) => {
    for (const p of plans) insert.run(p);
  });
  seed([
    { id: 'starter', name: 'Starter', price_cents: 0, interval: 'month', description: '3 active builds, community model access', stripe_price_id: null },
    { id: 'builder', name: 'Builder', price_cents: 2900, interval: 'month', description: 'Unlimited builds, all models, custom domains', stripe_price_id: '' },
    { id: 'team', name: 'Team', price_cents: 9900, interval: 'month', description: '5 seats, shared workspace, admin controls', stripe_price_id: '' }
  ]);
}

module.exports = db;
