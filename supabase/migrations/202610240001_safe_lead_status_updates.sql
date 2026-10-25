-- Keep lead changes and their timeline events in one transaction.
-- Apply this migration in the Supabase SQL editor before saving CRM edits.
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
  saved_lead jsonb;
  changes jsonb := COALESCE(p_changes, '{}'::jsonb);
  event jsonb;
  event_type text;
  target_status text;
  status_event_count integer;
  v_column_name text;
  assignments text := '';
  allowed_columns constant text[] := ARRAY[
    'status', 'next_follow_up_at', 'assigned_staff',
    'not_converted_reason', 'service_interest', 'notes', 'updated_at'
  ];
BEGIN
  IF p_lead_id IS NULL OR p_expected_status IS NULL OR jsonb_typeof(changes) <> 'object' THEN
    RAISE EXCEPTION 'Invalid lead status update request.' USING ERRCODE = '22023';
  END IF;

  IF changes ? 'status' AND COALESCE(changes->>'status', '') NOT IN ('New', 'Contacted', 'Follow Up', 'Converted', 'Lost') THEN
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
  IF jsonb_array_length(COALESCE(p_events, '[]'::jsonb)) > 4 THEN
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

  IF current_lead.status IS DISTINCT FROM p_expected_status THEN
    RAISE EXCEPTION 'This lead was changed elsewhere. Refresh it before making another change.' USING ERRCODE = 'P0001';
  END IF;

  target_status := COALESCE(changes->>'status', current_lead.status);
  IF (target_status IS DISTINCT FROM current_lead.status AND status_event_count <> 1)
     OR (target_status IS NOT DISTINCT FROM current_lead.status AND status_event_count <> 0) THEN
    RAISE EXCEPTION 'The status history does not match the requested status change.' USING ERRCODE = '22023';
  END IF;

  IF target_status IS DISTINCT FROM current_lead.status
     AND current_lead.status IN ('Converted', 'Lost') THEN
    RAISE EXCEPTION 'Converted and lost leads cannot be reopened or converted again.' USING ERRCODE = 'P0001';
  END IF;

  IF target_status = 'Lost' AND NULLIF(BTRIM(changes->>'not_converted_reason'), '') IS NULL
     AND current_lead.status IS DISTINCT FROM 'Lost' THEN
    RAISE EXCEPTION 'Add a reason before marking this lead as lost.' USING ERRCODE = '22023';
  END IF;

  IF target_status = 'Follow Up'
     AND NULLIF(changes->>'next_follow_up_at', '') IS NULL
     AND current_lead.next_follow_up_at IS NULL THEN
    RAISE EXCEPTION 'Set a follow-up date and time before using Follow Up status.' USING ERRCODE = '22023';
  END IF;

  IF target_status IN ('Converted', 'Lost') THEN
    changes := jsonb_set(changes, '{next_follow_up_at}', 'null'::jsonb, true);
  END IF;
  IF target_status = 'Converted' THEN
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
    saved_lead := to_jsonb(current_lead);
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
