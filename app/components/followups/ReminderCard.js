"use client";

import { DeliveryBadge, ResponseBadge } from "../ui/StatusBadges";
import { DELIVERY_NEXT, canRecordResponse, isReminderDue } from "../../lib/remindersApi";
import { formatDateTime } from "../../lib/leads";

/* One reminder slot. Delivery and client response are two separate records, and reminder 1 and 2 are tracked
   independently: this card never reads or changes the other reminder. */
export default function ReminderCard({ number, reminder, canManage, now = new Date(), onRecord }) {
  if (!reminder) {
    return (
      <section className="reminder-card is-empty" aria-label={`Reminder ${number}`}>
        <header className="reminder-head">
          <strong>Reminder {number}</strong>
        </header>
        <p className="muted">Created automatically when the follow-up is booked.</p>
      </section>
    );
  }

  const due = isReminderDue(reminder, now);
  const canDeliver = canManage && (DELIVERY_NEXT[reminder.delivery_status] || []).length > 0;
  const canRespond = canManage && canRecordResponse(reminder);

  return (
    <section className={`reminder-card ${due ? "is-due" : ""}`} aria-label={`Reminder ${number}`}>
      <header className="reminder-head">
        <strong>Reminder {number}</strong>
        <span className={due ? "reminder-due" : "muted"}>
          {due ? "Due now · " : "Due "}
          {formatDateTime(reminder.due_at)}
        </span>
      </header>

      <dl className="reminder-rows">
        <div>
          <dt>Delivery</dt>
          <dd>
            <DeliveryBadge status={reminder.delivery_status} />
            <small className="muted">
              {reminder.delivered_at
                ? `Delivered ${formatDateTime(reminder.delivered_at)}`
                : reminder.sent_at
                  ? `Sent ${formatDateTime(reminder.sent_at)}`
                  : reminder.failed_at
                    ? `Failed ${formatDateTime(reminder.failed_at)}`
                    : reminder.cancelled_at
                      ? `Cancelled ${formatDateTime(reminder.cancelled_at)}`
                      : "Not sent yet"}
              {reminder.delivery_updated_by_name ? ` · ${reminder.delivery_updated_by_name}` : ""}
            </small>
            {reminder.failure_reason ? <small className="muted">Reason: {reminder.failure_reason}</small> : null}
          </dd>
        </div>
        <div>
          <dt>Client response</dt>
          <dd>
            <ResponseBadge response={reminder.client_response} />
            {reminder.responded_at ? (
              <small className="muted">
                {formatDateTime(reminder.responded_at)}
                {reminder.response_recorded_by_name ? ` · ${reminder.response_recorded_by_name}` : ""}
              </small>
            ) : null}
            {reminder.response_note ? <small className="reminder-note">“{reminder.response_note}”</small> : null}
          </dd>
        </div>
      </dl>

      {(canDeliver || canRespond) && (
        <div className="reminder-actions">
          {canDeliver && (
            <button type="button" className="appt-btn" onClick={() => onRecord(reminder, "delivery")}>
              Record delivery
            </button>
          )}
          {canRespond && (
            <button type="button" className="appt-btn" onClick={() => onRecord(reminder, "response")}>
              {reminder.client_response ? "Change response" : "Record response"}
            </button>
          )}
        </div>
      )}
    </section>
  );
}
