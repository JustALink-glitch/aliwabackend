# Synqop API

Backend for Synqop V1 — multi-tenant programme operations for training organisations.
Product rules and screens: *Synqop Development Reference V1* and the Figma file `u0Cotvhu5Xk0mr2zoD5GYA`.

> The previous Training Ops code is in `legacy/` for reference only. It is not built or deployed from this branch.

## Stack

- Node 22, TypeScript, [Hono](https://hono.dev) on `@hono/node-server`
- Supabase: Postgres (queried directly with [postgres.js](https://github.com/porsager/postgres) so multi-step
  writes are transactions), Auth (sign-in and password reset), Storage
- Email: [Resend](https://resend.com) in production, console in development
- Zod for validation, Vitest for tests

## Endpoints so far

| Method | Path | Who | Screen |
|---|---|---|---|
| `POST` | `/v1/organisations` | Signed in, no organisation yet | R1 — creates the organisation; caller becomes owner |
| `GET` | `/v1/me` | Any member | User, membership, organisation |
| `GET` | `/v1/members?role=&status=` | Owner, admin | B1 / B2 lists (`role` takes a comma list) |
| `GET` | `/v1/members/:id` | Owner, admin | B2.02 — person, who invited them, invitation history |
| `POST` | `/v1/members` | Owner, admin | B1.02 / B2.03 — invite; emails a 72-hour link |
| `POST` | `/v1/members/:id/invitation` | Owner, admin | B2.02i — resend (old link stops working) |
| `DELETE` | `/v1/members/:id/invitation` | Owner, admin | B2.02i — revoke: cancels the link and removes the not-yet-joined person |
| `GET` | `/v1/programmes` | Owner, admin | A1.01 — programmes with status (Draft · Active · Archived) and counts |
| `POST` | `/v1/programmes` | Owner, admin | A1.03 — name, description, lead (an admin), outcomes |
| `GET` | `/v1/programmes/:id` | Owner, admin | A1.02 — programme, outcomes, cohorts, courses |
| `PATCH` | `/v1/programmes/:id` | Owner, admin | A1.04 |
| `POST` | `/v1/programmes/:id/archive` | Owner, admin | A1.05 — 409 `cohorts_running` (A1.05b) while cohorts are active or upcoming; archives its cohorts too |
| `POST` | `/v1/programmes/:id/restore` | Owner, admin | Restores the programme and the cohorts archived with it |
| `GET` | `/v1/courses?programmeId=` | Owner, admin | A2.01 — course library |
| `POST` | `/v1/courses` | Owner, admin | A2.03 — default lead trainer; optionally add to active/upcoming cohorts |
| `GET` | `/v1/cohorts` | Owner, admin | A3.01 — status is derived from dates (Upcoming · Active · Completed · Archived) |
| `POST` | `/v1/cohorts` | Owner, admin | A3.07 — dates, delivery, courses; each course's default lead becomes its lead trainer |
| `GET` | `/v1/cohorts/:id` | Owner, admin | A3.02 — cohort, its courses and trainers |
| `PATCH` | `/v1/cohorts/:id` | Owner, admin | A3.08 — programme can't change; courses with sessions can't be removed |
| `POST` | `/v1/cohorts/:id/archive` | Owner, admin | A3.09 — not while active (before it starts, archiving cancels it) |
| `POST` | `/v1/cohorts/:id/restore` | Owner, admin | Not while its programme is archived |
| `GET` | `/v1/participants?cohortId=` | Owner, admin | B1.01 / A3.03 — participants with their current (or that cohort's) enrolment |
| `POST` | `/v1/participants` | Owner, admin | B1.02 — invite and enrol; 409 `already_enrolled` / `one_cohort_only` (B1.02b) |
| `POST` | `/v1/participants/import/preview` | Owner, admin | B1.03b — checks up to 500 rows, saves nothing |
| `POST` | `/v1/participants/import` | Owner, admin | B1.03c — adds the ready rows, emails invitations after |
| `GET` | `/v1/participants/:id` | Owner, admin | B1.04 — details, enrolments, history |
| `PATCH` | `/v1/participants/:id` | Owner, admin | B1.06 — email changes only before they join; a new link goes to the new address |
| `POST` | `/v1/participants/:id/enrolments/:eid/defer` | Owner, admin | B1.05a — optionally into an upcoming cohort in the same programme |
| `POST` | `/v1/participants/:id/enrolments/:eid/withdraw` | Owner, admin | B1.05b |
| `POST` | `/v1/participants/:id/enrolments/:eid/transfer` | Owner, admin | B1.05c — old enrolment kept as `transferred` |
| `GET` | `/v1/sessions?from=&to=&cohortId=` | Owner, admin | C1.01 / A3.04 — sessions (dates are organisation-local), plus attendance to confirm |
| `POST` | `/v1/sessions` | Owner, admin | C1.02 — one session or a weekly series (up to 200), inside the cohort's dates |
| `GET` | `/v1/sessions/:id` | Owner, admin | C1.03 — number, series, trainer, expected, attendance and report state |
| `PATCH` | `/v1/sessions/:id` | Owner, admin | C1.06 / C1.04 — scope `this`, `following` or `all`; held sessions never change |
| `POST` | `/v1/sessions/:id/cancel` | Owner, admin | C1.05 — reason required; emails participants and the trainer |
| `GET` | `/v1/sessions/:id/attendance` | Owner, admin | C2.01 — register, counts, rate (present ÷ recorded) |
| `PUT` | `/v1/sessions/:id/attendance` | Owner, admin | C2.03 — marks people not yet marked; 409 `already_recorded` for changes |
| `PATCH` | `/v1/sessions/:id/attendance/:memberId` | Owner, admin | C2.02 — change one mark; reason required and logged |
| `GET` | `/v1/sessions/:id/attendance/history` | Owner, admin | C2.05 — register saves and changes, newest first |
| `GET` | `/v1/assignments` | Staff | T6.01 / C4.01 — trainers: their courses, drafts included; admins: every published assignment |
| `GET` | `/v1/assignments/options` | Staff | T6.02 — courses the user teaches, allowed grading scales |
| `POST` | `/v1/assignments` | Owner, admin, trainer; assistant if allowed | T6.02 — create; `publish: false` saves a draft |
| `GET` | `/v1/assignments/:id` | Staff | T6.03 / C4.02 — everyone's status, grading queue, `locked` once work is in |
| `PATCH` | `/v1/assignments/:id` | Owner, admin, trainer; assistant if allowed | T6.05 — edit; 409 `assignment_locked` for scale or submission types after submissions |
| `GET` | `/v1/assignments/:id/submissions/:memberId` | Staff | T6.04 / C4.03 — submission, grade, previous / next |
| `PUT` | `/v1/assignments/:id/submissions/:memberId/grade` | Owner, admin, trainer; assistant if allowed | T6.04 — grade in the assignment's scale; visible to the participant on save |
| `GET` | `/v1/invitations/:token` | Link holder | T0 / P0 — who's invited where |
| `POST` | `/v1/invitations/:token/accept` | Link holder | Set password and join |
| `POST` | `/v1/invitations/:token/renew` | Link holder, expired link | Sends a fresh link to the invitee |
| `POST` | `/v1/auth/password-reset` | Anyone | S1.01 — emails a 1-hour reset link; same answer whether or not the email exists |

## How access works

1. The browser signs in with Supabase Auth and sends the access token as `Authorization: Bearer …`.
2. The API verifies the token against the project's signing keys (JWKS) — no shared secret.
3. It loads the caller's **active** row in `organisation_members`. That row is the only source of
   organisation and role. Never read either from the request body or query.
4. Every query is scoped to `c.var.auth.organisationId`. Row-level security in Postgres is the second wall.

Roles: `owner`, `admin` (programme managers), `trainer`, `assistant_trainer`, `participant` (§03).

## First-time setup

### 1. Install

```bash
nvm use        # Node 22
npm install
```

### 2. Database — choose one

**A. Hosted dev project (recommended to start)**

1. Create a new project at [supabase.com](https://supabase.com/dashboard) named `synqop-dev`, region
   **West EU (Ireland)**. Keep it separate from the live Aliwa project.
2. Link and apply migrations:
   ```bash
   npx supabase login
   npx supabase link --project-ref <project-ref>
   npm run db:push
   ```
3. Authentication → Sign In / Providers → Email: minimum password length **10**.
   Authentication → URL Configuration: Site URL `http://localhost:5173`, redirect URL `http://localhost:5173/**`.
4. Project Settings → API Keys: copy the **secret** key into `.env` (API) and the **publishable** key into the web app.

**B. Local (needs Docker)**

```bash
npm run db:start   # creates local signing keys, starts Supabase, prints URL and keys
npm run db:reset   # re-applies all migrations from scratch
```

Studio runs at http://127.0.0.1:54323.

### 3. Environment

```bash
cp .env.example .env
```

Fill in `SUPABASE_URL`, `SUPABASE_SECRET_KEY` and `DATABASE_URL` (Supabase → **Connect** → **Session pooler**;
replace `[YOUR-PASSWORD]` with the database password). Without `RESEND_API_KEY`, emails are printed to the
terminal so you can click invitation links while developing.

### 4. Run

```bash
npm run dev            # http://localhost:5000/health
```

## Scripts

| Script | What it does |
|---|---|
| `dev` | Run with reload |
| `typecheck` · `lint` · `test` | Checks (also run in CI). Database tests run when `TEST_DATABASE_URL` is set |
| `build` · `start` | Production build and run |
| `db:new <name>` | New migration in `supabase/migrations` |
| `db:push` | Apply migrations to the linked project |
| `db:reset` | Rebuild the local database |
| `db:types` | Generate TypeScript types from the local schema |

## Conventions

- Schema changes only through migrations. Never edit tables in the dashboard.
- Every tenant table has `organisation_id`, RLS enabled, and no client write policies. Writes go through the API.
- Throw `AppError` (`src/lib/errors.ts`) for messages users may see. Anything else returns a generic 500 with a request ID.
- Metrics (attendance %, completion, health) are defined once, server-side, and return `null` when there is nothing to measure.

## Not yet decided

See *Proposals to confirm* in the development reference (§12). Invitation links (72 h) are longer than Supabase's
maximum email-link lifetime, so the API issues its own: 256-bit random, stored only as a SHA-256 hash, single use.
