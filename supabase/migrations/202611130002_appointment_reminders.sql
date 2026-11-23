-- Kappiness CRM: Phase 3 - reminder TRACKING for follow-up appointments (database only; nothing is sent).
-- Owner: Aswathy (backend).
--
-- WHAT THIS ADDS
--   public.appointment_reminder_settings  two rows: how long before the appointment reminder 1 and 2 are due.
--   public.appointment_reminders          exactly two reminder slots (1, 2) per follow-up appointment.
--   public.appointment_reminder_events    append-only history of every reminder change.
--   Triggers on public.appointments:
--     * AFTER INSERT of an active follow-up appointment  -> create reminders 1 and 2 (Pending).
--     * AFTER a status change out of Scheduled/Confirmed -> mark that appointment's PENDING reminders Cancelled
--       (Sent / Delivered / Failed reminders are left exactly as they are).
--   RPCs (active CRM staff only): record_reminder_delivery, record_reminder_response, update_reminder_due_at;
--   (active CRM admins only): set_reminder_offsets.
--
-- HOW IT FITS THE EXISTING WORKFLOW (202611040001, verified from the repository source, not assumed)
--   * A "follow-up appointment" is an appointment with recommendation_id set: book_appointment stores
--     p_recommendation_id on the appointment (and session_type 'Follow-up'), and reschedule_appointment copies
--     old_appt.recommendation_id onto the replacement and repoints follow_up_recommendations.appointment_id.
--   * Active statuses are 'Scheduled' and 'Confirmed' (the same set appointments_no_overlap uses).
--     cancel_appointment -> 'Cancelled'; reschedule_appointment -> old row 'Rescheduled' + new 'Scheduled' row;
--     record_attendance -> 'Completed' / 'Missed'.
--   * Everything runs inside the caller's transaction, so a booking or reschedule that fails for any reason
--     (overlap, availability, missing reminder settings, ...) leaves no appointment and no reminders behind.
--   * book_appointment, reschedule_appointment and cancel_appointment are NOT modified. The security helpers
--     (is_crm_staff, is_crm_admin, ...) are NOT modified and NOT used: reminder access is decided directly from
--     an ACTIVE public.crm_staff_members row, so it is correct whether or not 202611040003 / the production
--     remediation has been applied.
--
-- TIMING IS CONFIGURATION, NOT CODE
--   due_at = appointment.starts_at - appointment_reminder_settings.offset_before_start, read when the reminders
--   are created. If that moment has already passed, the reminder is due immediately (now()). Reminder 2 is never
--   due before reminder 1. The seeded offsets (24 hours, 2 hours) are initial configuration: admins change them
--   with set_reminder_offsets(); staff move one pending reminder with update_reminder_due_at().
--
-- DELIVERY STATUS RULES (enforced by trigger for every writer, including service_role)
--   Pending -> Sent | Delivered | Failed | Cancelled
--   Sent    -> Delivered | Failed
--   Failed  -> Sent (retry) | Delivered | Cancelled
--   Delivered and Cancelled are final.
--   A client response can be recorded only for a Sent or Delivered reminder.
--   Reminders and their events are never deleted (row trigger + no DELETE/TRUNCATE grants).
--
-- PREREQUISITES
--   202611030001 (crm_staff_members) and 202611040001 (appointments, follow_up_recommendations, workflow
--   functions, current_actor_name). Independent of 202611040003/04/05 and of the is_crm_staff() remediation.
--
-- DEPLOYMENT
--   Single transaction; safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS / ON CONFLICT).
--   Do NOT deploy with `supabase db push` while production migration history is incomplete (it would replay
--   202611040001). See supabase/migrations/README.md.
--
-- ROLLBACK (only before any reminder data matters; this drops reminder history)
--   BEGIN;
--   DROP TRIGGER IF EXISTS appointments_create_reminders ON public.appointments;
--   DROP TRIGGER IF EXISTS appointments_cancel_pending_reminders ON public.appointments;
--   DROP FUNCTION IF EXISTS public.record_reminder_delivery(uuid, text, timestamptz, text),
--     public.record_reminder_response(uuid, text, text, timestamptz),
--     public.update_reminder_due_at(uuid, timestamptz, text), public.set_reminder_offsets(interval, interval);
--   DROP TABLE IF EXISTS public.appointment_reminder_events, public.appointment_reminders,
--     public.appointment_reminder_settings;
--   DROP FUNCTION IF EXISTS public.appointment_reminders_on_appointment_insert(),
--     public.appointment_reminders_on_appointment_status(), public._create_appointment_reminders(uuid),
--     public.appointment_reminders_before_write(), public.appointment_reminders_log_event(),
--     public.appointment_reminders_block_delete(), public._assert_crm_staff_member(boolean);
--   COMMIT;
--   To keep history instead, drop only the two appointments triggers (reminders stop being created/cancelled).

