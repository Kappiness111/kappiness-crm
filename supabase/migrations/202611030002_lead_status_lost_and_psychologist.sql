-- Kappiness CRM: lead status vocabulary, Lost status, and psychologist assignment.
--
-- WHY: the CRM screens use the statuses Enquiry / Yet to Confirm / Will Inform / Confirmed (+ Lost),
-- but public.leads still has the older leads_status_check (New / Contacted / Follow Up / Converted / Lost)
-- and update_lead_with_history validates the older list. Saving "Enquiry" therefore fails with
--   23514: new row for relation "leads" violates check constraint "leads_status_check".
--
-- WHAT THIS DOES (one transaction; any failure rolls everything back):
--   1. Checks that every existing status is a known value (stops with a clear error otherwise).
--   2. Saves a copy of the current status of every lead whose status will be renamed.
--   3. Renames old statuses to the new names and replaces leads_status_check.
--   4. Makes sure leads.not_converted_reason exists (it is used for the Lost reason).
--   5. Adds leads.assigned_psychologist_id -> psychologists(id), using the same type as psychologists.id.
--   6. Adds a trigger so every write path follows the workflow:
--        - Confirmed needs an assigned psychologist,
--        - Lost needs a reason.
--   7. Replaces update_lead_with_history with the new statuses and rules.
--
-- BACKEND REVIEW BEFORE APPLYING:
--   a) Confirm the old -> new status mapping in step 3 (especially Contacted and Follow Up).
--   b) Existing Confirmed leads without a psychologist, and Lost leads without a reason, are kept as they
--      are. The rules only apply when a lead moves into those statuses, or when the psychologist/reason is removed.
--   c) Row Level Security is unchanged. The new column follows the existing leads policies.
--   d) Rollback: the old statuses are in public.leads_status_backup_202611030002.

BEGIN;

-- 1. Fail early, with a readable message, if the table holds a status this migration does not know.
DO $$
DECLARE
  unknown text;
BEGIN
  SELECT string_agg(DISTINCT status, ', ') INTO unknown
  FROM public.leads
  WHERE status IS NOT NULL
    AND status NOT IN ('New', 'Contacted', 'Follow Up', 'Converted', 'Lost',
                       'Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed');
  IF unknown IS NOT NULL THEN
    RAISE EXCEPTION 'leads contains unexpected status values: %. Add them to the mapping before applying.', unknown;
  END IF;
END
$$;

-- 2. Keep a copy of every status that is about to be renamed.
CREATE TABLE IF NOT EXISTS public.leads_status_backup_202611030002 (
  lead_id uuid,
  old_status text NOT NULL,
  backed_up_at timestamptz NOT NULL DEFAULT now()
);
-- lead_id is uuid in the CRM; if leads.id has another type, adjust this column before applying.

INSERT INTO public.leads_status_backup_202611030002 (lead_id, old_status)
SELECT id, status
FROM public.leads
WHERE status IN ('New', 'Contacted', 'Follow Up', 'Converted');

-- The backup is not for the app: keep it away from the API roles.
ALTER TABLE public.leads_status_backup_202611030002 ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.leads_status_backup_202611030002 FROM anon, authenticated;

-- 3. New status vocabulary.
ALTER TABLE public.leads DROP CONSTRAINT IF EXISTS leads_status_check;

UPDATE public.leads
SET status = CASE status
  WHEN 'New' THEN 'Enquiry'
  WHEN 'Contacted' THEN 'Yet to Confirm'
  WHEN 'Follow Up' THEN 'Will Inform'
  WHEN 'Converted' THEN 'Confirmed'
END
WHERE status IN ('New', 'Contacted', 'Follow Up', 'Converted');

ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost'));

ALTER TABLE public.leads ALTER COLUMN status SET DEFAULT 'Enquiry';

-- 4. Lost reason column (already used by the CRM; created only if it is missing).
ALTER TABLE public.leads ADD COLUMN IF NOT EXISTS not_converted_reason text;

-- 5. Assigned psychologist. The column type follows psychologists.id so the foreign key always matches.
DO $$
DECLARE
  id_type text;
BEGIN
  SELECT format_type(a.atttypid, a.atttypmod) INTO id_type
  FROM pg_attribute AS a
  WHERE a.attrelid = 'public.psychologists'::regclass
    AND a.attname = 'id'
    AND NOT a.attisdropped;

  IF id_type IS NULL THEN
    RAISE EXCEPTION 'public.psychologists.id was not found.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'assigned_psychologist_id'
  ) THEN
    -- RESTRICT: a psychologist who still has leads cannot be deleted by accident (the CRM deactivates instead).
    EXECUTE format(
      'ALTER TABLE public.leads ADD COLUMN assigned_psychologist_id %s REFERENCES public.psychologists(id) ON DELETE RESTRICT',
      id_type
    );
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_leads_assigned_psychologist_id
  ON public.leads (assigned_psychologist_id);

-- 6. Workflow rules for every write path (RPC, direct updates, inserts).
CREATE OR REPLACE FUNCTION public.enforce_lead_workflow()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.status = 'Confirmed'
     AND NEW.assigned_psychologist_id IS NULL
     AND (TG_OP = 'INSERT'
          OR OLD.status IS DISTINCT FROM 'Confirmed'
          OR OLD.assigned_psychologist_id IS NOT NULL) THEN
    RAISE EXCEPTION 'Assign a psychologist before setting this lead to Confirmed.' USING ERRCODE = 'P0001';
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

DROP TRIGGER IF EXISTS leads_enforce_workflow ON public.leads;
CREATE TRIGGER leads_enforce_workflow
  BEFORE INSERT OR UPDATE OF status, assigned_psychologist_id, not_converted_reason ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_lead_workflow();

-- 7. Atomic lead update + history, with the new statuses and fields.
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

REVOKE ALL ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) TO authenticated;

COMMIT;
