-- Kappiness CRM: BEHAVIOUR CHECK for production deployment 202611130003. Ends in ROLLBACK: changes nothing.
-- GENERATED FILE: DO NOT EDIT. Regenerate with: node scripts/build-production-deploy.mjs (verify with --check)
-- Sources (sha256 with LF line endings):
--   supabase/migrations/202611130001_remediate_role_helpers_and_availability.sql  c4a81f279e2636a13301a88aea0357727e467afadb0678a1454fce3510ad7040
--   supabase/migrations/202611130002_appointment_reminders.sql  7db1cb568e5a80065e5d817fcd504240e36121958637b484f139cf6277203d52
--   supabase/deploy/parts/202611130003_preflight_checks.sql  549cb938eadd218627ebb5395c296242cc561e27a9416c8ab618705e949088a1
--   supabase/deploy/parts/202611130003_admin_assignment.sql  a779e02558ab32668a6213aec7edb8aaf31ecaf14fe55f133041fc0faf8ec2f5
--   supabase/deploy/parts/202611130003_behaviour_checks.sql  694c8d5c93828477e0248443391e89e853b6f9d540ceebf42b7fca126e19975a
--   supabase/deploy/parts/202611130003_postdeploy_checks.sql  5af5882929f3d73bb5c2b09d19409ec0ec266d96e203b55cab61444d34dfb9c2
--
-- Run AFTER the deployment. Success = "Success. No rows returned"; any failure shows BEHAVIOUR FAIL ...

BEGIN;

-- Kappiness CRM production deployment 202611130003: BEHAVIOUR CHECKS (statements, no transaction control).
-- Edit here, then run  node scripts/build-production-deploy.mjs
-- Embedded in 202611130003_02_production_deploy.sql just before COMMIT, and wrapped in BEGIN ... ROLLBACK as
-- 202611130003_04_behaviour_check.sql (re-run any time after the deployment).
--
-- Simulates Supabase logins (request.jwt.claims + SET LOCAL ROLE, the documented SQL Editor technique) for:
-- anon, a random signed-in account, a real active staff member and a real psychologist without membership.
-- Reads only ids and EXISTS/count results; writes nothing (refused calls are expected to fail before writing).
-- Any failure raises, which rolls back the enclosing transaction.

SELECT set_config('deploy.staff_uid',
         (SELECT user_id::text FROM public.crm_staff_members WHERE is_active ORDER BY created_at LIMIT 1), true);
SELECT set_config('deploy.psych_uid',
         coalesce((SELECT p.auth_user_id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id IS NOT NULL
                     AND NOT EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                                     WHERE m.user_id = p.auth_user_id AND m.is_active)
                   ORDER BY p.created_at LIMIT 1), ''), true);
SELECT set_config('deploy.psych_id',
         coalesce((SELECT p.id::text FROM public.psychologists AS p
                   WHERE p.auth_user_id::text = current_setting('deploy.psych_uid', true)), ''), true);
-- Any existing appointment id: cancel_appointment checks permission before status, so a refused call proves the
-- permission check. If the check were broken the call would succeed, X2 would raise, and everything rolls back.
SELECT set_config('deploy.appt_id',
         coalesce((SELECT id::text FROM public.appointments ORDER BY created_at LIMIT 1), ''), true);

-- X1. anon: no access to reminders, availability, psychologists; no reminder RPCs.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE
  denied integer := 0;
BEGIN
  BEGIN PERFORM 1 FROM public.appointment_reminders LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.appointment_reminder_events LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.psychologist_availability LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.psychologists LIMIT 1; EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent'); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM public.is_crm_staff(); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  IF denied <> 6 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X1: anon reached % of 6 protected objects', 6 - denied;
  END IF;
END
$$;
RESET ROLE;

-- X2. A signed-in account with no membership and no psychologist profile: not staff, sees nothing, changes nothing.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
         'app_metadata', json_build_object('role', 'admin'))::text, true);   -- a JWT "admin" claim must not help
DO $$
DECLARE
  refused integer := 0;
  expected integer := 3;
  v_appt uuid := nullif(current_setting('deploy.appt_id', true), '')::uuid;
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM false OR public.is_crm_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login is treated as staff/admin';
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients) OR EXISTS (SELECT 1 FROM public.appointments)
     OR EXISTS (SELECT 1 FROM public.sessions) OR EXISTS (SELECT 1 FROM public.follow_up_recommendations)
     OR EXISTS (SELECT 1 FROM public.psychologist_availability) OR EXISTS (SELECT 1 FROM public.leads)
     OR EXISTS (SELECT 1 FROM public.appointment_reminders) OR EXISTS (SELECT 1 FROM public.appointment_reminder_events)
     OR EXISTS (SELECT 1 FROM public.appointment_reminder_settings) THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login can see CRM rows';
  END IF;
  BEGIN PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent'); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN PERFORM public.set_reminder_offsets(interval '48 hours', interval '1 hour'); EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  IF v_appt IS NOT NULL THEN
    expected := expected + 1;
    BEGIN PERFORM public.cancel_appointment(v_appt, 'deployment permission probe');
    EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  END IF;
  BEGIN
    INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time)
    VALUES ((SELECT id FROM public.psychologists LIMIT 1), 7, '03:00', '03:30');
  EXCEPTION WHEN insufficient_privilege OR not_null_violation THEN refused := refused + 1;
  END;
  IF refused <> expected THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X2: an unknown login was allowed % of % refused actions', expected - refused, expected;
  END IF;