BEGIN;

/* =====================================================================
   0. Prerequisites: check the schema this migration builds on instead of assuming it.
   ===================================================================== */
DO $$
DECLARE
  status_def text;
  s text;
BEGIN
  IF to_regclass('public.appointments') IS NULL
     OR to_regclass('public.follow_up_recommendations') IS NULL
     OR to_regclass('public.crm_staff_members') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611030001 and 202611040001 first (appointments, follow_up_recommendations, crm_staff_members).';
  END IF;

  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'appointments'
        AND column_name IN ('id', 'starts_at', 'status', 'recommendation_id', 'rescheduled_from_id', 'cancellation_reason')) <> 6 THEN
    RAISE EXCEPTION 'public.appointments does not have the 202611040001 columns this migration uses.';
  END IF;
  IF (SELECT count(*) FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'crm_staff_members'
        AND column_name IN ('user_id', 'is_active', 'access_level')) <> 3 THEN
    RAISE EXCEPTION 'public.crm_staff_members must have user_id, is_active and access_level.';
  END IF;

  -- The appointment status vocabulary must be exactly the one the triggers below rely on.
  SELECT string_agg(pg_get_constraintdef(c.oid), ' ') INTO status_def
  FROM pg_constraint AS c
  WHERE c.conrelid = 'public.appointments'::regclass AND c.contype = 'c'
    AND pg_get_constraintdef(c.oid) LIKE '%status%';
  FOREACH s IN ARRAY ARRAY['Scheduled', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed', 'Missed'] LOOP
    IF position(quote_literal(s) IN coalesce(status_def, '')) = 0 THEN
      RAISE EXCEPTION 'appointments.status no longer allows %; review the reminder triggers before applying.', s;
    END IF;
  END LOOP;

  -- Workflow functions and the behaviour the triggers depend on.
  IF to_regprocedure('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)') IS NULL
     OR to_regprocedure('public.reschedule_appointment(uuid, timestamptz, uuid, text)') IS NULL
     OR to_regprocedure('public.cancel_appointment(uuid, text)') IS NULL
     OR to_regprocedure('public.current_actor_name()') IS NULL THEN
    RAISE EXCEPTION 'book_appointment / reschedule_appointment / cancel_appointment / current_actor_name are missing. Apply 202611040001 first.';
  END IF;
  IF position('p_recommendation_id' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'book_appointment no longer stores the recommendation on the appointment; follow-up detection would break.';
  END IF;
  IF position('old_appt.recommendation_id' IN (SELECT prosrc FROM pg_proc
       WHERE oid = 'public.reschedule_appointment(uuid, timestamptz, uuid, text)'::regprocedure)) = 0 THEN
    RAISE EXCEPTION 'reschedule_appointment no longer copies the recommendation onto the replacement; reminders would not follow it.';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_class
             WHERE oid IN ('public.crm_staff_members'::regclass, 'public.appointments'::regclass)
               AND relforcerowsecurity) THEN
    RAISE EXCEPTION 'FORCE ROW LEVEL SECURITY on crm_staff_members/appointments would break the definer functions.';
  END IF;
END
$$;

/* =====================================================================
   1. Tables
   ===================================================================== */

-- 1a. Timing configuration: one row per reminder slot.
CREATE TABLE IF NOT EXISTS public.appointment_reminder_settings (
  reminder_number smallint PRIMARY KEY CHECK (reminder_number IN (1, 2)),
  offset_before_start interval NOT NULL
    CHECK (offset_before_start > interval '0' AND offset_before_start <= interval '30 days'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid,
  updated_by_name text
);

INSERT INTO public.appointment_reminder_settings (reminder_number, offset_before_start, updated_by_name)
VALUES (1, interval '24 hours', 'Initial configuration (202611130002)'),
       (2, interval '2 hours',  'Initial configuration (202611130002)')
ON CONFLICT (reminder_number) DO NOTHING;

-- 1b. Reminder slots.
CREATE TABLE IF NOT EXISTS public.appointment_reminders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  reminder_number smallint NOT NULL CHECK (reminder_number IN (1, 2)),
  due_at timestamptz NOT NULL,
  delivery_status text NOT NULL DEFAULT 'Pending'
    CHECK (delivery_status IN ('Pending', 'Sent', 'Delivered', 'Failed', 'Cancelled')),
  sent_at timestamptz,
  delivered_at timestamptz,
  failed_at timestamptz,
  failure_reason text CHECK (char_length(failure_reason) <= 500),
  cancelled_at timestamptz,
  delivery_updated_by uuid,
  delivery_updated_by_name text,
  client_response text CHECK (client_response IN ('Confirmed', 'Wants to Reschedule', 'No Response')),
  responded_at timestamptz,
  response_recorded_by uuid,
  response_recorded_by_name text,
  response_note text CHECK (char_length(response_note) <= 1000),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- Exactly two slots per appointment: numbers 1 and 2, each at most once.
  CONSTRAINT appointment_reminders_slot_key UNIQUE (appointment_id, reminder_number),
  CONSTRAINT appointment_reminders_sent_has_time
    CHECK (delivery_status NOT IN ('Sent', 'Delivered') OR sent_at IS NOT NULL),
  CONSTRAINT appointment_reminders_delivered_has_time
    CHECK ((delivery_status = 'Delivered') = (delivered_at IS NOT NULL)),
  CONSTRAINT appointment_reminders_delivered_after_sent
    CHECK (delivered_at IS NULL OR (sent_at IS NOT NULL AND delivered_at >= sent_at)),
  CONSTRAINT appointment_reminders_failed_has_time
    CHECK (delivery_status <> 'Failed' OR failed_at IS NOT NULL),
  CONSTRAINT appointment_reminders_cancelled_has_time
    CHECK ((delivery_status = 'Cancelled') = (cancelled_at IS NOT NULL)),
  CONSTRAINT appointment_reminders_response_has_time
    CHECK ((client_response IS NULL) = (responded_at IS NULL)),
  CONSTRAINT appointment_reminders_response_needs_delivery
    CHECK (client_response IS NULL OR delivery_status IN ('Sent', 'Delivered')),
  CONSTRAINT appointment_reminders_note_needs_response
    CHECK (response_note IS NULL OR client_response IS NOT NULL)
);
-- Work queue: pending reminders by due time.
CREATE INDEX IF NOT EXISTS idx_appointment_reminders_pending_due
  ON public.appointment_reminders (due_at) WHERE delivery_status = 'Pending';
-- Follow-up lists: sent/delivered reminders still waiting for a client response.
CREATE INDEX IF NOT EXISTS idx_appointment_reminders_awaiting_response
  ON public.appointment_reminders (sent_at)
  WHERE delivery_status IN ('Sent', 'Delivered') AND client_response IS NULL;
-- (appointment_id, reminder_number) is already indexed by appointment_reminders_slot_key.

-- 1c. Append-only history.
CREATE TABLE IF NOT EXISTS public.appointment_reminder_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Total order of events (several events in one transaction share changed_at = now()).
  event_seq bigint GENERATED ALWAYS AS IDENTITY,
  reminder_id uuid NOT NULL REFERENCES public.appointment_reminders(id) ON DELETE RESTRICT,
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('Created', 'Delivery status', 'Client response', 'Due time')),
  from_value text,
  to_value text,
  note text CHECK (char_length(note) <= 1000),
  changed_by uuid,
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_appointment_reminder_events_reminder
  ON public.appointment_reminder_events (reminder_id, event_seq);
