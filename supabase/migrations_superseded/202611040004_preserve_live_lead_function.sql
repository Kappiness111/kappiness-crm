-- Kappiness CRM: keep the live update_lead_with_history exactly as it is in production.
-- Owner: Aswathy (backend / security).
--
-- WHY
--   202611030002 replaces public.update_lead_with_history with a version that is WEAKER than live:
--   it drops "Confirmed and Lost are final", the transition matrix, the follow-up date validation and the
--   clears on Confirmed, and allows five history events instead of four. 202611030002 cannot be edited
--   (teammate-owned), so this migration, deployed in the same transaction, puts the live function back.
--
-- WHAT THIS DOES
--   1. Recreates the function VERBATIM from the live definition (pg_get_functiondef, exported 4 Nov 2026 to
--      live_function_definitions.csv; prosrc md5 0d07f2ccc6f8e6b1737d4cacc8103804). The live body already lists
--      assigned_psychologist_id among the allowed fields, so the body is NOT changed at all.
--   2. Keeps live security settings: SECURITY INVOKER, search_path public, owner unchanged; EXECUTE for
--      authenticated (and the existing service_role grant), none for PUBLIC or anon.
--   3. Self-check: the stored body matches the live md5, the settings match, and the 202611040001 trigger that
--      enforces "Confirmed needs an ACTIVE psychologist" is in place.
--
-- HOW THE FUNCTION AND THE TRIGGER SHARE THE RULES (no conflicting duplicates)
--   * Function (live, unchanged): request validation, row lock, expected status, Confirmed/Lost final,
--     transition matrix, Lost reason, follow-up validation, clears on Confirmed/Lost, 4-event limit,
--     history rows. Its messages are the ones staff see today.
--   * Trigger enforce_lead_workflow (202611040001): the SAME final-status and transition rules (identical
--     matrix, so they can never disagree) for every write path, including direct UPDATEs that bypass the
--     function; staff-only status/assignment changes; Confirmed needs an ACTIVE assigned psychologist (the
--     only place this rule lives); Lost needs a reason on every path.
--
-- DEPLOYMENT
--   Only inside the atomic bundle (scripts/build-deploy-bundle.mjs), after 202611030002 and 202611040001.
--
-- KNOWN GAP (separate, later migration): history rows are written with staff_member = NULL, as on live.

BEGIN;

-- 0. Prerequisites: 202611030002 (assigned_psychologist_id) and 202611040001 (workflow trigger) in this transaction.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'assigned_psychologist_id'
  ) THEN
    RAISE EXCEPTION 'leads.assigned_psychologist_id is missing. Apply 202611030002 first, in the same transaction.';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgrelid = 'public.leads'::regclass AND tgname = 'leads_enforce_workflow' AND NOT tgisinternal
  ) OR position('is not active' IN coalesce(
       (SELECT prosrc FROM pg_proc WHERE oid = to_regprocedure('public.enforce_lead_workflow()')), '')) = 0 THEN
    RAISE EXCEPTION 'The 202611040001 lead workflow trigger is missing. Apply 202611040001 first, in the same transaction.';
  END IF;
END
$$;

-- 1. The live function, verbatim.
CREATE OR REPLACE FUNCTION public.update_lead_with_history(p_lead_id uuid, p_expected_status text, p_changes jsonb, p_events jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
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
        'status',
        'next_follow_up_at',
        'assigned_staff',
        'assigned_psychologist_id',
        'not_converted_reason',
        'service_interest',
        'notes',
        'source',
        'contact_method',
        'updated_at'
    ];

