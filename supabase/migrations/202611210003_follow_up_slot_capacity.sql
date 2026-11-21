-- Kappiness CRM: follow-up slot capacity, slot holds and slot status.
-- Owner: Sariga (follow-up workflow).
--
-- WHY
--   Reception proposes a slot for a client's next session (Type A follow-up) and waits for the client to confirm.
--   Until now nothing reserved that slot, so it could be booked for someone else meanwhile, and there was no
--   per-psychologist limit on how many follow-up sessions a day can hold.
--
-- WHAT THIS ADDS (nothing existing is changed)
--   public.follow_up_slot_capacity  one row per psychologist: max_follow_up_slots_per_day
--                                   (NULL = no extra limit: the free working-hour slots are the limit).
--   follow_ups_no_overlapping_holds EXCLUDE constraint on public.follow_ups (from 202611210002): two holds
--                                   (status Tentative / Pending Confirmation) of one psychologist never overlap,
--                                   buffer included. Same idea as appointments_no_overlap.
--   appointments_respect_follow_up_holds
--                                   NEW BEFORE INSERT trigger on appointments: an active booking cannot take a
--                                   held slot. Existing triggers and functions are not modified.
--   follow_up_slot_grid(...)        working-hour slots of one day, same rule as app/lib/appointmentSlots.js
--                                   slotsForDay (each weekly period filled from its own start, step
--                                   duration + buffer).
--   follow_up_slots_used(...)       follow-up slots used on a day: holds + active follow-up appointments.
--   public.follow_up_slot_status    view: Available / Tentative / Booked / Confirmed per slot for the next 28 days,
--                                   with capacity, used and remaining follow-up slots per psychologist per day.
--   Functions (SECURITY DEFINER, permission-checked):
--     set_follow_up_slot_capacity(psychologist, max)  staff.
--     propose_follow_up_slot(follow_up, start, service, psychologist, status)
--                                   holds a slot after checking working hours and leave (_assert_slot_available,
--                                   the check book_appointment uses), existing appointments and daily capacity.
--     confirm_follow_up_slot(follow_up)
--                                   books through book_appointment (not bypassed), then marks the follow-up
--                                   confirmation_status = 'Confirmed' with the appointment linked.
--
-- HOW HOLDS AND appointments_no_overlap WORK TOGETHER
--   An EXCLUDE constraint only sees its own table, so the two are combined like this:
--     hold vs hold                 follow_ups_no_overlapping_holds (database constraint, race-proof).
--     appointment vs appointment   appointments_no_overlap (unchanged).
--     new hold vs appointments     propose_follow_up_slot checks active appointments.
--     new appointment vs holds     trigger appointments_respect_follow_up_holds.
--   The last two are cross-table checks. Both run after taking the same per-psychologist transaction advisory lock
--   (_follow_up_slot_lock), and each check is a new statement (READ COMMITTED), so a concurrent hold and booking
--   for the same psychologist are serialised and the second one sees the first. Lock order is always
--   psychologist row (FOR SHARE, as book_appointment) -> advisory lock, so no deadlock with booking.
--   Confirmation releases the hold and books in the same transaction; if book_appointment fails (overlap, outside
--   hours, past time, ...), everything rolls back and the hold stays.
--
-- ACCESS
--   As 202611210002: staff read all; a psychologist reads own rows; writes only through the functions.
--
-- PREREQUISITES
--   202611210002 (follow_ups), 202611040001 (book_appointment, _assert_slot_available, btree_gist). Checked below.
--
-- AFTER APPLYING
--   1. propose_follow_up_slot twice for the same psychologist and time (two follow-ups): the second fails.
--   2. book_appointment over a held slot: fails ("held for a follow-up").
--   3. confirm_follow_up_slot: one appointment is created, follow-up Upcoming / Confirmed with appointment_id.
--   4. set_follow_up_slot_capacity(p, 1), then hold two slots on one day: the second fails.
--   Do NOT deploy with `supabase db push` (see supabase/migrations/README.md).
--
-- ROLLBACK
--   BEGIN;
--   DROP TRIGGER IF EXISTS appointments_respect_follow_up_holds ON public.appointments;
--   DROP VIEW IF EXISTS public.follow_up_slot_status;
--   DROP FUNCTION IF EXISTS public.confirm_follow_up_slot(uuid),
--     public.propose_follow_up_slot(uuid, timestamptz, uuid, uuid, text),
--     public.set_follow_up_slot_capacity(uuid, integer), public.follow_up_slots_used(uuid, date, uuid),
--     public.follow_up_slot_grid(uuid, date, integer, integer), public.appointments_respect_follow_up_holds(),
--     public._follow_up_slot_lock(uuid);
--   ALTER TABLE public.follow_ups DROP CONSTRAINT IF EXISTS follow_ups_no_overlapping_holds;
--   DROP TABLE IF EXISTS public.follow_up_slot_capacity;
--   COMMIT;
--   Dropping only the trigger restores booking exactly as before; holds then only block other holds.
--
-- Safe to re-run (IF NOT EXISTS / CREATE OR REPLACE / DROP ... IF EXISTS).

