-- Kappiness CRM (Day 21): eight lead statuses and the new lead workflow.
-- Owner: Aswathy (backend / database).
--
-- WHY
--   The clinic's lead pipeline moves from five statuses (Enquiry / Yet to Confirm / Will Inform / Confirmed / Lost)
--   to eight, with a "Not Interested" outcome next to "Lost Lead" and a richer path to Confirmed.
--
-- NEW STATUSES (exact strings, used by the constraint, both functions, the tests and app/lib/leads.js)
--   New Lead, Contacted, Interested, Follow-up Required, Awaiting Confirmation, Confirmed, Not Interested, Lost Lead
--
-- EXISTING DATA (old -> new; every other column, every lead_activities row and every client is untouched)
--   Enquiry -> New Lead | Yet to Confirm -> Awaiting Confirmation | Will Inform -> Follow-up Required
--   Confirmed -> Confirmed (row not touched) | Lost -> Lost Lead
--   Old lead_activities texts are history and keep the old labels on purpose.
--
-- TRANSITIONS (enforced ONLY by the enforce_lead_workflow trigger, for every write path: the RPC, direct
-- UPDATEs, the service role and the SQL editor)
--   New Lead              -> Contacted, Interested, Follow-up Required, Awaiting Confirmation, Not Interested, Lost Lead
--   Contacted             -> Interested, Follow-up Required, Awaiting Confirmation, Not Interested, Lost Lead
--   Interested            -> Follow-up Required, Awaiting Confirmation, Confirmed, Not Interested, Lost Lead
--   Follow-up Required    -> Contacted, Interested, Awaiting Confirmation, Confirmed, Not Interested, Lost Lead
--   Awaiting Confirmation -> Follow-up Required, Confirmed, Not Interested, Lost Lead
--   Confirmed, Not Interested, Lost Lead: final (no transition)
--   Unchanged rules: only active CRM staff may change a status or the psychologist when signed in; Confirmed needs
--   an ACTIVE assigned psychologist; Not Interested and Lost Lead need a non-empty not_converted_reason.
--
-- WHAT THIS DOES (one transaction; any failure rolls everything back and changes nothing)
--   0. Preflight: refuses unless the database is exactly in the state this was written against
--      (old status constraint, production fingerprints of both functions, the three leads triggers, uuid ids,
--      no unexpected status values, not applied yet). Unexpected status values are LISTED, never converted.
--   1. Fingerprints leads (all columns except status), lead_activities and clients.
--   2. Backs up every status it renames into public.leads_status_backup_20261123150448 (for rollback).
--   3. Renames the statuses (only leads_enforce_workflow is disabled, for this one statement, inside the
--      transaction, with leads locked), replaces leads_status_check, sets the default to 'New Lead', and moves
--      lost_lead_requires_reason (if present) to Not Interested + Lost Lead.
--   4. Replaces enforce_lead_workflow() (same signature, settings, owner and trigger).
--   5. Replaces update_lead_with_history(uuid, text, jsonb, jsonb) (same signature, return type, SECURITY
--      INVOKER, search_path and grants).
--   6. Post-checks: vocabulary, mapping counts, unchanged fingerprints, triggers present and enabled,
--      function settings and grants.
--
-- HISTORY ATTRIBUTION: update_lead_with_history writes lead_activities.staff_member = NULL, exactly as every earlier
--   version did (202610240001, the live body captured before 202611030002, 202611030002 itself, and the retired
--   202611040004, which calls it a known gap). This migration keeps that behaviour; attribution is a separate change.
--
-- NOT CHANGED: RLS policies, grants on leads / lead_activities, set_lead_code / generate_lead_code,
--   sync_client_from_lead, appointments, reminders, follow-ups, the inert legacy constraint
--   follow_up_requires_datetime (it only refers to the retired 'Follow Up' status).
--
-- DEPLOYMENT: the app must ship app/lib/leads.js with the new statuses at the same time (the old app inserts
--   'Enquiry', which the new constraint rejects). Do NOT use `supabase db push` on production until migration
--   history has been repaired (supabase/migrations/README.md on main). Rollback: supabase/deploy/
--   20261123150448_ROLLBACK_reference.sql (reference only; read it before using it).
--
-- Not safe to re-run: a second run is refused by the preflight and changes nothing.

