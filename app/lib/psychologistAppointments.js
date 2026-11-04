/* Appointments for the psychologist workspace, in the shape the calendar components render.
   Backed by public.appointments / public.sessions (migration 202611040001). RLS limits a psychologist to their
   own appointments; every change goes through the permission-checked database functions. */

import {
  cancelAppointment,
  describeAppointmentError,
  isMissingBackend,
  listAppointments,
  recordAttendance,
} from "./appointmentsApi";
import { createRecommendation, getSessionByAppointment } from "./sessionsApi";

export const CAPABILITIES = {
  read: true,
  updateStatus: true,
  recommendFollowUp: true,
  followUpNotes: true,
};

const STATUS_KEYS = ["scheduled", "confirmed", "rescheduled", "cancelled", "completed", "missed"];

// Turns an appointment row into what the calendar renders. Returns null for rows that cannot be shown.
export function normalizeAppointment(row) {
  if (!row) return null;
  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;
  const status = String(row.status || "").toLowerCase();

  return {
    id: row.id,
    clientId: row.client_id || null,
    clientName: String(row.client_name || "Client").trim(),
    psychologistId: row.psychologist_id,
    start,
    end,
    type: row.recommendation_id ? "follow_up" : "regular",
    status: STATUS_KEYS.includes(status) ? status : "scheduled",
    serviceType: row.service_type || "",
    notes: row.notes || "",
    raw: row,
  };
}

// Resolves to { supported, items }. supported=false when the database migration has not been applied yet.
export async function fetchAppointments(psychologistId, rangeStart, rangeEnd) {
  if (!psychologistId) return { supported: true, items: [] };
  try {
    const rows = await listAppointments({ psychologistId, from: rangeStart, to: rangeEnd });
    return { supported: true, items: rows.map(normalizeAppointment).filter(Boolean) };
  } catch (error) {
    if (isMissingBackend(error)) return { supported: false, items: [] };
    throw error;
  }
}

// status: completed | missed | cancelled. Resolves to { ok, message }.
export async function updateSessionStatus(appointmentId, status, extra = {}) {
  try {
    if (status === "completed") await recordAttendance(appointmentId, true, extra.outcome);
    else if (status === "missed") await recordAttendance(appointmentId, false, extra.outcome);
    else if (status === "cancelled") await cancelAppointment(appointmentId, extra.reason || "");
    else return { ok: false, message: "Choose a valid status." };
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: describeAppointmentError(error, "Could not update the session. Please try again.") };
  }
}

// values = { appointmentId, date: "YYYY-MM-DD", time: "HH:MM", notes, priority? }. Resolves to { ok, message }.
export async function recommendFollowUp(values) {
  try {
    const session = await getSessionByAppointment(values.appointmentId);
    if (!session) return { ok: false, message: "This appointment has no session record yet." };
    await createRecommendation({
      sessionId: session.id,
      recommendation: values.notes,
      date: values.date,
      time: values.time,
      priority: values.priority,
    });
    return { ok: true, message: "" };
  } catch (error) {
    return { ok: false, message: describeAppointmentError(error, "Could not save the recommendation. Please try again.") };
  }
}
