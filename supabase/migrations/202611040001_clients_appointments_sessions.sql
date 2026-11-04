-- Kappiness CRM: clients, services, appointments, sessions, follow-up recommendations and blocked dates.
--
-- PREREQUISITE: 202611030002_lead_status_lost_and_psychologist.sql must be applied first
-- (it adds leads.assigned_psychologist_id, which does not exist in the live database yet).
--
-- WHAT THIS ADDS (one transaction; any failure rolls everything back):
--    1. Role helpers used by every policy and function (crm_role, is_crm_staff, current_psychologist_id).
--    2. Lead workflow: the allowed status transitions, staff-only status/assignment changes,
--       an active psychologist before Confirmed.
--    3. services: appointment duration and buffer per service (seeded from the CRM's service list).
--    4. clients: one client per confirmed lead (lead_id is UNIQUE), created automatically on confirmation.
--    5. appointments: bookings with a database-level "no overlapping bookings" rule (including buffer).
--    6. appointment_status_history: every status change, who made it, when and why.
--    7. sessions (+ session_notes, session_status_history): what actually happened, linked 1:1 to an appointment.
--    8. follow_up_recommendations: psychologist recommendations, tracked separately from appointments.
--    9. psychologist_availability_exceptions: blocked dates/periods.
--   10. psychologist_availability: overlap prevention and RLS for psychologists and staff.
--   11. Workflow functions (SECURITY DEFINER, permission-checked): book, confirm, cancel, reschedule,
--       attendance, session update, recommendations, blocking periods, client assignment.
--
-- DESIGN NOTES
--   * Appointment times are stored as starts_at / ends_at (timestamptz) instead of date + time columns. A single
--     instant range is what lets PostgreSQL itself reject overlapping bookings (EXCLUDE constraint), and it is
--     timezone-safe. The date and times are derived from it for display.
--   * Weekly availability is clinic-local time. public.clinic_timezone() says which zone that is
--     (Asia/Kolkata). Change it there if the clinic works in another timezone.
--   * Nothing is ever deleted: cancelled / rescheduled / missed appointments stay, with who and when.
--   * Writes to appointments, sessions and recommendations only happen through the functions below, which check
--     the caller's role. Clients can read through RLS; they cannot write status columns directly.
--
-- ROLES (matches the existing app and proxy.js):
--   psychologist = a login linked through psychologists.auth_user_id (or app_metadata.role = 'psychologist')
--   staff        = app_metadata.role 'admin' or 'staff', or any other signed-in user without a psychologist profile
--   RECOMMENDED: set app_metadata.role explicitly for every staff login and keep public sign-ups disabled,
--   then tighten is_crm_staff() to the explicit roles only.

BEGIN;

CREATE EXTENSION IF NOT EXISTS btree_gist WITH SCHEMA extensions;

-- 0. Prerequisite check.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'assigned_psychologist_id'
  ) THEN
    RAISE EXCEPTION 'Apply 202611030002_lead_status_lost_and_psychologist.sql before this migration.';
  END IF;
END
$$;

/* =====================================================================
   1. Role helpers
   ===================================================================== */

CREATE OR REPLACE FUNCTION public.crm_role()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT lower(coalesce(auth.jwt() -> 'app_metadata' ->> 'role', ''));
$$;

-- The psychologist profile of the signed-in user, or NULL.
CREATE OR REPLACE FUNCTION public.current_psychologist_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.id FROM public.psychologists AS p WHERE p.auth_user_id = auth.uid() LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.is_crm_staff()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL
     AND public.crm_role() <> 'psychologist'
     AND (
       public.crm_role() IN ('admin', 'staff')
       OR NOT EXISTS (SELECT 1 FROM public.psychologists AS p WHERE p.auth_user_id = auth.uid())
     );
$$;

CREATE OR REPLACE FUNCTION public.is_crm_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT auth.uid() IS NOT NULL AND public.crm_role() = 'admin';
$$;

-- Display name of the signed-in user, saved next to *_by columns so history stays readable.
CREATE OR REPLACE FUNCTION public.current_actor_name()
RETURNS text
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  SELECT coalesce(
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'full_name'), ''),
    nullif(btrim(auth.jwt() -> 'user_metadata' ->> 'name'), ''),
    nullif(auth.jwt() ->> 'email', ''),
    'System'
  );
$$;

CREATE OR REPLACE FUNCTION public.clinic_timezone()
RETURNS text
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT 'Asia/Kolkata'::text;
$$;

REVOKE ALL ON FUNCTION public.crm_role(), public.current_psychologist_id(), public.is_crm_staff(),
  public.is_crm_admin(), public.current_actor_name(), public.clinic_timezone() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_role(), public.current_psychologist_id(), public.is_crm_staff(),
  public.is_crm_admin(), public.current_actor_name(), public.clinic_timezone() TO authenticated;

