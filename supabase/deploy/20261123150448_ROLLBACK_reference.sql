-- Kappiness CRM: ROLLBACK REFERENCE for migration 20261123161850_lead_status_workflow_eight_statuses.sql (Day 21).
-- Handwritten; the two function bodies in STEP 3 are copied byte-for-byte from 202611040001 and 202611030002.
--
-- THIS FILE REFUSES TO RUN AS-IS. Its first statement aborts its own transaction unless the session has
--   SET kappiness.rollback_20261123150448 = 'reviewed';
-- Nothing in it has been run on any real database. Rehearsed only on a disposable in-memory database.
--
-- PRINCIPLES
--   * Prefer rolling FORWARD (a corrective migration) over rolling back.
--   * A failed Day 21 migration needs NO rollback: it is one transaction with a preflight and post-checks, so a
--     failure leaves the database exactly as before.
--   * The app must go back to the old app/lib/leads.js (five statuses) in the same release as this rollback.
--
-- WHAT THE ROLLBACK DOES (one transaction)
--   STEP 0  refuses unless opted in, unless the Day 21 objects are present, and while any lead has a status with
--           no old equivalent (see "LOSSY CASES").
--   STEP 1  reverse rename: New Lead -> Enquiry, Awaiting Confirmation -> Yet to Confirm,
--           Follow-up Required -> Will Inform, Lost Lead -> Lost, Confirmed -> Confirmed.
--   STEP 2  restores leads_status_check (five statuses), the default 'Enquiry' and, where it exists,
--           lost_lead_requires_reason for 'Lost'.
--   STEP 3  restores enforce_lead_workflow() (202611040001, md5 a1a07bca…) and update_lead_with_history()
--           (202611030002, md5 2dc29d7e…), then checks both fingerprints.
--   It keeps: public.leads_status_backup_20261123150448 (audit; drop it later by hand if wanted), every
--   lead_activities row (rows written after Day 21 keep the new labels: history is not rewritten), every client.
--
-- IS IT LOSSLESS?
--   * For leads the migration renamed and that have NOT changed status since: yes. The value mapping is 1:1 and
--     public.leads_status_backup_20261123150448 records each lead's old status.
--   * For leads in New Lead / Awaiting Confirmation / Follow-up Required / Lost Lead / Confirmed (whenever they got
--     there): the reverse rename is unambiguous by value. A lead that reached its status by a Day 21 move the old
--     workflow did not allow (e.g. New Lead -> Awaiting Confirmation) simply keeps that status under its old name.
--   * LOSSY CASES: Contacted, Interested and Not Interested have NO old equivalent. The rollback refuses while any
--     lead is in one of them. Someone must decide, lead by lead, and update them FIRST (as the table owner, inside
--     the same maintenance window). Suggested, but a business decision, not a technical one:
--       Contacted -> Yet to Confirm,  Interested -> Will Inform,  Not Interested -> Lost (its reason is kept).
--     Whatever is chosen, the distinction between those statuses is lost on rollback.
--
-- CHECK BEFORE ROLLBACK (read-only; run these first and keep the output)
--   -- 1. Current status counts, and the leads that block the rollback:
--   SELECT status, count(*) FROM public.leads GROUP BY status ORDER BY status;
--   SELECT id, lead_code, status, not_converted_reason FROM public.leads
--   WHERE status IN ('Contacted', 'Interested', 'Not Interested') ORDER BY lead_code;
--   -- 2. Renamed leads that have moved since the migration (their backup row no longer describes them):
--   SELECT b.lead_id, l.lead_code, b.old_status, b.new_status, l.status AS status_now
--   FROM public.leads_status_backup_20261123150448 AS b JOIN public.leads AS l ON l.id = b.lead_id
--   WHERE l.status IS DISTINCT FROM b.new_status ORDER BY l.lead_code;
--   -- 3. Leads that will lose a Day 21-only meaning (Lost Lead / Not Interested reasons are kept as the Lost reason):
--   SELECT status, count(*) FILTER (WHERE NULLIF(BTRIM(not_converted_reason), '') IS NULL) AS without_reason
--   FROM public.leads WHERE status IN ('Lost Lead', 'Not Interested') GROUP BY status;
--   -- 4. The functions are still the Day 21 versions (if not, someone changed them since: stop and review):
--   SELECT p.proname, md5(replace(p.prosrc, E'\r', '')) FROM pg_proc AS p
--   WHERE p.oid IN ('public.enforce_lead_workflow()'::regprocedure,
--                   'public.update_lead_with_history(uuid,text,jsonb,jsonb)'::regprocedure);