CREATE INDEX IF NOT EXISTS idx_appointment_reminder_events_appointment
  ON public.appointment_reminder_events (appointment_id, event_seq);

/* =====================================================================
   2. Internal helpers (not callable through the API)
   ===================================================================== */

-- Raises 42501 unless the caller has an ACTIVE crm_staff_members row (and access_level 'admin' if asked).
-- Deliberately independent of is_crm_staff()/is_crm_admin() (see header).
CREATE OR REPLACE FUNCTION public._assert_crm_staff_member(p_admin boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF auth.uid() IS NULL OR NOT EXISTS (
    SELECT 1 FROM public.crm_staff_members AS m
    WHERE m.user_id = auth.uid()
      AND m.is_active = true
      AND (NOT coalesce(p_admin, false) OR m.access_level = 'admin')
  ) THEN
    IF coalesce(p_admin, false) THEN
      RAISE EXCEPTION 'Only CRM administrators can change reminder timing.' USING ERRCODE = '42501';
    END IF;
    RAISE EXCEPTION 'Only CRM staff can update appointment reminders.' USING ERRCODE = '42501';
  END IF;
END;
$$;

-- Creates reminders 1 and 2 for an active follow-up appointment. Idempotent: an existing slot is never
-- duplicated or overwritten. Returns the number of reminders created (0, or 2 for a new follow-up).
CREATE OR REPLACE FUNCTION public._create_appointment_reminders(p_appointment_id uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  appt record;
  off1 interval;
  off2 interval;
  due1 timestamptz;
  due2 timestamptz;
  created integer;
BEGIN
  SELECT a.id, a.starts_at, a.status, a.recommendation_id, a.rescheduled_from_id INTO appt
  FROM public.appointments AS a WHERE a.id = p_appointment_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Appointment % does not exist.', p_appointment_id USING ERRCODE = 'P0001';
  END IF;
  IF appt.recommendation_id IS NULL OR appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RETURN 0; -- not an active follow-up appointment
  END IF;
  IF appt.starts_at <= now() THEN
    RAISE EXCEPTION 'Reminders can only be created for an appointment in the future.' USING ERRCODE = 'P0001';
  END IF;

  SELECT s.offset_before_start INTO off1 FROM public.appointment_reminder_settings AS s WHERE s.reminder_number = 1;
  SELECT s.offset_before_start INTO off2 FROM public.appointment_reminder_settings AS s WHERE s.reminder_number = 2;
  IF off1 IS NULL OR off2 IS NULL THEN
    RAISE EXCEPTION 'Reminder timing is not configured (appointment_reminder_settings needs reminders 1 and 2).'
      USING ERRCODE = 'P0001';
  END IF;
  IF off1 <= off2 THEN
    RAISE EXCEPTION 'Reminder timing is misconfigured: reminder 1 must be due earlier than reminder 2.'
      USING ERRCODE = 'P0001';
  END IF;

  due1 := greatest(appt.starts_at - off1, now());
  due2 := greatest(appt.starts_at - off2, due1);

  PERFORM set_config('kappiness.reminder_note',
    CASE WHEN appt.rescheduled_from_id IS NULL THEN 'Follow-up appointment booked'
         ELSE format('Replacement for rescheduled appointment %s', appt.rescheduled_from_id) END, true);
  INSERT INTO public.appointment_reminders (appointment_id, reminder_number, due_at)
  VALUES (appt.id, 1, due1), (appt.id, 2, due2)
  ON CONFLICT (appointment_id, reminder_number) DO NOTHING;
  GET DIAGNOSTICS created = ROW_COUNT;
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN created;
END;
$$;

/* =====================================================================
   3. Reminder table triggers: validation, history, no deletes
   ===================================================================== */

CREATE OR REPLACE FUNCTION public.appointment_reminders_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  appt_start timestamptz;
  allowed text[];
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.delivery_status IS DISTINCT FROM 'Pending'
       OR NEW.sent_at IS NOT NULL OR NEW.delivered_at IS NOT NULL OR NEW.failed_at IS NOT NULL
       OR NEW.cancelled_at IS NOT NULL OR NEW.client_response IS NOT NULL THEN
      RAISE EXCEPTION 'A new reminder must start as Pending, with no delivery or response details.' USING ERRCODE = '22023';
    END IF;
    SELECT a.starts_at INTO appt_start FROM public.appointments AS a WHERE a.id = NEW.appointment_id;
    IF NEW.due_at >= appt_start THEN
      RAISE EXCEPTION 'A reminder must be due before the appointment starts.' USING ERRCODE = '22023';
    END IF;
    NEW.created_at := now();
    NEW.updated_at := now();
    RETURN NEW;
  END IF;

  -- UPDATE: the slot identity never changes.
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.appointment_id IS DISTINCT FROM OLD.appointment_id
     OR NEW.reminder_number IS DISTINCT FROM OLD.reminder_number OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'A reminder''s appointment, number and creation time cannot be changed.' USING ERRCODE = '22023';
  END IF;

  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    allowed := CASE OLD.delivery_status
      WHEN 'Pending' THEN ARRAY['Sent', 'Delivered', 'Failed', 'Cancelled']
      WHEN 'Sent'    THEN ARRAY['Delivered', 'Failed']
      WHEN 'Failed'  THEN ARRAY['Sent', 'Delivered', 'Cancelled']
      ELSE ARRAY[]::text[] -- Delivered and Cancelled are final
    END;
    IF NOT (NEW.delivery_status = ANY (allowed)) THEN
      RAISE EXCEPTION 'A reminder cannot move from % to %.', OLD.delivery_status, NEW.delivery_status USING ERRCODE = 'P0001';
    END IF;
  END IF;

  -- Recorded delivery times are kept: sent_at changes only when (re)sending, delivered_at is written once.
  IF OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at
     AND NOT (NEW.delivery_status = 'Sent' AND OLD.delivery_status = 'Failed') THEN
    RAISE EXCEPTION 'The recorded send time cannot be changed.' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.delivered_at IS NOT NULL AND NEW.delivered_at IS DISTINCT FROM OLD.delivered_at THEN
    RAISE EXCEPTION 'The recorded delivery time cannot be changed.' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.due_at IS DISTINCT FROM OLD.due_at AND OLD.delivery_status <> 'Pending' THEN
    RAISE EXCEPTION 'Only a pending reminder can be moved to another time.' USING ERRCODE = 'P0001';
  END IF;

  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.appointment_reminders_log_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_note text := left(nullif(current_setting('kappiness.reminder_note', true), ''), 1000);
  v_by uuid := auth.uid();
  v_name text := public.current_actor_name();
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Created', NULL,
            format('Reminder %s Pending, due %s', NEW.reminder_number, NEW.due_at), v_note, v_by, v_name);
    RETURN NULL;
  END IF;

  IF NEW.delivery_status IS DISTINCT FROM OLD.delivery_status THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Delivery status', OLD.delivery_status, NEW.delivery_status, v_note, v_by, v_name);
  END IF;
  IF NEW.client_response IS DISTINCT FROM OLD.client_response
     OR NEW.response_note IS DISTINCT FROM OLD.response_note
     OR NEW.responded_at IS DISTINCT FROM OLD.responded_at THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Client response', OLD.client_response, NEW.client_response,
            left(NEW.response_note, 1000), v_by, v_name);
  END IF;
  IF NEW.due_at IS DISTINCT FROM OLD.due_at THEN
    INSERT INTO public.appointment_reminder_events (reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by, changed_by_name)
    VALUES (NEW.id, NEW.appointment_id, 'Due time', OLD.due_at::text, NEW.due_at::text, v_note, v_by, v_name);
  END IF;
  RETURN NULL;
