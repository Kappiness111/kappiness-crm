/* Shared constants and helpers for the Kappiness CRM lead screens. */

// These values must match the leads_status_check constraint and the update_lead_with_history RPC
// (supabase/migrations/202611030002_lead_status_lost_and_psychologist.sql).
export const STATUSES = ["Enquiry", "Yet to Confirm", "Will Inform", "Confirmed", "Lost"];
// A lost lead stays in the CRM for reporting, but drops out of follow-up reminders.
export const CLOSED_STATUSES = ["Lost"];
export const DEFAULT_STATUS = "Enquiry";
// Leads in these statuses have no confirmed appointment yet.
export const UNCONFIRMED_STATUSES = ["Enquiry", "Yet to Confirm", "Will Inform"];
export const CONFIRMED_STATUS = "Confirmed";
export const LOST_STATUS = "Lost";

// Allowed lead status changes. Confirmed and Lost are final. The database trigger enforce_lead_workflow
// (migration 202611040001) applies the same table, so this only keeps the menus honest.
export const STATUS_TRANSITIONS = {
  Enquiry: ["Yet to Confirm", "Lost"],
  "Yet to Confirm": ["Enquiry", "Will Inform", "Lost"],
  "Will Inform": ["Yet to Confirm", "Confirmed", "Lost"],
  Confirmed: [],
  Lost: [],
};

// The current status plus the statuses it may move to, in pipeline order.
export function statusOptions(current) {
  const next = STATUS_TRANSITIONS[current] || [];
  return STATUSES.filter((status) => status === current || next.includes(status));
}

// Explains how an open lead reaches Confirmed when it cannot move there directly (only Will Inform can).
export function confirmPathHint(current) {
  if (current === "Enquiry") return "To confirm: move to Yet to Confirm, then Will Inform, then Confirmed.";
  if (current === "Yet to Confirm") return "To confirm: move to Will Inform first, then Confirmed.";
  return "";
}

export function canMoveStatus(from, to) {
  return from === to || (STATUS_TRANSITIONS[from] || []).includes(to);
}

/* ----- psychologist assignment ----- */

// leads.assigned_psychologist_id -> psychologists.id (added by the migration above).
export const PSYCHOLOGIST_COLUMN = "assigned_psychologist_id";
export const CONFIRM_NEEDS_PSYCHOLOGIST = "Assign a psychologist before setting this lead to Confirmed.";

/* ----- lost reason (stored in the existing leads.not_converted_reason column) ----- */

export const LOST_REASONS = [
  "Not interested",
  "Budget constraints",
  "No response",
  "Chose another service provider",
  "Not suitable for the service",
  "Other",
];
export const LOST_REASON_OTHER = "Other";
export const LOST_DETAIL_LIMIT = 200;

// "Other" is saved as "Other: <explanation>" so the explanation is kept with the reason.
export function buildLostReason(choice, detail = "") {
  if (choice === LOST_REASON_OTHER) return `${LOST_REASON_OTHER}: ${detail.trim()}`;
  return choice || "";
}

// Splits a saved reason back into the dropdown choice and the free-text explanation.
export function parseLostReason(value) {
  const text = (value || "").trim();
  if (!text) return { choice: "", detail: "" };
  if (LOST_REASONS.includes(text) && text !== LOST_REASON_OTHER) return { choice: text, detail: "" };
  const other = /^Other:\s*(.*)$/s.exec(text);
  // Anything else (older free-text reasons) is shown as an "Other" explanation so it is not lost.
  return { choice: LOST_REASON_OTHER, detail: other ? other[1] : text };
}

// Returns { choice?, detail? } error messages for a Lost reason.
export function validateLostReason(choice, detail = "") {
  const errors = {};
  if (!LOST_REASONS.includes(choice)) errors.choice = "Choose why this lead was lost.";
  else if (choice === LOST_REASON_OTHER && !detail.trim()) errors.detail = "Add a short explanation for Other.";
  if (detail.length > LOST_DETAIL_LIMIT) errors.detail = `Keep the explanation under ${LOST_DETAIL_LIMIT} characters.`;
  return errors;
}

/* ----- Supabase errors on lead saves ----- */

// Short, specific messages for the lead form and drawer. Full details still go to the console.
export function describeLeadError(error, fallback = "Could not save your changes. Please try again.") {
  const code = error && error.code;
  const text = `${(error && error.message) || ""} ${(error && error.details) || ""}`;
  if (code === "23514" && /leads_status_check/.test(text)) {
    console.error("leads_status_check rejected the status; migration 202611030002 may be missing:", error);
    return "This status can't be saved yet because the database needs an update. Please let your administrator know.";
  }
  if (code === "23514") return "One of these values isn't allowed. Please check the form and try again.";
  if (code === "23503") return "The selected psychologist no longer exists. Refresh the page and choose again.";
  if (code === "23502") return "A required field is missing. Please fill in every required field.";
  if (code === "23505") return "A lead with these details already exists.";
  if (code === "42501") return "You do not have permission to save this change. Please ask your administrator to check access.";
  if (code === "PGRST116") return "This lead wasn't updated. It may have been removed, or you may not have permission to edit it.";
  if (code === "PGRST204" || code === "42703") {
    console.error("The leads table is missing a column this change needs:", error);
    return "This change can't be saved yet because the database needs an update. Please let your administrator know.";
  }
  // Raised on purpose by update_lead_with_history with a message written for staff.
  if ((code === "P0001" || code === "22023") && error.message) return error.message;
  return fallback;
}

