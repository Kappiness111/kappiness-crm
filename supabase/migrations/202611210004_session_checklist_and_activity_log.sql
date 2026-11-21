-- Kappiness CRM: session checklist and a general activity log.
-- Owner: Sariga (session workflow).
--
-- WHY
--   Reception and psychologists tick off the steps of each session (arrival, start, end, next follow-up,
--   next booking, reminder) on paper. There is no record of who did what and when.
--   The existing logs do not fit: lead_activities is tied to leads (FK + fixed activity_type list), and
--   appointment_status_history / session_status_history only record status changes. So a general
--   public.activity_log is added; nothing existing is changed.
--
-- WHAT THIS ADDS
--   public.session_checklists  one row per appointment (and its session): six steps, each a boolean with the
--                              time it was ticked (client_arrived, session_started, session_completed,
--                              next_follow_up_discussed, next_appointment_booked, reminder_sent), updated_by.
--                              The checklist is a manual record: it does not change appointment, session or
--                              reminder status (record_attendance and the reminder RPCs still do that).
--   public.activity_log        append-only: entity_type, entity_id, action, actor, actor_name, details jsonb,
--                              created_at (+ client_id, psychologist_id for access control).
--   update_session_checklist(...)  SECURITY DEFINER; NULL = leave a step unchanged. Writes one activity_log row
--                                  with the changed steps (from/to) when anything changed.
--
-- ACCESS
--   Staff read all; a psychologist reads rows with psychologist_id = current_psychologist_id().
--   The checklist is written by staff or the appointment's psychologist (_can_manage_psychologist), via the
--   function only. activity_log cannot be updated or deleted by anyone (trigger + no write grants).
--
-- PREREQUISITES
--   202611040001 (appointments, sessions, role helpers), 202611130001, 202611210001.
--
-- AFTER APPLYING
--   1. update_session_checklist(appt, p_client_arrived => true): one checklist row, client_arrived_at set,
--      one activity_log row. Calling it again with the same value: no new activity_log row.
--   2. As another psychologist: the call is refused (42501) and SELECT returns 0 rows.
--   3. UPDATE / DELETE on activity_log (even as the owner): refused.
--   Do NOT deploy with `supabase db push` (see supabase/migrations/README.md).
--
-- ROLLBACK (drops checklist data and the activity log)
--   BEGIN;
--   DROP FUNCTION IF EXISTS public.update_session_checklist(uuid, boolean, boolean, boolean, boolean, boolean, boolean, text);
--   DROP TABLE IF EXISTS public.session_checklists, public.activity_log;
--   DROP FUNCTION IF EXISTS public.activity_log_append_only();
--   COMMIT;
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).

BEGIN;

/* =====================================================================
   0. Prerequisites (and: if an activity_log already exists, it must have the expected shape)
   ===================================================================== */
DO $$
BEGIN
  IF to_regclass('public.appointments') IS NULL OR to_regclass('public.sessions') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611040001 first.';
  END IF;
  IF to_regprocedure('public._can_manage_psychologist(uuid)') IS NULL
     OR to_regprocedure('public.current_actor_name()') IS NULL THEN
    RAISE EXCEPTION 'Role helpers are missing. Apply 202611040001 first.';
  END IF;
  IF to_regclass('public.activity_log') IS NOT NULL AND (
    SELECT count(*) FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'activity_log'
      AND column_name IN ('entity_type', 'entity_id', 'action', 'actor', 'actor_name', 'details', 'created_at',
                          'client_id', 'psychologist_id')) <> 9 THEN
    RAISE EXCEPTION 'public.activity_log exists with a different shape; review it before applying.';
  END IF;
END
$$;