END;
$$;

-- Reminder history is permanent: no row of either table is ever deleted, and events are never edited.
CREATE OR REPLACE FUNCTION public.appointment_reminders_block_delete()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% rows are permanent history and cannot be %.', TG_TABLE_NAME,
    CASE TG_OP WHEN 'DELETE' THEN 'deleted' ELSE 'changed' END USING ERRCODE = '42501';
END;
$$;

DROP TRIGGER IF EXISTS appointment_reminders_before_write ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_before_write
  BEFORE INSERT OR UPDATE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_before_write();

DROP TRIGGER IF EXISTS appointment_reminders_log_event ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_log_event
  AFTER INSERT OR UPDATE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_log_event();

DROP TRIGGER IF EXISTS appointment_reminders_no_delete ON public.appointment_reminders;
CREATE TRIGGER appointment_reminders_no_delete
  BEFORE DELETE ON public.appointment_reminders
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_block_delete();

DROP TRIGGER IF EXISTS appointment_reminder_events_append_only ON public.appointment_reminder_events;
CREATE TRIGGER appointment_reminder_events_append_only
  BEFORE UPDATE OR DELETE ON public.appointment_reminder_events
  FOR EACH ROW EXECUTE FUNCTION public.appointment_reminders_block_delete();

/* =====================================================================
   4. Integration with the appointment workflow (triggers on public.appointments)
   ===================================================================== */

