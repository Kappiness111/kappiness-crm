-- Kappiness CRM: tests for appointment reminder tracking (202611130002).
-- Owner: Aswathy (backend).
--
-- RUN ONLY ON A DISPOSABLE DATABASE. NEVER ON THE LIVE PROJECT.
-- Refuses to start unless  SET kappiness.test_env = 'disposable';  was run AND crm_staff_members is empty.
--
--   psql "<disposable database connection string>" -v ON_ERROR_STOP=1 \
--        -c "SET kappiness.test_env = 'disposable'" -f supabase/tests/appointment_reminders_test.sql
--
-- One transaction, ending in ROLLBACK: no fixture is kept. Any failed assertion raises an exception.
--
-- PRECONDITIONS
--   202611040001 and 202611130002 applied; normally the production path in supabase/test-bootstrap/README.md.
--   Also passes with only 202611040001 (insecure is_crm_staff()): reminder access does not depend on
--   is_crm_staff()/is_crm_admin().
--
-- IDENTITIES
--   ...01 signed-in non-member          ...02 non-member with JWT app_metadata.role = admin
--   ...03 INACTIVE staff membership     ...04 active staff          ...06 active admin
--   ...08 psychologist A (no membership)
--
-- COVERAGE
--   T0 catalog/privileges  T1 two reminders per follow-up  T2 no duplicates  T3 delivery status
--   T4 client response     T5 due time changes             T6 reschedule (cancel old pending, two new,
--   history kept, recommendation repointed)                 T7 cancellation (pending only) + completion
--   T8 unauthorised users  T9 failed booking/reschedule leaves no orphans  T10 configurable timing

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
   Test helpers (session-temporary; gone after the session)
   --------------------------------------------------------------------------------------------- */
-- Runs p_sql and requires it to fail with SQLSTATE p_state. The statement's effects are rolled back.
CREATE FUNCTION pg_temp.expect_error(p_sql text, p_state text, p_label text)
RETURNS void
LANGUAGE plpgsql
AS $$
DECLARE
  got text;
  msg text;
BEGIN
  BEGIN
    EXECUTE p_sql;
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS got = RETURNED_SQLSTATE, msg = MESSAGE_TEXT;
  END;
  IF got IS NULL THEN
    RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, but the statement succeeded', p_label, p_state;
  END IF;
  IF got <> p_state THEN
    RAISE EXCEPTION 'FAIL %: expected SQLSTATE %, got % (%)', p_label, p_state, got, msg;
  END IF;
END;
$$;

-- Simulated Supabase login.
CREATE FUNCTION pg_temp.as_user(p_uid uuid, p_app_role text DEFAULT NULL)
RETURNS void
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM set_config('request.jwt.claims',
    jsonb_build_object('sub', p_uid, 'role', 'authenticated',
      'app_metadata', CASE WHEN p_app_role IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('role', p_app_role) END)::text,
    true);
END;
$$;

-- Clinic-local time slot: today (Asia/Kolkata) + p_days at p_hour:00.
CREATE FUNCTION pg_temp.slot(p_days integer, p_hour integer)
RETURNS timestamptz
LANGUAGE sql
STABLE
AS $$
  SELECT (date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + make_interval(days => p_days, hours => p_hour))
         AT TIME ZONE 'Asia/Kolkata';
$$;

