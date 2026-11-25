-- Kappiness CRM (Day 24): tests for client management, phone-number matching (shared numbers allowed), linking an
-- enquiry to an existing client, communication tracking and client audit access
-- (migration 20261125120000_client_management_duplicates_communication.sql).
-- Owner: Aswathy (backend / database).
--
-- RUN ONLY ON A DISPOSABLE DATABASE (fresh local stack, Supabase branch or in-memory PGlite). NEVER ON THE LIVE PROJECT.
-- Refuses to start unless  SET kappiness.test_env = 'disposable';  was run AND crm_staff_members is empty.
--
-- PRECONDITIONS: the production path from supabase/test-bootstrap/README.md, then 202611210001..05, 20261123161850,
--   20261123223548, 202611240001 and 20261125120000.
--
-- One transaction, ending in ROLLBACK. Any failed assertion raises an exception ("FAIL ...").
--
-- WHAT IS COVERED
--   T0  catalog: columns, NON-unique phone index (no unique rule on the number), triggers, RLS, grants, audit policy
--   T1  normalize_phone: formatting variants match, different countries never match (same vectors as tests/phone.test.mjs)
--   T2  shared numbers: two and three clients sharing an Indian number, two sharing an international number, a separate
--       client created despite a match, a phone edit to a shared number, nothing linked / changed automatically
--   T3  linking with several matches: lookup lists every client; the chosen (second) client gets the appointment and
--       the link, the others are untouched; linking to the third; manual link needs a note; unlink rules; Day 23 RPC
--       on a linked lead rolls back; transition rules still apply; T3k permissions
--   T4  client management: directory counts and dates, Active/Inactive with guard and history, audited edits,
--       validation, stale-save protection, column grants, T4h psychologist scope (no unrelated clients)
--   T5  communication: lead + client events, staff + time recorded, trail, channel/status rules, statuses separate,
--       staff-only read, no automatic "Message Sent"
--   T6  regression: booking, rescheduling, double booking, Day 21 rules, Day 23 conversion
--   T7  as table owner: a direct insert with a shared number is allowed; communication history is append-only;
--       only record_communication writes communication_events
--   T8  deactivation guard counts past appointments still awaiting attendance
--   T9  client audit: psychologists read the audit of the clients they may read (including the deactivation reason),
--       never of unrelated clients; access follows a reassignment at once; nobody but the trigger can write it

BEGIN;

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
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients'
                 AND column_name = 'referral_source')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients'
                    AND column_name = 'phone_normalized' AND is_generated = 'ALWAYS')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'clients'
                    AND column_name = 'is_active') THEN
    RAISE EXCEPTION 'FAIL T0: clients columns referral_source / phone_normalized / is_active missing';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'idx_clients_phone_normalized'
                 AND indexdef LIKE 'CREATE INDEX%(phone_normalized) WHERE (phone_normalized IS NOT NULL)')
     OR to_regclass('public.clients_phone_normalized_key') IS NOT NULL
     OR EXISTS (SELECT 1 FROM pg_index AS i WHERE i.indrelid = 'public.clients'::regclass AND i.indisunique
                AND i.indkey::int2[] @> ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clients'::regclass
                                              AND attname = 'phone_normalized')]) THEN
    RAISE EXCEPTION 'FAIL T0: phone index must exist and must NOT be unique';
  END IF;
  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'FAIL T0: triggers on leads are %', v_text;
  END IF;
  SELECT string_agg(t.tgname::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.clients'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'clients_audit_changes,clients_guard_deactivation' THEN
    RAISE EXCEPTION 'FAIL T0: triggers on clients are %', v_text;
  END IF;
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.communication_events'::regclass)
     OR NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.lead_client_links'::regclass) THEN
    RAISE EXCEPTION 'FAIL T0: RLS off on a new table';
  END IF;
  IF has_table_privilege('authenticated', 'public.communication_events', 'INSERT')
     OR has_table_privilege('authenticated', 'public.lead_client_links', 'INSERT')
     OR has_table_privilege('authenticated', 'public.activity_log', 'INSERT, UPDATE, DELETE, TRUNCATE')
     OR has_table_privilege('anon', 'public.communication_events', 'SELECT')
     OR has_table_privilege('anon', 'public.client_directory', 'SELECT')
     OR has_table_privilege('anon', 'public.activity_log', 'SELECT')
     OR has_column_privilege('authenticated', 'public.clients', 'referral_source', 'UPDATE') THEN
    RAISE EXCEPTION 'FAIL T0: unexpected privileges';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activity_log'
                 AND policyname = 'activity_log_client_audit_read' AND cmd = 'SELECT' AND permissive = 'PERMISSIVE')
     OR NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'activity_log'
                    AND policyname = 'activity_log_read') THEN
    RAISE EXCEPTION 'FAIL T0: activity_log policies';
  END IF;
  IF has_function_privilege('anon', 'public.convert_lead_to_existing_client(uuid,text,uuid,uuid,uuid,timestamptz,text,text)', 'EXECUTE')
     OR has_function_privilege('anon', 'public.record_communication(uuid,uuid,text,text,text,timestamptz)', 'EXECUTE')
     OR (SELECT prosecdef FROM pg_proc WHERE oid = 'public.convert_lead_to_existing_client(uuid,text,uuid,uuid,uuid,timestamptz,text,text)'::regprocedure)
     OR NOT (SELECT prosecdef FROM pg_proc WHERE oid = 'public.record_communication(uuid,uuid,text,text,text,timestamptz)'::regprocedure) THEN
    RAISE EXCEPTION 'FAIL T0: function grants or security';
  END IF;
  -- Day 21 / Day 23 contracts untouched.
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)'::regprocedure), E'\r', ''))
       <> 'd61213476b5d2537d729a08e91a008eb'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.update_lead_with_history(uuid,text,jsonb,jsonb)'::regprocedure), E'\r', ''))
       <> '0a62ea753396e7da751446e34373c29e'
     OR md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.enforce_lead_workflow()'::regprocedure), E'\r', ''))
       <> '7c9f820ac5dd11e57e6b4a11b2785a6b' THEN
    RAISE EXCEPTION 'FAIL T0: a Day 21 / Day 23 function changed';
  END IF;
  RAISE NOTICE 'PASS T0: catalog (phone number not unique, audit policy, grants)';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T1. normalize_phone
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('9876543210', '+919876543210'),
    ('98765 43210', '+919876543210'),
    ('98765-43210', '+919876543210'),
    ('(98765) 43210', '+919876543210'),
    ('+91 98765 43210', '+919876543210'),
    ('+91-98765-43210', '+919876543210'),
    ('+91 (0) 98765 43210', '+919876543210'),
    ('+9109876543210', '+919876543210'),
    ('09876543210', '+919876543210'),
    ('919876543210', '+919876543210'),
    ('0091 98765 43210', '+919876543210'),
    ('  +91.98765.43210  ', '+919876543210'),
    ('+91 98765 43210 ext 12', '+919876543210'),
    ('+44 7911 123456', '+447911123456'),
    ('0044 7911 123456', '+447911123456'),
    ('+44 98765 43210', '+449876543210'),
    ('+1 (202) 555-0123', '+12025550123'),
    ('+971 50 123 4567', '+971501234567'),
    ('(+44) 7911 123456', '+447911123456'),
    (chr(160) || '+44 7911 123456', '+447911123456'),
    (chr(9) || '+44 7911 123456', '+447911123456'),
    ('Tel: +44 7911 123456', '+447911123456'),
    ('(+1) 202 555 0123', '+12025550123'),
    ('1234567', '1234567'),
    ('12345', NULL),
    ('', NULL),
    ('not a number', NULL),
    ('+123', NULL)
  ) AS v(input, expected) LOOP
    IF public.normalize_phone(r.input) IS DISTINCT FROM r.expected THEN
      RAISE EXCEPTION 'FAIL T1: normalize_phone(%) = %, expected %', r.input, public.normalize_phone(r.input), r.expected;
    END IF;
  END LOOP;
  IF public.normalize_phone(NULL) IS NOT NULL THEN RAISE EXCEPTION 'FAIL T1: NULL'; END IF;
  IF public.normalize_phone('+44 98765 43210') = public.normalize_phone('+91 98765 43210')
     OR public.normalize_phone('+44 7911 123456') = public.normalize_phone('7911123456') THEN
    RAISE EXCEPTION 'FAIL T1: different countries matched';
  END IF;
  RAISE NOTICE 'PASS T1: phone normalisation (formatting variants match, other countries do not)';
