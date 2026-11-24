import { createClient } from "../../utils/supabase/client";
import { isMissingBackend } from "./appointmentsApi";

/* Dashboard counts from the read-only database views (supabase/proposed/202611240001_dashboard_views.sql).
   The views are SECURITY INVOKER, so each user's existing row-level security applies.
   Until the views are applied, loadDashboardCounts resolves to null and the dashboard calculates the same
   numbers in the browser from the records it already has. Days are clinic days (Asia/Kolkata). */

const pad = (n) => String(n).padStart(2, "0");
export const dayKey = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

// filters: { start: Date, end: Date (exclusive), psychologistId, appointmentStatus, appointmentType, leadStatus }
export async function loadDashboardCounts({ start, end, psychologistId, appointmentStatus, appointmentType, leadStatus }) {
  const supabase = createClient();
  const from = dayKey(start);
  const to = dayKey(end);
  const today = dayKey(new Date());

  let appts = supabase.from("dashboard_appointment_daily").select("status, appointments").gte("day", from).lt("day", to);
  if (psychologistId) appts = appts.eq("psychologist_id", psychologistId);
  if (appointmentStatus) appts = appts.eq("status", appointmentStatus);
  if (appointmentType) appts = appts.eq("service_type", appointmentType);

  let leads = supabase.from("dashboard_lead_daily").select("created_day, status, leads");
  if (leadStatus) leads = leads.eq("status", leadStatus);

  let calls = supabase.from("dashboard_follow_up_calls").select("due_day, calls, overdue");
  if (leadStatus) calls = calls.eq("status", leadStatus);

  let leave = supabase.from("dashboard_leave_daily").select("psychologist_id, day, full_day, reasons").gte("day", from).lt("day", to);
  if (psychologistId) leave = leave.eq("psychologist_id", psychologistId);

  const results = await Promise.all([appts, leads, calls, leave]);
  const failed = results.find((result) => result.error);
  if (failed) {
    if (isMissingBackend(failed.error)) return null; // views not applied yet
    throw failed.error;
  }
  const [a, l, c, v] = results.map((result) => result.data || []);

  const byStatus = {};
  a.forEach((row) => {
    byStatus[row.status] = (byStatus[row.status] || 0) + row.appointments;
  });
  const sum = (rows, field, keep = () => true) => rows.filter(keep).reduce((total, row) => total + row[field], 0);

  return {
    appointments: {
      total: sum(a, "appointments"),
      byStatus,
    },
    leads: {
      total: sum(l, "leads"),
      newInPeriod: sum(l, "leads", (row) => row.created_day >= from && row.created_day < to),
      awaiting: sum(l, "leads", (row) => row.status === "Yet to Confirm" || row.status === "Will Inform"),
    },
    followUpCalls: {
      due: sum(c, "calls", (row) => row.due_day >= from && row.due_day < to),
      overdue: sum(c, "overdue"),
      dueToday: sum(c, "calls", (row) => row.due_day === today),
    },
    leave: v, // [{ psychologist_id, day, full_day, reasons }]
  };
}
