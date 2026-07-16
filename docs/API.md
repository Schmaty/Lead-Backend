# Leadline API — complete reference

Everything this backend can do, field by field, and exactly what a frontend must do to use it. Operational setup (Docker, secrets, backups) lives in the [README](../README.md). A complete reference client — the Leadline Lead Desk dashboard — lives in [web/](../web/) and consumes exactly this API.

- **Base URL:** `https://<your-api-host>` — all business endpoints live under `/api/v1`. Health probes live at the root.
- **Wire format:** JSON, camelCase, UTF-8. All timestamps are ISO-8601 strings (`2026-07-06T14:12:00.000Z`). Send `content-type: application/json` on every request with a body — no other body content type is accepted.
- **Two auth schemes:** user endpoints use a Bearer access token (+ refresh cookie); the ingest webhook uses an `x-api-key` header. They never mix.

---

## 1. How the frontend authenticates

### The token pair

| Credential | Where it lives | Lifetime | Purpose |
|---|---|---|---|
| **Access token** (JWT) | Returned in JSON by signup/login/refresh. Keep it **in memory** (not localStorage). | 15 min (config) | Sent as `Authorization: Bearer <token>` on every API call |
| **Refresh token** (opaque) | `leadline_refresh` cookie — `httpOnly`, `Secure` (prod), `SameSite=lax`, **path `/api/v1/auth`** | 30 days (config) | Only travels to `/api/v1/auth/*`; used by `POST /auth/refresh` to mint a new pair |

The frontend never reads or writes the cookie — the browser handles it. What the frontend **must** do:

1. Call auth endpoints with **`credentials: 'include'`** so the cookie is set/sent cross-origin.
2. Keep the latest `accessToken` in a variable and attach it as a Bearer header everywhere.
3. On any `401`, call `POST /api/v1/auth/refresh` (with credentials) once; if it succeeds, store the new token and retry the original request once; if it fails, route to the login screen.
4. On logout, call `POST /auth/logout` (with credentials) and drop the in-memory token.

```ts
// Minimal session core (full dataService wrapper in the README)
let accessToken: string | null = null

async function apiFetch<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  })
  if (res.status === 401 && retry) {
    const r = await fetch(`${BASE}/api/v1/auth/refresh`, { method: 'POST', credentials: 'include' })
    if (r.ok) { accessToken = (await r.json()).accessToken; return apiFetch<T>(path, init, false) }
  }
  if (!res.ok) throw Object.assign(new Error((await res.json().catch(() => ({})))?.error ?? res.statusText), { status: res.status })
  return res.json()
}
```