/* =====================================================================
   2. Lead workflow (replaces the trigger function from 202611030002)
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
      WHEN 'Enquiry' THEN ARRAY['Yet to Confirm', 'Lost']
      WHEN 'Yet to Confirm' THEN ARRAY['Enquiry', 'Will Inform', 'Lost']
      WHEN 'Will Inform' THEN ARRAY['Yet to Confirm', 'Confirmed', 'Lost']
      ELSE ARRAY[]::text[] -- Confirmed and Lost are final
    END;
    IF NOT NEW.status = ANY(allowed) THEN
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

/* =====================================================================
   3. Services (duration and buffer per service)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.services (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 2 AND 80),
  duration_minutes integer NOT NULL DEFAULT 50 CHECK (duration_minutes BETWEEN 10 AND 480),
  buffer_minutes integer NOT NULL DEFAULT 10 CHECK (buffer_minutes BETWEEN 0 AND 120),
  is_active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS services_name_key ON public.services (lower(btrim(name)));

-- Configuration seed from the CRM's service list. Durations are defaults: review them in Services settings.
INSERT INTO public.services (name, duration_minutes, buffer_minutes)
VALUES
  ('Individual counselling', 50, 10),
  ('Couples counselling', 60, 10),
  ('Family counselling', 60, 10),
  ('Child & adolescent', 50, 10),
  ('Career guidance', 45, 10),
  ('Workshop / group session', 90, 15)
ON CONFLICT DO NOTHING;

/* =====================================================================
   4. Clients (one per confirmed lead)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.clients (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id uuid NOT NULL UNIQUE REFERENCES public.leads(id) ON DELETE RESTRICT,
  full_name text NOT NULL,
  phone text,
  email text,
  city text,
  preferred_language text,
  preferred_contact text,
  best_time text,
  service_interest text,
  primary_psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  is_active boolean NOT NULL DEFAULT true,
  created_by uuid DEFAULT auth.uid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_clients_primary_psychologist ON public.clients (primary_psychologist_id);

-- Creates (or re-links) the client whenever a lead is Confirmed with a psychologist. Runs inside the same
-- transaction as the lead update, so a lead is never Confirmed without its client.
CREATE OR REPLACE FUNCTION public.sync_client_from_lead()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  lead jsonb := to_jsonb(NEW);
BEGIN
  IF NEW.status = 'Confirmed' AND NEW.assigned_psychologist_id IS NOT NULL THEN
    INSERT INTO public.clients (
      lead_id, full_name, phone, email, city, preferred_language, preferred_contact, best_time,
      service_interest, primary_psychologist_id
    ) VALUES (
      NEW.id,
      coalesce(nullif(btrim(lead ->> 'full_name'), ''), 'Client'),
      lead ->> 'phone', lead ->> 'email', lead ->> 'city', lead ->> 'preferred_language',
      coalesce(lead ->> 'preferred_contact', lead ->> 'contact_method'), lead ->> 'best_time',
      lead ->> 'service_interest', NEW.assigned_psychologist_id
    )
    ON CONFLICT (lead_id) DO UPDATE
      SET primary_psychologist_id = EXCLUDED.primary_psychologist_id, updated_at = now()
      WHERE public.clients.primary_psychologist_id IS DISTINCT FROM EXCLUDED.primary_psychologist_id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS leads_sync_client ON public.leads;
CREATE TRIGGER leads_sync_client
  AFTER INSERT OR UPDATE OF status, assigned_psychologist_id ON public.leads
  FOR EACH ROW
  EXECUTE FUNCTION public.sync_client_from_lead();

-- Backfill clients for leads that are already Confirmed with a psychologist.
INSERT INTO public.clients (
  lead_id, full_name, phone, email, city, preferred_language, preferred_contact, best_time,
  service_interest, primary_psychologist_id, created_by
)
SELECT l.id,
       coalesce(nullif(btrim(to_jsonb(l) ->> 'full_name'), ''), 'Client'),
       to_jsonb(l) ->> 'phone', to_jsonb(l) ->> 'email', to_jsonb(l) ->> 'city',
       to_jsonb(l) ->> 'preferred_language',
       coalesce(to_jsonb(l) ->> 'preferred_contact', to_jsonb(l) ->> 'contact_method'),
       to_jsonb(l) ->> 'best_time', to_jsonb(l) ->> 'service_interest',
       l.assigned_psychologist_id, NULL
FROM public.leads AS l
WHERE l.status = 'Confirmed' AND l.assigned_psychologist_id IS NOT NULL
ON CONFLICT (lead_id) DO NOTHING;

DO $$
DECLARE
  missing integer;
BEGIN
  SELECT count(*) INTO missing FROM public.leads WHERE status = 'Confirmed' AND assigned_psychologist_id IS NULL;
  IF missing > 0 THEN
    RAISE NOTICE '% confirmed lead(s) have no psychologist yet. Assign one in the CRM to create their client profile.', missing;
  END IF;
END
$$;

/* =====================================================================
   5. Appointments
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.appointments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  service_id uuid REFERENCES public.services(id) ON DELETE SET NULL,
  service_type text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  buffer_minutes integer NOT NULL DEFAULT 0 CHECK (buffer_minutes BETWEEN 0 AND 120),
  blocked_until timestamptz NOT NULL, -- ends_at + buffer, maintained by trigger
  status text NOT NULL DEFAULT 'Scheduled'
    CHECK (status IN ('Scheduled', 'Confirmed', 'Rescheduled', 'Cancelled', 'Completed', 'Missed')),
  notes text CHECK (char_length(notes) <= 1000),
  recommendation_id uuid, -- FK added after follow_up_recommendations exists
  created_by uuid DEFAULT auth.uid(),
  created_by_name text,
  confirmed_at timestamptz,
  confirmed_by uuid,
  confirmed_by_name text,
  cancelled_at timestamptz,
  cancelled_by uuid,
  cancelled_by_name text,
  cancellation_reason text,
  rescheduled_from_id uuid REFERENCES public.appointments(id) ON DELETE RESTRICT,
  rescheduled_at timestamptz,
  rescheduled_by uuid,
  rescheduled_by_name text,
  attendance_marked_at timestamptz,
  attendance_marked_by uuid,
  attendance_marked_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT appointments_time_range CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '8 hours'),
  -- Two active bookings (Scheduled / Confirmed) for one psychologist can never overlap, buffer included.
  CONSTRAINT appointments_no_overlap EXCLUDE USING gist (
    psychologist_id WITH =,
    tstzrange(starts_at, blocked_until, '[)') WITH &&
  ) WHERE (status IN ('Scheduled', 'Confirmed'))
);
CREATE INDEX IF NOT EXISTS idx_appointments_psychologist_start ON public.appointments (psychologist_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON public.appointments (client_id, starts_at);
CREATE UNIQUE INDEX IF NOT EXISTS appointments_one_replacement ON public.appointments (rescheduled_from_id)
  WHERE rescheduled_from_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.appointments_before_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  NEW.blocked_until := NEW.ends_at + make_interval(mins => NEW.buffer_minutes);
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_before_write ON public.appointments;
CREATE TRIGGER appointments_before_write
  BEFORE INSERT OR UPDATE ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.appointments_before_write();

/* =====================================================================
   6. Appointment status history (written by trigger, reason via a transaction setting)
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.appointment_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL REFERENCES public.appointments(id) ON DELETE RESTRICT,
  previous_status text,
  new_status text NOT NULL,
  changed_by uuid DEFAULT auth.uid(),
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS idx_appointment_history_appointment ON public.appointment_status_history (appointment_id, changed_at);

CREATE OR REPLACE FUNCTION public.log_appointment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'INSERT' OR NEW.status IS DISTINCT FROM OLD.status THEN
    INSERT INTO public.appointment_status_history (appointment_id, previous_status, new_status, changed_by, changed_by_name, reason)
    VALUES (
      NEW.id,
      CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
      NEW.status,
      auth.uid(),
      public.current_actor_name(),
      nullif(current_setting('kappiness.status_reason', true), '')
    );
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS appointments_log_status ON public.appointments;
CREATE TRIGGER appointments_log_status
  AFTER INSERT OR UPDATE OF status ON public.appointments
  FOR EACH ROW
  EXECUTE FUNCTION public.log_appointment_status();

/* =====================================================================
   7. Sessions, session notes and session status history
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  appointment_id uuid NOT NULL UNIQUE REFERENCES public.appointments(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'Scheduled' CHECK (status IN ('Scheduled', 'Completed', 'Cancelled', 'Missed')),
  session_type text NOT NULL DEFAULT 'Regular' CHECK (session_type IN ('Initial', 'Regular', 'Follow-up', 'Assessment')),
  outcome text CHECK (char_length(outcome) <= 500), -- non-clinical summary, visible to staff
  updated_by uuid,
  updated_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sessions_time_range CHECK (ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS idx_sessions_psychologist_start ON public.sessions (psychologist_id, starts_at);
CREATE INDEX IF NOT EXISTS idx_sessions_client ON public.sessions (client_id, starts_at);

-- Clinical notes live apart from sessions so they can have stricter access (own psychologist + admins).
CREATE TABLE IF NOT EXISTS public.session_notes (
  session_id uuid PRIMARY KEY REFERENCES public.sessions(id) ON DELETE RESTRICT,
  notes text NOT NULL CHECK (char_length(notes) <= 5000),
  updated_by uuid DEFAULT auth.uid(),
  updated_by_name text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.session_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  previous_status text,
  new_status text NOT NULL,
  changed_by uuid DEFAULT auth.uid(),
  changed_by_name text,
  changed_at timestamptz NOT NULL DEFAULT now(),
  reason text
);
CREATE INDEX IF NOT EXISTS idx_session_history_session ON public.session_status_history (session_id, changed_at);

CREATE OR REPLACE FUNCTION public.log_session_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    NEW.updated_at := now();
    IF NEW.status IS NOT DISTINCT FROM OLD.status THEN
      RETURN NEW;
    END IF;
  END IF;
  INSERT INTO public.session_status_history (session_id, previous_status, new_status, changed_by, changed_by_name, reason)
  VALUES (
    NEW.id,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE OLD.status END,
    NEW.status,
    auth.uid(),
    public.current_actor_name(),
    nullif(current_setting('kappiness.status_reason', true), '')
  );
  RETURN NEW;
END;
$$;

-- BEFORE so updated_at is set; the history row only needs NEW.id, which already exists.
DROP TRIGGER IF EXISTS sessions_log_status ON public.sessions;
CREATE TRIGGER sessions_log_status
  BEFORE UPDATE ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_session_status();

DROP TRIGGER IF EXISTS sessions_log_status_insert ON public.sessions;
CREATE TRIGGER sessions_log_status_insert
  AFTER INSERT ON public.sessions
  FOR EACH ROW
  EXECUTE FUNCTION public.log_session_status();

/* =====================================================================
   8. Follow-up recommendations
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.follow_up_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id uuid NOT NULL REFERENCES public.sessions(id) ON DELETE RESTRICT,
  client_id uuid NOT NULL REFERENCES public.clients(id) ON DELETE RESTRICT,
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  recommendation text NOT NULL CHECK (char_length(btrim(recommendation)) BETWEEN 3 AND 2000),
  recommended_date date NOT NULL,
  recommended_time time,
  priority text NOT NULL DEFAULT 'Normal' CHECK (priority IN ('Normal', 'High', 'Urgent')),
  -- Recommendation status is separate from appointment status: Open -> Scheduled (booked) -> Completed, or Dismissed.
  status text NOT NULL DEFAULT 'Open' CHECK (status IN ('Open', 'Scheduled', 'Completed', 'Dismissed')),
  appointment_id uuid REFERENCES public.appointments(id) ON DELETE RESTRICT,
  outcome text CHECK (char_length(outcome) <= 1000),
  completed_at timestamptz,
  completed_by uuid,
  completed_by_name text,
  created_by uuid DEFAULT auth.uid(),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_recommendations_psychologist ON public.follow_up_recommendations (psychologist_id, recommended_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON public.follow_up_recommendations (status, recommended_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_client ON public.follow_up_recommendations (client_id);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'appointments_recommendation_fkey') THEN
    ALTER TABLE public.appointments
      ADD CONSTRAINT appointments_recommendation_fkey
      FOREIGN KEY (recommendation_id) REFERENCES public.follow_up_recommendations(id) ON DELETE RESTRICT;
  END IF;
END
$$;

/* =====================================================================
   9. Blocked dates / periods
   ===================================================================== */

