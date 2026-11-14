-- Kappiness CRM: access tests for appointments, sessions, clinical notes, recommendations,
-- blocked periods and psychologist availability (202611040001 + 202611130001, which superseded 202611040003/05).
-- Owner: Aswathy (backend / security).
--
-- RUN ONLY ON A DISPOSABLE DATABASE (fresh local stack or Supabase branch). NEVER ON THE LIVE PROJECT.
-- Refuses to start unless  SET kappiness.test_env = 'disposable';  was run AND crm_staff_members is empty.
--
--   psql "<disposable database connection string>" -v ON_ERROR_STOP=1 \
--        -c "SET kappiness.test_env = 'disposable'" -f supabase/tests/scheduling_access_test.sql
--
-- One transaction, ending in ROLLBACK: no fixture is kept. Any failed assertion raises an exception.
--
-- PRECONDITIONS
--   A copy of the live schema (including the five live psychologist_availability policies and the live
--   leads / lead_activities policies) with the production path in supabase/test-bootstrap/README.md applied.
--
-- IDENTITIES
--   ...01 non-member (signed in)            ...02 non-member with JWT app_metadata.role = admin
--   ...04 active staff                      ...06 active admin
--   ...08 psychologist A (treating)         ...09 psychologist B
--   ...0a psychologist C + active staff membership (not admin, not treating)
--
-- FIXTURES (all for psychologist A's client unless stated)
--   completed appointment + session + clinical notes + open recommendation, a blocked period for A,
--   weekly availability for A (Mon) and B (Tue).

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
   Catalog checks for the availability lockdown (202611130001; formerly 202611040005)
   --------------------------------------------------------------------------------------------- */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policy
    WHERE polrelid = 'public.psychologist_availability'::regclass
      AND polname = 'availability_require_staff_or_owner' AND NOT polpermissive AND polcmd = '*'
  ) THEN
    RAISE EXCEPTION 'FAIL K1: restrictive availability policy missing';
  END IF;
  IF has_table_privilege('anon', 'public.psychologist_availability',
                         'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') THEN
    RAISE EXCEPTION 'FAIL K1: anon still has privileges on psychologist_availability';
  END IF;
  IF has_table_privilege('authenticated', 'public.psychologist_availability', 'TRUNCATE') THEN
    RAISE EXCEPTION 'FAIL K1: authenticated can TRUNCATE psychologist_availability';
  END IF;
  IF (SELECT relforcerowsecurity OR NOT relrowsecurity FROM pg_class
      WHERE oid = 'public.psychologist_availability'::regclass) THEN
    RAISE EXCEPTION 'FAIL K1: psychologist_availability RLS must be enabled and not forced';
  END IF;
  RAISE NOTICE 'PASS K1: availability catalog checks';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a000-000000000001', 'sa-nonmember@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000002', 'sa-spoof-admin@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'sa-staff@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000006', 'sa-admin@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000008', 'sa-psych-a@test.invalid',     'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000009', 'sa-psych-b@test.invalid',     'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000a', 'sa-psych-c@test.invalid',     'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a000-000000000004', 'staff', true),
  ('00000000-0000-4000-a000-000000000006', 'admin', true),
  ('00000000-0000-4000-a000-00000000000a', 'staff', true);

INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b000-000000000001', 'SA Psychologist A', '+910000000001', true, '00000000-0000-4000-a000-000000000008'),
  ('00000000-0000-4000-b000-000000000002', 'SA Psychologist B', '+910000000002', true, '00000000-0000-4000-a000-000000000009'),
  ('00000000-0000-4000-b000-000000000003', 'SA Psychologist C', '+910000000003', true, '00000000-0000-4000-a000-00000000000a');

INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id) VALUES
  ('00000000-0000-4000-c000-000000000001', 'SA Client', '+910000000099', 'Confirmed', '00000000-0000-4000-b000-000000000001');