/* ---------------------------------------------------------------------------------------------
   T0. Catalog and privileges
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.appointment_reminders', 'public.appointment_reminder_events',
                           'public.appointment_reminder_settings'] LOOP
    IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) THEN
      RAISE EXCEPTION 'FAIL T0: RLS disabled on %', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'FAIL T0: anon has privileges on %', t;
    END IF;
    IF has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE') THEN
      RAISE EXCEPTION 'FAIL T0: authenticated can write % directly', t;
    END IF;
  END LOOP;
  IF has_function_privilege('authenticated', 'public._create_appointment_reminders(uuid)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_reminder_delivery(uuid, text, timestamptz, text)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FAIL T0: function privileges too broad';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.appointment_reminders'::regclass AND conname = 'appointment_reminders_slot_key'
        AND contype = 'u') <> 1 THEN
    RAISE EXCEPTION 'FAIL T0: unique (appointment_id, reminder_number) missing';
  END IF;
  RAISE NOTICE 'PASS T0: RLS, grants, unique slot constraint';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a000-000000000001', 'rm-nonmember@test.invalid',   'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000002', 'rm-spoof-admin@test.invalid', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000003', 'rm-inactive@test.invalid',    'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000004', 'rm-staff@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000006', 'rm-admin@test.invalid',       'authenticated', 'authenticated'),
  ('00000000-0000-4000-a000-000000000008', 'rm-psych-a@test.invalid',     'authenticated', 'authenticated');

INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a000-000000000003', 'staff', false),
  ('00000000-0000-4000-a000-000000000004', 'staff', true),
  ('00000000-0000-4000-a000-000000000006', 'admin', true);

INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b000-000000000001', 'RM Psychologist A', '+910000000001', true, '00000000-0000-4000-a000-000000000008');

-- A Confirmed lead becomes a client through sync_client_from_lead.
INSERT INTO public.leads (id, full_name, phone, status, assigned_psychologist_id) VALUES
  ('00000000-0000-4000-c000-000000000001', 'RM Client', '+910000000099', 'Confirmed', '00000000-0000-4000-b000-000000000001');

INSERT INTO public.services (id, name, duration_minutes, buffer_minutes)
VALUES ('00000000-0000-4000-f000-000000000001', 'RM follow-up service', 50, 10);

-- Psychologist A works every day 06:00-22:00 (clinic time), so booking dates never depend on the weekday.
INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
SELECT '00000000-0000-4000-b000-000000000001', d, '06:00', '22:00', true FROM generate_series(1, 7) AS d;

-- A completed session two days ago, and four open follow-up recommendations from it.
INSERT INTO public.appointments (id, client_id, psychologist_id, service_id, service_type, starts_at, ends_at,
                                 buffer_minutes, status)
SELECT '00000000-0000-4000-d000-000000000001', c.id, '00000000-0000-4000-b000-000000000001',
       '00000000-0000-4000-f000-000000000001', 'RM follow-up service',
       date_trunc('hour', now()) - interval '2 days',
       date_trunc('hour', now()) - interval '2 days' + interval '50 minutes', 10, 'Completed'
FROM public.clients AS c WHERE c.lead_id = '00000000-0000-4000-c000-000000000001';

INSERT INTO public.sessions (id, appointment_id, client_id, psychologist_id, starts_at, ends_at, status, session_type)
SELECT '00000000-0000-4000-d100-000000000001', a.id, a.client_id, a.psychologist_id, a.starts_at, a.ends_at,
       'Completed', 'Initial'
FROM public.appointments AS a WHERE a.id = '00000000-0000-4000-d000-000000000001';

INSERT INTO public.follow_up_recommendations (id, session_id, client_id, psychologist_id, recommendation, recommended_date)
SELECT ('00000000-0000-4000-d200-00000000000' || n)::uuid, s.id, s.client_id, s.psychologist_id,
       format('RM follow up %s', n), current_date + 7
FROM public.sessions AS s, generate_series(1, 4) AS n
WHERE s.id = '00000000-0000-4000-d100-000000000001';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001') THEN
    RAISE EXCEPTION 'FIXTURE: client was not created from the confirmed lead';
  END IF;
  -- The completed fixture appointment is not a follow-up: no reminders.
  IF EXISTS (SELECT 1 FROM public.appointment_reminders) THEN
    RAISE EXCEPTION 'FIXTURE: unexpected reminders before any follow-up booking';
  END IF;
  PERFORM set_config('t.client',
    (SELECT id::text FROM public.clients WHERE lead_id = '00000000-0000-4000-c000-000000000001'), true);
END
$$;

/* ---------------------------------------------------------------------------------------------
   T1. Booking a follow-up appointment creates exactly two Pending reminders at the configured times
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  appt public.appointments;
  regular public.appointments;
  off1 interval;
  off2 interval;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  SELECT offset_before_start INTO off1 FROM public.appointment_reminder_settings WHERE reminder_number = 1;
  SELECT offset_before_start INTO off2 FROM public.appointment_reminder_settings WHERE reminder_number = 2;

  appt := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
            '00000000-0000-4000-f000-000000000001', pg_temp.slot(3, 10), 'RM follow-up 1',
            '00000000-0000-4000-d200-000000000001');
  PERFORM set_config('t.appt1', appt.id::text, true);

  IF (SELECT array_agg(reminder_number ORDER BY reminder_number) FROM public.appointment_reminders
      WHERE appointment_id = appt.id) IS DISTINCT FROM ARRAY[1, 2]::smallint[] THEN
    RAISE EXCEPTION 'FAIL T1: expected reminders 1 and 2 for the follow-up appointment';
  END IF;
  IF EXISTS (SELECT 1 FROM public.appointment_reminders WHERE appointment_id = appt.id
             AND (delivery_status <> 'Pending' OR sent_at IS NOT NULL OR client_response IS NOT NULL)) THEN
    RAISE EXCEPTION 'FAIL T1: new reminders must be Pending with no delivery/response details';
  END IF;
  IF (SELECT due_at FROM public.appointment_reminders WHERE appointment_id = appt.id AND reminder_number = 1)
       IS DISTINCT FROM appt.starts_at - off1
     OR (SELECT due_at FROM public.appointment_reminders WHERE appointment_id = appt.id AND reminder_number = 2)
       IS DISTINCT FROM appt.starts_at - off2 THEN
    RAISE EXCEPTION 'FAIL T1: due_at does not follow appointment_reminder_settings (% / %)', off1, off2;
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_events
      WHERE appointment_id = appt.id AND event_type = 'Created'
        AND changed_by = '00000000-0000-4000-a000-000000000004'
        AND note = 'Follow-up appointment booked') <> 2 THEN
    RAISE EXCEPTION 'FAIL T1: expected two Created events attributed to the booking staff member';
  END IF;

  -- A regular (non follow-up) booking gets no reminders.
  regular := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
               '00000000-0000-4000-f000-000000000001', pg_temp.slot(3, 14), 'RM regular');
  PERFORM set_config('t.regular', regular.id::text, true);
  IF EXISTS (SELECT 1 FROM public.appointment_reminders WHERE appointment_id = regular.id) THEN
    RAISE EXCEPTION 'FAIL T1: a non follow-up appointment got reminders';
  END IF;

  PERFORM set_config('t.a1r1', (SELECT id::text FROM public.appointment_reminders
                                WHERE appointment_id = appt.id AND reminder_number = 1), true);
  PERFORM set_config('t.a1r2', (SELECT id::text FROM public.appointment_reminders
                                WHERE appointment_id = appt.id AND reminder_number = 2), true);
  RAISE NOTICE 'PASS T1: follow-up booking created reminders 1 and 2 (Pending, due starts_at - %, - %); regular booking none',
    (SELECT offset_before_start FROM public.appointment_reminder_settings WHERE reminder_number = 1),
    (SELECT offset_before_start FROM public.appointment_reminder_settings WHERE reminder_number = 2);
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T2. No duplicate reminders
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  a uuid := current_setting('t.appt1')::uuid;
BEGIN
  IF public._create_appointment_reminders(a) <> 0 THEN
    RAISE EXCEPTION 'FAIL T2: re-running reminder creation created rows';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = a) <> 2 THEN
    RAISE EXCEPTION 'FAIL T2: appointment no longer has exactly two reminders';
  END IF;
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO public.appointment_reminders (appointment_id, reminder_number, due_at) VALUES (%L, 1, now())', a),
    '23505', 'T2 duplicate slot');
  PERFORM pg_temp.expect_error(format(
    'INSERT INTO public.appointment_reminders (appointment_id, reminder_number, due_at) VALUES (%L, 3, now())', a),
    '23514', 'T2 third slot');
END
$$;

SET LOCAL ROLE authenticated;
DO $$
DECLARE
  before_count bigint := (SELECT count(*) FROM public.appointment_reminders);
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  -- The same recommendation cannot be booked twice, so no second pair of reminders appears.
  PERFORM pg_temp.expect_error(format(
    'SELECT public.book_appointment(%L, %L, %L, %L, NULL, %L)', current_setting('t.client'),
    '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-f000-000000000001', pg_temp.slot(3, 12),
    '00000000-0000-4000-d200-000000000001'), 'P0001', 'T2 rebook scheduled recommendation');
  IF (SELECT count(*) FROM public.appointment_reminders) <> before_count THEN
    RAISE EXCEPTION 'FAIL T2: reminder count changed after a refused booking';
  END IF;
  RAISE NOTICE 'PASS T2: idempotent creation, unique slot, max two slots, no reminders from a refused rebooking';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T3. Delivery status updates (record_reminder_delivery)
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r1 uuid := current_setting('t.a1r1')::uuid;
  r2 uuid := current_setting('t.a1r2')::uuid;
  rem public.appointment_reminders;
  appt2 public.appointments;
  b1 uuid;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');

  rem := public.record_reminder_delivery(r1, 'Sent');
  IF rem.delivery_status <> 'Sent' OR rem.sent_at IS NULL
     OR rem.delivery_updated_by IS DISTINCT FROM '00000000-0000-4000-a000-000000000004'::uuid THEN
    RAISE EXCEPTION 'FAIL T3: Sent not recorded correctly';
  END IF;
  rem := public.record_reminder_delivery(r1, 'Delivered');
  IF rem.delivery_status <> 'Delivered' OR rem.delivered_at IS NULL OR rem.delivered_at < rem.sent_at THEN
    RAISE EXCEPTION 'FAIL T3: Delivered not recorded correctly';
  END IF;

  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', r1, 'Sent'),
    'P0001', 'T3 Delivered is final');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', r1, 'Delivered'),
    'P0001', 'T3 duplicate Delivered');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', r2, 'Pending'),
    '22023', 'T3 Pending is not a recordable status');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L, %L)', r2, 'Sent', now() + interval '1 hour'),
    '22023', 'T3 future delivery time');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', r2, 'Cancelled'),
    '22023', 'T3 manual cancel needs a reason');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', gen_random_uuid(), 'Sent'),
    'P0001', 'T3 unknown reminder');

  -- Second follow-up appointment: failure and retry.
  appt2 := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
             '00000000-0000-4000-f000-000000000001', pg_temp.slot(3, 16), NULL, '00000000-0000-4000-d200-000000000002');
  PERFORM set_config('t.appt2', appt2.id::text, true);
  SELECT id INTO b1 FROM public.appointment_reminders WHERE appointment_id = appt2.id AND reminder_number = 1;
  PERFORM set_config('t.a2r1', b1::text, true);
  PERFORM set_config('t.a2r2', (SELECT id::text FROM public.appointment_reminders
                                WHERE appointment_id = appt2.id AND reminder_number = 2), true);

  rem := public.record_reminder_delivery(b1, 'Failed', NULL, 'Number unreachable');
  IF rem.delivery_status <> 'Failed' OR rem.failed_at IS NULL OR rem.failure_reason <> 'Number unreachable' THEN
    RAISE EXCEPTION 'FAIL T3: Failed not recorded correctly';
  END IF;
  rem := public.record_reminder_delivery(b1, 'Sent');
  IF rem.delivery_status <> 'Sent' OR rem.sent_at IS NULL OR rem.failed_at IS NULL THEN
    RAISE EXCEPTION 'FAIL T3: retry after failure must be Sent and keep the failure time';
  END IF;
  IF (SELECT array_agg(coalesce(from_value, '-') || '>' || to_value ORDER BY event_seq)
      FROM public.appointment_reminder_events WHERE reminder_id = b1 AND event_type = 'Delivery status')
     IS DISTINCT FROM ARRAY['Pending>Failed', 'Failed>Sent'] THEN
    RAISE EXCEPTION 'FAIL T3: delivery history for the retried reminder is incomplete';
  END IF;
  IF (SELECT note FROM public.appointment_reminder_events
      WHERE reminder_id = b1 AND event_type = 'Delivery status' AND to_value = 'Failed') <> 'Number unreachable' THEN
    RAISE EXCEPTION 'FAIL T3: failure reason missing from history';
  END IF;
  RAISE NOTICE 'PASS T3: Sent, Delivered, Failed, retry, final states and input validation';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T4. Client response (record_reminder_response)
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r1 uuid := current_setting('t.a1r1')::uuid;
  r2 uuid := current_setting('t.a1r2')::uuid;
  rem public.appointment_reminders;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  rem := public.record_reminder_response(r1, 'Confirmed', 'Replied on WhatsApp');
  IF rem.client_response <> 'Confirmed' OR rem.responded_at IS NULL OR rem.response_note <> 'Replied on WhatsApp'
     OR rem.response_recorded_by IS DISTINCT FROM '00000000-0000-4000-a000-000000000004'::uuid
     OR rem.response_recorded_by_name IS NULL THEN
    RAISE EXCEPTION 'FAIL T4: response not recorded correctly';
  END IF;
  rem := public.record_reminder_response(r1, 'Wants to Reschedule', 'Asked for another day');
  IF rem.client_response <> 'Wants to Reschedule' THEN
    RAISE EXCEPTION 'FAIL T4: response update not saved';
  END IF;
  IF (SELECT array_agg(coalesce(from_value, '-') || '>' || to_value ORDER BY event_seq)
      FROM public.appointment_reminder_events WHERE reminder_id = r1 AND event_type = 'Client response')
     IS DISTINCT FROM ARRAY['->Confirmed', 'Confirmed>Wants to Reschedule'] THEN
    RAISE EXCEPTION 'FAIL T4: response history incomplete';
  END IF;

  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_response(%L, %L)', r2, 'Confirmed'),
    'P0001', 'T4 response before the reminder was sent');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_response(%L, %L)', r1, 'Maybe'),
    '22023', 'T4 invalid response value');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_response(%L, %L, %L)', r1,
    'Wants to Reschedule', 'Asked for another day'), 'P0001', 'T4 duplicate response');
  RAISE NOTICE 'PASS T4: client response recorded, replaced with history, validated';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T5. Moving a pending reminder (update_reminder_due_at)
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  r1 uuid := current_setting('t.a1r1')::uuid;
  r2 uuid := current_setting('t.a1r2')::uuid;
  starts timestamptz := (SELECT starts_at FROM public.appointments WHERE id = current_setting('t.appt1')::uuid);
  rem public.appointment_reminders;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  rem := public.update_reminder_due_at(r2, starts - interval '3 hours', 'Client prefers an earlier message');
  IF rem.due_at IS DISTINCT FROM starts - interval '3 hours' THEN
    RAISE EXCEPTION 'FAIL T5: due_at not updated';
  END IF;
  PERFORM pg_temp.expect_error(format('SELECT public.update_reminder_due_at(%L, %L)', r2, starts + interval '1 minute'),
    '22023', 'T5 after the appointment start');
  PERFORM pg_temp.expect_error(format('SELECT public.update_reminder_due_at(%L, %L)', r2,
    (SELECT due_at FROM public.appointment_reminders WHERE id = r1) - interval '1 hour'),
    '22023', 'T5 reminder 2 before reminder 1');
  PERFORM pg_temp.expect_error(format('SELECT public.update_reminder_due_at(%L, %L)', r1, starts - interval '5 hours'),
    'P0001', 'T5 delivered reminder cannot move');
  IF (SELECT count(*) FROM public.appointment_reminder_events WHERE reminder_id = r2 AND event_type = 'Due time'
      AND note = 'Client prefers an earlier message') <> 1 THEN
    RAISE EXCEPTION 'FAIL T5: due time change missing from history';
  END IF;
  RAISE NOTICE 'PASS T5: pending reminder moved; invalid moves refused';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T6. Rescheduling: old appointment and its history kept, old PENDING reminders cancelled, exactly two new
   reminders, recommendation points to the replacement, no duplicates on a second attempt
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  old_id uuid := current_setting('t.appt1')::uuid;
  r1 uuid := current_setting('t.a1r1')::uuid;
  r2 uuid := current_setting('t.a1r2')::uuid;
  r1_before jsonb := (SELECT to_jsonb(x) FROM public.appointment_reminders AS x WHERE x.id = r1);
  events_before jsonb := (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_seq)
                          FROM public.appointment_reminder_events AS e WHERE e.appointment_id = old_id);
  new_appt public.appointments;
  newer public.appointments;
  off1 interval := (SELECT offset_before_start FROM public.appointment_reminder_settings WHERE reminder_number = 1);
  off2 interval := (SELECT offset_before_start FROM public.appointment_reminder_settings WHERE reminder_number = 2);
  total bigint;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  new_appt := public.reschedule_appointment(old_id, pg_temp.slot(4, 10), NULL, 'Client asked for another day');

  IF (SELECT status FROM public.appointments WHERE id = old_id) <> 'Rescheduled' THEN
    RAISE EXCEPTION 'FAIL T6: old appointment not kept as Rescheduled';
  END IF;
  -- The delivered, answered reminder is untouched.
  IF (SELECT to_jsonb(x) FROM public.appointment_reminders AS x WHERE x.id = r1) IS DISTINCT FROM r1_before THEN
    RAISE EXCEPTION 'FAIL T6: the delivered reminder of the old appointment was changed';
  END IF;
  -- The pending one is cancelled, with a reason.
  IF (SELECT delivery_status FROM public.appointment_reminders WHERE id = r2) <> 'Cancelled'
     OR (SELECT cancelled_at FROM public.appointment_reminders WHERE id = r2) IS NULL THEN
    RAISE EXCEPTION 'FAIL T6: pending reminder of the old appointment not cancelled';
  END IF;
  -- Old history: every earlier event still there, unchanged, plus exactly one new cancellation event.
  IF (SELECT jsonb_agg(to_jsonb(e) ORDER BY e.event_seq) FROM public.appointment_reminder_events AS e
      WHERE e.appointment_id = old_id AND NOT (e.reminder_id = r2 AND e.event_type = 'Delivery status'))
     IS DISTINCT FROM events_before THEN
    RAISE EXCEPTION 'FAIL T6: earlier reminder history changed';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_events WHERE reminder_id = r2 AND event_type = 'Delivery status'
      AND from_value = 'Pending' AND to_value = 'Cancelled' AND note = 'Appointment rescheduled') <> 1 THEN
    RAISE EXCEPTION 'FAIL T6: cancellation of the old pending reminder not recorded';
  END IF;

  -- Exactly two new Pending reminders for the replacement, timed from the NEW start.
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = new_appt.id AND delivery_status = 'Pending') <> 2
     OR (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = new_appt.id) <> 2 THEN
    RAISE EXCEPTION 'FAIL T6: replacement does not have exactly two Pending reminders';
  END IF;
  IF (SELECT due_at FROM public.appointment_reminders WHERE appointment_id = new_appt.id AND reminder_number = 1)
       IS DISTINCT FROM new_appt.starts_at - off1
     OR (SELECT due_at FROM public.appointment_reminders WHERE appointment_id = new_appt.id AND reminder_number = 2)
       IS DISTINCT FROM new_appt.starts_at - off2 THEN
    RAISE EXCEPTION 'FAIL T6: replacement reminders not timed from the new start';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_events WHERE appointment_id = new_appt.id
      AND event_type = 'Created' AND note = format('Replacement for rescheduled appointment %s', old_id)) <> 2 THEN
    RAISE EXCEPTION 'FAIL T6: creation events for the replacement missing';
  END IF;
  IF (SELECT appointment_id FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000001')
       IS DISTINCT FROM new_appt.id
     OR (SELECT status FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000001') <> 'Scheduled' THEN
    RAISE EXCEPTION 'FAIL T6: recommendation does not point to the replacement appointment';
  END IF;

  -- The original cannot be rescheduled again; nothing is duplicated.
  total := (SELECT count(*) FROM public.appointment_reminders);
  PERFORM pg_temp.expect_error(format('SELECT public.reschedule_appointment(%L, %L)', old_id, pg_temp.slot(4, 12)),
    'P0001', 'T6 reschedule an already rescheduled appointment');
  IF (SELECT count(*) FROM public.appointment_reminders) <> total THEN
    RAISE EXCEPTION 'FAIL T6: a refused reschedule changed the reminders';
  END IF;

  -- Rescheduling the replacement again: its pending reminders are cancelled, the newest gets two.
  newer := public.reschedule_appointment(new_appt.id, pg_temp.slot(5, 10));
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = new_appt.id AND delivery_status = 'Cancelled') <> 2
     OR (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = newer.id AND delivery_status = 'Pending') <> 2
     OR (SELECT appointment_id FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000001')
          IS DISTINCT FROM newer.id THEN
    RAISE EXCEPTION 'FAIL T6: second reschedule did not move reminders and recommendation';
  END IF;
  IF EXISTS (SELECT 1 FROM public.appointment_reminders GROUP BY appointment_id HAVING count(*) <> 2) THEN
    RAISE EXCEPTION 'FAIL T6: some appointment does not have exactly two reminder slots';
  END IF;
  PERFORM set_config('t.appt1c', newer.id::text, true);
  RAISE NOTICE 'PASS T6: reschedule kept history, cancelled pending only, created exactly two new, repointed recommendation';
END
$$;
RESET ROLE;

/* ---------------------------------------------------------------------------------------------
   T7. Cancellation cancels pending reminders only; completion does the same
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  a2 uuid := current_setting('t.appt2')::uuid;
  b1 uuid := current_setting('t.a2r1')::uuid; -- Sent (after a failed attempt)
  b2 uuid := current_setting('t.a2r2')::uuid; -- Pending
  b1_before jsonb := (SELECT to_jsonb(x) FROM public.appointment_reminders AS x WHERE x.id = b1);
  rem public.appointment_reminders;
  rebooked public.appointments;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  PERFORM public.cancel_appointment(a2, 'Client travelling');

  IF (SELECT to_jsonb(x) FROM public.appointment_reminders AS x WHERE x.id = b1) IS DISTINCT FROM b1_before THEN
    RAISE EXCEPTION 'FAIL T7: sent reminder changed by the cancellation';
  END IF;
  IF (SELECT delivery_status FROM public.appointment_reminders WHERE id = b2) <> 'Cancelled' THEN
    RAISE EXCEPTION 'FAIL T7: pending reminder not cancelled';
  END IF;
  IF (SELECT note FROM public.appointment_reminder_events
      WHERE reminder_id = b2 AND event_type = 'Delivery status' AND to_value = 'Cancelled') <> 'Appointment cancelled: Client travelling' THEN
    RAISE EXCEPTION 'FAIL T7: cancellation reason not in reminder history';
  END IF;
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', b2, 'Sent'),
    'P0001', 'T7 cancelled reminder is final');

  -- A delivery receipt for the already-sent reminder can still be recorded (history stays complete).
  rem := public.record_reminder_delivery(b1, 'Delivered');
  IF rem.delivery_status <> 'Delivered' THEN
    RAISE EXCEPTION 'FAIL T7: late delivery receipt not recorded';
  END IF;

  -- The recommendation is open again; rebooking it creates two fresh reminders, old ones are kept.
  IF (SELECT status FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000002') <> 'Open' THEN
    RAISE EXCEPTION 'FAIL T7: recommendation not reopened by cancel_appointment';
  END IF;
  rebooked := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
                '00000000-0000-4000-f000-000000000001', pg_temp.slot(6, 10), NULL, '00000000-0000-4000-d200-000000000002');
  PERFORM set_config('t.appt3', rebooked.id::text, true);
  PERFORM set_config('t.a3r1', (SELECT id::text FROM public.appointment_reminders
                                WHERE appointment_id = rebooked.id AND reminder_number = 1), true);
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = rebooked.id AND delivery_status = 'Pending') <> 2
     OR (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = a2) <> 2 THEN
    RAISE EXCEPTION 'FAIL T7: rebooking did not produce two new reminders while keeping the old two';
  END IF;
  RAISE NOTICE 'PASS T7: cancellation cancelled pending only; sent/delivered history kept; rebooking created two new';
END
$$;
RESET ROLE;

-- T7b. Completion (attendance recorded) also cancels reminders that were never sent.
DO $$
DECLARE
  c uuid := current_setting('t.appt1c')::uuid;
BEGIN
  UPDATE public.appointments SET status = 'Completed' WHERE id = c;
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = c AND delivery_status = 'Cancelled'
        AND cancelled_at IS NOT NULL) <> 2
     OR (SELECT count(*) FROM public.appointment_reminder_events WHERE appointment_id = c
         AND to_value = 'Cancelled' AND note = 'Appointment completed') <> 2 THEN
    RAISE EXCEPTION 'FAIL T7b: pending reminders of a completed appointment not cancelled';
  END IF;
  RAISE NOTICE 'PASS T7b: completion cancels pending reminders';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T8. Unauthorised users can neither see nor change reminder records
   --------------------------------------------------------------------------------------------- */
