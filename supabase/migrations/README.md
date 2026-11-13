# Kappiness CRM database migrations

## Migration status on the MAIN (production) project

Verified 13 Nov 2026 against production (read-only): schema objects and function fingerprints for every row.
"Recorded in history" means a row in `supabase_migrations.schema_migrations`.

| # | File | What it does | Applied to production | Recorded in history |
|---|------|--------------|-----------------------|---------------------|
| 1 | `202610240001_safe_lead_status_updates.sql` | `update_lead_with_history` RPC (first version; later replaced by `202611030002`) | Applied | **Yes** (already recorded) |
| 2 | `202611030001_crm_staff_membership_rls.sql` | `crm_staff_members` and the restrictive membership policies on leads / lead activities | Applied (by hand) | Not yet (pending repair) |
| 3 | `202611030002_lead_status_lost_and_psychologist.sql` | Lead statuses incl. Lost, Lost reason, `leads.assigned_psychologist_id`, current `update_lead_with_history` | Applied (by hand) | Not yet (pending repair) |
| 4 | `202611040001_clients_appointments_sessions.sql` | Clients, services, appointments, sessions, recommendations, blocked periods, RLS, workflow functions | Applied (by hand) | Not yet (pending repair) |
| 5 | `202611130001_remediate_role_helpers_and_availability.sql` | Membership-based `is_crm_staff()` / `is_crm_admin()`, `is_own_psychologist()`, availability lockdown, anon/TRUNCATE revokes | Applied (deployment `202611130003`) | Not yet (pending repair) |
| 6 | `202611130002_appointment_reminders.sql` | Phase 3 reminder tracking (see below) | Applied (deployment `202611130003`) | Not yet (pending repair) |
| — | `202611040002` … `202611040005` | Archived in `supabase/migrations_superseded/` (see its README) | **Never applied**: superseded / redundant; `040004` must never be applied | **No, never record them** |

`supabase/migrations/` contains exactly rows 1–6, the migrations that are live on production. The four
superseded files were moved out, unchanged, so the Supabase CLI cannot see them as pending. Recording rows 2–6 in
migration history (`supabase migration repair --status applied …`) is a separate step that needs review and
approval. Until it is done, **do not run `supabase db push`** against production: it would replay `202611030001`,
`202611030002` and `202611040001` (and re-create the insecure helper from `202611040001`).

The old atomic bundle is retired in `supabase/deploy/retired/` (it aborts if run), and
`scripts/build-deploy-bundle.mjs` no longer builds it.

History, for context: before deployment `202611130003`, live `is_crm_staff()` was the insecure version from
`202611040001`, because `202611040003`-`202611040005` and the bundle were never applied.

## What exists vs what was added (historical snapshot, 3–4 Nov 2026)

> Historical: this records the state of the live project on 3–4 Nov 2026, before `202611040001` was applied.
> All the tables listed below exist on production now; see the status table above for what is applied.

Verified in the live project at that time: `psychologists`, `psychologist_availability`, `leads`, `lead_activities`.
Missing at that time (PGRST205), and created by `202611040001_clients_appointments_sessions.sql`: `clients`,
`services`, `appointments`, `appointment_status_history`, `sessions`, `session_notes`, `session_status_history`,
`follow_up_recommendations`, `psychologist_availability_exceptions`.

```
leads 1───1 clients ───* appointments 1───1 sessions 1───1 session_notes
  │            │             │   │                │
  │            │             │   └─* appointment_status_history
  │            │             └─ rescheduled_from_id → appointments (old → new)
  │            └─* follow_up_recommendations ─→ sessions, appointments (when booked)
  └─ assigned_psychologist_id ─→ psychologists ←─ clients.primary_psychologist_id
                                      │            appointments.psychologist_id
                                      ├─* psychologist_availability (weekly, several per day)
                                      └─* psychologist_availability_exceptions (blocked periods)
services ─* appointments (duration + buffer copied at booking time)
```

## Rules enforced in the database

- **Lead workflow** (trigger `enforce_lead_workflow`):
  - Enquiry → Yet to Confirm / Lost
  - Yet to Confirm → Enquiry / Will Inform / Lost
  - Will Inform → Yet to Confirm / Confirmed / Lost
  - Confirmed and Lost are final.
  - Lost needs a reason.
  - Confirmed needs an active psychologist.
  - Only staff can change a status or an assignment.