END
$$;

/* ---------------------------------------------------------------------------------------------
   Fixtures (as the table owner, no JWT)
   Number X = Indian 98765 43210 in several formats; number Y = UK +44 98765 43210 (same national digits).
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '', true);

INSERT INTO auth.users (id, email, aud, role) VALUES
  ('00000000-0000-4000-a024-000000000001', 'd24-staff@test.invalid',    'authenticated', 'authenticated'),
  ('00000000-0000-4000-a024-000000000002', 'd24-psych-1@test.invalid',  'authenticated', 'authenticated'),
  ('00000000-0000-4000-a024-000000000003', 'd24-nonmember@test.invalid','authenticated', 'authenticated'),
  ('00000000-0000-4000-a024-000000000004', 'd24-psych-2@test.invalid',  'authenticated', 'authenticated');
INSERT INTO public.crm_staff_members (user_id, access_level, is_active) VALUES
  ('00000000-0000-4000-a024-000000000001', 'staff', true);
INSERT INTO public.psychologists (id, full_name, phone, is_active, auth_user_id) VALUES
  ('00000000-0000-4000-b024-000000000001', 'D24 Psychologist One', '+910000240001', true, '00000000-0000-4000-a024-000000000002'),
  ('00000000-0000-4000-b024-000000000002', 'D24 Psychologist Two', '+910000240002', true, '00000000-0000-4000-a024-000000000004');
INSERT INTO public.psychologist_availability (psychologist_id, day_of_week, start_time, end_time, is_active)
SELECT p, d, '06:00', '22:00', true
FROM unnest(ARRAY['00000000-0000-4000-b024-000000000001', '00000000-0000-4000-b024-000000000002']::uuid[]) AS p,
     generate_series(1, 7) AS d;

INSERT INTO public.leads (id, full_name, phone, source, status, assigned_psychologist_id, next_follow_up_at) VALUES
  ('00000000-0000-4000-c024-00000000000a', 'D24 A',       '98765 43210',       'Google Ad', 'Interested',            NULL, NULL),
  ('00000000-0000-4000-c024-00000000000b', 'D24 B',       '98765 43210',       'Meta Ad',   'Interested',            NULL, now() + interval '2 days'),
  ('00000000-0000-4000-c024-00000000000c', 'D24 C',       '+91-98765-43210',   'Other',     'Awaiting Confirmation', '00000000-0000-4000-b024-000000000001', NULL),
  ('00000000-0000-4000-c024-00000000000d', 'D24 D',       '+44 98765 43210',   'Other',     'Interested',            NULL, NULL),
  ('00000000-0000-4000-c024-00000000000e', 'D24 E',       '+91 90000 11111',   'Meta Ad',   'Contacted',             NULL, NULL),
  ('00000000-0000-4000-c024-00000000000f', 'D24 F',       '9876543210',        'Meta Ad',   'New Lead',              NULL, NULL),
  ('00000000-0000-4000-c024-000000000010', 'D24 G',       '(0) 98765-43210',   'Meta Ad',   'Follow-up Required',    NULL, NULL),
  ('00000000-0000-4000-c024-000000000011', 'D24 H',       '+91 81234 56789',   'Google Ad', 'Interested',            NULL, NULL),
  ('00000000-0000-4000-c024-000000000012', 'D24 Parent',  '+91 98765-43210',   'Referral',  'Interested',            NULL, NULL),
  ('00000000-0000-4000-c024-000000000013', 'D24 Sibling', '098765 43210',      'Meta Ad',   'Awaiting Confirmation', '00000000-0000-4000-b024-000000000001', NULL),
  ('00000000-0000-4000-c024-000000000014', 'D24 D2',      '(+44) 98765-43210', 'Other',     'Interested',            NULL, NULL);

CREATE TEMP TABLE _d24t ON COMMIT DROP AS
SELECT
  (SELECT id FROM public.services WHERE name = 'Individual counselling') AS svc,
  ((date_trunc('day', now() AT TIME ZONE 'Asia/Kolkata') + interval '1 day 08 hours') AT TIME ZONE 'Asia/Kolkata') AS t0;
GRANT SELECT ON _d24t TO authenticated;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T2. Shared phone numbers are allowed
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  f record;
  v jsonb;
  ca public.clients%ROWTYPE;
  ca_json text;
  cd uuid;
  n_x integer;
BEGIN
  SELECT * INTO f FROM _d24t;

  -- T2a: the first client for number X, with the lead's source as referral source.
  v := public.convert_lead_to_appointment('00000000-0000-4000-c024-00000000000a', 'Interested',
         '00000000-0000-4000-b024-000000000001', f.svc, f.t0, 'first');
  SELECT * INTO ca FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a';
  IF ca.id IS NULL OR ca.id <> (v ->> 'client_id')::uuid OR ca.referral_source IS DISTINCT FROM 'Google Ad'
     OR ca.phone_normalized <> '+919876543210' THEN
    RAISE EXCEPTION 'FAIL T2a: first client';
  END IF;
  ca_json := (SELECT (to_jsonb(c) - 'updated_at')::text FROM public.clients AS c WHERE c.id = ca.id);

  -- T2b: a separate client despite the matching number (Day 23 RPC, staff chose "separate profile"): two share X.
  v := public.convert_lead_to_appointment('00000000-0000-4000-c024-000000000012', 'Interested',
         '00000000-0000-4000-b024-000000000002', f.svc, f.t0 + interval '1 hour', NULL);
  IF (SELECT count(*) FROM public.clients WHERE phone_normalized = '+919876543210') <> 2
     OR (SELECT referral_source FROM public.clients WHERE id = (v ->> 'client_id')::uuid) <> 'Referral'
     OR (v ->> 'client_id')::uuid = ca.id THEN
    RAISE EXCEPTION 'FAIL T2b: two clients sharing an Indian number';
  END IF;

  -- T2c: a third client through the ordinary status change (update_lead_with_history): three share X.
  PERFORM public.update_lead_with_history('00000000-0000-4000-c024-000000000013', 'Awaiting Confirmation',
    '{"status":"Confirmed"}'::jsonb, '[{"type":"status","text":"to Confirmed"}]'::jsonb);
  SELECT count(*) INTO n_x FROM public.clients WHERE phone_normalized = '+919876543210';
  IF n_x <> 3 OR NOT EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000013') THEN
    RAISE EXCEPTION 'FAIL T2c: three clients sharing one number (%)', n_x;
  END IF;

  -- T2d: two clients sharing an international number; it stays different from the Indian number.
  PERFORM public.convert_lead_to_appointment('00000000-0000-4000-c024-00000000000d', 'Interested',
            '00000000-0000-4000-b024-000000000002', f.svc, f.t0, NULL);
  PERFORM public.convert_lead_to_appointment('00000000-0000-4000-c024-000000000014', 'Interested',
            '00000000-0000-4000-b024-000000000002', f.svc, f.t0 + interval '3 hours', NULL);
  IF (SELECT count(*) FROM public.clients WHERE phone_normalized = '+449876543210') <> 2
     OR (SELECT count(*) FROM public.clients WHERE phone_normalized = '+919876543210') <> 3 THEN
    RAISE EXCEPTION 'FAIL T2d: international shared number';
  END IF;

  -- T2e: editing a phone to a number other clients use is allowed (then put back).
  cd := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000d');
  PERFORM public.update_client_details(cd, '{"phone":"+91 98765-43210"}'::jsonb);
  IF (SELECT phone_normalized FROM public.clients WHERE id = cd) <> '+919876543210' THEN RAISE EXCEPTION 'FAIL T2e: edit'; END IF;
  PERFORM public.update_client_details(cd, '{"phone":"+44 98765 43210"}'::jsonb);

  -- T2f: nothing was linked, merged or changed automatically; the first client is exactly as it was.
  IF EXISTS (SELECT 1 FROM public.lead_client_links)
     OR (SELECT (to_jsonb(c) - 'updated_at')::text FROM public.clients AS c WHERE c.id = ca.id) <> ca_json
     OR (SELECT count(*) FROM public.clients) <> 5 THEN
    RAISE EXCEPTION 'FAIL T2f: automatic changes after shared-number clients were created';
  END IF;
  RAISE NOTICE 'PASS T2: 2 and 3 clients share an Indian number, 2 share a UK number, separate profiles created, nothing linked or changed automatically';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T3. Linking an enquiry to the client staff chose, when several clients share the number
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  f record;
  v jsonb;
  ca uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a');
  cp uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000012');
  cq uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000013');
  ld public.leads%ROWTYPE;
  appt public.appointments%ROWTYPE;
  v_state text; v_msg text;
  n_clients integer;
  n_ca integer; n_cq integer;
BEGIN
  SELECT * INTO f FROM _d24t;
  SELECT count(*) INTO n_clients FROM public.clients;

  -- T3a: the lookup lists EVERY client with the number (oldest first) and the other enquiries.
  v := public.find_phone_matches('+91 (98765) 43210', '00000000-0000-4000-c024-00000000000b');
  IF v ->> 'normalized' <> '+919876543210' OR jsonb_array_length(v -> 'clients') <> 3
     OR (v -> 'clients' -> 0 ->> 'id')::uuid <> ca OR (v -> 'clients' -> 1 ->> 'id')::uuid <> cp
     OR (v -> 'clients' -> 2 ->> 'id')::uuid <> cq
     OR NOT (v -> 'leads') @> '[{"id":"00000000-0000-4000-c024-00000000000a"},{"id":"00000000-0000-4000-c024-000000000012"}]'::jsonb
     OR (v -> 'leads') @> '[{"id":"00000000-0000-4000-c024-00000000000b"}]'::jsonb
     OR (v -> 'leads') @> '[{"id":"00000000-0000-4000-c024-00000000000d"}]'::jsonb THEN
    RAISE EXCEPTION 'FAIL T3a: %', v;
  END IF;
  IF jsonb_array_length((public.find_phone_matches('(+44) 98765 43210', NULL)) -> 'clients') <> 2 THEN
    RAISE EXCEPTION 'FAIL T3a: international matches';
  END IF;

  -- T3b: staff select the SECOND match (the parent): only that client gets the appointment and the link.
  SELECT count(*) INTO n_ca FROM public.appointments WHERE client_id = ca;
  SELECT count(*) INTO n_cq FROM public.appointments WHERE client_id = cq;
  v := public.convert_lead_to_existing_client('00000000-0000-4000-c024-00000000000b', 'Interested', cp,
         '00000000-0000-4000-b024-000000000002', f.svc, f.t0 + interval '2 hours', 'returning', NULL);
  SELECT * INTO ld FROM public.leads WHERE id = '00000000-0000-4000-c024-00000000000b';
  SELECT * INTO appt FROM public.appointments WHERE id = (v ->> 'appointment_id')::uuid;
  IF NOT (v ->> 'ok')::boolean OR (v ->> 'client_id')::uuid <> cp OR NOT (v ->> 'link_created')::boolean
     OR appt.client_id <> cp OR appt.status <> 'Scheduled'
     OR NOT EXISTS (SELECT 1 FROM public.sessions WHERE appointment_id = appt.id AND client_id = cp) THEN
    RAISE EXCEPTION 'FAIL T3b: appointment not on the chosen client';
  END IF;
  IF (SELECT count(*) FROM public.appointments WHERE client_id = ca) <> n_ca
     OR (SELECT count(*) FROM public.appointments WHERE client_id = cq) <> n_cq
     OR (SELECT count(*) FROM public.clients) <> n_clients
     OR EXISTS (SELECT 1 FROM public.clients WHERE lead_id = ld.id) THEN
    RAISE EXCEPTION 'FAIL T3b: other matching clients touched or a client created';
  END IF;
  IF ld.status <> 'Confirmed' OR ld.next_follow_up_at IS NOT NULL OR ld.source <> 'Meta Ad' OR ld.phone <> '98765 43210'
     OR (SELECT client_id FROM public.lead_client_links WHERE lead_id = ld.id) <> cp
     OR (SELECT match_basis FROM public.lead_client_links WHERE lead_id = ld.id) <> 'phone'
     OR (SELECT referral_source FROM public.clients WHERE id = cp) <> 'Referral' THEN
    RAISE EXCEPTION 'FAIL T3b: lead / link / referral source';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = ld.id AND notes LIKE 'Linked to existing client D24 Parent%same phone number%')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = ld.id AND activity_type = 'Status change' AND notes LIKE 'Status changed from Interested to Confirmed%')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = ld.id AND activity_type = 'Follow-up' AND notes LIKE 'Follow up cleared on conversion%')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = ld.id AND notes LIKE 'Appointment booked for existing client D24 Parent%') THEN
    RAISE EXCEPTION 'FAIL T3b: enquiry history incomplete';
  END IF;

  -- T3c: a repeated conversion is refused.
  BEGIN
    PERFORM public.convert_lead_to_existing_client(ld.id, 'Interested', cp, '00000000-0000-4000-b024-000000000002',
              f.svc, f.t0 + interval '4 hours', NULL, NULL);
    RAISE EXCEPTION 'FAIL T3c: accepted twice';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T3c: %', v_state; END IF;
  END;

  -- T3d: a manual link (phones differ) needs a note; idempotent for the same client.
  BEGIN
    PERFORM public.link_lead_to_client('00000000-0000-4000-c024-00000000000e', ca, NULL);
    RAISE EXCEPTION 'FAIL T3d: manual link without note accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> '22023' THEN RAISE EXCEPTION 'FAIL T3d: %', v_state; END IF;
  END;
  v := public.link_lead_to_client('00000000-0000-4000-c024-00000000000e', ca, 'Parent enquiring for the client');
  IF v -> 'link' ->> 'match_basis' <> 'manual' OR NOT (v ->> 'created')::boolean THEN RAISE EXCEPTION 'FAIL T3d: %', v; END IF;
  v := public.link_lead_to_client('00000000-0000-4000-c024-00000000000e', ca, 'again');
  IF (v ->> 'created')::boolean THEN RAISE EXCEPTION 'FAIL T3d: not idempotent'; END IF;

  -- T3e: unlink before Confirmed (with history); a Confirmed lead cannot be unlinked.
  PERFORM public.unlink_lead_from_client('00000000-0000-4000-c024-00000000000e', 'Linked by mistake');
  IF EXISTS (SELECT 1 FROM public.lead_client_links WHERE lead_id = '00000000-0000-4000-c024-00000000000e')
     OR NOT EXISTS (SELECT 1 FROM public.lead_activities WHERE lead_id = '00000000-0000-4000-c024-00000000000e' AND notes LIKE 'Link to client % removed: Linked by mistake') THEN
    RAISE EXCEPTION 'FAIL T3e: unlink';
  END IF;
  BEGIN
    PERFORM public.unlink_lead_from_client(ld.id, 'try');
    RAISE EXCEPTION 'FAIL T3e: Confirmed lead unlinked';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T3e: %', v_state; END IF;
  END;

  -- T3f: a client's own lead cannot be linked anywhere.
  BEGIN
    PERFORM public.link_lead_to_client('00000000-0000-4000-c024-00000000000a', cp, 'self');
    RAISE EXCEPTION 'FAIL T3f: accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T3f: %', v_state; END IF;
  END;

  -- T3g: linking to the THIRD match; then the ordinary status change to Confirmed creates no client.
  PERFORM public.link_lead_to_client('00000000-0000-4000-c024-000000000010', cq, NULL);
  PERFORM public.update_lead_with_history('00000000-0000-4000-c024-000000000010', 'Follow-up Required',
    '{"status":"Confirmed","assigned_psychologist_id":"00000000-0000-4000-b024-000000000001"}'::jsonb,
    '[{"type":"status","text":"to Confirmed"}]'::jsonb);
  IF (SELECT client_id FROM public.lead_client_links WHERE lead_id = '00000000-0000-4000-c024-000000000010') <> cq
     OR (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c024-000000000010') <> 'Confirmed'
     OR EXISTS (SELECT 1 FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000010')
     OR (SELECT count(*) FROM public.clients) <> n_clients THEN
    RAISE EXCEPTION 'FAIL T3g: linked manual confirmation';
  END IF;

  -- T3h: the Day 23 RPC on a linked lead fails safely (nothing saved); the Day 24 RPC then converts it.
  PERFORM public.link_lead_to_client('00000000-0000-4000-c024-00000000000c', ca, NULL);
  BEGIN
    PERFORM public.convert_lead_to_appointment('00000000-0000-4000-c024-00000000000c', 'Awaiting Confirmation',
              '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '5 hours', NULL);
    RAISE EXCEPTION 'FAIL T3h: Day 23 RPC created something for a linked lead';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T3h: %', v_state; END IF;
  END;
  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c024-00000000000c') <> 'Awaiting Confirmation'
     OR EXISTS (SELECT 1 FROM public.appointments WHERE starts_at = f.t0 + interval '5 hours') THEN
    RAISE EXCEPTION 'FAIL T3h: Day 23 RPC left changes behind';
  END IF;
  v := public.convert_lead_to_existing_client('00000000-0000-4000-c024-00000000000c', 'Awaiting Confirmation', ca,
         '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '5 hours', NULL, NULL);
  IF (v ->> 'link_created')::boolean OR (v ->> 'client_id')::uuid <> ca THEN RAISE EXCEPTION 'FAIL T3h: %', v; END IF;

  -- T3i: the Day 21 transition rules still apply and nothing is kept, not even the link.
  BEGIN
    PERFORM public.convert_lead_to_existing_client('00000000-0000-4000-c024-00000000000f', 'New Lead', ca,
              '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '6 hours', NULL, NULL);
    RAISE EXCEPTION 'FAIL T3i: New Lead converted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' OR v_msg NOT LIKE 'A lead cannot move from New Lead to Confirmed%' THEN RAISE EXCEPTION 'FAIL T3i: % %', v_state, v_msg; END IF;
  END;
  IF EXISTS (SELECT 1 FROM public.lead_client_links WHERE lead_id = '00000000-0000-4000-c024-00000000000f')
     OR (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c024-00000000000f') <> 'New Lead' THEN
    RAISE EXCEPTION 'FAIL T3i: partial changes kept';
  END IF;
  RAISE NOTICE 'PASS T3: every matching client listed; the chosen one gets the appointment and link, the others are untouched; atomic';
END
$$;

-- T3k: permissions (psychologist and non-member cannot link, convert, look up or record).
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000002","role":"authenticated"}', true);
DO $$
DECLARE
  v_state text;
  i integer;
BEGIN
  FOR i IN 1..2 LOOP
    IF i = 2 THEN
      PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000003","role":"authenticated"}', true);
    END IF;
    BEGIN
      PERFORM public.link_lead_to_client('00000000-0000-4000-c024-00000000000e', (SELECT id FROM public.clients LIMIT 1), 'x');
      RAISE EXCEPTION 'FAIL T3k: link allowed (%)', i;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T3k: link % (%)', v_state, i; END IF;
    END;
    BEGIN
      PERFORM public.find_phone_matches('9876543210', NULL);
      RAISE EXCEPTION 'FAIL T3k: lookup allowed (%)', i;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T3k: lookup % (%)', v_state, i; END IF;
    END;
    BEGIN
      PERFORM public.convert_lead_to_existing_client('00000000-0000-4000-c024-000000000011', 'Interested',
        '00000000-0000-4000-c024-00000000000a', '00000000-0000-4000-b024-000000000001',
        (SELECT svc FROM _d24t), (SELECT t0 FROM _d24t) + interval '7 hours', NULL, NULL);
      RAISE EXCEPTION 'FAIL T3k: convert allowed (%)', i;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T3k: convert % (%)', v_state, i; END IF;
    END;
    BEGIN
      PERFORM public.record_communication('00000000-0000-4000-c024-00000000000e', NULL, 'Call', 'Call Completed', NULL, NULL);
      RAISE EXCEPTION 'FAIL T3k: record allowed (%)', i;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
      IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T3k: record % (%)', v_state, i; END IF;
    END;
    IF EXISTS (SELECT 1 FROM public.lead_client_links) THEN
      RAISE EXCEPTION 'FAIL T3k: links readable by a non-staff user (%)', i;
    END IF;
  END LOOP;
  RAISE NOTICE 'PASS T3k: psychologists and non-members cannot link, convert, look up or record communication';
END
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T4. Client management (past appointments are seeded as the owner: booking only allows future times)
   --------------------------------------------------------------------------------------------- */
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  ca uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a');
  ap uuid;
  r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('Completed', 5, 'Completed'), ('Missed', 3, 'Missed'), ('Cancelled', 2, 'Cancelled'), ('Rescheduled', 1, 'Cancelled')
  ) AS v(appt_status, days_ago, session_status) LOOP
    INSERT INTO public.appointments (client_id, psychologist_id, service_type, starts_at, ends_at, status)
    VALUES (ca, '00000000-0000-4000-b024-000000000001', 'Individual counselling',
            now() - make_interval(days => r.days_ago), now() - make_interval(days => r.days_ago) + interval '50 minutes', r.appt_status)
    RETURNING id INTO ap;
    INSERT INTO public.sessions (appointment_id, client_id, psychologist_id, starts_at, ends_at, status)
    VALUES (ap, ca, '00000000-0000-4000-b024-000000000001', now() - make_interval(days => r.days_ago),
            now() - make_interval(days => r.days_ago) + interval '50 minutes', r.session_status);
  END LOOP;
