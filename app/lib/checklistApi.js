/* Daily session checklist (public.session_checklists) and its activity log (public.activity_log), migration
   202611210004. The checklist is a manual record: it never changes appointment, session or reminder status.
   Reads: staff see all, a psychologist sees their own (RLS). Writes ONLY through:
     update_session_checklist(p_appointment_id, p_client_arrived, p_session_started, p_session_completed,
       p_next_follow_up_discussed, p_next_appointment_booked, p_reminder_sent, p_note)   NULL = leave unchanged
   Allowed for staff and the appointment's own psychologist. */

import { createClient } from "../../utils/supabase/client";

export const CHECKLIST_STEPS = [
  { id: "client_arrived", label: "Client arrived" },
  { id: "session_started", label: "Session started" },
  { id: "session_completed", label: "Session completed" },
  { id: "next_follow_up_discussed", label: "Next follow-up discussed" },
  { id: "next_appointment_booked", label: "Next appointment booked" },
  { id: "reminder_sent", label: "Reminder sent" },
];

const PARAM = {
  client_arrived: "p_client_arrived",
  session_started: "p_session_started",
  session_completed: "p_session_completed",
  next_follow_up_discussed: "p_next_follow_up_discussed",
  next_appointment_booked: "p_next_appointment_booked",
  reminder_sent: "p_reminder_sent",
};

// Checklists of these appointments, as { [appointmentId]: row }.
export async function listChecklists(appointmentIds) {
  const ids = [...new Set(appointmentIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from("session_checklists").select("*").in("appointment_id", ids.slice(i, i + 150));
    if (error) throw error;
    (data || []).forEach((row) => {
      map[row.appointment_id] = row;
    });
  }
  return map;
}

// Activity log entries of these checklists, oldest first, as { [checklistId]: [entry] }.
export async function listChecklistActivity(checklistIds) {
  const ids = [...new Set(checklistIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("activity_log")
      .select("id, entity_id, action, actor_name, details, created_at")
      .eq("entity_type", "session_checklist")
      .in("entity_id", ids.slice(i, i + 150))
      .order("created_at", { ascending: true });
    if (error) throw error;
    (data || []).forEach((row) => {
      (map[row.entity_id] = map[row.entity_id] || []).push(row);
    });
  }
  return map;
}

// Who ticked each step that is ticked now: the latest log entry that turned it on. { [stepId]: name }.
export function tickedBy(checklist, entries = []) {
  const result = {};
  if (!checklist) return result;
  CHECKLIST_STEPS.forEach((step) => {
    if (!checklist[step.id]) return;
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const change = entries[i].details && entries[i].details.changes && entries[i].details.changes[step.id];
      if (change && change.to === true) {
        result[step.id] = entries[i].actor_name || "";
        break;
      }
    }
  });
  return result;
}

// changes: { stepId: true|false }; other steps stay as they are.
export async function updateChecklist(appointmentId, changes, note = "") {
  const args = { p_appointment_id: appointmentId, p_note: note && note.trim() ? note.trim() : null };
  Object.entries(PARAM).forEach(([step, param]) => {
    args[param] = step in changes ? Boolean(changes[step]) : null;
  });
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_session_checklist", args);
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

/* Completed sessions per client before a time, for the follow-up number (F1 = first follow-up after the first
   completed session). Returns { [clientId]: [startsAt ms, ...] } sorted. */
export async function listCompletedSessionTimes(clientIds, before) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const map = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase
      .from("sessions")
      .select("client_id, starts_at")
      .in("client_id", ids.slice(i, i + 150))
      .eq("status", "Completed")
      .lt("starts_at", new Date(before).toISOString());
    if (error) throw error;
    (data || []).forEach((row) => {
      (map[row.client_id] = map[row.client_id] || []).push(new Date(row.starts_at).getTime());
    });
  }
  Object.values(map).forEach((list) => list.sort((a, b) => a - b));
  return map;
}

// Plain words for a log entry: "Client arrived ticked, Reminder sent unticked".
export function describeActivity(entry) {
  const changes = (entry.details && entry.details.changes) || {};
  const parts = CHECKLIST_STEPS.filter((step) => changes[step.id]).map((step) => `${step.label} ${changes[step.id].to ? "ticked" : "unticked"}`);
  return parts.length ? parts.join(", ") : entry.action;
}