CREATE TABLE IF NOT EXISTS public.psychologist_availability_exceptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  psychologist_id uuid NOT NULL REFERENCES public.psychologists(id) ON DELETE RESTRICT,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL,
  reason text CHECK (char_length(reason) <= 200),
  created_by uuid DEFAULT auth.uid(),
  created_by_name text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT availability_exceptions_range CHECK (ends_at > starts_at AND ends_at - starts_at <= interval '366 days')
);
CREATE INDEX IF NOT EXISTS idx_availability_exceptions ON public.psychologist_availability_exceptions (psychologist_id, starts_at);

/* =====================================================================
   10. Weekly availability: no overlapping active periods for one psychologist on one day
   ===================================================================== */

CREATE OR REPLACE FUNCTION public.check_availability_overlap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public
AS $$
BEGIN
  IF NEW.end_time <= NEW.start_time THEN
    RAISE EXCEPTION 'End time must be later than start time.' USING ERRCODE = '22023';
  END IF;
  IF NEW.is_active AND EXISTS (
    SELECT 1 FROM public.psychologist_availability AS a
    WHERE a.psychologist_id = NEW.psychologist_id
      AND a.day_of_week = NEW.day_of_week
      AND a.is_active
      AND a.id IS DISTINCT FROM NEW.id
      AND a.start_time < NEW.end_time
      AND NEW.start_time < a.end_time
  ) THEN
    RAISE EXCEPTION 'This period overlaps another active period on the same day.' USING ERRCODE = '23P01';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS availability_no_overlap ON public.psychologist_availability;
CREATE TRIGGER availability_no_overlap
  BEFORE INSERT OR UPDATE ON public.psychologist_availability
  FOR EACH ROW
  EXECUTE FUNCTION public.check_availability_overlap();

/* =====================================================================
   11. Workflow functions
   ===================================================================== */