END
$$;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);

DO $$
DECLARE
  f record;
  ca public.clients%ROWTYPE;
  cd public.clients%ROWTYPE;
  dir record;
  n_appts integer; n_sessions integer;
  v_state text; v_msg text;
  a record;
BEGIN
  SELECT * INTO f FROM _d24t;
  SELECT * INTO ca FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a';
  SELECT * INTO cd FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000d';

  -- T4a: totals and dates. Only the Completed session counts; Cancelled / Rescheduled are not the last appointment.
  SELECT * INTO dir FROM public.client_directory WHERE id = ca.id;
  IF dir.total_sessions <> 1 THEN RAISE EXCEPTION 'FAIL T4a: total_sessions %', dir.total_sessions; END IF;
  IF dir.last_appointment_status <> 'Missed' OR dir.last_appointment_at::date <> (now() - interval '3 days')::date THEN
    RAISE EXCEPTION 'FAIL T4a: last appointment % %', dir.last_appointment_status, dir.last_appointment_at;
  END IF;
  IF dir.next_appointment_at <> f.t0 OR dir.next_appointment_status <> 'Scheduled' THEN
    RAISE EXCEPTION 'FAIL T4a: next appointment % %', dir.next_appointment_at, dir.next_appointment_status;
  END IF;
  IF dir.referral_source <> 'Google Ad' OR dir.psychologist_name <> 'D24 Psychologist One' OR dir.linked_enquiries <> 1
     OR dir.original_lead_code IS NULL THEN
    RAISE EXCEPTION 'FAIL T4a: directory fields % % % %', dir.referral_source, dir.psychologist_name, dir.linked_enquiries, dir.original_lead_code;
  END IF;

  -- T4b: deactivation is refused while open bookings exist, and needs a reason.
  BEGIN
    PERFORM public.set_client_active(ca.id, false, 'Moved abroad');
    RAISE EXCEPTION 'FAIL T4b: deactivated with open appointments';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' OR v_msg NOT LIKE 'This client still has 2 open appointment(s)%' THEN RAISE EXCEPTION 'FAIL T4b: % %', v_state, v_msg; END IF;
  END;
  BEGIN
    PERFORM public.set_client_active(ca.id, false, '');
    RAISE EXCEPTION 'FAIL T4b: no reason accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> '22023' THEN RAISE EXCEPTION 'FAIL T4b: %', v_state; END IF;
  END;

  -- T4c: after cancelling, deactivation keeps every appointment and session and is recorded with the reason.
  FOR a IN SELECT id FROM public.appointments WHERE client_id = ca.id AND status IN ('Scheduled', 'Confirmed') AND starts_at > now() LOOP
    PERFORM public.cancel_appointment(a.id, 'Client moving');
  END LOOP;
  SELECT count(*) INTO n_appts FROM public.appointments WHERE client_id = ca.id;
  SELECT count(*) INTO n_sessions FROM public.sessions WHERE client_id = ca.id;
  PERFORM public.set_client_active(ca.id, false, 'Moved abroad');
  IF (SELECT is_active FROM public.clients WHERE id = ca.id)
     OR (SELECT count(*) FROM public.appointments WHERE client_id = ca.id) <> n_appts
     OR (SELECT count(*) FROM public.sessions WHERE client_id = ca.id) <> n_sessions
     OR (SELECT total_sessions FROM public.client_directory WHERE id = ca.id) <> 1 THEN
    RAISE EXCEPTION 'FAIL T4c: deactivation lost history';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client' AND entity_id = ca.id
                 AND action = 'Client marked inactive' AND actor = '00000000-0000-4000-a024-000000000001'
                 AND details ->> 'reason' = 'Moved abroad' AND details -> 'changes' -> 'is_active' ->> 'to' = 'false'
                 AND psychologist_id IS NULL AND client_id = ca.id) THEN
    RAISE EXCEPTION 'FAIL T4c: deactivation not in activity_log as expected';
  END IF;

  -- T4d: an inactive client cannot be booked or receive a converted enquiry; reactivation is recorded.
  BEGIN
    PERFORM public.book_appointment(ca.id, '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '9 hours', NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL T4d: booked an inactive client';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T4d: %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.convert_lead_to_existing_client('00000000-0000-4000-c024-00000000000f', 'New Lead', ca.id,
              '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '9 hours', NULL, NULL);
    RAISE EXCEPTION 'FAIL T4d: converted into an inactive client';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_msg NOT LIKE 'This client is inactive%' THEN RAISE EXCEPTION 'FAIL T4d: %', v_msg; END IF;
  END;
  PERFORM public.set_client_active(ca.id, true, 'Back in town');
  IF NOT (SELECT is_active FROM public.clients WHERE id = ca.id)
     OR NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_id = ca.id AND action = 'Client reactivated') THEN
    RAISE EXCEPTION 'FAIL T4d: reactivation';
  END IF;

  -- T4e: editing details is audited with old and new values; referral source can be corrected explicitly.
  SELECT * INTO cd FROM public.clients WHERE id = cd.id;
  PERFORM public.update_client_details(cd.id,
    '{"full_name":"D24 D Renamed","email":"d24@example.com","referral_source":"Doctor referral","city":""}'::jsonb, cd.updated_at);
  SELECT * INTO cd FROM public.clients WHERE id = cd.id;
  IF cd.full_name <> 'D24 D Renamed' OR cd.email <> 'd24@example.com' OR cd.referral_source <> 'Doctor referral' OR cd.city IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T4e: details not saved';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_id = cd.id AND action = 'Client details updated'
                 AND details -> 'changes' -> 'referral_source' ->> 'from' = 'Other'
                 AND details -> 'changes' -> 'referral_source' ->> 'to' = 'Doctor referral'
                 AND details -> 'changes' ? 'full_name' AND NOT details -> 'changes' ? 'phone') THEN
    RAISE EXCEPTION 'FAIL T4e: audit row';
  END IF;

  -- T4f: validation and stale saves.
  FOR a IN SELECT * FROM (VALUES
    ('{"email":"not-an-email"}', '22023'), ('{"full_name":" "}', '22023'), ('{"is_active":"false"}', '22023'),
    ('{"phone":"123"}', '22023'), ('{"lead_id":"00000000-0000-4000-c024-00000000000a"}', '22023')
  ) AS v(changes, code) LOOP
    BEGIN
      PERFORM public.update_client_details(cd.id, a.changes::jsonb);
      RAISE EXCEPTION 'FAIL T4f: % accepted', a.changes;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
      IF v_state <> a.code THEN RAISE EXCEPTION 'FAIL T4f: % -> %', a.changes, v_state; END IF;
    END;
  END LOOP;
  BEGIN
    PERFORM public.update_client_details(cd.id, '{"city":"Kochi"}'::jsonb, cd.updated_at - interval '1 minute');
    RAISE EXCEPTION 'FAIL T4f: stale save accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'This client was changed elsewhere%' THEN RAISE EXCEPTION 'FAIL T4f: %', v_msg; END IF;
  END;

  -- T4g: the referral source is not writable directly (only through the function).
  BEGIN
    UPDATE public.clients SET referral_source = 'hack' WHERE id = cd.id;
    RAISE EXCEPTION 'FAIL T4g: direct referral_source update allowed';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RAISE NOTICE 'PASS T4: directory totals/dates, Active/Inactive with guard and history, audited edits, validation';
