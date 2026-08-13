const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const bcrypt = require('bcryptjs');

const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new DatabaseSync(path.join(dataDir, 'forensic.db'));
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'superadmin',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'initiated',
    email_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id INTEGER NOT NULL REFERENCES cases(id),
    case_code TEXT NOT NULL,
    name TEXT NOT NULL,
    incident_date TEXT,
    incident_location TEXT,
    incident_description TEXT,
    vehicle_number TEXT,
    vehicle_make_model TEXT,
    vehicle_type TEXT,
    vehicle_color TEXT,
    additional_notes TEXT,
    submitted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS case_seq (
    year TEXT PRIMARY KEY,
    last INTEGER NOT NULL DEFAULT 0
  );
`);

const reportCols = db.prepare('PRAGMA table_info(reports)').all();
if (!reportCols.some((c) => c.name === 'cross_questions')) {
  db.exec('ALTER TABLE reports ADD COLUMN cross_questions TEXT;');
}

const admin = db.prepare('SELECT id FROM admins WHERE username = ?').get(process.env.ADMIN_USERNAME || 'superadmin');
if (!admin) {
  const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'superadmin@123', 10);
  db.prepare('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_USERNAME || 'superadmin', hash, 'superadmin');
  console.log('[db] Seeded superadmin user');
}

const year = String(new Date().getFullYear());
const seq = db.prepare('SELECT last FROM case_seq WHERE year = ?').get(year);
if (!seq) {
  const rows = db.prepare('SELECT case_code FROM cases WHERE case_code LIKE ?').all(`BAJ-${year}-%`);
  let max = 0;
  for (const r of rows) {
    const m = /BAJ-\d{4}-(\d+)$/.exec(r.case_code);
    if (m) max = Math.max(max, parseInt(m[1], 10));
  }
  db.prepare('INSERT INTO case_seq (year, last) VALUES (?, ?)').run(year, max);
}

function nextCaseCode() {
  const year = String(new Date().getFullYear());
  const row = db.prepare('SELECT last FROM case_seq WHERE year = ?').get(year);
  let last;
  if (row) {
    last = Number(row.last) + 1;
    db.prepare('UPDATE case_seq SET last = ? WHERE year = ?').run(last, year);
  } else {
    last = 1;
    db.prepare('INSERT INTO case_seq (year, last) VALUES (?, ?)').run(year, last);
  }
  return `BAJ-${year}-${String(last).padStart(4, '0')}`;
}

module.exports = { db, nextCaseCode };
