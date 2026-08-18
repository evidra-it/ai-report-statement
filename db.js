const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');

const DATABASE_URL = process.env.DATABASE_URL || '';

const CREATE_TABLES = `
  CREATE TABLE IF NOT EXISTS admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'superadmin',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS cases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'initiated',
    email_sent_at TEXT,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
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
    cross_questions TEXT,
    submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS case_seq (
    year TEXT PRIMARY KEY,
    last INTEGER NOT NULL DEFAULT 0
  );
`;

const CREATE_TABLES_PG = `
  CREATE TABLE IF NOT EXISTS admins (
    id SERIAL PRIMARY KEY,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'superadmin',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS cases (
    id SERIAL PRIMARY KEY,
    case_code TEXT UNIQUE NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'initiated',
    email_sent_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS reports (
    id SERIAL PRIMARY KEY,
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
    cross_questions TEXT,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE IF NOT EXISTS case_seq (
    year TEXT PRIMARY KEY,
    last INTEGER NOT NULL DEFAULT 0
  );
`;

function sqliteAdapter() {
  const { DatabaseSync } = require('node:sqlite');
  const dataDir = path.join(__dirname, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const raw = new DatabaseSync(path.join(dataDir, 'forensic.db'));
  raw.exec('PRAGMA journal_mode = WAL;');

  return {
    dialect: 'sqlite',
    exec(sql) {
      raw.exec(sql);
    },
    get(sql, ...params) {
      return raw.prepare(sql).get(...params);
    },
    all(sql, ...params) {
      return raw.prepare(sql).all(...params);
    },
    run(sql, ...params) {
      const info = raw.prepare(sql).run(...params);
      return { lastInsertRowid: Number(info.lastInsertRowid), changes: Number(info.changes) };
    },
    listColumns(table) {
      return raw.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    },
    close() {
      raw.close();
    },
  };
}

function pgAdapter() {
  const { Pool } = require('pg');
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: DATABASE_URL.includes('localhost') ? false : { rejectUnauthorized: false },
  });

  const convert = (sql) => {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  };

  return {
    dialect: 'postgres',
    async exec(sql) {
      await pool.query(convert(sql));
    },
    async get(sql, ...params) {
      const res = await pool.query(convert(sql), params);
      return res.rows[0] || undefined;
    },
    async all(sql, ...params) {
      const res = await pool.query(convert(sql), params);
      return res.rows;
    },
    async run(sql, ...params) {
      const trimmed = convert(sql.trim());
      if (/^INSERT/i.test(trimmed) && !/RETURNING/i.test(trimmed)) {
        const res = await pool.query(`${trimmed} RETURNING id`, params);
        return { lastInsertRowid: Number(res.rows[0].id), changes: res.rowCount };
      }
      const res = await pool.query(trimmed, params);
      return { lastInsertRowid: null, changes: res.rowCount };
    },
    async listColumns(table) {
      const res = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_name = $1`,
        [table]
      );
      return res.rows.map((r) => r.column_name);
    },
    async close() {
      await pool.end();
    },
  };
}

let conn = null;

async function initDb() {
  if (DATABASE_URL) {
    conn = pgAdapter();
  } else {
    conn = sqliteAdapter();
  }

  await conn.exec(conn.dialect === 'postgres' ? CREATE_TABLES_PG : CREATE_TABLES);

  const cols = await conn.listColumns('reports');
  if (!cols.includes('cross_questions')) {
    await conn.exec('ALTER TABLE reports ADD COLUMN cross_questions TEXT');
  }

  const admin = await conn.get('SELECT id FROM admins WHERE username = ?', process.env.ADMIN_USERNAME || 'superadmin');
  if (!admin) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'superadmin@123', 10);
    await conn.run('INSERT INTO admins (username, password_hash, role) VALUES (?, ?, ?)', process.env.ADMIN_USERNAME || 'superadmin', hash, 'superadmin');
    console.log('[db] Seeded superadmin user');
  }

  const year = String(new Date().getFullYear());
  const seq = await conn.get('SELECT last FROM case_seq WHERE year = ?', year);
  if (!seq) {
    const rows = await conn.all('SELECT case_code FROM cases WHERE case_code LIKE ?', `BAJ-${year}-%`);
    let max = 0;
    for (const r of rows) {
      const m = /BAJ-\d{4}-(\d+)$/.exec(r.case_code);
      if (m) max = Math.max(max, parseInt(m[1], 10));
    }
    await conn.run('INSERT INTO case_seq (year, last) VALUES (?, ?)', year, max);
  }

  return conn;
}

const db = {
  get: (...args) => conn.get(...args),
  all: (...args) => conn.all(...args),
  run: (...args) => conn.run(...args),
  exec: (...args) => conn.exec(...args),
};

async function nextCaseCode() {
  const year = String(new Date().getFullYear());
  const row = await db.get('SELECT last FROM case_seq WHERE year = ?', year);
  let last;
  if (row) {
    last = Number(row.last) + 1;
    await db.run('UPDATE case_seq SET last = ? WHERE year = ?', last, year);
  } else {
    last = 1;
    await db.run('INSERT INTO case_seq (year, last) VALUES (?, ?)', year, last);
  }
  return `BAJ-${year}-${String(last).padStart(4, '0')}`;
}

module.exports = { db, initDb, nextCaseCode };
