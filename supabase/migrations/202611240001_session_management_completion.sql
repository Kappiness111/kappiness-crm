-- Kappiness CRM: private session follow-up decisions and checklist N/A reasons.
-- Owner: Sariga (session workflow).
--
-- This is additive. Completed session rows and their status history continue to be written by
-- record_attendance; this migration stores the psychologist's separate after-session decision
-- without exposing its clinical details to reception.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.sessions') IS NULL OR to_regclass('public.appointments') IS NULL
     OR to_regclass('public.session_checklists') IS NULL OR to_regclass('public.activity_log') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611040001 and 202611210004 first.';
  END IF;
  IF to_regprocedure('public.current_psychologist_id()') IS NULL
     OR to_regprocedure('public.is_crm_staff()') IS NULL
     OR to_regprocedure('public.is_crm_admin()') IS NULL THEN
    RAISE EXCEPTION 'Session role helpers are missing.';
  END IF;
END
$$;

ALTER TABLE public.session_checklists
  ADD COLUMN IF NOT EXISTS not_applicable jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.session_checklists'::regclass
      AND conname = 'session_checklists_not_applicable_object'
  ) THEN
    ALTER TABLE public.session_checklists
      ADD CONSTRAINT session_checklists_not_applicable_object
      CHECK (jsonb_typeof(not_applicable) = 'object');
  END IF;
END
$$;

CREATE TABLE IF NOT EXISTS public.session_follow_up_decisions (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  follow_up_required boolean NOT NULL,
  follow_up_purpose text,
  follow_up_date date,
  follow_up_details text,
  updated_by uuid NOT NULL DEFAULT auth.uid(),
  updated_by_name text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT session_follow_up_decision_fields CHECK (
    (follow_up_required AND follow_up_purpose IS NOT NULL AND follow_up_date IS NOT NULL)
    OR (NOT follow_up_required AND follow_up_purpose IS NULL AND follow_up_date IS NULL AND follow_up_details IS NULL)
  ),
  CONSTRAINT session_follow_up_purpose_length CHECK (
    follow_up_purpose IS NULL OR char_length(btrim(follow_up_purpose)) BETWEEN 3 AND 120
  ),
  CONSTRAINT session_follow_up_details_length CHECK (
    follow_up_details IS NULL OR char_length(follow_up_details) <= 1000
  )
);
CREATE INDEX IF NOT EXISTS idx_session_follow_up_decisions_client
  ON public.session_follow_up_decisions (client_id, updated_at DESC);

ALTER TABLE public.session_follow_up_decisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.session_follow_up_decisions FROM PUBLIC, anon, authenticated;
-- Reception can see only the scheduling flag; clinical details are returned by a psychologist/admin-checked RPC.
GRANT SELECT (session_id, follow_up_required, follow_up_date, updated_at)
  ON public.session_follow_up_decisions TO authenticated;
DROP POLICY IF EXISTS session_follow_up_decisions_read ON public.session_follow_up_decisions;
CREATE POLICY session_follow_up_decisions_read ON public.session_follow_up_decisions FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

CREATE OR REPLACE FUNCTION public.prevent_ticking_not_applicable_session_step()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF (NEW.not_applicable ? 'client_arrived' AND NEW.client_arrived)
     OR (NEW.not_applicable ? 'session_started' AND NEW.session_started)
     OR (NEW.not_applicable ? 'session_completed' AND NEW.session_completed)
     OR (NEW.not_applicable ? 'next_follow_up_discussed' AND NEW.next_follow_up_discussed)
     OR (NEW.not_applicable ? 'next_appointment_booked' AND NEW.next_appointment_booked)
     OR (NEW.not_applicable ? 'reminder_sent' AND NEW.reminder_sent) THEN
    RAISE EXCEPTION 'Clear the not-applicable reason before completing that checklist step.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS session_checklists_not_applicable_guard ON public.session_checklists;
CREATE TRIGGER session_checklists_not_applicable_guard
  BEFORE INSERT OR UPDATE ON public.session_checklists
  FOR EACH ROW
  EXECUTE FUNCTION public.prevent_ticking_not_applicable_session_step();

