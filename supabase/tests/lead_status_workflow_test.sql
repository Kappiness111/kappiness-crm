-- Kappiness CRM (Day 21): tests for the eight lead statuses and the new lead workflow
-- (migration 20261123161850_lead_status_workflow_eight_statuses.sql).
-- Owner: Aswathy (backend / database).
--
-- RUN ONLY ON A DISPOSABLE DATABASE (fresh local stack, Supabase branch or in-memory PGlite). NEVER ON THE LIVE PROJECT.
-- Refuses to start unless  SET kappiness.test_env = 'disposable';  was run AND crm_staff_members is empty.
--
--   psql "<disposable database connection string>" --no-psqlrc -v ON_ERROR_STOP=1 \
--        -c "SET kappiness.test_env = 'disposable'" -f supabase/tests/lead_status_workflow_test.sql
--
-- One transaction, ending in ROLLBACK. Any failed assertion raises an exception.
--
-- PRECONDITIONS
--   The production path from supabase/test-bootstrap/README.md (bootstrap + 202611030002 + 202611040001 +
--   202611130001 + 202611130002), then 20261123150448.
--
-- WHAT IS COVERED
--   T0  catalog: constraint, default, triggers, function settings/grants, RLS + membership policies, backup table
--   T1  all 26 allowed transitions through update_lead_with_history (one status activity each; Confirmed -> client)
--   T1b all 26 allowed transitions as direct UPDATEs (the trigger is the single source of the matrix)
--   T2  all 30 forbidden transitions refused by the function AND by direct UPDATE; no row change, no history
--   T3  reason rules for Not Interested and Lost Lead; non-closed statuses never need a reason
--   T4  Confirmed needs an ACTIVE psychologist; exactly one client is created
--   T5  history: the right lead_activities rows on success, none on failure, existing history byte-for-byte unchanged
--   T6  authorization: anon, non-member, inactive staff, psychologist, spoofed JWT admin; trigger check without RLS
--   T7  regression: lead code + default status on insert, old statuses refused, existing update behaviour
--   T8  both closed statuses with the drawer's payloads: reason required, history names the status, reason edits
-- Rejections are asserted by SQLSTATE class and by the unchanged row, not by message text.

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
   T0. Catalog
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  v_text text;
BEGIN
  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check';
  IF v_text IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))' THEN
    RAISE EXCEPTION 'FAIL T0: leads_status_check is %', v_text;
  END IF;

  SELECT column_default INTO v_text FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'status';
  IF v_text IS DISTINCT FROM '''New Lead''::text' THEN RAISE EXCEPTION 'FAIL T0: status default is %', v_text; END IF;

  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'lost_lead_requires_reason';
  IF v_text IS NOT NULL AND v_text NOT LIKE '%Not Interested%Lost Lead%' THEN
    RAISE EXCEPTION 'FAIL T0: lost_lead_requires_reason still targets the old status: %', v_text;
  END IF;

  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'FAIL T0: triggers on leads are %', v_text;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_proc
             WHERE oid IN (to_regprocedure('public.enforce_lead_workflow()'),
                           to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)'))
               AND (prosecdef OR coalesce(proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public']))
     OR (SELECT count(*) FROM pg_proc
         WHERE oid IN (to_regprocedure('public.enforce_lead_workflow()'),
                       to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)'))) <> 2 THEN
    RAISE EXCEPTION 'FAIL T0: lead functions must exist, be SECURITY INVOKER and keep search_path=public';
  END IF;
  IF pg_get_function_result(to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)')) <> 'jsonb' THEN
    RAISE EXCEPTION 'FAIL T0: update_lead_with_history must still return jsonb';
  END IF;
  IF has_function_privilege('anon', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL T0: update_lead_with_history grants changed';
  END IF;

  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leads'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lead_activities'::regclass) THEN
    RAISE EXCEPTION 'FAIL T0: RLS is off on leads or lead_activities';
  END IF;
  IF (SELECT count(*) FROM pg_policies
      WHERE schemaname = 'public' AND tablename IN ('leads', 'lead_activities')
        AND policyname = 'Require active CRM staff membership' AND permissive = 'RESTRICTIVE') <> 2 THEN
    RAISE EXCEPTION 'FAIL T0: the restrictive membership policies on leads / lead_activities are missing';
  END IF;

  IF to_regclass('public.leads_status_backup_20261123150448') IS NULL
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.leads_status_backup_20261123150448'::regclass)
     OR has_table_privilege('authenticated', 'public.leads_status_backup_20261123150448', 'SELECT')
     OR has_table_privilege('anon', 'public.leads_status_backup_20261123150448', 'SELECT') THEN
    RAISE EXCEPTION 'FAIL T0: status backup table missing or exposed to API roles';
  END IF;
  RAISE NOTICE 'PASS T0: constraint, default, triggers, function settings and grants, RLS, backup table';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures (as the table owner, no JWT)
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a000-000000000001', 'd21-nonmember@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'd21-staff@test.invalid',     'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000005', 'd21-inactive@test.invalid',  'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000008', 'd21-psych-a@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000b', 'd21-psych-off@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000c', 'd21-jwt-admin@test.invalid', 'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a000-000000000004', 'staff', true),
  ('00000000-0000-4000-a000-000000000005', 'staff', false);

INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b000-000000000001', 'D21 Psychologist A', '+910000000001', true,  '00000000-0000-4000-a000-000000000008'),
  ('00000000-0000-4000-b000-000000000004', 'D21 Inactive',       '+910000000004', false, '00000000-0000-4000-a000-00000000000b');

-- The specification, written independently of the function.
CREATE TEMP TABLE _d21t_status (status text PRIMARY KEY, ord integer NOT NULL) ON COMMIT DROP;
INSERT INTO _d21t_status VALUES
  ('New Lead', 1), ('Contacted', 2), ('Interested', 3), ('Follow-up Required', 4),
  ('Awaiting Confirmation', 5), ('Confirmed', 6), ('Not Interested', 7), ('Lost Lead', 8);

CREATE TEMP TABLE _d21t_allowed (from_status text, to_status text, PRIMARY KEY (from_status, to_status)) ON COMMIT DROP;
INSERT INTO _d21t_allowed VALUES
  ('New Lead', 'Contacted'), ('New Lead', 'Interested'), ('New Lead', 'Follow-up Required'),
  ('New Lead', 'Awaiting Confirmation'), ('New Lead', 'Not Interested'), ('New Lead', 'Lost Lead'),
  ('Contacted', 'Interested'), ('Contacted', 'Follow-up Required'), ('Contacted', 'Awaiting Confirmation'),
  ('Contacted', 'Not Interested'), ('Contacted', 'Lost Lead'),
  ('Interested', 'Follow-up Required'), ('Interested', 'Awaiting Confirmation'), ('Interested', 'Confirmed'),
  ('Interested', 'Not Interested'), ('Interested', 'Lost Lead'),
  ('Follow-up Required', 'Contacted'), ('Follow-up Required', 'Interested'),
  ('Follow-up Required', 'Awaiting Confirmation'), ('Follow-up Required', 'Confirmed'),
  ('Follow-up Required', 'Not Interested'), ('Follow-up Required', 'Lost Lead'),
  ('Awaiting Confirmation', 'Follow-up Required'), ('Awaiting Confirmation', 'Confirmed'),
  ('Awaiting Confirmation', 'Not Interested'), ('Awaiting Confirmation', 'Lost Lead');

CREATE TEMP TABLE _d21t_forbidden ON COMMIT DROP AS
SELECT f.status AS from_status, t.status AS to_status
FROM _d21t_status AS f CROSS JOIN _d21t_status AS t
WHERE f.status <> t.status
  AND NOT EXISTS (SELECT 1 FROM _d21t_allowed AS a WHERE a.from_status = f.status AND a.to_status = t.status);

GRANT SELECT ON _d21t_status, _d21t_allowed, _d21t_forbidden TO authenticated;

DO $$
BEGIN
  IF (SELECT count(*) FROM _d21t_allowed) <> 26 OR (SELECT count(*) FROM _d21t_forbidden) <> 30 THEN
    RAISE EXCEPTION 'FAIL fixtures: expected 26 allowed and 30 forbidden transitions';
  END IF;
  IF (SELECT count(*) FROM _d21t_forbidden WHERE (from_status, to_status) IN (
        ('New Lead', 'Confirmed'), ('Confirmed', 'Contacted'), ('Not Interested', 'Interested'),
        ('Lost Lead', 'New Lead'))) <> 4 THEN
    RAISE EXCEPTION 'FAIL fixtures: a required forbidden example is missing';
  END IF;
END
$$;

-- One lead per transition and path: ids are md5 of '<path>:<from>><to>', so each test finds its own lead.
--   r = through the function (T1), d = direct UPDATE (T1b), f = forbidden (T2).
INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id, not_converted_reason)
SELECT md5(x.path || ':' || x.from_status || '>' || x.to_status)::uuid,
       'D21 ' || x.path || ' ' || x.from_status || ' > ' || x.to_status,
       '+9199' || substr(md5(x.path || x.from_status || x.to_status), 1, 8),
       x.from_status,
       CASE WHEN x.from_status = 'Confirmed' THEN '00000000-0000-4000-b000-000000000001'::uuid END,
       CASE WHEN x.from_status IN ('Not Interested', 'Lost Lead') THEN 'D21 seed reason' END
FROM (SELECT from_status, to_status, 'r' AS path FROM _d21t_allowed
      UNION ALL SELECT from_status, to_status, 'd' FROM _d21t_allowed
      UNION ALL SELECT from_status, to_status, 'f' FROM _d21t_forbidden) AS x;

-- Named leads for the remaining tests (suffix: 3* reasons, 4* psychologist, 5* history, 6* authorization, 7* regression).
INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id, not_converted_reason, next_follow_up_at) VALUES
  ('00000000-0000-4000-c100-000000000031', 'D21 r1', '+910000003001', 'Interested',            NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000032', 'D21 r2', '+910000003002', 'Awaiting Confirmation', NULL, NULL, now() + interval '2 days'),
  ('00000000-0000-4000-c100-000000000033', 'D21 r3', '+910000003003', 'Contacted',             NULL, NULL, now() + interval '2 days'),
  ('00000000-0000-4000-c100-000000000034', 'D21 r4', '+910000003004', 'Contacted',             NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000035', 'D21 r5', '+910000003005', 'Not Interested',        NULL, 'Not interested', NULL),
  ('00000000-0000-4000-c100-000000000041', 'D21 p1', '+910000004001', 'Interested',            NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000042', 'D21 p2', '+910000004002', 'Awaiting Confirmation', NULL, 'old note', now() + interval '3 days'),
  ('00000000-0000-4000-c100-000000000051', 'D21 h1', '+910000005001', 'Contacted',             NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000061', 'D21 x1', '+910000006001', 'New Lead',              NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000071', 'D21 g1', '+910000007001', 'Follow-up Required',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-000000000081', 'D21 c1', '+910000008001', 'Interested',            NULL, NULL, now() + interval '4 days'),
  ('00000000-0000-4000-c100-000000000082', 'D21 c2', '+910000008002', 'Awaiting Confirmation', NULL, NULL, now() + interval '4 days'),
  ('00000000-0000-4000-c100-000000000083', 'D21 c3', '+910000008003', 'Not Interested',        NULL, 'Budget constraints', NULL),
  ('00000000-0000-4000-c100-000000000084', 'D21 c4', '+910000008004', 'Lost Lead',             NULL, 'Other: Moved abroad', NULL);

-- Pre-existing history, including labels from the old vocabulary (must stay byte-for-byte unchanged).
INSERT INTO public.lead_activities (lead_id, activity_type, notes, occurred_at) VALUES
  ('00000000-0000-4000-c100-000000000051', 'Status change', 'Status: Enquiry -> Yet to Confirm', now() - interval '20 days'),
  ('00000000-0000-4000-c100-000000000051', 'Follow-up',     'Call back on Monday',               now() - interval '19 days'),
  ('00000000-0000-4000-c100-000000000035', 'Status change', 'Status: Enquiry -> Lost (Not interested)', now() - interval '10 days');

CREATE TEMP TABLE _d21t_history ON COMMIT DROP AS SELECT * FROM public.lead_activities;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T1. Every allowed transition through update_lead_with_history (signed in as active staff)
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  v_id uuid;
  v_changes jsonb;
  v_saved jsonb;
  v_lead record;
  v_n integer;
  v_done integer := 0;
  failures text := '';
BEGIN
  FOR c IN SELECT * FROM _d21t_allowed ORDER BY from_status, to_status LOOP
    v_id := md5('r:' || c.from_status || '>' || c.to_status)::uuid;
    v_changes := jsonb_build_object('status', c.to_status);
    IF c.to_status IN ('Not Interested', 'Lost Lead') THEN
      v_changes := v_changes || '{"not_converted_reason":"D21 reason"}';
    END IF;
    IF c.to_status = 'Confirmed' THEN
      v_changes := v_changes || '{"assigned_psychologist_id":"00000000-0000-4000-b000-000000000001"}';
    END IF;
    BEGIN
      v_saved := public.update_lead_with_history(v_id, c.from_status, v_changes,
        jsonb_build_array(jsonb_build_object('type', 'status', 'text', format('D21 %s -> %s', c.from_status, c.to_status))));
      SELECT status, not_converted_reason, next_follow_up_at INTO v_lead FROM public.leads WHERE id = v_id;
      SELECT count(*) INTO v_n FROM public.lead_activities
      WHERE lead_id = v_id AND activity_type = 'Status change'
        AND notes = format('D21 %s -> %s', c.from_status, c.to_status);
      IF v_lead.status IS DISTINCT FROM c.to_status OR v_n <> 1 OR (v_saved ->> 'ok') IS DISTINCT FROM 'true'
         OR (v_saved -> 'lead' ->> 'status') IS DISTINCT FROM c.to_status THEN
        failures := failures || format(E'\n  %s -> %s: status=%s activities=%s', c.from_status, c.to_status, v_lead.status, v_n);
      END IF;
      IF c.to_status IN ('Not Interested', 'Lost Lead')
         AND v_lead.not_converted_reason IS DISTINCT FROM 'D21 reason' THEN
        failures := failures || format(E'\n  %s -> %s: reason not saved', c.from_status, c.to_status);
      END IF;
      IF c.to_status = 'Confirmed' AND (SELECT count(*) FROM public.clients WHERE lead_id = v_id) <> 1 THEN
        failures := failures || format(E'\n  %s -> Confirmed: expected exactly one client', c.from_status);
      END IF;
      IF c.to_status NOT IN ('Not Interested', 'Lost Lead', 'Confirmed') AND v_lead.not_converted_reason IS NOT NULL THEN
        failures := failures || format(E'\n  %s -> %s: unexpected reason', c.from_status, c.to_status);
      END IF;
      v_done := v_done + 1;
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      failures := failures || format(E'\n  %s -> %s refused: %s', c.from_status, c.to_status, SQLERRM);
    END;
  END LOOP;
  IF failures <> '' OR v_done <> 26 THEN RAISE EXCEPTION 'FAIL T1: allowed transitions (% done)%', v_done, failures; END IF;
  RAISE NOTICE 'PASS T1: all 26 allowed transitions via update_lead_with_history (one status activity each; Confirmed created a client)';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T1b. Every allowed transition as a direct UPDATE (the trigger alone decides)
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  v_id uuid;
  v_status text;
  failures text := '';
BEGIN
  FOR c IN SELECT * FROM _d21t_allowed LOOP
    v_id := md5('d:' || c.from_status || '>' || c.to_status)::uuid;
    BEGIN
      UPDATE public.leads
        SET status = c.to_status,
            not_converted_reason = CASE WHEN c.to_status IN ('Not Interested', 'Lost Lead') THEN 'D21 reason' END,
            assigned_psychologist_id = CASE WHEN c.to_status = 'Confirmed'
                                            THEN '00000000-0000-4000-b000-000000000001'::uuid END
        WHERE id = v_id;
      SELECT status INTO v_status FROM public.leads WHERE id = v_id;
      IF v_status IS DISTINCT FROM c.to_status THEN
        failures := failures || format(E'\n  %s -> %s: status=%s', c.from_status, c.to_status, v_status);
      END IF;
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      failures := failures || format(E'\n  %s -> %s refused: %s', c.from_status, c.to_status, SQLERRM);
    END;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T1b: allowed direct updates%', failures; END IF;
  RAISE NOTICE 'PASS T1b: all 26 allowed transitions as direct UPDATEs';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T2. Every forbidden transition is refused (function AND direct UPDATE); the lead and its history are unchanged
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  v_id uuid;
  v_before jsonb;
  v_after jsonb;
  refused boolean;
  failures text := '';
BEGIN
  FOR c IN SELECT * FROM _d21t_forbidden ORDER BY from_status, to_status LOOP
    v_id := md5('f:' || c.from_status || '>' || c.to_status)::uuid;
    SELECT to_jsonb(l) INTO v_before FROM public.leads AS l WHERE l.id = v_id;

    -- Through the function, with everything else the target would need, so only the transition is wrong.
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history(v_id, c.from_status,
        jsonb_build_object('status', c.to_status, 'not_converted_reason', 'D21 reason',
                           'assigned_psychologist_id', '00000000-0000-4000-b000-000000000001'),
        '[{"type":"status","text":"D21 forbidden"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  function allowed %s -> %s', c.from_status, c.to_status); END IF;

    -- Directly, bypassing the function.
    refused := false;
    BEGIN
      UPDATE public.leads
        SET status = c.to_status, not_converted_reason = 'D21 reason',
            assigned_psychologist_id = '00000000-0000-4000-b000-000000000001'
        WHERE id = v_id;
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  direct UPDATE allowed %s -> %s', c.from_status, c.to_status); END IF;

    SELECT to_jsonb(l) INTO v_after FROM public.leads AS l WHERE l.id = v_id;
    IF v_after IS DISTINCT FROM v_before THEN
      failures := failures || format(E'\n  %s -> %s changed the lead', c.from_status, c.to_status);
    END IF;
    IF EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = v_id) THEN
      failures := failures || format(E'\n  %s -> %s left history behind', c.from_status, c.to_status);
    END IF;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T2: forbidden transitions%', failures; END IF;
  RAISE NOTICE 'PASS T2: all 30 forbidden transitions refused (function and direct UPDATE), incl. New Lead->Confirmed, Confirmed->Contacted, Not Interested->Interested, Lost Lead->New Lead; no change, no history';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T3. Reason rules
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  refused boolean;
  v_before jsonb;
  v_after jsonb;
  v_lead record;
  failures text := '';
BEGIN
  -- 3a. Refused without a (non-blank) reason, through the function.
  FOR c IN
    SELECT * FROM (VALUES
      ('Not Interested, no reason',    '{"status":"Not Interested"}'::jsonb),
      ('Not Interested, blank reason', '{"status":"Not Interested","not_converted_reason":"   "}'),
      ('Not Interested, null reason',  '{"status":"Not Interested","not_converted_reason":null}'),
      ('Lost Lead, no reason',         '{"status":"Lost Lead"}'),
      ('Lost Lead, blank reason',      '{"status":"Lost Lead","not_converted_reason":""}')
    ) AS t(label, changes)
  LOOP
    SELECT to_jsonb(l) INTO v_before FROM public.leads AS l WHERE l.id = '00000000-0000-4000-c100-000000000031';
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000031', 'Interested', c.changes,
                                              '[{"type":"status","text":"D21 r1"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation THEN refused := true;
    END;
    SELECT to_jsonb(l) INTO v_after FROM public.leads AS l WHERE l.id = '00000000-0000-4000-c100-000000000031';
    IF NOT refused OR v_before IS DISTINCT FROM v_after THEN
      failures := failures || format(E'\n  function: %s (refused=%s)', c.label, refused);
    END IF;
  END LOOP;

  -- 3b. Refused without a reason, as a direct UPDATE (the trigger enforces it on every path).
  FOR c IN SELECT * FROM (VALUES ('Not Interested'), ('Lost Lead')) AS t(to_status) LOOP
    refused := false;
    BEGIN
      UPDATE public.leads SET status = c.to_status WHERE id = '00000000-0000-4000-c100-000000000031';
    EXCEPTION WHEN raise_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  direct UPDATE to %s without reason allowed', c.to_status); END IF;
  END LOOP;

  -- 3c. A closed lead cannot be inserted without a reason, and its reason cannot be removed afterwards.
  refused := false;
  BEGIN
    INSERT INTO public.leads (full_name, phone, status) VALUES ('D21 r-insert', '+910000003099', 'Lost Lead');
  EXCEPTION WHEN raise_exception OR check_violation THEN refused := true;
  END;
  IF NOT refused THEN failures := failures || E'\n  INSERT Lost Lead without reason allowed'; END IF;
  refused := false;
  BEGIN
    UPDATE public.leads SET not_converted_reason = NULL WHERE id = '00000000-0000-4000-c100-000000000035';
  EXCEPTION WHEN raise_exception OR check_violation THEN refused := true;
  END;
  IF NOT refused THEN failures := failures || E'\n  removing the reason of a Not Interested lead allowed'; END IF;

  IF EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000031') THEN
    failures := failures || E'\n  a refused reason update left history behind';
  END IF;

  -- 3d. With a valid reason both succeed; the reason is kept and the follow-up date is cleared.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000032', 'Awaiting Confirmation',
    '{"status":"Not Interested","not_converted_reason":"Not interested"}'::jsonb, '[{"type":"status","text":"D21 r2"}]'::jsonb);
  SELECT status, not_converted_reason, next_follow_up_at INTO v_lead FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000032';
  IF v_lead.status <> 'Not Interested' OR v_lead.not_converted_reason <> 'Not interested' OR v_lead.next_follow_up_at IS NOT NULL THEN
    failures := failures || format(E'\n  Not Interested with reason: %s', to_jsonb(v_lead));
  END IF;
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000033', 'Contacted',
    '{"status":"Lost Lead","not_converted_reason":"No response"}'::jsonb, '[{"type":"status","text":"D21 r3"}]'::jsonb);
  SELECT status, not_converted_reason, next_follow_up_at INTO v_lead FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000033';
  IF v_lead.status <> 'Lost Lead' OR v_lead.not_converted_reason <> 'No response' OR v_lead.next_follow_up_at IS NOT NULL THEN
    failures := failures || format(E'\n  Lost Lead with reason: %s', to_jsonb(v_lead));
  END IF;

  -- 3e. Moving to an allowed non-closed status needs no reason.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000034', 'Contacted',
    '{"status":"Follow-up Required"}'::jsonb, '[{"type":"status","text":"D21 r4"}]'::jsonb);
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000034', 'Follow-up Required',
    '{"status":"Interested"}'::jsonb, '[{"type":"status","text":"D21 r4b"}]'::jsonb);
  SELECT status, not_converted_reason INTO v_lead FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000034';
  IF v_lead.status <> 'Interested' OR v_lead.not_converted_reason IS NOT NULL THEN
    failures := failures || format(E'\n  non-closed moves: %s', to_jsonb(v_lead));
  END IF;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T3: reasons%', failures; END IF;
  RAISE NOTICE 'PASS T3: Not Interested / Lost Lead need a reason on every path; both succeed with one; other statuses need none';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T4. Confirmed needs an ACTIVE assigned psychologist; exactly one client
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  refused boolean;
  v_lead record;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('no psychologist',       '{"status":"Confirmed"}'::jsonb),
      ('inactive psychologist', '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b000-000000000004"}')
    ) AS t(label, changes)
  LOOP
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000041', 'Interested', c.changes,
                                              '[{"type":"status","text":"D21 p1"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  function: Confirmed with %s allowed', c.label); END IF;
  END LOOP;

  refused := false;
  BEGIN
    UPDATE public.leads SET status = 'Confirmed', assigned_psychologist_id = '00000000-0000-4000-b000-000000000004'
    WHERE id = '00000000-0000-4000-c100-000000000041';
  EXCEPTION WHEN raise_exception THEN refused := true;
  END;
  IF NOT refused THEN failures := failures || E'\n  direct UPDATE: Confirmed with inactive psychologist allowed'; END IF;
  refused := false;
  BEGIN
    UPDATE public.leads SET status = 'Confirmed' WHERE id = '00000000-0000-4000-c100-000000000041';
  EXCEPTION WHEN raise_exception THEN refused := true;
  END;
  IF NOT refused THEN failures := failures || E'\n  direct UPDATE: Confirmed without psychologist allowed'; END IF;

  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000041') <> 'Interested'
     OR EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c100-000000000041')
     OR EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000041') THEN
    failures := failures || E'\n  a refused confirmation changed the lead, created a client or left history';
  END IF;

  -- Active psychologist: succeeds, one client; Confirmed keeps the follow-up date and the existing note (as before).
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000042', 'Awaiting Confirmation',
    '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b000-000000000001"}'::jsonb,
    '[{"type":"status","text":"D21 p2"}]'::jsonb);
  SELECT status, not_converted_reason, next_follow_up_at INTO v_lead FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000042';
  IF v_lead.status <> 'Confirmed' OR v_lead.not_converted_reason IS DISTINCT FROM 'old note' OR v_lead.next_follow_up_at IS NULL THEN
    failures := failures || format(E'\n  Confirmed with active psychologist: %s', to_jsonb(v_lead));
  END IF;
  IF (SELECT count(*) FROM public.clients
      WHERE lead_id = '00000000-0000-4000-c100-000000000042'
        AND primary_psychologist_id = '00000000-0000-4000-b000-000000000001') <> 1 THEN
    failures := failures || E'\n  Confirmed lead p2 does not have exactly one client';
  END IF;

  -- A confirmed lead cannot be moved to an inactive psychologist.
  refused := false;
  BEGIN
    PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000042', 'Confirmed',
      '{"assigned_psychologist_id":"00000000-0000-4000-b000-000000000004"}'::jsonb, '[{"type":"update","text":"x"}]'::jsonb);
  EXCEPTION WHEN raise_exception THEN refused := true;
  END;
  IF NOT refused THEN failures := failures || E'\n  reassigning a Confirmed lead to an inactive psychologist allowed'; END IF;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T4: psychologist%', failures; END IF;
  RAISE NOTICE 'PASS T4: Confirmed refused without / with an inactive psychologist; active psychologist succeeds with exactly one client';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T5. History
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  v_before integer;
  v_after integer;
  refused boolean;
  failures text := '';
BEGIN
  SELECT count(*) INTO v_before FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051';

  -- Success: one row per event, with the right types and texts.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000051', 'Contacted',
    '{"status":"Interested","next_follow_up_at":"2030-02-01T10:00:00+05:30","notes":"D21 notes"}'::jsonb,
    '[{"type":"status","text":"Status: Contacted -> Interested"},{"type":"followup","text":"Follow-up set"},{"type":"update","text":"Notes edited"}]'::jsonb);
  SELECT count(*) INTO v_after FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051';
  IF v_after - v_before <> 3
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051'
                    AND activity_type = 'Status change' AND notes = 'Status: Contacted -> Interested')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051'
                    AND activity_type = 'Follow-up' AND notes = 'Follow-up set')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051'
                    AND activity_type = 'Lead update' AND notes = 'Notes edited') THEN
    failures := failures || format(E'\n  success wrote % rows instead of the 3 expected', v_after - v_before);
  END IF;

  -- Failures (invalid transition; status change without a status event): no new rows.
  v_before := v_after;
  BEGIN
    PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000051', 'Interested',
      '{"status":"New Lead"}'::jsonb, '[{"type":"status","text":"misleading"},{"type":"update","text":"misleading"}]'::jsonb);
  EXCEPTION WHEN raise_exception OR data_exception OR check_violation THEN NULL;
  END;
  BEGIN
    PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000051', 'Interested',
      '{"status":"Follow-up Required"}'::jsonb, '[{"type":"update","text":"misleading"}]'::jsonb);
  EXCEPTION WHEN raise_exception OR data_exception OR check_violation THEN NULL;
  END;
  SELECT count(*) INTO v_after FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000051';
  IF v_after <> v_before OR EXISTS (SELECT 1 FROM public.lead_activities WHERE notes = 'misleading') THEN
    failures := failures || E'\n  a refused update wrote history';
  END IF;
  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000051') <> 'Interested' THEN
    failures := failures || E'\n  a refused update changed the status';
  END IF;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T5: history%', failures; END IF;
  RAISE NOTICE 'PASS T5a: success writes one row per event with the right type; refused updates write none';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T6. Authorization
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);
SET LOCAL ROLE anon;
DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000061', 'New Lead',
      '{"status":"Contacted"}'::jsonb, '[{"type":"status","text":"anon"}]'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL T6: anon executed update_lead_with_history'; END IF;
  BEGIN
    UPDATE public.leads SET status = 'Contacted' WHERE id = '00000000-0000-4000-c100-000000000061';
  EXCEPTION WHEN insufficient_privilege THEN NULL; -- no privilege at all is also a refusal
  END;
END
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  refused boolean;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('non-member',       '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}'),
      ('inactive staff',   '{"sub":"00000000-0000-4000-a000-000000000005","role":"authenticated"}'),
      ('psychologist',     '{"sub":"00000000-0000-4000-a000-000000000008","role":"authenticated"}'),
      ('spoofed JWT admin','{"sub":"00000000-0000-4000-a000-00000000000c","role":"authenticated","app_metadata":{"role":"admin"}}')
    ) AS t(label, claims)
  LOOP
    PERFORM set_config('request.jwt.claims', c.claims, true);
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000061', 'New Lead',
        '{"status":"Contacted"}'::jsonb, '[{"type":"status","text":"unauthorized"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR insufficient_privilege THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  %s: function succeeded', c.label); END IF;
    BEGIN
      UPDATE public.leads SET status = 'Contacted' WHERE id = '00000000-0000-4000-c100-000000000061';
    EXCEPTION WHEN raise_exception OR insufficient_privilege THEN NULL;
    END;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T6: unauthorized callers%', failures; END IF;
END
$$;
RESET ROLE;

-- Defence in depth: even with RLS bypassed (table owner), a signed-in non-member cannot change a status.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  refused boolean := false;
BEGIN
  BEGIN
    UPDATE public.leads SET status = 'Contacted' WHERE id = '00000000-0000-4000-c100-000000000061';
  EXCEPTION WHEN insufficient_privilege THEN refused := true;
  END;
  IF NOT refused THEN RAISE EXCEPTION 'FAIL T6: the trigger staff check did not fire for a signed-in non-member'; END IF;
END
$$;
SELECT set_config('request.jwt.claims', '', true);

DO $$
BEGIN
  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000061') <> 'New Lead'
     OR EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000061') THEN
    RAISE EXCEPTION 'FAIL T6: an unauthorized caller changed the lead or wrote history';
  END IF;
  RAISE NOTICE 'PASS T6: anon, non-member, inactive staff, psychologist and spoofed JWT admin cannot change statuses; trigger check holds without RLS';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T7. Regression: lead codes, default status, old statuses refused, existing update behaviour
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);
DO $$
DECLARE
  v_code text;
  v_status text;
  v_before jsonb;
  v_n integer;
  refused boolean;
  c record;
  failures text := '';
BEGIN
  -- Lead code generation and the new default (the app's insert path, as staff under RLS).
  INSERT INTO public.leads (full_name, phone) VALUES ('D21 new', '+910000007099') RETURNING lead_code, status INTO v_code, v_status;
  IF v_code IS NULL OR v_code NOT LIKE 'KAP-%' OR v_status <> 'New Lead' THEN
    failures := failures || format(E'\n  insert: lead_code=%s status=%s', v_code, v_status);
  END IF;

  -- Old statuses are gone on every path.
  FOR c IN SELECT * FROM (VALUES ('Enquiry'), ('Yet to Confirm'), ('Will Inform'), ('Lost'), ('New')) AS t(s) LOOP
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000071', 'Follow-up Required',
        jsonb_build_object('status', c.s, 'not_converted_reason', 'x'), '[{"type":"status","text":"old"}]'::jsonb);
    EXCEPTION WHEN data_exception OR raise_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  function accepted old status %s', c.s); END IF;
    refused := false;
    BEGIN
      INSERT INTO public.leads (full_name, phone, status, not_converted_reason) VALUES ('D21 old', '+910000007098', c.s, 'x');
    EXCEPTION WHEN check_violation OR raise_exception THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  INSERT accepted old status %s', c.s); END IF;
  END LOOP;

  -- Existing behaviour kept (incl. the non-status checks carried over from the retired lead_workflow_test.sql T3):
  -- each request is refused AND leaves the lead and its history unchanged.
  FOR c IN
    SELECT * FROM (VALUES
      ('stale expected status', 'New Lead', '{"status":"Contacted"}'::jsonb, '[{"type":"status","text":"x"}]'::jsonb),
      ('unsupported field', 'Follow-up Required', '{"phone":"+910000009999"}', '[{"type":"update","text":"x"}]'),
      ('six events', 'Follow-up Required', '{"notes":"x"}',
         '[{"type":"update","text":"1"},{"type":"update","text":"2"},{"type":"update","text":"3"},{"type":"update","text":"4"},{"type":"update","text":"5"},{"type":"update","text":"6"}]'),
      ('status event without change', 'Follow-up Required', '{"notes":"x"}', '[{"type":"status","text":"x"}]'),
      ('unsupported event', 'Follow-up Required', '{"notes":"x"}', '[{"type":"hack","text":"x"}]'),
      ('status change without status event', 'Follow-up Required', '{"status":"Interested"}', '[{"type":"update","text":"x"}]'),
      ('two status events', 'Follow-up Required', '{"status":"Interested"}',
         '[{"type":"status","text":"x"},{"type":"status","text":"y"}]'),
      ('events not an array', 'Follow-up Required', '{"notes":"x"}', '{"type":"update"}'),
      ('changes not an object', 'Follow-up Required', '["status"]', '[]'),
      ('invalid follow-up date', 'Follow-up Required', '{"next_follow_up_at":"not a date"}', '[]'),
      ('blank follow-up date (the app sends null instead)', 'Follow-up Required', '{"next_follow_up_at":"  "}', '[]')
    ) AS t(label, expected, changes, events)
  LOOP
    SELECT to_jsonb(l) INTO v_before FROM public.leads AS l WHERE l.id = '00000000-0000-4000-c100-000000000071';
    SELECT count(*) INTO v_n FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000071';
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000071', c.expected, c.changes, c.events);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused THEN failures := failures || format(E'\n  %s accepted', c.label); END IF;
    IF (SELECT to_jsonb(l) FROM public.leads AS l WHERE l.id = '00000000-0000-4000-c100-000000000071') IS DISTINCT FROM v_before
       OR (SELECT count(*) FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000071') <> v_n THEN
      failures := failures || format(E'\n  %s left a partial write', c.label);
    END IF;
  END LOOP;

  -- Five events accepted; a follow-up date is saved and JSON null clears it.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000071', 'Follow-up Required',
    '{"next_follow_up_at":"2030-01-15T10:30:00+05:30"}'::jsonb,
    '[{"type":"update","text":"1"},{"type":"followup","text":"2"},{"type":"update","text":"3"},{"type":"update","text":"4"},{"type":"update","text":"5"}]'::jsonb);
  IF (SELECT next_follow_up_at FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000071')
     IS DISTINCT FROM '2030-01-15T10:30:00+05:30'::timestamptz
     OR (SELECT count(*) FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-000000000071') <> 5 THEN
    failures := failures || E'\n  five-event update with follow-up date not saved';
  END IF;
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-000000000071', 'Follow-up Required',
    '{"next_follow_up_at":null}'::jsonb, '[{"type":"followup","text":"cleared"}]'::jsonb);
  IF (SELECT next_follow_up_at FROM public.leads WHERE id = '00000000-0000-4000-c100-000000000071') IS NOT NULL THEN
    failures := failures || E'\n  JSON null did not clear the follow-up date';
  END IF;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T7: regression%', failures; END IF;
  RAISE NOTICE 'PASS T7: lead code + New Lead default on insert; old statuses refused; existing update rules unchanged';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T8. Both closed statuses through the payloads the lead drawer sends (app/lib/leads.js helpers):
       select without / with a reason, the status history names the actual status, the reason can be edited
       (one "Lead update" row), an edit to a blank reason is refused, and history rows keep staff_member = NULL
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  refused boolean;
  v_lead record;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('00000000-0000-4000-c100-000000000081'::uuid, 'Interested',            'Not Interested', 'Not interested'),
      ('00000000-0000-4000-c100-000000000082'::uuid, 'Awaiting Confirmation', 'Lost Lead',      'Other: Chose a clinic nearer home')
    ) AS t(lead_id, from_status, to_status, reason)
  LOOP
    -- Selected without a reason (what the page check also blocks): refused, nothing written.
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history(c.lead_id, c.from_status,
        jsonb_build_object('status', c.to_status, 'not_converted_reason', ''),
        jsonb_build_array(jsonb_build_object('type', 'status',
          'text', format('Status changed from %s to %s. Reason: ', c.from_status, c.to_status))));
    EXCEPTION WHEN raise_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused OR EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = c.lead_id) THEN
      failures := failures || format(E'\n  %s without a reason: refused=%s', c.to_status, refused);
    END IF;

    -- Selected with a valid reason: saved, follow-up cleared, one status row naming the actual status.
    PERFORM public.update_lead_with_history(c.lead_id, c.from_status,
      jsonb_build_object('status', c.to_status, 'not_converted_reason', c.reason),
      jsonb_build_array(jsonb_build_object('type', 'status',
        'text', format('Status changed from %s to %s. Reason: %s', c.from_status, c.to_status, c.reason))));
    SELECT status, not_converted_reason, next_follow_up_at INTO v_lead FROM public.leads WHERE id = c.lead_id;
    IF v_lead.status <> c.to_status OR v_lead.not_converted_reason <> c.reason OR v_lead.next_follow_up_at IS NOT NULL THEN
      failures := failures || format(E'\n  %s with a reason: %s', c.to_status, to_jsonb(v_lead));
    END IF;
    IF (SELECT count(*) FROM public.lead_activities
        WHERE lead_id = c.lead_id AND activity_type = 'Status change' AND staff_member IS NULL
          AND notes = format('Status changed from %s to %s. Reason: %s', c.from_status, c.to_status, c.reason)) <> 1 THEN
      failures := failures || format(E'\n  %s: expected one status row naming the status', c.to_status);
    END IF;
  END LOOP;

  -- Editing the reason of a lead that stays in its closed status.
  FOR c IN
    SELECT * FROM (VALUES
      ('00000000-0000-4000-c100-000000000083'::uuid, 'Not Interested', 'No response', 'Not Interested reason updated: No response'),
      ('00000000-0000-4000-c100-000000000084'::uuid, 'Lost Lead', 'Other: Moved to Dubai', 'Lost reason updated: Other: Moved to Dubai')
    ) AS t(lead_id, status, reason, history)
  LOOP
    PERFORM public.update_lead_with_history(c.lead_id, c.status,
      jsonb_build_object('status', c.status, 'not_converted_reason', c.reason),
      jsonb_build_array(jsonb_build_object('type', 'update', 'text', c.history)));
    IF (SELECT not_converted_reason FROM public.leads WHERE id = c.lead_id) IS DISTINCT FROM c.reason
       OR (SELECT count(*) FROM public.lead_activities
           WHERE lead_id = c.lead_id AND activity_type = 'Lead update' AND notes = c.history) <> 1 THEN
      failures := failures || format(E'\n  %s: reason edit not saved with one update row', c.status);
    END IF;

    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history(c.lead_id, c.status,
        jsonb_build_object('not_converted_reason', '  '), '[{"type":"update","text":"blank"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR check_violation THEN refused := true;
    END;
    IF NOT refused OR (SELECT not_converted_reason FROM public.leads WHERE id = c.lead_id) IS DISTINCT FROM c.reason THEN
      failures := failures || format(E'\n  %s: blank reason edit was not refused', c.status);
    END IF;
  END LOOP;

  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T8: closed-status reasons%', failures; END IF;
  RAISE NOTICE 'PASS T8: Not Interested and Lost Lead: refused without a reason, saved with one, history names the status (staff_member NULL as before), reason editable, blank edit refused';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T5b. Existing history is byte-for-byte unchanged
   --------------------------------------------------------------------------------------------- */
DO $$
BEGIN
  IF EXISTS (SELECT * FROM _d21t_history EXCEPT SELECT * FROM public.lead_activities) THEN
    RAISE EXCEPTION 'FAIL T5b: a pre-existing lead_activities row was changed or removed';
  END IF;
  RAISE NOTICE 'PASS T5b: all pre-existing lead_activities rows unchanged (including old-vocabulary labels)';
END
$$;

ROLLBACK;