BEGIN;

/* =====================================================================
   0. Prerequisites
   ===================================================================== */
DO $$
BEGIN
  IF to_regclass('public.follow_ups') IS NULL THEN
    RAISE EXCEPTION 'Apply 202611210002_follow_ups_and_communication.sql first.';
  END IF;
  IF to_regprocedure('public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text)') IS NULL
     OR to_regprocedure('public._assert_slot_available(uuid, timestamptz, timestamptz)') IS NULL
     OR to_regprocedure('public._can_manage_psychologist(uuid)') IS NULL THEN
    RAISE EXCEPTION 'book_appointment / _assert_slot_available / _can_manage_psychologist are missing. Apply 202611040001 first.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION 'btree_gist is missing (created by 202611040001).';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'appointments_before_write'
                 AND tgrelid = 'public.appointments'::regclass) THEN
    RAISE EXCEPTION 'appointments_before_write (sets blocked_until) is missing; the hold trigger depends on it.';
  END IF;
END
$$;

/* =====================================================================
   1. Daily capacity per psychologist
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.follow_up_slot_capacity (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psychologist_id uuid NOT NULL UNIQUE REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  -- NULL = no extra limit: as many follow-ups as free working-hour slots allow.
  max_follow_up_slots_per_day integer CHECK (max_follow_up_slots_per_day BETWEEN 0 AND 48),
  updated_by uuid DEFAULT auth.uid(),
  updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

/* =====================================================================
   2. Holds: no two holds of one psychologist overlap (buffer included)
   ===================================================================== */

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conname = 'follow_ups_no_overlapping_holds' AND conrelid = 'public.follow_ups'::regclass) THEN
    ALTER TABLE public.follow_ups
      ADD CONSTRAINT follow_ups_no_overlapping_holds EXCLUDE USING gist (
        psychologist_id WITH =,
        tstzrange(proposed_starts_at, proposed_blocked_until, '[)') WITH &&
      ) WHERE (status IN ('Tentative', 'Pending Confirmation'));
  END IF;
END
$$;

-- Internal: serialises slot decisions (holds and bookings) for one psychologist until the transaction ends.
CREATE OR REPLACE FUNCTION public._follow_up_slot_lock(p_psychologist_id uuid)
RETURNS void
LANGUAGE sql
VOLATILE
SET search_path = public
AS $$
  SELECT pg_advisory_xact_lock(hashtextextended('kappiness.follow_up_slot:' || p_psychologist_id::text, 0));
$$;

-- New trigger: an active booking cannot take a held slot. Runs after appointments_before_write (alphabetical
-- order of BEFORE triggers), so NEW.blocked_until is already set.
CREATE OR REPLACE FUNCTION public.appointments_respect_follow_up_holds()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  PERFORM public._follow_up_slot_lock(NEW.psychologist_id);
  IF EXISTS (
    SELECT 1 FROM public.follow_ups AS f
    WHERE f.psychologist_id = NEW.psychologist_id
      AND f.status IN ('Tentative', 'Pending Confirmation')
      AND tstzrange(f.proposed_starts_at, f.proposed_blocked_until, '[)')
          && tstzrange(NEW.starts_at, NEW.blocked_until, '[)')
  ) THEN
    -- P0001, not 23P01: book_appointment rewrites exclusion_violation into its generic overlap message.
    RAISE EXCEPTION 'That time is held for a follow-up waiting for confirmation. Choose another slot.' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_respect_follow_up_holds ON public.appointments;
CREATE TRIGGER appointments_respect_follow_up_holds
  BEFORE INSERT ON public.appointments
  FOR EACH ROW
  WHEN (NEW.status IN ('Scheduled', 'Confirmed'))
  EXECUTE FUNCTION public.appointments_respect_follow_up_holds();

