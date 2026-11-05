-- Kappiness CRM TEST BOOTSTRAP, step 4 of 4: read-only verification. Changes nothing (ends with ROLLBACK).
-- Owner: Aswathy (backend / testing).
--
-- Confirms the test project is in the live pre-bundle state and empty, so the deployment bundle and the
-- three SQL suites start from the same place they will on production:
--   * every public table is empty; auth.users is empty; crm_staff_members has ZERO rows
--   * the live functions are present with the live bodies, settings and grants
--   * the objects the five bundle files require are present; the objects the bundle creates are absent
--   * no FORCE ROW LEVEL SECURITY; postgres owns the tables the definer functions read

BEGIN;

DO $$
DECLARE
  r record;
  n bigint;
  def record;
  body_md5 text;
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;

  -- 1. No data anywhere in public; no users.
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class AS c JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
  LOOP
    EXECUTE format('SELECT count(*) FROM %s', r.rel) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION '% has % rows; the test project must be empty.', r.rel, n;
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'auth.users is not empty.';
  END IF;
  IF (SELECT count(*) FROM public.crm_staff_members) <> 0 THEN
    RAISE EXCEPTION 'crm_staff_members must have zero rows before the tests.';
  END IF;

  -- 2. Exactly the expected public tables (live pre-bundle set).
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname)
      FROM pg_class AS c JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
      WHERE ns.nspname = 'public' AND c.relkind = 'r')
     IS DISTINCT FROM ARRAY['crm_staff_members', 'lead_activities', 'leads', 'psychologist_availability', 'psychologists'] THEN
    RAISE EXCEPTION 'Unexpected set of public tables; rebuild the test project from scratch.';
  END IF;

  -- 3. Objects the bundle creates must not exist yet.
  IF to_regclass('public.appointments') IS NOT NULL OR to_regclass('public.clients') IS NOT NULL
     OR to_regclass('public.psychologist_availability_exceptions') IS NOT NULL
     OR to_regprocedure('public.is_crm_admin()') IS NOT NULL
     OR to_regprocedure('public.enforce_lead_workflow()') IS NOT NULL
     OR EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'assigned_psychologist_id')
     OR EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'Bundle objects already exist: this is not the pre-bundle state.';
  END IF;

  -- 4. Requirements of the five bundle files.
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'crm_staff_members'
        AND column_name IN ('user_id', 'is_active', 'access_level')) <> 3 THEN
    RAISE EXCEPTION 'crm_staff_members is missing user_id / is_active / access_level (040003).';
  END IF;
  IF (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.psychologists'::regclass AND attname = 'id' AND NOT attisdropped) IS DISTINCT FROM 'uuid' THEN
    RAISE EXCEPTION 'psychologists.id must be uuid (030002 foreign key, 040001 tables).';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'psychologists'
        AND column_name IN ('id', 'auth_user_id', 'full_name', 'is_active', 'phone')) <> 5 THEN
    RAISE EXCEPTION 'psychologists is missing columns used by 040001 or the tests.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'psychologist_availability'
        AND column_name IN ('id', 'psychologist_id', 'day_of_week', 'start_time', 'end_time', 'is_active')) <> 6 THEN
    RAISE EXCEPTION 'psychologist_availability is missing columns used by 040001.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'leads'
        AND column_name IN ('status', 'not_converted_reason', 'next_follow_up_at', 'updated_at')) <> 4 THEN
    RAISE EXCEPTION 'leads is missing columns used by 030002 / 040001.';
  END IF;
  IF coalesce(pg_get_constraintdef((SELECT oid FROM pg_constraint
        WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check')), '') NOT LIKE '%Yet to Confirm%' THEN
    RAISE EXCEPTION 'leads_status_check does not hold the live status vocabulary.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relforcerowsecurity AND oid IN (
       'public.crm_staff_members'::regclass, 'public.psychologists'::regclass, 'public.psychologist_availability'::regclass)) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY must be off (040003 / 040005).';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relowner <> 'postgres'::regrole AND oid IN (
       'public.crm_staff_members'::regclass, 'public.psychologists'::regclass,
       'public.psychologist_availability'::regclass, 'public.leads'::regclass)) THEN
    RAISE EXCEPTION 'postgres must own the CRM tables (as on live). Run the bootstrap as postgres.';
  END IF;
  IF (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.psychologist_availability'::regclass) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'RLS must be enabled on psychologist_availability (live state).';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.psychologist_availability'::regclass AND polpermissive) <> 5 THEN
    RAISE EXCEPTION 'psychologist_availability must have the five live permissive policies.';
  END IF;
  IF NOT has_table_privilege('anon', 'public.psychologist_availability', 'SELECT, INSERT, UPDATE, DELETE') THEN
    RAISE EXCEPTION 'anon must start with the live availability grants (040005 must be seen to remove them).';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polname = 'Require active CRM staff membership' AND NOT polpermissive
        AND polrelid IN ('public.leads'::regclass, 'public.lead_activities'::regclass)) <> 2 THEN
    RAISE EXCEPTION 'The restrictive membership policies from 202611030001 are missing.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.leads'::regclass AND NOT tgisinternal AND tgname <> 'set_lead_code') THEN
    RAISE EXCEPTION 'leads must have only the set_lead_code trigger (live state).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_available_extensions WHERE name = 'btree_gist') THEN
    RAISE EXCEPTION 'btree_gist is not available (040001).';
  END IF;

  -- 5. Live functions: bodies (CR-insensitive md5 of prosrc), settings, grants.
  SELECT p.prosecdef, p.provolatile, p.proconfig, p.proowner, md5(replace(p.prosrc, E'\r', '')) AS m INTO def
  FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.is_crm_staff()');
  IF def.m IS DISTINCT FROM '43d6701416acdb74d80c33ad93167267' OR def.prosecdef IS DISTINCT FROM true
     OR def.provolatile IS DISTINCT FROM 's' OR def.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR def.proowner IS DISTINCT FROM 'postgres'::regrole THEN
    RAISE EXCEPTION 'is_crm_staff() does not match live (body md5 %).', def.m;
  END IF;

  SELECT p.prosecdef, p.provolatile, p.proconfig, p.proowner, md5(replace(p.prosrc, E'\r', '')) AS m INTO def
  FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)');
  body_md5 := def.m;
  IF body_md5 IS DISTINCT FROM '0d07f2ccc6f8e6b1737d4cacc8103804' OR def.prosecdef IS DISTINCT FROM false
     OR def.provolatile IS DISTINCT FROM 'v' OR def.proconfig IS DISTINCT FROM ARRAY['search_path=public']
     OR def.proowner IS DISTINCT FROM 'postgres'::regrole THEN
    RAISE EXCEPTION 'update_lead_with_history does not match live (body md5 %).', body_md5;
  END IF;

  IF has_function_privilege('anon', 'public.is_crm_staff()', 'EXECUTE')
     OR has_function_privilege('anon', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.is_crm_staff()', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Live function EXECUTE grants are not reproduced (authenticated yes, anon no).';
  END IF;

  RAISE NOTICE 'Test bootstrap verified: live pre-bundle state, all tables empty, crm_staff_members = 0 rows, update_lead_with_history body md5 %.', body_md5;
END
$$;

ROLLBACK;
