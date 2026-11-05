-- Kappiness CRM TEST BOOTSTRAP, step 3 of 4: bring the test project from the 27 Oct snapshot to the
-- live state of 4 Nov 2026, i.e. the state the deployment bundle will start from on production.
-- Owner: Aswathy (backend / testing).
--
-- TARGET: the separate, EMPTY Supabase project kappiness-crm-test ONLY. Never production.
-- Runs after step 1 (01_baseline_from_snapshot.sql) and step 2 (202611030001_crm_staff_membership_rls.sql).
--
-- WHERE EACH PART COMES FROM
--   [VERIFIED]  public.is_crm_staff() and public.update_lead_with_history(...) are copied verbatim
--               (line endings normalised to LF) from live_function_definitions.csv, with the live owner,
--               settings and EXECUTE grants (postgres, authenticated, service_role; not anon, not PUBLIC).
--   [VERIFIED]  Live status vocabulary: Enquiry, Yet to Confirm, Will Inform, Confirmed, Lost.
--   [VERIFIED]  psychologists: id uuid, auth_user_id uuid NOT NULL, full_name text NOT NULL,
--               is_active boolean NOT NULL.
--   [VERIFIED]  psychologist_availability: psychologist_id uuid, day_of_week smallint CHECK 1-7,
--               start_time / end_time time, is_active boolean DEFAULT true; RLS enabled, not forced;
--               five PERMISSIVE policies with the live names; anon has SELECT, INSERT, UPDATE, DELETE.
--   [ASSUMED]   Everything else below is marked ASSUMED: column defaults, primary keys, foreign keys,
--               psychologists.phone / created_at, availability id / created_at (both used by the app),
--               the live name of the status constraint, the expressions of the five live policies,
--               RLS on psychologists. Compare with the read-only queries in README.md before trusting
--               a test result that depends on them.
--
-- Contains no production data. Leaves every table empty, including crm_staff_members.

BEGIN;

-- 0. Guard: opted in, steps 1 and 2 done, still empty.
DO $$
BEGIN
  IF coalesce(current_setting('kappiness.test_env', true), '') <> 'disposable' THEN
    RAISE EXCEPTION 'Refusing to run: SET kappiness.test_env = ''disposable'' first (test project only).';
  END IF;
  IF to_regclass('public.leads') IS NULL OR to_regclass('public.crm_staff_members') IS NULL THEN
    RAISE EXCEPTION 'Run 01_baseline_from_snapshot.sql and 202611030001_crm_staff_membership_rls.sql first.';
  END IF;
  IF to_regclass('public.psychologists') IS NOT NULL OR to_regclass('public.appointments') IS NOT NULL THEN
    RAISE EXCEPTION 'Refusing to run: psychologists or appointments already exist (not a fresh test bootstrap).';
  END IF;
  IF EXISTS (SELECT 1 FROM public.leads) OR EXISTS (SELECT 1 FROM public.crm_staff_members)
     OR EXISTS (SELECT 1 FROM auth.users) THEN
    RAISE EXCEPTION 'Refusing to run: leads, crm_staff_members or auth.users has rows.';
  END IF;
END
$$;

-- 1. Live lead status vocabulary. [VERIFIED values; ASSUMED constraint name and default]
--    The name leads_status_check is what 202611030002 drops and recreates.
ALTER TABLE public.leads DROP CONSTRAINT leads_status_check;
ALTER TABLE public.leads
  ADD CONSTRAINT leads_status_check
  CHECK (status IN ('Enquiry', 'Yet to Confirm', 'Will Inform', 'Confirmed', 'Lost'));
ALTER TABLE public.leads ALTER COLUMN status SET DEFAULT 'Enquiry';

-- 2. Live public.is_crm_staff(), verbatim from live_function_definitions.csv. [VERIFIED]
CREATE OR REPLACE FUNCTION public.is_crm_staff()
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT auth.uid() IS NOT NULL
     AND EXISTS (
       SELECT 1
       FROM public.crm_staff_members AS staff
       WHERE staff.user_id = auth.uid()
         AND staff.is_active = true
     );
