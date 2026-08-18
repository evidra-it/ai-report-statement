const log = require('./logger');
const { Agent } = require('undici');
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || '';
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

const dispatcher = new Agent({
  connect: { timeout: 10000 },
  headersTimeout: 40000,
  bodyTimeout: 40000,
});

const MODELS = [
  'nvidia/nemotron-3-ultra-550b-a55b:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'nvidia/nemotron-3.5-lightning:free',
  'openai/gpt-oss-20b:free',
  'google/gemma-4-31b-it:free',
];

const SYSTEM_PROMPT = `You are a forensic investigation assistant. You are given the details a forensic investigator has entered on a report form (incident details and vehicle details). Based ONLY on the details provided by the user, generate cross-examination questions that a claim/forensic team would ask to probe, verify, and dig deeper into that specific case.

Rules:
- Ask questions that are TRULY based on the user's entered details. Do not ask generic or unrelated questions.
- Focus on the specific vehicle, location, dates, and description the user gave (e.g. probe ownership/usage of that vehicle, timeline around the incident date, witnesses at that location, consistency of the description).
- Produce 5 to 8 questions.
- Output exactly one question per line, numbered or not. No extra text, no bullets, no headers, no explanation.
- If the user has provided almost no details, ask only a few clarifying questions based on what little they entered.`;

const STATEMENT_SYSTEM_PROMPT = `You are a legal/forensic scribe. Convert the case details and the cross-question answers into a formal first-person statement (affidavit-style), exactly as the person reporting the incident would give it.

Rules:
- Write entirely in first person ("I", "my", "me").
- Open with "I, <name>, ..." introducing the person (name, and mention they are submitting this statement for case <case_code>).
- State the incident date and location clearly.
- Narrate the incident chronologically using ONLY the details provided.
- Weave the cross-question answers in naturally where they add relevant context (e.g. witnesses, tyre condition, speed, insurance, prior incidents). Do not include the questions themselves.
- Stay factual, formal and neutral. Do NOT invent facts that are not present in the details.
- Open the introduction on its own, then the narration as several short paragraphs, then a short "Observations / additional details" paragraph if the cross-question answers added material worth capturing, and finish with the confirmation line "I confirm that the above statement is true to the best of my knowledge." followed by the person's name on one line and the statement date on the final line.
- Use the exact statement date given in the details.

CRITICAL - ALWAYS a complete statement:
- Never stop after the introduction. The output must ALWAYS be a full affidavit with all four sections in order: (1) introduction, (2) narration, (3) observations/additional details, (4) confirmation line + name + date.
- If some report fields are missing, DO NOT print the introduction alone and stop. Instead, still produce the full structure: narrate using whatever details DO exist, and for anything unknown write a short, honest line such as "The incident details were not provided in the report" rather than inventing facts.
- Produce enough length for a real statement (multiple sentences / paragraphs), never a single line.

Output the statement as an HTML fragment. Rules for the HTML:
- Use ONLY <p>, <strong>, <em>, <ul>, <ol>, <li>, <span>, and <br>.
- One <p> per paragraph. The person's full name may be wrapped in <strong> at first mention.
- No attributes, no class, no style, no id, no <html>, <body>, <head>, <script>, <img>, <a>, or links.
- Plain text otherwise.`;

function sanitizeHtml(raw) {
  const allowed = new Set(['p', 'strong', 'em', 'b', 'i', 'ul', 'ol', 'li', 'span', 'br']);
  let out = String(raw)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\s(on\w+)[^=]*=[^\s>]*/gi, '')
    .replace(/\s(href|src|style|class|id|target|rel)[^=]*=("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)[^>]*>/g, (full, tag) =>
    allowed.has(tag.toLowerCase()) ? full : ''
  );
  return out;
}

