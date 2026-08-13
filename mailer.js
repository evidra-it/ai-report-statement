const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const FROM_EMAIL = process.env.FROM_EMAIL || 'no-reply@localhost';
const FROM_NAME = process.env.FROM_NAME || 'Forensic Investigation Portal';
const BREVO_API_KEY = process.env.BREVO_API_KEY || '';

const emailsDir = path.join(__dirname, 'emails');
if (!fs.existsSync(emailsDir)) fs.mkdirSync(emailsDir, { recursive: true });

let transporter = null;
if (SMTP_HOST && !BREVO_API_KEY) {
  transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    connectionTimeout: 15000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });
}

function reportLink(caseCode) {
  return `${BASE_URL}/report.html?case=${encodeURIComponent(caseCode)}`;
}

function renderInviteEmail({ name, caseCode }) {
  const link = reportLink(caseCode);
  const subject = `Forensic Investigation Report Required - Case ${caseCode}`;
  const html = `
    <div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden">
      <div style="background:#1a237e;padding:20px 24px">
        <h2 style="color:#fff;margin:0">Forensic Investigation Portal</h2>
      </div>
      <div style="padding:24px">
        <p>Dear <strong>${name}</strong>,</p>
        <p>An investigation case has been initiated. Please submit your forensic report using the details below.</p>
        <table style="border-collapse:collapse;margin:16px 0">
          <tr><td style="padding:6px 12px;background:#f5f5f5"><strong>Case Code</strong></td><td style="padding:6px 12px">${caseCode}</td></tr>
          <tr><td style="padding:6px 12px;background:#f5f5f5"><strong>Name</strong></td><td style="padding:6px 12px">${name}</td></tr>
        </table>
        <p><a href="${link}" style="display:inline-block;background:#1a237e;color:#fff;padding:12px 20px;text-decoration:none;border-radius:6px">Fill the Report Form</a></p>
        <p style="color:#666;font-size:13px">Or open this link: <a href="${link}">${link}</a></p>
        <p style="color:#666;font-size:12px">This is an automated email. Please do not reply.</p>
      </div>
    </div>
  `;
  return { subject, html };
}

async function sendInviteEmail({ name, caseCode, email }) {
  const { subject, html } = renderInviteEmail({ name, caseCode });

  if (BREVO_API_KEY) {
    return sendViaBrevoApi({ name, email, subject, html, caseCode });
  }

  if (!transporter) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(emailsDir, `${caseCode}-${stamp}.html`);
    fs.writeFileSync(file, html);
    console.log(`[mailer] MOCK MODE (no SMTP_HOST and no BREVO_API_KEY): email to ${email}`);
    console.log(`[mailer] Subject: ${subject}`);
    console.log(`[mailer] Preview saved to ${file}`);
    console.log(`[mailer] Link: ${reportLink(caseCode)}`);
    return { mock: true, previewPath: file };
  }

  try {
    const info = await transporter.sendMail({
      from: { name: FROM_NAME, address: FROM_EMAIL },
      to: email,
      subject,
      html,
    });
    console.log(`[mailer] Sent via SMTP (${SMTP_HOST}) to ${email} (messageId=${info.messageId})`);
    return { mock: false, messageId: info.messageId };
  } catch (err) {
    console.error('[mailer] SMTP send failed:', err.message);
    throw err;
  }
}

async function sendViaBrevoApi({ name, email, subject, html, caseCode }) {
  const body = {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email, name }],
    subject,
    htmlContent: html,
    tags: ['forensic-investigator', caseCode],
  };
  let lastErr = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'api-key': BREVO_API_KEY,
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20000),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        console.log(`[mailer] Sent via Brevo API to ${email} (messageId=${data.messageId})`);
        return { mock: false, messageId: data.messageId };
      }
      lastErr = new Error(`Brevo API ${res.status} ${res.statusText}: ${JSON.stringify(data)}`);
      console.error(`[mailer] Brevo API attempt ${attempt}/2 failed:`, lastErr.message);
    } catch (err) {
      lastErr = err;
      console.error(`[mailer] Brevo API attempt ${attempt}/2 network error:`, err.message);
    }
    if (attempt === 1) await new Promise((r) => setTimeout(r, 1500));
  }
  throw lastErr;
}

module.exports = { sendInviteEmail };