/* =====================================================================
   1. Activity log (append-only)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.activity_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL CHECK (entity_type ~ '^[a-z_]{3,40}$'),
  entity_id uuid NOT NULL,
  action text NOT NULL CHECK (char_length(btrim(action)) BETWEEN 2 AND 80),
  actor uuid DEFAULT auth.uid(),
  actor_name text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  client_id uuid REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_activity_log_entity ON public.activity_log (entity_type, entity_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_client ON public.activity_log (client_id, created_at);
CREATE INDEX IF NOT EXISTS idx_activity_log_psychologist ON public.activity_log (psychologist_id, created_at);

CREATE OR REPLACE FUNCTION public.activity_log_append_only()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  RAISE EXCEPTION 'The activity log cannot be changed or deleted.' USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS activity_log_append_only ON public.activity_log;
CREATE TRIGGER activity_log_append_only
  BEFORE UPDATE OR DELETE ON public.activity_log
  FOR EACH ROW
  EXECUTE FUNCTION public.activity_log_append_only();

/* =====================================================================
   2. Session checklist (one row per appointment)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.session_checklists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES public.appointments(id) ON DELETE RESTRICT,
  session_id uuid UNIQUE REFERENCES public.sessions(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  client_arrived boolean NOT NULL DEFAULT false,
  client_arrived_at timestamptz,
  session_started boolean NOT NULL DEFAULT false,
  session_started_at timestamptz,
  session_completed boolean NOT NULL DEFAULT false,
  session_completed_at timestamptz,
  next_follow_up_discussed boolean NOT NULL DEFAULT false,
  next_follow_up_discussed_at timestamptz,
  next_appointment_booked boolean NOT NULL DEFAULT false,
  next_appointment_booked_at timestamptz,
  reminder_sent boolean NOT NULL DEFAULT false,
  reminder_sent_at timestamptz,
  updated_by uuid DEFAULT auth.uid(),
  updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- A ticked step always has its time; an unticked step never does.
  CONSTRAINT session_checklists_arrived_time CHECK (client_arrived = (client_arrived_at IS NOT NULL)),
  CONSTRAINT session_checklists_started_time CHECK (session_started = (session_started_at IS NOT NULL)),
  CONSTRAINT session_checklists_completed_time CHECK (session_completed = (session_completed_at IS NOT NULL)),
  CONSTRAINT session_checklists_discussed_time CHECK (next_follow_up_discussed = (next_follow_up_discussed_at IS NOT NULL)),
  CONSTRAINT session_checklists_booked_time CHECK (next_appointment_booked = (next_appointment_booked_at IS NOT NULL)),
  CONSTRAINT session_checklists_reminder_time CHECK (reminder_sent = (reminder_sent_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_session_checklists_psychologist ON public.session_checklists (psychologist_id);
CREATE INDEX IF NOT EXISTS idx_session_checklists_client ON public.session_checklists (client_id);

/* =====================================================================
   3. Function
   ===================================================================== */