BEGIN;

SET LOCAL lock_timeout = '10s';

/* =====================================================================
   STEP 0. Guards
   ===================================================================== */
DO $$
DECLARE
  v_text text;
BEGIN
  IF coalesce(current_setting('kappiness.rollback_20261123150448', true), '') <> 'reviewed' THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: this is a reference. Read the header, run the checks, then SET kappiness.rollback_20261123150448 = ''reviewed'' in the same session.';
  END IF;
  IF to_regclass('public.leads_status_backup_20261123150448') IS NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: public.leads_status_backup_20261123150448 does not exist; migration 20261123150448 is not applied here.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check'
                 AND pg_get_constraintdef(oid) LIKE '%New Lead%Lost Lead%') THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: leads_status_check is not the Day 21 constraint.';
  END IF;
END
$$;

LOCK TABLE public.leads IN ACCESS EXCLUSIVE MODE;

DO $$
DECLARE
  v_text text;
BEGIN
  SELECT string_agg(format('%L (%s)', s.status, s.n), ', ' ORDER BY s.status) INTO v_text
  FROM (SELECT status, count(*) AS n FROM public.leads
        WHERE status NOT IN ('New Lead', 'Awaiting Confirmation', 'Follow-up Required', 'Lost Lead', 'Confirmed')
        GROUP BY status) AS s;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'ROLLBACK REFUSED: leads have statuses with no old equivalent: %. Decide and update them first (see header).', v_text;
  END IF;
END
$$;

/* =====================================================================
   STEP 1. Reverse rename (only the status column; the workflow trigger is off for this statement only)
   ===================================================================== */
ALTER TABLE public.leads DROP CONSTRAINT leads_status_check;
ALTER TABLE public.leads DISABLE TRIGGER leads_enforce_workflow;

UPDATE public.leads
SET status = CASE status
  WHEN 'New Lead' THEN 'Enquiry'
  WHEN 'Awaiting Confirmation' THEN 'Yet to Confirm'
  WHEN 'Follow-up Required' THEN 'Will Inform'
  WHEN 'Lost Lead' THEN 'Lost'
END
WHERE status IN ('New Lead', 'Awaiting Confirmation', 'Follow-up Required', 'Lost Lead');

ALTER TABLE public.leads ENABLE TRIGGER leads_enforce_workflow;

/* =====================================================================
   STEP 2. Previous constraints and default
   ===================================================================== */
ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost'));
ALTER TABLE public.leads ALTER COLUMN status SET DEFAULT 'Enquiry';

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.leads'::regclass AND conname = 'lost_lead_requires_reason') THEN
    ALTER TABLE public.leads DROP CONSTRAINT lost_lead_requires_reason;
    ALTER TABLE public.leads
      ADD CONSTRAINT lost_lead_requires_reason
      CHECK (((status <> 'Lost'::text) OR (NULLIF(TRIM(BOTH FROM not_converted_reason), ''::text) IS NOT NULL)));
  END IF;
END
$$;

/* =====================================================================
   STEP 3. Previous function definitions (verbatim)
   ===================================================================== */