-- Internal: can the caller act on appointments of this psychologist?
CREATE OR REPLACE FUNCTION public._can_manage_psychologist(p_psychologist_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  -- coalesce: a NULL here must mean "no", never "unknown" (IF NOT NULL would let the caller through).
  SELECT coalesce(public.is_crm_staff(), false)
      OR coalesce(p_psychologist_id IS NOT NULL AND p_psychologist_id = public.current_psychologist_id(), false);
$$;

-- Internal: raises when [p_start, p_end) is outside weekly availability or inside a blocked period.
CREATE OR REPLACE FUNCTION public._assert_slot_available(p_psychologist_id uuid, p_start timestamptz, p_end timestamptz)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  local_start timestamp := p_start AT TIME ZONE public.clinic_timezone();
  local_end timestamp := p_end AT TIME ZONE public.clinic_timezone();
BEGIN
  IF local_start::date <> (local_end - interval '1 microsecond')::date THEN
    RAISE EXCEPTION 'An appointment must start and end on the same day.' USING ERRCODE = 'P0001';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.psychologist_availability AS a
    WHERE a.psychologist_id = p_psychologist_id
      AND a.is_active
      AND a.day_of_week = extract(isodow FROM local_start)::int
      AND a.start_time <= local_start::time
      AND a.end_time >= local_end::time
  ) THEN
    RAISE EXCEPTION 'That time is outside the psychologist''s working hours.' USING ERRCODE = 'P0001';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.psychologist_availability_exceptions AS e
    WHERE e.psychologist_id = p_psychologist_id AND e.starts_at < p_end AND p_start < e.ends_at
  ) THEN
    RAISE EXCEPTION 'The psychologist is unavailable at that time.' USING ERRCODE = 'P0001';
  END IF;
END;
$$;