/* =====================================================================
   3. Slot logic
   ===================================================================== */

-- Working-hour slots of one clinic-local day (same rule as slotsForDay in app/lib/appointmentSlots.js).
-- SECURITY INVOKER: the caller's RLS on psychologist_availability applies.
CREATE OR REPLACE FUNCTION public.follow_up_slot_grid(
  p_psychologist_id uuid,
  p_day date,
  p_duration_minutes integer,
  p_buffer_minutes integer
)
RETURNS TABLE (slot_start timestamptz, slot_end timestamptz, slot_blocked_until timestamptz)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT DISTINCT
    (p_day + make_interval(mins => g.m)) AT TIME ZONE public.clinic_timezone(),
    (p_day + make_interval(mins => g.m + greatest(p_duration_minutes, 5))) AT TIME ZONE public.clinic_timezone(),
    (p_day + make_interval(mins => g.m + greatest(p_duration_minutes, 5) + greatest(p_buffer_minutes, 0)))
      AT TIME ZONE public.clinic_timezone()
  FROM public.psychologist_availability AS a
  CROSS JOIN LATERAL generate_series(
    (extract(epoch FROM a.start_time) / 60)::integer,
    (extract(epoch FROM a.end_time) / 60)::integer - greatest(p_duration_minutes, 5),
    greatest(p_duration_minutes, 5) + greatest(p_buffer_minutes, 0)
  ) AS g(m)
  WHERE a.psychologist_id = p_psychologist_id
    AND a.is_active
    AND a.day_of_week = extract(isodow FROM p_day)::integer
  ORDER BY 1;
$$;

-- Follow-up slots used on one clinic-local day: active holds + active follow-up appointments
-- (recommendation_id set, as 202611130002 defines a follow-up appointment, or linked from follow_ups).
CREATE OR REPLACE FUNCTION public.follow_up_slots_used(p_psychologist_id uuid, p_day date, p_exclude_follow_up_id uuid DEFAULT NULL)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT (
    (SELECT count(*) FROM public.follow_ups AS f
     WHERE f.psychologist_id = p_psychologist_id
       AND f.status IN ('Tentative', 'Pending Confirmation')
       AND (f.proposed_starts_at AT TIME ZONE public.clinic_timezone())::date = p_day
       AND f.id IS DISTINCT FROM p_exclude_follow_up_id)
    +
    (SELECT count(*) FROM public.appointments AS a
     WHERE a.psychologist_id = p_psychologist_id
       AND a.status IN ('Scheduled', 'Confirmed')
       AND (a.starts_at AT TIME ZONE public.clinic_timezone())::date = p_day
       AND (a.recommendation_id IS NOT NULL
            OR EXISTS (SELECT 1 FROM public.follow_ups AS f2 WHERE f2.appointment_id = a.id)))
  )::integer;
$$;

/* =====================================================================
   4. View: slot states and remaining follow-up slots (next 28 clinic days, future slots, outside leave)
   Slot length here is the services default (50 min + 10 min buffer); propose_follow_up_slot uses the real
   service. security_invoker: staff see all psychologists, a psychologist sees only their own.
   ===================================================================== */