-- From 202611040001_clients_appointments_sessions.sql, section 2.
CREATE OR REPLACE FUNCTION public.enforce_lead_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  allowed text[];
  signed_in boolean := auth.uid() IS NOT NULL; -- false for the SQL editor / service role
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF signed_in AND NOT public.is_crm_staff() THEN
      RAISE EXCEPTION 'Only CRM staff can change lead statuses.' USING ERRCODE = '42501';
    END IF;

    allowed := CASE OLD.status
      WHEN 'Enquiry' THEN ARRAY['Yet to Confirm', 'Lost']
      WHEN 'Yet to Confirm' THEN ARRAY['Enquiry', 'Will Inform', 'Lost']
      WHEN 'Will Inform' THEN ARRAY['Yet to Confirm', 'Confirmed', 'Lost']
      ELSE ARRAY[]::text[] -- Confirmed and Lost are final
    END;
    IF NOT NEW.status = ANY(allowed) THEN
      RAISE EXCEPTION 'A lead cannot move from % to %.', OLD.status, NEW.status USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF TG_OP = 'UPDATE' AND NEW.assigned_psychologist_id IS DISTINCT FROM OLD.assigned_psychologist_id
     AND signed_in AND NOT public.is_crm_staff() THEN
    RAISE EXCEPTION 'Only CRM staff can assign psychologists.' USING ERRCODE = '42501';
  END IF;

  IF NEW.status = 'Confirmed'
     AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'Confirmed'
          OR NEW.assigned_psychologist_id IS DISTINCT FROM OLD.assigned_psychologist_id) THEN
    IF NEW.assigned_psychologist_id IS NULL THEN
      RAISE EXCEPTION 'Assign a psychologist before setting this lead to Confirmed.' USING ERRCODE = 'P0001';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = NEW.assigned_psychologist_id AND is_active) THEN
      RAISE EXCEPTION 'The assigned psychologist is not active. Choose an active psychologist.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  IF NEW.status = 'Lost'
     AND NULLIF(BTRIM(NEW.not_converted_reason), '') IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM 'Lost'
          OR NULLIF(BTRIM(OLD.not_converted_reason), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'Add a reason before marking this lead as lost.' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

-- From 202611030002_lead_status_lost_and_psychologist.sql, step 7. (Owner and grants are kept by CREATE OR REPLACE.)
CREATE OR REPLACE FUNCTION public.update_lead_with_history(
  p_lead_id uuid,
  p_expected_status text,
  p_changes jsonb,
  p_events jsonb
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  current_lead public.leads%ROWTYPE;
  current_json jsonb;
  saved_lead jsonb;
  changes jsonb := COALESCE(p_changes, '{}'::jsonb);
  event jsonb;
  event_type text;
  target_status text;
  target_psychologist text;
  target_reason text;
  status_event_count integer;
  v_column_name text;
  assignments text := '';
  allowed_columns constant text[] := ARRAY[
    'status', 'next_follow_up_at', 'assigned_staff', 'assigned_psychologist_id',
    'not_converted_reason', 'service_interest', 'notes', 'source',
    'contact_method', 'updated_at'
  ];
BEGIN
  IF p_lead_id IS NULL OR p_expected_status IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RAISE EXCEPTION 'Invalid lead status update request.' USING ERRCODE = '22023';
  END IF;

  IF changes ? 'status' AND COALESCE(changes->>'status', '') NOT IN
     ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost') THEN
    RAISE EXCEPTION 'Choose a valid lead status.' USING ERRCODE = '22023';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM jsonb_object_keys(changes) AS supplied(key)
    WHERE NOT supplied.key = ANY(allowed_columns)
  ) THEN
    RAISE EXCEPTION 'The update contains an unsupported lead field.' USING ERRCODE = '22023';
  END IF;

  IF p_events IS NOT NULL AND jsonb_typeof(p_events) <> 'array' THEN
    RAISE EXCEPTION 'Invalid activity history.' USING ERRCODE = '22023';
  END IF;
  IF jsonb_array_length(COALESCE(p_events, '[]'::jsonb)) > 5 THEN
    RAISE EXCEPTION 'Too many history entries for one lead update.' USING ERRCODE = '22023';
  END IF;
  SELECT COUNT(*) INTO status_event_count
  FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) AS items(value)
  WHERE value->>'type' = 'status';

  IF status_event_count > 1 THEN
    RAISE EXCEPTION 'A lead update cannot contain duplicate status history entries.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO current_lead
  FROM public.leads
  WHERE id = p_lead_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.' USING ERRCODE = 'P0001';
  END IF;
  current_json := to_jsonb(current_lead);

  IF current_lead.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'This lead was changed elsewhere. Refresh it before making another change.' USING ERRCODE = 'P0001';
  END IF;

  target_status := COALESCE(changes->>'status', current_lead.status);
  IF (target_status IS DISTINCT FROM current_lead.status AND status_event_count <> 1)
     OR (target_status IS NOT DISTINCT FROM current_lead.status AND status_event_count <> 0) THEN
    RAISE EXCEPTION 'The status history does not match the requested status change.' USING ERRCODE = '22023';
  END IF;

  target_psychologist := CASE
    WHEN changes ? 'assigned_psychologist_id' THEN NULLIF(changes->>'assigned_psychologist_id', '')
    ELSE current_json->>'assigned_psychologist_id'
  END;
  target_reason := CASE
    WHEN changes ? 'not_converted_reason' THEN NULLIF(BTRIM(changes->>'not_converted_reason'), '')
    ELSE NULLIF(BTRIM(current_json->>'not_converted_reason'), '')
  END;

  IF target_status = 'Confirmed' AND target_psychologist IS NULL
     AND (current_lead.status IS DISTINCT FROM 'Confirmed' OR changes ? 'assigned_psychologist_id') THEN
    RAISE EXCEPTION 'Assign a psychologist before setting this lead to Confirmed.' USING ERRCODE = 'P0001';
  END IF;

  IF target_status = 'Lost' AND target_reason IS NULL
     AND (current_lead.status IS DISTINCT FROM 'Lost' OR changes ? 'not_converted_reason') THEN
    RAISE EXCEPTION 'Add a reason before marking this lead as lost.' USING ERRCODE = 'P0001';
  END IF;

  -- A lost lead needs no follow ups; a lead leaving Lost drops the old reason (the history keeps it).
  IF target_status = 'Lost' AND current_lead.status IS DISTINCT FROM 'Lost' THEN
    changes := jsonb_set(changes, '{next_follow_up_at}', 'null'::jsonb, true);
  END IF;
  IF current_lead.status = 'Lost' AND target_status IS DISTINCT FROM 'Lost' THEN
    changes := jsonb_set(changes, '{not_converted_reason}', 'null'::jsonb, true);
  END IF;

  FOR v_column_name IN SELECT jsonb_object_keys(changes) LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns AS c
      WHERE c.table_schema = 'public' AND c.table_name = 'leads' AND c.column_name = v_column_name
    ) THEN
      IF changes->v_column_name = 'null'::jsonb OR changes->>v_column_name = '' THEN
        changes := changes - v_column_name;
        CONTINUE;
      END IF;
      RAISE EXCEPTION 'The leads table is missing the % column.', v_column_name USING ERRCODE = 'P0001';
    END IF;
    assignments := assignments || CASE WHEN assignments = '' THEN '' ELSE ', ' END
      || format('%1$I = (jsonb_populate_record(NULL::public.leads, $1)).%1$I', v_column_name);
  END LOOP;

  IF assignments <> '' THEN
    EXECUTE format(
      'UPDATE public.leads AS l SET %s WHERE l.id = $2 RETURNING to_jsonb(l)',
      assignments
    ) INTO saved_lead USING changes, p_lead_id;
  ELSE
    saved_lead := current_json;
  END IF;

  FOR event IN SELECT value FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) AS items(value) LOOP
    event_type := CASE event->>'type'
      WHEN 'status' THEN 'Status change'
      WHEN 'followup' THEN 'Follow-up'
      WHEN 'update' THEN 'Lead update'
      ELSE NULL
    END;
    IF event_type IS NULL THEN
      RAISE EXCEPTION 'The history contains an unsupported event.' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.lead_activities (lead_id, activity_type, staff_member, notes)
    VALUES (p_lead_id, event_type, NULL, NULLIF(event->>'text', ''));
  END LOOP;

  RETURN jsonb_build_object('ok', true, 'lead', saved_lead, 'events_saved', true);
END;
$$;

/* =====================================================================
   STEP 4. Checks
   ===================================================================== */
DO $$
BEGIN
  IF md5(replace((SELECT prosrc FROM pg_proc WHERE oid = 'public.enforce_lead_workflow()'::regprocedure), E'\r', ''))
       IS DISTINCT FROM 'a1a07bca19718034c78c824014060747'
     OR md5(replace((SELECT prosrc FROM pg_proc
                     WHERE oid = 'public.update_lead_with_history(uuid,text,jsonb,jsonb)'::regprocedure), E'\r', ''))
       IS DISTINCT FROM '2dc29d7ea4dade1797b141a2b86c408c' THEN
    RAISE EXCEPTION 'ROLLBACK CHECK FAILED: the restored functions do not match the production fingerprints.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.leads
             WHERE status NOT IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost')) THEN
    RAISE EXCEPTION 'ROLLBACK CHECK FAILED: a lead still has a Day 21 status.';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.leads'::regclass AND NOT tgisinternal AND tgenabled <> 'O') THEN
    RAISE EXCEPTION 'ROLLBACK CHECK FAILED: a trigger on leads is disabled.';
  END IF;
END
$$;

COMMIT;
