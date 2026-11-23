-- Kappiness CRM: lead workflow regression tests for the PRODUCTION lead functions:
-- update_lead_with_history from 202611030002 (md5 2dc29d7e…, confirmed on production 13 Nov 2026) +
-- enforce_lead_workflow / sync_client_from_lead from 202611040001 (enforce_lead_workflow md5 a1a07bca…).
-- Rewritten 13 Nov 2026: the previous version pinned the 202611040004 body, which was never applied and must never
-- be applied (supabase/migrations_superseded/README.md).
-- Owner: Aswathy (backend / security).
--
-- RUN ONLY ON A DISPOSABLE DATABASE (fresh local stack or Supabase branch). NEVER ON THE LIVE PROJECT.
-- Refuses to start unless  SET kappiness.test_env = 'disposable';  was run AND crm_staff_members is empty.
--
--   psql "<disposable database connection string>" -v ON_ERROR_STOP=1 \
--        -c "SET kappiness.test_env = 'disposable'" -f supabase/tests/lead_workflow_test.sql
--
-- One transaction, ending in ROLLBACK. Any failed assertion raises an exception.
--
-- PRECONDITIONS
--   The production-like schema: test bootstrap + 202611030002 + 202611040001 (+ 202611130001/202611130002), as in
--   supabase/test-bootstrap/README.md.
--
-- WHAT IS PINNED (production behaviour, 13 Nov 2026)
--   * expected-status check; Confirmed and Lost are final; the approved transition matrix (enforced by the
--     enforce_lead_workflow trigger, for the function AND for direct UPDATEs)
--       Enquiry        -> Yet to Confirm, Lost
--       Yet to Confirm -> Enquiry, Will Inform, Lost
--       Will Inform    -> Yet to Confirm, Confirmed, Lost
--   * Lost needs a reason; Confirmed needs an ACTIVE assigned psychologist and creates one client
--   * Lost clears next_follow_up_at and preserves the Lost reason (T5)
--   * Confirmed preserves the existing next_follow_up_at and the existing not_converted_reason (the 202611030002
--     function does not clear them; the app hides follow-ups of closed leads). Pinned as current behaviour so any
--     change is noticed, not as a requirement (T5)
--   * history events per update: FIVE are accepted (T4; the lead drawer can send five), SIX are rejected (T3);
--     exactly one status event per status change; unsupported fields and event types refused; one lead_activities
--     row per event
--   * next_follow_up_at: JSON null clears it (T4; what app/page.js sends for an empty field); a blank or malformed
--     string is rejected with SQLSTATE 22007 (T3)
--   * non-members and psychologists cannot change leads
-- Rejections are asserted by SQLSTATE class and by the unchanged row, not by message text, so the tests do
-- not depend on the exact wording of the functions.

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
   T0. The functions are the production ones, with production settings
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  def record;
BEGIN
  SELECT p.prosecdef, p.proconfig, p.prosrc INTO def
  FROM pg_proc AS p WHERE p.oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)');
  IF def IS NULL THEN RAISE EXCEPTION 'FAIL T0: update_lead_with_history is missing'; END IF;
  IF md5(replace(def.prosrc, E'\r', '')) IS DISTINCT FROM '2dc29d7ea4dade1797b141a2b86c408c' THEN
    RAISE EXCEPTION 'FAIL T0: update_lead_with_history is not the production (202611030002) body';
  END IF;
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.enforce_lead_workflow()')), E'\r', ''))
       IS DISTINCT FROM 'a1a07bca19718034c78c824014060747' THEN
    RAISE EXCEPTION 'FAIL T0: enforce_lead_workflow is not the production (202611040001) body';
  END IF;
  IF def.prosecdef OR coalesce(def.proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'FAIL T0: function must be SECURITY INVOKER with search_path=public';
  END IF;
  IF has_function_privilege('anon', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL T0: anon can execute update_lead_with_history';
  END IF;
  RAISE NOTICE 'PASS T0: production function bodies and settings';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a000-000000000001', 'lw-nonmember@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'lw-staff@test.invalid',     'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000008', 'lw-psych-a@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-00000000000b', 'lw-psych-off@test.invalid', 'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a000-000000000004', 'staff', true);

INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b000-000000000001', 'LW Psychologist A', '+910000000001', true,  '00000000-0000-4000-a000-000000000008'),
  ('00000000-0000-4000-b000-000000000004', 'LW Inactive',       '+910000000004', false, '00000000-0000-4000-a000-00000000000b');

-- id suffix: a* allowed transitions, f* forbidden-from, d* validation, e* field handling on Confirmed / Lost (T5).
-- e1 starts with a follow-up date AND a reason, so T5 can show that Confirmed preserves both.
INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id, not_converted_reason, next_follow_up_at) VALUES
  ('00000000-0000-4000-c100-0000000000a1', 'LW a1', '+910000001001', 'Enquiry',        NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a2', 'LW a2', '+910000001002', 'Enquiry',        NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a3', 'LW a3', '+910000001003', 'Yet to Confirm', NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a4', 'LW a4', '+910000001004', 'Yet to Confirm', NULL, NULL, now() + interval '2 days'),
  ('00000000-0000-4000-c100-0000000000a5', 'LW a5', '+910000001005', 'Yet to Confirm', NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a6', 'LW a6', '+910000001006', 'Will Inform',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a7', 'LW a7', '+910000001007', 'Will Inform',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000a8', 'LW a8', '+910000001008', 'Will Inform',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000f1', 'LW f1', '+910000001011', 'Enquiry',        NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000f2', 'LW f2', '+910000001012', 'Yet to Confirm', NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000f3', 'LW f3', '+910000001013', 'Will Inform',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000f4', 'LW f4', '+910000001014', 'Confirmed', '00000000-0000-4000-b000-000000000001', NULL, NULL),
  ('00000000-0000-4000-c100-0000000000f5', 'LW f5', '+910000001015', 'Lost',           NULL, 'No response', NULL),
  ('00000000-0000-4000-c100-0000000000d1', 'LW d1', '+910000001021', 'Will Inform',    NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000d2', 'LW d2', '+910000001022', 'Enquiry',        NULL, NULL, NULL),
  ('00000000-0000-4000-c100-0000000000e1', 'LW e1', '+910000001031', 'Will Inform',    NULL, 'existing reason', now() + interval '3 days'),
  ('00000000-0000-4000-c100-0000000000e2', 'LW e2', '+910000001032', 'Yet to Confirm', NULL, NULL, now() + interval '3 days');

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a000-000000000004","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T1. Every allowed transition succeeds through the function and records one status activity
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  saved jsonb;
  now_status text;
  activity_count integer;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('00000000-0000-4000-c100-0000000000a1'::uuid, 'Enquiry',        '{"status":"Yet to Confirm"}'::jsonb),
      ('00000000-0000-4000-c100-0000000000a2'::uuid, 'Enquiry',        '{"status":"Lost","not_converted_reason":"Not interested"}'),
      ('00000000-0000-4000-c100-0000000000a3'::uuid, 'Yet to Confirm', '{"status":"Enquiry"}'),
      ('00000000-0000-4000-c100-0000000000a4'::uuid, 'Yet to Confirm', '{"status":"Will Inform"}'),
      ('00000000-0000-4000-c100-0000000000a5'::uuid, 'Yet to Confirm', '{"status":"Lost","not_converted_reason":"Budget constraints"}'),
      ('00000000-0000-4000-c100-0000000000a6'::uuid, 'Will Inform',    '{"status":"Yet to Confirm"}'),
      ('00000000-0000-4000-c100-0000000000a7'::uuid, 'Will Inform',    '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b000-000000000001"}'),
      ('00000000-0000-4000-c100-0000000000a8'::uuid, 'Will Inform',    '{"status":"Lost","not_converted_reason":"No response"}')
    ) AS t(lead_id, from_status, changes)
  LOOP
    BEGIN
      saved := public.update_lead_with_history(c.lead_id, c.from_status, c.changes,
                                               '[{"type":"status","text":"LW transition"}]'::jsonb);
      SELECT status INTO now_status FROM public.leads WHERE id = c.lead_id;
      SELECT count(*) INTO activity_count FROM public.lead_activities
      WHERE lead_id = c.lead_id AND activity_type = 'Status change';
      IF now_status IS DISTINCT FROM c.changes ->> 'status' OR activity_count <> 1
         OR (saved ->> 'ok') IS DISTINCT FROM 'true' THEN
        failures := failures || format(E'\n  %s -> %s: status=%s activities=%s',
          c.from_status, c.changes ->> 'status', now_status, activity_count);
      END IF;
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      failures := failures || format(E'\n  %s -> %s refused: %s', c.from_status, c.changes ->> 'status', SQLERRM);
    END;
  END LOOP;

  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c100-0000000000a7') THEN
    failures := failures || E'\n  Confirmed lead a7 has no client';
  END IF;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T1: allowed transitions%', failures; END IF;
  RAISE NOTICE 'PASS T1: all 8 allowed transitions';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T2. Every forbidden transition is refused (function AND direct UPDATE) and leaves the lead unchanged
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  refused boolean;
  now_status text;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('00000000-0000-4000-c100-0000000000f1'::uuid, 'Enquiry',        'Will Inform'),
      ('00000000-0000-4000-c100-0000000000f1'::uuid, 'Enquiry',        'Confirmed'),
      ('00000000-0000-4000-c100-0000000000f2'::uuid, 'Yet to Confirm', 'Confirmed'),
      ('00000000-0000-4000-c100-0000000000f3'::uuid, 'Will Inform',    'Enquiry'),
      ('00000000-0000-4000-c100-0000000000f4'::uuid, 'Confirmed',      'Enquiry'),
      ('00000000-0000-4000-c100-0000000000f4'::uuid, 'Confirmed',      'Yet to Confirm'),
      ('00000000-0000-4000-c100-0000000000f4'::uuid, 'Confirmed',      'Will Inform'),
      ('00000000-0000-4000-c100-0000000000f4'::uuid, 'Confirmed',      'Lost'),
      ('00000000-0000-4000-c100-0000000000f5'::uuid, 'Lost',           'Enquiry'),
      ('00000000-0000-4000-c100-0000000000f5'::uuid, 'Lost',           'Yet to Confirm'),
      ('00000000-0000-4000-c100-0000000000f5'::uuid, 'Lost',           'Will Inform'),
      ('00000000-0000-4000-c100-0000000000f5'::uuid, 'Lost',           'Confirmed')
    ) AS t(lead_id, from_status, to_status)
  LOOP
    -- Through the function (with everything else the target would need, so only the transition is wrong).
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history(c.lead_id, c.from_status,
        jsonb_build_object('status', c.to_status,
                           'not_converted_reason', 'LW reason',
                           'assigned_psychologist_id', '00000000-0000-4000-b000-000000000001'),
        '[{"type":"status","text":"LW forbidden"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    IF NOT refused THEN
      failures := failures || format(E'\n  function allowed %s -> %s', c.from_status, c.to_status);
    END IF;

    -- Directly, bypassing the function (the trigger must still refuse).
    refused := false;
    BEGIN
      UPDATE public.leads
        SET status = c.to_status,
            not_converted_reason = 'LW reason',
            assigned_psychologist_id = '00000000-0000-4000-b000-000000000001'
        WHERE id = c.lead_id;
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    IF NOT refused THEN
      failures := failures || format(E'\n  direct UPDATE allowed %s -> %s', c.from_status, c.to_status);
    END IF;

    SELECT status INTO now_status FROM public.leads WHERE id = c.lead_id;
    IF now_status IS DISTINCT FROM c.from_status THEN
      failures := failures || format(E'\n  %s changed to %s', c.from_status, now_status);
    END IF;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T2: forbidden transitions%', failures; END IF;
  RAISE NOTICE 'PASS T2: all 12 forbidden transitions refused (function and direct UPDATE)';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T3. Validation: each request below must be refused and leave the lead unchanged
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  c record;
  refused boolean;
  before_row jsonb;
  after_row jsonb;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('stale expected status',             '00000000-0000-4000-c100-0000000000d1'::uuid, 'Enquiry',
         '{"status":"Lost","not_converted_reason":"x"}'::jsonb, '[{"type":"status","text":"x"}]'::jsonb),
      ('Lost without reason',               '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Lost"}', '[{"type":"status","text":"x"}]'),
      ('Lost with blank reason',            '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Lost","not_converted_reason":"   "}', '[{"type":"status","text":"x"}]'),
      ('Confirmed without psychologist',    '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Confirmed"}', '[{"type":"status","text":"x"}]'),
      ('Confirmed with inactive psychologist', '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b000-000000000004"}',
         '[{"type":"status","text":"x"}]'),
      ('status change without status event', '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Yet to Confirm"}', '[{"type":"update","text":"x"}]'),
      ('two status events',                 '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"Yet to Confirm"}', '[{"type":"status","text":"x"},{"type":"status","text":"y"}]'),
      ('status event without status change', '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"notes":"x"}', '[{"type":"status","text":"x"}]'),
      ('unsupported field',                 '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"phone":"+910000009999"}', '[{"type":"update","text":"x"}]'),
      ('unsupported event type',            '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"notes":"x"}', '[{"type":"hack","text":"x"}]'),
      ('six history events',                '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"notes":"x"}',
         '[{"type":"update","text":"1"},{"type":"update","text":"2"},{"type":"update","text":"3"},{"type":"update","text":"4"},{"type":"update","text":"5"},{"type":"update","text":"6"}]'),
      ('events not an array',               '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"notes":"x"}', '{"type":"update"}'),
      ('invalid status value',              '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"status":"New"}', '[{"type":"status","text":"x"}]'),
      ('invalid follow-up date',            '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"next_follow_up_at":"not a date"}', '[]'),
      ('blank follow-up date (the app sends null instead)', '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '{"next_follow_up_at":"  "}', '[]'),
      ('changes not an object',             '00000000-0000-4000-c100-0000000000d1'::uuid, 'Will Inform',
         '["status"]', '[]')
    ) AS t(label, lead_id, expected, changes, events)
  LOOP
    SELECT to_jsonb(l) INTO before_row FROM public.leads AS l WHERE l.id = c.lead_id;
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history(c.lead_id, c.expected, c.changes, c.events);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    SELECT to_jsonb(l) INTO after_row FROM public.leads AS l WHERE l.id = c.lead_id;
    IF NOT refused OR before_row IS DISTINCT FROM after_row THEN
      failures := failures || format(E'\n  %s: refused=%s, row unchanged=%s', c.label, refused, before_row = after_row);
    END IF;
  END LOOP;

  IF EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-0000000000d1') THEN
    failures := failures || E'\n  a refused update left lead_activities rows behind';
  END IF;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T3: validation%', failures; END IF;
  RAISE NOTICE 'PASS T3: 16 invalid requests refused with no partial writes';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T4. Five history events are accepted (the lead drawer can send five; six are rejected in T3);
       assigned_psychologist_id is an allowed field; a follow-up date is saved and JSON null clears it
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  n integer;
BEGIN
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000d2', 'Enquiry',
    '{"notes":"LW five events"}'::jsonb,
    '[{"type":"update","text":"1"},{"type":"followup","text":"2"},{"type":"update","text":"3"},{"type":"update","text":"4"},{"type":"update","text":"5"}]'::jsonb);
  SELECT count(*) INTO n FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c100-0000000000d2';
  IF n <> 5 THEN RAISE EXCEPTION 'FAIL T4: expected 5 activity rows, got %', n; END IF;

  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000d2', 'Enquiry',
    '{"assigned_psychologist_id":"00000000-0000-4000-b000-000000000001"}'::jsonb,
    '[{"type":"update","text":"assigned"}]'::jsonb);
  IF (SELECT assigned_psychologist_id FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000d2')
     IS DISTINCT FROM '00000000-0000-4000-b000-000000000001'::uuid THEN
    RAISE EXCEPTION 'FAIL T4: assigned_psychologist_id was not saved';
  END IF;

  -- Follow-up date: a valid value is saved; JSON null (what app/page.js toDbValue sends for an empty field) clears it.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000d2', 'Enquiry',
    '{"next_follow_up_at":"2030-01-15T10:30:00+05:30"}'::jsonb, '[{"type":"followup","text":"set"}]'::jsonb);
  IF (SELECT next_follow_up_at FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000d2')
     IS DISTINCT FROM '2030-01-15T10:30:00+05:30'::timestamptz THEN
    RAISE EXCEPTION 'FAIL T4: valid follow-up date was not saved';
  END IF;
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000d2', 'Enquiry',
    '{"next_follow_up_at":null}'::jsonb, '[{"type":"followup","text":"cleared"}]'::jsonb);
  IF (SELECT next_follow_up_at FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000d2') IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T4: null follow-up date did not clear the value';
  END IF;
  RAISE NOTICE 'PASS T4: five-event limit (inclusive), psychologist assignment, follow-up date set/clear';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T5. Field handling on Confirmed and Lost (production 202611030002 behaviour):
       Confirmed preserves the follow-up date and the existing reason; Lost clears the follow-up date and
       preserves the Lost reason
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  r record;
  before_follow_up timestamptz;
BEGIN
  SELECT next_follow_up_at INTO before_follow_up FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000e1';
  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000e1', 'Will Inform',
    '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b000-000000000001"}'::jsonb,
    '[{"type":"status","text":"LW confirm"}]'::jsonb);
  SELECT status, next_follow_up_at, not_converted_reason INTO r
  FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000e1';
  IF r.status <> 'Confirmed' THEN RAISE EXCEPTION 'FAIL T5: e1 not Confirmed'; END IF;
  -- Production does not clear these on Confirmed (pinned so that any change in behaviour is noticed).
  IF r.next_follow_up_at IS DISTINCT FROM before_follow_up THEN
    RAISE EXCEPTION 'FAIL T5: next_follow_up_at changed on Confirmed (production keeps it)';
  END IF;
  IF r.not_converted_reason IS DISTINCT FROM 'existing reason' THEN
    RAISE EXCEPTION 'FAIL T5: not_converted_reason changed on Confirmed (production keeps it)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c100-0000000000e1') THEN
    RAISE EXCEPTION 'FAIL T5: Confirmed lead e1 has no client';
  END IF;

  PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000e2', 'Yet to Confirm',
    '{"status":"Lost","not_converted_reason":"Chose another service provider"}'::jsonb,
    '[{"type":"status","text":"LW lost"}]'::jsonb);
  SELECT status, next_follow_up_at, not_converted_reason INTO r
  FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000e2';
  IF r.status <> 'Lost' THEN RAISE EXCEPTION 'FAIL T5: e2 not Lost'; END IF;
  IF r.next_follow_up_at IS NOT NULL THEN RAISE EXCEPTION 'FAIL T5: next_follow_up_at not cleared on Lost'; END IF;
  IF r.not_converted_reason IS DISTINCT FROM 'Chose another service provider' THEN
    RAISE EXCEPTION 'FAIL T5: Lost reason not kept';
  END IF;
  RAISE NOTICE 'PASS T5: Confirmed preserves follow-up and reason, creates the client; Lost clears follow-up and preserves the reason';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T6. Non-members and psychologists cannot change leads (RLS + trigger staff check)
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  refused boolean;
  n integer;
  failures text := '';
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('non-member',     '00000000-0000-4000-a000-000000000001'::uuid),
      ('psychologist A', '00000000-0000-4000-a000-000000000008'::uuid)
    ) AS t(label, user_id)
  LOOP
    PERFORM set_config('request.jwt.claims',
      jsonb_build_object('sub', c.user_id, 'role', 'authenticated', 'app_metadata', '{"role":"admin"}'::jsonb)::text, true);
    refused := false;
    BEGIN
      PERFORM public.update_lead_with_history('00000000-0000-4000-c100-0000000000f1', 'Enquiry',
        '{"status":"Yet to Confirm"}'::jsonb, '[{"type":"status","text":"x"}]'::jsonb);
    EXCEPTION WHEN raise_exception OR data_exception OR check_violation OR insufficient_privilege THEN
      refused := true;
    END;
    UPDATE public.leads SET status = 'Yet to Confirm' WHERE id = '00000000-0000-4000-c100-0000000000f1';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF NOT refused OR n <> 0 THEN
      failures := failures || format(E'\n  %s: function refused=%s, direct update rows=%s', c.label, refused, n);
    END IF;
  END LOOP;
  IF failures <> '' THEN RAISE EXCEPTION 'FAIL T6: lead access%', failures; END IF;
END
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c100-0000000000f1') <> 'Enquiry' THEN
    RAISE EXCEPTION 'FAIL T6: lead f1 was changed by a non-member or psychologist';
  END IF;
  RAISE NOTICE 'PASS T6: non-members and psychologists cannot change leads';
END
$$;

DO $$ BEGIN RAISE NOTICE 'ALL LEAD WORKFLOW TESTS PASSED (rolling back fixtures)'; END $$;

ROLLBACK;