BEGIN
    IF p_lead_id IS NULL
       OR p_expected_status IS NULL
       OR jsonb_typeof(changes) <> 'object'
    THEN
        RAISE EXCEPTION 'Invalid lead status update request.'
        USING ERRCODE = '22023';
    END IF;

    IF changes ? 'status'
       AND COALESCE(changes->>'status', '') NOT IN (
           'Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost'
       )
    THEN
        RAISE EXCEPTION 'Choose a valid lead status.'
        USING ERRCODE = '22023';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM jsonb_object_keys(changes) AS supplied(key)
        WHERE NOT supplied.key = ANY(allowed_columns)
    ) THEN
        RAISE EXCEPTION 'The update contains an unsupported lead field.'
        USING ERRCODE = '22023';
    END IF;

    IF p_events IS NOT NULL
       AND jsonb_typeof(p_events) <> 'array'
    THEN
        RAISE EXCEPTION 'Invalid activity history.'
        USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(COALESCE(p_events, '[]'::jsonb)) > 4 THEN
        RAISE EXCEPTION 'Too many history entries for one lead update.'
        USING ERRCODE = '22023';
    END IF;

    SELECT COUNT(*)
    INTO status_event_count
    FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) AS items(value)
    WHERE value->>'type' = 'status';

    IF status_event_count > 1 THEN
        RAISE EXCEPTION 'A lead update cannot contain duplicate status history entries.'
        USING ERRCODE = '22023';
    END IF;

    SELECT *
    INTO current_lead
    FROM public.leads
    WHERE id = p_lead_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'This lead no longer exists. Refresh the page and try again.'
        USING ERRCODE = 'P0001';
    END IF;

    IF current_lead.status IS DISTINCT FROM p_expected_status THEN
        RAISE EXCEPTION 'This lead was changed elsewhere. Refresh it before making another change.'
        USING ERRCODE = 'P0001';
    END IF;

    target_status := COALESCE(changes->>'status', current_lead.status);

    IF (
        target_status IS DISTINCT FROM current_lead.status
        AND status_event_count <> 1
    ) OR (
        target_status IS NOT DISTINCT FROM current_lead.status
        AND status_event_count <> 0
    ) THEN
        RAISE EXCEPTION 'The status history does not match the requested status change.'
        USING ERRCODE = '22023';
    END IF;

    IF target_status IS DISTINCT FROM current_lead.status
       AND current_lead.status IN ('Confirmed', 'Lost')
    THEN
        RAISE EXCEPTION 'Confirmed and lost leads cannot be reopened or converted again.'
        USING ERRCODE = 'P0001';
    END IF;

    IF target_status IS DISTINCT FROM current_lead.status
       AND NOT (
            (current_lead.status = 'Enquiry' AND target_status IN ('Yet to Confirm', 'Lost'))
            OR (current_lead.status = 'Yet to Confirm' AND target_status IN ('Enquiry', 'Will Inform', 'Lost'))
            OR (current_lead.status = 'Will Inform' AND target_status IN ('Yet to Confirm', 'Confirmed', 'Lost'))
       )
    THEN
        RAISE EXCEPTION 'This lead cannot move from % to %.', current_lead.status, target_status
        USING ERRCODE = 'P0001';
    END IF;

    IF target_status = 'Lost'
       AND NULLIF(BTRIM(changes->>'not_converted_reason'), '') IS NULL
       AND current_lead.status IS DISTINCT FROM 'Lost'
    THEN
        RAISE EXCEPTION 'Add a reason before marking this lead as lost.'
        USING ERRCODE = '22023';
    END IF;

    IF changes ? 'next_follow_up_at' THEN
        IF NULLIF(BTRIM(changes->>'next_follow_up_at'), '') IS NULL THEN
            changes := jsonb_set(changes, '{next_follow_up_at}', 'null'::jsonb, true);
        ELSE
            BEGIN
                PERFORM (changes->>'next_follow_up_at')::timestamptz;
            EXCEPTION WHEN OTHERS THEN
                RAISE EXCEPTION 'Enter a valid follow-up date and time.'
                USING ERRCODE = '22023';
            END;
        END IF;
    END IF;

    IF target_status IN ('Confirmed', 'Lost') THEN
        changes := jsonb_set(changes, '{next_follow_up_at}', 'null'::jsonb, true);
    END IF;

    IF target_status = 'Confirmed' THEN
        changes := jsonb_set(changes, '{not_converted_reason}', 'null'::jsonb, true);
    END IF;

    FOR v_column_name IN SELECT jsonb_object_keys(changes)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns AS c
            WHERE c.table_schema = 'public'
              AND c.table_name = 'leads'
              AND c.column_name = v_column_name
        ) THEN
            IF changes->v_column_name = 'null'::jsonb
               OR changes->>v_column_name = ''
            THEN
                changes := changes - v_column_name;
                CONTINUE;
            END IF;

            RAISE EXCEPTION 'The leads table is missing the % column.', v_column_name
            USING ERRCODE = 'P0001';
        END IF;

        assignments := assignments ||
            CASE WHEN assignments = '' THEN '' ELSE ', ' END ||
            format(
                '%1$I = (jsonb_populate_record(NULL::public.leads, $1)).%1$I',
                v_column_name
            );
    END LOOP;

    IF assignments <> '' THEN
        EXECUTE format(
            'UPDATE public.leads AS l
             SET %s
             WHERE l.id = $2
             RETURNING to_jsonb(l)',
            assignments
        )
        INTO saved_lead
        USING changes, p_lead_id;
    ELSE
        saved_lead := to_jsonb(current_lead);
    END IF;

    FOR event IN
        SELECT value
        FROM jsonb_array_elements(COALESCE(p_events, '[]'::jsonb)) AS items(value)
    LOOP
        event_type := CASE event->>'type'
            WHEN 'status' THEN 'Status change'
            WHEN 'followup' THEN 'Follow-up'
            WHEN 'update' THEN 'Lead update'
            ELSE NULL
        END;

        IF event_type IS NULL THEN
            RAISE EXCEPTION 'The history contains an unsupported event.'
            USING ERRCODE = '22023';
        END IF;

        INSERT INTO public.lead_activities (
            lead_id, activity_type, staff_member, notes
        )
        VALUES (
            p_lead_id, event_type, NULL, NULLIF(event->>'text', '')
        );
    END LOOP;

    RETURN jsonb_build_object(
        'ok', true,
        'lead', saved_lead,
        'events_saved', true
    );
