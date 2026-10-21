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