export const SOURCES = [
  "Google Ad",
  "Meta Ad",
  "Other",
];

export const SERVICES = [
  "Individual counselling",
  "Couples counselling",
  "Family counselling",
  "Child & adolescent",
  "Career guidance",
  "Workshop / group session",
  "Not sure yet",
];

export const LANGUAGES = ["Malayalam", "English", "Hindi", "Tamil", "Other"];
export const CONTACT_METHODS = ["Call", "WhatsApp", "Other"];
export const CONTACT_TIMES = ["Any time", "Morning", "Afternoon", "Evening"];
export const PRIORITIES = ["Normal", "High", "Urgent"];
export const NOTES_LIMIT = 500;

/* ----- dates ----- */

function pad(value) {
  return String(value).padStart(2, "0");
}

export function parseDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

// Converts any date value into the format <input type="datetime-local"> needs.
export function toInputValue(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(
    date.getHours()
  )}:${pad(date.getMinutes())}`;
}

// A datetime-local value for `days` from now at 10:00 AM (used by quick picks).
export function quickFollowUpValue(days, now = new Date()) {
  const date = new Date(now);
  date.setDate(date.getDate() + days);
  date.setHours(10, 0, 0, 0);
  return toInputValue(date);
}

export function formatDate(value) {
  const date = parseDate(value);
  if (!value) return "Not scheduled";
  if (!date) return value;
  return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

export function formatTime(value) {
  const date = parseDate(value);
  if (!date) return "";
  return date
    .toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", hour12: true })
    .toUpperCase();
}

export function formatDateTime(value) {
  const date = parseDate(value);
  if (!value) return "Not scheduled";
  if (!date) return value;
  return `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" })}, ${formatTime(value)}`;
}

export function formatShort(value) {
  const date = parseDate(value);
  if (!date) return "";
  return `${date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })}, ${formatTime(value)}`;
}

function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function dayDiff(value, now) {
  const date = parseDate(value);
  if (!date || !now) return null;
  return Math.round((startOfDay(date) - startOfDay(now)) / 86400000);
}

// "overdue" | "today" | "upcoming" | null (closed, unscheduled, or clock not ready)
export function getFollowUpState(lead, now) {
  if (!lead.next_follow_up_at || CLOSED_STATUSES.includes(lead.status)) return null;
  const diff = dayDiff(lead.next_follow_up_at, now);
  if (diff === null) return null;
  if (diff < 0) return "overdue";
  if (diff === 0) return "today";
  return "upcoming";
}

export function dueLabel(lead, now) {
  const diff = dayDiff(lead.next_follow_up_at, now);
  if (diff === null) return "";
  if (diff < 0) return `${Math.abs(diff)} day${Math.abs(diff) > 1 ? "s" : ""} overdue`;
  if (diff === 0) return "Today";
  if (diff === 1) return "Tomorrow";
  return formatDate(lead.next_follow_up_at);
}

export function relativeTime(value, now) {
  const date = parseDate(value);
  if (!date) return "";
  if (!now) return formatDateTime(value);

  const minutes = Math.round((now - date) / 60000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days} day${days > 1 ? "s" : ""} ago`;
  return formatDateTime(value);
}

export function getGreeting(now) {
  if (!now) return "Welcome";
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/* ----- contact ----- */

export function phoneDigits(phone) {
  return (phone || "").replace(/\D/g, "");
}

export function whatsappLink(phone) {
  const digits = phoneDigits(phone);
  return `https://wa.me/${digits.length === 10 ? `91${digits}` : digits}`;
}

/* ----- records ----- */

export function nextLeadCode(leads) {
  const highest = leads.reduce((max, lead) => {
    const match = /KAP-(\d+)/.exec(lead.lead_code || "");
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0);
  return `KAP-${String(highest + 1).padStart(3, "0")}`;
}

export function makeActivity(type, text) {
  return {
    id: `act-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    text,
    at: new Date().toISOString(),
  };
}

// Chronological activity (oldest first). Older records get a synthetic "created" entry.
export function ensureActivity(lead) {
  if (Array.isArray(lead.activity) && lead.activity.length > 0) return lead.activity;
  return [
    {
      id: `${lead.id}-created`,
      type: "created",
      text: lead.source ? `Lead created from ${lead.source}` : "Lead created",
      at: lead.created_at,
    },
  ];
}

// Newest first, for display.
export function getActivity(lead) {
  return [...ensureActivity(lead)].reverse();
}