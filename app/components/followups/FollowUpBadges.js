"use client";

import { Badge } from "../ui/StatusBadges";
import { FOLLOW_UP_TYPE_META, communicationLabel, confirmationLabel, displayStatus, wantsReschedule } from "../../lib/followUpsApi";
import { formatDate } from "../../lib/leads";

/* Badges for follow_ups (Type A / Type B). Every badge is written out, never colour alone, and reuses the
   shared Badge so it follows the light and dark themes. */

const STATUS_TONE = {
  Upcoming: "info",
  Confirmed: "success",
  Tentative: "warning",
  "Pending Confirmation": "warning",
  "Contact Needed": "danger",
  Completed: "success",
  "No Follow-up Required": "neutral",
};

const COMMUNICATION_TONE = {
  "Reminder Pending": "neutral",
  "Message Sent": "info",
  "Call Completed": "info",
  "Client Responded": "success",
  "No Response": "danger",
  "Client Will Inform": "warning",
};

const CONFIRMATION_TONE = { "Not Requested": "neutral", "Awaiting Client": "warning", Confirmed: "success", Declined: "danger" };

// Type A = next therapy session, Type B = reception contact. Different tone and different words.
export function FollowUpTypeBadge({ type, long = false }) {
  const meta = FOLLOW_UP_TYPE_META[type] || { short: type, label: "", description: "", tone: "neutral" };
  return (
    <Badge tone={meta.tone} title={meta.description}>
      {meta.label || type}
      {long && meta.description ? <span className="sr-only">: {meta.description}</span> : null}
    </Badge>
  );
}

// Pass the row to apply the display rules ("Confirmed" instead of "Upcoming"), or a plain status.
export function FollowUpStatusBadge({ status, row = null }) {
  const label = row ? displayStatus(row) : status;
  return <Badge tone={STATUS_TONE[label] || "neutral"}>{label}</Badge>;
}

export function RescheduleBadge({ row }) {
  if (!wantsReschedule(row)) return null;
  return <Badge tone="warning">Wants to reschedule</Badge>;
}

// Status + due state + reschedule flag, as shown in lists.
export function FollowUpStatusCell({ row }) {
  // An Upcoming follow-up that is overdue or due today shows only that due state; other statuses keep both.
  const dueOnly = row.status === "Upcoming" && (row.due_state === "Overdue" || row.due_state === "Due Today");
  return (
    <span className="reminder-cell">
      {dueOnly ? null : <FollowUpStatusBadge row={row} />}
      <DueStateBadge dueState={row.due_state} />
      <RescheduleBadge row={row} />
    </span>
  );
}

// Due Today / Overdue come from due_state (clinic time). Later and No Date need no badge.
export function DueStateBadge({ dueState }) {
  if (dueState === "Overdue") return <Badge tone="danger">Overdue</Badge>;
  if (dueState === "Due Today") return <Badge tone="warning">Due Today</Badge>;
  return null;
}

// The due date with the existing overdue / today highlight.
export function DueDate({ row }) {
  if (!row.due_date) return <span className="muted">No date</span>;
  const tone = row.due_state === "Overdue" ? "overdue" : row.due_state === "Due Today" ? "today" : "";
  return <span className={`due ${tone}`}>{formatDate(row.due_date)}</span>;
}

export function CommunicationBadge({ status }) {
  if (!status) return <span className="muted">—</span>;
  return <Badge tone={COMMUNICATION_TONE[status] || "neutral"}>{communicationLabel(status)}</Badge>;
}

export function ConfirmationBadge({ status }) {
  if (!status) return <span className="muted">—</span>;
  return <Badge tone={CONFIRMATION_TONE[status] || "neutral"}>{confirmationLabel(status)}</Badge>;
}