END
$$;

-- X3. A real active staff member: staff, can read reminder configuration, reaches the RPC's own checks.
SELECT set_config('request.jwt.claims',
         json_build_object('sub', current_setting('deploy.staff_uid', true), 'role', 'authenticated')::text, true);
DO $$
DECLARE
  state text;
BEGIN
  IF public.is_crm_staff() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: an active staff member is no longer staff';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_settings) <> 2 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: staff cannot read reminder settings';
  END IF;
  BEGIN
    PERFORM public.record_reminder_delivery(gen_random_uuid(), 'Sent');   -- unknown reminder: P0001, not 42501
  EXCEPTION WHEN OTHERS THEN GET STACKED DIAGNOSTICS state = RETURNED_SQLSTATE;
  END;
  IF state IS DISTINCT FROM 'P0001' THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X3: staff call to record_reminder_delivery returned % instead of P0001', state;
  END IF;
END
$$;

-- X4. A real psychologist without membership: not staff, owns only their profile, no reminder access.
SELECT set_config('request.jwt.claims',
         CASE WHEN current_setting('deploy.psych_uid', true) = '' THEN '{"role":"authenticated"}'
              ELSE json_build_object('sub', current_setting('deploy.psych_uid', true), 'role', 'authenticated')::text END,
         true);
DO $$
DECLARE
  v_pid uuid := nullif(current_setting('deploy.psych_id', true), '')::uuid;
BEGIN
  IF v_pid IS NULL THEN
    RAISE NOTICE 'BEHAVIOUR SKIP X4: no psychologist login without staff membership';
    RETURN;
  END IF;
  IF public.is_crm_staff() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: a psychologist without membership is treated as staff';
  END IF;
  IF public.is_own_psychologist(v_pid) IS DISTINCT FROM true OR public.is_own_psychologist(gen_random_uuid()) IS DISTINCT FROM false
     OR public.current_psychologist_id() IS DISTINCT FROM v_pid THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: psychologist ownership helpers disagree';
  END IF;
  IF EXISTS (SELECT 1 FROM public.psychologist_availability WHERE psychologist_id <> v_pid)
     OR EXISTS (SELECT 1 FROM public.leads)
     OR EXISTS (SELECT 1 FROM public.appointment_reminders) OR EXISTS (SELECT 1 FROM public.appointment_reminder_settings) THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X4: a psychologist sees another psychologist''s availability, leads or reminders';
  END IF;
END
$$;

-- X5. Admin decision: every ACTIVE membership passes is_crm_admin() (and is_crm_staff()); every INACTIVE membership
--     and the psychologist fail both. User ids are read as postgres first (the API role cannot list memberships).
RESET ROLE;
SELECT set_config('deploy.active_uids',
         coalesce((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.crm_staff_members WHERE is_active), ''), true);
SELECT set_config('deploy.inactive_uids',
         coalesce((SELECT string_agg(user_id::text, ',' ORDER BY user_id) FROM public.crm_staff_members WHERE NOT is_active), ''), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  uid text;
  n_active integer := 0;
  n_inactive integer := 0;
BEGIN
  FOREACH uid IN ARRAY coalesce(string_to_array(nullif(current_setting('deploy.active_uids', true), ''), ','), ARRAY[]::text[]) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM true OR public.is_crm_staff() IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: active member % is not admin and staff', uid;
    END IF;
    n_active := n_active + 1;
  END LOOP;
  IF n_active <> 4 THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X5: expected 4 active admins, checked %', n_active;
  END IF;

  FOREACH uid IN ARRAY coalesce(string_to_array(nullif(current_setting('deploy.inactive_uids', true), ''), ','), ARRAY[]::text[]) LOOP
    PERFORM set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM false OR public.is_crm_staff() IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: inactive member % still passes is_crm_admin()/is_crm_staff()', uid;
    END IF;
    n_inactive := n_inactive + 1;
  END LOOP;

  -- The psychologist (no membership) and a stranger with a JWT "admin" claim are not admin.
  IF current_setting('deploy.psych_uid', true) <> '' THEN
    PERFORM set_config('request.jwt.claims',
      json_build_object('sub', current_setting('deploy.psych_uid', true), 'role', 'authenticated')::text, true);
    IF public.is_crm_admin() IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'BEHAVIOUR FAIL X5: a psychologist without membership passes is_crm_admin()';
    END IF;
  END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('sub', gen_random_uuid(), 'role', 'authenticated',
            'app_metadata', json_build_object('role', 'admin'))::text, true);
  IF public.is_crm_admin() IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'BEHAVIOUR FAIL X5: a non-member with a JWT admin claim passes is_crm_admin()';
  END IF;
  RAISE NOTICE 'BEHAVIOUR X5: % active admin(s) pass, % inactive member(s), psychologist and non-member refused', n_active, n_inactive;
END
$$;

RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);

ROLLBACK;
