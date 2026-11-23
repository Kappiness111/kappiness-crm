/* Follow-up appointment reminders (public.appointment_reminders, migration 202611130002, live on production).
   Each follow-up appointment has exactly two independent reminder slots (1 and 2), each with its own delivery
   status and client response. Nothing is sent from the CRM: staff record what happened.

   Reads: active CRM staff only (RLS). Writes only through the existing database functions:
     record_reminder_delivery(p_reminder_id uuid, p_status text, p_occurred_at timestamptz = null, p_note text = null)
       p_status: Sent | Delivered | Failed | Cancelled   (Cancelled needs a note; a Failed note is the failure reason)
     record_reminder_response(p_reminder_id uuid, p_response text, p_note text = null, p_responded_at timestamptz = null)
       p_response: Confirmed | Wants to Reschedule | No Response   (only after the reminder is Sent or Delivered) */

import { createClient } from "../../utils/supabase/client";

export const DELIVERY_STATUSES = ["Pending", "Sent", "Delivered", "Failed", "Cancelled"];
export const CLIENT_RESPONSES = ["Confirmed", "Wants to Reschedule", "No Response"];

// Delivery changes the database accepts from each status (appointment_reminders_before_write).
export const DELIVERY_NEXT = {
  Pending: ["Sent", "Delivered", "Failed", "Cancelled"],
  Sent: ["Delivered", "Failed"],
  Failed: ["Sent", "Delivered", "Cancelled"],
  Delivered: [],
  Cancelled: [],
};

export function canRecordResponse(reminder) {
  return Boolean(reminder) && (reminder.delivery_status === "Sent" || reminder.delivery_status === "Delivered");
}

// A reminder is due when it is still Pending and its due time has passed.
export function isReminderDue(reminder, now = new Date()) {
  return reminder.delivery_status === "Pending" && new Date(reminder.due_at).getTime() <= now.getTime();
}

const COLUMNS =
  "id, appointment_id, reminder_number, due_at, delivery_status, sent_at, delivered_at, failed_at, failure_reason, " +
  "cancelled_at, delivery_updated_by_name, client_response, responded_at, response_recorded_by_name, response_note, " +
  "created_at, updated_at";

// Reminders for these appointments. Returns { allowed, rows }: allowed=false when the viewer may not read
// reminders (psychologists), so the UI can say so instead of showing an empty state.
export async function listReminders(appointmentIds) {
  if (!appointmentIds.length) return { allowed: true, rows: [] };
  const supabase = createClient();
  const rows = [];
  // Keep each request's id list short enough for the URL.
  for (let i = 0; i < appointmentIds.length; i += 150) {
    const { data, error } = await supabase
      .from("appointment_reminders")
      .select(COLUMNS)
      .in("appointment_id", appointmentIds.slice(i, i + 150))
      .order("reminder_number", { ascending: true });
    if (error) {
      if (error.code === "42501" || error.code === "PGRST301") return { allowed: false, rows: [] };
      throw error;
    }
    rows.push(...(data || []));
  }
  return { allowed: true, rows };
}

export async function listReminderEvents(appointmentIds) {
  if (!appointmentIds.length) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("appointment_reminder_events")
    .select("id, event_seq, reminder_id, appointment_id, event_type, from_value, to_value, note, changed_by_name, changed_at")
    .in("appointment_id", appointmentIds)
    .order("event_seq", { ascending: true });
  if (error) throw error;
  return data || [];
}

// values: { status, occurredAt?: Date|string, note? }
export async function recordReminderDelivery(reminderId, values) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("record_reminder_delivery", {
    p_reminder_id: reminderId,
    p_status: values.status,
    p_occurred_at: values.occurredAt ? new Date(values.occurredAt).toISOString() : null,
    p_note: values.note ? values.note.trim() : null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

// values: { response, note?, respondedAt?: Date|string }
export async function recordReminderResponse(reminderId, values) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("record_reminder_response", {
    p_reminder_id: reminderId,
    p_response: values.response,
    p_note: values.note ? values.note.trim() : null,
    p_responded_at: values.respondedAt ? new Date(values.respondedAt).toISOString() : null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
