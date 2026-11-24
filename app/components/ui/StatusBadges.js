"use client";

import { FOLLOW_UP_STATES } from "../../lib/followUpSessions";
import { APPOINTMENT_STATUS_LABEL } from "../../lib/statusLabels";
import { STATUS_TONE as LEAD_TONE } from "../StatusBadge";

/* The status badge set for the whole CRM: lead, appointment, follow-up and communication (reminder delivery and
   client response) statuses. Each status is written out (never colour alone) and uses the .badge + tone-* tokens,
   so they follow the light and dark themes. Anything late gets the overdue treatment: the danger tone plus a solid
   edge and a clock icon, so it stands out even in a long list or for colour-blind users. */

const TONE_CLASS = { info: "tone-info", success: "tone-success", warning: "tone-warning", danger: "tone-danger", neutral: "" };

export function Badge({ tone = "neutral", children, title, overdue = false }) {
  return (
    <span className={`badge ${overdue ? "tone-danger is-overdue" : TONE_CLASS[tone] || ""}`} title={title}>
      {overdue ? (
        <svg className="badge-clock" viewBox="0 0 12 12" aria-hidden="true">
          <circle cx="6" cy="6" r="4.75" />
          <path d="M6 3.4V6l1.8 1.1" />
        </svg>
      ) : (
        <span className="badge-dot" aria-hidden="true" />
      )}
      {children}
    </span>
  );
}

// "2 days overdue" style label; the overdue look comes from Badge.
export function OverdueBadge({ children = "Overdue", title }) {
  return (
    <Badge overdue title={title}>
      {children}
    </Badge>
  );
}

export function LeadStatusBadge({ status }) {
  return <Badge tone={LEAD_TONE[status] || "neutral"}>{status}</Badge>;
}

const APPOINTMENT_TONE = { Scheduled: "warning", Confirmed: "success", Completed: "neutral", Missed: "danger", Cancelled: "neutral", Rescheduled: "info" };

export function AppointmentStatusBadge({ status }) {
  return <Badge tone={APPOINTMENT_TONE[status] || "neutral"}>{APPOINTMENT_STATUS_LABEL[status] || status}</Badge>;
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
  return (
    <Badge tone={meta.tone} overdue={state === "overdue"}>
      {meta.label}
    </Badge>
  );
}

/* Communication status of one reminder: what happened to the message, then how the client answered.
   A pending reminder past its due time is shown as overdue. */
export function CommunicationBadge({ delivery, response, due = null, now = null }) {
  if (response) return <ResponseBadge response={response} />;
  const late = delivery === "Pending" && due && now && new Date(due).getTime() < now.getTime();
  if (late) return <OverdueBadge title="This reminder is past its send time">Reminder overdue</OverdueBadge>;
  return <DeliveryBadge status={delivery} />;
}

export function SessionStatusBadge({ status }) {
  return <Badge tone={SESSION_TONE[status] || "neutral"}>{SESSION_LABEL[status] || status}</Badge>;
}
