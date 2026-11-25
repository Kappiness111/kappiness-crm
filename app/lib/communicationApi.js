/* Communication tracking for leads and clients (public.communication_events, migration 20261125120000).
   Append-only history: every entry records the channel, the communication status, notes, the staff member (from the
   login, never typed) and when it happened. Written only by record_communication(); staff only.

   The status vocabulary is shared with follow-ups (followUpsApi.js COMMUNICATION_STATUSES), but it is a separate
   status: it never changes the lead status, client status, appointment status or session status.

   Opening WhatsApp records nothing. "Message Sent" is only saved when staff confirm the message was sent. */

import { createClient } from "../../utils/supabase/client";
import { COMMUNICATION_STATUSES, communicationLabel } from "./followUpsApi";
import { isMissingBackend } from "./appointmentsApi";

export { COMMUNICATION_STATUSES, communicationLabel };

export const COMMUNICATION_CHANNELS = ["Call", "WhatsApp", "SMS", "Email", "Reminder", "In person", "Other"];

// Statuses that only make sense on some channels (the database enforces the same rule).
const STATUS_CHANNELS = {
  "Call Completed": ["Call"],
  "Message Sent": ["WhatsApp", "SMS", "Email", "Reminder"],
};

export function channelAllows(channel, status) {
  const allowed = STATUS_CHANNELS[status];
  return !allowed || allowed.includes(channel);
}

export function statusesForChannel(channel) {
  return COMMUNICATION_STATUSES.filter((status) => channelAllows(channel, status));
}

export const COMMUNICATION_TONE = {
  "Reminder Pending": "tone-warning",
  "Message Sent": "tone-info",
  "Call Completed": "tone-info",
  "Client Responded": "tone-success",
  "No Response": "tone-danger",
  "Client Will Inform": "tone-warning",
};

const RULE_CODES = new Set(["P0001", "22023", "42501"]);

export function describeCommunicationError(error, fallback = "Could not save the communication. Please try again.") {
  if (!error) return fallback;
  if (isMissingBackend(error)) return "Communication tracking isn't set up yet. Ask the backend team to apply migration 20261125120000.";
  if (RULE_CODES.has(error.code) && error.message && !/violates|constraint|relation "|column "/i.test(error.message)) return error.message;
  if (error.code === "23514") return "Some details are not valid for this communication. Please check them.";
  return fallback;
}

// subject: { leadId } or { clientId }. occurredAt: Date / ISO / null (now).
export async function recordCommunication({ leadId = null, clientId = null, channel, status, notes = "", occurredAt = null }) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("record_communication", {
    p_lead_id: leadId,
    p_client_id: clientId,
    p_channel: channel,
    p_status: status,
    p_notes: notes ? notes.trim() : null,
    p_occurred_at: occurredAt ? new Date(occurredAt).toISOString() : null,
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}

// History for any number of leads and/or one client, newest first. Missing table (not deployed yet) -> [].
export async function listCommunications({ leadIds = [], clientId = null } = {}) {
  const ids = leadIds.filter(Boolean);
  if (!ids.length && !clientId) return [];
  const supabase = createClient();
  let query = supabase.from("communication_events").select("*");
  if (ids.length && clientId) query = query.or(`client_id.eq.${clientId},lead_id.in.(${ids.join(",")})`);
  else if (clientId) query = query.eq("client_id", clientId);
  else query = query.in("lead_id", ids);
  const { data, error } = await query.order("occurred_at", { ascending: false }).order("created_at", { ascending: false }).limit(500);
  if (error) {
    if (isMissingBackend(error)) return [];
    throw error;
  }
  return data || [];
}

// Follow-up communications of a client (Sariga's follow_up_contacts, read-only here), shaped like
// communication_events so one timeline can show both. They stay recorded only in follow_up_contacts.
export async function listFollowUpContactsForClient(clientId) {
  if (!clientId) return [];
  const supabase = createClient();
  const { data, error } = await supabase
    .from("follow_up_contacts")
    .select("id, follow_up_id, client_id, previous_status, communication_status, note, contacted_by_name, contacted_at")
    .eq("client_id", clientId)
    .order("contacted_at", { ascending: false })
    .limit(200);
  if (error) {
    if (isMissingBackend(error)) return [];
    throw error;
  }
  return (data || []).map((row) => ({
    id: `fu-${row.id}`,
    source: "follow-up",
    follow_up_id: row.follow_up_id,
    client_id: row.client_id,
    lead_id: null,
    channel: null,
    communication_status: row.communication_status,
    previous_status: row.previous_status,
    notes: row.note,
    occurred_at: row.contacted_at,
    created_at: row.contacted_at,
    recorded_by_name: row.contacted_by_name,
  }));
}

// The latest status of a history (newest first), or null.
export function currentCommunicationStatus(events) {
  return events && events.length ? events[0].communication_status : null;
}