- **Client conversion** (trigger `sync_client_from_lead`): a Confirmed lead with a psychologist gets exactly one client (`clients.lead_id` is UNIQUE). The lead and its history are untouched.
- **No overlapping bookings**: an `EXCLUDE` constraint on `(psychologist_id, [starts_at, ends_at + buffer))` for Scheduled and Confirmed rows. Concurrent bookings cannot both succeed. Cancelled and rescheduled rows no longer hold the time.
- **Booking** (`book_appointment`): the time must be in the future, inside an active weekly period (clinic timezone `Asia/Kolkata`, set in `clinic_timezone()`) and outside blocked periods. The length comes from the service. Staff can book any active psychologist. A psychologist can book only themselves and only their own clients.
- **Status changes** only happen through functions:
  - `confirm_appointment` (staff only)
  - `cancel_appointment` (reason required; the record and its time are kept)
  - `reschedule_appointment` (the original becomes Rescheduled and a new Scheduled appointment links back)
  - `record_attendance` (only after the start time; Completed or Missed, recording who and when; the session follows)

  Every change is written to `appointment_status_history`.
- **Blocked periods** (`add_availability_block`): refused while active appointments fall inside them. `availability_block_conflicts` lists them for the warning. Existing appointments are never changed.

## RLS summary

| Table | Staff | Psychologist | Anonymous |
|---|---|---|---|
| clients | read all, edit contact fields | read own and those booked with them | none |
| appointments | read all, edit notes | read own, edit notes | none |
| sessions, histories | read all | read own | none |
| session_notes | admins only | own sessions | none |
| follow_up_recommendations | read all | read own | none |
| availability, blocked periods | manage all | manage own | none |
| leads, lead_activities | read, create, update (no delete) | **no access** | none |

Leads and lead activities are protected by the RESTRICTIVE "Require active CRM staff membership" policies from
`202611030001_crm_staff_membership_rls.sql` and the RESTRICTIVE "block psychologist accounts" policies present on
production (both confirmed with read-only catalog queries on 13 Nov 2026).

**Who counts as staff and admin (production since deployment `202611130003`, i.e. `202611130001`):**

- **Staff** (`is_crm_staff()`): a signed-in user with an **active** row in `public.crm_staff_members`
  (`is_active = true`). Deactivating the row removes staff access immediately.
- **Admin** (`is_crm_admin()`): an active `crm_staff_members` row with `access_level = 'admin'`.
- **JWT role claims alone never grant CRM staff or admin access.** `app_metadata.role` (read by `crm_role()`) is
  ignored for authorization, and so is the absence of a psychologist profile; only the membership table counts.
- Psychologists are identified by `psychologists.auth_user_id` (`current_psychologist_id()`,
  `is_own_psychologist()`) and get only their own data.

Before `202611130001` the helpers from `202611040001` treated a JWT `admin`/`staff` role, or any signed-in user
without a psychologist profile, as staff. That is no longer the case.

## Phase 3: appointment reminder tracking (`202611130002_appointment_reminders.sql`)

Database tracking only. Nothing here sends email, SMS or WhatsApp.

### What it adds

| Object | Purpose |
|---|---|
| `appointment_reminder_settings` | Two rows: how long before the appointment reminder 1 and reminder 2 are due. Seeded with 24 hours and 2 hours (initial configuration, changeable). |
| `appointment_reminders` | Exactly two slots (`reminder_number` 1, 2; `UNIQUE (appointment_id, reminder_number)`) per follow-up appointment. Delivery status `Pending / Sent / Delivered / Failed / Cancelled`, client response `Confirmed / Wants to Reschedule / No Response`, who/when columns. |
| `appointment_reminder_events` | Append-only history of every reminder change (creation, delivery status, response, due time), with actor and note. |
| Triggers on `appointments` | `appointments_create_reminders` (after insert of an active follow-up) and `appointments_cancel_pending_reminders` (after a status change out of Scheduled/Confirmed). |
| RPCs | `record_reminder_delivery`, `record_reminder_response`, `update_reminder_due_at` (active staff), `set_reminder_offsets` (active admins). |

A **follow-up appointment** is an appointment with `recommendation_id` set. That is how `book_appointment` records a booking made from a follow-up recommendation, and `reschedule_appointment` copies it to the replacement.

### How it plugs into the existing workflow

`book_appointment`, `reschedule_appointment` and `cancel_appointment` are **not modified**. The triggers fire inside their transactions:

