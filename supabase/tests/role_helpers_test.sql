-- Kappiness CRM: tests for the membership-based role helpers is_crm_staff() / is_crm_admin(), as installed on
-- production by 202611130001 (identical to the superseded 202611040003).
-- Owner: Aswathy (backend / security).
--
-- RUN ONLY ON A DISPOSABLE DATABASE (fresh local stack or Supabase branch). NEVER ON THE LIVE PROJECT.
-- The script refuses to start unless BOTH are true:
--   1. the session opted in:  SET kappiness.test_env = 'disposable';
--   2. public.crm_staff_members is empty before the fixtures are added (live has enrolled staff).
--
--   psql "<disposable database connection string>" -v ON_ERROR_STOP=1 \
--        -c "SET kappiness.test_env = 'disposable'" -f supabase/tests/role_helpers_test.sql
--
-- Everything runs in one transaction that ends with ROLLBACK: fixtures (auth users, staff memberships,
-- psychologists, a lead and its client) are never kept. Any failed assertion raises an exception.
--
-- PRECONDITIONS (database state the tests expect)
--   A copy of the live schema (leads, lead_activities, psychologists, psychologist_availability with their
--   live policies, crm_staff_members from 202611030001), then the production path in
--   supabase/test-bootstrap/README.md (202611030002, 202611040001, 202611130001, 202611130002).
--   psychologists: id uuid, auth_user_id uuid NOT NULL, full_name text NOT NULL, is_active boolean NOT NULL
--   (confirmed on live 4 Nov 2026). phone is assumed to exist (the app reads it); it is not confirmed as
--   NOT NULL, so the fixture supplies it.
--
-- Related suites: scheduling_access_test.sql (sessions, notes, availability), lead_workflow_test.sql.
--
-- WHAT IS COVERED
--   A. Catalog checks: definitions, SECURITY DEFINER, search_path, execute grants.
--   B. Helper results for every identity in the role matrix (including spoofed JWT roles).
--   C. The helpers protect real policies and functions: a signed-in non-member gets no client rows,
--      cannot write services, and is refused by staff-only workflow functions.

BEGIN;

-- Disposable-database guard.
DO $$
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first, on a disposable database only.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.crm_staff_members) THEN
    RAISE EXCEPTION 'Refusing to run: crm_staff_members already has rows, so this is not a disposable database.';
  END IF;
END
$$;

/* ---------------------------------------------------------------------------------------------
   A. Catalog checks
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  fn text;
  def record;
BEGIN
  FOREACH fn IN ARRAY ARRAY['public.is_crm_staff()', 'public.is_crm_admin()'] LOOP
    SELECT p.prosecdef, p.prosrc, p.proconfig, p.provolatile INTO def
    FROM pg_proc AS p WHERE p.oid = to_regprocedure(fn);

    IF def IS NULL THEN RAISE EXCEPTION 'FAIL A: % does not exist', fn; END IF;
    IF NOT def.prosecdef THEN RAISE EXCEPTION 'FAIL A: % must be SECURITY DEFINER', fn; END IF;
    IF def.provolatile <> 's' THEN RAISE EXCEPTION 'FAIL A: % must be STABLE', fn; END IF;
    IF NOT ('search_path=""' = ANY (coalesce(def.proconfig, ARRAY[]::text[]))) THEN
      RAISE EXCEPTION 'FAIL A: % must pin an empty search_path', fn;
    END IF;
    IF position('crm_staff_members' IN def.prosrc) = 0 THEN
      RAISE EXCEPTION 'FAIL A: % must read crm_staff_members', fn;
    END IF;
    IF position('crm_role' IN def.prosrc) > 0 OR position('app_metadata' IN def.prosrc) > 0
       OR position('psychologists' IN def.prosrc) > 0 THEN
      RAISE EXCEPTION 'FAIL A: % must not use JWT roles or psychologist profiles', fn;
    END IF;
    IF has_function_privilege('anon', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL A: anon can execute %', fn;
    END IF;
    IF NOT has_function_privilege('authenticated', fn, 'EXECUTE') THEN
      RAISE EXCEPTION 'FAIL A: authenticated cannot execute %', fn;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS A: catalog checks';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures (as the session owner; rolled back at the end)
   Identities:
     u_nonmember   signed in (e.g. Google), no membership, no psychologist profile
     u_spoof_admin signed in, no membership, JWT app_metadata.role = 'admin'
     u_spoof_staff signed in, no membership, JWT app_metadata.role = 'staff'
     u_staff       active staff
     u_staff_off   inactive staff
     u_admin       active admin
     u_admin_off   inactive admin
     u_psych       psychologist A, no membership (JWT role 'admin' too, to prove it is ignored)
     u_psych_other psychologist B, no membership
     u_psych_staff psychologist C with active staff membership
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a000-000000000001', 'rh-nonmember@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000002', 'rh-spoof-admin@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000003', 'rh-spoof-staff@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'rh-staff@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000005', 'rh-staff-off@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000006', 'rh-admin@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000007', 'rh-admin-off@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000008', 'rh-psych@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000009', 'rh-psych-other@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000a', 'rh-psych-staff@test.invalid', 'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a000-000000000004', 'staff', true),
  ('00000000-0000-4000-a000-000000000005', 'staff', false),
  ('00000000-0000-4000-a000-000000000006', 'admin', true),
  ('00000000-0000-4000-a000-000000000007', 'admin', false),
  ('00000000-0000-4000-a000-00000000000a', 'staff', true);

INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b000-000000000001', 'RH Test Psychologist A', '+910000000001', true, '00000000-0000-4000-a000-000000000008'),
  ('00000000-0000-4000-b000-000000000002', 'RH Test Psychologist B', '+910000000002', true, '00000000-0000-4000-a000-000000000009'),
  ('00000000-0000-4000-b000-000000000003', 'RH Test Psychologist C', '+910000000003', true, '00000000-0000-4000-a000-00000000000a');

-- A confirmed lead for psychologist A: the sync_client_from_lead trigger creates its client.
INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id) VALUES
  ('00000000-0000-4000-c000-000000000001', 'RH Test Client', '+910000000099', 'Confirmed',
   '00000000-0000-4000-b000-000000000001');

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001') THEN
    RAISE EXCEPTION 'FIXTURE: the confirmed lead did not create a client (check 202611040001 is applied).';
  END IF;
END
$$;

/* ---------------------------------------------------------------------------------------------
   B. Helper results per identity
   Expected: (is_crm_staff, is_crm_admin)
   --------------------------------------------------------------------------------------------- */