BEGIN;

SET LOCAL lock_timeout = '10s';

-- Lock first, in a fixed order, so no write can slip in between the checks and the changes.
LOCK TABLE public.leads IN ACCESS EXCLUSIVE MODE;
LOCK TABLE public.lead_activities IN SHARE MODE;
LOCK TABLE public.clients IN SHARE MODE;

/* =====================================================================
   0. Preflight
   ===================================================================== */
DO $$
DECLARE
  v_text text;
  v_md5 text;
BEGIN
  -- Not applied yet.
  IF to_regclass('public.leads_status_backup_20261123150448') IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: public.leads_status_backup_20261123150448 already exists. This migration has already run.';
  END IF;

  -- Required objects.
  IF to_regclass('public.lead_activities') IS NULL OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.psychologists') IS NULL
     OR to_regprocedure('public.is_crm_staff()') IS NULL
     OR to_regprocedure('public.sync_client_from_lead()') IS NULL
     OR to_regprocedure('public.generate_lead_code()') IS NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: a required object is missing (lead_activities, clients, psychologists, is_crm_staff, sync_client_from_lead or generate_lead_code).';
  END IF;

  SELECT string_agg(c.column_name || ':' || c.data_type, ',' ORDER BY c.column_name) INTO v_text
  FROM information_schema.columns AS c
  WHERE c.table_schema = 'public' AND c.table_name = 'leads'
    AND c.column_name IN ('id', 'status', 'not_converted_reason', 'assigned_psychologist_id', 'next_follow_up_at');
  IF v_text IS DISTINCT FROM
     'assigned_psychologist_id:uuid,id:uuid,next_follow_up_at:timestamp with time zone,not_converted_reason:text,status:text' THEN
    RAISE EXCEPTION 'PREFLIGHT: unexpected leads columns: %', v_text;
  END IF;

  -- The status constraint is the current five-status one.
  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check';
  IF v_text IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''Enquiry''::text, ''Yet to Confirm''::text, ''Will Inform''::text, ''Confirmed''::text, ''Lost''::text])))' THEN
    RAISE EXCEPTION 'PREFLIGHT: leads_status_check is not the expected five-status constraint: %', coalesce(v_text, '(missing)');
  END IF;

  -- If the legacy Lost-reason constraint exists, it must be the known one (step 3 moves it to the new statuses).
  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'lost_lead_requires_reason';
  IF v_text IS NOT NULL AND v_text IS DISTINCT FROM
     'CHECK (((status <> ''Lost''::text) OR (NULLIF(TRIM(BOTH FROM not_converted_reason), ''''::text) IS NOT NULL)))' THEN
    RAISE EXCEPTION 'PREFLIGHT: lost_lead_requires_reason has an unexpected definition: %', v_text;
  END IF;

  -- The two functions are the production versions (md5 of the body with LF line endings).
  SELECT md5(replace(prosrc, E'\r', '')) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.enforce_lead_workflow()');
  IF v_md5 IS DISTINCT FROM 'a1a07bca19718034c78c824014060747' THEN
    RAISE EXCEPTION 'PREFLIGHT: enforce_lead_workflow() is not the 202611040001 production body (md5 %).', coalesce(v_md5, 'missing');
  END IF;
  SELECT md5(replace(prosrc, E'\r', '')) INTO v_md5 FROM pg_proc
  WHERE oid = to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)');
  IF v_md5 IS DISTINCT FROM '2dc29d7ea4dade1797b141a2b86c408c' THEN
    -- 0d07f2cc... here means the retired 202611040004 was applied: stop and restore 202611030002 first.
    RAISE EXCEPTION 'PREFLIGHT: update_lead_with_history() is not the 202611030002 production body (md5 %).', coalesce(v_md5, 'missing');
  END IF;

  -- Exactly the three known triggers on leads, all enabled, and the workflow trigger on the known events.
  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'PREFLIGHT: unexpected triggers on leads: %', coalesce(v_text, '(none)');
  END IF;
  SELECT pg_get_triggerdef(t.oid) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND t.tgname = 'leads_enforce_workflow';
  IF v_text IS DISTINCT FROM
     'CREATE TRIGGER leads_enforce_workflow BEFORE INSERT OR UPDATE OF status, assigned_psychologist_id, not_converted_reason ON public.leads FOR EACH ROW EXECUTE FUNCTION enforce_lead_workflow()' THEN
    RAISE EXCEPTION 'PREFLIGHT: leads_enforce_workflow has an unexpected definition: %', v_text;
  END IF;

  -- Unexpected status values: list them with counts and stop. Nothing is converted silently.
  SELECT string_agg(format('%L (%s)', s.status, s.n), ', ' ORDER BY s.status) INTO v_text
  FROM (SELECT status, count(*) AS n FROM public.leads
        WHERE status IS NULL OR status NOT IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost')
        GROUP BY status) AS s;
  IF v_text IS NOT NULL THEN
    RAISE EXCEPTION 'PREFLIGHT: leads contains unexpected status values: %. Decide their mapping before applying.', v_text;
  END IF;
END
$$;

/* =====================================================================
   1. Fingerprints (checked again in step 6)
   ===================================================================== */
CREATE TEMP TABLE _d21_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM public.leads) AS leads_n,
  (SELECT md5(coalesce(string_agg((to_jsonb(l) - 'status')::text, '|' ORDER BY l.id), ''))
     FROM public.leads AS l) AS leads_md5,
  (SELECT count(*) FROM public.lead_activities) AS activities_n,
  (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, '|' ORDER BY a.id), ''))
     FROM public.lead_activities AS a) AS activities_md5,
  (SELECT count(*) FROM public.clients) AS clients_n,
  (SELECT md5(coalesce(string_agg(to_jsonb(c)::text, '|' ORDER BY c.id), ''))
     FROM public.clients AS c) AS clients_md5,
  (SELECT jsonb_object_agg(s.status, s.n) FROM (SELECT status, count(*) AS n FROM public.leads GROUP BY status) AS s)
     AS status_counts;

/* =====================================================================
   2. Backup of every status that is renamed
   ===================================================================== */
CREATE TABLE public.leads_status_backup_20261123150448 (
  lead_id uuid PRIMARY KEY,
  old_status text NOT NULL,
  new_status text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.leads_status_backup_20261123150448 IS
  'Day 21 (migration 20261123150448): lead status before the eight-status rename. Used only for rollback.';

INSERT INTO public.leads_status_backup_20261123150448 (lead_id, old_status, new_status)
SELECT l.id, l.status,
       CASE l.status
         WHEN 'Enquiry' THEN 'New Lead'
         WHEN 'Yet to Confirm' THEN 'Awaiting Confirmation'
         WHEN 'Will Inform' THEN 'Follow-up Required'
         WHEN 'Lost' THEN 'Lost Lead'
       END
FROM public.leads AS l
WHERE l.status IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Lost');

-- Not for the app: keep it away from the API roles (same as leads_status_backup_202611030002).
ALTER TABLE public.leads_status_backup_20261123150448 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.leads_status_backup_20261123150448 FROM PUBLIC, anon, authenticated;

/* =====================================================================
   3. New vocabulary and data rename
   ===================================================================== */
ALTER TABLE public.leads DROP CONSTRAINT leads_status_check;

-- The workflow trigger would (correctly) refuse Enquiry -> New Lead, which is a rename, not a transition.
-- It is disabled only around this one UPDATE, inside this transaction, with leads exclusively locked, so no other
-- session can ever write while it is off. leads_sync_client stays enabled (no renamed row is Confirmed, so it does
-- nothing) and set_lead_code is INSERT-only.
ALTER TABLE public.leads DISABLE TRIGGER leads_enforce_workflow;

UPDATE public.leads AS l
SET status = b.new_status
FROM public.leads_status_backup_20261123150448 AS b
WHERE b.lead_id = l.id;

ALTER TABLE public.leads ENABLE TRIGGER leads_enforce_workflow;

ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('New Lead', 'Contacted', 'Interested', 'Follow-up Required', 'Awaiting Confirmation',
                    'Confirmed', 'Not Interested', 'Lost Lead'));

ALTER TABLE public.leads ALTER COLUMN status SET DEFAULT 'New Lead';

-- The legacy row-level rule "Lost needs a reason" follows the rename to both closed-negative statuses.
-- It held for every 'Lost' row and no row is 'Not Interested' yet, so validation cannot fail.
-- Where the constraint does not exist, none is added (the trigger still enforces the rule on every change).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.leads'::regclass AND conname = 'lost_lead_requires_reason') THEN
    ALTER TABLE public.leads DROP CONSTRAINT lost_lead_requires_reason;
    ALTER TABLE public.leads
      ADD CONSTRAINT lost_lead_requires_reason
      CHECK (status NOT IN ('Not Interested', 'Lost Lead')
             OR NULLIF(BTRIM(not_converted_reason), '') IS NOT NULL);
  ELSE
    RAISE NOTICE 'lost_lead_requires_reason does not exist here; not added (the trigger enforces the reason rule).';
  END IF;
END
$$;

/* =====================================================================
   4. Workflow trigger function (single source of the transition matrix)
   ===================================================================== */
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
      WHEN 'New Lead' THEN
        ARRAY['Contacted', 'Interested', 'Follow-up Required', 'Awaiting Confirmation', 'Not Interested', 'Lost Lead']
      WHEN 'Contacted' THEN
        ARRAY['Interested', 'Follow-up Required', 'Awaiting Confirmation', 'Not Interested', 'Lost Lead']
      WHEN 'Interested' THEN
        ARRAY['Follow-up Required', 'Awaiting Confirmation', 'Confirmed', 'Not Interested', 'Lost Lead']
      WHEN 'Follow-up Required' THEN
        ARRAY['Contacted', 'Interested', 'Awaiting Confirmation', 'Confirmed', 'Not Interested', 'Lost Lead']
      WHEN 'Awaiting Confirmation' THEN
        ARRAY['Follow-up Required', 'Confirmed', 'Not Interested', 'Lost Lead']
      ELSE ARRAY[]::text[] -- Confirmed, Not Interested and Lost Lead are final
    END;
    IF NOT coalesce(NEW.status = ANY(allowed), false) THEN
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

  IF NEW.status IN ('Not Interested', 'Lost Lead')
     AND NULLIF(BTRIM(NEW.not_converted_reason), '') IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM NEW.status
          OR NULLIF(BTRIM(OLD.not_converted_reason), '') IS NOT NULL) THEN
    RAISE EXCEPTION 'Add a reason before marking this lead as %.', NEW.status USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

/* =====================================================================
   5. Atomic lead update + history (same signature, return type, security and grants)
      The transition matrix is NOT repeated here: the UPDATE below fires enforce_lead_workflow, which refuses
      an invalid move before any lead_activities row is written, and the whole call is rolled back.
   ===================================================================== */
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
  lead_statuses constant text[] := ARRAY[
    'New Lead', 'Contacted', 'Interested', 'Follow-up Required', 'Awaiting Confirmation',
    'Confirmed', 'Not Interested', 'Lost Lead'
  ];
  reason_statuses constant text[] := ARRAY['Not Interested', 'Lost Lead'];
BEGIN
  IF p_lead_id IS NULL OR p_expected_status IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RAISE EXCEPTION 'Invalid lead status update request.' USING ERRCODE = '22023';
  END IF;

  IF changes ? 'status' AND NOT (COALESCE(changes->>'status', '') = ANY(lead_statuses)) THEN
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

  -- Early, friendly versions of two trigger rules (the trigger remains the authority).
  IF target_status = 'Confirmed' AND target_psychologist IS NULL
     AND (current_lead.status IS DISTINCT FROM 'Confirmed' OR changes ? 'assigned_psychologist_id') THEN
    RAISE EXCEPTION 'Assign a psychologist before setting this lead to Confirmed.' USING ERRCODE = 'P0001';
  END IF;

  IF target_status = ANY(reason_statuses) AND target_reason IS NULL
     AND (current_lead.status IS DISTINCT FROM target_status OR changes ? 'not_converted_reason') THEN
    RAISE EXCEPTION 'Add a reason before marking this lead as %.', target_status USING ERRCODE = 'P0001';
  END IF;

  -- A closed (Not Interested / Lost Lead) lead needs no follow-ups. A lead leaving one of those statuses
  -- (not possible in the current matrix; kept for safety) drops the old reason; the history keeps it.
  IF target_status = ANY(reason_statuses) AND current_lead.status IS DISTINCT FROM target_status THEN
    changes := jsonb_set(changes, '{next_follow_up_at}', 'null'::jsonb, true);
  END IF;
  IF current_lead.status = ANY(reason_statuses) AND NOT (target_status = ANY(reason_statuses)) THEN
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

  -- The UPDATE fires enforce_lead_workflow (transitions, staff check, psychologist, reason) BEFORE any history row.
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
-- CREATE OR REPLACE keeps the existing owner and grants (authenticated + service_role; not anon, not PUBLIC).

/* =====================================================================
   6. Post-checks (any failure rolls back the whole migration)
   ===================================================================== */
DO $$
DECLARE
  b record;
  v_text text;
  v_counts jsonb;
  v_expected jsonb;
BEGIN
  SELECT * INTO b FROM _d21_before;

  -- Vocabulary and constraint.
  IF EXISTS (SELECT 1 FROM public.leads WHERE status NOT IN ('New Lead', 'Contacted', 'Interested',
             'Follow-up Required', 'Awaiting Confirmation', 'Confirmed', 'Not Interested', 'Lost Lead')) THEN
    RAISE EXCEPTION 'POSTCHECK: a lead still has a status outside the eight statuses.';
  END IF;
  SELECT pg_get_constraintdef(oid) INTO v_text
  FROM pg_constraint WHERE conrelid = 'public.leads'::regclass AND conname = 'leads_status_check';
  IF v_text IS DISTINCT FROM
     'CHECK ((status = ANY (ARRAY[''New Lead''::text, ''Contacted''::text, ''Interested''::text, ''Follow-up Required''::text, ''Awaiting Confirmation''::text, ''Confirmed''::text, ''Not Interested''::text, ''Lost Lead''::text])))' THEN
    RAISE EXCEPTION 'POSTCHECK: leads_status_check is %', coalesce(v_text, '(missing)');
  END IF;
  SELECT column_default INTO v_text FROM information_schema.columns
  WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'status';
  IF v_text IS DISTINCT FROM '''New Lead''::text' THEN
    RAISE EXCEPTION 'POSTCHECK: leads.status default is %', v_text;
  END IF;

  -- Mapping: the new counts are exactly the old counts under the mapping.
  SELECT coalesce(jsonb_object_agg(s.status, s.n), '{}'::jsonb) INTO v_counts
  FROM (SELECT status, count(*) AS n FROM public.leads GROUP BY status) AS s;
  SELECT coalesce(jsonb_object_agg(m.new_status, m.n), '{}'::jsonb) INTO v_expected
  FROM (SELECT CASE o.key WHEN 'Enquiry' THEN 'New Lead' WHEN 'Yet to Confirm' THEN 'Awaiting Confirmation'
                          WHEN 'Will Inform' THEN 'Follow-up Required' WHEN 'Lost' THEN 'Lost Lead'
                          ELSE o.key END AS new_status,
               sum(o.value::bigint) AS n
        FROM jsonb_each_text(coalesce(b.status_counts, '{}'::jsonb)) AS o
        GROUP BY 1) AS m;
  IF v_counts IS DISTINCT FROM v_expected THEN
    RAISE EXCEPTION 'POSTCHECK: status counts % do not match the mapped counts %', v_counts, v_expected;
  END IF;
  IF (SELECT count(*) FROM public.leads_status_backup_20261123150448)
     <> (SELECT count(*) FROM public.leads AS l JOIN public.leads_status_backup_20261123150448 AS k
           ON k.lead_id = l.id AND l.status = k.new_status) THEN
    RAISE EXCEPTION 'POSTCHECK: backup rows do not match the renamed leads.';
  END IF;

  -- Nothing else changed: leads (except status), every history row, every client.
  IF (SELECT count(*) FROM public.leads) <> b.leads_n
     OR (SELECT md5(coalesce(string_agg((to_jsonb(l) - 'status')::text, '|' ORDER BY l.id), ''))
           FROM public.leads AS l) IS DISTINCT FROM b.leads_md5 THEN
    RAISE EXCEPTION 'POSTCHECK: a lead column other than status changed.';
  END IF;
  IF (SELECT count(*) FROM public.lead_activities) <> b.activities_n
     OR (SELECT md5(coalesce(string_agg(to_jsonb(a)::text, '|' ORDER BY a.id), ''))
           FROM public.lead_activities AS a) IS DISTINCT FROM b.activities_md5 THEN
    RAISE EXCEPTION 'POSTCHECK: lead_activities changed.';
  END IF;
  IF (SELECT count(*) FROM public.clients) <> b.clients_n
     OR (SELECT md5(coalesce(string_agg(to_jsonb(c)::text, '|' ORDER BY c.id), ''))
           FROM public.clients AS c) IS DISTINCT FROM b.clients_md5 THEN
    RAISE EXCEPTION 'POSTCHECK: clients changed.';
  END IF;

  -- Triggers: same three, all enabled again.
  SELECT string_agg(t.tgname::text || ':' || t.tgenabled::text, ',' ORDER BY t.tgname) INTO v_text
  FROM pg_trigger AS t WHERE t.tgrelid = 'public.leads'::regclass AND NOT t.tgisinternal;
  IF v_text IS DISTINCT FROM 'leads_enforce_workflow:O,leads_sync_client:O,set_lead_code:O' THEN
    RAISE EXCEPTION 'POSTCHECK: triggers on leads are %', v_text;
  END IF;

  -- Function settings and grants unchanged.
  IF EXISTS (SELECT 1 FROM pg_proc
             WHERE oid IN (to_regprocedure('public.enforce_lead_workflow()'),
                           to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)'))
               AND (prosecdef OR coalesce(proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public'])) THEN
    RAISE EXCEPTION 'POSTCHECK: a lead function is SECURITY DEFINER or lost search_path=public.';
  END IF;
  IF has_function_privilege('anon', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.update_lead_with_history(uuid,text,jsonb,jsonb)', 'EXECUTE') THEN
    RAISE EXCEPTION 'POSTCHECK: update_lead_with_history grants changed.';
  END IF;
  IF has_table_privilege('authenticated', 'public.leads_status_backup_20261123150448', 'SELECT')
     OR has_table_privilege('anon', 'public.leads_status_backup_20261123150448', 'SELECT') THEN
    RAISE EXCEPTION 'POSTCHECK: the status backup is readable by an API role.';
  END IF;
END
$$;

COMMIT;