| Event | Reminders |
|---|---|
| Follow-up booked | Reminders 1 and 2 created, `Pending`, `due_at = starts_at - offset` (or `now()` if that moment has passed; reminder 2 never before reminder 1). |
| Rescheduled | Old appointment kept (`Rescheduled`). Its **Pending** reminders become `Cancelled`; Sent/Delivered/Failed ones and all history are untouched. The replacement gets exactly two new Pending reminders timed from its new start. The recommendation already points to the replacement (`reschedule_appointment`). |
| Cancelled | Pending reminders become `Cancelled` (the cancellation reason is in the event note). Everything else is kept. |
| Completed / Missed | Pending reminders become `Cancelled` (they can no longer be useful). |
| Any failure | Booking, reschedule and reminder creation share one transaction: no orphan appointment or reminder. If reminder timing is not configured, the follow-up booking itself fails. |

Delivery status rules, enforced by a trigger for every writer (service_role and the table owner included):
`Pending → Sent | Delivered | Failed | Cancelled`, `Sent → Delivered | Failed`, `Failed → Sent (retry) | Delivered | Cancelled`; `Delivered` and `Cancelled` are final. A client response needs a `Sent` or `Delivered` reminder. Reminder rows and events cannot be deleted; events cannot be edited.

### Access

| | Active staff | Active admin | Psychologist, non-member, inactive staff, JWT-only "admin" | anon |
|---|---|---|---|---|
| Read reminders, events, settings | yes | yes | no (0 rows) | no privileges |
| Record delivery / response, move a pending reminder | via RPC | via RPC | refused (42501) | refused |
| Change offsets | no | via RPC | refused | refused |
| Direct INSERT/UPDATE/DELETE | no | no | no | no |

Access is decided **directly from an active `crm_staff_members` row** (admin: `access_level = 'admin'`). It does not use `is_crm_staff()` / `is_crm_admin()`. Reminder tracking does not depend on the state of is_crm_staff() (insecure before deployment 202611130003, membership-based since).

### Dependencies and application order

1. Requires `202611030001` (crm_staff_members) and `202611040001` (appointments, recommendations, workflow functions, `current_actor_name`). Both are live.
2. Independent of the superseded `202611040002`-`202611040005` and of the `is_crm_staff()` remediation (`202611130001`). The remediation still goes first: it closes the hole that lets any signed-in non-psychologist book, cancel and reschedule appointments, and those actions drive the reminder triggers. The production package below runs them in that order, in one transaction.
3. The migration checks its assumptions before changing anything: tables and columns, the exact appointment status vocabulary, the three workflow functions, that `book_appointment` stores `p_recommendation_id`, that `reschedule_appointment` copies `old_appt.recommendation_id`, and no FORCE RLS. Any mismatch aborts it.
4. On production, apply **only** through the package in "Production deployment 202611130003" below, **not** with `supabase db push` (see the status note above). On its own, the file is safe to re-run. A backfill creates reminders for active, future follow-up appointments that already exist; the audit found 0 recommendations on live, so the expected result is 0.

### Rollback considerations

- **Stop the behaviour, keep the history (preferred):** `DROP TRIGGER appointments_create_reminders ON public.appointments; DROP TRIGGER appointments_cancel_pending_reminders ON public.appointments;`. Booking, rescheduling and cancelling then work exactly as before.
- **Remove everything:** the full statement list is in the header of the migration. It drops `appointment_reminders` and `appointment_reminder_events`, so **reminder history is lost**. Only do this before the data matters, or export it first.
- Nothing in the existing schema is altered, so no rollback step touches appointments, sessions or recommendations.

### Tests

`supabase/tests/appointment_reminders_test.sql`: one transaction ending in ROLLBACK. It needs `SET kappiness.test_env = 'disposable'` and an empty `crm_staff_members`, like the other suites.

It covers: two reminders per follow-up (and none for regular bookings), duplicate prevention, delivery status updates (including retry, final states and validation), client responses with history, moving a pending reminder, reschedule (old pending cancelled, exactly two new, old history byte-for-byte unchanged, recommendation repointed, a refused second reschedule changes nothing), cancellation (pending only), completion, unauthorised users (anon, non-member, spoofed JWT admin, inactive staff, psychologist; direct writes refused; even the owner cannot delete history), no orphans after failed bookings or reschedules (overlap, outside hours, missing timing configuration), and configurable timing.

Run it on a **disposable** database only (the hosted test project was retired on 13 Nov 2026), as part of the production path in `supabase/test-bootstrap/README.md` (steps 1-12; it runs all four suites). Minimal reminder-only variant (without `202611130001`, so no temporary staff login is needed):