CREATE OR REPLACE FUNCTION public.set_session_checklist_not_applicable(
  p_appointment_id uuid,
  p_step_id text,
  p_reason text DEFAULT NULL
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
  v_reason text := nullif(btrim(p_reason), '');
  v_applicable jsonb;
  v_previous text;
BEGIN
  IF p_step_id IS NULL OR p_step_id NOT IN (
    'client_arrived', 'session_started', 'session_completed',
    'next_follow_up_discussed', 'next_appointment_booked', 'reminder_sent'
  ) THEN
    RAISE EXCEPTION 'Choose a valid checklist step.' USING ERRCODE = '22023';
  END IF;
  IF p_reason IS NOT NULL AND (v_reason IS NULL OR char_length(v_reason) > 200) THEN
    RAISE EXCEPTION 'Add a reason under 200 characters, or clear the not-applicable state.' USING ERRCODE = '22023';
  END IF;

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

  SELECT s.id INTO v_session FROM public.sessions AS s WHERE s.appointment_id = appt.id;
  INSERT INTO public.session_checklists (appointment_id, session_id, client_id, psychologist_id, updated_by, updated_by_name)
  VALUES (appt.id, v_session, appt.client_id, appt.psychologist_id, auth.uid(), public.current_actor_name())
  ON CONFLICT (appointment_id) DO NOTHING;
  SELECT * INTO old_row FROM public.session_checklists WHERE appointment_id = appt.id FOR UPDATE;

  v_previous := old_row.not_applicable ->> p_step_id;
  IF v_previous IS NOT DISTINCT FROM v_reason THEN
    RETURN old_row;
  END IF;
  IF v_reason IS NULL THEN
    v_applicable := old_row.not_applicable - p_step_id;
  ELSE
    v_applicable := jsonb_set(old_row.not_applicable, ARRAY[p_step_id], to_jsonb(v_reason), true);
  END IF;

  UPDATE public.session_checklists SET
    not_applicable = v_applicable,
    client_arrived = CASE WHEN p_step_id = 'client_arrived' AND v_reason IS NOT NULL THEN false ELSE client_arrived END,
    client_arrived_at = CASE WHEN p_step_id = 'client_arrived' AND v_reason IS NOT NULL THEN NULL ELSE client_arrived_at END,
    session_started = CASE WHEN p_step_id = 'session_started' AND v_reason IS NOT NULL THEN false ELSE session_started END,
    session_started_at = CASE WHEN p_step_id = 'session_started' AND v_reason IS NOT NULL THEN NULL ELSE session_started_at END,
    session_completed = CASE WHEN p_step_id = 'session_completed' AND v_reason IS NOT NULL THEN false ELSE session_completed END,
    session_completed_at = CASE WHEN p_step_id = 'session_completed' AND v_reason IS NOT NULL THEN NULL ELSE session_completed_at END,
    next_follow_up_discussed = CASE WHEN p_step_id = 'next_follow_up_discussed' AND v_reason IS NOT NULL THEN false ELSE next_follow_up_discussed END,
    next_follow_up_discussed_at = CASE WHEN p_step_id = 'next_follow_up_discussed' AND v_reason IS NOT NULL THEN NULL ELSE next_follow_up_discussed_at END,
    next_appointment_booked = CASE WHEN p_step_id = 'next_appointment_booked' AND v_reason IS NOT NULL THEN false ELSE next_appointment_booked END,
    next_appointment_booked_at = CASE WHEN p_step_id = 'next_appointment_booked' AND v_reason IS NOT NULL THEN NULL ELSE next_appointment_booked_at END,
    reminder_sent = CASE WHEN p_step_id = 'reminder_sent' AND v_reason IS NOT NULL THEN false ELSE reminder_sent END,
    reminder_sent_at = CASE WHEN p_step_id = 'reminder_sent' AND v_reason IS NOT NULL THEN NULL ELSE reminder_sent_at END,
    updated_by = auth.uid(),
    updated_by_name = public.current_actor_name(),
    updated_at = now()
  WHERE id = old_row.id
  RETURNING * INTO saved;

  INSERT INTO public.activity_log (entity_type, entity_id, action, actor, actor_name, details, client_id, psychologist_id)
  VALUES (
    'session_checklist',
    saved.id,
    CASE WHEN v_reason IS NULL THEN 'Checklist step made applicable' ELSE 'Checklist step not applicable' END,
    auth.uid(),
    public.current_actor_name(),
    jsonb_build_object('step_id', p_step_id, 'previous_reason', v_previous, 'reason', v_reason),
    appt.client_id,
    appt.psychologist_id
  );
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.record_session_follow_up_decision(
  p_session_id uuid,
  p_follow_up_required boolean,
  p_follow_up_purpose text DEFAULT NULL,
  p_follow_up_date date DEFAULT NULL,
  p_follow_up_details text DEFAULT NULL
)
RETURNS public.session_follow_up_decisions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ses public.sessions%ROWTYPE;
  saved public.session_follow_up_decisions%ROWTYPE;
  v_today date := (now() AT TIME ZONE public.clinic_timezone())::date;
  v_purpose text := nullif(btrim(p_follow_up_purpose), '');
  v_details text := nullif(btrim(p_follow_up_details), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to record the follow-up decision.' USING ERRCODE = '42501';
  END IF;
  IF p_follow_up_required IS NULL THEN
    RAISE EXCEPTION 'Choose whether another follow-up is required.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO ses FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This session no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF ses.psychologist_id IS DISTINCT FROM public.current_psychologist_id() THEN
    RAISE EXCEPTION 'Only the session''s psychologist can record the follow-up decision.' USING ERRCODE = '42501';
  END IF;
  IF ses.status <> 'Completed' OR NOT EXISTS (
    SELECT 1 FROM public.appointments AS a WHERE a.id = ses.appointment_id AND a.status = 'Completed'
  ) THEN
    RAISE EXCEPTION 'Mark the session as Completed before recording its follow-up decision.' USING ERRCODE = 'P0001';
  END IF;

  IF p_follow_up_required THEN
    IF v_purpose IS NULL OR char_length(v_purpose) NOT BETWEEN 3 AND 120 THEN
      RAISE EXCEPTION 'Add a short follow-up purpose (3-120 characters).' USING ERRCODE = '22023';
    END IF;
    IF p_follow_up_date IS NULL OR p_follow_up_date < v_today THEN
      RAISE EXCEPTION 'Choose a follow-up date from today onwards.' USING ERRCODE = '22023';
    END IF;
    IF char_length(coalesce(v_details, '')) > 1000 THEN
      RAISE EXCEPTION 'Keep follow-up details under 1000 characters.' USING ERRCODE = '22023';
    END IF;
  ELSE
    v_purpose := NULL;
    p_follow_up_date := NULL;
    v_details := NULL;
  END IF;

  INSERT INTO public.session_follow_up_decisions (
    session_id, client_id, psychologist_id, follow_up_required, follow_up_purpose,
    follow_up_date, follow_up_details, updated_by, updated_by_name, updated_at
  ) VALUES (
    ses.id, ses.client_id, ses.psychologist_id, p_follow_up_required, v_purpose,
    p_follow_up_date, v_details, auth.uid(), public.current_actor_name(), now()
  )
  ON CONFLICT (session_id) DO UPDATE SET
    follow_up_required = EXCLUDED.follow_up_required,
    follow_up_purpose = EXCLUDED.follow_up_purpose,
    follow_up_date = EXCLUDED.follow_up_date,
    follow_up_details = EXCLUDED.follow_up_details,
    updated_by = EXCLUDED.updated_by,
    updated_by_name = EXCLUDED.updated_by_name,
    updated_at = EXCLUDED.updated_at
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

CREATE OR REPLACE FUNCTION public.get_session_follow_up_decision(p_session_id uuid)
RETURNS TABLE (
  session_id uuid,
  follow_up_required boolean,
  follow_up_purpose text,
  follow_up_date date,
  follow_up_details text,
  updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ses public.sessions%ROWTYPE;
BEGIN
  SELECT * INTO ses FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This session no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT (coalesce(public.is_crm_admin(), false)
      OR ses.psychologist_id = public.current_psychologist_id()) THEN
    RAISE EXCEPTION 'You do not have permission to view this follow-up decision.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT d.session_id, d.follow_up_required, d.follow_up_purpose, d.follow_up_date,
           d.follow_up_details, d.updated_at
    FROM public.session_follow_up_decisions AS d
    WHERE d.session_id = p_session_id;
END;
$$;

REVOKE ALL ON FUNCTION public.prevent_ticking_not_applicable_session_step() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION
  public.set_session_checklist_not_applicable(uuid, text, text),
  public.record_session_follow_up_decision(uuid, boolean, text, date, text),
  public.get_session_follow_up_decision(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.set_session_checklist_not_applicable(uuid, text, text),
  public.record_session_follow_up_decision(uuid, boolean, text, date, text),
  public.get_session_follow_up_decision(uuid)
TO authenticated;

COMMENT ON TABLE public.session_follow_up_decisions IS
  'One psychologist-owned after-session decision per completed session. Reception can read only the required flag.';
COMMENT ON COLUMN public.session_checklists.not_applicable IS
  'Per-step not-applicable reason; changed only by set_session_checklist_not_applicable.';

COMMIT;