CREATE OR REPLACE VIEW public.follow_up_slot_status
WITH (security_invoker = true) AS
WITH grid AS (
  SELECT p.id AS psychologist_id, d.day::date AS slot_date, g.slot_start, g.slot_end, g.slot_blocked_until
  FROM public.psychologists AS p
  CROSS JOIN LATERAL generate_series(
    ((now() AT TIME ZONE public.clinic_timezone())::date)::timestamp,
    ((now() AT TIME ZONE public.clinic_timezone())::date + 27)::timestamp,
    interval '1 day'
  ) AS d(day)
  CROSS JOIN LATERAL public.follow_up_slot_grid(p.id, d.day::date, 50, 10) AS g
  WHERE p.is_active
    AND (public.is_crm_staff() OR p.id = public.current_psychologist_id())
),
classified AS (
  SELECT grid.*,
    grid.slot_start <= now() AS is_past,
    EXISTS (SELECT 1 FROM public.psychologist_availability_exceptions AS e
            WHERE e.psychologist_id = grid.psychologist_id
              AND e.starts_at < grid.slot_end AND grid.slot_start < e.ends_at) AS on_leave,
    (SELECT a.status FROM public.appointments AS a
     WHERE a.psychologist_id = grid.psychologist_id AND a.status IN ('Scheduled', 'Confirmed')
       AND a.starts_at < grid.slot_blocked_until AND grid.slot_start < a.blocked_until
     ORDER BY (a.status = 'Confirmed') DESC
     LIMIT 1) AS appointment_status,
    (SELECT f.id FROM public.follow_ups AS f
     WHERE f.psychologist_id = grid.psychologist_id AND f.status IN ('Tentative', 'Pending Confirmation')
       AND f.proposed_starts_at < grid.slot_blocked_until AND grid.slot_start < f.proposed_blocked_until
     ORDER BY f.proposed_starts_at
     LIMIT 1) AS held_by_follow_up_id
  FROM grid
),
per_day AS (
  SELECT c.*,
    CASE
      WHEN c.appointment_status = 'Confirmed' THEN 'Confirmed'
      WHEN c.appointment_status = 'Scheduled' THEN 'Booked'
      WHEN c.held_by_follow_up_id IS NOT NULL THEN 'Tentative'
      ELSE 'Available'
    END AS slot_state,
    count(*) OVER w AS day_working_slots,
    count(*) FILTER (WHERE c.appointment_status IS NULL AND c.held_by_follow_up_id IS NULL
                       AND NOT c.is_past AND NOT c.on_leave) OVER w AS day_available_slots
  FROM classified AS c
  WINDOW w AS (PARTITION BY c.psychologist_id, c.slot_date)
)
SELECT
  pd.psychologist_id,
  pd.slot_date,
  pd.slot_start,
  pd.slot_end,
  pd.slot_blocked_until,
  pd.slot_state,
  pd.held_by_follow_up_id,
  cap.max_follow_up_slots_per_day,
  coalesce(cap.max_follow_up_slots_per_day, pd.day_working_slots::integer) AS day_follow_up_capacity,
  u.used AS day_follow_up_slots_used,
  CASE
    WHEN cap.max_follow_up_slots_per_day IS NULL THEN pd.day_available_slots::integer
    ELSE greatest(0, least(cap.max_follow_up_slots_per_day - u.used, pd.day_available_slots::integer))
  END AS day_remaining_slots
FROM per_day AS pd
LEFT JOIN public.follow_up_slot_capacity AS cap ON cap.psychologist_id = pd.psychologist_id
CROSS JOIN LATERAL (SELECT public.follow_up_slots_used(pd.psychologist_id, pd.slot_date) AS used) AS u
WHERE NOT pd.is_past AND NOT pd.on_leave;

/* =====================================================================
   5. Functions
   ===================================================================== */

-- Staff set (or clear, with NULL) a psychologist's daily follow-up limit.
CREATE OR REPLACE FUNCTION public.set_follow_up_slot_capacity(p_psychologist_id uuid, p_max integer)
RETURNS public.follow_up_slot_capacity
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  saved public.follow_up_slot_capacity%ROWTYPE;
BEGIN
  IF NOT coalesce(public.is_crm_staff(), false) THEN
    RAISE EXCEPTION 'Only CRM staff can change follow-up capacity.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = p_psychologist_id) THEN
    RAISE EXCEPTION 'This psychologist no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF p_max IS NOT NULL AND (p_max < 0 OR p_max > 48) THEN
    RAISE EXCEPTION 'Choose between 0 and 48 follow-up slots per day, or leave it empty.' USING ERRCODE = '22023';
  END IF;
  INSERT INTO public.follow_up_slot_capacity (psychologist_id, max_follow_up_slots_per_day, updated_by, updated_by_name)
  VALUES (p_psychologist_id, p_max, auth.uid(), public.current_actor_name())
  ON CONFLICT (psychologist_id) DO UPDATE
    SET max_follow_up_slots_per_day = EXCLUDED.max_follow_up_slots_per_day,
        updated_by = EXCLUDED.updated_by, updated_by_name = EXCLUDED.updated_by_name, updated_at = now()
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