function ensureHtmlBlocks(html) {
  if (/(<p|<ul|<ol|<div|<h[1-6]\b)/i.test(html)) return html;
  return html
    .split(/\n{2,}/)
    .map((para) => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');
}

function htmlToText(html) {
  return String(html)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0*39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function buildUserPrompt(fields) {
  const lines = [];
  if (fields.incident_date) lines.push(`Incident date: ${fields.incident_date}`);
  if (fields.incident_location) lines.push(`Incident location: ${fields.incident_location}`);
  if (fields.incident_description) lines.push(`Incident description: ${fields.incident_description}`);
  if (fields.vehicle_number) lines.push(`Vehicle registration number: ${fields.vehicle_number}`);
  if (fields.vehicle_make_model) lines.push(`Vehicle make & model: ${fields.vehicle_make_model}`);
  if (fields.vehicle_type) lines.push(`Vehicle type: ${fields.vehicle_type}`);
  if (fields.vehicle_color) lines.push(`Vehicle color: ${fields.vehicle_color}`);
  if (fields.additional_notes) lines.push(`Additional notes: ${fields.additional_notes}`);
  return `The investigator has entered these details:\n\n${lines.join('\n')}\n\nGenerate cross-examination questions strictly based on the above details.`;
}

function formatDate(d) {
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

function buildStatementPrompt(report) {
  const lines = [];
  lines.push(`Name: ${report.name}`);
  lines.push(`Case code: ${report.case_code}`);
  lines.push(`Statement date: ${formatDate(new Date())}`);
  if (report.incident_date) lines.push(`Incident date: ${report.incident_date}`);
  if (report.incident_location) lines.push(`Incident location: ${report.incident_location}`);
  if (report.incident_description) lines.push(`Incident description: ${report.incident_description}`);
  if (report.vehicle_number) lines.push(`Vehicle number: ${report.vehicle_number}`);
  if (report.vehicle_make_model) lines.push(`Vehicle make/model: ${report.vehicle_make_model}`);
  if (report.vehicle_type) lines.push(`Vehicle type: ${report.vehicle_type}`);
  if (report.vehicle_color) lines.push(`Vehicle color: ${report.vehicle_color}`);
  if (report.additional_notes) lines.push(`Additional notes: ${report.additional_notes}`);

  let qa = [];
  try { qa = JSON.parse(report.cross_questions || '[]'); } catch (err) { qa = []; }
  if (qa.length) {
    lines.push('\nCross-question answers:');
    qa.forEach((q, i) => {
      lines.push(`${i + 1}. Q: ${q.question} A: ${q.answer || '(not answered)'}`);
    });
  }
  return `Generate a first-person statement using ONLY these details:\n\n${lines.join('\n')}`;
}

function parseQuestions(text) {
  return text
    .split('\n')
    .map((line) => line.trim().replace(/^\d+[.)]\s*/, '').replace(/^[-*•]\s*/, ''))
    .filter((line) => line.length > 0);
}

async function attemptModel(model, systemPrompt, userPrompt, maxTokens, timeoutMs, temperature) {
  const started = Date.now();
  try {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': BASE_URL,
        'X-Title': 'Forensic Investigation POC',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: temperature ?? 0.7,
        max_tokens: maxTokens,
      }),
      signal: AbortSignal.timeout(timeoutMs),
      dispatcher,
    });

    const elapsed = Date.now() - started;

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenRouter API ${res.status}: ${body.slice(0, 200)}`);
      log.error(`[ai] model=${model} failed status=${res.status} after=${elapsed}ms body=${body.slice(0, 200)}`);
      return { ok: false, error: err };
    }

    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) {
      const err = new Error(`model ${model} returned an empty response`);
      log.error(`[ai] model=${model} empty response after=${elapsed}ms`);
      return { ok: false, error: err };
    }

    log.info(`[ai] model=${model} ok chars=${text.length} after=${elapsed}ms`);
    return { ok: true, text };
  } catch (err) {
    const elapsed = Date.now() - started;
    log.error(`[ai] model=${model} error after=${elapsed}ms: ${err.message}`);
    return { ok: false, error: new Error(`model ${model} failed: ${err.message}`) };
  }
}

async function callModel(systemPrompt, userPrompt, maxTokens, temperature) {
  if (!OPENROUTER_API_KEY) {
    log.error('[ai] call skipped - OPENROUTER_API_KEY not configured');
    throw new Error('OPENROUTER_API_KEY is not configured in .env');
  }

  const FETCH_TIMEOUT_MS = 45000;
  const MAX_ATTEMPTS_PER_MODEL = 2;
  let lastError;

  for (const model of MODELS) {
    log.info(`[ai] trying model=${model} inputChars=${userPrompt.length}`);
    for (let attempt = 1; attempt <= MAX_ATTEMPTS_PER_MODEL; attempt++) {
      const outcome = await attemptModel(model, systemPrompt, userPrompt, maxTokens, FETCH_TIMEOUT_MS, temperature);
      if (outcome.ok) return outcome.text;

      lastError = outcome.error;
      const isNetwork =
        outcome.error.message.includes('fetch failed') ||
        outcome.error.message.includes('timed out') ||
        outcome.error.message.includes('aborted') ||
        outcome.error.name === 'TimeoutError';

      if (isNetwork && attempt < MAX_ATTEMPTS_PER_MODEL) {
        log.warn(`[ai] model=${model} network error, retry ${attempt}/${MAX_ATTEMPTS_PER_MODEL}`);
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    }
  }

  throw lastError || new Error('All AI models failed');
}

async function generateCrossQuestions(fields) {
  const text = await callModel(SYSTEM_PROMPT, buildUserPrompt(fields), 2048);
  const questions = parseQuestions(text);
  if (questions.length === 0) {
    log.error(`[ai] could not parse questions raw=${text.slice(0, 300)}`);
    throw new Error('Could not parse questions from AI response');
  }
  log.info(`[ai] ok questions=${questions.length}`);
  return questions;
}

async function generateStatement(report) {
  const raw = await callModel(STATEMENT_SYSTEM_PROMPT, buildStatementPrompt(report), 2048, 0.4);
  const html = ensureHtmlBlocks(sanitizeHtml(raw));
  return { html, text: htmlToText(html) };
}

module.exports = { generateCrossQuestions, generateStatement };
