/* Client profiles (public.clients). A client is created by the database when a lead becomes Confirmed with a
   psychologist; the lead stays as it is, linked through clients.lead_id. RLS limits a psychologist to their
   own clients.

   Day 24 (migration 20261125120000):
   - The Client ID is the client's uuid (clients.id); clientIdLabel() shows a short form, search accepts either.
   - listClients() reads public.client_directory (totals, last / next appointment, psychologist name). If the view is
     not deployed yet it falls back to the clients table, so the app keeps working during deployment.
   - Edits and Active/Inactive go through update_client_details / set_client_active (staff only, audited).
   - Phone numbers may be shared by several clients (family members). findPhoneMatches() lists every client with the
     same normalised number so staff can choose; nothing is linked or merged automatically. */

import { createClient } from "../../utils/supabase/client";
import { isMissingBackend } from "./appointmentsApi";

export const CLIENT_EDITABLE_FIELDS = [
  "full_name",
  "phone",
  "email",
  "city",
  "preferred_language",
  "preferred_contact",
  "best_time",
  "service_interest",
  "referral_source",
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
    referral_source: row.referral_source || "",
    is_active: row.is_active !== false,
    total_sessions: row.total_sessions ?? null,
    last_appointment_at: row.last_appointment_at || null,
    last_appointment_status: row.last_appointment_status || null,
    next_appointment_at: row.next_appointment_at || null,
    next_appointment_status: row.next_appointment_status || null,
    linked_enquiries: row.linked_enquiries ?? 0,
  };
}

// Short, readable form of the Client ID (the first block of the uuid). The full id is always shown on the profile.
export function clientIdLabel(id) {
  return id ? `CL-${String(id).slice(0, 8).toUpperCase()}` : "";
}

// Does a search term match this client's id (full uuid, the CL- form, or a prefix of at least 4 characters)?
export function matchesClientId(client, term) {
  const value = String(term || "").trim().toLowerCase().replace(/^cl-/, "");
  if (value.length < 4) return false;
  return String(client.id).toLowerCase().startsWith(value);
}

async function selectClients(source, { psychologistId = null, id = null } = {}) {
  const supabase = createClient();
  let query = supabase.from(source).select("*");
  if (id) query = query.eq("id", id);
  if (psychologistId) query = query.eq("primary_psychologist_id", psychologistId);
  const { data, error } = await query.order("full_name", { ascending: true }).limit(5000);
  return { data, error };
}

export async function listClients({ psychologistId = null } = {}) {
  let { data, error } = await selectClients("client_directory", { psychologistId });
  if (error && isMissingBackend(error)) ({ data, error } = await selectClients("clients", { psychologistId }));
  if (error) throw error;
  return (data || []).map(mapClient);
}

export async function getClient(id) {
  let { data, error } = await selectClients("client_directory", { id });
  if (error && isMissingBackend(error)) ({ data, error } = await selectClients("clients", { id }));
  if (error) throw error;
  return mapClient((data || [])[0] || null);
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

// Staff only (update_client_details: validated and audited; a number shared with another client is allowed).
// expectedUpdatedAt: the client's updated_at when the form was opened, so a save over someone else's change is refused.
export async function updateClientDetails(clientId, values, expectedUpdatedAt = null) {
  const changes = {};
  CLIENT_EDITABLE_FIELDS.forEach((field) => {
    if (field in values) changes[field] = String(values[field] ?? "").trim();
  });
  if ("full_name" in changes && !changes.full_name) throw new Error("A client needs a name.");
  const supabase = createClient();
  const { data, error } = await supabase.rpc("update_client_details", {
    p_client_id: clientId,
    p_changes: changes,
    p_expected_updated_at: expectedUpdatedAt,
  });
  if (error) throw error;
  return mapClient(Array.isArray(data) ? data[0] : data);
}

// Staff only. A reason is required to mark a client inactive; appointments and history are always kept.
export async function setClientActive(clientId, active, reason = "") {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_client_active", {
    p_client_id: clientId,
    p_active: Boolean(active),
    p_reason: reason || null,
  });
  if (error) throw error;
  return mapClient(Array.isArray(data) ? data[0] : data);
}

// ALL clients and leads with the same (normalised) phone number. Staff only. Several clients may share a number.
// Resolves to { normalized, clients: [...], leads: [...] }.
export async function findPhoneMatches(phone, excludeLeadId = null) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("find_phone_matches", { p_phone: phone || "", p_exclude_lead_id: excludeLeadId });
  if (error) throw error;
  return { normalized: data?.normalized || null, clients: data?.clients || [], leads: data?.leads || [] };
}

// Links an enquiry to an existing client (before it is Confirmed). A note is required when the phones differ.
export async function linkLeadToClient(leadId, clientId, note = "") {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("link_lead_to_client", { p_lead_id: leadId, p_client_id: clientId, p_note: note || null });
  if (error) throw error;
  return data;
}

export async function unlinkLeadFromClient(leadId, reason) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("unlink_lead_from_client", { p_lead_id: leadId, p_reason: reason });
  if (error) throw error;
  return data;
}

// Every lead -> existing-client link (staff only). Missing table (not deployed yet) -> [].
export async function listLeadClientLinks({ clientId = null } = {}) {
  const supabase = createClient();
  let query = supabase.from("lead_client_links").select("lead_id, client_id, match_basis, note, linked_by_name, linked_at");
  if (clientId) query = query.eq("client_id", clientId);
  const { data, error } = await query.order("linked_at", { ascending: false }).limit(5000);
  if (error) {
    if (isMissingBackend(error)) return [];
    throw error;
  }
  return data || [];
}

// The enquiries that belong to a client: its original lead plus every linked one (staff only: leads are staff-only).
export async function listClientEnquiries(client) {
  const links = await listLeadClientLinks({ clientId: client.id });
  const ids = [client.lead_id, ...links.map((item) => item.lead_id)].filter(Boolean);
  if (ids.length === 0) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("leads")
    .select("id, lead_code, full_name, phone, source, status, service_interest, created_at")
    .in("id", ids);
  if (error) throw error;
  const linkBy = new Map(links.map((item) => [item.lead_id, item]));
  return (data || [])
    .map((lead) => ({ ...lead, original: lead.id === client.lead_id, link: linkBy.get(lead.id) || null }))
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

// Client detail / status changes recorded by the database (activity_log, entity_type 'client'). Staff, and the
// psychologists who can read the client (activity_log_client_audit_read), may read them; nobody can change them.
export async function listClientChanges(clientId) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("activity_log")
    .select("id, action, actor_name, details, created_at")
    .eq("entity_type", "client")
    .eq("entity_id", clientId)
    .order("created_at", { ascending: false })
    .limit(100);
  if (error) {
    if (isMissingBackend(error)) return [];
    throw error;
  }
  return data || [];
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
