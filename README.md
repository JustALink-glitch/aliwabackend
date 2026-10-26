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
| `GET` | `/v1/me` | Any member | User, membership (with display name and last sign-in), organisation |
| `GET` | `/v1/notifications?limit=` | Any member | G1.01 — your in-app notifications, newest first, with the unread count |
| `POST` | `/v1/notifications/:id/read` · `/v1/notifications/read-all` | Any member | G1.01 — mark one or all as read |
| `GET` | `/v1/search?q=` | Any member | G1.02 — grouped results scoped to the role: admins see everything, trainers what they teach, participants their courses and sessions |
| `PATCH` | `/v1/me` | Any member | P8.01 / G1.04 — full name, display name, phone |
| `GET` `PUT` | `/v1/me/notification-preferences` | Any member | P8.02 / F1.09 — email and in-app per event; admins also set a digest time |
| `GET` | `/v1/members?role=&status=` | Owner, admin | B1 / B2 lists (`role` takes a comma list) |
| `GET` | `/v1/members/:id` | Owner, admin | B2.02 — person, who invited them, invitation history |
| `POST` | `/v1/members` | Owner, admin | B1.02 / B2.03 — invite; emails a 72-hour link |
| `POST` | `/v1/members/:id/invitation` | Owner, admin | B2.02i — resend (old link stops working) |
| `DELETE` | `/v1/members/:id/invitation` | Owner, admin | B2.02i — revoke: cancels the link and removes the not-yet-joined person |
| `PATCH` | `/v1/members/:id/role` | Owner, admin | F1.02b — admin, trainer or assistant trainer; never the owner or yourself |
| `DELETE` | `/v1/members/:id` | Owner, admin | F1.02c — remove: no more sign-in, off what they teach; their records stay. Invite the same email to bring them back |
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
| `GET` | `/v1/sessions?from=&to=&cohortId=` | Staff (trainers: own courses) | C1.01 / A3.04 — sessions (dates are organisation-local), plus attendance to confirm |
| `POST` | `/v1/sessions` | Owner, admin, lead trainer (own courses) | C1.02 — one session or a weekly series (up to 200), inside the cohort's dates |
| `GET` | `/v1/sessions/:id` | Staff (trainers: own courses) | C1.03 / T3.02 — number, series, trainer, expected, attendance, report state, resources and what you `can` do |
| `PATCH` | `/v1/sessions/:id` | Owner, admin, lead trainer | C1.06 / C1.04 — scope `this`, `following` or `all`; held sessions never change |
| `POST` | `/v1/sessions/:id/cancel` | Owner, admin, lead trainer | C1.05 — reason required; emails participants and the trainer |
| `GET` | `/v1/sessions/:id/attendance` | Staff (own courses) | C2.01 — register, counts, rate (present ÷ recorded) |
| `PUT` | `/v1/sessions/:id/attendance` | Owner, admin, trainers (assistants if F1.04 allows) | C2.03 — marks people not yet marked; 409 `already_recorded` for changes |
| `PATCH` | `/v1/sessions/:id/attendance/:memberId` | Owner, admin, trainers (assistants if F1.04 allows) | C2.02 — change one mark; reason required and logged |
| `GET` | `/v1/sessions/:id/attendance/history` | Staff (own courses) | C2.05 — register saves and changes, newest first |
| `GET` | `/v1/sessions/options` | Staff | C1.02 / T3.03 — cohorts and courses you can schedule in, with their trainers |
| `POST` | `/v1/sessions/:id/resources/uploads` | Staff (assistants if F1.04 allows) | T8.01 — signed upload URL for a resource file |
| `POST` | `/v1/sessions/:id/resources` | Staff (assistants if F1.04 allows) | T8.01 — add a file or link to the session or the whole course; visible to participants or not |
| `GET` | `/v1/sessions/:id/resources/:resourceId` | Staff (own courses) | Download link for a resource |
| `GET` | `/v1/reports` | Owner, admin | E1.01 — generated reports, newest first (status queued, running, ready, failed) |
| `POST` | `/v1/reports` | Owner, admin | E1.02 — generate a cohort or programme summary, attendance, assignments or feedback report as PDF or CSV |
| `POST` | `/v1/reports/:id/retry` | Owner, admin | E1.05 — try a failed report again with the same choices |
| `GET` | `/v1/reports/:id/file` | Owner, admin | E1.04 — the file; downloads are logged |
| `GET` | `/v1/overview` | Owner, admin | O1.01 — cohorts, participants, attendance (4 weeks and previous), flags, 8 weeks of check-ins, next session per cohort, set-up steps |
| `GET` | `/v1/trainer/today` | Trainer, assistant | T2.01 — my cohorts, today's sessions, grading queue, attendance and flag counts |
| `GET` | `/v1/session-reports` | Staff (trainers: courses they report on) | T5.03 / C3.01 — held sessions with report state (due, overdue, submitted) and counts |
| `GET` | `/v1/session-reports/:sessionId` | Staff (own courses) | T5.01 / T5.02 / C3.02 — questions, answers, summary, whether it can still be edited |
| `PUT` | `/v1/session-reports/:sessionId` | Lead trainer (assistants if F1.04 allows) | T5.01 — save a draft or submit; editable until due, a late report is final |
| `POST` | `/v1/session-reports/:sessionId/remind` | Owner, admin | C3.01 — email the trainer about a due or overdue report |
| `GET` `PUT` | `/v1/settings/session-reports` | Owner, admin | F1.08 — due hours, reminder, overview, multiple-choice questions |
| `GET` | `/v1/trainer/cohorts` | Trainer, assistant | T3.04 — cohorts I teach in, one row per course |
| `GET` | `/v1/trainer/cohorts/:id` | Trainer, assistant | T3.05 — cohort summary, courses (mine marked), flagged count |
| `GET` | `/v1/assignments` | Staff | T6.01 / C4.01 — trainers: their courses, drafts included; admins: every published assignment |
| `GET` | `/v1/assignments/options` | Staff | T6.02 — courses the user teaches, allowed grading scales |
| `POST` | `/v1/assignments` | Owner, admin, trainer; assistant if allowed | T6.02 — create; `publish: false` saves a draft |
| `GET` | `/v1/assignments/:id` | Staff | T6.03 / C4.02 — everyone's status, grading queue, `locked` once work is in |
| `PATCH` | `/v1/assignments/:id` | Owner, admin, trainer; assistant if allowed | T6.05 — edit; 409 `assignment_locked` for scale or submission types after submissions |
| `GET` | `/v1/assignments/:id/submissions/:memberId` | Staff | T6.04 / C4.03 — submission, grade, previous / next |
| `PUT` | `/v1/assignments/:id/submissions/:memberId/grade` | Owner, admin, trainer; assistant if allowed | T6.04 — grade in the assignment's scale; visible to the participant on save |
| `POST` | `/v1/assignments/uploads` | Owner, admin, trainer; assistant if allowed | T6.02 — one-time signed upload URL for a brief file (25 MB) |
| `GET` | `/v1/assignments/:id/files/:fileId` | Staff | Download link (5 min) for a brief file or a submitted file |
| `GET` | `/v1/my/assignments` | Participant | P5.01 — published work in my cohorts, with my status and grade |
| `GET` | `/v1/my/assignments/:id` | Participant | P5.02 / P5.03 / P6.02 — brief, my submission, grade, feedback, whether I can submit |
| `POST` | `/v1/my/assignments/:id/uploads` | Participant | P5.02 — one-time signed upload URL for my file |
| `PUT` | `/v1/my/assignments/:id/submission` | Participant | P5.02 — submit or replace (file, link or text); late or closed rules; 409 once graded |
| `GET` | `/v1/my/assignments/:id/files/:fileId` | Participant | Download link for a brief file or my own file |
| `GET` | `/v1/my/grades` | Participant | P6.01 — everything handed in, graded or waiting |
| `GET` | `/v1/my/overview` | Participant | P2.01 — current cohort (or deferred), next and upcoming sessions, my attendance, programme progress |
| `GET` | `/v1/my/sessions` | Participant | P4.01 — sessions in my cohorts with my attendance; join link from the day before |
| `GET` | `/v1/my/sessions/:id` | Participant | P4.02 — one session, my attendance, its resources |
| `GET` | `/v1/my/courses` | Participant | P3.01 — my courses: trainer, attendance, work submitted, next session |
| `GET` | `/v1/my/courses/:id` | Participant | P3.02 — sessions with my attendance, trainer, resources |
| `GET` | `/v1/my/resources/:id` | Participant | Download link for a course or session resource |
| `PUT` | `/v1/my/sessions/:id/feedback` | Participant | P4.03 — rate a held session 1–5 with an optional comment; can be changed |
| `GET` | `/v1/session-feedback/:sessionId` | Owner, admin; the course's trainers | C5.01 / T7.04 — anonymous totals, distribution and comments |
| `GET` | `/v1/attention` | Staff (trainers: own cohorts) | D1.01 — re-checks the rules, then flagged participants with their flags and latest follow-up |
| `GET` | `/v1/attention/count` | Staff | Sidebar count of flagged participants |
| `GET` | `/v1/attention/interventions` | Staff | D1.04 — interventions log |
| `GET` | `/v1/attention/participants/:memberId` | Staff | D1.02 / T7.02 — open flags, interventions, next review |
| `POST` | `/v1/attention/participants/:memberId/interventions` | Staff | D1.03 / T7.03 — record a call, email, message or visit |
| `POST` | `/v1/attention/participants/:memberId/resolve` | Owner, admin (trainers if F1.06 allows) | D1.02 — resolve open flags with a note; they don't reopen until the rule stops matching |
| `GET` | `/v1/trainer/participants` | Trainer, assistant | T7.01 — people in cohorts I teach: own-course attendance and work, flag, last active |
| `GET` | `/v1/trainer/participants/:memberId` | Trainer, assistant | T7.02 — sessions and assignments from my courses only |
| `GET` | `/v1/completion/certificates` | Owner, admin | D2.01 — everyone against the completion rule (eligible, issued, not yet, not completed); issues automatically if F1.05 says so |
| `POST` | `/v1/completion/certificates` | Owner, admin | D2.02 — issue certificates to eligible people; optionally email a link |
| `GET` | `/v1/completion/certificates/:id` | Owner, admin | A certificate as printed |
| `GET` | `/v1/completion/outcomes` | Owner, admin | D3.01 — outcomes for a programme (optionally one cohort), counts per option |
| `POST` | `/v1/completion/outcomes` | Owner, admin | D3.02 — record (or update) an outcome for someone who completed |
| `GET` `PUT` | `/v1/settings/organisation` | Owner, admin | F1.01 — name, type, country, time zone; owner and created date |
| `GET` `PUT` | `/v1/settings/programme-setup` | Owner, admin | F1.04 — course library, trainer assignment, assistants, multi-cohort, grading scales, feedback |
| `GET` `PUT` | `/v1/settings/attendance` | Owner, admin | F1.07 — join links, present %, late arrivals, recordings, in-person reminder; Zoom connection status |
| `GET` | `/v1/privacy` | Owner, admin | F1.10 — recent exports and deletion status (`canManage` for the owner) |
| `POST` | `/v1/privacy/exports` | Owner | F1.10 — ZIP of CSVs (and submission files if asked), ready for 7 days; emails the owner |
| `GET` | `/v1/privacy/exports/:id/file` | Owner | F1.10 — download the ZIP |
| `POST` `DELETE` | `/v1/privacy/deletion` | Owner | F1.11 — schedule (type the name; read-only for 30 days, everyone emailed) or cancel |
| `POST` | `/v1/zoom/connect` | Owner, admin | F1.07 — Zoom's approval URL (signed state, 10 minutes) |
| `GET` | `/v1/zoom/callback` | Public (Zoom redirect) | F1.07 — swaps the code for tokens (stored encrypted), back to Settings with `?zoom=connected` |
| `DELETE` | `/v1/zoom/connection` | Owner, admin | F1.07 — disconnect; existing meetings stay in Zoom |
| `GET` `POST` | `/v1/sessions/:id/attendance/zoom` | Staff on the session | C2.04 / T4.04 — Zoom names that didn't match by email, with suggestions; save matches and ignores |
| `GET` `PUT` | `/v1/settings/completion` | Owner, admin | F1.05 — completion criteria, issuing, signatory, certificate title, default outcomes |
| `GET` `PUT` | `/v1/settings/attention-rules` | Owner, admin | F1.06 — signals, who sees flags, how they close; with how many are flagged now |
| `GET` | `/v1/my/progress` | Participant | P7.01 — progress against the completion rule |
| `GET` | `/v1/my/certificate` | Participant | P7.02 — my certificate |
| `PATCH` | `/v1/me` | Anyone signed in | P8.01 — display name and phone |
| `GET` | `/v1/me/notification-preferences` | Anyone signed in | P8.01 — events for my role with email / in-app choices |
| `PUT` | `/v1/me/notification-preferences` | Anyone signed in | P8.01 — save choices |
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