INSERT INTO public.services (id, name, duration_minutes, buffer_minutes)
VALUES ('00000000-0000-4000-f000-000000000001', 'SA test service', 50, 10);

-- A completed appointment two days ago (inserted directly; booking rules are not under test here).
INSERT INTO public.appointments (id, client_id, psychologist_id, service_id, service_type, starts_at, ends_at,
                                 buffer_minutes, status)
SELECT '00000000-0000-4000-d000-000000000001', c.id, '00000000-0000-4000-b000-000000000001',
       '00000000-0000-4000-f000-000000000001', 'SA test service',
       date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()) - interval '2 days' + interval '50 minutes', 10, 'Completed'
FROM public.clients AS c WHERE c.lead_id = '00000000-0000-4000-c000-000000000001';

INSERT INTO public.sessions (id, appointment_id, client_id, psychologist_id, starts_at, ends_at, status, session_type)
SELECT '00000000-0000-4000-d100-000000000001', a.id, a.client_id, a.psychologist_id, a.starts_at, a.ends_at,
       'Completed', 'Initial'
FROM public.appointments AS a WHERE a.id = '00000000-0000-4000-d000-000000000001';

INSERT INTO public.session_notes (session_id, notes)
VALUES ('00000000-0000-4000-d100-000000000001', 'SA clinical note');

INSERT INTO public.follow_up_recommendations (id, session_id, client_id, psychologist_id, recommendation, recommended_date)
SELECT '00000000-0000-4000-d200-000000000001', s.id, s.client_id, s.psychologist_id, 'SA follow up in a week',
       current_date + 7
FROM public.sessions AS s WHERE s.id = '00000000-0000-4000-d100-000000000001';

INSERT INTO public.psychologist_availability_exceptions (id, psychologist_id, starts_at, ends_at, reason)
VALUES ('00000000-0000-4000-d300-000000000001', '00000000-0000-4000-b000-000000000001',
        date_trunc('day', now()) + interval '30 days', date_trunc('day', now()) + interval '31 days', 'SA leave');

-- Weekly availability: A on Monday (1), B on Tuesday (2). Identified by (psychologist_id, day_of_week).
INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active) VALUES
  ('00000000-0000-4000-b000-000000000001', 1, '09:00', '12:00', true),
  ('00000000-0000-4000-b000-000000000002', 2, '09:00', '12:00', true);