END
$$;

-- T4h: psychologist scope: own clients only (no unrelated clients that share a number), no management functions.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000002","role":"authenticated"}', true);
DO $$
DECLARE
  v_state text;
BEGIN
  IF (SELECT string_agg(full_name, ',' ORDER BY full_name) FROM public.client_directory) IS DISTINCT FROM 'D24 A,D24 Sibling' THEN
    RAISE EXCEPTION 'FAIL T4h: psychologist one sees %', (SELECT string_agg(full_name, ',' ORDER BY full_name) FROM public.client_directory);
  END IF;
  IF EXISTS (SELECT 1 FROM public.clients WHERE full_name IN ('D24 Parent', 'D24 D Renamed', 'D24 D2')) THEN
    RAISE EXCEPTION 'FAIL T4h: psychologist reads unrelated clients';
  END IF;
  BEGIN
    PERFORM public.update_client_details((SELECT id FROM public.clients WHERE full_name = 'D24 A'), '{"city":"x"}'::jsonb);
    RAISE EXCEPTION 'FAIL T4h: edit allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T4h: edit %', v_state; END IF;
  END;
  BEGIN
    PERFORM public.set_client_active((SELECT id FROM public.clients WHERE full_name = 'D24 A'), false, 'x x x');
    RAISE EXCEPTION 'FAIL T4h: status change allowed';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '42501' THEN RAISE EXCEPTION 'FAIL T4h: status %', v_state; END IF;
  END;
  RAISE NOTICE 'PASS T4h: psychologist scope (own clients only, even when numbers are shared)';