-- B1. anon cannot execute the helpers at all.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE
  denied integer := 0;
BEGIN
  BEGIN PERFORM public.is_crm_staff(); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM public.is_crm_admin(); EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  IF denied <> 2 THEN RAISE EXCEPTION 'FAIL B1: anon was able to execute a role helper'; END IF;
  RAISE NOTICE 'PASS B1: anon denied';
END
$$;
RESET ROLE;

-- B2. Every authenticated identity, including spoofed JWT roles.
--     Each case switches identity with a transaction-local set_config; the role switch happens once, outside.
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  got_staff boolean;
  got_admin boolean;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('signed in, no membership (Google user)', '00000000-0000-4000-a000-000000000001'::uuid, NULL::text,     false, false),
      ('JWT role admin, no membership',          '00000000-0000-4000-a000-000000000002'::uuid, 'admin',        false, false),
      ('JWT role staff, no membership',          '00000000-0000-4000-a000-000000000003'::uuid, 'staff',        false, false),
      ('active staff',                           '00000000-0000-4000-a000-000000000004'::uuid, NULL,           true,  false),
      ('inactive staff',                         '00000000-0000-4000-a000-000000000005'::uuid, 'staff',        false, false),
      ('active admin',                           '00000000-0000-4000-a000-000000000006'::uuid, NULL,           true,  true),
      ('inactive admin',                         '00000000-0000-4000-a000-000000000007'::uuid, 'admin',        false, false),
      ('psychologist, no membership, JWT admin', '00000000-0000-4000-a000-000000000008'::uuid, 'admin',        false, false),
      ('psychologist + active staff membership', '00000000-0000-4000-a000-00000000000a'::uuid, 'psychologist', true,  false),
      ('unknown user id (no auth.users row)',    '00000000-0000-4000-a000-0000000000ff'::uuid, 'admin',        false, false)
    ) AS t(label, user_id, app_role, want_staff, want_admin)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', c.user_id, 'role', 'authenticated',
                         'app_metadata', CASE WHEN c.app_role IS NULL THEN '{}'::jsonb
                                              ELSE jsonb_build_object('role', c.app_role) END)::text,
      true);
    got_staff := public.is_crm_staff();
    got_admin := public.is_crm_admin();
    IF got_staff IS DISTINCT FROM c.want_staff OR got_admin IS DISTINCT FROM c.want_admin THEN
      failures := failures || format(E'\n  %s: staff=%s admin=%s (want %s/%s)',
        c.label, got_staff, got_admin, c.want_staff, c.want_admin);
    END IF;
  END LOOP;

  -- No identity at all (signed-in role, no sub claim): never NULL, always false.
  PERFORM set_config('request.jwt.claims', '{"role":"authenticated"}', true);
  IF public.is_crm_staff() IS DISTINCT FROM false OR public.is_crm_admin() IS DISTINCT FROM false THEN
    failures := failures || E'\n  no sub claim: helpers must return false, not NULL/true';
  END IF;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL B2:%', failures; END IF;
  RAISE NOTICE 'PASS B2: role matrix';