**Refresh rotation & theft detection:** every `/auth/refresh` invalidates the presented refresh token and issues a new one. If a rotated token is presented again *within* `REFRESH_REUSE_GRACE` (default 10 s) it is treated as a benign multi-tab race: that request gets a plain `401` (without clearing the cookie — the parallel tab's newer cookie stays valid). Presented *after* the grace window, it is treated as theft: **all** sessions for that user are revoked and the API answers `401` with `"Refresh token reuse detected — all sessions revoked"` — treat that as a forced logout. Frontends should still de-duplicate concurrent refresh calls (share one in-flight promise).

**CORS:** the server allows only the origins in its `CORS_ORIGIN` env (with credentials). If the dashboard origin isn't listed there, every browser call fails preflight — that's configuration, not a frontend bug.

### Roles

| Role | Can do |
|---|---|
| `MEMBER` | Everything on leads (list/read/create/patch) + analytics + read workspace/users |
| `ADMIN` | MEMBER + invite users, manage credentials, manage API keys, edit settings, delete leads |
| `OWNER` | ADMIN (one per workspace, created by signup) |

Calls that exceed the caller's role return `403 { "error": "Requires role: OWNER or ADMIN" }`.

### Error contract (all endpoints)

| Status | Body | When |
|---|---|---|
| 400 | `{ "error": "Validation failed", "details": [{ "path": "email", "message": "…" }] }` | schema validation |
| 400 | `{ "error": "<message>", "details"?: … }` | domain rules (unknown stage, bad owner, unsafe PATCH field, …) |
| 401 | `{ "error": "<message>" }` | missing/expired/invalid token, bad login, bad API key/signature |
| 403 | `{ "error": "<message>" }` | insufficient role / missing scope |
| 404 | `{ "error": "Lead not found" }` etc. | wrong id **or** the row belongs to another workspace (indistinguishable by design) |
| 409 | `{ "error": "…already exists" }` | duplicate email on signup/invite |
| 413 | `{ "error": "…" }` | body over 1 MiB |
| 429 | `{ "error": "Rate limit exceeded, retry in 1 minute" }` | rate limit (global 120/min/IP; auth endpoints 10/min/IP; ingest 600/min/key — all configurable) |
| 500 | `{ "error": "Internal server error" }` | logged server-side, never detailed to clients |

---

## 2. Health

| Method & path | Auth | Returns |
|---|---|---|
| `GET /health` | none | `{ "status": "ok" }` — process liveness |
| `GET /ready` | none | `{ "status": "ready" }`, or `503 { "status": "unavailable" }` if Postgres is unreachable |

---

## 3. Auth endpoints (`/api/v1/auth`)

### `POST /auth/signup` — create a workspace + its OWNER
Body: `{ workspaceName, name, email, password }`. Password policy: ≥ 12 chars, not a common password, must not contain your email's local part.
`201` → `{ accessToken, user, workspace }` + refresh cookie. One signup = one brand-new workspace. `409` if the email exists anywhere.

### `POST /auth/login`
Body: `{ email, password }` → `200 { accessToken, user }` + refresh cookie. Failures are a uniform `401 "Invalid email or password"` (no user enumeration). Updates `lastLoginAt`; audited (including failed attempts).

### `POST /auth/refresh`
No body; needs the cookie (`credentials: 'include'`). → `200 { accessToken, user }` + a **new** refresh cookie. `401` on missing/expired/reused token (see rotation above).

### `POST /auth/logout`
No body; needs the cookie. Revokes the refresh token, clears the cookie. Always `200 { ok: true }`.

### `GET /auth/me` (Bearer)
→ `{ user: { id, name, email, role, lastLoginAt, createdAt }, workspace: { id, name, slug, settings } }`. Call this on app boot (after a silent refresh) to hydrate session + settings in one round trip.

### `POST /auth/invite` (Bearer, OWNER/ADMIN)
Body: `{ email, role: "ADMIN" | "MEMBER" }` → `{ inviteUrl, token, emailed, expiresInSec }`.
- If SMTP is configured server-side, the invite is emailed (`emailed: true`).
- Otherwise the frontend should show `inviteUrl` for manual sharing. The URL points at `<dashboard-origin>/accept-invite?token=…` — the dashboard needs a route there that collects name + password and calls accept-invite.
- `409` if the email is already registered. Tokens expire (default 7 days).

### `POST /auth/accept-invite`
Body: `{ token, name, password }` → `201 { accessToken, user, workspace }` + cookie (auto-login). `400` invalid/expired token, `409` email already registered.

### `POST /auth/password/change` (Bearer)
Body: `{ currentPassword, newPassword }` → `200 { ok: true, accessToken }`. Revokes **all** refresh tokens, then issues a fresh cookie+token for this client — other devices are logged out.

### `POST /auth/password/reset-request`
Body: `{ email }` → **always** `200 { ok: true }` (no enumeration). If the account exists: with SMTP the reset link is emailed; without SMTP it is written to the **server log** only (operator delivers it manually — deliberately never returned in the response).

### `POST /auth/password/reset`
Body: `{ token, newPassword }` → `200 { ok: true }`. The token is single-use (it embeds a fingerprint of the old password hash) and expires (default 1 h). All sessions are revoked; user must log in again.

---

## 4. The Lead object

Returned by every lead endpoint. Fields marked ⚙ are computed server-side; ✍ are the human-editable "safe" fields; everything else is AI/ingest-owned.

```ts
interface Lead {
  id: string
  externalId: string | null      // email Message-ID / external id (null for manually added leads)
  receivedAt: string             // ISO date the inquiry arrived
  name: string; email: string; org: string
  source: string                 // e.g. "Website form" | "Email" | "Referral" | "Event" | "Other"
  inquiryType: string            // from workspace settings.inquiryTypes
  summary: string
  fitScore: number               // 0–10 (AI)
  urgencyScore: number           // 0–10 (AI)
  leadScore: number              // 0–10 (AI)
  tier: 'hot' | 'warm' | 'cold'          // ⚙ from leadScore vs settings.tierThresholds
  dealValueLow: number; dealValueHigh: number
  estPayoutRaw: string
  winProbability: number         // ⚙ default from settings.winProbabilityMap; ✍ human-overridable
  winProbabilityOverridden: boolean      // ⚙ true once a human set winProbability
  expectedValue: number          // ⚙ ((low+high)/2) * winProbability, 2dp
  estWork: string; recommendedNextStep: string; draftReply: string
  fitReasons: string[]; riskFlags: string[]; inferredFields: string[]
  stage: string                  // ✍ one of settings.stages
  ownerId: string | null         // ✍ user id or null = Unassigned
  owner?: { id: string; name: string } | null   // joined for display
  followUpDate: string | null    // ✍
  replySent: boolean             // ✍
  lastTouchedAt: string          // ⚙ bumped on every human edit
  notes: string                  // ✍
  createdAt: string; updatedAt: string
  // GET /leads/:id only:
  threads?: Array<{ id: string; subject: string; url: string; direction: 'in' | 'out'; date: string; snippet: string }>
  timeline?: Array<{ id: string; type: string; at: string; actor: string; detail: string }>
  timeInStageHours?: number      // ⚙ hours since the last stage_change (or creation)
}
```

Timeline event `type` values: `created`, `stage_change`, `owner_change`, `follow_up_set`, `note_added`, `reply_sent`, `win_probability_set`. `actor` is a user's display name or `"system"` (inbox scanner / ingest webhook).

### Computed-field semantics

- **tier** — `hot` if `leadScore >= settings.tierThresholds.hot` (default 8), `warm` if `>= warm` (default 5), else `cold`.
- **winProbability** — highest matching band in `settings.winProbabilityMap` (defaults: 9–10 → 0.55, 7–8 → 0.35, 5–6 → 0.18, 3–4 → 0.07, 0–2 → 0.02) unless a human override is set — overrides survive re-ingestion **and** settings changes.
- **expectedValue** — deal-range midpoint × winProbability, rounded to 2 dp; recomputed whenever scores, deal values, winProbability or the settings inputs change.
- **overdue** (filter concept, not a stored field) — `followUpDate < now` AND stage not in `settings.closedStages`.
- **needsAttention** (filter concept) — `tier == hot` OR overdue OR (`ownerId == null` AND `receivedAt` within the last 7 days).

---

## 5. Lead endpoints (`/api/v1/leads`, Bearer)

### `GET /leads` — list + aggregates

Every query parameter (all optional, all combinable — they AND together):

| Param | Type | Meaning |
|---|---|---|
| `stage` | multi | stages to include — repeat the param (`stage=New&stage=Contacted`) or comma-separate (`stage=New,Contacted`) |
| `tier` | multi | `hot`, `warm`, `cold` |
| `inquiryType` | multi | match any of the given types |
| `source` | multi | match any of the given sources |
| `ownerId` | multi | user ids; the literal `unassigned` matches `ownerId = null` and can be mixed in (`ownerId=unassigned,<userId>`) |
| `fitMin` / `fitMax` | int 0–10 | inclusive fitScore range |
| `urgencyMin` / `urgencyMax` | int 0–10 | inclusive urgencyScore range |
| `leadMin` / `leadMax` | int 0–10 | inclusive leadScore range |
| `receivedFrom` / `receivedTo` | ISO date | inclusive receivedAt range |
| `followUpFrom` / `followUpTo` | ISO date | inclusive followUpDate range |
| `overdue` | `true` | past follow-up on a non-closed stage |
| `expectedMin` / `expectedMax` | number | inclusive expectedValue range |
| `replySent` | `true`/`false` | exact match |
| `needsAttention` | `true` | hot OR overdue OR recent-unassigned (see §4) |
| `search` | string ≤ 200 | case-insensitive substring across name, org, email, summary, notes |
| `include` | `threads,timeline` | embed those relations in each list item (the dashboard uses this for client-side analytics) |
| `sort` | enum | `receivedAt` (default) · `leadScore` · `fitScore` · `urgencyScore` · `expectedValue` · `winProbability` · `followUpDate` (nulls last) · `name` · `org` · `stage` · `lastTouchedAt` · `createdAt` |
| `order` | `asc`/`desc` | default `desc` |
| `page` | int ≥ 1 | default 1 |
| `pageSize` | int 1–200 | default 25 |

Response:

```jsonc
{
  "items": [ /* Lead[] with owner joined */ ],
  "page": 1, "pageSize": 25,
  "total": 34,                       // total matches (not just this page)
  "aggregates": {                    // computed under the SAME filters
    "total": 34,
    "countByStage": { "New": 7, "Contacted": 6, "Closed won": 5, "…": 0 },
    "countByTier": { "hot": 9, "warm": 14, "cold": 11 },
    "pipelineExpectedValue": 40758.4,   // Σ expectedValue over NON-closed stages only
    "wonCount": 5,
    "wonValue": 71500,                  // Σ deal-range midpoints of Closed-won leads
    "overdueCount": 4,
    "unassignedCount": 6,
    "needsAttentionCount": 12
  }
}
```

Dashboard patterns: the stat cards come straight from `aggregates` (no second request); the "Needs attention" view is just `?needsAttention=true`; a saved board filter is a query string.

### `GET /leads/export.csv`
Same query params as the list (filters + sort). Returns `text/csv` with `content-disposition: attachment`, capped at 10 000 rows. Columns: id, receivedAt, name, email, org, source, inquiryType, stage, tier, fitScore, urgencyScore, leadScore, dealValueLow, dealValueHigh, winProbability, expectedValue, owner, followUpDate, replySent, summary, notes. Cells are quoted/escaped and formula-injection-guarded.
**Frontend note:** the endpoint needs the Bearer header, so a plain `<a href>` won't authenticate — `fetch` it, then `URL.createObjectURL(await res.blob())` into a temporary anchor.

### `GET /leads/:id`
Full Lead including `threads` (chronological), `timeline` (chronological) and `timeInStageHours`. `404` if unknown **or** owned by another workspace.

### `POST /leads` — manual add
Body: `{ name, email }` required; optional (with defaults): `org ""`, `source "Other"`, `inquiryType "Other"`, `summary ""`, `fitScore 5`, `urgencyScore 5`, `leadScore 5`, `dealValueLow 0`, `dealValueHigh 0`, `estPayoutRaw`, `estWork`, `recommendedNextStep`, `draftReply`, `fitReasons []`, `riskFlags []`, `inferredFields []`, `stage "New"` (must be in settings.stages), `ownerId` (must be a workspace user, or `null`/`"unassigned"`), `followUpDate`, `notes ""`, `receivedAt` (defaults now), `replySent false`.
Unknown fields → `400`. `201` → the full Lead (tier/winProbability/expectedValue computed, `created` timeline event written with the caller as actor).

### `PATCH /leads/:id` — safe fields only
Accepts **exactly** these keys; any other key fails the whole request:

| Field | Value | Side effects |
|---|---|---|
| `stage` | string in `settings.stages` | `stage_change` event (`"New → Contacted"`) |
| `ownerId` | workspace user id, `null`, or `"unassigned"` | `owner_change` event with names |
| `followUpDate` | ISO date or `null` | `follow_up_set` event |
| `notes` | string ≤ 20 000 | `note_added` event |
| `replySent` | boolean | `reply_sent` event (feeds first-response analytics) |
| `winProbability` | number 0–1 | sets the override flag, recomputes `expectedValue`, `win_probability_set` event |

Rejection shape (nothing is applied):

```json
{ "error": "These fields are AI-scored or computed and cannot be patched",
  "details": { "rejectedFields": ["leadScore"],
               "allowedFields": ["stage","ownerId","followUpDate","notes","replySent","winProbability"] } }
```

No-op patches (same values) write no events. Any real change bumps `lastTouchedAt`. `200` → the updated Lead.

### `DELETE /leads/:id` (OWNER/ADMIN)
Soft delete — the lead disappears from every list/detail/aggregate/analytics query but the row is retained (`deletedAt`). Audited. `200 { ok: true }`; `403` for MEMBER; `404` unknown/foreign.

---

## 6. Analytics (`GET /api/v1/analytics`, Bearer)

Query: `from`, `to` (ISO dates; default = the last 90 days). The window filters on `receivedAt`. Soft-deleted leads are excluded. Everything is computed per-workspace.

```jsonc
{
  "range": { "from": "…", "to": "…" },
  "totalLeads": 34,
  "funnel": [ { "stage": "New", "count": 7 }, … ],   // in settings.stages order
  "winRate": 0.63,          // wonCount / (wonCount + lostCount); null if nothing decided
  "wonCount": 5, "lostCount": 3,
  "avgDealSize": 14300,     // mean deal-range midpoint of Closed-won leads; null if none
  "totalWonValue": 71500,   // Σ midpoints of Closed-won leads
  "pipelineExpectedValue": 40758.4,   // Σ expectedValue of open (non-closed) leads
  "leadsPerWeek": [ { "week": "2026-W25", "count": 4 }, … ],          // ISO week of receivedAt
  "expectedPipelineTrend": [ { "week": "2026-W25", "expectedValue": 9060 }, … ],  // open leads by received week
  "firstResponse": {
    "avgHours": 5.2,        // receivedAt → first reply_sent timeline event; null if no replies yet
    "trend": [ { "week": "2026-W25", "avgHours": 6.1 }, … ]
  },
  "sourcePerformance": [
    { "source": "Email", "count": 12, "won": 2, "lost": 1, "winRate": 0.67, "wonValue": 21000 }, …
  ],
  "scoreCalibration": [     // does the AI score predict reality? win rate per leadScore band
    { "band": "0-2", "count": 3, "won": 0, "lost": 0, "winRate": null },
    { "band": "3-4", "count": 5, "won": 0, "lost": 2, "winRate": 0 },
    { "band": "5-6", "count": 9, "won": 1, "lost": 1, "winRate": 0.5 },
    { "band": "7-8", "count": 10, "won": 2, "lost": 0, "winRate": 1 },
    { "band": "9-10", "count": 7, "won": 2, "lost": 0, "winRate": 1 }
  ]
}
```

Chart mapping: funnel → bar/funnel chart; `leadsPerWeek` + `expectedPipelineTrend` + `firstResponse.trend` → line charts keyed by `week`; `sourcePerformance` → table or grouped bars; `scoreCalibration` → the "is the score honest?" bar chart. `winRate` fields are `null` (not 0) when no decided leads exist — render as "—".

---

## 7. Workspace endpoints (`/api/v1/workspace`, Bearer)

### `GET /workspace` (any role)
→ `{ id, name, slug, createdAt, settings, users: [{ id, name, email, role, lastLoginAt }] }`. This is the dashboard's `getSettings()`; `users` doubles as the owner-assignment dropdown.

### `GET /workspace/users` (any role)
→ `{ users: [...] }` — same user shape, when you only need the member list.

### `PATCH /workspace/settings` (OWNER/ADMIN)
Send any subset of:

| Key | Shape | Validation / effect |
|---|---|---|
| `tierThresholds` | `{ hot: 0–10, warm: 0–10 }` | warm ≤ hot; **recomputes every lead's tier** |
| `winProbabilityMap` | `[{ min: 0–10, p: 0–1 }, …]` | highest matching `min` wins; **recomputes winProbability + expectedValue** (overrides survive) |
| `stages` | `string[]` (1–30) | must still contain `wonStage`, `lostStage`, all `closedStages` |
| `closedStages` | `string[]` | subset of `stages`; drives overdue/pipeline logic |
| `wonStage` / `lostStage` | string | must be in `stages`; drive win-rate analytics |
| `sources` / `inquiryTypes` | `string[]` | pick-lists for the UI |
| `notificationThresholds` | `{ hotLeadScore: 0–10 }` | stored for the dashboard's use |
| `scanSettings` | `{ pollMinutes: 1–1440 }` | cadence of the built-in inbox scanner (see below) |
| `staleDays` | int 1–365 | stored for the dashboard's use |
| `stageRenames` | `[{ from, to }, …]` | applied **before** the rest of the patch: renames the stage in `stages`/`closedStages`/`wonStage`/`lostStage` **and** on every lead carrying the old name, atomically, without timeline noise. `from` must exist; `to` must not collide. |

→ `{ settings, recomputedLeads, renamedStages }` (`recomputedLeads` = how many leads changed). Unknown keys → 400. Audited.

### Credentials (OWNER/ADMIN) — integration secrets, encrypted at rest

| Kind | `value` (encrypted) | `meta` (plain JSON) | Used for |
|---|---|---|---|
| `GMAIL_IMAP` | the Gmail **app password** (Google Account → Security → 2-Step Verification → App passwords) | `{ email, host?, port?, lastScanAt? }` — `email` is required; `host`/`port` default to `imap.gmail.com:993`; `lastScanAt` is maintained by the scanner | the inbox the built-in scanner reads |
| `ANTHROPIC_API_KEY` | an Anthropic API key | — | scoring each scanned email with Claude |
| `N8N_WEBHOOK` | a shared signing secret | — | optional HMAC verification on the ingest webhook (§8) |

| Call | Body | Returns |
|---|---|---|
| `GET /workspace/credentials` | — | `{ credentials: [{ kind, maskedValue, meta, createdAt, updatedAt }] }` |
| `PUT /workspace/credentials/:kind` | `{ value, meta? }` | `{ kind, maskedValue, meta, updatedAt }` — upsert = rotation |
| `DELETE /workspace/credentials/:kind` | — | `{ ok: true }` (404 if absent) |

**The raw secret is never returned by any endpoint** — only masked (`sk-…0042`). Values are AES-256-GCM-encrypted in the database. The frontend should treat these as write-only: show the mask, offer "replace" and "delete".

### Inbox scanning (the built-in pipeline)

Once `GMAIL_IMAP` **and** `ANTHROPIC_API_KEY` are stored, the server polls the mailbox on the `scanSettings.pollMinutes` cadence: it fetches mail newer than the last scan over IMAP, scores each email with the Anthropic API (`claude-opus-4-8`, structured outputs — category, 0–10 fit/urgency/lead scores, deal-value estimate, next step, draft reply), and upserts a lead per email. The email's Message-ID is the `externalId`, so re-scans update rather than duplicate and human edits survive (§8 semantics). Irrelevant mail (newsletters, receipts, spam) is filed to the stage matching `/spam/i` — or dropped if no such stage exists; mail from the workspace's own address is skipped; at most 25 emails are scored per scan; the first scan looks back 7 days.

| Call | Role | Returns |
|---|---|---|
| `POST /workspace/scan` | OWNER/ADMIN | `202 { started: true }` — the scan runs in the background. `400` if the two credentials aren't stored, `409` if a scan is already running. Audited. |
| `GET /workspace/scan/status` | any | `{ configured, running, lastScanAt, pollMinutes, lastResult, lastError }` where `lastResult` = `{ at, scanned, imported, updated, skipped, errors: string[] }` |

Frontend flow for a "Scan now" button: POST, then poll status every ~2 s until `running` is false, then show `lastResult`/`lastError` and refresh the lead list.

### API keys (OWNER/ADMIN) — for external tools → ingest auth (optional)

Not needed for inbox scanning — only for something outside Leadline pushing leads to §8.

| Call | Body | Returns |
|---|---|---|
| `GET /workspace/api-keys` | — | `{ apiKeys: [{ id, name, prefix, scopes, lastUsedAt, revokedAt, createdAt }] }` |
| `POST /workspace/api-keys` | `{ name }` | `201 { id, name, prefix, key, warning }` — **`key` appears here once and never again** |
| `DELETE /workspace/api-keys/:id` | — | `{ ok: true }` — revocation is immediate |

Frontend: on create, show the full key in a copy-once dialog; afterwards only `prefix` (first 8 chars) identifies it. `lastUsedAt` is the "is the external pusher alive?" signal. Only the SHA-256 hash is stored server-side.

---

## 8. Ingest webhook (`POST /api/v1/ingest/leads`)

**Machine-to-machine only, and optional** — the built-in inbox scanner (§7) covers the normal path; this endpoint exists for external scripts or tools that produce already-scored leads. Authenticated by `x-api-key: <full key>` (not user auth, no cookie, no Bearer). The key resolves the workspace; rate limit 600/min per key; body limit 1 MiB. The scanner and this webhook share the same upsert, so both write identical leads.

Payload (unknown extra fields are ignored):

| Field | Type | Required | Notes |
|---|---|---|---|
| `externalId` | string | ✔ | any stable id for the source email/record — the idempotency key (the built-in scanner uses the email Message-ID) |
| `receivedAt` | ISO date | ✔ | |
| `name`, `email` | string | ✔ | email must be valid |
| `source`, `inquiryType` | string | ✔ | |
| `org`, `summary`, `estPayoutRaw`, `estWork`, `recommendedNextStep`, `draftReply` | string | — | default `""` |
| `fitScore`, `urgencyScore`, `leadScore` | int 0–10 | ✔ | |
| `dealValueLow`, `dealValueHigh` | number ≥ 0 | — | default 0 |
| `fitReasons`, `riskFlags`, `inferredFields` | string[] | — | default `[]` |
| `threads` | `[{ subject, url, direction: "in"\|"out", date, snippet }]` | — | replaces the stored set on every ingest |

Responses: `201 { id, created: true }` on first sight of an `externalId`; `200 { id, created: false }` on any re-run (the row is **updated, never duplicated** — sender retries are safe).

**Update semantics on re-ingest:** AI fields (scores, summary, deal values, draft, arrays, threads) are overwritten and tier/winProbability/expectedValue recomputed — but the human-owned fields (`stage`, `ownerId`, `followUpDate`, `notes`, `replySent`, and a manual `winProbability` override) are preserved. A `created` timeline event (actor `system`) is written only on first insert.

**Optional HMAC:** when the server runs with `INGEST_HMAC_ENABLED=true` **and** the workspace has an `N8N_WEBHOOK` credential stored, every ingest call must also send `x-signature: <hex HMAC-SHA256 of the raw request body, keyed by that secret>`; missing/invalid signatures → 401. Without the stored secret, the key alone authenticates.

---

## 9. dataService mapping (dashboard contract)

| dataService method | HTTP call |
|---|---|
| `login(email, password)` / `me()` / `logout()` | `POST /auth/login` · `GET /auth/me` · `POST /auth/logout` |
| `listLeads(filters)` | `GET /leads?<query>` → `{ items, total, aggregates, … }` |
| `getLead(id)` | `GET /leads/:id` |
| `updateLead(id, patch)` | `PATCH /leads/:id` (safe fields only) |
| `addLead(partial)` | `POST /leads` |
| `getSettings()` | `GET /workspace` |
| `updateSettings(patch)` | `PATCH /workspace/settings` |
| analytics page | `GET /analytics?from&to` |
| team management | `GET /workspace/users` · `POST /auth/invite` · `POST /auth/accept-invite` |
| integrations page | `GET/PUT/DELETE /workspace/credentials/:kind` · `GET/POST/DELETE /workspace/api-keys` |
| inbox scanning | `POST /workspace/scan` · `GET /workspace/scan/status` |

A ready-to-paste `apiDataService.ts` wrapper (with the 401-refresh-retry loop) is in the [README](../README.md#point-the-dashboard-at-it).
