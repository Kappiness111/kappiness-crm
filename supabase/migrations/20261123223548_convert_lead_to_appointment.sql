-- Kappiness CRM (Day 23): convert an eligible lead into a booked appointment in one transaction.
-- Owner: Aswathy (backend / database).
--
-- WHY
--   Converting a lead used to take three separate saves (assign a psychologist, set Confirmed, then book). Each
--   one committed on its own, so a failure half way left a Confirmed lead with no appointment, or a client with no
--   first session. This adds one RPC that does the whole conversion atomically.
--
-- WHAT THIS ADDS (nothing existing is changed or replaced)
--   public.convert_lead_to_appointment(
--     p_lead_id uuid, p_expected_status text, p_psychologist_id uuid, p_service_id uuid,
--     p_starts_at timestamptz, p_notes text DEFAULT NULL
--   ) RETURNS jsonb  -- { ok, lead, client_id, appointment_id, session_id }
--
-- HOW IT WORKS (one function call = one transaction; any error rolls back every step below)
--   1. The caller must be signed in and active CRM staff (is_crm_staff(), crm_staff_members membership).
--   2. The lead row is locked (FOR UPDATE). Its status must still be p_expected_status (stale screens are refused),
--      it must not already be Confirmed, and it must not already have a client profile (whatever that client's
--      appointments). Together with the lock, this makes a repeated or concurrent conversion fail instead of creating
--      a second client/appointment, and it means the client is always created inside this transaction, where no
--      ordinary booking can reach it before commit.
--   3. public.update_lead_with_history (Day 21, unchanged) sets status = Confirmed (and the psychologist, if it
--      changes), clears next_follow_up_at (the lead now has a booked appointment instead), and writes the
--      'Status change' (and 'Lead update' / 'Follow-up') rows to lead_activities. The 'Follow-up' row records the
--      cleared date, so it stays auditable. All of this is one UPDATE plus its history rows. Its UPDATE fires:
--        - enforce_lead_workflow (unchanged): the Day 21 transition matrix (only Interested, Follow-up Required and
--          Awaiting Confirmation may move to Confirmed; New Lead / Contacted are refused; final statuses are final),
--          staff-only status and assignment changes, and an ACTIVE assigned psychologist;
--        - leads_sync_client / sync_client_from_lead (unchanged): creates the lead's one client profile
--          (clients.lead_id is UNIQUE), copying the contact fields from the lead. The trigger could also re-link an
--          existing client, but step 2 refuses that case, so here it always creates a new one.
--      The transition matrix is deliberately NOT repeated here: the trigger stays the single authority.
--   4. public.book_appointment (unchanged) books the first appointment for that client: future time, working
--      hours, blocked periods, no overlap (EXCLUDE constraint), follow-up holds, active service and psychologist.
--      It also creates the session, the appointment status history row and the 'Appointment booked' lead activity.
--   5. Returns the saved lead and the client, appointment and session ids.
--
-- CLIENT ID: the client's identifier is clients.id (uuid), as in the existing design; the app already routes
--   client profiles by it (/clients/<id>). No new identifier column is added. The lead keeps its lead_code.
--
-- PRESERVED: every lead enquiry/contact column (name, phone, email, source, contact method, service interest,
--   notes, staff, lead_code, created_at) is left exactly as it is: only status, assigned_psychologist_id,
--   next_follow_up_at (cleared to NULL; the previous value is kept in the 'Follow-up' history row) and updated_at
--   change. The lead row and all of its history stay; the client is a copy linked through clients.lead_id.
--
-- NOT CHANGED: the manual status change to Confirmed (without booking) still works exactly as before; it does not
--   clear the follow-up date. Only this conversion RPC does.
--
-- SECURITY: SECURITY INVOKER, search_path = public. It runs with the caller's own rights: the restrictive staff
--   policies on leads / lead_activities still apply, and it only calls functions authenticated users may already
--   call (is_crm_staff, update_lead_with_history, book_appointment). EXECUTE is granted to authenticated only
--   (not anon, not PUBLIC); the staff check inside refuses everyone else (42501).
--
-- PREREQUISITES (checked below; the preflight refuses to run otherwise)
--   202611040001 (clients, appointments, sessions, sync_client_from_lead, book_appointment), 202611130001
--   (membership-based is_crm_staff), 20261123161850 (Day 21 eight statuses). The four functions this relies on are
--   pinned by fingerprint (md5 of prosrc without CR), so a changed dependency is reviewed before this is applied.
--   book_appointment's fingerprint is the one checked on production by deployment 202611130003; the other three are
--   computed from the repository files.
--
-- DEPLOYMENT: do NOT use `supabase db push` (see supabase/migrations/README.md). Run this whole file in the SQL
--   Editor. Package: supabase/deploy/20261123223548_01_preflight_report.sql (before), this file,
--   20261123223548_03_postdeploy_report.sql and 20261123223548_04_behaviour_check.sql (after),
--   20261123223548_ROLLBACK_reference.sql. Ship the app changes (app/lib/appointmentsApi.js, BookingModal,
--   LeadDetailsModal, page.js) at the same time or after this.
--
-- ROLLBACK (removes only this function; data written by conversions stays, as it is ordinary lead/client/
--   appointment data):
--   DROP FUNCTION IF EXISTS public.convert_lead_to_appointment(uuid, text, uuid, uuid, timestamptz, text);
--
-- Safe to re-run (CREATE OR REPLACE; the preflight only checks dependencies).