END
$$;
RESET ROLE;

-- B3. Membership changes take effect immediately (no cached role).
UPDATE public.crm_staff_members SET is_active = false WHERE user_id = '00000000-0000-4000-a000-000000000004';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);
DO $$
BEGIN
  IF public.is_crm_staff() THEN RAISE EXCEPTION 'FAIL B3: deactivated staff still counts as staff'; END IF;
  RAISE NOTICE 'PASS B3: deactivation is immediate';
END
$$;
RESET ROLE;
UPDATE public.crm_staff_members SET is_active = true WHERE user_id = '00000000-0000-4000-a000-000000000004';

/* ---------------------------------------------------------------------------------------------
   C. The helpers protect real policies and functions (202611040001)
   --------------------------------------------------------------------------------------------- */

-- C1. Signed-in non-member, even with a spoofed JWT role: no client or lead rows, no writes,
--     staff-only workflow functions refuse.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated","app_metadata":{"role":"admin"}}', true);
DO $$
DECLARE
  n integer;
  refused integer := 0;
BEGIN
  SELECT count(*) INTO n FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C1: non-member can read the client'; END IF;

  SELECT count(*) INTO n FROM public.leads WHERE id = '00000000-0000-4000-c000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C1: non-member can read the lead'; END IF;

  BEGIN
    INSERT INTO public.services (name, duration_minutes, buffer_minutes) VALUES ('RH test service', 50, 10);
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1;
  END;

  BEGIN
    PERFORM public.confirm_appointment(gen_random_uuid());
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1;
  END;

  BEGIN
    PERFORM public.close_recommendation(gen_random_uuid(), 'Completed', 'test');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1;
  END;

  BEGIN
    PERFORM public.assign_client_psychologist(gen_random_uuid(), '00000000-0000-4000-b000-000000000002');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1;
  END;

  BEGIN
    PERFORM public.book_appointment(gen_random_uuid(), '00000000-0000-4000-b000-000000000001',
      gen_random_uuid(), now() + interval '1 day');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1;
  END;

  IF refused <> 5 THEN
    RAISE EXCEPTION 'FAIL C1: expected 5 permission refusals for a non-member, got %', refused;
  END IF;
  RAISE NOTICE 'PASS C1: non-member blocked from clients, leads, services and staff workflows';
END
$$;
RESET ROLE;

-- C2. Active staff can read the client and the lead.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C2: active staff cannot read the client'; END IF;
  SELECT count(*) INTO n FROM public.leads WHERE id = '00000000-0000-4000-c000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C2: active staff cannot read the lead'; END IF;
  RAISE NOTICE 'PASS C2: active staff access';
END
$$;
RESET ROLE;

-- C3. Psychologist A (no membership, JWT role admin) sees only their own client and no leads;
--     psychologist B sees neither.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims',
  '{"sub":"00000000-0000-4000-a000-000000000008","role":"authenticated","app_metadata":{"role":"admin"}}', true);
DO $$
DECLARE
  n integer;
BEGIN
  IF public.current_psychologist_id() IS DISTINCT FROM '00000000-0000-4000-b000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL C3: current_psychologist_id() did not resolve psychologist A';
  END IF;
  SELECT count(*) INTO n FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C3: psychologist A cannot read their own client'; END IF;
  SELECT count(*) INTO n FROM public.leads WHERE id = '00000000-0000-4000-c000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C3: psychologist A can read leads'; END IF;
  BEGIN
    PERFORM public.confirm_appointment(gen_random_uuid());
    RAISE EXCEPTION 'FAIL C3: psychologist A passed a staff-only function';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000009","role":"authenticated"}', true);
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001';
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C3: psychologist B can read psychologist A''s client'; END IF;
  RAISE NOTICE 'PASS C3: psychologist scoping';
END
$$;
RESET ROLE;

-- C4. Psychologist C with an active staff membership gets staff access (decision: membership decides).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-00000000000a","role":"authenticated"}', true);
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001';
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C4: psychologist with staff membership lacks staff read access'; END IF;
  RAISE NOTICE 'PASS C4: staff membership wins over psychologist profile';
END
$$;
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL ROLE HELPER TESTS PASSED (rolling back fixtures)'; END $$;

ROLLBACK;
