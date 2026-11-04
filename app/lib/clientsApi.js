/* Client profiles (public.clients). A client is created by the database when a lead becomes Confirmed with a
   psychologist; the lead stays as it is, linked through clients.lead_id. RLS limits a psychologist to their
   own clients. */

import { createClient } from "../../utils/supabase/client";

export const CLIENT_EDITABLE_FIELDS = [
  "full_name",
  "phone",
  "email",
  "city",
  "preferred_language",
  "preferred_contact",
  "best_time",
  "service_interest",
];

export function mapClient(row) {
  if (!row) return null;
  return {
    ...row,
    full_name: row.full_name || "Client",
    phone: row.phone || "",
    email: row.email || "",
    city: row.city || "",
    preferred_language: row.preferred_language || "",
    preferred_contact: row.preferred_contact || "",
    best_time: row.best_time || "",
    service_interest: row.service_interest || "",
  };
}

export async function listClients({ psychologistId = null } = {}) {
  const supabase = createClient();
  let query = supabase.from("clients").select("*").order("full_name", { ascending: true });
  if (psychologistId) query = query.eq("primary_psychologist_id", psychologistId);
  const { data, error } = await query.limit(5000);
  if (error) throw error;
  return (data || []).map(mapClient);
}

export async function getClient(id) {
  const supabase = createClient();
  const { data, error } = await supabase.from("clients").select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return mapClient(data);
}

// Staff only (database function). Also updates the lead's assigned psychologist and records history.
export async function assignClientPsychologist(clientId, psychologistId) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("assign_client_psychologist", {
    p_client_id: clientId,
    p_psychologist_id: psychologistId,
  });
  if (error) throw error;
  return mapClient(Array.isArray(data) ? data[0] : data);
}

// Staff only (RLS + column grants).
export async function updateClientDetails(clientId, values) {
  const payload = { updated_at: new Date().toISOString() };
  CLIENT_EDITABLE_FIELDS.forEach((field) => {
    if (field in values) payload[field] = String(values[field] || "").trim() || null;
  });
  if (!payload.full_name && "full_name" in values) throw new Error("A client needs a name.");
  const supabase = createClient();
  const { data, error } = await supabase.from("clients").update(payload).eq("id", clientId).select("*").single();
  if (error) throw error;
  return mapClient(data);
}

// The original lead history (staff only: psychologists cannot read lead_activities).
export async function listLeadActivities(leadId) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("lead_activities")
    .select("id, activity_type, staff_member, occurred_at, notes, outcome")
    .eq("lead_id", leadId)
    .order("occurred_at", { ascending: false })
    .limit(200);
  if (error) throw error;
  return data || [];
}
