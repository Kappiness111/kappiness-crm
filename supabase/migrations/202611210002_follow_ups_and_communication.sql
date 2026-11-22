-- Kappiness CRM: follow-ups (Type A / Type B), communication status and contact history.
-- Owner: Sariga (follow-up workflow).
--
-- WHY
--   follow_up_recommendations records what the psychologist recommended. There is nowhere to track the
--   follow-up work itself: who must contact the client, whether the client answered, and the next session
--   that is being arranged. Reception keeps this outside the CRM today.
--
-- WHAT THIS ADDS (nothing existing is changed)
--   public.follow_ups              one row per follow-up.
--     follow_up_type        'Type A' = the client's next therapy session.
--                           'Type B' = a reception follow-up to contact the client again.
--     status                Upcoming | Tentative | Pending Confirmation | Contact Needed | Completed |
--                           No Follow-up Required. Tentative and Pending Confirmation hold a proposed slot
--                           (see 202611210003).
--     confirmation_status   Not Requested | Awaiting Client | Confirmed | Declined (the client's answer to a
--                           proposed slot; separate from status).
--     communication_status  Reminder Pending | Message Sent | Call Completed | Client Responded | No Response |
--                           Client Will Inform. Separate from appointment status and from the delivery status
--                           of appointment_reminders.
--   public.follow_up_contacts      append-only contact history (every communication status change).
--   public.follow_ups_with_status  view: adds due_date and due_state (Overdue / Due Today / Later / No Date),
--                                  computed in clinic_timezone(), never stored, plus the reminder status of
--                                  the booked appointment read from appointment_reminders (not copied).
--   Functions (SECURITY DEFINER, permission-checked):
--     create_follow_up(...)                               staff; or the psychologist, for Type A of own client
--     set_follow_up_communication_status(id, status, note) staff. Writes a contact-history row.
--                                                          'No Response' opens exactly one Type B
--                                                          'Contact Needed' follow-up per client (unique index).
--     close_follow_up(id, status, note)                   staff. Completed / No Follow-up Required.
--
-- ACCESS
--   Staff (is_crm_staff(), membership-based since 202611130001) read everything. A psychologist reads only rows
--   with psychologist_id = current_psychologist_id(). Nobody writes the tables directly: functions only.
--
-- PREREQUISITES
--   202611040001, 202611130001 (membership-based is_crm_staff), 202611130002 (appointment_reminders),
--   202611210001 (current_psychologist_id requires an active psychologist). Checked below.
--
-- AFTER APPLYING
--   1. As staff: create_follow_up for a test client, then set_follow_up_communication_status(id, 'No Response', ..)
--      twice. Expected: 2 contact rows, exactly 1 open Type B 'Contact Needed' follow-up for that client.
--   2. As a psychologist: SELECT from follow_ups_with_status returns only their own rows.
--   3. Direct INSERT/UPDATE/DELETE on follow_ups or follow_up_contacts as authenticated: permission denied.
--   Do NOT deploy with `supabase db push` (see supabase/migrations/README.md).
--
-- ROLLBACK (drops follow-up data and contact history)
--   BEGIN;
--   DROP VIEW IF EXISTS public.follow_ups_with_status;
--   DROP FUNCTION IF EXISTS public.create_follow_up(uuid, text, uuid, date, uuid, text),
--     public.set_follow_up_communication_status(uuid, text, text), public.close_follow_up(uuid, text, text);
--   DROP TABLE IF EXISTS public.follow_up_contacts, public.follow_ups;
--   COMMIT;
--   (Apply the 202611210003 rollback first: it depends on follow_ups.)
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).

BEGIN;

/* =====================================================================
   0. Prerequisites
   ===================================================================== */
