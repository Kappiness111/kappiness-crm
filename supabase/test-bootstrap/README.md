# Test database bootstrap (disposable databases)

> **The hosted test project `kappiness-crm-test` was retired on 13 Nov 2026.** This bootstrap and the four SQL
> suites in `supabase/tests/` are kept for future testing on any **disposable** database. Nothing here is ever run
> against production (`ibfxhimzufthlogrqefj`).

### What counts as a disposable database

An **empty**, throwaway, Supabase-compatible PostgreSQL 17 database that you are willing to lose, for example a
local stack started with `supabase start`, a Supabase branch, or a newly created throwaway Supabase project. It
must provide:

- the Supabase `auth` schema (`auth.users`, `auth.uid()`, `auth.jwt()`) and the roles `anon`, `authenticated`
  and `service_role`;
- an `extensions` schema in which the `btree_gist` extension is available;
- an empty `public` schema and an empty `auth.users` (step 1 refuses to run otherwise).

Builds an **empty** copy of the live pre-bundle schema (as of 4 Nov 2026) in that disposable database, then
replays the **production path** (the migrations that are actually live on production, in production order) and
runs the four SQL suites. The old atomic bundle is retired
(`supabase/deploy/retired/`) and is no longer part of this procedure. No production data is used: `schema_before_migration.sql` is schema-only,
and `supabase/backups/data_before_migration.sql` must **never** be loaded here.

## Files

| Step | File | Effect |
|---|---|---|
| 1 | `supabase/test-bootstrap/01_baseline_from_snapshot.sql` | Snapshot tables `leads`, `lead_activities`, sequence, trigger, policies and grants. Refuses unless `public` is empty and `auth.users` is empty. |
| 2 | `supabase/migrations/202611030001_crm_staff_membership_rls.sql` | Unchanged. `crm_staff_members` and the restrictive membership policies. On the **disposable** database only. |
| 3 | `supabase/test-bootstrap/03_live_state_delta.sql` | Live status vocabulary, `psychologists`, `psychologist_availability` with its 5 live policies and anon grants, and the live `is_crm_staff()` and `update_lead_with_history()`, verbatim from `live_function_definitions.csv`. |
| 4 | `supabase/test-bootstrap/04_verify_bootstrap.sql` | Read-only (ROLLBACK). Fails unless the state matches live, every table is empty and `crm_staff_members` has 0 rows. |
| 5 | `supabase/migrations/202611030002_lead_status_lost_and_psychologist.sql` | As applied on production. |
| 6 | `supabase/migrations/202611040001_clients_appointments_sessions.sql` | As applied on production (installs the old insecure helpers, replaced in step 8). |
| 7 | `supabase/test-bootstrap/06_add_temporary_staff.sql` | One temporary active staff login, only because step 8 refuses to run with zero active staff (production lock-out guard). |
| 8 | `supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql` | Membership-based helpers and availability lockdown, as deployed to production. |
| 9 | `supabase/migrations/202611130002_appointment_reminders.sql` | Reminder tracking, as deployed to production. |
| 10 | `supabase/test-bootstrap/07_remove_temporary_staff.sql` | Removes the temporary login; `crm_staff_members` and `auth.users` are empty again. |
| 11 | `supabase/tests/*.sql` | The four suites. Each ends with ROLLBACK, so `crm_staff_members` stays empty. |
| 12 | `supabase/test-bootstrap/05_verify_test_state.sql` | Read-only (ROLLBACK). Confirms the suites left nothing behind and the seeds (6 services, 2 reminder-timing rows) are intact. |

Not replayed: the production admin assignment (part of `supabase/deploy/202611130003_02_production_deploy.sql`, data only) and
the superseded migrations in `supabase/migrations_superseded/` (never applied to production).

## Commands

Put the **disposable** database's direct connection string (port 5432, user `postgres`) in `TEST_DB_URL`
yourself. It must never be production's. Do not use the transaction pooler (port 6543): the `SET` below must
last for the whole session.

```sh
# Run this whole block as a script (e.g. saved and run with `bash -e`), so the exit below stops everything.
# Step 0: refuse to continue if TEST_DB_URL points at production (ibfxhimzufthlogrqefj).
case "$TEST_DB_URL" in *ibfxhimzufthlogrqefj*) echo "TEST_DB_URL is PRODUCTION - stop." >&2; exit 1;; esac

# Steps 1-4 in ONE session; stops at the first error.
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SET kappiness.test_env = 'disposable'" \
  -f supabase/test-bootstrap/01_baseline_from_snapshot.sql \
  -f supabase/migrations/202611030001_crm_staff_membership_rls.sql \
  -f supabase/test-bootstrap/03_live_state_delta.sql \
  -f supabase/test-bootstrap/04_verify_bootstrap.sql

# Steps 5-10: the production path, in production order (each file is its own transaction).
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1   -c "SET kappiness.test_env = 'disposable'"   -f supabase/migrations/202611030002_lead_status_lost_and_psychologist.sql   -f supabase/migrations/202611040001_clients_appointments_sessions.sql   -f supabase/test-bootstrap/06_add_temporary_staff.sql   -f supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql   -f supabase/migrations/202611130002_appointment_reminders.sql   -f supabase/test-bootstrap/07_remove_temporary_staff.sql

# Step 11: the suites, one session each.
for t in role_helpers_test scheduling_access_test lead_workflow_test appointment_reminders_test; do
  psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
    -c "SET kappiness.test_env = 'disposable'" -f "supabase/tests/$t.sql" || break
done

# Step 12: nothing left behind, seeds intact.
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1   -c "SET kappiness.test_env = 'disposable'" -f supabase/test-bootstrap/05_verify_test_state.sql
```

If any step fails part-way, throw the disposable database away and start again with a new empty one, or drop
the objects it created yourself. Step 1 refuses to run on a non-empty `public` schema.

## Assumptions to check against live (read-only)

Step 3 marks everything not confirmed from live as `ASSUMED`. To confirm it, run these on production
in the SQL editor. They are read-only.

```sql
-- Columns, defaults and nullability
SELECT table_name, column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name IN ('psychologists', 'psychologist_availability', 'leads')
ORDER BY table_name, ordinal_position;

-- Constraints (PK, FK, CHECK, including the live status-check name)
SELECT conrelid::regclass, conname, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid IN ('public.psychologists'::regclass, 'public.psychologist_availability'::regclass, 'public.leads'::regclass)
ORDER BY 1, 2;

-- Policies (expressions and roles) and RLS flags
SELECT tablename, policyname, permissive, roles, cmd, qual, with_check
FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('psychologists', 'psychologist_availability')
ORDER BY 1, 2;
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE oid IN ('public.psychologists'::regclass, 'public.psychologist_availability'::regclass);

-- Grants
SELECT table_name, grantee, string_agg(privilege_type, ', ' ORDER BY privilege_type)
FROM information_schema.role_table_grants
WHERE table_schema = 'public' AND table_name IN ('psychologists', 'psychologist_availability')
GROUP BY 1, 2 ORDER BY 1, 2;
```