END
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T5. Communication tracking
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  ca uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a');
  e1 public.communication_events%ROWTYPE;
  e2 public.communication_events%ROWTYPE;
  e3 public.communication_events%ROWTYPE;
  lead_status text := (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c024-00000000000e');
  appt_statuses text := (SELECT string_agg(status, ',' ORDER BY id) FROM public.appointments WHERE client_id = ca);
  v_state text; v_msg text;
  a record;
BEGIN
  e1 := public.record_communication('00000000-0000-4000-c024-00000000000e', NULL, 'WhatsApp', 'Message Sent', 'Sent intro message', NULL);
  e2 := public.record_communication('00000000-0000-4000-c024-00000000000e', NULL, 'WhatsApp', 'Client Will Inform', ' Will reply after talking to family ', now() + interval '1 minute');
  IF e1.recorded_by <> '00000000-0000-4000-a024-000000000001' OR e1.recorded_by_name IS NULL OR e1.occurred_at IS NULL
     OR e1.previous_status IS NOT NULL OR e1.lead_id IS NULL OR e1.client_id IS NOT NULL THEN
    RAISE EXCEPTION 'FAIL T5a: first lead event %', to_jsonb(e1);
  END IF;
  IF e2.previous_status <> 'Message Sent' OR e2.notes <> 'Will reply after talking to family' THEN
    RAISE EXCEPTION 'FAIL T5a: trail %', to_jsonb(e2);
  END IF;
  e3 := public.record_communication(NULL, ca, 'Reminder', 'Reminder Pending', NULL, NULL);
  e3 := public.record_communication(NULL, ca, 'Call', 'Call Completed', 'Confirmed next week', now() - interval '1 hour');
  IF e3.client_id <> ca OR e3.previous_status <> 'Reminder Pending' OR e3.occurred_at > now() - interval '59 minutes' THEN
    RAISE EXCEPTION 'FAIL T5b: client event %', to_jsonb(e3);
  END IF;
  IF (SELECT count(*) FROM public.communication_events WHERE client_id = ca) <> 2
     OR (SELECT count(*) FROM public.communication_events WHERE lead_id = '00000000-0000-4000-c024-00000000000e') <> 2 THEN
    RAISE EXCEPTION 'FAIL T5b: history is not kept';
  END IF;

  FOR a IN SELECT * FROM (VALUES
    ('WhatsApp', 'Call Completed', 0), ('Call', 'Message Sent', 0), ('In person', 'Message Sent', 0),
    ('Fax', 'Message Sent', 0), ('Call', 'Sent', 0), ('Call', 'No Response', 1), ('Call', 'No Response', 2), ('Call', 'No Response', 3)
  ) AS v(channel, status, variant) LOOP
    BEGIN
      IF a.variant = 1 THEN
        PERFORM public.record_communication('00000000-0000-4000-c024-00000000000e', ca, a.channel, a.status, NULL, NULL);
      ELSIF a.variant = 2 THEN
        PERFORM public.record_communication('00000000-0000-4000-c024-00000000000e', NULL, a.channel, a.status, NULL, now() + interval '1 hour');
      ELSIF a.variant = 3 THEN
        PERFORM public.record_communication(NULL, ca, a.channel, a.status, repeat('x', 1001), NULL);
      ELSE
        PERFORM public.record_communication('00000000-0000-4000-c024-00000000000e', NULL, a.channel, a.status, NULL, NULL);
      END IF;
      RAISE EXCEPTION 'FAIL T5c: % / % (%) accepted', a.channel, a.status, a.variant;
    EXCEPTION WHEN OTHERS THEN
      GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
      IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
      IF v_state <> '22023' THEN RAISE EXCEPTION 'FAIL T5c: % / % -> %', a.channel, a.status, v_state; END IF;
    END;
  END LOOP;

  IF (SELECT status FROM public.leads WHERE id = '00000000-0000-4000-c024-00000000000e') <> lead_status
     OR (SELECT string_agg(status, ',' ORDER BY id) FROM public.appointments WHERE client_id = ca) <> appt_statuses
     OR NOT (SELECT is_active FROM public.clients WHERE id = ca) THEN
    RAISE EXCEPTION 'FAIL T5d: communication changed another status';
  END IF;
  IF (SELECT count(*) FROM public.communication_events WHERE communication_status = 'Message Sent') <> 1 THEN
    RAISE EXCEPTION 'FAIL T5e: unexpected Message Sent rows';
  END IF;
  RAISE NOTICE 'PASS T5: lead and client communication history, staff and time recorded, rules, statuses separate';
END
$$;

-- T5f: psychologists and non-members cannot read communication history.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000002","role":"authenticated"}', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.communication_events) THEN RAISE EXCEPTION 'FAIL T5f: psychologist reads communication'; END IF;
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000003","role":"authenticated"}', true);
  IF EXISTS (SELECT 1 FROM public.communication_events) OR EXISTS (SELECT 1 FROM public.client_directory) THEN
    RAISE EXCEPTION 'FAIL T5f: non-member reads communication or clients';
  END IF;
  RAISE NOTICE 'PASS T5f: communication history is staff-only';
END
$$;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);