-- Internal: best-effort lead history entry. A failure here never blocks the scheduling change.
CREATE OR REPLACE FUNCTION public._log_client_activity(p_client_id uuid, p_text text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO public.lead_activities (lead_id, activity_type, staff_member, notes)
  SELECT c.lead_id, 'Lead update', public.current_actor_name(), p_text
  FROM public.clients AS c WHERE c.id = p_client_id;
EXCEPTION WHEN others THEN
  RAISE NOTICE 'Lead activity not recorded: %', SQLERRM;
END;
$$;

-- Book. Staff: any active psychologist. Psychologist: only themselves, and only their own clients.
CREATE OR REPLACE FUNCTION public.book_appointment(
  p_client_id uuid,
  p_psychologist_id uuid,
  p_service_id uuid,
  p_starts_at timestamptz,
  p_notes text DEFAULT NULL,
  p_recommendation_id uuid DEFAULT NULL,
  p_session_type text DEFAULT NULL
)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  svc public.services%ROWTYPE;
  cli public.clients%ROWTYPE;
  rec public.follow_up_recommendations%ROWTYPE;
  saved public.appointments%ROWTYPE;
  v_end timestamptz;
  v_type text;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Sign in to book appointments.' USING ERRCODE = '42501';
  END IF;
  IF NOT public._can_manage_psychologist(p_psychologist_id) THEN
    RAISE EXCEPTION 'You can only book appointments for yourself.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = p_psychologist_id AND is_active) THEN
    RAISE EXCEPTION 'Choose an active psychologist.' USING ERRCODE = 'P0001';
  END IF;

  SELECT * INTO cli FROM public.clients WHERE id = p_client_id;
  IF NOT FOUND OR NOT cli.is_active THEN
    RAISE EXCEPTION 'Choose an existing, active client.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public.is_crm_staff() AND cli.primary_psychologist_id <> p_psychologist_id THEN
    RAISE EXCEPTION 'You can only book your own clients.' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO svc FROM public.services WHERE id = p_service_id AND is_active;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Choose an active service.' USING ERRCODE = 'P0001';
  END IF;

  IF p_starts_at IS NULL OR p_starts_at <= now() THEN
    RAISE EXCEPTION 'Choose a time in the future.' USING ERRCODE = 'P0001';
  END IF;
  v_end := p_starts_at + make_interval(mins => svc.duration_minutes);
  -- Shared lock: waits for (and is checked after) any blocked period being added for this psychologist.
  PERFORM 1 FROM public.psychologists WHERE id = p_psychologist_id FOR SHARE;
  PERFORM public._assert_slot_available(p_psychologist_id, p_starts_at, v_end);

  IF p_recommendation_id IS NOT NULL THEN
    SELECT * INTO rec FROM public.follow_up_recommendations WHERE id = p_recommendation_id FOR UPDATE;
    IF NOT FOUND OR rec.client_id <> p_client_id THEN
      RAISE EXCEPTION 'That recommendation does not belong to this client.' USING ERRCODE = 'P0001';
    END IF;
    IF rec.status <> 'Open' THEN
      RAISE EXCEPTION 'That recommendation has already been scheduled or closed.' USING ERRCODE = 'P0001';
    END IF;
  END IF;

  BEGIN
    INSERT INTO public.appointments (
      client_id, psychologist_id, service_id, service_type, starts_at, ends_at, buffer_minutes, status,
      notes, recommendation_id, created_by, created_by_name
    ) VALUES (
      p_client_id, p_psychologist_id, svc.id, svc.name, p_starts_at, v_end, svc.buffer_minutes, 'Scheduled',
      nullif(btrim(p_notes), ''), p_recommendation_id, auth.uid(), public.current_actor_name()
    ) RETURNING * INTO saved;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time overlaps another booking for this psychologist. Choose another slot.' USING ERRCODE = '23P01';
  END;

  v_type := coalesce(p_session_type,
    CASE
      WHEN p_recommendation_id IS NOT NULL THEN 'Follow-up'
      WHEN NOT EXISTS (SELECT 1 FROM public.sessions WHERE client_id = p_client_id) THEN 'Initial'
      ELSE 'Regular'
    END);
  INSERT INTO public.sessions (appointment_id, client_id, psychologist_id, starts_at, ends_at, status, session_type, updated_by, updated_by_name)
  VALUES (saved.id, p_client_id, p_psychologist_id, saved.starts_at, saved.ends_at, 'Scheduled', v_type, auth.uid(), public.current_actor_name());

  IF p_recommendation_id IS NOT NULL THEN
    UPDATE public.follow_up_recommendations
      SET status = 'Scheduled', appointment_id = saved.id, updated_at = now()
      WHERE id = p_recommendation_id;
  END IF;

  PERFORM public._log_client_activity(p_client_id,
    format('Appointment booked: %s, %s', svc.name,
      to_char(saved.starts_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI')));
  RETURN saved;
END;
$$;

-- Client confirmation, recorded manually by staff.
CREATE OR REPLACE FUNCTION public.confirm_appointment(p_appointment_id uuid)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  appt public.appointments%ROWTYPE;
BEGIN
  IF NOT public.is_crm_staff() THEN
    RAISE EXCEPTION 'Only CRM staff can record client confirmation.' USING ERRCODE = '42501';
  END IF;
  SELECT * INTO appt FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF appt.status <> 'Scheduled' THEN
    RAISE EXCEPTION 'Only a Scheduled appointment can be confirmed (this one is %).', appt.status USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('kappiness.status_reason', 'Client confirmed', true);
  UPDATE public.appointments
    SET status = 'Confirmed', confirmed_at = now(), confirmed_by = auth.uid(), confirmed_by_name = public.current_actor_name()
    WHERE id = p_appointment_id
    RETURNING * INTO appt;
  PERFORM public._log_client_activity(appt.client_id, 'Client confirmed the appointment');
  RETURN appt;
END;
$$;

-- Cancel: keeps the record and its original time; the slot is released because only active rows block time.
CREATE OR REPLACE FUNCTION public.cancel_appointment(p_appointment_id uuid, p_reason text)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  appt public.appointments%ROWTYPE;
BEGIN
  SELECT * INTO appt FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF NOT public._can_manage_psychologist(appt.psychologist_id) THEN
    RAISE EXCEPTION 'You do not have permission to cancel this appointment.' USING ERRCODE = '42501';
  END IF;
  IF appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RAISE EXCEPTION 'A % appointment cannot be cancelled.', appt.status USING ERRCODE = 'P0001';
  END IF;
  IF nullif(btrim(p_reason), '') IS NULL THEN
    RAISE EXCEPTION 'Add a reason for the cancellation.' USING ERRCODE = '22023';
  END IF;

  PERFORM set_config('kappiness.status_reason', btrim(p_reason), true);
  UPDATE public.appointments
    SET status = 'Cancelled', cancelled_at = now(), cancelled_by = auth.uid(),
        cancelled_by_name = public.current_actor_name(), cancellation_reason = btrim(p_reason)
    WHERE id = p_appointment_id
    RETURNING * INTO appt;
  UPDATE public.sessions SET status = 'Cancelled', updated_by = auth.uid(), updated_by_name = public.current_actor_name()
    WHERE appointment_id = p_appointment_id AND status = 'Scheduled';
  UPDATE public.follow_up_recommendations SET status = 'Open', appointment_id = NULL, updated_at = now()
    WHERE appointment_id = p_appointment_id AND status = 'Scheduled';
  PERFORM public._log_client_activity(appt.client_id, format('Appointment cancelled: %s', btrim(p_reason)));
  RETURN appt;
END;
$$;

-- Reschedule: the original stays (status Rescheduled, original time kept); a new Scheduled appointment links back.
CREATE OR REPLACE FUNCTION public.reschedule_appointment(
  p_appointment_id uuid,
  p_new_starts_at timestamptz,
  p_new_psychologist_id uuid DEFAULT NULL,
  p_reason text DEFAULT NULL
)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  old_appt public.appointments%ROWTYPE;
  new_appt public.appointments%ROWTYPE;
  target uuid;
  duration interval;
  old_session public.sessions%ROWTYPE;
BEGIN
  SELECT * INTO old_appt FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  target := coalesce(p_new_psychologist_id, old_appt.psychologist_id);
  IF NOT public._can_manage_psychologist(old_appt.psychologist_id) OR NOT public._can_manage_psychologist(target) THEN
    RAISE EXCEPTION 'You do not have permission to reschedule this appointment.' USING ERRCODE = '42501';
  END IF;
  IF old_appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RAISE EXCEPTION 'A % appointment cannot be rescheduled.', old_appt.status USING ERRCODE = 'P0001';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = target AND is_active) THEN
    RAISE EXCEPTION 'Choose an active psychologist.' USING ERRCODE = 'P0001';
  END IF;
  IF p_new_starts_at IS NULL OR p_new_starts_at <= now() THEN
    RAISE EXCEPTION 'Choose a time in the future.' USING ERRCODE = 'P0001';
  END IF;

  duration := old_appt.ends_at - old_appt.starts_at;
  PERFORM 1 FROM public.psychologists WHERE id = target FOR SHARE;
  PERFORM public._assert_slot_available(target, p_new_starts_at, p_new_starts_at + duration);

  -- Release the original slot first (same transaction), then book the replacement.
  PERFORM set_config('kappiness.status_reason', coalesce(nullif(btrim(p_reason), ''), 'Rescheduled'), true);
  UPDATE public.appointments
    SET status = 'Rescheduled', rescheduled_at = now(), rescheduled_by = auth.uid(),
        rescheduled_by_name = public.current_actor_name()
    WHERE id = p_appointment_id;

  PERFORM set_config('kappiness.status_reason', format('Rescheduled from %s', p_appointment_id), true);
  BEGIN
    INSERT INTO public.appointments (
      client_id, psychologist_id, service_id, service_type, starts_at, ends_at, buffer_minutes, status, notes,
      recommendation_id, rescheduled_from_id, created_by, created_by_name
    ) VALUES (
      old_appt.client_id, target, old_appt.service_id, old_appt.service_type, p_new_starts_at,
      p_new_starts_at + duration, old_appt.buffer_minutes, 'Scheduled', old_appt.notes,
      old_appt.recommendation_id, old_appt.id, auth.uid(), public.current_actor_name()
    ) RETURNING * INTO new_appt;
  EXCEPTION WHEN exclusion_violation THEN
    RAISE EXCEPTION 'That time overlaps another booking for this psychologist. Choose another slot.' USING ERRCODE = '23P01';
  END;

  SELECT * INTO old_session FROM public.sessions WHERE appointment_id = p_appointment_id;
  PERFORM set_config('kappiness.status_reason', 'Appointment rescheduled', true);
  UPDATE public.sessions SET status = 'Cancelled', outcome = coalesce(outcome, 'Rescheduled'),
      updated_by = auth.uid(), updated_by_name = public.current_actor_name()
    WHERE appointment_id = p_appointment_id AND status = 'Scheduled';
  INSERT INTO public.sessions (appointment_id, client_id, psychologist_id, starts_at, ends_at, status, session_type, updated_by, updated_by_name)
  VALUES (new_appt.id, new_appt.client_id, target, new_appt.starts_at, new_appt.ends_at, 'Scheduled',
          coalesce(old_session.session_type, 'Regular'), auth.uid(), public.current_actor_name());

  UPDATE public.follow_up_recommendations SET appointment_id = new_appt.id, updated_at = now()
    WHERE appointment_id = p_appointment_id;

  PERFORM public._log_client_activity(old_appt.client_id,
    format('Appointment rescheduled to %s',
      to_char(new_appt.starts_at AT TIME ZONE public.clinic_timezone(), 'DD Mon YYYY HH24:MI')));
  RETURN new_appt;
END;
$$;

-- Attendance, checked by a person after the start time. Never automatic.
CREATE OR REPLACE FUNCTION public.record_attendance(p_appointment_id uuid, p_attended boolean, p_outcome text DEFAULT NULL)
RETURNS public.appointments
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  appt public.appointments%ROWTYPE;
  v_status text := CASE WHEN p_attended THEN 'Completed' ELSE 'Missed' END;
BEGIN
  SELECT * INTO appt FROM public.appointments WHERE id = p_appointment_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This appointment no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF p_attended IS NULL THEN
    RAISE EXCEPTION 'Say whether the client attended.' USING ERRCODE = '22023';
  END IF;
  IF NOT public._can_manage_psychologist(appt.psychologist_id) THEN
    RAISE EXCEPTION 'You do not have permission to record attendance for this appointment.' USING ERRCODE = '42501';
  END IF;
  IF appt.status NOT IN ('Scheduled', 'Confirmed') THEN
    RAISE EXCEPTION 'Attendance cannot be recorded for a % appointment.', appt.status USING ERRCODE = 'P0001';
  END IF;
  IF appt.starts_at > now() THEN
    RAISE EXCEPTION 'Attendance can be recorded once the appointment has started.' USING ERRCODE = 'P0001';
  END IF;

  PERFORM set_config('kappiness.status_reason', CASE WHEN p_attended THEN 'Client attended' ELSE 'Client did not attend' END, true);
  UPDATE public.appointments
    SET status = v_status, attendance_marked_at = now(), attendance_marked_by = auth.uid(),
        attendance_marked_by_name = public.current_actor_name()
    WHERE id = p_appointment_id
    RETURNING * INTO appt;
  UPDATE public.sessions
    SET status = v_status, outcome = coalesce(nullif(btrim(p_outcome), ''), outcome),
        updated_by = auth.uid(), updated_by_name = public.current_actor_name()
    WHERE appointment_id = p_appointment_id;
  PERFORM public._log_client_activity(appt.client_id,
    CASE WHEN p_attended THEN 'Session completed' ELSE 'Client missed the appointment' END);
  RETURN appt;
END;
$$;

-- Session details (type, outcome, actual times, clinical notes). Status changes go through the functions above.
CREATE OR REPLACE FUNCTION public.update_session(
  p_session_id uuid,
  p_session_type text DEFAULT NULL,
  p_outcome text DEFAULT NULL,
  p_notes text DEFAULT NULL,
  p_starts_at timestamptz DEFAULT NULL,
  p_ends_at timestamptz DEFAULT NULL
)
RETURNS public.sessions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ses public.sessions%ROWTYPE;
  own boolean;
BEGIN
  SELECT * INTO ses FROM public.sessions WHERE id = p_session_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This session no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  own := coalesce(ses.psychologist_id = public.current_psychologist_id(), false);
  IF NOT (own OR coalesce(public.is_crm_staff(), false)) THEN
    RAISE EXCEPTION 'You do not have permission to update this session.' USING ERRCODE = '42501';
  END IF;
  IF p_notes IS NOT NULL AND NOT (own OR coalesce(public.is_crm_admin(), false)) THEN
    RAISE EXCEPTION 'Only the session''s psychologist can write session notes.' USING ERRCODE = '42501';
  END IF;

  UPDATE public.sessions
    SET session_type = coalesce(p_session_type, session_type),
        outcome = CASE WHEN p_outcome IS NULL THEN outcome ELSE nullif(btrim(p_outcome), '') END,
        starts_at = coalesce(p_starts_at, starts_at),
        ends_at = coalesce(p_ends_at, ends_at),
        updated_by = auth.uid(),
        updated_by_name = public.current_actor_name()
    WHERE id = p_session_id
    RETURNING * INTO ses;

  IF p_notes IS NOT NULL THEN
    IF nullif(btrim(p_notes), '') IS NULL THEN
      RAISE EXCEPTION 'Session notes cannot be emptied. Write an update instead.' USING ERRCODE = '22023';
    END IF;
    INSERT INTO public.session_notes (session_id, notes, updated_by, updated_by_name, updated_at)
    VALUES (p_session_id, btrim(p_notes), auth.uid(), public.current_actor_name(), now())
    ON CONFLICT (session_id) DO UPDATE
      SET notes = EXCLUDED.notes, updated_by = EXCLUDED.updated_by,
          updated_by_name = EXCLUDED.updated_by_name, updated_at = now();
  END IF;
  RETURN ses;
END;
$$;

-- Recommendation from the session's psychologist.
CREATE OR REPLACE FUNCTION public.create_recommendation(
  p_session_id uuid,
  p_recommendation text,
  p_recommended_date date,
  p_recommended_time time DEFAULT NULL,
  p_priority text DEFAULT 'Normal'
)
RETURNS public.follow_up_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  ses public.sessions%ROWTYPE;
  saved public.follow_up_recommendations%ROWTYPE;
BEGIN
  SELECT * INTO ses FROM public.sessions WHERE id = p_session_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This session no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF ses.psychologist_id IS DISTINCT FROM public.current_psychologist_id() THEN
    RAISE EXCEPTION 'Only the session''s psychologist can recommend a follow-up.' USING ERRCODE = '42501';
  END IF;
  IF ses.status <> 'Completed' THEN
    RAISE EXCEPTION 'Recommend a follow-up after the session has been completed.' USING ERRCODE = 'P0001';
  END IF;
  IF p_recommended_date IS NULL OR p_recommended_date < (now() AT TIME ZONE public.clinic_timezone())::date THEN
    RAISE EXCEPTION 'Choose a follow-up date from today onwards.' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.follow_up_recommendations (
    session_id, client_id, psychologist_id, recommendation, recommended_date, recommended_time, priority,
    created_by, created_by_name
  ) VALUES (
    p_session_id, ses.client_id, ses.psychologist_id, btrim(p_recommendation), p_recommended_date,
    p_recommended_time, coalesce(p_priority, 'Normal'), auth.uid(), public.current_actor_name()
  ) RETURNING * INTO saved;
  PERFORM public._log_client_activity(ses.client_id,
    format('Follow-up recommended for %s', to_char(p_recommended_date, 'DD Mon YYYY')));
  RETURN saved;
END;
$$;

-- Psychologist edits their own open recommendation.
CREATE OR REPLACE FUNCTION public.update_recommendation(
  p_id uuid,
  p_recommendation text,
  p_recommended_date date,
  p_recommended_time time DEFAULT NULL,
  p_priority text DEFAULT 'Normal'
)
RETURNS public.follow_up_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.follow_up_recommendations%ROWTYPE;
BEGIN
  SELECT * INTO rec FROM public.follow_up_recommendations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This recommendation no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF rec.psychologist_id IS DISTINCT FROM public.current_psychologist_id() THEN
    RAISE EXCEPTION 'Only the recommending psychologist can edit this recommendation.' USING ERRCODE = '42501';
  END IF;
  IF rec.status <> 'Open' THEN
    RAISE EXCEPTION 'Only open recommendations can be edited.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.follow_up_recommendations
    SET recommendation = btrim(p_recommendation), recommended_date = p_recommended_date,
        recommended_time = p_recommended_time, priority = coalesce(p_priority, 'Normal'), updated_at = now()
    WHERE id = p_id
    RETURNING * INTO rec;
  RETURN rec;
END;
$$;

-- Staff close a recommendation (follow-up done, or not needed) with an outcome.
CREATE OR REPLACE FUNCTION public.close_recommendation(p_id uuid, p_status text, p_outcome text)
RETURNS public.follow_up_recommendations
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  rec public.follow_up_recommendations%ROWTYPE;
BEGIN
  IF NOT public.is_crm_staff() THEN
    RAISE EXCEPTION 'Only CRM staff can close follow-up recommendations.' USING ERRCODE = '42501';
  END IF;
  IF p_status NOT IN ('Completed', 'Dismissed') THEN
    RAISE EXCEPTION 'Choose Completed or Dismissed.' USING ERRCODE = '22023';
  END IF;
  IF nullif(btrim(p_outcome), '') IS NULL THEN
    RAISE EXCEPTION 'Add the follow-up outcome.' USING ERRCODE = '22023';
  END IF;
  SELECT * INTO rec FROM public.follow_up_recommendations WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This recommendation no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  IF rec.status IN ('Completed', 'Dismissed') THEN
    RAISE EXCEPTION 'This recommendation is already closed.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.follow_up_recommendations
    SET status = p_status, outcome = btrim(p_outcome), completed_at = now(), completed_by = auth.uid(),
        completed_by_name = public.current_actor_name(), updated_at = now()
    WHERE id = p_id
    RETURNING * INTO rec;
  PERFORM public._log_client_activity(rec.client_id, format('Follow-up %s: %s', lower(p_status), btrim(p_outcome)));
  RETURN rec;
END;
$$;

-- Active appointments that a blocked period would clash with (used to warn before blocking).
CREATE OR REPLACE FUNCTION public.availability_block_conflicts(p_psychologist_id uuid, p_starts_at timestamptz, p_ends_at timestamptz)
RETURNS TABLE (appointment_id uuid, client_name text, starts_at timestamptz, ends_at timestamptz, status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT public._can_manage_psychologist(p_psychologist_id) THEN
    RAISE EXCEPTION 'You do not have permission to manage this availability.' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
    SELECT a.id, c.full_name, a.starts_at, a.ends_at, a.status
    FROM public.appointments AS a
    JOIN public.clients AS c ON c.id = a.client_id
    WHERE a.psychologist_id = p_psychologist_id
      AND a.status IN ('Scheduled', 'Confirmed')
      AND a.starts_at < p_ends_at AND p_starts_at < a.ends_at
    ORDER BY a.starts_at;
END;
$$;

-- Block a period. Refuses while active appointments are inside it: they must be resolved by a person first.
CREATE OR REPLACE FUNCTION public.add_availability_block(p_psychologist_id uuid, p_starts_at timestamptz, p_ends_at timestamptz, p_reason text DEFAULT NULL)
RETURNS public.psychologist_availability_exceptions
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  clash integer;
  saved public.psychologist_availability_exceptions%ROWTYPE;
BEGIN
  IF NOT public._can_manage_psychologist(p_psychologist_id) THEN
    RAISE EXCEPTION 'You do not have permission to manage this availability.' USING ERRCODE = '42501';
  END IF;
  IF p_starts_at IS NULL OR p_ends_at IS NULL OR p_ends_at <= p_starts_at THEN
    RAISE EXCEPTION 'The blocked period must end after it starts.' USING ERRCODE = '22023';
  END IF;
  -- Serialise blocking against booking for this psychologist.
  PERFORM 1 FROM public.psychologists WHERE id = p_psychologist_id FOR UPDATE;
  SELECT count(*) INTO clash FROM public.appointments AS a
  WHERE a.psychologist_id = p_psychologist_id AND a.status IN ('Scheduled', 'Confirmed')
    AND a.starts_at < p_ends_at AND p_starts_at < a.ends_at;
  IF clash > 0 THEN
    RAISE EXCEPTION '% appointment(s) fall in this period. Cancel or reschedule them before blocking it.', clash USING ERRCODE = 'P0001';
  END IF;
  INSERT INTO public.psychologist_availability_exceptions (psychologist_id, starts_at, ends_at, reason, created_by, created_by_name)
  VALUES (p_psychologist_id, p_starts_at, p_ends_at, nullif(btrim(p_reason), ''), auth.uid(), public.current_actor_name())
  RETURNING * INTO saved;
  RETURN saved;
END;
$$;

-- Staff change a client's primary psychologist (kept in step with the lead's assignment).
CREATE OR REPLACE FUNCTION public.assign_client_psychologist(p_client_id uuid, p_psychologist_id uuid)
RETURNS public.clients
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  cli public.clients%ROWTYPE;
BEGIN
  IF NOT public.is_crm_staff() THEN
    RAISE EXCEPTION 'Only CRM staff can change a client''s psychologist.' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.psychologists WHERE id = p_psychologist_id AND is_active) THEN
    RAISE EXCEPTION 'Choose an active psychologist.' USING ERRCODE = 'P0001';
  END IF;
  SELECT * INTO cli FROM public.clients WHERE id = p_client_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'This client no longer exists.' USING ERRCODE = 'P0001';
  END IF;
  UPDATE public.leads SET assigned_psychologist_id = p_psychologist_id WHERE id = cli.lead_id;
  UPDATE public.clients SET primary_psychologist_id = p_psychologist_id, updated_at = now()
    WHERE id = p_client_id RETURNING * INTO cli;
  PERFORM public._log_client_activity(p_client_id,
    format('Primary psychologist changed to %s', (SELECT full_name FROM public.psychologists WHERE id = p_psychologist_id)));
  RETURN cli;
END;
$$;

/* =====================================================================
   12. Row Level Security and grants
   ===================================================================== */

ALTER TABLE public.services ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.appointment_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.session_status_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follow_up_recommendations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psychologist_availability_exceptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.psychologist_availability ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.services, public.clients, public.appointments, public.appointment_status_history,
  public.sessions, public.session_notes, public.session_status_history, public.follow_up_recommendations,
  public.psychologist_availability_exceptions FROM anon;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON public.clients, public.appointments, public.appointment_status_history,
  public.sessions, public.session_notes, public.session_status_history, public.follow_up_recommendations,
  public.psychologist_availability_exceptions FROM authenticated;
GRANT SELECT ON public.services, public.clients, public.appointments, public.appointment_status_history,
  public.sessions, public.session_notes, public.session_status_history, public.follow_up_recommendations,
  public.psychologist_availability_exceptions TO authenticated;
GRANT INSERT, UPDATE ON public.services TO authenticated;
GRANT UPDATE (full_name, phone, email, city, preferred_language, preferred_contact, best_time, service_interest, is_active, updated_at)
  ON public.clients TO authenticated;
GRANT UPDATE (notes, updated_at) ON public.appointments TO authenticated;
GRANT DELETE ON public.psychologist_availability_exceptions TO authenticated;

-- services: everyone signed in reads; staff configure.
DROP POLICY IF EXISTS services_read ON public.services;
CREATE POLICY services_read ON public.services FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS services_staff_insert ON public.services;
CREATE POLICY services_staff_insert ON public.services FOR INSERT TO authenticated WITH CHECK (public.is_crm_staff());
DROP POLICY IF EXISTS services_staff_update ON public.services;
CREATE POLICY services_staff_update ON public.services FOR UPDATE TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

-- clients: staff see all; a psychologist sees their own clients and clients booked with them.
DROP POLICY IF EXISTS clients_read ON public.clients;
CREATE POLICY clients_read ON public.clients FOR SELECT TO authenticated USING (
  public.is_crm_staff()
  OR primary_psychologist_id = public.current_psychologist_id()
  OR EXISTS (SELECT 1 FROM public.appointments AS a WHERE a.client_id = clients.id AND a.psychologist_id = public.current_psychologist_id())
);
DROP POLICY IF EXISTS clients_staff_update ON public.clients;
CREATE POLICY clients_staff_update ON public.clients FOR UPDATE TO authenticated
  USING (public.is_crm_staff()) WITH CHECK (public.is_crm_staff());

-- appointments
DROP POLICY IF EXISTS appointments_read ON public.appointments;
CREATE POLICY appointments_read ON public.appointments FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS appointments_notes_update ON public.appointments;
CREATE POLICY appointments_notes_update ON public.appointments FOR UPDATE TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id())
  WITH CHECK (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

DROP POLICY IF EXISTS appointment_history_read ON public.appointment_status_history;
CREATE POLICY appointment_history_read ON public.appointment_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.appointments AS a WHERE a.id = appointment_status_history.appointment_id));