-- Booking (book_appointment) and the replacement row of reschedule_appointment.
CREATE OR REPLACE FUNCTION public.appointment_reminders_on_appointment_insert()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._create_appointment_reminders(NEW.id);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_create_reminders ON public.appointments;
CREATE TRIGGER appointments_create_reminders
  AFTER INSERT ON public.appointments
  FOR EACH ROW
  WHEN (NEW.recommendation_id IS NOT NULL AND NEW.status IN ('Scheduled', 'Confirmed'))
  EXECUTE FUNCTION public.appointment_reminders_on_appointment_insert();

-- Leaving the active statuses (Cancelled, Rescheduled, Completed, Missed): cancel PENDING reminders only.
CREATE OR REPLACE FUNCTION public.appointment_reminders_on_appointment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM set_config('kappiness.reminder_note',
    CASE WHEN NEW.status = 'Cancelled' AND nullif(btrim(NEW.cancellation_reason), '') IS NOT NULL
         THEN format('Appointment cancelled: %s', btrim(NEW.cancellation_reason))
         ELSE format('Appointment %s', lower(NEW.status)) END, true);
  UPDATE public.appointment_reminders
    SET delivery_status = 'Cancelled', cancelled_at = now(),
        delivery_updated_by = auth.uid(), delivery_updated_by_name = public.current_actor_name()
    WHERE appointment_id = NEW.id AND delivery_status = 'Pending';
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS appointments_cancel_pending_reminders ON public.appointments;
CREATE TRIGGER appointments_cancel_pending_reminders
  AFTER UPDATE OF status ON public.appointments
  FOR EACH ROW
  WHEN (OLD.status IN ('Scheduled', 'Confirmed') AND NEW.status NOT IN ('Scheduled', 'Confirmed'))
  EXECUTE FUNCTION public.appointment_reminders_on_appointment_status();

/* =====================================================================
   5. Tracking functions (RPC)
   Lock order everywhere: appointment row, then reminder rows (same as cancel/reschedule), so a reminder update
   and an appointment cancellation can never deadlock, and the later one always sees the earlier one's result.
   ===================================================================== */