-- Tick or untick checklist steps. NULL leaves a step as it is. Ticking sets the time to now(), unticking clears it.
CREATE OR REPLACE FUNCTION public.update_session_checklist(
  p_appointment_id uuid,
  p_client_arrived boolean DEFAULT NULL,
  p_session_started boolean DEFAULT NULL,
  p_session_completed boolean DEFAULT NULL,
  p_next_follow_up_discussed boolean DEFAULT NULL,
  p_next_appointment_booked boolean DEFAULT NULL,
  p_reminder_sent boolean DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS public.session_checklists
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  appt public.appointments%ROWTYPE;
  old_row public.session_checklists%ROWTYPE;
  saved public.session_checklists%ROWTYPE;
  v_session uuid;
  v_changes jsonb;
BEGIN
  SELECT * INTO appt FROM public.appointments WHERE id = p_appointment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT coalesce(public._can_manage_psychologist(appt.psychologist_id), false) THEN
    RAISE EXCEPTION 'You do not have permission to update this checklist.' USING ERRCODE = '42501';
  END IF;
  IF appt.status IN ('Cancelled', 'Rescheduled') THEN
    RAISE EXCEPTION 'A % appointment has no checklist to update.', appt.status USING ERRCODE = 'P0001';
  END IF;
  IF p_note IS NOT NULL AND char_length(p_note) > 1000 THEN
    RAISE EXCEPTION 'Keep the note under 1000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT s.id INTO v_session FROM public.sessions AS s WHERE s.appointment_id = appt.id;
  INSERT INTO public.session_checklists (appointment_id, session_id, client_id, psychologist_id, updated_by, updated_by_name)
  VALUES (appt.id, v_session, appt.client_id, appt.psychologist_id, auth.uid(), public.current_actor_name())
  ON CONFLICT (appointment_id) DO NOTHING;
  SELECT * INTO old_row FROM public.session_checklists WHERE appointment_id = appt.id FOR UPDATE;

  -- SET expressions read the old row values.
  UPDATE public.session_checklists SET
    client_arrived = coalesce(p_client_arrived, client_arrived),
    client_arrived_at = CASE WHEN p_client_arrived IS NULL OR p_client_arrived = client_arrived THEN client_arrived_at
                             WHEN p_client_arrived THEN now() END,
    session_started = coalesce(p_session_started, session_started),
    session_started_at = CASE WHEN p_session_started IS NULL OR p_session_started = session_started THEN session_started_at
                              WHEN p_session_started THEN now() END,
    session_completed = coalesce(p_session_completed, session_completed),
    session_completed_at = CASE WHEN p_session_completed IS NULL OR p_session_completed = session_completed THEN session_completed_at
                                WHEN p_session_completed THEN now() END,
    next_follow_up_discussed = coalesce(p_next_follow_up_discussed, next_follow_up_discussed),
    next_follow_up_discussed_at = CASE WHEN p_next_follow_up_discussed IS NULL OR p_next_follow_up_discussed = next_follow_up_discussed
                                       THEN next_follow_up_discussed_at
                                       WHEN p_next_follow_up_discussed THEN now() END,
    next_appointment_booked = coalesce(p_next_appointment_booked, next_appointment_booked),
    next_appointment_booked_at = CASE WHEN p_next_appointment_booked IS NULL OR p_next_appointment_booked = next_appointment_booked
                                      THEN next_appointment_booked_at
                                      WHEN p_next_appointment_booked THEN now() END,
    reminder_sent = coalesce(p_reminder_sent, reminder_sent),
    reminder_sent_at = CASE WHEN p_reminder_sent IS NULL OR p_reminder_sent = reminder_sent THEN reminder_sent_at
                            WHEN p_reminder_sent THEN now() END,
    session_id = coalesce(session_id, v_session),
    updated_by = auth.uid(),
    updated_by_name = public.current_actor_name(),
    updated_at = now()
  WHERE id = old_row.id
  RETURNING * INTO saved;

  -- Only the steps that changed, as {"step": {"from": old, "to": new}}.
  v_changes := jsonb_strip_nulls(jsonb_build_object(
    'client_arrived', CASE WHEN saved.client_arrived IS DISTINCT FROM old_row.client_arrived
      THEN jsonb_build_object('from', old_row.client_arrived, 'to', saved.client_arrived) END,
    'session_started', CASE WHEN saved.session_started IS DISTINCT FROM old_row.session_started
      THEN jsonb_build_object('from', old_row.session_started, 'to', saved.session_started) END,
    'session_completed', CASE WHEN saved.session_completed IS DISTINCT FROM old_row.session_completed
      THEN jsonb_build_object('from', old_row.session_completed, 'to', saved.session_completed) END,
    'next_follow_up_discussed', CASE WHEN saved.next_follow_up_discussed IS DISTINCT FROM old_row.next_follow_up_discussed
      THEN jsonb_build_object('from', old_row.next_follow_up_discussed, 'to', saved.next_follow_up_discussed) END,
    'next_appointment_booked', CASE WHEN saved.next_appointment_booked IS DISTINCT FROM old_row.next_appointment_booked
      THEN jsonb_build_object('from', old_row.next_appointment_booked, 'to', saved.next_appointment_booked) END,
    'reminder_sent', CASE WHEN saved.reminder_sent IS DISTINCT FROM old_row.reminder_sent
      THEN jsonb_build_object('from', old_row.reminder_sent, 'to', saved.reminder_sent) END
  ));

  IF v_changes <> '{}'::jsonb THEN
    INSERT INTO public.activity_log (entity_type, entity_id, action, actor, actor_name, details, client_id, psychologist_id)
    VALUES ('session_checklist', saved.id, 'Checklist updated', auth.uid(), public.current_actor_name(),
            jsonb_strip_nulls(jsonb_build_object('appointment_id', appt.id, 'session_id', saved.session_id,
                                                 'changes', v_changes, 'note', nullif(btrim(p_note), ''))),
            appt.client_id, appt.psychologist_id);
  END IF;
  RETURN saved;
END;
$$;

/* =====================================================================
   4. Row Level Security and grants
   ===================================================================== */

ALTER TABLE public.session_checklists ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.activity_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.session_checklists, public.activity_log FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.session_checklists, public.activity_log TO authenticated;

DROP POLICY IF EXISTS session_checklists_read ON public.session_checklists;
CREATE POLICY session_checklists_read ON public.session_checklists FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

DROP POLICY IF EXISTS activity_log_read ON public.activity_log;
CREATE POLICY activity_log_read ON public.activity_log FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

REVOKE ALL ON FUNCTION public.activity_log_append_only() FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.update_session_checklist(uuid, boolean, boolean, boolean, boolean, boolean, boolean, text)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.update_session_checklist(uuid, boolean, boolean, boolean, boolean, boolean, boolean, text)
TO authenticated;

COMMENT ON TABLE public.session_checklists IS
  'Manual per-appointment session checklist; written only by update_session_checklist (202611210004).';
COMMENT ON TABLE public.activity_log IS
  'Append-only activity log (entity_type, entity_id, action, actor, details) (202611210004).';

COMMIT;
