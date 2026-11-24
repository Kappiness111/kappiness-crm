/* Follow-ups (Type A / Type B), communication status and contact history (migrations 202611210002, 202611210005).

   Reads (RLS: staff read everything, a psychologist reads only their own follow-ups):
     follow_ups_with_status   follow_ups + client_name, due_date, due_state (Overdue / Due Today / Later / No Date,
                              computed in clinic time) and the booked appointment's reminder statuses (staff only)
     follow_up_contacts       append-only contact history
   Writes ONLY through these database functions (nobody writes the tables directly):
     create_follow_up(p_client_id, p_follow_up_type, p_recommendation_id, p_due_on, p_assigned_staff_id, p_notes)
     set_follow_up_communication_status(p_follow_up_id, p_status, p_note)   staff; 'No Response' opens one Type B
                                                                            'Contact Needed' follow-up per client
     update_follow_up(p_follow_up_id, p_assigned_staff_id, p_due_on, p_notes) staff; NULL leaves a value unchanged
     close_follow_up(p_follow_up_id, p_status, p_note)                      staff; Completed / No Follow-up Required */

import { createClient } from "../../utils/supabase/client";
import { describeAppointmentError, isMissingBackend } from "./appointmentsApi";

export const FOLLOW_UP_TYPES = ["Type A", "Type B"];

// What each type means, written out so the two never look alike.
export const FOLLOW_UP_TYPE_META = {
  "Type A": { short: "Type A", label: "Next session", description: "The client's next therapy session", tone: "info" },
  "Type B": { short: "Type B", label: "Contact client", description: "Reception contacts the client again", tone: "warning" },
};

// Stored statuses (follow_ups.status).
export const FOLLOW_UP_STATUSES = ["Upcoming", "Tentative", "Pending Confirmation", "Contact Needed", "Completed", "No Follow-up Required"];
export const CLOSED_FOLLOW_UP_STATUSES = ["Completed", "No Follow-up Required"];
// Due states that are shown as a status (they come from due_state in the view, never from the stored status).
export const DUE_STATUSES = ["Due Today", "Overdue"];
// Every status a user can filter by, in the order they read best.
export const FOLLOW_UP_FILTER_STATUSES = [
  "Upcoming",
  "Due Today",
  "Overdue",
  "Tentative",
  "Pending Confirmation",
  "Contact Needed",
  "Completed",
  "No Follow-up Required",
];

export const COMMUNICATION_STATUSES = [
  "Reminder Pending",
  "Message Sent",
  "Call Completed",
  "Client Responded",
  "No Response",
  "Client Will Inform",
];
export const CONFIRMATION_STATUSES = ["Not Requested", "Awaiting Client", "Confirmed", "Declined"];

export function isClosedFollowUp(row) {
  return Boolean(row) && CLOSED_FOLLOW_UP_STATUSES.includes(row.status);
}

// The status a person reads: a confirmed booking shows "Confirmed" instead of "Upcoming".
export function displayStatus(row) {
  if (!row) return "";
  if (row.status === "Upcoming" && row.confirmation_status === "Confirmed") return "Confirmed";
  return row.status;
}

// The client answered a reminder with "Wants to Reschedule".
export function wantsReschedule(row) {
  return Boolean(row) && !isClosedFollowUp(row) && [row.reminder_1_response, row.reminder_2_response].includes("Wants to Reschedule");
}

// A slot is waiting for the client's answer.
export function isAwaitingConfirmation(row) {
  return Boolean(row) && !isClosedFollowUp(row) && (row.status === "Pending Confirmation" || row.confirmation_status === "Awaiting Client");
}

// The time that matters for the list: the proposed slot, else the due day.
export function followUpWhen(row) {
  if (row.proposed_starts_at) return new Date(row.proposed_starts_at).getTime();
  if (row.due_date) return new Date(`${row.due_date}T23:59`).getTime();
  return Number.MAX_SAFE_INTEGER;
}

const DUE_ORDER = { Overdue: 0, "Due Today": 1 };