-- T8a. anon: no table or function access at all.
SET LOCAL ROLE anon;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
DO $$
DECLARE
  p uuid := current_setting('t.a3r1')::uuid;
BEGIN
  PERFORM pg_temp.expect_error('SELECT 1 FROM public.appointment_reminders', '42501', 'T8a anon read reminders');
  PERFORM pg_temp.expect_error('SELECT 1 FROM public.appointment_reminder_events', '42501', 'T8a anon read events');
  PERFORM pg_temp.expect_error('SELECT 1 FROM public.appointment_reminder_settings', '42501', 'T8a anon read settings');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', p, 'Sent'), '42501', 'T8a anon delivery');
  PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_response(%L, %L)', p, 'Confirmed'), '42501', 'T8a anon response');
  PERFORM pg_temp.expect_error(format('SELECT public.update_reminder_due_at(%L, %L)', p, now() + interval '1 hour'), '42501', 'T8a anon due');
  PERFORM pg_temp.expect_error('SELECT public.set_reminder_offsets(''48 hours'', ''1 hour'')', '42501', 'T8a anon offsets');
  RAISE NOTICE 'PASS T8a: anon denied';
END
$$;
RESET ROLE;

-- T8b. Signed-in users without an ACTIVE staff membership (incl. a spoofed JWT admin and the psychologist).
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  c record;
  p uuid := current_setting('t.a3r1')::uuid;            -- a Pending reminder
  d uuid := current_setting('t.a1r1')::uuid;            -- a Delivered reminder