END;
$function$;

-- 2. Live execute rights: authenticated only (service_role keeps its existing grant).
REVOKE ALL ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) TO authenticated;

-- 3. Self-check (NULL-safe).
DO $$
DECLARE
  fn_oid oid := to_regprocedure('public.update_lead_with_history(uuid,text,jsonb,jsonb)');
  def record;
BEGIN
  IF fn_oid IS NULL THEN
    RAISE EXCEPTION 'update_lead_with_history(uuid,text,jsonb,jsonb) does not exist.';
  END IF;

  SELECT p.prosecdef, p.provolatile, p.proconfig, p.prosrc, p.prorettype INTO def
  FROM pg_proc AS p WHERE p.oid = fn_oid;

  IF md5(replace(def.prosrc, E'\r', '')) IS DISTINCT FROM '0d07f2ccc6f8e6b1737d4cacc8103804' THEN
    RAISE EXCEPTION 'update_lead_with_history body does not match the live definition.';
  END IF;
  IF def.prosecdef IS DISTINCT FROM false
     OR def.provolatile IS DISTINCT FROM 'v'
     OR def.prorettype IS DISTINCT FROM 'jsonb'::regtype
     OR coalesce(def.proconfig, ARRAY[]::text[]) IS DISTINCT FROM ARRAY['search_path=public'] THEN
    RAISE EXCEPTION 'update_lead_with_history settings differ from live (expected SECURITY INVOKER, VOLATILE, search_path=public).';
  END IF;

  IF has_function_privilege('anon', fn_oid, 'EXECUTE') IS DISTINCT FROM false
     OR has_function_privilege('authenticated', fn_oid, 'EXECUTE') IS DISTINCT FROM true
     OR EXISTS (SELECT 1 FROM pg_proc AS p, aclexplode(p.proacl) AS a
                WHERE p.oid = fn_oid AND a.grantee = 0) THEN
    RAISE EXCEPTION 'update_lead_with_history execute rights differ from live (authenticated only, no PUBLIC/anon).';
  END IF;
END
$$;

COMMIT;