/* ---------------------------------------------------------------------------------------------
   R. Read access matrix
   visible?  appt | session | notes | rec | appt hist | session hist | block | avail A | avail B
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  got boolean[];
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('non-member',              '00000000-0000-4000-a000-000000000001'::uuid, NULL::text,
         ARRAY[false, false, false, false, false, false, false, false, false]),
      ('non-member JWT admin',    '00000000-0000-4000-a000-000000000002'::uuid, 'admin',
         ARRAY[false, false, false, false, false, false, false, false, false]),
      ('active staff',            '00000000-0000-4000-a000-000000000004'::uuid, NULL,
         ARRAY[true,  true,  false, true,  true,  true,  true,  true,  true ]),
      ('active admin',            '00000000-0000-4000-a000-000000000006'::uuid, NULL,
         ARRAY[true,  true,  true,  true,  true,  true,  true,  true,  true ]),
      ('treating psychologist A', '00000000-0000-4000-a000-000000000008'::uuid, 'admin',
         ARRAY[true,  true,  true,  true,  true,  true,  true,  true,  false]),
      ('other psychologist B',    '00000000-0000-4000-a000-000000000009'::uuid, NULL,
         ARRAY[false, false, false, false, false, false, false, false, true ]),
      ('psychologist C + staff',  '00000000-0000-4000-a000-00000000000a'::uuid, NULL,
         ARRAY[true,  true,  false, true,  true,  true,  true,  true,  true ])
    ) AS t(label, user_id, app_role, want)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', c.user_id, 'role', 'authenticated',
        'app_metadata', CASE WHEN c.app_role IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('role', c.app_role) END)::text,
      true);
    got := ARRAY[
      EXISTS (SELECT 1 FROM public.appointments WHERE id = '00000000-0000-4000-d000-000000000001'),
      EXISTS (SELECT 1 FROM public.sessions WHERE id = '00000000-0000-4000-d100-000000000001'),
      EXISTS (SELECT 1 FROM public.session_notes WHERE session_id = '00000000-0000-4000-d100-000000000001'),
      EXISTS (SELECT 1 FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000001'),
      EXISTS (SELECT 1 FROM public.appointment_status_history WHERE appointment_id = '00000000-0000-4000-d000-000000000001'),
      EXISTS (SELECT 1 FROM public.session_status_history WHERE session_id = '00000000-0000-4000-d100-000000000001'),
      EXISTS (SELECT 1 FROM public.psychologist_availability_exceptions WHERE id = '00000000-0000-4000-d300-000000000001'),
      EXISTS (SELECT 1 FROM public.psychologist_availability
              WHERE psychologist_id = '00000000-0000-4000-b000-000000000001' AND day_of_week = 1),
      EXISTS (SELECT 1 FROM public.psychologist_availability
              WHERE psychologist_id = '00000000-0000-4000-b000-000000000002' AND day_of_week = 2)
    ];
    IF got IS DISTINCT FROM c.want THEN
      failures := failures || format(E'\n  %s: got %s, want %s', c.label, got, c.want);
    END IF;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL R: read access matrix%', failures; END IF;
  RAISE NOTICE 'PASS R: read access matrix (session notes: admin + treating psychologist only)';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   N. Writing clinical notes (update_session): treating psychologist and admin only
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  allowed boolean;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('treating psychologist A', '00000000-0000-4000-a000-000000000008'::uuid, true),
      ('active admin',            '00000000-0000-4000-a000-000000000006'::uuid, true),
      ('active staff',            '00000000-0000-4000-a000-000000000004'::uuid, false),
      ('psychologist C + staff',  '00000000-0000-4000-a000-00000000000a'::uuid, false),
      ('other psychologist B',    '00000000-0000-4000-a000-000000000009'::uuid, false),
      ('non-member',              '00000000-0000-4000-a000-000000000001'::uuid, false)
    ) AS t(label, user_id, want)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', c.user_id, 'role', 'authenticated')::text, true);
    BEGIN
      PERFORM public.update_session('00000000-0000-4000-d100-000000000001', NULL, NULL,
                                    format('note by %s', c.label), NULL, NULL);
      allowed := true;
    EXCEPTION WHEN insufficient_privilege THEN
      allowed := false;
    END;
    IF allowed IS DISTINCT FROM c.want THEN
      failures := failures || format(E'\n  %s: allowed=%s, want %s', c.label, allowed, c.want);
    END IF;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL N: clinical note writes%', failures; END IF;
  RAISE NOTICE 'PASS N: clinical note writes';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   A. Availability writes (live permissive policies + 040001 policies, limited by the 040005 guard)
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  n integer;
  refused boolean;
BEGIN
  -- A1. Psychologist A adds and edits their own availability.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000008","role":"authenticated"}', true);
  INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
  VALUES ('00000000-0000-4000-b000-000000000001', 3, '09:00', '10:00', true);
  UPDATE public.psychologist_availability SET end_time = '11:00'
  WHERE psychologist_id = '00000000-0000-4000-b000-000000000001' AND day_of_week = 3;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL A1: psychologist A could not update own availability'; END IF;

  -- A2. Psychologist A cannot add availability for psychologist B.
  refused := false;
  BEGIN
    INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
    VALUES ('00000000-0000-4000-b000-000000000002', 4, '09:00', '10:00', true);
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL A2: psychologist A inserted availability for B'; END IF;

  -- A3. Psychologist B cannot change or delete A's rows (RLS filters them: 0 rows).
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000009","role":"authenticated"}', true);
  UPDATE public.psychologist_availability SET is_active = false
  WHERE psychologist_id = '00000000-0000-4000-b000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL A3: psychologist B updated A''s availability'; END IF;
  DELETE FROM public.psychologist_availability WHERE psychologist_id = '00000000-0000-4000-b000-000000000001';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL A3: psychologist B deleted A''s availability'; END IF;

  -- A4. A signed-in non-member (JWT admin) cannot insert, update or delete anything.
  PERFORM set_config('request.jwt.claims',
    '{"sub":"00000000-0000-4000-a000-000000000002","role":"authenticated","app_metadata":{"role":"admin"}}', true);
  refused := false;
  BEGIN
    INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
    VALUES ('00000000-0000-4000-b000-000000000001', 5, '09:00', '10:00', true);
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL A4: non-member inserted availability'; END IF;
  UPDATE public.psychologist_availability SET is_active = false
  WHERE psychologist_id IN ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-000000000002');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL A4: non-member updated availability'; END IF;
  DELETE FROM public.psychologist_availability
  WHERE psychologist_id IN ('00000000-0000-4000-b000-000000000001', '00000000-0000-4000-b000-000000000002');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL A4: non-member deleted availability'; END IF;

  -- A5. Active staff manage any psychologist's availability.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);
  INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
  VALUES ('00000000-0000-4000-b000-000000000002', 4, '14:00', '16:00', true);
  UPDATE public.psychologist_availability SET end_time = '12:30'
  WHERE psychologist_id = '00000000-0000-4000-b000-000000000001' AND day_of_week = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL A5: staff could not update A''s availability'; END IF;

  RAISE NOTICE 'PASS A: availability writes';
END
$$;
RESET ROLE;

-- A6. anon has no access at all.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE
  denied integer := 0;
BEGIN
  BEGIN PERFORM 1 FROM public.psychologist_availability LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN
    INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time)
    VALUES ('00000000-0000-4000-b000-000000000001', 6, '09:00', '10:00');
  EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  BEGIN PERFORM 1 FROM public.session_notes LIMIT 1;
  EXCEPTION WHEN insufficient_privilege THEN denied := denied + 1; END;
  IF denied <> 3 THEN RAISE EXCEPTION 'FAIL A6: anon reached availability or session notes (% of 3 denied)', denied; END IF;
  RAISE NOTICE 'PASS A6: anon denied';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   B. Blocked periods and booking across psychologists
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  refused integer := 0;
BEGIN
  -- Psychologist B cannot block A's time or book A's client.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000009","role":"authenticated"}', true);
  BEGIN
    PERFORM public.add_availability_block('00000000-0000-4000-b000-000000000001',
      date_trunc('day', now()) + interval '40 days', date_trunc('day', now()) + interval '41 days', 'x');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;
  BEGIN
    PERFORM public.book_appointment(
      (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001'),
      '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-f000-000000000001', now() + interval '3 days');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;

  -- A non-member cannot block anyone's time.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
  BEGIN
    PERFORM public.add_availability_block('00000000-0000-4000-b000-000000000001',
      date_trunc('day', now()) + interval '40 days', date_trunc('day', now()) + interval '41 days', 'x');
  EXCEPTION WHEN insufficient_privilege THEN refused := refused + 1; END;

  IF refused <> 3 THEN RAISE EXCEPTION 'FAIL B: expected 3 refusals, got %', refused; END IF;

  -- Psychologist A blocks their own free period.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000008","role":"authenticated"}', true);
  PERFORM public.add_availability_block('00000000-0000-4000-b000-000000000001',
    date_trunc('day', now()) + interval '40 days', date_trunc('day', now()) + interval '41 days', 'own leave');

  RAISE NOTICE 'PASS B: blocked periods and cross-psychologist booking';
END
$$;
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL SCHEDULING ACCESS TESTS PASSED (rolling back fixtures)'; END $$;

ROLLBACK;