BEGIN
  FOR c IN
    SELECT * FROM (VALUES
      ('non-member',            '00000000-0000-4000-a000-000000000001'::uuid, NULL::text),
      ('non-member JWT admin',  '00000000-0000-4000-a000-000000000002'::uuid, 'admin'),
      ('inactive staff',        '00000000-0000-4000-a000-000000000003'::uuid, NULL),
      ('psychologist A',        '00000000-0000-4000-a000-000000000008'::uuid, 'admin')
    ) AS t(label, uid, app_role)
  LOOP
    PERFORM pg_temp.as_user(c.uid, c.app_role);
    IF EXISTS (SELECT 1 FROM public.appointment_reminders) OR EXISTS (SELECT 1 FROM public.appointment_reminder_events)
       OR EXISTS (SELECT 1 FROM public.appointment_reminder_settings) THEN
      RAISE EXCEPTION 'FAIL T8b: % can read reminder data', c.label;
    END IF;
    PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_delivery(%L, %L)', p, 'Sent'), '42501', 'T8b delivery ' || c.label);
    PERFORM pg_temp.expect_error(format('SELECT public.record_reminder_response(%L, %L)', d, 'No Response'), '42501', 'T8b response ' || c.label);
    PERFORM pg_temp.expect_error(format('SELECT public.update_reminder_due_at(%L, %L)', p, now() + interval '1 hour'), '42501', 'T8b due ' || c.label);
    PERFORM pg_temp.expect_error('SELECT public.set_reminder_offsets(''48 hours'', ''1 hour'')', '42501', 'T8b offsets ' || c.label);
    PERFORM pg_temp.expect_error(format('UPDATE public.appointment_reminders SET delivery_status = ''Sent'', sent_at = now() WHERE id = %L', p),
      '42501', 'T8b direct update ' || c.label);
    PERFORM pg_temp.expect_error(format('INSERT INTO public.appointment_reminders (appointment_id, reminder_number, due_at) VALUES (%L, 1, now())',
      current_setting('t.regular')), '42501', 'T8b direct insert ' || c.label);
    PERFORM pg_temp.expect_error(format('DELETE FROM public.appointment_reminders WHERE id = %L', p), '42501', 'T8b direct delete ' || c.label);
    PERFORM pg_temp.expect_error('SELECT public._create_appointment_reminders(gen_random_uuid())', '42501', 'T8b internal fn ' || c.label);
  END LOOP;

  -- Active staff: can read, but cannot write directly and cannot change timing (admin only).
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  IF NOT EXISTS (SELECT 1 FROM public.appointment_reminders) OR NOT EXISTS (SELECT 1 FROM public.appointment_reminder_events) THEN
    RAISE EXCEPTION 'FAIL T8b: active staff cannot read reminders';
  END IF;
  PERFORM pg_temp.expect_error(format('UPDATE public.appointment_reminders SET due_at = now() WHERE id = %L', p),
    '42501', 'T8b staff direct update');
  PERFORM pg_temp.expect_error('SELECT public.set_reminder_offsets(''48 hours'', ''1 hour'')', '42501', 'T8b staff offsets');
  RAISE NOTICE 'PASS T8b: non-members, spoofed JWT admin, inactive staff and psychologists denied; staff read-only outside RPCs';
