# Test database bootstrap (kappiness-crm-test only)

Builds an **empty** copy of the live pre-bundle schema (as of 4 Nov 2026) in the separate Supabase
project `kappiness-crm-test`. The deployment bundle and the three SQL suites then run there exactly as
they would on production. No production data is used: `schema_before_migration.sql` is schema-only,
and `supabase/backups/data_before_migration.sql` must **never** be loaded here.

## Files

| Step | File | Effect |
|---|---|---|
| 1 | `supabase/test-bootstrap/01_baseline_from_snapshot.sql` | Snapshot tables `leads`, `lead_activities`, sequence, trigger, policies and grants. Refuses unless `public` is empty and `auth.users` is empty. |
| 2 | `supabase/migrations/202611030001_crm_staff_membership_rls.sql` | Unchanged. `crm_staff_members` and the restrictive membership policies. On the **test** project only. |
| 3 | `supabase/test-bootstrap/03_live_state_delta.sql` | Live status vocabulary, `psychologists`, `psychologist_availability` with its 5 live policies and anon grants, and the live `is_crm_staff()` and `update_lead_with_history()`, verbatim from `live_function_definitions.csv`. |
| 4 | `supabase/test-bootstrap/04_verify_bootstrap.sql` | Read-only (ROLLBACK). Fails unless the state matches live, every table is empty and `crm_staff_members` has 0 rows. |
| 5 | `supabase/deploy/202611040005_atomic_bundle.sql` | The deployment bundle under test. |
| 6 | `supabase/tests/*.sql` | The three suites. Each ends with ROLLBACK, so `crm_staff_members` stays empty. |

## Commands

Put the **test** project's direct connection string (port 5432, user `postgres`) in `TEST_DB_URL`
yourself. Check that its project ref is the test project's, not production's. Do not use the
transaction pooler (port 6543): the `SET` below must last for the whole session.

```sh
# Steps 1-4 in ONE session; stops at the first error.
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
  -c "SET kappiness.test_env = 'disposable'" \
  -f supabase/test-bootstrap/01_baseline_from_snapshot.sql \
  -f supabase/migrations/202611030001_crm_staff_membership_rls.sql \
  -f supabase/test-bootstrap/03_live_state_delta.sql \
  -f supabase/test-bootstrap/04_verify_bootstrap.sql

# Step 5: the bundle (single transaction).
psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 -f supabase/deploy/202611040005_atomic_bundle.sql

# Step 6: the suites, one session each.
for t in role_helpers_test scheduling_access_test lead_workflow_test; do
  psql "$TEST_DB_URL" --no-psqlrc -v ON_ERROR_STOP=1 \
    -c "SET kappiness.test_env = 'disposable'" -f "supabase/tests/$t.sql" || break
done

# After the suites, this must still print 0.
psql "$TEST_DB_URL" --no-psqlrc -tA -c "SELECT count(*) FROM public.crm_staff_members"
```

If any step fails part-way, delete and recreate the test project, or drop the objects it created
yourself. Step 1 refuses to run on a non-empty `public` schema.

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
