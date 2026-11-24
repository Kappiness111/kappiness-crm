/* Prepared WhatsApp messages for reception. They are only a starting text: staff edit them before sending, and
   nothing is sent from the CRM. Opening WhatsApp records nothing; staff set the communication status afterwards.
   Messages never mention the reason for therapy or anything from the session. */

import { formatDate, formatTime, phoneDigits } from "./leads";

function firstName(name) {
  return String(name || "").trim().split(/\s+/)[0] || "there";
}

function slotText(row) {
  if (row.proposed_starts_at) return `${formatDate(row.proposed_starts_at)} at ${formatTime(row.proposed_starts_at)}`;
  if (row.due_date) return formatDate(row.due_date);
  return "";
}

export const MESSAGE_TEMPLATES = [
  {
    id: "reminder",
    label: "Follow-up reminder",
    build: (row, psychologistName) =>
      `Hello ${firstName(row.client_name)}, this is the Kappiness team. A reminder that your next session${
        psychologistName ? ` with ${psychologistName}` : ""
      } is due${slotText(row) ? ` around ${slotText(row)}` : " soon"}. Please let us know a time that suits you.`,
  },
  {
    id: "confirmation",
    label: "Appointment confirmation",
    build: (row, psychologistName) =>
      `Hello ${firstName(row.client_name)}, this is the Kappiness team. We have kept ${
        slotText(row) || "a slot"
      } for your next session${psychologistName ? ` with ${psychologistName}` : ""}. Could you please reply to confirm?`,
  },
  {
    id: "reschedule",
    label: "Rescheduling",
    build: (row) =>
      `Hello ${firstName(row.client_name)}, this is the Kappiness team. We understand you would like to change your session time. Please share a few days and times that work for you and we will arrange it.`,
  },
  {
    id: "general",
    label: "General contact",
    build: (row) => `Hello ${firstName(row.client_name)}, this is the Kappiness team. Please let us know a good time to reach you.`,
  },
];

// wa.me link with the (edited) message. Same number rule as whatsappLink in leads.js.
export function whatsappMessageLink(phone, text) {
  const digits = phoneDigits(phone);
  const number = digits.length === 10 ? `91${digits}` : digits;
  return `https://wa.me/${number}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}
