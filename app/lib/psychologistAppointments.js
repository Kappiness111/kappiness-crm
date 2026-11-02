/* ====================================================================
   INTEGRATION POINT: psychologist appointments and sessions
   ====================================================================
   No appointments / sessions table, view or function exists in this project yet, and none was
   documented by the backend team. To avoid inventing database fields, this file is the ONLY place
   that talks about appointment data. Everything else (calendar, panels, overview) works on the
   normalized shape below.

   When the backend is ready, the backend team needs to provide (with RLS so a psychologist only
   sees their own sessions and the client fields they are allowed to see):

   1. Read: appointments for one psychologist between two timestamps, returning for each row
        id, client_id, client_name, starts_at, ends_at,
        session_type   ("regular" | "follow_up"),
        status         ("scheduled" | "confirmed" | "completed" | "cancelled" | "missed"),
        follow_up_of / follow_up_recommended_at (optional)
   2. Update status: a way for the psychologist to set completed / cancelled / missed.
   3. Recommend follow-up: a way to store { appointment/client, recommended date and time, notes? }
      for staff to pick up in the CRM.

   Then: set the matching CAPABILITIES flag to true and fill in the query inside the function.
   ==================================================================== */

export const CAPABILITIES = {
  read: false,
  updateStatus: false,
  recommendFollowUp: false,
  followUpNotes: false,
};

const TYPES = ["regular", "follow_up"];
const STATUSES = ["scheduled", "confirmed", "completed", "cancelled", "missed"];

// Turns a backend row into what the calendar renders. Returns null for rows that cannot be shown.
// Adjust the field names here once the backend structure is confirmed.
export function normalizeAppointment(row) {
  if (!row) return null;
  const start = new Date(row.starts_at);
  const end = new Date(row.ends_at);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end <= start) return null;

  return {
    id: row.id,
    clientId: row.client_id || null,
    clientName: String(row.client_name || "Client").trim(),
    start,
    end,
    type: TYPES.includes(row.session_type) ? row.session_type : "regular",
    status: STATUSES.includes(row.status) ? row.status : "scheduled",
    followUpRecommendedAt: row.follow_up_recommended_at || null,
  };
}

// Resolves to { supported, items }. Throws on a real query failure so the UI can show an error state.
export async function fetchAppointments(psychologistId, rangeStart, rangeEnd) {
  void psychologistId;
  void rangeStart;
  void rangeEnd;
  if (!CAPABILITIES.read) return { supported: false, items: [] };

  // TODO(backend): query the agreed source here, then:
  // return { supported: true, items: rows.map(normalizeAppointment).filter(Boolean) };
  return { supported: false, items: [] };
}

// Resolves to { ok, message }.
export async function updateSessionStatus(appointmentId, status) {
  void appointmentId;
  void status;
  if (!CAPABILITIES.updateStatus) {
    return { ok: false, message: "Updating session status needs backend support, which is not available yet." };
  }
  // TODO(backend): call the agreed update workflow here.
  return { ok: false, message: "Updating session status is not connected yet." };
}

// values = { appointmentId, clientId, date: "YYYY-MM-DD", time: "HH:MM", notes? }. Resolves to { ok, message }.
export async function recommendFollowUp(values) {
  void values;
  if (!CAPABILITIES.recommendFollowUp) {
    return { ok: false, message: "Recommending a follow-up needs backend support, which is not available yet." };
  }
  // TODO(backend): call the agreed follow-up recommendation workflow here.
  return { ok: false, message: "Follow-up recommendations are not connected yet." };
}