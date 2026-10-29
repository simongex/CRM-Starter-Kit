# CRM Starter Kit

A small, login-protected internal workspace for a team:

- **Timeline** – phases, tasks, owners, deadlines, actions (export to PDF / Excel / JSON)
- **Contacts CRM** – categories, owners, notes, mailing groups, relationship summaries
- **Integrations** (all optional) – Gmail history, Granola meeting notes, AI-written notes and summaries (Anthropic), Slack digests, Mailchimp sync, password-reset emails (Resend)

It is plain HTML/CSS/JS plus serverless functions. No build step, no framework. It runs on **Vercel** with an **Upstash Redis** database.

> The kit ships with placeholder names (Alex, Sam, Jordan, Taylor, Robin, Casey, Morgan), the domain `example.org` and the brand "YourOrg". Change them before inviting real people – see step 3.

---

## 1. What you need

| | Needed for | Cost |
|---|---|---|
| Vercel account | hosting | free (Hobby) |
| Upstash Redis database | storing tasks, contacts, logins | free tier |
| Node 18+ and Python 3 | running it locally / tests | free |
| Anthropic API key | AI notes & summaries | pay-as-you-go |
| Google Cloud OAuth client | Gmail import | free |
| Granola API key, Slack bot, Mailchimp, Resend | each optional feature | depends |

---

## 2. Run it locally (2 minutes)

```bash
cd "CRM Starter Kit"
INTERNAL_USERS="alex:test,sam:test" python3 tools/dev-server.py
```

Open http://127.0.0.1:8765/internal and log in as `alex` / `test`.

Locally, data is saved to `.dev-*.json` files in the folder instead of Redis (they are git-ignored). Gmail sign-in only works on the deployed site.

Run the tests: `npm test`

---

## 3. Make it yours (people, roles, branding)

The team list is defined in code in a few places. Search the project for `alex` / `Alex` and update consistently.

