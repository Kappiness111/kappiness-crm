-- Kappiness CRM TEST BOOTSTRAP, final verification: confirm fixture rollback and preserve service seeds.
-- Run only after the atomic deployment bundle and all three SQL test suites succeeded.
-- TEST PROJECT ONLY. Read-only; creates no users or CRM records and ends with ROLLBACK.

BEGIN;

DO $$
DECLARE
  r record;
  n bigint;
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;

  IF EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'Fixture rollback failed: auth.users contains test users.';
  END IF;
  IF to_regclass('public.crm_staff_members') IS NULL THEN
    RAISE EXCEPTION 'public.crm_staff_members is missing; the staff-membership migration did not run.';
  END IF;
  IF to_regclass('public.services') IS NULL THEN
    RAISE EXCEPTION 'public.services is missing; the atomic bundle was not fully applied.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.crm_staff_members) THEN
    RAISE EXCEPTION 'Fixture rollback failed: crm_staff_members contains test memberships.';
  END IF;

  -- All public tables except services must be empty after the rollback-only suites.
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class AS c
    JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p') AND c.relname <> 'services'
    ORDER BY c.relname
  LOOP
    EXECUTE format('SELECT count(*) FROM %s', r.rel) INTO n;
    IF n <> 0 THEN
      RAISE EXCEPTION 'Fixture rollback failed: % has % rows.', r.rel, n;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM public.services) <> 6 THEN
    RAISE EXCEPTION 'Expected exactly six service seed rows; found %. Do not overwrite or delete these seeds.',
      (SELECT count(*) FROM public.services);
  END IF;

  IF EXISTS (
    SELECT 1
    FROM (VALUES
      ('Individual counselling'::text, 50::integer, 10::integer),
      ('Couples counselling'::text, 60::integer, 10::integer),
      ('Family counselling'::text, 60::integer, 10::integer),
      ('Child & adolescent'::text, 50::integer, 10::integer),
      ('Career guidance'::text, 45::integer, 10::integer),
      ('Workshop / group session'::text, 90::integer, 15::integer)
    ) AS expected(name, duration_minutes, buffer_minutes)
    FULL OUTER JOIN public.services AS actual
      ON actual.name = expected.name
    WHERE expected.name IS NULL
       OR actual.name IS NULL
       OR actual.duration_minutes IS DISTINCT FROM expected.duration_minutes
       OR actual.buffer_minutes IS DISTINCT FROM expected.buffer_minutes
  ) THEN
    RAISE EXCEPTION 'The six service seed records differ from the approved bundle values.';
  END IF;

  RAISE NOTICE 'PASS: fixture rollback verified (no auth users, no CRM fixtures); all six service seed records preserved.';
END
$$;

ROLLBACK;