END
$$;
RESET ROLE;

-- T8c. Even the table owner cannot delete reminder history or edit events; the probed reminder is untouched.
DO $$
DECLARE
  p uuid := current_setting('t.a3r1')::uuid;
BEGIN
  PERFORM pg_temp.expect_error(format('DELETE FROM public.appointment_reminders WHERE id = %L', p), '42501', 'T8c owner delete');
  PERFORM pg_temp.expect_error(format('UPDATE public.appointment_reminder_events SET note = ''x'' WHERE reminder_id = %L', p),
    '42501', 'T8c owner edits event');
  PERFORM pg_temp.expect_error(format('DELETE FROM public.appointment_reminder_events WHERE reminder_id = %L', p),
    '42501', 'T8c owner deletes event');
  -- Reopening a Delivered reminder is refused even for the owner (status rules live in a trigger).
  PERFORM pg_temp.expect_error(format(
    'UPDATE public.appointment_reminders SET delivery_status = ''Sent'', delivered_at = NULL WHERE id = %L',
    current_setting('t.a1r1')), 'P0001', 'T8c owner breaks the status rules');
  IF (SELECT delivery_status FROM public.appointment_reminders WHERE id = p) <> 'Pending' THEN
    RAISE EXCEPTION 'FAIL T8c: a refused write changed the reminder';
  END IF;
  RAISE NOTICE 'PASS T8c: history is append-only and status rules bind every writer';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T9. Failed bookings and reschedules leave no orphan reminders
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  n_appt bigint := (SELECT count(*) FROM public.appointments);
  n_rem bigint := (SELECT count(*) FROM public.appointment_reminders);
  n_evt bigint := (SELECT count(*) FROM public.appointment_reminder_events);
  n_ses bigint := (SELECT count(*) FROM public.sessions);
  a3 uuid := current_setting('t.appt3')::uuid;
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  -- Overlaps the active regular appointment at day 3, 14:00.
  PERFORM pg_temp.expect_error(format('SELECT public.book_appointment(%L, %L, %L, %L, NULL, %L)',
    current_setting('t.client'), '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-f000-000000000001',
    pg_temp.slot(3, 14), '00000000-0000-4000-d200-000000000003'), '23P01', 'T9 overlapping follow-up booking');
  -- Outside working hours.
  PERFORM pg_temp.expect_error(format('SELECT public.book_appointment(%L, %L, %L, %L, NULL, %L)',
    current_setting('t.client'), '00000000-0000-4000-b000-000000000001', '00000000-0000-4000-f000-000000000001',
    pg_temp.slot(3, 23), '00000000-0000-4000-d200-000000000003'), 'P0001', 'T9 booking outside hours');
  -- A reschedule into an occupied slot changes nothing either.
  PERFORM pg_temp.expect_error(format('SELECT public.reschedule_appointment(%L, %L)', a3, pg_temp.slot(3, 14)),
    '23P01', 'T9 overlapping reschedule');

  IF (SELECT count(*) FROM public.appointments) <> n_appt OR (SELECT count(*) FROM public.appointment_reminders) <> n_rem
     OR (SELECT count(*) FROM public.appointment_reminder_events) <> n_evt OR (SELECT count(*) FROM public.sessions) <> n_ses THEN
    RAISE EXCEPTION 'FAIL T9: a failed booking/reschedule left rows behind';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminders WHERE appointment_id = a3 AND delivery_status = 'Pending') <> 2 THEN
    RAISE EXCEPTION 'FAIL T9: a failed reschedule touched the existing reminders';
  END IF;
  IF (SELECT status FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000003') <> 'Open' THEN
    RAISE EXCEPTION 'FAIL T9: recommendation changed by a failed booking';
  END IF;
  RAISE NOTICE 'PASS T9a: failed bookings/reschedules left no appointment, session or reminder';
END
$$;
RESET ROLE;

-- T9b. If reminders cannot be created (timing not configured), the whole booking fails: no appointment either.
SELECT pg_temp.as_user('00000000-0000-4000-a000-000000000004');
DO $$
DECLARE
  n_appt bigint := (SELECT count(*) FROM public.appointments);
  n_rem bigint := (SELECT count(*) FROM public.appointment_reminders);
  n_ses bigint := (SELECT count(*) FROM public.sessions);
  err text;
BEGIN
  BEGIN
    DELETE FROM public.appointment_reminder_settings WHERE reminder_number = 2;
    PERFORM public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
      '00000000-0000-4000-f000-000000000001', pg_temp.slot(7, 10), NULL, '00000000-0000-4000-d200-000000000003');
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS err = MESSAGE_TEXT;
  END;
  IF err IS NULL OR position('not configured' IN err) = 0 THEN
    RAISE EXCEPTION 'FAIL T9b: booking should fail when reminder timing is missing (got: %)', coalesce(err, 'success');
  END IF;
  IF (SELECT count(*) FROM public.appointments) <> n_appt OR (SELECT count(*) FROM public.appointment_reminders) <> n_rem
     OR (SELECT count(*) FROM public.sessions) <> n_ses
     OR (SELECT status FROM public.follow_up_recommendations WHERE id = '00000000-0000-4000-d200-000000000003') <> 'Open' THEN
    RAISE EXCEPTION 'FAIL T9b: a booking that failed on reminder creation left rows behind';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_settings) <> 2 THEN
    RAISE EXCEPTION 'FAIL T9b: test setup not rolled back';
  END IF;
  RAISE NOTICE 'PASS T9b: reminder creation failure rolls back the whole booking (no orphan appointment or reminder)';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T10. Timing is configuration: admins change offsets, new reminders follow, existing ones do not move
   --------------------------------------------------------------------------------------------- */
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  a4 public.appointments;
  a5 public.appointments;
  a3_due timestamptz := (SELECT due_at FROM public.appointment_reminders WHERE id = current_setting('t.a3r1')::uuid);
