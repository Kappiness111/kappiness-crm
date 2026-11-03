/* Sessions (what actually happened) and follow-up recommendations (migration 202611040001).
   A session is created with its appointment and follows its attendance; details are edited through
   update_session. Recommendations have their own status, separate from appointment status. */

import { createClient } from "../../utils/supabase/client";

export const SESSION_STATUSES = ["Scheduled", "Completed", "Cancelled", "Missed"];
export const SESSION_TYPES = ["Initial", "Regular", "Follow-up", "Assessment"];
export const RECOMMENDATION_STATUSES = ["Open", "Scheduled", "Completed", "Dismissed"];
export const RECOMMENDATION_PRIORITIES = ["Normal", "High", "Urgent"];

const SESSION_SELECT = "*, client:clients(id, lead_id, full_name)";
const RECOMMENDATION_SELECT = "*, client:clients(id, lead_id, full_name, phone), session:sessions(id, starts_at, session_type)";

function mapSession(row) {
  const client = row.client || {};
  return { ...row, client_name: client.full_name || "Client", lead_id: client.lead_id || null };
}

function mapRecommendation(row) {
  const client = row.client || {};
  return { ...row, client_name: client.full_name || "Client", client_phone: client.phone || "", lead_id: client.lead_id || null };
}

// filters: { psychologistId?, clientId?, from?, to?, statuses? }
export async function listSessions(filters = {}) {
  const supabase = createClient();
  let query = supabase.from("sessions").select(SESSION_SELECT).order("starts_at", { ascending: false });
  if (filters.psychologistId) query = query.eq("psychologist_id", filters.psychologistId);
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.from) query = query.gte("starts_at", new Date(filters.from).toISOString());
  if (filters.to) query = query.lt("starts_at", new Date(filters.to).toISOString());
  if (filters.statuses && filters.statuses.length) query = query.in("status", filters.statuses);
  const { data, error } = await query.limit(5000);
  if (error) throw error;
  return (data || []).map(mapSession);
}

export async function getSessionByAppointment(appointmentId) {
  const supabase = createClient();
  const { data, error } = await supabase.from("sessions").select(SESSION_SELECT).eq("appointment_id", appointmentId).maybeSingle();
  if (error) throw error;
  return data ? mapSession(data) : null;
}

// Clinical notes are only readable by the session's psychologist and administrators (RLS); others get none.
export async function listSessionNotes(sessionIds) {
  if (!sessionIds.length) return {};
  const supabase = createClient();
  const { data, error } = await supabase.from("session_notes").select("*").in("session_id", sessionIds);
  if (error) throw error;
  const map = {};
  (data || []).forEach((row) => {
    map[row.session_id] = row;
  });
  return map;
}

export async function listSessionHistory(sessionIds) {
  if (!sessionIds.length) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("session_status_history")
    .select("*")
    .in("session_id", sessionIds)
    .order("changed_at", { ascending: true });
  if (error) throw error;
  return data || [];
}

// values: { sessionType?, outcome?, notes? } — only the supplied fields change.
export async function updateSession(sessionId, values) {
  const supabase = createClient();
  const { error } = await supabase.rpc("update_session", {
    p_session_id: sessionId,
    p_session_type: values.sessionType ?? null,
    p_outcome: values.outcome ?? null,
    p_notes: values.notes ?? null,
    p_starts_at: null,
    p_ends_at: null,
  });
  if (error) throw error;
}

/* ----- recommendations ----- */

// filters: { psychologistId?, clientId?, statuses? }
export async function listRecommendations(filters = {}) {
  const supabase = createClient();
  let query = supabase
    .from("follow_up_recommendations")
    .select(RECOMMENDATION_SELECT)
    .order("recommended_date", { ascending: true });
  if (filters.psychologistId) query = query.eq("psychologist_id", filters.psychologistId);
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.statuses && filters.statuses.length) query = query.in("status", filters.statuses);
  const { data, error } = await query.limit(5000);
  if (error) throw error;
  return (data || []).map(mapRecommendation);
}

// values: { sessionId, recommendation, date: "YYYY-MM-DD", time?: "HH:MM", priority? }
export async function createRecommendation(values) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("create_recommendation", {
    p_session_id: values.sessionId,
    p_recommendation: values.recommendation,
    p_recommended_date: values.date,
    p_recommended_time: values.time || null,
    p_priority: values.priority || "Normal",
  });
  if (error) throw error;
  return data;
}

export async function updateRecommendation(id, values) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_recommendation", {
    p_id: id,
    p_recommendation: values.recommendation,
    p_recommended_date: values.date,
    p_recommended_time: values.time || null,
    p_priority: values.priority || "Normal",
  });
  if (error) throw error;
  return data;
}

// status: "Completed" | "Dismissed"
export async function closeRecommendation(id, status, outcome) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("close_recommendation", { p_id: id, p_status: status, p_outcome: outcome });
  if (error) throw error;
  return data;
}

// Open recommendations whose date has passed are overdue.
export function recommendationState(rec, now = new Date()) {
  if (rec.status !== "Open") return rec.status.toLowerCase();
  const due = new Date(`${rec.recommended_date}T${rec.recommended_time || "23:59"}`);
  return due.getTime() < now.getTime() ? "overdue" : "open";
}