BEGIN;

/* =====================================================================
   0. Preflight
   ===================================================================== */
DO $$
DECLARE
  v_text text;
  v_md5 text;
  v_fn record;
BEGIN
  IF to_regclass('public.leads') IS NULL OR to_regclass('public.lead_activities') IS NULL
     OR to_regclass('public.clients') IS NULL OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.sessions') IS NULL OR to_regclass('public.psychologists') IS NULL
     OR to_regclass('public.crm_staff_members') IS NULL
     OR to_regprocedure('public.is_crm_staff()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: a required table or is_crm_staff() is missing. Apply 202611040001 and 202611130001 first.';
  END IF;

  -- Day 21 is applied (eight statuses).
  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check';
  IF v_text IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT: leads_status_check is not the Day 21 eight-status constraint (apply 20261123161850 first): %',
      coalesce(v_text, '(missing)');
  END IF;

  -- The functions this RPC relies on are the reviewed versions.
  FOR v_fn IN
    SELECT * FROM (VALUES
      ('public.update_lead_with_history(uuid,text,jsonb,jsonb)', '0a62ea753396e7da751446e34373c29e', '20261123161850'),
      ('public.enforce_lead_workflow()', '7c9f820ac5dd11e57e6b4a11b2785a6b', '20261123161850'),
      ('public.sync_client_from_lead()', '4109aa9bd681941e084d44732f35a38c', '202611040001'),
      ('public.book_appointment(uuid,uuid,uuid,timestamptz,text,uuid,text)', '0c25ffb3cfa622fdeb53041a496b7ade', '202611040001')
    ) AS f(sig, expected, source)
  LOOP
    SELECT md5(replace(prosrc, E'\r', '')) INTO v_md5 FROM pg_proc WHERE oid = to_regprocedure(v_fn.sig);
    IF v_md5 IS DISTINCT FROM v_fn.expected THEN
      RAISE EXCEPTION 'PREFLIGHT: % is not the % version (md5 %, expected %). Review the change before applying.',
        v_fn.sig, v_fn.source, coalesce(v_md5, 'missing'), v_fn.expected;
    END IF;
  END LOOP;

  -- update_lead_with_history must stay SECURITY INVOKER (RLS on leads applies to the caller).
  IF (SELECT prosecdef FROM pg_proc WHERE oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)')) THEN
    RAISE EXCEPTION 'PREFLIGHT: update_lead_with_history is SECURITY DEFINER; expected SECURITY INVOKER.';
  END IF;

  -- The workflow and client triggers on leads exist and are enabled.
  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t
  WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal
    AND t.tgname IN ('leads_enforce_workflow', 'leads_sync_client');
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O' THEN
    RAISE EXCEPTION 'PREFLIGHT: leads_enforce_workflow / leads_sync_client are missing or disabled: %', coalesce(v_text, '(none)');
  END IF;

  -- One client per lead and one session per appointment (what makes the conversion duplicate-proof).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clients'::regclass AND contype = 'u'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.clients'::regclass AND attname = 'lead_id')]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: clients.lead_id is not UNIQUE.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.sessions'::regclass AND contype = 'u'
      AND conkey = ARRAY[(SELECT attnum FROM pg_attribute WHERE attrelid = 'public.sessions'::regclass AND attname = 'appointment_id')]
  ) THEN
    RAISE EXCEPTION 'PREFLIGHT: sessions.appointment_id is not UNIQUE.';
  END IF;