// Overdue first, then Due Today, then by date; closed follow-ups last.
export function sortFollowUps(rows) {
  return [...rows].sort((a, b) => {
    const closedA = isClosedFollowUp(a) ? 1 : 0;
    const closedB = isClosedFollowUp(b) ? 1 : 0;
    if (closedA !== closedB) return closedA - closedB;
    const dueA = DUE_ORDER[a.due_state] ?? 2;
    const dueB = DUE_ORDER[b.due_state] ?? 2;
    if (dueA !== dueB) return dueA - dueB;
    return followUpWhen(a) - followUpWhen(b);
  });
}

// Reception must contact the client: Type B, Contact Needed, or due/overdue with no answer yet.
export function needsContact(row) {
  if (!row || isClosedFollowUp(row)) return false;
  if (row.follow_up_type === "Type B" || row.status === "Contact Needed") return true;
  return DUE_STATUSES.includes(row.due_state) && ["Reminder Pending", "No Response"].includes(row.communication_status);
}

/* ----- errors ----- */

const RULE_ERRORS = new Set(["P0001", "42501", "22023", "23505", "23P01"]);

// Booking problems, rewritten so reception knows what to do next. Matched on the database's own wording.
const BOOKING_MESSAGES = [
  [/no follow-up slots left that day/i, (m) => `${m.replace(/\.$/, "")}. Choose another day or ask an administrator to raise the daily follow-up limit.`],
  [/held for a follow-up waiting for confirmation|already held for another follow-up/i, () => "That time is held for another client's follow-up. Choose another slot."],
  [/overlaps another booking/i, () => "That time is already booked for this psychologist. Choose another slot."],
  [/outside the psychologist's working hours/i, () => "That time is outside the psychologist's working hours. Choose a time inside their hours."],
  [/psychologist is unavailable at that time/i, () => "The psychologist is on leave or blocked at that time. Choose another slot."],
  [/time in the future/i, () => "That time has already passed. Choose a later slot."],
];
const RAW_DB_TEXT = /violates|constraint|row-level security|relation "|column "|syntax error|permission denied for/i;

// The database functions raise messages written for people; show those as they are, never raw PostgreSQL text.
export function describeFollowUpError(error, fallback = "Could not save the follow-up. Please try again.") {
  if (!error) return fallback;
  if (isMissingBackend(error)) {
    console.error("Follow-up tables or functions are missing (migrations 202611210002 / 202611210005):", error);
    return "Follow-ups aren't set up yet. Please contact your clinic administrator.";
  }
  const message = error.message || "";
  const booking = BOOKING_MESSAGES.find(([pattern]) => pattern.test(message));
  if (booking) return booking[1](message);
  if (error.code === "23P01") return "That time is already taken. Choose another slot.";
  if (RULE_ERRORS.has(error.code) && message && !RAW_DB_TEXT.test(message)) return message;
  return describeAppointmentError(error, fallback);
}

/* ----- reads ----- */

const VIEW = "follow_ups_with_status";

function today() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

export function todayInputValue() {
  return today();
}

/* filters: {
     psychologistId?   one psychologist
     status?           a stored status, or 'Due Today' / 'Overdue' (read from due_state)
     dueState?         'Overdue' | 'Due Today' | 'Later' | 'No Date'
     type?             'Type A' | 'Type B'
     dateFrom?, dateTo? 'YYYY-MM-DD', inclusive, on due_date (proposed slot day, else due_on)
     openOnly?         leave out Completed / No Follow-up Required
   } */
export async function listFollowUps(filters = {}) {
  const supabase = createClient();
  let query = supabase
    .from(VIEW)
    .select("*")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (filters.psychologistId) query = query.eq("psychologist_id", filters.psychologistId);
  if (filters.clientId) query = query.eq("client_id", filters.clientId);
  if (filters.type) query = query.eq("follow_up_type", filters.type);
  if (filters.status) {
    if (DUE_STATUSES.includes(filters.status)) query = query.eq("due_state", filters.status);
    else query = query.eq("status", filters.status);
  }
  if (filters.dueState) query = query.eq("due_state", filters.dueState);
  if (filters.dateFrom) query = query.gte("due_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("due_date", filters.dateTo);
  if (filters.openOnly) query = query.not("status", "in", '("Completed","No Follow-up Required")');
  const { data, error } = await query.limit(2000);
  if (error) throw error;
  return data || [];
}

export async function getFollowUp(id) {
  const supabase = createClient();
  const { data, error } = await supabase.from(VIEW).select("*").eq("id", id).maybeSingle();
  if (error) throw error;
  return data;
}

// Contact history of one follow-up, newest first (read-only).
export async function listContacts(followUpId) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("follow_up_contacts")
    .select("id, follow_up_id, client_id, previous_status, communication_status, note, created_follow_up_id, contacted_by, contacted_by_name, contacted_at")
    .eq("follow_up_id", followUpId)
    .order("contacted_at", { ascending: false });
  if (error) throw error;
  return data || [];
}

// The session a follow-up continues from (date and status), or null.
export async function getSessionSummary(sessionId) {
  if (!sessionId) return null;
  const supabase = createClient();
  const { data, error } = await supabase
    .from("sessions")
    .select("id, starts_at, status, session_type, psychologist_id")
    .eq("id", sessionId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// Phone numbers for a quick WhatsApp / call link. Returns { [clientId]: phone }.
export async function listClientPhones(clientIds) {
  const ids = [...new Set(clientIds.filter(Boolean))];
  if (!ids.length) return {};
  const supabase = createClient();
  const phones = {};
  for (let i = 0; i < ids.length; i += 150) {
    const { data, error } = await supabase.from("clients").select("id, phone").in("id", ids.slice(i, i + 150));
    if (error) throw error;
    (data || []).forEach((row) => {
      if (row.phone) phones[row.id] = row.phone;
    });
  }
  return phones;
}

/* Staff names known from follow-up activity. crm_staff_members has no names and each user may read only their
   own membership, so this is the only name source the browser has. The database still checks that an assigned
   user is active staff. Returns { [userId]: name }. */
export function knownStaffNames(rows = [], contacts = []) {
  const names = {};
  const add = (id, name) => {
    if (id && name && !names[id]) names[id] = name;
  };
  rows.forEach((row) => {
    add(row.updated_by, row.updated_by_name);
    add(row.created_by, row.created_by_name);
    add(row.closed_by, row.closed_by_name);
  });
  contacts.forEach((row) => add(row.contacted_by, row.contacted_by_name));
  return names;
}

/* ----- writes (database functions only) ----- */

async function call(name, args) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(name, args);
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || !row.id) throw new Error("The database returned an empty response.");
  return row;
}

// values: { clientId, type: 'Type A'|'Type B', recommendationId?, dueOn?: 'YYYY-MM-DD', assignedStaffId?, notes? }
export function createFollowUp(values) {
  return call("create_follow_up", {
    p_client_id: values.clientId,
    p_follow_up_type: values.type,
    p_recommendation_id: values.recommendationId || null,
    p_due_on: values.dueOn || null,
    p_assigned_staff_id: values.assignedStaffId || null,
    p_notes: values.notes ? values.notes.trim() : null,
  });
}

/* Records what actually happened with the client. Resolves to { followUp, createdFollowUpId, contactNeededOpen }:
   for 'No Response' the database opens one Type B 'Contact Needed' follow-up for reception, unless the client
   already has one open (createdFollowUpId is then null). undefined = could not be checked. */
export async function setCommunicationStatus(followUpId, status, note = "") {
  const followUp = await call("set_follow_up_communication_status", {
    p_follow_up_id: followUpId,
    p_status: status,
    p_note: note && note.trim() ? note.trim() : null,
  });
  let createdFollowUpId = null;
  if (status === "No Response") {
    try {
      const [latest] = await listContacts(followUpId);
      createdFollowUpId = (latest && latest.communication_status === "No Response" && latest.created_follow_up_id) || null;
    } catch (error) {
      console.error("Saved, but could not read the contact history:", error);
      createdFollowUpId = undefined; // unknown: the UI must not claim either way
    }
  }
  return { followUp, createdFollowUpId, contactNeededOpen: status === "No Response" };
}

/* values: { assignedStaffId?, dueOn?: 'YYYY-MM-DD', notes? }. Leave a key out (or undefined) to keep the value.
   notes: '' clears the notes. */
export function updateFollowUp(followUpId, values = {}) {
  return call("update_follow_up", {
    p_follow_up_id: followUpId,
    p_assigned_staff_id: values.assignedStaffId || null,
    p_due_on: values.dueOn || null,
    p_notes: values.notes === undefined || values.notes === null ? null : String(values.notes),
  });
}

// status: 'Completed' | 'No Follow-up Required'. A note is required.
export function closeFollowUp(followUpId, status, note) {
  return call("close_follow_up", { p_follow_up_id: followUpId, p_status: status, p_note: note ? note.trim() : null });
}

/* ----- follow-up slots and daily capacity (migration 202611210003) ----- */

export const SLOT_STATES = ["Available", "Tentative", "Booked", "Confirmed"];

/* Slots of the next 28 days from follow_up_slot_status (working hours, not past, not on leave), with the slot
   state and the remaining follow-up slots of that day. The grid uses the default 50 + 10 minute slot;
   propose_follow_up_slot checks the real service length again.
   filters: { psychologistId (required), dateFrom?, dateTo? ('YYYY-MM-DD') } */
export async function listSlotStatus(filters) {
  const supabase = createClient();
  let query = supabase
    .from("follow_up_slot_status")
    .select("psychologist_id, slot_date, slot_start, slot_end, slot_state, held_by_follow_up_id, max_follow_up_slots_per_day, day_follow_up_capacity, day_follow_up_slots_used, day_remaining_slots")
    .eq("psychologist_id", filters.psychologistId)
    .order("slot_start", { ascending: true });
  if (filters.dateFrom) query = query.gte("slot_date", filters.dateFrom);
  if (filters.dateTo) query = query.lte("slot_date", filters.dateTo);
  const { data, error } = await query.limit(2000);
  if (error) throw error;
  return data || [];
}

// Hold a slot for a Type A follow-up. status: 'Tentative' | 'Pending Confirmation' (the client has been asked).
// Calling it again moves the follow-up's own hold.
export function proposeFollowUpSlot(followUpId, { startsAt, serviceId, psychologistId = null, status = "Tentative" }) {
  return call("propose_follow_up_slot", {
    p_follow_up_id: followUpId,
    p_starts_at: new Date(startsAt).toISOString(),
    p_service_id: serviceId,
    p_psychologist_id: psychologistId || null,
    p_status: status,
  });
}

// The client confirmed: books the appointment (through book_appointment). The appointment starts Scheduled.
export function confirmFollowUpSlot(followUpId) {
  return call("confirm_follow_up_slot", { p_follow_up_id: followUpId });
}

// The client declined (declined = true) or the hold is withdrawn: the follow-up goes back to Upcoming.
export function releaseFollowUpSlot(followUpId, { declined = true, note = "" } = {}) {
  return call("release_follow_up_slot", {
    p_follow_up_id: followUpId,
    p_declined: Boolean(declined),
    p_note: note && note.trim() ? note.trim() : null,
  });
}

// { max_follow_up_slots_per_day, updated_by_name, updated_at } or null (no row = no extra limit).
export async function getSlotCapacity(psychologistId) {
  const supabase = createClient();
  const { data, error } = await supabase
    .from("follow_up_slot_capacity")
    .select("psychologist_id, max_follow_up_slots_per_day, updated_by_name, updated_at")
    .eq("psychologist_id", psychologistId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// max: 0–48, or null for "No extra limit". Staff only.
export async function setSlotCapacity(psychologistId, max) {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("set_follow_up_slot_capacity", {
    p_psychologist_id: psychologistId,
    p_max: max === null || max === undefined || max === "" ? null : Number(max),
  });
  if (error) throw error;
  return Array.isArray(data) ? data[0] : data;
}