```sh
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SET kappiness.test_env = 'disposable'" \
  -f supabase/test-bootstrap/01_baseline_from_snapshot.sql \
  -f supabase/migrations/202611030001_crm_staff_membership_rls.sql \
  -f supabase/test-bootstrap/03_live_state_delta.sql \
  -f supabase/test-bootstrap/04_verify_bootstrap.sql \
  -f supabase/migrations/202611030002_lead_status_lost_and_psychologist.sql \
  -f supabase/migrations/202611040001_clients_appointments_sessions.sql \
  -f supabase/migrations/202611130002_appointment_reminders.sql \
  -f supabase/tests/appointment_reminders_test.sql
```

## Production deployment 202611130003 (security remediation + reminder tracking)

Direct deployment to the MAIN project, without `kappiness-crm-test`, as decided on 13 Nov 2026 (the hosted test project was retired on 13 Nov 2026).

**Status: executed on the MAIN project on 13 Nov 2026.** Do not run it again; its preflight refuses a second run.

Reported by the operator who ran it in the SQL Editor:
- preflight report: 32/32 rows `ok = true`;
- deployment: completed successfully;
- post-deployment report: 41 checks verified;
- behaviour check: "Success. No rows returned";
- all four active staff accounts have admin access;
- psychologist and non-staff login tests passed.

Independently confirmed afterwards with read-only catalog queries on production (13 Nov 2026):
- function fingerprints `is_crm_staff()` `118729f2…`, `is_crm_admin()` `ffeeb94c…` and `is_own_psychologist(uuid)`
  `09629c62…` (the `202611130001` versions), and `update_lead_with_history` still `2dc29d7e…` (unchanged);
- the restrictive `availability_require_staff_or_owner` policy is present;
- the three reminder tables exist with RLS enabled and `authenticated` SELECT only, and the triggers
  `appointments_create_reminders` / `appointments_cancel_pending_reminders` are present on `appointments`;
- migration history still contains only `202610240001` (recording `202611030001`-`202611130002` is a separate,
  pending step).

Not independently re-checked: the four admin memberships (they come from the operator's report and post-deployment
check E1).

The sections below are kept as the record of how the package was built, rehearsed and run.

### Package (`supabase/deploy/`)

| Step | File | Effect |
|---|---|---|
| 1 | `202611130003_01_preflight_report.sql` | Read-only `SELECT`. 32 checks as a table. Every row must be `ok = true`. |
| 2 | `202611130003_02_production_deploy.sql` | **The deployment.** One transaction: strict preflight → content fingerprint of the 15 existing tables → `202611130001` → **admin access for the 4 active staff members** (`parts/202611130003_admin_assignment.sql`) → `202611130002` → behaviour checks → strict post-checks and unchanged content → `COMMIT`. Any failure rolls everything back. |
| 3 | `202611130003_03_postdeploy_report.sql` | Read-only `SELECT`. 41 checks as a table. Also safe over the read-only MCP connection. |
| 4 | `202611130003_04_behaviour_check.sql` | Simulated logins (anon, stranger, staff, psychologist); ends in `ROLLBACK`. Only meaningful on the fully deployed state. |
| — | `202611130003_ROLLBACK_reference.sql` | Handwritten rollback options. Everything is commented out, so running it unedited does nothing. |

Files 1–4 are **generated** from `supabase/migrations/202611130001_*.sql`, `202611130002_*.sql` and `supabase/deploy/parts/202611130003_*.sql` by `node scripts/build-production-deploy.mjs`. `--check` confirms they are current. Never edit them by hand. The old atomic bundle is retired (`deploy/retired/202611040005_atomic_bundle.sql`, aborts if run): it would replay `202611030002` and `202611040001`.

### What the preflight pins (aborts on any difference)

- md5 fingerprints of 15 functions. Four were read from production in the audit (`is_crm_staff`, `is_crm_admin`, `update_lead_with_history`, `enforce_lead_workflow`), and those four match the repository exactly. The other eleven come from the repository: the booking, reschedule, cancel, confirm and attendance functions plus their helpers and triggers.
- The exact sets of public tables, triggers and `psychologist_availability` policies; the appointment status vocabulary; the appointment columns the reminders use.
- No FORCE RLS; `postgres` owns the tables read by definer functions; running as `postgres`.
- **Exactly 4** active staff memberships (all of them become admin), and **0** accounts that would lose staff access.
- `crm_staff_members` has exactly the columns `access_level, created_at, created_by, is_active, user_id`, and its CHECK allows only `staff`/`admin`. Row 18 shows the current access levels (expected `active staff=4`).
- Nothing from this deployment exists yet, and migration history does not contain `202611130001`/`2`. A second run is therefore refused.

