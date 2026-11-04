# Kappiness CRM database migrations

## Run order (Supabase SQL editor, one file at a time)

| # | File | What it does | Status in the live project (checked 3 Nov 2026) |
|---|------|--------------|-------------------------------------------|
| 1 | `202610240001_safe_lead_status_updates.sql` | `update_lead_with_history` RPC (first version) | Assumed applied (the CRM uses it) |
| 2 | `202611030002_lead_status_lost_and_psychologist.sql` | New lead statuses, Lost reason, `leads.assigned_psychologist_id` | **Not applied**: `assigned_psychologist_id` does not exist yet |
| 3 | `202611040001_clients_appointments_sessions.sql` | Clients, services, appointments, sessions, recommendations, blocked periods, RLS, workflow functions | New |
| 4 | `202611040002_restrict_lead_access_to_staff.sql` | Restrictive policies: only CRM staff can read and write leads and lead activities | New. Review the existing policies first (audit query is in the file) |

Each file runs in one transaction and is safe to re-run. Nothing is dropped or deleted.

## What exists vs what was added

Verified in the live project: `psychologists`, `psychologist_availability`, `leads`, `lead_activities`.
Missing (PGRST205), and created by #3: `clients`, `services`, `appointments`, `appointment_status_history`,
`sessions`, `session_notes`, `session_status_history`, `follow_up_recommendations`,
`psychologist_availability_exceptions`.

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
| leads, lead_activities (#4) | unchanged | **no access** | none |

"Staff" means `app_metadata.role` is `admin` or `staff`, or any signed-in user without a psychologist profile. This matches the current app and `proxy.js`. Recommended:
- Set `app_metadata.role` on every staff login.
- Keep public sign-ups disabled.
- Then tighten `is_crm_staff()` to the explicit roles.