-- sessions
DROP POLICY IF EXISTS sessions_read ON public.sessions;
CREATE POLICY sessions_read ON public.sessions FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS session_history_read ON public.session_status_history;
CREATE POLICY session_history_read ON public.session_status_history FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.sessions AS s WHERE s.id = session_status_history.session_id));
-- Clinical notes: the session's psychologist and administrators only.
DROP POLICY IF EXISTS session_notes_read ON public.session_notes;
CREATE POLICY session_notes_read ON public.session_notes FOR SELECT TO authenticated USING (
  public.is_crm_admin()
  OR EXISTS (SELECT 1 FROM public.sessions AS s
             WHERE s.id = session_notes.session_id AND s.psychologist_id = public.current_psychologist_id())
);

-- recommendations
DROP POLICY IF EXISTS recommendations_read ON public.follow_up_recommendations;
CREATE POLICY recommendations_read ON public.follow_up_recommendations FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

-- blocked periods
DROP POLICY IF EXISTS availability_exceptions_read ON public.psychologist_availability_exceptions;
CREATE POLICY availability_exceptions_read ON public.psychologist_availability_exceptions FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS availability_exceptions_delete ON public.psychologist_availability_exceptions;
CREATE POLICY availability_exceptions_delete ON public.psychologist_availability_exceptions FOR DELETE TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