$function$;

REVOKE ALL ON FUNCTION public.is_crm_staff() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_crm_staff() TO authenticated, service_role;

-- 3. psychologists. [VERIFIED columns: id, auth_user_id, full_name, is_active]
CREATE TABLE public.psychologists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),                       -- ASSUMED: PK + default
  auth_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- ASSUMED: FK
  full_name text NOT NULL,
  phone text,                                                          -- ASSUMED (Sariga's actions.js selects it)
  is_active boolean NOT NULL DEFAULT true,                             -- ASSUMED: default
  created_at timestamptz NOT NULL DEFAULT now()                        -- ASSUMED (psychologistsApi.js orders by it)
);
CREATE INDEX idx_psychologists_auth_user_id ON public.psychologists (auth_user_id);

-- ASSUMED: RLS on psychologists, staff read all, a psychologist reads their own row. Only needed so the
-- live "own availability" policies below can look up the caller's profile. The bundle and the tests read
-- psychologists through SECURITY DEFINER functions, which this does not affect (FORCE RLS stays off).
ALTER TABLE public.psychologists ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bootstrap: staff can view psychologists" ON public.psychologists
  FOR SELECT TO authenticated USING (public.is_crm_staff());
CREATE POLICY "bootstrap: psychologists can view their own profile" ON public.psychologists
  FOR SELECT TO authenticated USING (auth_user_id = (SELECT auth.uid()));

-- 4. psychologist_availability. [VERIFIED columns/check; ASSUMED id, created_at, NOT NULLs, FK]
CREATE TABLE public.psychologist_availability (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE CASCADE,
  day_of_week smallint NOT NULL CHECK (day_of_week BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  is_active boolean DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_psychologist_availability_psychologist_id ON public.psychologist_availability (psychologist_id);

ALTER TABLE public.psychologist_availability ENABLE ROW LEVEL SECURITY;

-- The five live PERMISSIVE policies. [VERIFIED names and commands; ASSUMED expressions and roles]
CREATE POLICY "Active CRM staff can view psychologist availability" ON public.psychologist_availability
  FOR SELECT TO authenticated
  USING (public.is_crm_staff());
CREATE POLICY "Psychologists can read their own availability" ON public.psychologist_availability
  FOR SELECT TO authenticated
  USING (psychologist_id IN (SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = (SELECT auth.uid())));
CREATE POLICY "Psychologists can insert their own availability" ON public.psychologist_availability
  FOR INSERT TO authenticated
  WITH CHECK (psychologist_id IN (SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = (SELECT auth.uid())));
CREATE POLICY "Psychologists can update their own availability" ON public.psychologist_availability
  FOR UPDATE TO authenticated
  USING (psychologist_id IN (SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = (SELECT auth.uid())))
  WITH CHECK (psychologist_id IN (SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = (SELECT auth.uid())));
CREATE POLICY "Psychologists can delete their own availability" ON public.psychologist_availability
  FOR DELETE TO authenticated
  USING (psychologist_id IN (SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = (SELECT auth.uid())));

-- Live grants. [VERIFIED: anon SELECT, INSERT, UPDATE, DELETE. ASSUMED: authenticated keeps the
-- Supabase default ALL, including TRUNCATE, which 202611040005 must remove.]
REVOKE ALL ON TABLE public.psychologist_availability FROM PUBLIC, anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.psychologist_availability TO anon;
-- psychologists keeps the Supabase default grants. [ASSUMED]

-- 5. Live public.update_lead_with_history(...), verbatim from live_function_definitions.csv. [VERIFIED]
--    Replaces nothing: step 1 does not create the snapshot's legacy version.
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

REVOKE ALL ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_lead_with_history(uuid, text, jsonb, jsonb) TO authenticated, service_role;

COMMIT;