DO $$
BEGIN
  IF to_regclass('public.follow_up_recommendations') IS NULL OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.sessions') IS NULL OR to_regclass('public.clients') IS NULL
     OR to_regclass('public.crm_staff_members') IS NULL OR to_regclass('public.appointment_reminders') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611030001, 202611040001 and 202611130002 first.';
  END IF;
  IF to_regprocedure('public.is_crm_staff()') IS NULL OR to_regprocedure('public.current_psychologist_id()') IS NULL
     OR to_regprocedure('public.current_actor_name()') IS NULL OR to_regprocedure('public.clinic_timezone()') IS NULL
     OR to_regprocedure('public._log_client_activity(uuid, text)') IS NULL THEN
    RAISE EXCEPTION 'Role helpers or _log_client_activity are missing. Apply 202611040001 first.';
  END IF;
  -- Refuse to build on the insecure 202611040001 helper (any signed-in non-psychologist counted as staff).
  IF position('crm_staff_members' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.is_crm_staff()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'is_crm_staff() is not membership-based. Apply 202611130001 first.';
  END IF;
  IF position('is_active' IN (SELECT prosrc FROM pg_proc WHERE oid = 'public.current_psychologist_id()'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'current_psychologist_id() does not require an active psychologist. Apply 202611210001 first.';
  END IF;
END
$$;

/* =====================================================================
   1. Follow-ups
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.follow_ups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follow_up_type text NOT NULL CHECK (follow_up_type IN ('Type A', 'Type B')),
  status text NOT NULL DEFAULT 'Upcoming'
    CHECK (status IN ('Upcoming', 'Tentative', 'Pending Confirmation', 'Contact Needed', 'Completed', 'No Follow-up Required')),
  recommendation_id uuid REFERENCES public.follow_up_recommendations(id) ON DELETE RESTRICT,
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE RESTRICT,       -- the booked follow-up appointment
  session_id uuid REFERENCES public.sessions(id) ON DELETE RESTRICT,               -- the session of that appointment
  previous_session_id uuid REFERENCES public.sessions(id) ON DELETE RESTRICT,      -- the session this follows
  source_follow_up_id uuid REFERENCES public.follow_ups(id) ON DELETE RESTRICT,    -- Type B opened from this one
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  session_number integer CHECK (session_number BETWEEN 1 AND 1000),
  due_on date,                                                                       -- clinic-local due day
  proposed_starts_at timestamptz,
  proposed_ends_at timestamptz,
  proposed_blocked_until timestamptz,                                                -- proposed_ends_at + service buffer
  proposed_service_id uuid REFERENCES public.services(id) ON DELETE RESTRICT,
  confirmation_status text NOT NULL DEFAULT 'Not Requested'
    CHECK (confirmation_status IN ('Not Requested', 'Awaiting Client', 'Confirmed', 'Declined')),
  assigned_staff_id uuid REFERENCES public.crm_staff_members(user_id) ON DELETE SET NULL,
  communication_status text NOT NULL DEFAULT 'Reminder Pending'
    CHECK (communication_status IN ('Reminder Pending', 'Message Sent', 'Call Completed', 'Client Responded',
                                    'No Response', 'Client Will Inform')),
  communication_updated_at timestamptz,
  notes text CHECK (char_length(notes) <= 2000),
  closed_at timestamptz,
  closed_by uuid,
  closed_by_name text,
  created_by uuid DEFAULT auth.uid(),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A therapy-session follow-up always belongs to a psychologist.
  CONSTRAINT follow_ups_type_a_has_psychologist CHECK (follow_up_type <> 'Type A' OR psychologist_id IS NOT NULL),
  CONSTRAINT follow_ups_proposed_range CHECK (
    (proposed_starts_at IS NULL) = (proposed_ends_at IS NULL)
    AND (proposed_ends_at IS NULL OR proposed_ends_at > proposed_starts_at)
    AND (proposed_blocked_until IS NULL OR proposed_blocked_until >= proposed_ends_at)
  ),
  -- Tentative / Pending Confirmation are holds: they need a complete proposed slot.
  CONSTRAINT follow_ups_hold_is_complete CHECK (
    status NOT IN ('Tentative', 'Pending Confirmation')
    OR (psychologist_id IS NOT NULL AND proposed_starts_at IS NOT NULL AND proposed_blocked_until IS NOT NULL
        AND proposed_service_id IS NOT NULL)
  ),
  CONSTRAINT follow_ups_closed_has_time CHECK ((status IN ('Completed', 'No Follow-up Required')) = (closed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_follow_ups_client ON public.follow_ups (client_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_psychologist_due ON public.follow_ups (psychologist_id, due_on);
CREATE INDEX IF NOT EXISTS idx_follow_ups_status_due ON public.follow_ups (status, due_on);
CREATE INDEX IF NOT EXISTS idx_follow_ups_assigned_staff ON public.follow_ups (assigned_staff_id);
CREATE INDEX IF NOT EXISTS idx_follow_ups_appointment ON public.follow_ups (appointment_id);
-- Exactly one open reception contact task per client ('No Response' relies on this; ON CONFLICT targets it).
CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_one_open_contact_needed ON public.follow_ups (client_id)
  WHERE follow_up_type = 'Type B' AND status = 'Contact Needed';
-- At most one open Type A follow-up per recommendation.
CREATE UNIQUE INDEX IF NOT EXISTS follow_ups_one_open_per_recommendation ON public.follow_ups (recommendation_id)
  WHERE follow_up_type = 'Type A' AND recommendation_id IS NOT NULL
    AND status NOT IN ('Completed', 'No Follow-up Required');

/* =====================================================================
   2. Contact history (append-only: no write grants; written only by set_follow_up_communication_status)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.follow_up_contacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  follow_up_id uuid NOT NULL REFERENCES public.follow_ups(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  previous_status text,
  communication_status text NOT NULL
    CHECK (communication_status IN ('Reminder Pending', 'Message Sent', 'Call Completed', 'Client Responded',
                                    'No Response', 'Client Will Inform')),
  note text CHECK (char_length(note) <= 1000),
  created_follow_up_id uuid REFERENCES public.follow_ups(id) ON DELETE RESTRICT, -- Type B opened by this contact
  contacted_by uuid DEFAULT auth.uid(),
  contacted_by_name text,
  contacted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_follow_up_contacts_follow_up ON public.follow_up_contacts (follow_up_id, contacted_at);
CREATE INDEX IF NOT EXISTS idx_follow_up_contacts_client ON public.follow_up_contacts (client_id, contacted_at);

/* =====================================================================
   3. View: due state computed in clinic time, reminder status read from appointment_reminders
   security_invoker: the caller's RLS applies to every table read (psychologists get NULL reminder columns,
   because appointment_reminders is staff-only).
   ===================================================================== */

CREATE OR REPLACE VIEW public.follow_ups_with_status
WITH (security_invoker = true) AS
SELECT
  f.id, f.follow_up_type, f.status, f.recommendation_id, f.appointment_id, f.session_id, f.previous_session_id,
  f.source_follow_up_id, f.client_id, f.psychologist_id, f.session_number, f.due_on,
  f.proposed_starts_at, f.proposed_ends_at, f.proposed_blocked_until, f.proposed_service_id,
  f.confirmation_status, f.assigned_staff_id, f.communication_status, f.communication_updated_at, f.notes,
  f.closed_at, f.closed_by, f.closed_by_name, f.created_by, f.created_by_name, f.created_at,
  f.updated_by, f.updated_by_name, f.updated_at,
  c.full_name AS client_name,
  d.due_date,
  CASE
    WHEN f.status IN ('Completed', 'No Follow-up Required') THEN NULL
    WHEN d.due_date IS NULL THEN 'No Date'
    WHEN d.due_date < d.today THEN 'Overdue'
    WHEN d.due_date = d.today THEN 'Due Today'
    ELSE 'Later'
  END AS due_state,
  r1.delivery_status AS reminder_1_status,
  r1.client_response AS reminder_1_response,
  r2.delivery_status AS reminder_2_status,
  r2.client_response AS reminder_2_response
FROM public.follow_ups AS f
LEFT JOIN public.clients AS c ON c.id = f.client_id
CROSS JOIN LATERAL (
  SELECT coalesce((f.proposed_starts_at AT TIME ZONE public.clinic_timezone())::date, f.due_on) AS due_date,
         (now() AT TIME ZONE public.clinic_timezone())::date AS today
) AS d
LEFT JOIN public.appointment_reminders AS r1 ON r1.appointment_id = f.appointment_id AND r1.reminder_number = 1
LEFT JOIN public.appointment_reminders AS r2 ON r2.appointment_id = f.appointment_id AND r2.reminder_number = 2;

/* =====================================================================
   4. Functions
   ===================================================================== */

-- Create a follow-up. Type A starts as Upcoming, Type B as Contact Needed.
CREATE OR REPLACE FUNCTION public.create_follow_up(
  p_client_id uuid,
  p_follow_up_type text,
  p_recommendation_id uuid DEFAULT NULL,
  p_due_on date DEFAULT NULL,
  p_assigned_staff_id uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cli public.clients%ROWTYPE;
  rec public.follow_up_recommendations%ROWTYPE;
  saved public.follow_ups%ROWTYPE;
  v_psychologist uuid;
  v_previous uuid;
  v_number integer;
  v_staff boolean := coalesce(public.is_crm_staff(), false);
  v_today date := (now() AT TIME ZONE public.clinic_timezone())::date;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to create follow-ups.' USING ERRCODE = '42501';
  END IF;
  IF p_follow_up_type IS NULL OR p_follow_up_type NOT IN ('Type A', 'Type B') THEN
    RAISE EXCEPTION 'Choose Type A (next session) or Type B (contact the client again).' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO cli FROM public.clients WHERE id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;

  IF p_recommendation_id IS NOT NULL THEN
    SELECT * INTO rec FROM public.follow_up_recommendations WHERE id = p_recommendation_id FOR UPDATE;
    IF NOT FOUND OR rec.client_id <> p_client_id THEN
      RAISE EXCEPTION 'That recommendation does not belong to this client.' USING ERRCODE = 'P0001';
    END IF;
    IF rec.status <> 'Open' THEN
      RAISE EXCEPTION 'That recommendation has already been scheduled or closed.' USING ERRCODE = 'P0001';
    END IF;
    v_psychologist := rec.psychologist_id;
    v_previous := rec.session_id;
  ELSE
    v_psychologist := cli.primary_psychologist_id;
    SELECT s.id INTO v_previous FROM public.sessions AS s
      WHERE s.client_id = p_client_id AND s.status = 'Completed'
      ORDER BY s.starts_at DESC LIMIT 1;
  END IF;

  -- coalesce: a NULL must mean "no" (NOT NULL would let the caller through).
  IF NOT (v_staff OR coalesce(p_follow_up_type = 'Type A' AND v_psychologist = public.current_psychologist_id(), false)) THEN
    RAISE EXCEPTION 'You do not have permission to create this follow-up.' USING ERRCODE = '42501';
  END IF;
  IF p_assigned_staff_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.crm_staff_members AS m WHERE m.user_id = p_assigned_staff_id AND m.is_active
  ) THEN
    RAISE EXCEPTION 'Assign the follow-up to an active staff member.' USING ERRCODE = 'P0001';
  END IF;
  IF p_due_on IS NOT NULL AND p_due_on < v_today THEN
    RAISE EXCEPTION 'Choose a due date from today onwards.' USING ERRCODE = '22023';
  END IF;

  IF p_follow_up_type = 'Type A' THEN
    SELECT count(*) + 1 INTO v_number FROM public.sessions AS s
      WHERE s.client_id = p_client_id AND s.status = 'Completed';
  END IF;

  BEGIN
    INSERT INTO public.follow_ups (
      follow_up_type, status, recommendation_id, previous_session_id, client_id, psychologist_id, session_number,
      due_on, assigned_staff_id, notes, created_by, created_by_name, updated_by, updated_by_name
    ) VALUES (
      p_follow_up_type, CASE WHEN p_follow_up_type = 'Type A' THEN 'Upcoming' ELSE 'Contact Needed' END,
      p_recommendation_id, v_previous, p_client_id, v_psychologist, v_number,
      coalesce(p_due_on, rec.recommended_date, v_today), p_assigned_staff_id, nullif(btrim(p_notes), ''),
      auth.uid(), public.current_actor_name(), auth.uid(), public.current_actor_name()
    ) RETURNING * INTO saved;
  EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'An open follow-up of this kind already exists for this client.' USING ERRCODE = '23505';
  END;

  PERFORM public._log_client_activity(p_client_id, format('Follow-up created (%s)', p_follow_up_type));
  RETURN saved;
END;
$$;

-- Record a contact attempt / client answer. 'No Response' opens one Type B 'Contact Needed' follow-up for reception.
CREATE OR REPLACE FUNCTION public.set_follow_up_communication_status(p_follow_up_id uuid, p_status text, p_note text DEFAULT NULL)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
  v_new_id uuid;
BEGIN
  IF NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can update follow-up communication.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('Reminder Pending', 'Message Sent', 'Call Completed', 'Client Responded',
                                          'No Response', 'Client Will Inform') THEN
    RAISE EXCEPTION 'Choose a valid communication status.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status IN ('Completed', 'No Follow-up Required') THEN
    RAISE EXCEPTION 'This follow-up is already closed.' USING ERRCODE = 'P0001';
  END IF;

  IF p_status = 'No Response' THEN
    -- The partial unique index makes this race-safe: a second 'No Response' (here or concurrently) adds nothing.
    INSERT INTO public.follow_ups (
      follow_up_type, status, recommendation_id, previous_session_id, source_follow_up_id, client_id,
      psychologist_id, due_on, assigned_staff_id, communication_status, communication_updated_at, notes,
      created_by, created_by_name, updated_by, updated_by_name
    ) VALUES (
      'Type B', 'Contact Needed', f.recommendation_id, coalesce(f.session_id, f.previous_session_id), f.id, f.client_id,
      f.psychologist_id, (now() AT TIME ZONE public.clinic_timezone())::date, f.assigned_staff_id, 'No Response', now(),
      'Client did not respond. Contact the client again.',
      auth.uid(), public.current_actor_name(), auth.uid(), public.current_actor_name()
    )
    ON CONFLICT (client_id) WHERE follow_up_type = 'Type B' AND status = 'Contact Needed' DO NOTHING
    RETURNING id INTO v_new_id;
  END IF;

  INSERT INTO public.follow_up_contacts (
    follow_up_id, client_id, previous_status, communication_status, note, created_follow_up_id,
    contacted_by, contacted_by_name
  ) VALUES (
    f.id, f.client_id, f.communication_status, p_status, nullif(btrim(p_note), ''), v_new_id,
    auth.uid(), public.current_actor_name()
  );

  UPDATE public.follow_ups
    SET communication_status = p_status, communication_updated_at = now(),
        updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_follow_up_id
    RETURNING * INTO f;

  PERFORM public._log_client_activity(f.client_id,
    format('Follow-up communication: %s%s', p_status,
           CASE WHEN nullif(btrim(p_note), '') IS NULL THEN '' ELSE ' (' || btrim(p_note) || ')' END));
  RETURN f;
END;
$$;

-- Close a follow-up. Closing also releases a held slot (holds only exist while Tentative / Pending Confirmation).
CREATE OR REPLACE FUNCTION public.close_follow_up(p_follow_up_id uuid, p_status text, p_note text)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can close follow-ups.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('Completed', 'No Follow-up Required') THEN
    RAISE EXCEPTION 'Choose Completed or No Follow-up Required.' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_note), '') IS NULL THEN
    RAISE EXCEPTION 'Add a note for closing the follow-up.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status IN ('Completed', 'No Follow-up Required') THEN
    RAISE EXCEPTION 'This follow-up is already closed.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.follow_ups
    SET status = p_status, notes = left(concat_ws(E'\n', notes, btrim(p_note)), 2000),
        closed_at = now(), closed_by = auth.uid(), closed_by_name = public.current_actor_name(),
        updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_follow_up_id
    RETURNING * INTO f;
  PERFORM public._log_client_activity(f.client_id, format('Follow-up %s: %s', lower(p_status), btrim(p_note)));
  RETURN f;
END;
$$;

/* =====================================================================
   5. Row Level Security and grants: staff read all, a psychologist reads own rows; writes via functions only.
   ===================================================================== */

ALTER TABLE public.follow_ups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_contacts ENABLE ROW LEVEL SECURITY;

-- Default privileges in public grant ALL to anon and authenticated on new tables: take everything back.
REVOKE ALL ON TABLE public.follow_ups, public.follow_up_contacts, public.follow_ups_with_status
  FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.follow_ups, public.follow_up_contacts, public.follow_ups_with_status TO authenticated;

DROP POLICY IF EXISTS follow_ups_read ON public.follow_ups;
CREATE POLICY follow_ups_read ON public.follow_ups FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

DROP POLICY IF EXISTS follow_up_contacts_read ON public.follow_up_contacts;
CREATE POLICY follow_up_contacts_read ON public.follow_up_contacts FOR SELECT TO authenticated
  USING (
    public.is_crm_staff()
    OR EXISTS (SELECT 1 FROM public.follow_ups AS f
               WHERE f.id = follow_up_contacts.follow_up_id AND f.psychologist_id = public.current_psychologist_id())
  );

REVOKE ALL ON FUNCTION
  public.create_follow_up(uuid, text, uuid, date, uuid, text),
  public.set_follow_up_communication_status(uuid, text, text),
  public.close_follow_up(uuid, text, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.create_follow_up(uuid, text, uuid, date, uuid, text),
  public.set_follow_up_communication_status(uuid, text, text),
  public.close_follow_up(uuid, text, text)
TO authenticated;

COMMENT ON TABLE public.follow_ups IS
  'Follow-ups: Type A = next therapy session, Type B = reception contact task (202611210002). Written only by functions.';
COMMENT ON TABLE public.follow_up_contacts IS
  'Append-only contact history of follow_ups.communication_status (202611210002).';
COMMENT ON VIEW public.follow_ups_with_status IS
  'follow_ups plus due_state (Overdue / Due Today / Later / No Date, clinic time) and appointment reminder status (202611210002).';

/* =====================================================================
   6. Self-check
   ===================================================================== */
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.follow_ups', 'public.follow_up_contacts'] LOOP
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not enabled on %.', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE') IS DISTINCT FROM false
       OR has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'Unexpected write privileges on %.', t;
    END IF;
  END LOOP;
END
$$;

COMMIT;
