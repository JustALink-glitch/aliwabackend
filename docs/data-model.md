# Synqop V1 data model

Source of truth: `supabase/migrations/`. Product rules: Development Reference V1 §05.

## Map

```
organisations ─┬─ organisation_settings            (1:1, created automatically)
               ├─ organisation_members             (staff + participants; role, status)
               │    └─ invitations                 (72 h one-time link, hashed)
               ├─ programmes ─┬─ programme_outcome_options
               │              ├─ courses           (the course library)
               │              └─ cohorts ─┬─ enrolments ─┬─ attention_flags ── interventions
               │                          │              ├─ participant_outcomes
               │                          │              ├─ completion_reviews
               │                          │              └─ certificates
               │                          └─ cohort_courses  (a course running in a cohort)
               │                               ├─ cohort_course_trainers (one lead)
               │                               ├─ resources
               │                               ├─ assignments ─┬─ assignment_materials
               │                               │               ├─ rubric_criteria
               │                               │               └─ submissions ─┬─ submission_files
               │                               │                               └─ grades ── rubric_scores
               │                               └─ session_series ── sessions ─┬─ session_join_links
               │                                                              ├─ attendance_records ── attendance_changes
               │                                                              ├─ zoom_unmatched_attendees
               │                                                              ├─ session_recordings
               │                                                              ├─ session_reports ── session_report_answers
               │                                                              └─ session_feedback
               ├─ report_questions
               ├─ notifications · notification_preferences
               ├─ data_exports · generated_reports
               ├─ zoom_connections                 (token in Vault)
               └─ audit_events                     (append-only)
```

## Rules built into the schema

- **Tenant wall.** Every table has `organisation_id`. Children reference parents with composite keys
  `(organisation_id, id)`, so a row can never point at another organisation's data.
- **Same programme.** A cohort can only run courses from its own programme.
- **Closed to browsers.** RLS is on everywhere and clients have no grants on product tables; the API
  (secret key) does all reads and writes. New tables are closed by default.
- **Derived, not stored.** Cohort status (draft · upcoming · active · completed · archived) and session
  status (scheduled · in progress · held · cancelled) come from `status(cohort)` / `status(session)`, using
  the organisation's time zone. Report due/overdue, assignment late/overdue and certificate eligibility are
  derived the same way.
- **Not recorded** attendance is the absence of a row.
- Attendance edits need a reason; flags need a note to be resolved; one open flag per participant and rule;
  one lead trainer per course; one live invitation per person; the audit log can't be edited.

## Enforced by the API, not the schema

- Multi-cohort enrolment (organisation setting).
- Grading scale and submission types lock once work is submitted (proposal).
- Trainer and assistant permissions (§03 matrix, assistant settings in `organisation_settings`).
- Session feedback is anonymous to staff: `member_id` is never returned to trainers or admins.

## Placeholders to confirm

| Setting | Default | Why it's a placeholder |
|---|---|---|
| `flag_missed_in_row_count` | 2 | §05 says "missed sessions in a row" without a number |
| `flag_overdue_count` | 1 | "overdue assignments" without a number |
| `flag_inactivity_days` | 7 | "no activity for N days" |
| `in_person_reminder_hours` | 2 | "within N hours"; matches the 2 h admin notification |
| `grades.score_pct` for letter and pass/fail | null | How A–F and pass/fail count toward "average grade ≥ 50%" isn't defined |
| Proposals in §12 | as proposed | Zoom 70% / 10 min, 25 MB uploads, grades visible on save, reminders |