-- weekly availability: staff manage all; a psychologist manages their own. (Policies are added alongside any
-- existing ones; see the audit query in the README section of 202611040002 to review what else is in place.)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.psychologist_availability TO authenticated;
DROP POLICY IF EXISTS availability_read_scoped ON public.psychologist_availability;
CREATE POLICY availability_read_scoped ON public.psychologist_availability FOR SELECT TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS availability_insert_scoped ON public.psychologist_availability;
CREATE POLICY availability_insert_scoped ON public.psychologist_availability FOR INSERT TO authenticated
  WITH CHECK (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS availability_update_scoped ON public.psychologist_availability;
CREATE POLICY availability_update_scoped ON public.psychologist_availability FOR UPDATE TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id())
  WITH CHECK (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());
DROP POLICY IF EXISTS availability_delete_scoped ON public.psychologist_availability;
CREATE POLICY availability_delete_scoped ON public.psychologist_availability FOR DELETE TO authenticated
  USING (public.is_crm_staff() OR psychologist_id = public.current_psychologist_id());

-- Functions: signed-in users only (each one checks the caller's role itself).
REVOKE ALL ON FUNCTION
  public._can_manage_psychologist(uuid),
  public._assert_slot_available(uuid, timestamptz, timestamptz),
  public._log_client_activity(uuid, text),
  public.sync_client_from_lead(),
  public.log_appointment_status(),
  public.log_session_status()
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
  public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text),
  public.confirm_appointment(uuid),
  public.cancel_appointment(uuid, text),
  public.reschedule_appointment(uuid, timestamptz, uuid, text),
  public.record_attendance(uuid, boolean, text),
  public.update_session(uuid, text, text, text, timestamptz, timestamptz),
  public.create_recommendation(uuid, text, date, time, text),
  public.update_recommendation(uuid, text, date, time, text),
  public.close_recommendation(uuid, text, text),
  public.availability_block_conflicts(uuid, timestamptz, timestamptz),
  public.add_availability_block(uuid, timestamptz, timestamptz, text),
  public.assign_client_psychologist(uuid, uuid)
FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION
  public.book_appointment(uuid, uuid, uuid, timestamptz, text, uuid, text),
  public.confirm_appointment(uuid),
  public.cancel_appointment(uuid, text),
  public.reschedule_appointment(uuid, timestamptz, uuid, text),
  public.record_attendance(uuid, boolean, text),
  public.update_session(uuid, text, text, text, timestamptz, timestamptz),
  public.create_recommendation(uuid, text, date, time, text),
  public.update_recommendation(uuid, text, date, time, text),
  public.close_recommendation(uuid, text, text),
  public.availability_block_conflicts(uuid, timestamptz, timestamptz),
  public.add_availability_block(uuid, timestamptz, timestamptz, text),
  public.assign_client_psychologist(uuid, uuid)
TO authenticated;

COMMIT;
