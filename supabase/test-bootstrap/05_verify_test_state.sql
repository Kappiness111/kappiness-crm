-- Kappiness CRM TEST BOOTSTRAP, final verification: confirm fixture rollback and preserve service seeds.
-- Run only after the production path (README.md steps 5-10) and all four SQL test suites succeeded.
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
    RAISE EXCEPTION 'public.services is missing; 202611040001 was not applied.';
  END IF;
  IF to_regclass('public.appointment_reminder_settings') IS NULL THEN
    RAISE EXCEPTION 'public.appointment_reminder_settings is missing; 202611130002 was not applied.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.crm_staff_members) THEN
    RAISE EXCEPTION 'Fixture rollback failed: crm_staff_members contains test memberships.';
  END IF;

  -- All public tables except the seeded ones (services, appointment_reminder_settings) must be empty after the
  -- rollback-only suites.
  FOR r IN
    SELECT c.oid::regclass AS rel
    FROM pg_class AS c
    JOIN pg_namespace AS ns ON ns.oid = c.relnamespace
    WHERE ns.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND c.relname NOT IN ('services', 'appointment_reminder_settings')
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
    RAISE EXCEPTION 'The six service seed records differ from the approved 202611040001 values.';
  END IF;

  -- 202611130002 seeds the reminder timing: exactly reminder 1 = 24 hours, reminder 2 = 2 hours.
  IF (SELECT string_agg(reminder_number || '=' || offset_before_start, ',' ORDER BY reminder_number)
      FROM public.appointment_reminder_settings) IS DISTINCT FROM '1=24:00:00,2=02:00:00' THEN
    RAISE EXCEPTION 'appointment_reminder_settings differs from the 202611130002 seed (1=24:00:00,2=02:00:00).';
  END IF;

  RAISE NOTICE 'PASS: fixture rollback verified (no auth users, no CRM fixtures); six service seeds and the two reminder-timing seeds preserved.';
END
$$;

ROLLBACK;
