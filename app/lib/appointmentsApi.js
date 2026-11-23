/* Appointments, persisted in Supabase (public.appointments, migration 202611040001).
   Reads go through RLS (staff see all, a psychologist sees their own). Every status change goes through a
   permission-checked database function, so the rules hold no matter which screen calls them. */

import { createClient } from "../../utils/supabase/client";

export const APPOINTMENT_STATUSES = ["Scheduled", "Confirmed", "Rescheduled", "Cancelled", "Completed", "Missed"];
// Statuses that still hold a time slot.
export const ACTIVE_APPOINTMENT_STATUSES = ["Scheduled", "Confirmed"];

// Agreed permission: psychologists may schedule and manage their own appointments (enforced in the database).
export const PSYCHOLOGIST_CAN_SCHEDULE = true;

const SELECT = "*, client:clients(id, lead_id, full_name, phone, primary_psychologist_id)";

const MISSING_BACKEND = new Set(["PGRST205", "42P01", "PGRST202", "42883"]);
// Codes raised by the CRM's own database functions, whose messages are written for people.
const RULE_ERRORS = new Set(["P0001", "23P01", "42501", "22023"]);
// Raw PostgreSQL wording that must never reach the screen.
const RAW_DB_TEXT = /violates|constraint|row-level security|relation "|column "|syntax error|permission denied for/i;

export function isMissingBackend(error) {
  return Boolean(error && MISSING_BACKEND.has(error.code));
}

// Messages raised by the database functions are written for people, so they are shown as they are.
export function describeAppointmentError(error, fallback = "Could not save the appointment. Please try again.") {
  if (!error) return fallback;
  if (isMissingBackend(error)) {
    console.error("Scheduling tables are missing (migration 202611040001):", error);
    return "Scheduling isn't set up yet. Please contact your clinic administrator.";
  }
  if (error.code === "42501" || /row-level security|permission denied/i.test(error.message || "")) {
    if (!RAW_DB_TEXT.test(error.message || "")) return error.message;
    return "You don't have permission to do that. If you think you should, ask your clinic administrator.";
  }
  if (RULE_ERRORS.has(error.code) && error.message && !RAW_DB_TEXT.test(error.message)) return error.message;
  if (error.code === "23P01") return "That time overlaps another booking. Please choose another time.";
  if (error.code === "23514" || error.code === "23505") return "Some details are not valid for this change. Please check them and try again.";
  if (error.code === "PGRST301" || /jwt/i.test(error.message || "")) return "Your session has expired. Sign in again.";
  return fallback;
}

export function mapAppointment(row) {
  if (!row) return null;
  const client = row.client || {};
  return {
    ...row,
    id: row.id,
    client_id: row.client_id,
    lead_id: client.lead_id || null,
    client_name: client.full_name || "Client",
    client_phone: client.phone || "",
    psychologist_id: row.psychologist_id,
    starts_at: row.starts_at,
    ends_at: row.ends_at,
    status: row.status,
    notes: row.notes || "",
    booked_by: row.created_by_name || "",
  };
}

// filters: { from?: Date, to?: Date, psychologistId?, clientId?, statuses?: [], followUpsOnly?: boolean }
export async function listAppointments(filters = {}) {
  const supabase = createClient();
  let query = supabase.from("appointments").select(SELECT).order("starts_at", { ascending: true });
  if (filters.from) query = query.gte("starts_at", new Date(filters.from).toISOString());
  if (filters.to) query = query.lt("starts_at", new Date(filters.to).toISOString());
  if (filters.psychologistId) query = query.eq("psychologist_id", filters.psychologistId);
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.statuses && filters.statuses.length) query = query.in("status", filters.statuses);
  if (filters.followUpsOnly) query = query.not("recommendation_id", "is", null);
  const { data, error } = await query.limit(5000);
  if (error) throw error;
  return (data || []).map(mapAppointment);
}

export async function getAppointment(id) {
  const supabase = createClient();
  const { data, error } = await supabase.from("appointments").select(SELECT).eq("id", id).maybeSingle();
  if (error) throw error;
  return mapAppointment(data);
}

async function rpc(name, args) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id) throw new Error("The database returned an empty response.");
  return getAppointment(row.id);
}

// values: { clientId, psychologistId, serviceId, startsAt (Date|ISO), notes?, recommendationId?, sessionType? }
export function bookAppointment(values) {
  return rpc("book_appointment", {
    p_client_id: values.clientId,
    p_psychologist_id: values.psychologistId,
    p_service_id: values.serviceId,
    p_starts_at: new Date(values.startsAt).toISOString(),
    p_notes: values.notes || null,
    p_recommendation_id: values.recommendationId || null,
    p_session_type: values.sessionType || null,
  });
}

export function confirmAppointment(id) {
  return rpc("confirm_appointment", { p_appointment_id: id });
}

export function cancelAppointment(id, reason) {
  return rpc("cancel_appointment", { p_appointment_id: id, p_reason: reason });
}

// Resolves to the NEW appointment. The original keeps its time and becomes Rescheduled.
export function rescheduleAppointment(id, { startsAt, psychologistId = null, reason = "" }) {
  return rpc("reschedule_appointment", {
    p_appointment_id: id,
    p_new_starts_at: new Date(startsAt).toISOString(),
    p_new_psychologist_id: psychologistId || null,
    p_reason: reason || null,
  });
}

export function recordAttendance(id, attended, outcome = "") {
  return rpc("record_attendance", { p_appointment_id: id, p_attended: Boolean(attended), p_outcome: outcome || null });
}

export async function updateAppointmentNotes(id, notes) {
  const supabase = createClient();
  const { error } = await supabase.from("appointments").update({ notes: notes.trim() || null }).eq("id", id);
  if (error) throw error;
  return getAppointment(id);
}

export async function listAppointmentHistory(appointmentIds) {
  if (!appointmentIds.length) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("appointment_status_history")
    .select("*")
    .in("appointment_id", appointmentIds)
    .order("changed_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

/* ----- what a user may do next with one appointment ----- */

// Returns the actions allowed for this appointment, in display order. The database checks them again.
// action ids: confirm | attended | missed | reschedule | cancel
export function appointmentActions(item, { isStaff, ownPsychologistId = null, now = new Date() }) {
  if (!item || !ACTIVE_APPOINTMENT_STATUSES.includes(item.status)) return [];
  const own = ownPsychologistId && String(item.psychologist_id) === String(ownPsychologistId);
  if (!isStaff && !own) return [];
  const started = new Date(item.starts_at).getTime() <= now.getTime();
  const actions = [];
  if (isStaff && item.status === "Scheduled") actions.push("confirm");
  if (started) actions.push("attended", "missed");
  if (!started) actions.push("reschedule");
  actions.push("cancel");
  return actions;
}

export const ACTION_LABELS = {
  confirm: "Record client confirmation",
  attended: "Mark as completed",
  missed: "Mark as missed",
  reschedule: "Reschedule…",
  cancel: "Cancel appointment…",
};