-- 5a. Delivery status: Sent, Delivered, Failed (optional reason) or Cancelled (reason required).
CREATE OR REPLACE FUNCTION public.record_reminder_delivery(
  p_reminder_id uuid,
  p_status text,
  p_occurred_at timestamptz DEFAULT NULL,
  p_note text DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  v_at timestamptz := coalesce(p_occurred_at, now());
  v_note text := nullif(btrim(p_note), '');
  v_appt uuid;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  IF p_status IS NULL OR p_status NOT IN ('Sent', 'Delivered', 'Failed', 'Cancelled') THEN
    RAISE EXCEPTION 'Choose Sent, Delivered, Failed or Cancelled.' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The delivery time cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 500 THEN
    RAISE EXCEPTION 'Keep the note under 500 characters.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Cancelled' AND v_note IS NULL THEN
    RAISE EXCEPTION 'Add a reason for cancelling this reminder.' USING ERRCODE = '22023';
  END IF;

  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.appointments WHERE id = v_appt FOR SHARE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id FOR UPDATE;

  IF r.delivery_status = p_status THEN
    RAISE EXCEPTION 'This reminder is already %.', p_status USING ERRCODE = 'P0001';
  END IF;
  IF v_at < r.created_at THEN
    RAISE EXCEPTION 'The delivery time cannot be before the reminder was created.' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'Delivered' AND r.sent_at IS NOT NULL AND v_at < r.sent_at THEN
    RAISE EXCEPTION 'The delivery time cannot be before the send time.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('kappiness.reminder_note', coalesce(v_note, ''), true);
  UPDATE public.appointment_reminders
    SET delivery_status = p_status,
        sent_at = CASE p_status WHEN 'Sent' THEN v_at WHEN 'Delivered' THEN coalesce(sent_at, v_at) ELSE sent_at END,
        delivered_at = CASE WHEN p_status = 'Delivered' THEN v_at ELSE delivered_at END,
        failed_at = CASE WHEN p_status = 'Failed' THEN v_at ELSE failed_at END,
        failure_reason = CASE WHEN p_status = 'Failed' THEN v_note ELSE failure_reason END,
        cancelled_at = CASE WHEN p_status = 'Cancelled' THEN v_at ELSE cancelled_at END,
        delivery_updated_by = auth.uid(),
        delivery_updated_by_name = public.current_actor_name()
    WHERE id = p_reminder_id
    RETURNING * INTO r; -- invalid transitions are refused by appointment_reminders_before_write
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN r;
END;
$$;

-- 5b. Client response to a Sent or Delivered reminder. A later call replaces it; the events keep every version.
CREATE OR REPLACE FUNCTION public.record_reminder_response(
  p_reminder_id uuid,
  p_response text,
  p_note text DEFAULT NULL,
  p_responded_at timestamptz DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  v_at timestamptz := coalesce(p_responded_at, now());
  v_note text := nullif(btrim(p_note), '');
  v_appt uuid;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  IF p_response IS NULL OR p_response NOT IN ('Confirmed', 'Wants to Reschedule', 'No Response') THEN
    RAISE EXCEPTION 'Choose Confirmed, Wants to Reschedule or No Response.' USING ERRCODE = '22023';
  END IF;
  IF v_at > now() + interval '5 minutes' THEN
    RAISE EXCEPTION 'The response time cannot be in the future.' USING ERRCODE = '22023';
  END IF;
  IF char_length(v_note) > 1000 THEN
    RAISE EXCEPTION 'Keep the note under 1000 characters.' USING ERRCODE = '22023';
  END IF;

  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  PERFORM 1 FROM public.appointments WHERE id = v_appt FOR SHARE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id FOR UPDATE;

  IF r.delivery_status NOT IN ('Sent', 'Delivered') THEN
    RAISE EXCEPTION 'Record that this reminder was sent before recording the client''s response (it is %).',
      r.delivery_status USING ERRCODE = 'P0001';
  END IF;
  IF v_at < r.sent_at THEN
    RAISE EXCEPTION 'The response time cannot be before the reminder was sent.' USING ERRCODE = '22023';
  END IF;
  IF r.client_response IS NOT DISTINCT FROM p_response AND r.response_note IS NOT DISTINCT FROM v_note THEN
    RAISE EXCEPTION 'This response is already recorded.' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.appointment_reminders
    SET client_response = p_response,
        responded_at = v_at,
        response_note = v_note,
        response_recorded_by = auth.uid(),
        response_recorded_by_name = public.current_actor_name()
    WHERE id = p_reminder_id
    RETURNING * INTO r;
  RETURN r;
END;
$$;

-- 5c. Move one pending reminder (between now and the appointment start, keeping reminder 1 <= reminder 2).
CREATE OR REPLACE FUNCTION public.update_reminder_due_at(
  p_reminder_id uuid,
  p_due_at timestamptz,
  p_note text DEFAULT NULL
)
RETURNS public.appointment_reminders
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r public.appointment_reminders%ROWTYPE;
  appt record;
  v_appt uuid;
  sibling_due timestamptz;
BEGIN
  PERFORM public._assert_crm_staff_member(false);
  SELECT appointment_id INTO v_appt FROM public.appointment_reminders WHERE id = p_reminder_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This reminder no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  SELECT a.starts_at, a.status INTO appt FROM public.appointments AS a WHERE a.id = v_appt FOR SHARE;
  -- Lock both slots of this appointment in a fixed order.
  PERFORM 1 FROM public.appointment_reminders WHERE appointment_id = v_appt ORDER BY reminder_number FOR UPDATE;
  SELECT * INTO r FROM public.appointment_reminders WHERE id = p_reminder_id;

  IF r.delivery_status <> 'Pending' THEN
    RAISE EXCEPTION 'Only a pending reminder can be moved (this one is %).', r.delivery_status USING ERRCODE = 'P0001';
  END IF;
  IF appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RAISE EXCEPTION 'The appointment is %; its reminders cannot be moved.', appt.status USING ERRCODE = 'P0001';
  END IF;
  IF p_due_at IS NULL OR p_due_at < now() OR p_due_at >= appt.starts_at THEN
    RAISE EXCEPTION 'Choose a reminder time between now and the start of the appointment.' USING ERRCODE = '22023';
  END IF;
  SELECT s.due_at INTO sibling_due FROM public.appointment_reminders AS s
  WHERE s.appointment_id = r.appointment_id AND s.reminder_number <> r.reminder_number;
  IF (r.reminder_number = 1 AND p_due_at > sibling_due) OR (r.reminder_number = 2 AND p_due_at < sibling_due) THEN
    RAISE EXCEPTION 'Reminder 1 must be due no later than reminder 2.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('kappiness.reminder_note', coalesce(left(nullif(btrim(p_note), ''), 1000), ''), true);
  UPDATE public.appointment_reminders SET due_at = p_due_at WHERE id = p_reminder_id RETURNING * INTO r;
  PERFORM set_config('kappiness.reminder_note', '', true);
  RETURN r;
END;
$$;

-- 5d. Timing configuration (admins). Applies to reminders created from now on; existing ones are unchanged.
CREATE OR REPLACE FUNCTION public.set_reminder_offsets(p_first_before_start interval, p_second_before_start interval)
RETURNS SETOF public.appointment_reminder_settings
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  PERFORM public._assert_crm_staff_member(true);
  IF p_first_before_start IS NULL OR p_second_before_start IS NULL
     OR p_second_before_start <= interval '0' OR p_first_before_start > interval '30 days' THEN
    RAISE EXCEPTION 'Reminder offsets must be between 0 and 30 days before the appointment.' USING ERRCODE = '22023';
  END IF;
  IF p_first_before_start <= p_second_before_start THEN
    RAISE EXCEPTION 'Reminder 1 must be sent earlier than reminder 2 (a longer time before the appointment).'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.appointment_reminder_settings AS s (reminder_number, offset_before_start, updated_at, updated_by, updated_by_name)
  VALUES (1, p_first_before_start, now(), auth.uid(), public.current_actor_name()),
         (2, p_second_before_start, now(), auth.uid(), public.current_actor_name())
  ON CONFLICT (reminder_number) DO UPDATE
    SET offset_before_start = EXCLUDED.offset_before_start, updated_at = EXCLUDED.updated_at,
        updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name;

  RETURN QUERY SELECT * FROM public.appointment_reminder_settings ORDER BY reminder_number;
END;
$$;

/* =====================================================================
   6. Row Level Security and grants: active CRM staff read; all writes go through the functions above.
   ===================================================================== */

ALTER TABLE public.appointment_reminder_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_reminder_events ENABLE ROW LEVEL SECURITY;

-- Default privileges in public grant ALL to anon and authenticated on new tables: take everything back.
REVOKE ALL ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events FROM PUBLIC, anon, authenticated;
REVOKE TRUNCATE ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events FROM service_role;
GRANT SELECT ON TABLE public.appointment_reminder_settings, public.appointment_reminders,
  public.appointment_reminder_events TO authenticated;
-- The identity sequence behind event_seq also received the schema's default sequence grants.
DO $$
BEGIN
  EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated',
                 pg_get_serial_sequence('public.appointment_reminder_events', 'event_seq'));
END
$$;

DROP POLICY IF EXISTS appointment_reminder_settings_staff_read ON public.appointment_reminder_settings;
CREATE POLICY appointment_reminder_settings_staff_read ON public.appointment_reminder_settings
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

DROP POLICY IF EXISTS appointment_reminders_staff_read ON public.appointment_reminders;
CREATE POLICY appointment_reminders_staff_read ON public.appointment_reminders
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

DROP POLICY IF EXISTS appointment_reminder_events_staff_read ON public.appointment_reminder_events;
CREATE POLICY appointment_reminder_events_staff_read ON public.appointment_reminder_events
  FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.crm_staff_members AS m
                 WHERE m.user_id = (SELECT auth.uid()) AND m.is_active = true));

