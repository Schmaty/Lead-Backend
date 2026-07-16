# Leadline

Self-hosted, multi-tenant lead desk: the **Leadline API** (reads your Gmail inbox on a schedule, scores each inquiry with Claude, and stores everything in its own Postgres database) plus the **Leadline dashboard** (the "Lead Desk" web app in [web/](web/)) that the team uses to read, triage and work those leads.

```
┌────────┐   ┌───────────────────────────────────────┐   ┌────────────────────┐
│ Gmail  │ → │ Leadline API + Postgres               │ → │ Leadline dashboard │
│ (IMAP) │   │ built-in scanner polls the inbox,     │   │ (web/ — served by  │
│        │   │ scores each email with the Anthropic  │   │  the web service)  │
│        │   │ API, and upserts leads into Postgres  │   │                    │
└────────┘   └───────────────────────────────────────┘   └────────────────────┘
```

- **Multi-tenant:** every business row belongs to a `Workspace`; every query is workspace-scoped. One deployment can serve multiple client businesses with isolated data.
- **Self-contained pipeline:** the scanner, the AI scoring, and the database all live in this one service — no n8n, no Google Sheets, no external workflow tool. An optional [ingest webhook](#optional-push-leads-from-an-external-tool) exists for anything outside Leadline that wants to push leads in.
- **Client-facing by design:** clients never touch API keys or OAuth apps. All platform secrets (the universal Anthropic key, the Google OAuth client) live behind the **developer account** — the allowlist in `DEVELOPER_EMAILS`, which shows a "Developer" title in the dashboard. Clients connect their inbox with one Google sign-in; the platform absorbs the AI bill.
- **Portable by design:** Docker + config-only. Moving from the home server to a cloud VM later requires no code changes (see [Cloud migration](#cloud-migration-checklist)).

**Stack:** Node.js 20 · TypeScript · Fastify 5 · Prisma 6 · PostgreSQL 16 · React 19 + Vite (dashboard) · Docker Compose · Caddy or Cloudflare Tunnel at the edge.

**The dashboard** implements the full Lead Desk design: a Today briefing (morning brief, KPIs, needs-attention queue, funnel/source/score charts), a drag-and-drop Pipeline board, the All Leads table (filters, presets, search-in-URL, sorting, column toggles, density, bulk stage/owner/follow-up actions, CSV export), Analytics (win rate, calibration, weekly trends, source performance), a lead drawer (scores, reasons, deal economics with win-probability override, draft reply, email threads, notes, activity timeline, delete), and Settings (inbox scanning — connect Gmail by signing in, scan-now, schedule; developer-only platform keys + webhook ingest; tier cutoffs, win-probability map, stage rename/reorder/semantics, team + invites with a Developer title, sources, notification thresholds) — plus login, signup, invite-accept, forgot/reset password and change-password flows wired to the auth endpoints.

---

## API reference

Base path: `/api/v1`. All responses are JSON in camelCase. This section is a summary — the **complete field-level reference** (every endpoint, request/response shape, filter, analytics metric, error code, and the frontend auth flow) is in [docs/API.md](docs/API.md).

### Auth model

- `POST /auth/login` (or signup) returns a short-lived **access token** (default 15 m) and sets a **rotating refresh token** in an `httpOnly` cookie (`leadline_refresh`, scoped to `/api/v1/auth`, `Secure` in production, `SameSite=lax` by default).
- The SPA sends `Authorization: Bearer <accessToken>` on every call and renews via `POST /auth/refresh` **with credentials** (the cookie).
- Refresh tokens rotate on every use. Presenting an already-rotated token is treated as theft: **all** of that user's sessions are revoked and the event is audited.
- Passwords are argon2id. Refresh tokens and API keys are stored only as SHA-256 hashes.

### Endpoints

| Area | Endpoint | Notes |
|---|---|---|
| Health | `GET /health`, `GET /ready` | liveness / DB reachability (root path, no `/api/v1`) |
| Auth | `POST /api/v1/auth/signup` | `{workspaceName, name, email, password}` → new workspace + OWNER |
| | `POST /api/v1/auth/login` · `POST /auth/refresh` · `POST /auth/logout` · `GET /auth/me` | |
| | `POST /api/v1/auth/invite` | OWNER/ADMIN; `{email, role: ADMIN\|MEMBER}` → invite link (emailed if SMTP configured) |
| | `POST /api/v1/auth/accept-invite` | `{token, name, password}` |
| | `POST /api/v1/auth/password/change` · `…/password/reset-request` · `…/password/reset` | reset-request always returns 200 (no user enumeration) |
| Workspace | `GET /api/v1/workspace` · `GET /workspace/users` | settings + members |
| | `PATCH /api/v1/workspace/settings` | OWNER/ADMIN; changing `tierThresholds`/`winProbabilityMap` recomputes all leads |
| | `GET /api/v1/workspace/credentials` · `DELETE …/:kind` | OWNER/ADMIN (masked status + disconnect); `PUT …/:kind` is **developer-only** (kinds: `GMAIL_IMAP` fallback, `N8N_WEBHOOK`); values AES-256-GCM-encrypted, returned **masked only** |
| | `GET/POST /api/v1/workspace/api-keys` · `DELETE /workspace/api-keys/:id` | **developer-only**; the full key is returned **exactly once** at creation |
| Pipeline | `POST /api/v1/workspace/gmail/connect` | OWNER/ADMIN; returns the Google consent URL — clients connect their inbox by signing in |
| | `GET /api/v1/auth/google/callback` | public (Google redirects here); stores the workspace's `GMAIL_OAUTH` refresh token, bounces back to Settings |
| | `POST /api/v1/workspace/scan` | OWNER/ADMIN; kicks off an inbox scan in the background → `202 { started: true }` |
| | `GET /api/v1/workspace/scan/status` | `{ configured, method, email, googleSignInAvailable, aiReady, running, progress, lastScanAt, pollMinutes, lastResult, lastError }` — `progress` reports live per-email counts while a scan runs |
| Platform | `GET/PUT/DELETE /api/v1/platform/credentials[/:kind]` | **developer-only**; kinds: `ANTHROPIC_API_KEY` (universal AI key), `GOOGLE_OAUTH_CLIENT` (value = client secret, `meta.clientId`) |
| Leads | `GET /api/v1/leads` | filters/sort/search/pagination + `aggregates` (see below) |
| | `GET /api/v1/leads/export.csv` | same filters, CSV download |
| | `GET /api/v1/leads/:id` | full record incl. `threads`, `timeline`, `timeInStageHours` |
| | `POST /api/v1/leads` | manual add; computes tier/winProbability/expectedValue |
| | `PATCH /api/v1/leads/:id` | **safe fields only** (see below) |
| | `DELETE /api/v1/leads/:id` | OWNER/ADMIN; soft delete; audited |
| Analytics | `GET /api/v1/analytics?from&to` | funnel, win rate, won value, weekly trends, first-response time, source performance, score calibration |
| Ingest | `POST /api/v1/ingest/leads` | **`x-api-key` auth (not user auth)**; idempotent upsert by `externalId` |

### Lead list filters (`GET /leads`)

`stage`, `tier`, `inquiryType`, `source`, `ownerId` (all multi-value: repeat the param or comma-separate; `ownerId` accepts the literal `unassigned`) · `fitMin`/`fitMax`, `urgencyMin`/`urgencyMax`, `leadMin`/`leadMax` (0–10) · `receivedFrom`/`receivedTo`, `followUpFrom`/`followUpTo` (ISO dates) · `overdue=true` (past follow-up on a non-closed stage) · `expectedMin`/`expectedMax` · `replySent` · `needsAttention=true` (hot **or** overdue **or** unassigned-and-received-within-7-days) · `search` (name/org/email/summary/notes, case-insensitive) · `sort` (`receivedAt`, `leadScore`, `fitScore`, `urgencyScore`, `expectedValue`, `winProbability`, `followUpDate`, `name`, `org`, `stage`, `lastTouchedAt`, `createdAt`) · `order` (`asc`/`desc`) · `page`, `pageSize` (max 200).

Response: `{ items, page, pageSize, total, aggregates }` where `aggregates` — computed under the **same filters** — contains `countByStage`, `countByTier`, `pipelineExpectedValue` (open stages only), `wonCount`, `wonValue`, `overdueCount`, `unassignedCount`, `needsAttentionCount`, `total`.

### PATCH safe fields

`PATCH /leads/:id` accepts **only**: `stage`, `ownerId` (user id or `null`/`"unassigned"`), `followUpDate`, `notes`, `replySent`, `winProbability`. Anything else — AI-scored or computed fields — is rejected with `400` and the offending field names listed. Each change appends the matching timeline event (`stage_change`, `owner_change`, `follow_up_set`, `note_added`, `reply_sent`, `win_probability_set`) and bumps `lastTouchedAt`.

> **Design note:** `winProbability` is deliberately the one human-overridable computed field (the data model calls it "human-overridable"). Patching it sets an override flag, recomputes `expectedValue`, and the override **survives re-ingestion** and settings recomputes.

---

## Prerequisites

A Linux server (home box or VM) with Docker Engine + the compose plugin:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER   # log out/in afterwards
docker compose version           # v2.20+ required (compose "include")
```

Clone this repo onto the server.

## Generating secrets

```bash
cp .env.example .env
# 32-byte key for AES-256-GCM secret encryption:
openssl rand -base64 32    # → APP_ENCRYPTION_KEY
# JWT signing secrets (MUST be different from each other):
openssl rand -base64 48    # → JWT_ACCESS_SECRET
openssl rand -base64 48    # → JWT_REFRESH_SECRET
# Backup encryption passphrase:
openssl rand -base64 32    # → BACKUP_ENCRYPTION_KEY
# And a strong POSTGRES_PASSWORD of your choosing.
```

Fill them into `.env`. Every variable is documented inline in [.env.example](.env.example). **Never commit `.env`** (it's gitignored). The server validates configuration at boot and refuses to start with missing or weak values.

## At-rest encryption — three layers

| Layer | What | How |
|---|---|---|
| 1. Application | Integration secrets — platform (`PlatformCredential`: universal Anthropic key, Google OAuth client secret) and per-workspace (`Credential`: Google refresh token, app-password fallback, webhook signing secret) | AES-256-GCM with `APP_ENCRYPTION_KEY`; API returns masked values only (`sk-…1234`) |
| 2. Disk | Everything in Postgres (incl. lead PII) | **Full-disk encryption (LUKS) on the host partition** holding `/var/lib/docker/volumes` — an operator step, since Postgres has no free built-in TDE. Easiest at OS install time (choose encrypted LVM); retrofitting: `cryptsetup luksFormat` on a dedicated data partition, then move the Docker data root onto it. |
| 3. Backups | Nightly dumps | `pg_dump \| gzip \| gpg --symmetric` (AES-256) with `BACKUP_ENCRYPTION_KEY` |

Passwords: argon2id. API keys and refresh tokens: SHA-256 hashes only — the raw values are never stored and never logged (secrets are redacted from logs).

**Key rotation** (`APP_ENCRYPTION_KEY`): decrypt with the old key, re-encrypt with the new. One-off script pattern:

```bash
OLD_KEY=<old> NEW_KEY=<new> npx tsx -e "
import { PrismaClient } from '@prisma/client'
import { decryptSecret, encryptSecret } from './src/crypto/secrets.js'
const prisma = new PrismaClient()
const oldKey = Buffer.from(process.env.OLD_KEY!, 'base64')
const newKey = Buffer.from(process.env.NEW_KEY!, 'base64')
for (const c of await prisma.credential.findMany()) {
  await prisma.credential.update({ where: { id: c.id },
    data: { encryptedValue: encryptSecret(decryptSecret(c.encryptedValue, oldKey), newKey) } })
}
await prisma.\$disconnect(); console.log('rotated')
"
# then set APP_ENCRYPTION_KEY=<new> in .env and restart the api
```

**Column-level PII encryption** (lead names/emails) is deliberately **off**: it would break server-side search and sort on those columns. Disk encryption (layer 2) covers PII at rest for this deployment model.

## First run

```bash
# api + db + dashboard + nightly backups (everything bound to localhost only):
docker compose up -d --build

# home hosting (recommended): adds the Cloudflare Tunnel
docker compose --profile home up -d --build

# or with your own domain + open port 443: adds Caddy (auto-HTTPS)
docker compose --profile domain up -d --build
```

Database migrations run automatically when the `api` container starts (`prisma migrate deploy` in the entrypoint). Check:

```bash
docker compose ps
curl -s http://127.0.0.1:8080/health   # {"status":"ok"}   (API direct)
curl -s http://127.0.0.1:8080/ready    # {"status":"ready"}
open http://127.0.0.1:8081             # the dashboard (web service: SPA + /api proxy)
```

The `web` service serves the built dashboard and proxies `/api` to the API — app and API share one origin, so cookies and CORS need no extra configuration.

### Optional: load the demo workspace

The seed creates the fictional **"Fieldstone Training Group"** workspace (3 users, 34 leads across all stages) so the dashboard demos end-to-end. It needs Node on the machine running it and a network path to Postgres. On the server:

```bash
# 1. uncomment the db "ports: 127.0.0.1:5433:5432" lines in docker/docker-compose.yml
docker compose up -d db
# 2. from this repo:
npm ci
DATABASE_URL="postgresql://leadline:$POSTGRES_PASSWORD@127.0.0.1:5433/leadline" npm run seed
# 3. re-comment the port mapping and `docker compose up -d db` again
```

The seed is idempotent (re-running updates instead of duplicating) and prints the demo login credentials when done.

## Create the first workspace

```bash
API=http://127.0.0.1:8080   # or your public URL later

# Signup — creates YOUR workspace and its OWNER account
curl -s $API/api/v1/auth/signup -H 'content-type: application/json' -d '{
  "workspaceName": "Fieldstone Training Group",
  "name": "Avery Fieldstone",
  "email": "you@yourdomain.com",
  "password": "a-long-unique-passphrase"
}'
```

(Or just open the dashboard and use the signup screen — same thing.) Then connect the inbox — see [Built-in inbox scanning](#built-in-inbox-scanning) below.

## Expose it

### Option A — Cloudflare Tunnel (recommended for home hosting)

No port-forwarding, no static IP, no exposed inbound ports, free TLS + basic DDoS protection.

1. Cloudflare dashboard → **Zero Trust → Networks → Tunnels → Create a tunnel** (Cloudflared connector).
2. Copy the tunnel **token** into `CLOUDFLARE_TUNNEL_TOKEN` in `.env`.
3. Add a **Public hostname**: `leadline.yourdomain.com` → service `http://web:80` (dashboard + API on one hostname; add `api.yourdomain.com → http://api:8080` too only if something external needs the API without the dashboard).
4. `docker compose --profile home up -d`

### Option B — Caddy + your own domain

Requires a domain pointed at your IP (use DDNS if dynamic) and **only port 443/80 forwarded** to the server.

1. Set `LEADLINE_DOMAIN=leadline.yourdomain.com` in `.env`.
2. `docker compose --profile domain up -d` — Caddy provisions Let's Encrypt certificates automatically and proxies to the `web` service (dashboard + `/api`).

Either way, the api and web containers are bound to `127.0.0.1` — the edge is the only public entry point, and all public traffic is TLS.

## Built-in inbox scanning

The pipeline is part of this service — no external workflow tool. On the schedule set in Settings (default every 15 minutes), the API connects to the workspace's Gmail inbox over IMAP, reads mail newer than the last scan, scores each message with the Anthropic API (`claude-opus-4-8`, structured outputs), and upserts leads straight into Postgres. Genuine inquiries land in **New**; newsletters/receipts/spam are filed to the **Spam** stage so nothing silently disappears. Mail sent from the workspace's own address is skipped, at most 25 emails are scored per scan, and the first scan looks back 7 days.

### What a client does (once)

Settings → Connection → **Sign in with Google** with the account that receives inquiries. That's the whole setup: no keys, no app passwords, no billing. Then **Scan now** to test, and pick a schedule. Disconnecting is one click in the same place.

### What the developer does (once per deployment)

Sign in with an account whose email is in `DEVELOPER_EMAILS` (default: `kaz.keller20@gmail.com`) — it carries a **Developer** title in the dashboard, and Settings → Connection grows a Platform section:

1. **Universal Anthropic key** — create one at [console.anthropic.com](https://console.anthropic.com) and store it in the Platform card (or `PUT /api/v1/platform/credentials/ANTHROPIC_API_KEY`). One key scores every workspace's mail; the platform absorbs the AI bill.
2. **Google OAuth client** — in [Google Cloud Console](https://console.cloud.google.com): create a project → **APIs & Services → OAuth consent screen** (External) → **Credentials → Create credentials → OAuth client ID** (Web application) with authorized redirect URI `PUBLIC_URL/api/v1/auth/google/callback`. Store the client ID + secret in the Platform card. The flow requests the `https://mail.google.com/` scope (IMAP read access).
   - **Verification caveat:** that scope is restricted, so an app left in "Testing" status only works for test users you list, and their refresh tokens expire after about 7 days. Publish the app — and complete Google's verification when you outgrow its unverified limits — before onboarding real clients. Check Google's current OAuth verification docs; these rules change.
3. **App-password fallback** — for a mailbox that can't use sign-in, the developer can still store a Gmail app password per workspace (`PUT /api/v1/workspace/credentials/GMAIL_IMAP`, `meta: {email, host?, port?}` — any IMAP server works). Sign-in takes priority when both exist.

Secrets are AES-256-GCM-encrypted at rest and only ever shown masked. Each workspace stores only its own Google **refresh token** (`GMAIL_OAUTH` credential); the scanner trades it for short-lived access tokens at scan time (IMAP XOAUTH2). Clients can check status and scan any time:

```bash
curl -s -X POST $API/api/v1/workspace/scan -H "authorization: Bearer $TOKEN"    # → 202
curl -s $API/api/v1/workspace/scan/status -H "authorization: Bearer $TOKEN"    # → method, email, progress, last result
```

### Conversations merge into one lead

A lead is a **conversation**, not a single email. Messages thread together by their `References`/`In-Reply-To` headers (with a sender + "Re:"-subject fallback for clients that drop them), so when a prospect replies, the new email **merges into the same lead**: the message joins the lead's email thread, an `email_received` event lands on its timeline, and Claude re-assesses the deal *with the full exchange as context* — summary, scores, deal value, next step, and the draft reply all reflect where the conversation now stands. First-contact date and everything humans own (stage, owner, follow-up, notes, a win-probability override) are never touched by a merge.

Your side of the conversation is tracked too: each scan also reads the account's **sent mail** and attaches your replies to the matching lead — the reply appears in the thread (outbound), `replySent` flips on, a `reply_sent` event hits the timeline, and a lead still sitting in the first stage auto-advances to the contacted stage (leads a human has already moved are left alone).

Re-scans are idempotent — conversations are keyed by their thread root, already-seen messages are recognized (and spend no AI calls), nothing ever duplicates.

## Optional: push leads from an external tool

If something outside Leadline (a script, Zapier, a custom scraper) produces already-scored leads, it can deliver them to the ingest webhook instead of — or alongside — inbox scanning:

- Create an ingest API key (Settings → Connection → External lead push, or `POST /api/v1/workspace/api-keys`); the full key is shown **only once**.
- **POST** `https://api.yourdomain.com/api/v1/ingest/leads` with header `x-api-key: llk_…` and the camelCase payload documented in [docs/API.md §8](docs/API.md). Upsert is by `externalId` — retries never duplicate.

**Optional HMAC hardening:** set `INGEST_HMAC_ENABLED=true` in `.env`, store a shared secret via `PUT /api/v1/workspace/credentials/N8N_WEBHOOK` (`{"value":"<random secret>"}`), and have the sender include `x-signature` = hex HMAC-SHA256 of the raw JSON body with that secret. Once the secret exists, unsigned or mis-signed requests are rejected.

## The dashboard

The dashboard ships in this repo (`web/`) and is served by the `web` compose service on the same origin as the API — no wiring needed. Sign in at your public hostname (or `http://127.0.0.1:8081` on the box) with the account you created above. Set `CORS_ORIGIN` in `.env` to that origin (it is also used for invite/reset links).

Only if you host a **separate** dashboard on a different origin do you need CORS: set `CORS_ORIGIN` to that origin and use a fetch wrapper like this:

```ts
// apiDataService.ts — pattern for an externally-hosted client
const BASE = import.meta.env.VITE_API_URL ?? 'https://api.yourdomain.com'
let accessToken: string | null = null

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include', // refresh cookie
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401 && retry) {
    const r = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' })
    if (r.ok) {
      accessToken = (await r.json()).accessToken
      return request<T>(path, init, false)
    }
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}) as { error?: string })
    throw Object.assign(new Error(body.error ?? res.statusText), { status: res.status })
  }
  return res.json() as Promise<T>
}

export const dataService = {
  login: async (email: string, password: string) => {
    const out = await request<{ accessToken: string; user: unknown }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    })
    accessToken = out.accessToken
    return out.user
  },
  me: () => request('/auth/me'),
  logout: () => request('/auth/logout', { method: 'POST' }).finally(() => (accessToken = null)),
  listLeads: (filters: Record<string, string>) => request(`/leads?${new URLSearchParams(filters)}`),
  getLead: (id: string) => request(`/leads/${id}`),
  updateLead: (id: string, patch: object) => request(`/leads/${id}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  addLead: (partial: object) => request('/leads', { method: 'POST', body: JSON.stringify(partial) }),
  getSettings: () => request('/workspace'),
  updateSettings: (patch: object) => request('/workspace/settings', { method: 'PATCH', body: JSON.stringify(patch) }),
}
```

If the dashboard and API live on sibling subdomains of one domain, set `COOKIE_DOMAIN=yourdomain.com` and keep `COOKIE_SAMESITE=lax`. If they're on entirely different domains, set `COOKIE_SAMESITE=none` (requires HTTPS).

## Running this responsibly

Self-hosting other businesses' lead data means **you** own uptime, security and data protection:

- **Client names and emails are personal data.** A breach is a real liability. The encryption layers, the no-inbound-ports tunnel, workspace isolation and the audit log mitigate — they do not eliminate — that risk. Consider a simple written data-handling understanding with each client, and understand your local data-protection obligations (GDPR/CCPA equivalents). *This is not legal advice.*
- **A home connection has no uptime guarantee.** Fine while dogfooding and for early, low-stakes clients; risky once someone pays for an SLA. The cloud-migration path below exists for exactly that moment.
- **Backups only count if they restore.** Keep them encrypted, copy them off-box, and run the restore drill at least once (below).
- Patch the host OS regularly; pull updated images (see [Updating](#updating)); consider Uptime Kuma for monitoring.

## Backups & restore

The `backup` service runs a **nightly encrypted dump** (default `BACKUP_CRON=15 2 * * *` UTC, plus one dump at container start) into the `backups` volume, pruning files older than `BACKUP_RETENTION_DAYS` (default 14).

```bash
# list backups
docker compose exec backup ls -lh /backups

# copy the newest off-box (do this regularly — an on-box backup is only half a backup)
docker compose cp backup:/backups/leadline-2026-07-15_021500.sql.gz.gpg ./
scp leadline-*.sql.gz.gpg you@offsite:/safe/place/

# decrypt manually if ever needed
gpg --batch --passphrase "$BACKUP_ENCRYPTION_KEY" -d leadline-….sql.gz.gpg | gunzip > dump.sql
```

**Restore drill — actually do this once** before you rely on it:

```bash
docker compose exec backup restore.sh /backups/leadline-<stamp>.sql.gz.gpg
# The dump is --clean --if-exists: it drops and recreates objects in place.
docker compose restart api && curl -s http://127.0.0.1:8080/ready
```

## Updating

```bash
git pull
docker compose build --pull api backup
docker compose up -d          # add your --profile flag
docker image prune -f
```

Keep the host OS patched (`unattended-upgrades` on Debian/Ubuntu). Watchtower can auto-pull base images if you accept the tradeoff of unattended restarts.

## Cloud migration checklist

Everything is Docker + `.env` — no host-specific paths, no code changes:

1. Provision a VM (any provider), install Docker + compose.
2. Clone this repo; copy your `.env` over (secure channel!).
3. Copy the latest backup file to the VM.
4. `docker compose up -d db`, then run the restore drill command above.
5. `docker compose --profile domain up -d` (or move the Cloudflare Tunnel: same token = zero DNS changes).
6. Verify `/ready`, log in, confirm leads are present; update `CORS_ORIGIN`/DNS if hostnames changed.
7. Decommission the home box's tunnel/port-forward.

## Local development & tests

No Docker needed locally — an embedded PostgreSQL 16 lives in `node_modules`:

```bash
npm ci
npm run dev:db      # embedded Postgres 16 on 127.0.0.1:54322 (data in .devdb/)
npm run dev         # API with reload (set DATABASE_URL from dev:db output in .env)
npm test            # spins up a disposable embedded Postgres, migrates, runs vitest
npm run build       # tsc → dist/
npm run lint        # typecheck
npx tsx scripts/dev-db.ts -- npx prisma migrate dev   # create a new migration
npx tsx scripts/dev-db.ts -- npx tsx prisma/seed.ts   # seed the dev database

# dashboard (in a second terminal, with dev:db + dev running):
cd web
npm ci
npm run dev         # http://localhost:5173 — proxies /api to 127.0.0.1:8080
npm run build       # typecheck + production bundle
```

Tests cover auth (signup/login/refresh rotation/reuse detection/invites/roles/password change+reset), workspace isolation, lead CRUD, every list filter, aggregates, sorting, pagination, CSV, analytics, safe-field enforcement, credential encryption/masking, ingest (key auth, idempotent upsert, human-field preservation, HMAC), the inbox-scanning pipeline (configuration gating, role checks, idempotent re-scans, spam routing, scan-cursor overlap, per-email error isolation — with the IMAP fetch and Claude scoring stubbed out), and the platform tier (developer allowlist gating, platform credential encryption, the Google connect/callback flow with stubbed token exchange, OAuth-based scanning, client lockdown of keys).

## Design decisions & defaults

Chosen where the spec left room; all adjustable per workspace via `PATCH /workspace/settings`:

- **Stages:** `New, Contacted, Qualified, Proposal sent, Closed won, Closed lost, Not fit, Spam`; closed = the last four.
- **Tiers:** hot ≥ 8, warm 5–7, cold ≤ 4 (`tierThresholds`).
- **Win probability map:** 9–10 → 0.55 · 7–8 → 0.35 · 5–6 → 0.18 · 3–4 → 0.07 · 0–2 → 0.02.
- **expectedValue** = midpoint of the deal range × winProbability; recomputed on every relevant write and on settings changes (manual winProbability overrides survive).
- **needsAttention** = hot OR overdue OR (unassigned AND received within 7 days).
- **Deletes are soft** (`deletedAt`), excluded from all queries, audited.
- **Invites without SMTP** return the invite link in the API response (the inviter is authenticated). **Password-reset links without SMTP** are written to the server log only — returning them in the response would enable account takeover.
- **Rate limits:** global per-IP (default 120/min), tighter on auth endpoints (10/min), per-key on ingest (600/min). Body limit 1 MiB.
- **Audit log** records signups, logins (incl. failures), refresh-reuse detections, password changes/resets, invites, credential and API-key changes, settings updates and lead deletions, with IP.
- Wire format matches the dashboard contract 1:1 (camelCase, ISO-8601 dates).
