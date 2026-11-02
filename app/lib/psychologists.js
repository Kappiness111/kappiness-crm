/* Shared constants, helpers and validation for the Psychologist Management module. */

// day_of_week convention agreed with the backend: Monday = 1 ... Sunday = 7.
export const DAYS = [
  { value: 1, name: "Monday", short: "Mon" },
  { value: 2, name: "Tuesday", short: "Tue" },
  { value: 3, name: "Wednesday", short: "Wed" },
  { value: 4, name: "Thursday", short: "Thu" },
  { value: 5, name: "Friday", short: "Fri" },
  { value: 6, name: "Saturday", short: "Sat" },
  { value: 7, name: "Sunday", short: "Sun" },
];

/* ------------------------------------------------------------------ */
/* Column mapping                                                      */
/* BACKEND ASSUMPTION: psychologists has id, full_name, phone,         */
/* is_active, auth_user_id, created_at. If a column is named           */
/* differently, change the candidates below (one place only). The      */
/* first candidate found on a real row is used for reads and writes.   */
/* ------------------------------------------------------------------ */

const COLUMN_CANDIDATES = {
  name: ["full_name", "name"],
  phone: ["phone", "phone_number", "mobile"],
  active: ["is_active", "active"],
};

const columns = { name: "full_name", phone: "phone", active: "is_active" };

export function resolveColumns(sample) {
  if (!sample) return;
  Object.entries(COLUMN_CANDIDATES).forEach(([field, candidates]) => {
    const found = candidates.find((key) => key in sample);
    if (found) columns[field] = found;
  });
}

// Turns a database row into what the screens use. auth_user_id is never exposed, only whether one exists.
export function mapPsychologist(record) {
  const activeValue = record[columns.active];
  return {
    id: record.id,
    name: String(record[columns.name] || "").trim(),
    phone: String(record[columns.phone] || "").trim(),
    active: activeValue === undefined ? true : Boolean(activeValue),
    hasLogin: Boolean(record.auth_user_id),
    createdAt: record.created_at || "",
  };
}

// Builds a write payload from { name, phone, active } (any subset).
export function toPsychologistPayload(values) {
  const payload = {};
  if ("name" in values) payload[columns.name] = values.name;
  if ("phone" in values) payload[columns.phone] = values.phone;
  if ("active" in values) payload[columns.active] = values.active;
  return payload;
}

/* ------------------------------------------------------------------ */
/* Permissions                                                         */
/* BACKEND DEPENDENCY: the role is read from app_metadata.role (which  */
/* users cannot edit). Until the backend publishes it, the role is     */
/* unknown and the UI only hides write actions for psychologists.      */
/* Row Level Security remains the real enforcement either way.         */
/* ------------------------------------------------------------------ */

export function getUserRole(user) {
  const role = user && user.app_metadata && user.app_metadata.role;
  return typeof role === "string" ? role.trim().toLowerCase() : "";
}

export function canManagePsychologists(role) {
  return role !== "psychologist";
}

/* ------------------------------------------------------------------ */
/* Time helpers                                                        */
/* ------------------------------------------------------------------ */

export function toHHMM(value) {
  return String(value || "").slice(0, 5);
}

export function timeToMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

export function formatClock(value) {
  const minutes = timeToMinutes(value);
  if (minutes === null) return "";
  const hour24 = Math.floor(minutes / 60);
  const minute = String(minutes % 60).padStart(2, "0");
  const suffix = hour24 >= 12 ? "PM" : "AM";
  const hour12 = hour24 % 12 === 0 ? 12 : hour24 % 12;
  return `${hour12}:${minute} ${suffix}`;
}

export function formatRange(start, end) {
  return `${formatClock(start)} – ${formatClock(end)}`;
}

export function formatMemberSince(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

/* ------------------------------------------------------------------ */
/* Availability summary for the table                                  */
/* ------------------------------------------------------------------ */

export function summarizeAvailability(periods) {
  if (!periods || periods.length === 0) return { label: "Not set", detail: "" };
  const active = periods.filter((period) => period.is_active);
  if (active.length === 0) return { label: "All periods inactive", detail: `${periods.length} saved` };

  const dayValues = [...new Set(active.map((period) => Number(period.day_of_week)))].sort((a, b) => a - b);
  const label = dayValues
    .map((value) => (DAYS.find((day) => day.value === value) || {}).short)
    .filter(Boolean)
    .join(", ");
  return { label, detail: `${active.length} active period${active.length === 1 ? "" : "s"}` };
}

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

export function normalizePhone(value) {
  return String(value || "").replace(/[\s\-()]/g, "");
}

export function validatePsychologist(values) {
  const errors = {};
  const name = (values.name || "").trim();
  const phone = normalizePhone(values.phone);

  if (!name) errors.name = "Enter the psychologist's full name.";
  else if (name.length < 2) errors.name = "The name looks too short.";
  else if (name.length > 120) errors.name = "Keep the name under 120 characters.";

  if (!phone) errors.phone = "Enter a phone number.";
  else if (!/^\+?\d{7,15}$/.test(phone)) {
    errors.phone = "Enter a valid phone number, for example +91 98765 43210.";
  }

  return errors;
}

// existing = the psychologist's other periods; editingId = the period being edited (ignored in overlap checks).
export function validateAvailability(draft, existing = [], editingId = null) {
  const errors = {};
  const day = Number(draft.day_of_week);

  if (!DAYS.some((item) => item.value === day)) errors.day_of_week = "Choose a weekday.";
  if (!draft.start_time) errors.start_time = "Choose a start time.";
  if (!draft.end_time) errors.end_time = "Choose an end time.";

  const start = timeToMinutes(draft.start_time);
  const end = timeToMinutes(draft.end_time);

  if (start !== null && end !== null) {
    if (end <= start) errors.end_time = "End time must be later than the start time.";
    else if (draft.is_active && !errors.day_of_week) {
      const clash = existing.find((period) => {
        if (editingId !== null && String(period.id) === String(editingId)) return false;
        if (!period.is_active || Number(period.day_of_week) !== day) return false;
        const otherStart = timeToMinutes(period.start_time);
        const otherEnd = timeToMinutes(period.end_time);
        return otherStart !== null && otherEnd !== null && start < otherEnd && end > otherStart;
      });
      if (clash) {
        errors.start_time = `This overlaps an active period (${formatRange(clash.start_time, clash.end_time)}).`;
      }
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ */
/* Supabase error messages                                             */
/* ------------------------------------------------------------------ */

export function describeError(error, fallback = "Something went wrong. Please try again.") {
  const code = error && error.code;
  if (code === "42501") return "You do not have permission to do this. Please ask your administrator to check access.";
  if (code === "PGRST116") return "Nothing was changed. The record may not exist, or you may not have permission to edit it.";
  if (code === "23505") return "A record with these details already exists.";
  if (code === "23502") return "The database requires a value that this form cannot provide yet. This needs backend integration (see the note in the form).";
  if (code === "23514") return "The database rejected these values. Please check them and try again.";
  if (code === "42P01") return "A required table is not available in this environment.";
  if (code === "PGRST204" || code === "42703") return "A column is missing in the database. Please ask the backend team to confirm the table structure.";
  return fallback;
}