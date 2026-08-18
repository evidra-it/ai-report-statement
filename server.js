require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const { db, initDb, nextCaseCode } = require('./db');
const { sendInviteEmail } = require('./mailer');
const { generateCrossQuestions, generateStatement } = require('./ai');
const log = require('./logger');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
  session({
    secret: process.env.SESSION_SECRET || 'poc-secret',
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 },
  })
);

app.use(express.static(path.join(__dirname, 'public')));

function isAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

app.get('/api/me', async (req, res) => {
  if (!req.session || !req.session.adminId) return res.json({ authenticated: false });
  const admin = await db.get('SELECT id, username, role FROM admins WHERE id = ?', req.session.adminId);
  res.json({ authenticated: true, admin });
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body || {};
  const admin = await db.get('SELECT * FROM admins WHERE username = ?', username || '');
  if (!admin || !bcrypt.compareSync(password || '', admin.password_hash)) {
    log.warn(`[auth] failed login attempt for username="${username || ''}" from ${req.ip}`);
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  req.session.adminId = admin.id;
  log.info(`[auth] superadmin logged in (id=${admin.id}, username=${admin.username})`);
  res.json({ ok: true, admin: { id: admin.id, username: admin.username, role: admin.role } });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/cases/next-code', isAdmin, async (req, res) => {
  res.json({ case_code: await nextCaseCode() });
});

app.get('/api/cases', isAdmin, async (req, res) => {
  const cases = await db.all(
      `SELECT c.*, 
        (SELECT COUNT(*) FROM reports r WHERE r.case_id = c.id) AS reports_count
        FROM cases c ORDER BY c.id DESC`
    );
  res.json(cases);
});

app.post('/api/cases', isAdmin, async (req, res) => {
  const name = String(req.body.name || '').trim();
  const email = String(req.body.email || '').trim();

  if (!name) return res.status(400).json({ error: 'Name is required' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email is required' });
  }

  const caseCode = await nextCaseCode();
  const info = await db.run('INSERT INTO cases (case_code, name, email) VALUES (?, ?, ?)', caseCode, name, email);
  const caseRow = { id: Number(info.lastInsertRowid), case_code: caseCode, name, email };
  log.info(`[case] created ${caseCode} for ${name} <${email}>`);

  try {
    const proto = req.headers['x-forwarded-proto'] || req.protocol;
    const host = req.headers['x-forwarded-host'] || req.get('host');
    const reqBase = process.env.BASE_URL || `${proto}://${host}`;
    await sendInviteEmail({ name, email, caseCode, baseUrl: reqBase });
    await db.run('UPDATE cases SET status = ?, email_sent_at = CURRENT_TIMESTAMP WHERE id = ?', 'invited', caseRow.id);
    caseRow.status = 'invited';
    log.info(`[case] ${caseCode} email sent to ${email} (status=invited)`);
  } catch (err) {
    await db.run("UPDATE cases SET status = 'email_failed' WHERE id = ?", caseRow.id);
    caseRow.status = 'email_failed';
    log.error(`[case] ${caseCode} email FAILED for ${email}: ${err.message} (status=email_failed)`);
    return res.status(502).json({ error: 'Case created but email failed: ' + err.message, case: caseRow });
  }

  res.status(201).json({ ok: true, case: caseRow });
});

app.get('/api/public/cases/:caseCode', async (req, res) => {
  const c = await db.get('SELECT case_code, name, status FROM cases WHERE case_code = ?', req.params.caseCode);
  if (!c) return res.status(404).json({ error: 'Case not found' });
  res.json({ case_code: c.case_code, name: c.name, status: c.status });
});

app.post('/api/public/cases/:caseCode/report', async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE case_code = ?', req.params.caseCode);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  const b = req.body || {};
  const fields = {
    incident_date: String(b.incident_date || '').trim(),
    incident_location: String(b.incident_location || '').trim(),
    incident_description: String(b.incident_description || '').trim(),
    vehicle_number: String(b.vehicle_number || '').trim(),
    vehicle_make_model: String(b.vehicle_make_model || '').trim(),
    vehicle_type: String(b.vehicle_type || '').trim(),
    vehicle_color: String(b.vehicle_color || '').trim(),
    additional_notes: String(b.additional_notes || '').trim(),
  };

  if (!fields.incident_description) {
    return res.status(400).json({ error: 'Incident description is required' });
  }

  let crossQuestions = null;
  if (Array.isArray(b.cross_questions)) {
    crossQuestions = JSON.stringify(
      b.cross_questions
        .filter((q) => q && typeof q.question === 'string' && q.question.trim())
        .map((q) => ({ question: String(q.question).trim(), answer: String(q.answer || '').trim() }))
    );
  }

  const existing = await db.get('SELECT id FROM reports WHERE case_id = ?', c.id);
  if (existing) return res.status(409).json({ error: `A report for case ${c.case_code} has already been submitted` });

  await db.run(
    `INSERT INTO reports (case_id, case_code, name, incident_date, incident_location, incident_description,
       vehicle_number, vehicle_make_model, vehicle_type, vehicle_color, additional_notes, cross_questions)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    c.id, c.case_code, c.name,
    fields.incident_date, fields.incident_location, fields.incident_description,
    fields.vehicle_number, fields.vehicle_make_model, fields.vehicle_type,
    fields.vehicle_color, fields.additional_notes, crossQuestions
  );

  await db.run("UPDATE cases SET status = 'report_submitted' WHERE id = ?", c.id);

  log.info(`[report] submitted for ${c.case_code} by ${c.name} (${crossQuestions ? crossQuestions.length + ' chars q&a' : 'no cross questions'})`);
  res.status(201).json({ ok: true, case_code: c.case_code });
});

const crossCache = new Map();
const CROSS_CACHE_TTL = 60 * 1000;

app.post('/api/public/cases/:caseCode/cross-questions', async (req, res) => {
  const c = await db.get('SELECT * FROM cases WHERE case_code = ?', req.params.caseCode);
  if (!c) return res.status(404).json({ error: 'Case not found' });

  const fields = req.body.fields || {};
  if (!String(fields.incident_description || '').trim()) {
    log.warn(`[ai] cross-questions rejected for ${req.params.caseCode} - incident_description missing`);
    return res.status(400).json({ error: 'Enter the incident description first' });
  }

  const key = `${req.params.caseCode}:${JSON.stringify(fields)}`;
  const cached = crossCache.get(key);
  if (cached && Date.now() - cached.ts < CROSS_CACHE_TTL) {
    log.info(`[ai] cross-questions cache hit for ${req.params.caseCode} (${cached.questions.length} q)`);
    return res.json({ questions: cached.questions, cached: true });
  }

  log.info(`[ai] cross-questions request for ${req.params.caseCode} (generating new)`);
  try {
    const questions = await generateCrossQuestions(fields);
    crossCache.set(key, { questions, ts: Date.now() });
    res.json({ questions });
  } catch (err) {
    log.error(`[ai] cross-questions generation failed for ${req.params.caseCode}: ${err.message}`);
    res.status(502).json({ error: 'AI generation failed: ' + err.message });
  }
});

app.post('/api/public/cases/:caseCode/statement', async (req, res) => {
  const report = await db.get('SELECT * FROM reports WHERE case_code = ?', req.params.caseCode);
  if (!report) return res.status(404).json({ error: 'No report found for this case yet' });

  log.info(`[ai] statement request for ${req.params.caseCode}`);
  try {
    const { html, text } = await generateStatement(report);
    res.json({ statement: text, html });
  } catch (err) {
    log.error(`[ai] statement generation failed for ${req.params.caseCode}: ${err.message}`);
    res.status(502).json({ error: 'Statement generation failed: ' + err.message });
  }
});

app.post('/api/admin/cases/:id/statement', isAdmin, async (req, res) => {
  const report = await db.get('SELECT * FROM reports WHERE case_id = ?', req.params.id);
  if (!report) return res.status(404).json({ error: 'No report submitted for this case yet' });

  log.info(`[ai] admin statement request for case id ${req.params.id}`);
  try {
    const { html, text } = await generateStatement(report);
    res.json({ statement: text, html });
  } catch (err) {
    log.error(`[ai] admin statement failed for case ${req.params.id}: ${err.message}`);
    res.status(502).json({ error: 'Statement generation failed: ' + err.message });
  }
});

app.get('/api/cases/:id/report', isAdmin, async (req, res) => {
  const report = await db.get('SELECT * FROM reports WHERE case_id = ?', req.params.id);
  res.json(report || null);
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

async function main() {
  const mode = process.env.DATABASE_URL ? 'postgres' : 'sqlite';
  log.info(`[db] initializing (dialect=${mode}${process.env.DATABASE_URL ? '' : ' - file: data/forensic.db'})`);
  await initDb();
  app.listen(PORT, () => {
    console.log(`Forensic Investigation POC running at ${process.env.BASE_URL || `http://localhost:${PORT}`}`);
  });
}

main().catch((err) => {
  console.error('[db] failed to initialize database:', err);
  process.exit(1);
});