/* ---------------------------------------------------------------------------------------------
   T6. Regression: booking, rescheduling, Day 21 rules, Day 23 conversion
   --------------------------------------------------------------------------------------------- */
DO $$
DECLARE
  f record;
  ca uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000a');
  booked public.appointments%ROWTYPE;
  moved public.appointments%ROWTYPE;
  v_state text;
BEGIN
  SELECT * INTO f FROM _d24t;
  booked := public.book_appointment(ca, '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '10 hours', NULL, NULL, NULL);
  moved := public.reschedule_appointment(booked.id, f.t0 + interval '1 day 2 hours', NULL, 'Client asked');
  IF (SELECT status FROM public.appointments WHERE id = booked.id) <> 'Rescheduled' OR moved.status <> 'Scheduled'
     OR moved.rescheduled_from_id <> booked.id OR moved.client_id <> ca THEN
    RAISE EXCEPTION 'FAIL T6a: booking / rescheduling';
  END IF;
  BEGIN
    PERFORM public.book_appointment(ca, '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '1 day 2 hours', NULL, NULL, NULL);
    RAISE EXCEPTION 'FAIL T6b: double booking accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> '23P01' THEN RAISE EXCEPTION 'FAIL T6b: %', v_state; END IF;
  END;
  BEGIN
    UPDATE public.leads SET status = 'Confirmed', assigned_psychologist_id = '00000000-0000-4000-b024-000000000001'
    WHERE id = '00000000-0000-4000-c024-00000000000f';
    RAISE EXCEPTION 'FAIL T6c: New Lead -> Confirmed accepted';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
    IF v_state <> 'P0001' THEN RAISE EXCEPTION 'FAIL T6c: %', v_state; END IF;
  END;
  PERFORM public.convert_lead_to_appointment('00000000-0000-4000-c024-000000000011', 'Interested',
            '00000000-0000-4000-b024-000000000001', f.svc, f.t0 + interval '11 hours', NULL);
  IF (SELECT referral_source FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000011') <> 'Google Ad' THEN
    RAISE EXCEPTION 'FAIL T6d: Day 23 conversion';
  END IF;
  RAISE NOTICE 'PASS T6: booking, rescheduling, double-booking protection, Day 21 rules and Day 23 conversion unchanged';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T7. As the table owner (no RLS, no grants in the way)
   --------------------------------------------------------------------------------------------- */
RESET ROLE;
SELECT set_config('request.jwt.claims', '', true);
DO $$
DECLARE
  v_writers text;
  v_id uuid;
BEGIN
  -- A shared number is allowed at the lowest level too (no unique rule anywhere).
  INSERT INTO public.clients (lead_id, full_name, phone, primary_psychologist_id)
  VALUES ('00000000-0000-4000-c024-00000000000f', 'Direct insert', '0091 98765 43210', '00000000-0000-4000-b024-000000000001')
  RETURNING id INTO v_id;
  IF (SELECT count(*) FROM public.clients WHERE phone_normalized = '+919876543210') <> 4 THEN
    RAISE EXCEPTION 'FAIL T7a: shared-number insert';
  END IF;
  BEGIN
    UPDATE public.communication_events SET communication_status = 'No Response';
    RAISE EXCEPTION 'FAIL T7b: update allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.communication_events;
    RAISE EXCEPTION 'FAIL T7b: delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT string_agg(p.proname, ',' ORDER BY p.proname) INTO v_writers
  FROM pg_proc AS p WHERE p.pronamespace = 'public'::regnamespace
    AND p.prosrc ~* 'insert\s+into\s+public\.communication_events';
  IF v_writers IS DISTINCT FROM 'record_communication' THEN
    RAISE EXCEPTION 'FAIL T7c: functions writing communication_events: %', v_writers;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger AS t WHERE t.tgrelid = 'public.communication_events'::regclass AND NOT t.tgisinternal
             AND t.tgname <> 'communication_events_append_only') THEN
    RAISE EXCEPTION 'FAIL T7c: unexpected trigger on communication_events';
  END IF;
  -- Remove the fixture row again (it has no appointments or audit rows) so later sections see the same clients.
  DELETE FROM public.clients WHERE id = v_id;
  RAISE NOTICE 'PASS T7: shared number allowed at table level, history is append-only, one writer';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T8. Deactivation guard counts past appointments still awaiting attendance (client of lead H)
   --------------------------------------------------------------------------------------------- */
INSERT INTO public.appointments (id, client_id, psychologist_id, service_type, starts_at, ends_at, status)
SELECT '00000000-0000-4000-d024-000000000001', c.id, '00000000-0000-4000-b024-000000000001', 'Individual counselling',
       now() - interval '2 days', now() - interval '2 days' + interval '50 minutes', 'Scheduled'
FROM public.clients AS c WHERE c.lead_id = '00000000-0000-4000-c024-000000000011';
INSERT INTO public.sessions (appointment_id, client_id, psychologist_id, starts_at, ends_at, status)
SELECT a.id, a.client_id, a.psychologist_id, a.starts_at, a.ends_at, 'Scheduled'
FROM public.appointments AS a WHERE a.id = '00000000-0000-4000-d024-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  ch uuid := (SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-000000000011');
  a record;
  v_state text; v_msg text;
BEGIN
  FOR a IN SELECT id FROM public.appointments WHERE client_id = ch AND status IN ('Scheduled', 'Confirmed') AND starts_at > now() LOOP
    PERFORM public.cancel_appointment(a.id, 'T8');
  END LOOP;
  BEGIN
    PERFORM public.set_client_active(ch, false, 'T8 inactive');
    RAISE EXCEPTION 'FAIL T8: deactivated with a past appointment awaiting attendance';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE, v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
    IF v_state <> 'P0001' OR v_msg NOT LIKE 'This client still has 1 open appointment(s)%' THEN
      RAISE EXCEPTION 'FAIL T8: % %', v_state, v_msg;
    END IF;
  END;
  IF NOT (SELECT is_active FROM public.clients WHERE id = ch) THEN RAISE EXCEPTION 'FAIL T8: status changed on refusal'; END IF;

  PERFORM public.record_attendance('00000000-0000-4000-d024-000000000001', true, 'T8 attended');
  PERFORM public.set_client_active(ch, false, 'T8 inactive');
  IF (SELECT is_active FROM public.clients WHERE id = ch)
     OR EXISTS (SELECT 1 FROM public.appointments WHERE client_id = ch AND status IN ('Scheduled', 'Confirmed')) THEN
    RAISE EXCEPTION 'FAIL T8: inactive client still has an active appointment';
  END IF;
  BEGIN
    PERFORM public.reschedule_appointment('00000000-0000-4000-d024-000000000001', now() + interval '3 days', NULL, 'T8');
    RAISE EXCEPTION 'FAIL T8: completed appointment of an inactive client rescheduled';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg LIKE 'FAIL%' THEN RAISE; END IF;
  END;
  RAISE NOTICE 'PASS T8: past appointments awaiting attendance block deactivation; an inactive client has nothing to reschedule';
END
$$;

/* ---------------------------------------------------------------------------------------------
   T9. Client audit records: psychologist read access, no writes, no unrelated clients
   Audit rows so far: client A (psychologist one; deactivated + reactivated with reasons), client D (psychologist
   two; edited), client H (psychologist one; deactivated in T8).
   --------------------------------------------------------------------------------------------- */
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000002","role":"authenticated"}', true);
DO $$
DECLARE
  ca uuid;
  n integer;
BEGIN
  SELECT id INTO ca FROM public.clients WHERE full_name = 'D24 A';
  -- T9a: psychologist one reads the audit of their own clients, including the deactivation reason.
  IF ca IS NULL
     OR NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client' AND entity_id = ca
                    AND action = 'Client marked inactive' AND details ->> 'reason' = 'Moved abroad')
     OR NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client' AND entity_id = ca AND action = 'Client reactivated')
     OR NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client' AND details ->> 'reason' = 'T8 inactive') THEN
    RAISE EXCEPTION 'FAIL T9a: psychologist cannot read their clients'' audit';
  END IF;
  -- T9b: never the audit of an unrelated client (D belongs to psychologist two and was never booked with one).
  SELECT count(*) INTO n FROM public.activity_log AS l
  WHERE l.entity_type = 'client' AND l.client_id NOT IN (SELECT id FROM public.clients);
  IF n <> 0 OR EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client'
                       AND details -> 'changes' -> 'full_name' ->> 'to' = 'D24 D Renamed') THEN
    RAISE EXCEPTION 'FAIL T9b: psychologist reads an unrelated client''s audit (%)', n;
  END IF;
  -- T9c: no INSERT, UPDATE or DELETE on the audit.
  BEGIN
    UPDATE public.activity_log SET action = 'tampered' WHERE entity_type = 'client';
    RAISE EXCEPTION 'FAIL T9c: update allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM public.activity_log WHERE entity_type = 'client';
    RAISE EXCEPTION 'FAIL T9c: delete allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO public.activity_log (entity_type, entity_id, action, client_id) VALUES ('client', ca, 'forged', ca);
    RAISE EXCEPTION 'FAIL T9c: insert allowed';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  -- T9d: no staff-only data opened up: communication history, enquiry links and leads stay hidden.
  IF EXISTS (SELECT 1 FROM public.communication_events) OR EXISTS (SELECT 1 FROM public.lead_client_links)
     OR EXISTS (SELECT 1 FROM public.leads) THEN
    RAISE EXCEPTION 'FAIL T9d: psychologist reads staff-only data';
  END IF;

  -- T9e: psychologist two reads D's audit, not A's.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000004","role":"authenticated"}', true);
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client'
                 AND details -> 'changes' -> 'full_name' ->> 'to' = 'D24 D Renamed')
     OR EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client' AND details ->> 'reason' = 'Moved abroad') THEN
    RAISE EXCEPTION 'FAIL T9e: psychologist two audit scope';
  END IF;
  -- T9f: a signed-in non-member reads nothing.
  PERFORM set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000003","role":"authenticated"}', true);
  IF EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client') THEN
    RAISE EXCEPTION 'FAIL T9f: non-member reads client audit';
  END IF;
END
$$;

-- T9g: access follows the client at read time: after staff reassign D to psychologist one, one reads D's audit.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000001","role":"authenticated"}', true);
SELECT public.assign_client_psychologist((SELECT id FROM public.clients WHERE lead_id = '00000000-0000-4000-c024-00000000000d'),
                                         '00000000-0000-4000-b024-000000000001');
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-4000-a024-000000000002","role":"authenticated"}', true);
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.activity_log WHERE entity_type = 'client'
                 AND details -> 'changes' -> 'full_name' ->> 'to' = 'D24 D Renamed') THEN
    RAISE EXCEPTION 'FAIL T9g: reassignment did not grant the audit';
  END IF;
  RAISE NOTICE 'PASS T9: psychologists read the audit (incl. deactivation reasons) of clients they may read, never unrelated ones; no writes; access follows reassignment';
END
$$;
RESET ROLE;

ROLLBACK;