### Run it in the Supabase SQL Editor (MAIN project)

1. Dashboard → the MAIN Kappiness CRM project (confirm the project ref in the URL) → **SQL Editor** → **New query**.
2. Paste the whole of `202611130003_01_preflight_report.sql` → **Run**. Every row must show `ok = true` (failing rows sort first). If any row fails, **stop** and review.
3. Choose a quiet time. Open a **new query**, paste the **whole** of `202611130003_02_production_deploy.sql`, make sure nothing is selected, and press **Run**. Confirm the prompt about destructive operations (`DROP POLICY IF EXISTS`, `REVOKE`).
   - Success: "Success. No rows returned".
   - Any red error (`PREFLIGHT FAILED`, `POST-DEPLOYMENT CHECK FAILED`, `BEHAVIOUR FAIL`, lock timeout, ...): **nothing was committed**. Re-run step 2 to confirm, then investigate. A `lock_timeout` only means app traffic held a lock; retry at a quieter moment.
4. New query: `202611130003_03_postdeploy_report.sql` → Run → all 41 rows `ok = true` (E1: `active=4 admin=4 not_admin=0`).
5. New query: `202611130003_04_behaviour_check.sql` → Run → "Success. No rows returned".
6. App smoke test with real logins:
   - Staff: leads, clients, booking, reschedule, cancel, confirm, attendance.
   - Psychologist: own availability (add/edit/delete), own clients, session update.
   - An account with no membership sees nothing.
7. Only after this succeeds, decide on migration history. Record the hand-applied and new versions **without running them**: `supabase migration repair --status applied 202611030001 202611030002 202611040001 202611130001 202611130002`. `202611040002`-`202611040005` are **not** recorded: they were moved to `supabase/migrations_superseded/` instead, so `db push` can never see them. Until the repair is done and reviewed, never use `supabase db push`.

### Rehearsal (local, 13 Nov 2026)

Done in a disposable in-memory PostgreSQL 17 (PGlite), with a stand-in for Supabase's `auth` schema and API roles. The schema was rebuilt as production is today: bootstrap, then `202611030002` and `202611040001` stand-alone, availability policy names aligned to the audited live names, and production-shaped data (4 active staff, 2 psychologists). Results:

- The unaligned bootstrap was rejected by the preflight (policy names): drift detection works.
- Aligned: preflight 32/32, deploy committed, post-deploy 41/41, behaviour check passed (X5: 4 active admins pass; inactive members, psychologist and JWT-only admin refused), content of the 15 existing tables unchanged apart from the 4 access levels.
- A second deploy was refused by the preflight; nothing changed.
- A failure injected just before `COMMIT` (after every part had run) left the state identical to before (preflight 32/32 again; all 4 memberships back to `staff`).
- A pre-existing future follow-up got its 2 reminders from the backfill.
- On the deployed state: `role_helpers_test`, `scheduling_access_test` and `appointment_reminders_test` pass. `lead_workflow_test` failed at T0 at the time because it still asserted the `202611040004` lead function. It was rewritten on 13 Nov 2026 to pin the production behaviour (`202611030002` function, five-event limit) and now passes on the production path.
- Rollback options A, B, C and D each ran cleanly against a deployed copy. Option F (reverse the admin assignment) fails safely unedited, demotes exactly the listed ids, and refuses if any listed id does not match.
- Admin assignment negative tests: 3 or 5 active memberships → preflight row 11 fails and nothing changes. The admin step's own guard also aborts when run without the preflight. An unrelated change to a psychologist or to an inactive membership during the deployment → content check fails → everything rolled back. An inactive membership stays inactive and `staff`.

Not rehearsed: the real Supabase SQL Editor and the real `auth` implementation. Steps 2 and 4–5 are the checks for those on production.

### Admin access decision (13 Nov 2026)

All **4 active staff members** become admins (`crm_staff_members.access_level = 'admin'`) inside the deployment transaction (PART 2). Only that column of active rows changes. The deployment proves it before `COMMIT`: it compares a before/after content fingerprint of all 15 existing tables, masking only active `access_level`.

What admin allows, given the membership-based `is_crm_admin()`:
- Reading **and writing** the clinical session notes of **every** session (`session_notes_read`, `update_session`).
- Changing reminder timing (`set_reminder_offsets`).

To reverse it for some or all members, use option F in `deploy/202611130003_ROLLBACK_reference.sql`.