| File | What to change |
|---|---|
| `lib/internal-auth.js` | `EMAIL_DOMAIN` (your email domain), `MANAGERS` (full access + CRM), `ACCOUNTS` (all logins), `COORDINATORS` (see a team's tasks + categories), `PEERS` (people who share tasks) |
| `internal/scripts/app.js` (top of file) | `TEAM`, `MANAGERS`, `COORDINATORS`, `PEERS`, the `PEOPLE` profiles (name, email, role), `EMAIL_DOMAIN`. Also the manager logins in `canViewOthers()` (search `login === 'alex'`) |
| `internal/scripts/contacts.js` (top) | team list for contact owners, default relevance words, default categories |
| `lib/contacts.js` (top) | same team list, relevance words and categories (server side) |
| `tools/dev-server.py` (top) | `EMAIL_DOMAIN`, `SEED_MEMBERS`, `DEFAULT_CATEGORIES` (local only) |
| `lib/note-style.js`, `lib/contact-notes.js`, `lib/contact-integrations.js` | the AI prompts – replace "YourOrg is a small organisation (describe what you do here)" with one or two sentences about your organisation. This has a big effect on note quality |
| `api/state.js`, `api/mailchimp.js` | error messages that name the managers |
| Everywhere | find-and-replace `YourOrg` with your name, `example.org` with your domain |
| `lib/cron-hours.js` | jobs only run 08:00–19:59 London time; change the timezone if needed |

Logins are the part of an email before the `@`; the app adds `EMAIL_DOMAIN` (so `alex` → `alex@example.org`). Slack and Gmail match people by that email.

After editing, run `npm test` – some tests use the sample names, update them if you rename people.

---

## 4. Deploy to Vercel

1. Put the folder in a **new private** Git repo of your own (GitHub/GitLab), or deploy straight from the folder with the Vercel CLI: `npm i -g vercel && vercel`.
2. In Vercel: **Add New → Project →** import the repo. Framework preset: **Other**. No build command, no output directory.
3. **Storage → Create Database → Upstash for Redis** (Marketplace) and connect it to the project. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` automatically. (Or create one at upstash.com and paste the REST URL + token.)
4. **Settings → Environment Variables** – add at least:
   - `INTERNAL_USERS` = `alex:a-strong-password,sam:another-one`
   - `INTERNAL_SESSION_SECRET` = output of `openssl rand -base64 48`
   - `SITE_URL` = your deployment URL
   - `CRON_SECRET` = another random string
   The full list with comments is in **`.env.example`**.
5. Redeploy. Open `https://<your-project>.vercel.app/internal` and log in.
6. Each person can then set their own password and add a passkey (Face ID / Touch ID) from their profile. Saved passwords override the ones in `INTERNAL_USERS`.

The root URL `/` redirects to `/internal`. Everything under `/internal` is behind the login (see `middleware.js`) and marked `noindex`.

---

## 5. Connect the APIs (each one is optional)

Each integration switches on as soon as its variables are set. The Contacts settings screen shows which ones are connected. Redeploy after adding variables.

### Anthropic (AI notes, summaries, relevance check)
1. console.anthropic.com → API Keys → create key.
2. Set `ANTHROPIC_API_KEY`. Optional `ANTHROPIC_MODEL` (default in `lib/ai.js`).

### Gmail (read-only email history per contact)
1. console.cloud.google.com → new project → **APIs & Services → Enable APIs** → enable **Gmail API**.
2. **OAuth consent screen**: type *Internal* if you use Google Workspace (otherwise *External* and add each user as a test user). Scopes: `gmail.readonly`, `userinfo.email`.
3. **Credentials → Create credentials → OAuth client ID → Web application**. Authorised redirect URI: `https://<your-project>.vercel.app/api/gmail`
4. Set `GMAIL_CLIENT_ID` and `GMAIL_CLIENT_SECRET` (and `GMAIL_REDIRECT_URI` only if you use a custom domain different from the request host).
5. In the app, each user clicks **Connect Gmail** in Contacts.

### Granola (meeting notes)
1. Granola → Settings → API → create key (needs a plan with API access).
2. Set `GRANOLA_API_KEY`.

### Slack (Monday digest + DMs)
1. api.slack.com/apps → **Create New App → From scratch**.
2. **OAuth & Permissions → Bot Token Scopes**: `chat:write`, `users:read`, `users:read.email`.
3. Install to workspace, copy the **Bot User OAuth Token** (`xoxb-…`) into `SLACK_BOT_TOKEN`.
4. Users are matched by their `login@EMAIL_DOMAIN` address, so Slack emails must match.

### Mailchimp (newsletter status and groups)
1. Mailchimp → Profile → Extras → API keys → create key → `MAILCHIMP_API_KEY`.
2. `MAILCHIMP_SERVER_PREFIX` = the part after the dash in the key (e.g. `us21`).
3. `MAILCHIMP_AUDIENCE_ID` = Audience → Settings → Audience name and defaults → Audience ID.
4. Webhook (keeps unsubscribes in sync): pick a random `MAILCHIMP_WEBHOOK_SECRET`, then in Mailchimp → Audience → Settings → Webhooks add
   `https://<your-project>.vercel.app/api/mailchimp-webhook?key=<MAILCHIMP_WEBHOOK_SECRET>`

### Resend (password-reset emails)
1. resend.com → verify your sending domain → create API key → `RESEND_API_KEY`.
2. `RESET_EMAIL_FROM` = `YourOrg <no-reply@your-domain>`.

---

## 6. Scheduled jobs

Defined in `vercel.json` (times are UTC; Vercel Hobby allows one run per job per day):

| Job | Schedule | Does |
|---|---|---|
| `/api/cron/weekly-digest` | Mon 06:00 | Slack digest of tasks per person |
| `/api/cron/contact-notes` | daily 08:00 | writes interaction notes from Gmail/Granola |
| `/api/cron/mailchimp` | daily 05:30 | pulls Mailchimp statuses |
| `/api/cron/inbox-review` | daily 08:15 | flags new relevant emails |

They need `CRON_SECRET` set. Jobs whose integration isn't configured just skip.

---

## 7. Project layout

```
internal/        front end (index.html = app, login.html, reset.html, scripts/, styles/)
api/             serverless endpoints (login, session, state, contacts, gmail, mailchimp…)
api/cron/        scheduled jobs
lib/             shared server logic + tests (*.test.js)
middleware.js    login gate for /internal
vercel.json      routes, headers, cron schedule
tools/dev-server.py   local server that mimics Vercel
.env.example     every environment variable, commented
```

## 8. Good to know

- Data is stored as JSON in Redis under keys starting with `kb:`. Back it up from the Upstash console, or use the JSON export in the Timeline.
- The browser also caches state in `localStorage` (keys start with `yourorg-`).
- Font: the UI uses Arial. To change it, edit the `font-family` line near the top of `internal/styles/app.css`.
- Never commit `.env*` files or the `.dev-*.json` files – they are in `.gitignore`.