## Scheduled jobs (X2)

Every minute the API checks, for each active organisation:

| Job | Who hears | Setting |
|---|---|---|
| Session reminder (X2.01) | Participants in the cohort | `session_reminder_minutes_before` (60) |
| Assignment due (X2.02) | Participants who haven't submitted | `assignment_reminder_hours_before` (24) |
| Report due soon, then overdue (F1.08, X2.05) | Session trainer by email; admins in-app when overdue | Session reports settings |
| Attendance not recorded (F1.07) | Session trainer; admins in-app | Attendance & Zoom › Remind the trainer |
| Daily digest (X2.06) | Each admin at their digest time, only when there are new flags or overdue reports | Notifications |
| Delete organisation (F1.11) | Removes everything, files and sign-ins included, once the 30 days pass | Data & privacy |

Each message is claimed in `delivery_log` before it is sent, so it goes out once even if the API restarts or runs
on several machines. Missed alerts are only sent if they're recent (a few days), so turning the API back on
doesn't flood anyone. Everyone's Email / In-app choices are respected.

Hosts that sleep between requests can set `SCHEDULER=off` and have a cron call
`POST /v1/internal/run-jobs` with `Authorization: Bearer <CRON_SECRET>` every few minutes.

## Zoom (F1.07)

With `ZOOM_CLIENT_ID`, `ZOOM_CLIENT_SECRET` and `ZOOM_REDIRECT_URL` set, an Owner or Admin connects the
organisation's Zoom account in Settings › Attendance & Zoom. Then, from the scheduler every minute:

- every upcoming online session **without a pasted link** gets a Zoom meeting (moved when the time changes,
  removed when cancelled, moved in person or replaced by a pasted link);
- with personal join links on, everyone in the cohort is registered and sees their own link on the session;
- 10 minutes after a meeting ends, the participants report is imported: present if in the meeting for at least
  the set share of the session, late after the set minutes; hand-made marks are never changed; names that don't
  match anyone by email go to C2.04 and admins and the trainer are told.

Tokens are encrypted with a key derived from the client secret (changing the secret means connecting again).
If Zoom stops accepting the tokens, the connection shows "needs connecting again" and nothing is sent to Zoom.

The Zoom app needs these scopes: `user:read:user`, `meeting:write:meeting`, `meeting:update:meeting`,
`meeting:delete:meeting`, `meeting:write:registrant` and `report:read:list_meeting_participants:admin`
(the participants report needs a paid Zoom plan and is approved by a Zoom admin).