-- Internal and trigger functions: nobody through the API.
REVOKE ALL ON FUNCTION
  public._assert_crm_staff_member(boolean),
  public._create_appointment_reminders(uuid),
  public.appointment_reminders_before_write(),
  public.appointment_reminders_log_event(),
  public.appointment_reminders_block_delete(),
  public.appointment_reminders_on_appointment_insert(),
  public.appointment_reminders_on_appointment_status()
FROM PUBLIC, anon, authenticated;

-- RPCs: signed-in users may call them; each one checks for an active staff (or admin) membership itself.
REVOKE ALL ON FUNCTION
  public.record_reminder_delivery(uuid, text, timestamptz, text),
  public.record_reminder_response(uuid, text, text, timestamptz),
  public.update_reminder_due_at(uuid, timestamptz, text),
  public.set_reminder_offsets(interval, interval)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.record_reminder_delivery(uuid, text, timestamptz, text),
  public.record_reminder_response(uuid, text, text, timestamptz),
  public.update_reminder_due_at(uuid, timestamptz, text),
  public.set_reminder_offsets(interval, interval)
TO authenticated;

COMMENT ON TABLE public.appointment_reminders IS
  'Two reminder slots per follow-up appointment (202611130002). Written only by triggers and reminder RPCs.';
COMMENT ON TABLE public.appointment_reminder_events IS
  'Append-only history of appointment_reminders changes (202611130002).';
