-- Dashboard views (read-only) for the main dashboard counts.
--
-- Owner: Aavani (frontend). Review: Aswathy (shared backend). NOT APPLIED: see supabase/migrations/README.md.
--
-- What this adds: four views and nothing else. No table, column, policy, function or trigger is created or changed.
-- Every view is SECURITY INVOKER, so the row-level security on the underlying tables applies to whoever queries it:
-- staff see clinic-wide counts, a psychologist sees only what their existing policies already allow.
-- Days are counted in clinic time (Asia/Kolkata).
--
-- Capacity (total / booked / available slots) is NOT a view: it depends on cutting weekly working hours into
-- session-length slots, and that rule must stay identical to the one used when booking (app/lib/appointmentSlots.js).
-- The dashboard keeps calculating capacity in the browser from psychologist_availability and these appointments.

-- Appointments per clinic day, psychologist, status and appointment type (service).
CREATE OR REPLACE VIEW public.dashboard_appointment_daily
WITH (security_invoker = true) AS
SELECT
  (a.starts_at AT TIME ZONE 'Asia/Kolkata')::date AS day,
  a.psychologist_id,
  a.status,
  a.service_type,
  count(*)::integer AS appointments
FROM public.appointments a
GROUP BY 1, 2, 3, 4;

COMMENT ON VIEW public.dashboard_appointment_daily IS
  'Dashboard: appointment counts per clinic day (Asia/Kolkata), psychologist, status and service type. Security invoker.';

-- Leads per creation day and status (total leads = sum of all rows; new leads = rows inside the period).
CREATE OR REPLACE VIEW public.dashboard_lead_daily
WITH (security_invoker = true) AS
SELECT
  (l.created_at AT TIME ZONE 'Asia/Kolkata')::date AS created_day,
  l.status,
  count(*)::integer AS leads
FROM public.leads l
GROUP BY 1, 2;

COMMENT ON VIEW public.dashboard_lead_daily IS
  'Dashboard: lead counts per creation day (Asia/Kolkata) and status. Security invoker.';

-- Open lead follow-up calls per due day and status, with how many of them are already overdue.
CREATE OR REPLACE VIEW public.dashboard_follow_up_calls
WITH (security_invoker = true) AS
SELECT
  (l.next_follow_up_at AT TIME ZONE 'Asia/Kolkata')::date AS due_day,
  l.status,
  count(*)::integer AS calls,
  (count(*) FILTER (WHERE l.next_follow_up_at < now()))::integer AS overdue
FROM public.leads l
WHERE l.next_follow_up_at IS NOT NULL
  AND l.status NOT IN ('Confirmed', 'Not Interested', 'Lost Lead')
GROUP BY 1, 2;

COMMENT ON VIEW public.dashboard_follow_up_calls IS
  'Dashboard: open lead follow-up calls per due day (Asia/Kolkata) and status, with overdue count. Security invoker.';

-- One row per psychologist per clinic day touched by leave (blocked periods).
CREATE OR REPLACE VIEW public.dashboard_leave_daily
WITH (security_invoker = true) AS
SELECT
  e.psychologist_id,
  d::date AS day,
  bool_or(
    e.starts_at <= (d::date::timestamp AT TIME ZONE 'Asia/Kolkata')
    AND e.ends_at >= ((d::date + 1)::timestamp AT TIME ZONE 'Asia/Kolkata')
  ) AS full_day,
  string_agg(DISTINCT e.reason, ', ') AS reasons
FROM public.psychologist_availability_exceptions e
CROSS JOIN LATERAL generate_series(
  (e.starts_at AT TIME ZONE 'Asia/Kolkata')::date,
  ((e.ends_at - interval '1 second') AT TIME ZONE 'Asia/Kolkata')::date,
  interval '1 day'
) AS d
GROUP BY 1, 2;

COMMENT ON VIEW public.dashboard_leave_daily IS
  'Dashboard: psychologists on leave per clinic day (Asia/Kolkata); full_day when the leave covers the whole day. Security invoker.';

-- Signed-in users only; never anonymous.
REVOKE ALL ON public.dashboard_appointment_daily, public.dashboard_lead_daily,
  public.dashboard_follow_up_calls, public.dashboard_leave_daily FROM anon, public;
GRANT SELECT ON public.dashboard_appointment_daily, public.dashboard_lead_daily,
  public.dashboard_follow_up_calls, public.dashboard_leave_daily TO authenticated;
