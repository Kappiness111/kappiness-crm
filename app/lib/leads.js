/* Shared constants and helpers for the Kappiness CRM lead screens. */

export const STATUSES = ["New", "Contacted", "Follow Up", "Converted", "Lost"];
export const CLOSED_STATUSES = ["Converted", "Lost"];

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