COMMENT ON TABLE public.appointment_reminder_settings IS
  'How long before the appointment reminders 1 and 2 are due. Change with set_reminder_offsets() (202611130002).';

/* =====================================================================
   7. Backfill: active, future follow-up appointments that existed before this migration.
   ===================================================================== */
DO $$
DECLARE
  n integer := 0;
  a record;
BEGIN
  FOR a IN
    SELECT id FROM public.appointments
    WHERE recommendation_id IS NOT NULL AND status IN ('Scheduled', 'Confirmed') AND starts_at > now()
    ORDER BY starts_at
  LOOP
    n := n + public._create_appointment_reminders(a.id);
  END LOOP;
  RAISE NOTICE 'appointment_reminders backfill: % reminder(s) created for existing follow-up appointments.', n;
END
$$;

/* =====================================================================
   8. Self-check (NULL-safe): fail and roll back unless the security shape is exactly as intended.
   ===================================================================== */
DO $$
DECLARE
  t text;
  fn text;
BEGIN
  FOREACH t IN ARRAY ARRAY['public.appointment_reminder_settings', 'public.appointment_reminders',
                           'public.appointment_reminder_events'] LOOP
    IF (SELECT relrowsecurity FROM pg_class WHERE oid = t::regclass) IS DISTINCT FROM true THEN
      RAISE EXCEPTION 'RLS is not enabled on %.', t;
    END IF;
    IF has_table_privilege('anon', t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'anon has privileges on %.', t;
    END IF;
    IF has_table_privilege('authenticated', t, 'SELECT') IS DISTINCT FROM true
       OR has_table_privilege('authenticated', t, 'INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER') IS DISTINCT FROM false THEN
      RAISE EXCEPTION 'authenticated must have SELECT only on %.', t;
    END IF;
  END LOOP;

  FOREACH fn IN ARRAY ARRAY['public._assert_crm_staff_member(boolean)', 'public._create_appointment_reminders(uuid)',
                            'public.appointment_reminders_on_appointment_insert()',
                            'public.appointment_reminders_on_appointment_status()'] LOOP
    IF has_function_privilege('authenticated', fn, 'EXECUTE') IS DISTINCT FROM false
       OR has_function_privilege('anon', fn, 'EXECUTE') IS DISTINCT FROM false THEN
      RAISE EXCEPTION '% must not be executable through the API.', fn;
    END IF;
  END LOOP;
  FOREACH fn IN ARRAY ARRAY['public.record_reminder_delivery(uuid, text, timestamptz, text)',
                            'public.record_reminder_response(uuid, text, text, timestamptz)',
                            'public.update_reminder_due_at(uuid, timestamptz, text)',
                            'public.set_reminder_offsets(interval, interval)'] LOOP
    IF has_function_privilege('anon', fn, 'EXECUTE') IS DISTINCT FROM false
       OR has_function_privilege('authenticated', fn, 'EXECUTE') IS DISTINCT FROM true THEN
      RAISE EXCEPTION '% has the wrong execute privileges.', fn;
    END IF;
  END LOOP;

  IF (SELECT count(*) FROM pg_trigger
      WHERE tgrelid = 'public.appointments'::regclass AND NOT tgisinternal
        AND tgname IN ('appointments_create_reminders', 'appointments_cancel_pending_reminders')) <> 2 THEN
    RAISE EXCEPTION 'The appointment reminder triggers are missing.';
  END IF;
  IF (SELECT count(*) FROM public.appointment_reminder_settings WHERE reminder_number IN (1, 2)) <> 2 THEN
    RAISE EXCEPTION 'appointment_reminder_settings must have reminders 1 and 2.';
  END IF;
END
$$;

COMMIT;