-- Hold a slot for a Type A follow-up (Tentative, or Pending Confirmation when the client has been asked).
-- Calling it again for the same follow-up moves its hold.
CREATE OR REPLACE FUNCTION public.propose_follow_up_slot(
  p_follow_up_id uuid,
  p_starts_at timestamptz,
  p_service_id uuid,
  p_psychologist_id uuid DEFAULT NULL,
  p_status text DEFAULT 'Tentative'
)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
  cli public.clients%ROWTYPE;
  svc public.services%ROWTYPE;
  target uuid;
  v_end timestamptz;
  v_held timestamptz;
  v_max integer;
  v_used integer;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to propose a follow-up slot.' USING ERRCODE = '42501';
  END IF;
  IF p_status IS NULL OR p_status NOT IN ('Tentative', 'Pending Confirmation') THEN
    RAISE EXCEPTION 'A proposed slot is Tentative or Pending Confirmation.' USING ERRCODE = '22023';
  END IF;

  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.follow_up_type <> 'Type A' THEN
    RAISE EXCEPTION 'Only a Type A follow-up (next session) can hold a slot.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status IN ('Completed', 'No Follow-up Required') OR f.appointment_id IS NOT NULL THEN
    RAISE EXCEPTION 'This follow-up is already booked or closed.' USING ERRCODE = 'P0001';
  END IF;

  target := coalesce(p_psychologist_id, f.psychologist_id);
  IF NOT (coalesce(public._can_manage_psychologist(f.psychologist_id), false)
          AND coalesce(public._can_manage_psychologist(target), false)) THEN
    RAISE EXCEPTION 'You do not have permission to propose a slot for this follow-up.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = target AND is_active) THEN
    RAISE EXCEPTION 'Choose an active psychologist.' USING ERRCODE = 'P0001';
  END IF;
  -- Same client rules as book_appointment, so a hold never promises what booking would refuse.
  SELECT * INTO cli FROM public.clients WHERE id = f.client_id;
  IF NOT FOUND OR NOT cli.is_active THEN
    RAISE EXCEPTION 'Choose an existing, active client.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT coalesce(public.is_crm_staff(), false) AND cli.primary_psychologist_id <> target THEN
    RAISE EXCEPTION 'You can only propose slots for your own clients.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO svc FROM public.services WHERE id = p_service_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active service.' USING ERRCODE = 'P0001';
  END IF;
  IF p_starts_at IS NULL OR p_starts_at <= now() THEN
    RAISE EXCEPTION 'Choose a time in the future.' USING ERRCODE = 'P0001';
  END IF;
  v_end := p_starts_at + make_interval(mins => svc.duration_minutes);
  v_held := v_end + make_interval(mins => svc.buffer_minutes);

  -- Lock order as book_appointment: psychologist row (shared) first, then the slot lock.
  PERFORM 1 FROM public.psychologists WHERE id = target FOR SHARE;
  PERFORM public._follow_up_slot_lock(target);

  -- Working hours and leave: the same check book_appointment runs.
  PERFORM public._assert_slot_available(target, p_starts_at, v_end);

  IF EXISTS (
    SELECT 1 FROM public.appointments AS a
    WHERE a.psychologist_id = target AND a.status IN ('Scheduled', 'Confirmed')
      AND tstzrange(a.starts_at, a.blocked_until, '[)') && tstzrange(p_starts_at, v_held, '[)')
  ) THEN
    RAISE EXCEPTION 'That time overlaps another booking for this psychologist. Choose another slot.' USING ERRCODE = '23P01';
  END IF;

  SELECT c.max_follow_up_slots_per_day INTO v_max FROM public.follow_up_slot_capacity AS c WHERE c.psychologist_id = target;
  IF v_max IS NOT NULL THEN
    v_used := public.follow_up_slots_used(target, (p_starts_at AT TIME ZONE public.clinic_timezone())::date, f.id);
    IF v_used >= v_max THEN
      RAISE EXCEPTION 'No follow-up slots left that day (% of % used).', v_used, v_max USING ERRCODE = 'P0001';
    END IF;
  END IF;

  BEGIN
    UPDATE public.follow_ups
      SET psychologist_id = target, status = p_status,
          proposed_starts_at = p_starts_at, proposed_ends_at = v_end, proposed_blocked_until = v_held,
          proposed_service_id = svc.id,
          due_on = (p_starts_at AT TIME ZONE public.clinic_timezone())::date,
          confirmation_status = CASE WHEN p_status = 'Pending Confirmation' THEN 'Awaiting Client' ELSE 'Not Requested' END,
          updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
      WHERE id = p_follow_up_id
      RETURNING * INTO f;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time is already held for another follow-up. Choose another slot.' USING ERRCODE = '23P01';
  END;

  PERFORM public._log_client_activity(f.client_id,
    format('Follow-up slot proposed (%s): %s', p_status,
           to_char(p_starts_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI')));
  RETURN f;
END;
$$;

-- The client confirmed the held slot: book it through book_appointment and link the appointment.
CREATE OR REPLACE FUNCTION public.confirm_follow_up_slot(p_follow_up_id uuid)
RETURNS public.follow_ups
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  f public.follow_ups%ROWTYPE;
  appt public.appointments%ROWTYPE;
  v_rec_status text;
  v_session uuid;
BEGIN
  SELECT * INTO f FROM public.follow_ups WHERE id = p_follow_up_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This follow-up no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF f.status NOT IN ('Tentative', 'Pending Confirmation') THEN
    RAISE EXCEPTION 'Only a Tentative or Pending Confirmation follow-up can be confirmed.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT coalesce(public._can_manage_psychologist(f.psychologist_id), false) THEN
    RAISE EXCEPTION 'You do not have permission to confirm this follow-up.' USING ERRCODE = '42501';
  END IF;

  PERFORM 1 FROM public.psychologists WHERE id = f.psychologist_id FOR SHARE;
  PERFORM public._follow_up_slot_lock(f.psychologist_id);

  -- Release this follow-up's own hold so the hold trigger does not refuse its own booking.
  -- Same transaction: if the booking fails, the hold comes back with the rollback.
  UPDATE public.follow_ups SET status = 'Upcoming' WHERE id = p_follow_up_id;

  -- Pass the recommendation only while it is Open (book_appointment refuses otherwise); this also makes the
  -- appointment a follow-up appointment, so 202611130002 creates its two reminders.
  IF f.recommendation_id IS NOT NULL THEN
    SELECT r.status INTO v_rec_status FROM public.follow_up_recommendations AS r WHERE r.id = f.recommendation_id;
  END IF;

  SELECT * INTO appt FROM public.book_appointment(
    f.client_id, f.psychologist_id, f.proposed_service_id, f.proposed_starts_at, NULL,
    CASE WHEN v_rec_status = 'Open' THEN f.recommendation_id END, 'Follow-up'
  );

  SELECT s.id INTO v_session FROM public.sessions AS s WHERE s.appointment_id = appt.id;
  UPDATE public.follow_ups
    SET status = 'Upcoming', confirmation_status = 'Confirmed', appointment_id = appt.id, session_id = v_session,
        proposed_ends_at = appt.ends_at, proposed_blocked_until = appt.blocked_until,
        due_on = (appt.starts_at AT TIME ZONE public.clinic_timezone())::date,
        updated_by = auth.uid(), updated_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_follow_up_id
    RETURNING * INTO f;
  RETURN f;
END;
$$;

/* =====================================================================
   6. Row Level Security and grants
   ===================================================================== */

ALTER TABLE public.follow_up_slot_capacity ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.follow_up_slot_capacity, public.follow_up_slot_status FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.follow_up_slot_capacity, public.follow_up_slot_status TO authenticated;

DROP POLICY IF EXISTS follow_up_slot_capacity_read ON public.follow_up_slot_capacity;
CREATE POLICY follow_up_slot_capacity_read ON public.follow_up_slot_capacity FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

-- Internal and trigger functions: nobody through the API.
REVOKE ALL ON FUNCTION
  public._follow_up_slot_lock(uuid),
  public.appointments_respect_follow_up_holds()
FROM PUBLIC, anon, authenticated;

-- Read helpers used by the (security_invoker) view; they run with the caller's RLS.
REVOKE ALL ON FUNCTION
  public.follow_up_slot_grid(uuid, date, integer, integer),
  public.follow_up_slots_used(uuid, date, uuid),
  public.set_follow_up_slot_capacity(uuid, integer),
  public.propose_follow_up_slot(uuid, timestamptz, uuid, uuid, text),
  public.confirm_follow_up_slot(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION
  public.follow_up_slot_grid(uuid, date, integer, integer),
  public.follow_up_slots_used(uuid, date, uuid),
  public.set_follow_up_slot_capacity(uuid, integer),
  public.propose_follow_up_slot(uuid, timestamptz, uuid, uuid, text),
  public.confirm_follow_up_slot(uuid)
TO authenticated;

COMMENT ON TABLE public.follow_up_slot_capacity IS
  'Daily follow-up slot limit per psychologist; NULL = free working-hour slots are the limit (202611210003).';
COMMENT ON VIEW public.follow_up_slot_status IS
  'Available / Tentative / Booked / Confirmed slots and remaining follow-up slots per psychologist per day (202611210003).';

COMMIT;