BEGIN
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000006');
  PERFORM pg_temp.expect_error('SELECT public.set_reminder_offsets(''1 hour'', ''2 hours'')', '22023', 'T10 reversed offsets');
  PERFORM pg_temp.expect_error('SELECT public.set_reminder_offsets(''40 days'', ''2 hours'')', '22023', 'T10 offset too long');
  PERFORM public.set_reminder_offsets(interval '30 days', interval '29 days');

  -- Offsets longer than the lead time: both reminders become due immediately, in order.
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  a4 := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
          '00000000-0000-4000-f000-000000000001', pg_temp.slot(3, 18), NULL, '00000000-0000-4000-d200-000000000003');
  IF (SELECT array_agg(due_at ORDER BY reminder_number) FROM public.appointment_reminders WHERE appointment_id = a4.id)
     IS DISTINCT FROM ARRAY[now(), now()] THEN
    RAISE EXCEPTION 'FAIL T10: reminders past their offset must be due now';
  END IF;

  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000006');
  PERFORM public.set_reminder_offsets(interval '48 hours', interval '1 hour');
  PERFORM pg_temp.as_user('00000000-0000-4000-a000-000000000004');
  a5 := public.book_appointment(current_setting('t.client')::uuid, '00000000-0000-4000-b000-000000000001',
          '00000000-0000-4000-f000-000000000001', pg_temp.slot(8, 10), NULL, '00000000-0000-4000-d200-000000000004');
  IF (SELECT array_agg(due_at ORDER BY reminder_number) FROM public.appointment_reminders WHERE appointment_id = a5.id)
     IS DISTINCT FROM ARRAY[a5.starts_at - interval '48 hours', a5.starts_at - interval '1 hour'] THEN
    RAISE EXCEPTION 'FAIL T10: new reminders do not use the new offsets';
  END IF;
  IF (SELECT due_at FROM public.appointment_reminders WHERE id = current_setting('t.a3r1')::uuid) IS DISTINCT FROM a3_due THEN
    RAISE EXCEPTION 'FAIL T10: changing offsets moved an existing reminder';
  END IF;
  IF (SELECT updated_by FROM public.appointment_reminder_settings WHERE reminder_number = 1)
       IS DISTINCT FROM '00000000-0000-4000-a000-000000000006'::uuid THEN
    RAISE EXCEPTION 'FAIL T10: settings change not attributed to the admin';
  END IF;
  RAISE NOTICE 'PASS T10: offsets configurable by admins; clamped when late; existing reminders unchanged';
END
$$;
RESET ROLE;

DO $$ BEGIN RAISE NOTICE 'ALL APPOINTMENT REMINDER TESTS PASSED (rolling back fixtures)'; END $$;

ROLLBACK;
