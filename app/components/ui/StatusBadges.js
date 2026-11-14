"use client";

import { FOLLOW_UP_STATES } from "../../lib/followUpSessions";

/* Status badges shared by the scheduling screens. Each status is written out (never colour alone) and uses the
   existing .badge + tone-* tokens, so they follow the light and dark themes. */

const TONE_CLASS = { info: "tone-info", success: "tone-success", warning: "tone-warning", danger: "tone-danger", neutral: "" };

export function Badge({ tone = "neutral", children, title }) {
  return (
    <span className={`badge ${TONE_CLASS[tone] || ""}`} title={title}>
      <span className="badge-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const DELIVERY_TONE = { Pending: "neutral", Sent: "info", Delivered: "success", Failed: "danger", Cancelled: "neutral" };
const RESPONSE_TONE = { Confirmed: "success", "Wants to Reschedule": "warning", "No Response": "danger" };
const SESSION_LABEL = { Completed: "Attended / Completed" };
const SESSION_TONE = { Scheduled: "info", Completed: "success", Cancelled: "neutral", Missed: "danger" };

export function DeliveryBadge({ status }) {
  return <Badge tone={DELIVERY_TONE[status] || "neutral"}>{status}</Badge>;
}

// No response recorded yet is shown as "Awaiting response", distinct from the "No Response" outcome.
export function ResponseBadge({ response }) {
  if (!response) return <span className="muted response-empty">Awaiting response</span>;
  return <Badge tone={RESPONSE_TONE[response] || "neutral"}>{response}</Badge>;
}

export function FollowUpStateBadge({ state }) {
  const meta = FOLLOW_UP_STATES[state] || { label: state, tone: "neutral" };
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

export function SessionStatusBadge({ status }) {
  return <Badge tone={SESSION_TONE[status] || "neutral"}>{SESSION_LABEL[status] || status}</Badge>;
}