END
$$;

/* =====================================================================
   1. The conversion RPC
   ===================================================================== */
CREATE OR REPLACE FUNCTION public.convert_lead_to_appointment(
  p_lead_id uuid,
  p_expected_status text,
  p_psychologist_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_notes text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  current_lead public.leads%ROWTYPE;
  v_changes jsonb;
  v_events jsonb;
  v_psychologist_name text;
  v_saved jsonb;
  v_client_id uuid;
  v_appointment public.appointments%ROWTYPE;
  v_session_id uuid;
BEGIN
  IF p_lead_id IS NULL OR p_expected_status IS NULL OR p_psychologist_id IS NULL
     OR p_service_id IS NULL OR p_starts_at IS NULL THEN
    RAISE EXCEPTION 'Choose a lead, a psychologist, a service and a time slot.' USING ERRCODE = '22023';
  END IF;
  IF p_notes IS NOT NULL AND char_length(p_notes) > 1000 THEN
    RAISE EXCEPTION 'Keep the appointment notes under 1000 characters.' USING ERRCODE = '22023';
  END IF;

  -- 1. Signed-in, active CRM staff only.
  IF auth.uid() IS NULL OR NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can convert leads into appointments.' USING ERRCODE = '42501';
  END IF;

  -- 2. Lock the lead so a second (double-clicked or concurrent) conversion waits, then sees it is Confirmed.
  SELECT * INTO current_lead FROM public.leads WHERE id = p_lead_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
  END IF;
  IF current_lead.status = 'Confirmed' THEN
    RAISE EXCEPTION 'This lead is already Confirmed. Book further appointments from its client profile.' USING ERRCODE = 'P0001';
  END IF;
  IF current_lead.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'This lead was changed elsewhere. Refresh it before converting it.' USING ERRCODE = 'P0001';
  END IF;
  -- Defensive: a lead that is not Confirmed should never have a client (clients are only created on Confirmed, and
  -- Confirmed is final), so an existing one means the data needs a look. Refusing it, regardless of its appointments,
  -- also means the client is always created inside this transaction, invisible to every other session until commit:
  -- no ordinary booking can run against it while the conversion is in progress.
  IF EXISTS (SELECT 1 FROM public.clients AS c WHERE c.lead_id = p_lead_id) THEN
    RAISE EXCEPTION 'A client profile already exists for this lead, so it cannot be converted. Ask an administrator to investigate the existing client record before booking.'
      USING ERRCODE = 'P0001';
  END IF;

  -- 3. Confirm the lead through the Day 21 RPC (history included). Its UPDATE fires enforce_lead_workflow, which
  --    refuses New Lead / Contacted / final statuses and an inactive psychologist, and leads_sync_client, which
  --    creates the client. The follow-up date is cleared in the same UPDATE.
  v_changes := jsonb_build_object('status', 'Confirmed', 'updated_at', now());
  v_events := jsonb_build_array(jsonb_build_object(
    'type', 'status', 'text', format('Status changed from %s to Confirmed', current_lead.status)));
  IF current_lead.assigned_psychologist_id IS DISTINCT FROM p_psychologist_id THEN
    SELECT coalesce(nullif(btrim(to_jsonb(p) ->> 'full_name'), ''), nullif(btrim(to_jsonb(p) ->> 'name'), ''))
      INTO v_psychologist_name
    FROM public.psychologists AS p WHERE p.id = p_psychologist_id;
    v_changes := v_changes || jsonb_build_object('assigned_psychologist_id', p_psychologist_id);
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'type', 'update', 'text', format('Psychologist assigned: %s', coalesce(v_psychologist_name, 'selected psychologist'))));
  END IF;
  -- A booked appointment replaces the pending follow-up call. The old date goes into the history (clinic time and
  -- the exact ISO instant) before it is cleared, so it remains auditable.
  IF current_lead.next_follow_up_at IS NOT NULL THEN
    v_changes := v_changes || '{"next_follow_up_at": null}'::jsonb;
    v_events := v_events || jsonb_build_array(jsonb_build_object(
      'type', 'followup', 'text', format('Follow up cleared on conversion (was %s %s, %s)',
        to_char(current_lead.next_follow_up_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI'),
        public.clinic_timezone(),
        to_char(current_lead.next_follow_up_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'))));
  END IF;

  v_saved := public.update_lead_with_history(p_lead_id, p_expected_status, v_changes, v_events);
  IF NOT coalesce((v_saved ->> 'ok')::boolean, false) OR v_saved -> 'lead' IS NULL THEN
    RAISE EXCEPTION 'The lead could not be confirmed. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;

  -- 4. The client profile created by leads_sync_client in this same transaction.
  SELECT c.id INTO v_client_id FROM public.clients AS c WHERE c.lead_id = p_lead_id;
  IF v_client_id IS NULL THEN
    RAISE EXCEPTION 'The client profile could not be created. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;

  -- 5. Book the first appointment and its session (all booking rules apply).
  SELECT * INTO v_appointment
  FROM public.book_appointment(v_client_id, p_psychologist_id, p_service_id, p_starts_at,
                               nullif(btrim(p_notes), ''), NULL, NULL);
  SELECT s.id INTO v_session_id FROM public.sessions AS s WHERE s.appointment_id = v_appointment.id;
  IF v_appointment.id IS NULL OR v_session_id IS NULL THEN
    RAISE EXCEPTION 'The appointment could not be booked. Nothing was saved.' USING ERRCODE = 'P0001';
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'lead', v_saved -> 'lead',
    'client_id', v_client_id,
    'appointment_id', v_appointment.id,
    'session_id', v_session_id
  );
END;
$$;

COMMENT ON FUNCTION public.convert_lead_to_appointment(uuid, text, uuid, uuid, timestamptz, text) IS
  'Day 23: confirms an eligible lead, creates its client and books the first appointment and session in one transaction (20261123223548).';

REVOKE ALL ON FUNCTION public.convert_lead_to_appointment(uuid, text, uuid, uuid, timestamptz, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.convert_lead_to_appointment(uuid, text, uuid, uuid, timestamptz, text) TO authenticated;

/* =====================================================================
   2. Post-checks
   ===================================================================== */
DO $$
DECLARE
  v_sig constant text := 'public.convert_lead_to_appointment(uuid,text,uuid,uuid,timestamptz,text)';
BEGIN
  IF EXISTS (SELECT 1 FROM pg_proc WHERE oid = to_regprocedure(v_sig)
             AND (prosecdef OR coalesce(proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION 'POSTCHECK: convert_lead_to_appointment must be SECURITY INVOKER with search_path=public.';
  END IF;
  IF has_function_privilege('anon', v_sig, 'EXECUTE')
     OR NOT has_function_privilege('authenticated', v_sig, 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCHECK: convert_lead_to_appointment grants are wrong (anon must not, authenticated must execute).';
  END IF;
END
$$;

-- Make the new RPC visible to the API straight away (delivered only if the transaction commits; harmless if
-- Supabase's automatic schema reload has already done it).
NOTIFY pgrst, 'reload schema';

COMMIT;
