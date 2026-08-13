# Forensic Investigation Portal (POC)

Full-stack proof-of-concept:

- **Landing page** with superadmin login
- **Case initiator form** (superadmin only) — auto-generates a case code, takes name + email
- On submit, an **email invitation** is sent with a prefilled report link
- **Public report form** — incident details + vehicle details only, with name & case code prefilled (read-only)
- SQLite storage, session-based auth, Brevo email (mock fallback when no API key)

## Stack

- Backend: Node.js + Express + better-sqlite3
- Frontend: vanilla HTML/CSS/JS (served statically by Express)
- Email: Nodemailer over SMTP (mock fallback when `SMTP_HOST` is empty)
- AI cross questions: OpenRouter (free models), generated from the investigator's own entries

## Setup

```bash
npm install
copy .env.example .env
npm start
```

Open http://localhost:3000

## Default superadmin (seeded on first run)

| Username    | Password       |
| ----------- | -------------- |
| superadmin  | superadmin@123 |

Change via `.env` (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) before first run, or delete `data/forensic.db` and restart.

## Flow

1. Superadmin logs in at `/` → redirected to `/admin.html`
2. Admin enters the investigator's name + email → case code like `BAJ-2026-0001` is auto-generated
3. Invitation email is sent to that address with a link to `/report.html?case=BAJ-2026-0001`
4. Investigator opens the link, sees prefilled name/case code, fills **all** incident + vehicle details and clicks **Next**
5. The AI cross-questions API is called once with the entered details; step 2 shows the generated questions with answer fields
6. Investigator answers and clicks **Submit Report**; the Q&A is saved with the report
7. On the success screen, **Generate Statement** builds a first-person statement from the report + Q&A (AI)
8. Case status updates in the admin dashboard (`initiated` → `invited` → `report_submitted`)

## Email (Nodemailer / SMTP)

Set in `.env`:

- `SMTP_HOST` — your SMTP server (e.g. Brevo: `smtp-relay.brevo.com`)
- `SMTP_PORT` — usually `587` (STARTTLS) or `465` (SSL)
- `SMTP_USER`, `SMTP_PASS` — SMTP credentials
- `FROM_EMAIL`, `FROM_NAME` — sender shown to recipients
- `BASE_URL` — public URL used in the email link (must be reachable by the investigator)

**Without** `SMTP_HOST`, emails are not sent: the link is printed to the console and a preview HTML is saved under `emails/` so you can test the flow locally.

## API

| Method | Path | Auth | Description |
| ------ | ---- | ---- | ----------- |
| POST | `/api/login` | – | Superadmin login |
| GET | `/api/me` | session | Current session |
| POST | `/api/logout` | – | Logout |
| GET | `/api/cases/next-code` | admin | Preview next case code |
| GET | `/api/cases` | admin | List cases |
| POST | `/api/cases` | admin | Create case + send invitation email |
| GET | `/api/cases/:id/report` | admin | Get submitted report |
| GET | `/api/public/cases/:caseCode` | – | Prefill data for report form |
| POST | `/api/public/cases/:caseCode/report` | – | Submit report (incl. cross-question answers) |
| POST | `/api/public/cases/:caseCode/cross-questions` | – | Generate cross questions from entered details |
| POST | `/api/public/cases/:caseCode/statement` | – | Generate first-person statement from the submitted report + Q&A |
| GET | `/api/health` | – | Health check |

## AI Cross Questions (OpenRouter)

The report form is a 2-step wizard. The investigator fills **all** incident/vehicle fields on step 1 and clicks **Next**; only then is the OpenRouter call made once (payload-cached 60s server-side). Step 2 loads the generated cross-examination questions — based purely on the entered details — as read-only questions the investigator answers. The Q&A is saved with the report (JSON in the `cross_questions` column).

- `OPENROUTER_API_KEY` — your OpenRouter API key
- `AI_MODEL` — e.g. `openai/gpt-oss-20b:free` (free tier; availability changes, check via `/api/v1/models`)
- Without a key, step 2 shows an error but the report can still be submitted (AI is optional)

## Logs

Every event is written to `logs/app.log` (and the console): login attempts, case creation, AI trigger reason (`generating new` vs `cache hit`), AI model/latency/status, and report submissions.

## Roadmap (next milestones)

- Admin dashboard with case/report viewing and status management
- Email delivery/status tracking (e.g. Brevo webhooks)
- Report attachments (photos, documents)
- Authentication for investigators
- Production hosting
