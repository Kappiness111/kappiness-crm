"use client";

import { useEffect, useState } from "react";
import Icon from "../Icon";
import ModalShell from "../ModalShell";
import { StatusPill } from "../AppointmentTable";
import ReminderCard from "./ReminderCard";
import { Badge, FollowUpStateBadge } from "../ui/StatusBadges";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { listReminderEvents } from "../../lib/remindersApi";
import { appointmentStatusLabel } from "../../lib/statusLabels";

/* Everything about one follow-up session: the recommendation, the current booking and its actions, earlier
   bookings (released slots), and the two reminders with their history. */
export default function FollowUpDrawer({
  row,
  names,
  viewer,
  showReminders,
  now,
  workflow,
  onRecordReminder,
  onCloseRecommendation,
  onEditRecommendation,
  onOpenClient,
  onClose,
  reloadKey,
}) {
  const rec = row.recommendation;
  const current = row.current;
  const [events, setEvents] = useState({ key: "", rows: [], error: "" });
  const eventsKey = `${current ? current.id : ""}|${reloadKey}`;

  useEffect(() => {
    if (!showReminders || !current) return undefined;
    let cancelled = false;
    listReminderEvents([current.id])
      .then((rows) => {
        if (!cancelled) setEvents({ key: eventsKey, rows, error: "" });
      })
      .catch(() => {
        if (!cancelled) setEvents({ key: eventsKey, rows: [], error: "Could not load the reminder history." });
      });
    return () => {
      cancelled = true;
    };
  }, [showReminders, current, eventsKey]);

  const actions = current ? workflow.actionsFor(current) : [];
  const ownId = viewer.ownPsychologist ? String(viewer.ownPsychologist.id) : null;
  const canBook = rec.status === "Open" && !current && (viewer.isStaff || ownId === String(rec.psychologist_id));
  const canClose = viewer.isStaff && (rec.status === "Open" || rec.status === "Scheduled");
  const canEdit = rec.status === "Open" && ownId === String(rec.psychologist_id);

  return (
    <ModalShell variant="drawer" size="md" labelledBy="followup-title" onRequestClose={onClose}>
      <header className="modal-head">
        <div>
          <p style={{ margin: 0 }}>Follow-up session</p>
          <h2 id="followup-title">{row.clientName}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
          <Icon name="close" />
        </button>
      </header>

      <div className="modal-body followup-body">
        {row.rescheduleRequested && (
          <div className="notice warn" role="status">
            <Icon name="alert" />
            <div>
              <strong>The client wants to reschedule</strong>
              Pick a new slot. The current booking is released once the new one is saved.
              {actions.includes("reschedule") && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={() => workflow.openReschedule(current)}>
                    Choose a new slot
                  </button>
                </div>
              )}
            </div>
          </div>
        )}

        <section className="info-section">
          <h4>Recommendation</h4>
          <dl className="kv">
            <dt>Status</dt>
            <dd>
              <FollowUpStateBadge state={row.state} />
            </dd>
            <dt>Recommended for</dt>
            <dd>
              {formatDate(rec.recommended_date)}
              {rec.recommended_time ? `, ${String(rec.recommended_time).slice(0, 5)}` : ""}
              {rec.priority !== "Normal" ? (
                <>
                  {" "}
                  <Badge tone="warning">{rec.priority}</Badge>
                </>
              ) : null}
            </dd>
            <dt>Psychologist</dt>
            <dd>{names[rec.psychologist_id] || "—"}</dd>
            <dt>Client</dt>
            <dd>
              {row.clientName}
              {row.clientPhone ? <span className="muted"> · {row.clientPhone}</span> : null}
            </dd>
            <dt>Details</dt>
            <dd className="wrap">{rec.recommendation}</dd>
            {rec.outcome ? (
              <>
                <dt>Outcome</dt>
                <dd className="wrap">{rec.outcome}</dd>
              </>
            ) : null}
          </dl>
        </section>

        <section className="info-section">
          <h4>Scheduled session</h4>
          {current ? (
            <div className="followup-slot">
              <div>
                <strong>
                  {formatDate(current.starts_at)}, {formatTime(current.starts_at)}–{formatTime(current.ends_at)}
                </strong>
                <span className="muted">
                  {current.service_type} · {names[current.psychologist_id] || "Psychologist"}
                </span>
              </div>
              <StatusPill status={current.status} label={appointmentStatusLabel(current.status)} />
            </div>
          ) : (
            <p className="subtle-text">Not scheduled yet. This follow-up becomes an appointment once a date and time are booked.</p>
          )}

          {row.previous.length > 0 && (
            <ul className="released-list" aria-label="Earlier bookings">
              {row.previous.map((item) => (
                <li key={item.id}>
                  <s>
                    {formatDate(item.starts_at)}, {formatTime(item.starts_at)}–{formatTime(item.ends_at)}
                  </s>
                  <span className="muted">
                    {item.status === "Rescheduled" ? "Rescheduled · slot released" : `${item.status} · slot released`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          <div className="followup-actions">
            {canBook && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() =>
                  workflow.openBooking(
                    { id: rec.client_id, full_name: row.clientName, lead_id: row.leadId, primary_psychologist_id: rec.psychologist_id },
                    rec
                  )
                }
              >
                <Icon name="calendar" /> Schedule follow-up
              </button>
            )}
            {actions.includes("confirm") && (
              <button type="button" className="btn btn-sm" disabled={workflow.busyId === current.id} onClick={() => workflow.runAction(current, "confirm")}>
                Record client confirmation
              </button>
            )}
            {actions.includes("reschedule") && !row.rescheduleRequested && (
              <button type="button" className="btn btn-sm" onClick={() => workflow.openReschedule(current)}>
                Reschedule
              </button>
            )}
            {actions.includes("attended") && (
              <button type="button" className="btn btn-primary btn-sm" disabled={workflow.busyId === current.id} onClick={() => workflow.runAction(current, "attended")}>
                <Icon name="check" /> Mark as completed
              </button>
            )}
            {actions.includes("missed") && (
              <button type="button" className="btn btn-sm" disabled={workflow.busyId === current.id} onClick={() => workflow.runAction(current, "missed")}>
                Mark as missed
              </button>
            )}
            {actions.includes("cancel") && (
              <button type="button" className="btn btn-sm btn-danger" onClick={() => workflow.runAction(current, "cancel")}>
                Cancel appointment
              </button>
            )}
          </div>
        </section>

        <section className="info-section">
          <h4>Reminders</h4>
          {!showReminders ? (
            <p className="subtle-text">Reminders are tracked by clinic staff.</p>
          ) : !current ? (
            <p className="subtle-text">Two reminders are created when the follow-up is booked.</p>
          ) : (
            <>
              <div className="reminder-pair">
                <ReminderCard number={1} reminder={row.reminder1} canManage={viewer.isStaff} now={now} onRecord={onRecordReminder} />
                <ReminderCard number={2} reminder={row.reminder2} canManage={viewer.isStaff} now={now} onRecord={onRecordReminder} />
              </div>
              {events.key === eventsKey && events.rows.length > 0 && (
                <details className="reminder-history">
                  <summary>Reminder history ({events.rows.length})</summary>
                  <ol className="status-trail">
                    {events.rows.map((event) => {
                      const number = event.reminder_id === (row.reminder1 && row.reminder1.id) ? 1 : 2;
                      return (
                        <li key={event.id}>
                          <strong>
                            Reminder {number}: {event.event_type}
                          </strong>
                          {event.to_value ? ` → ${event.to_value}` : ""} · {formatDateTime(event.changed_at)}
                          {event.changed_by_name ? ` · ${event.changed_by_name}` : ""}
                          {event.note ? <span className="muted"> · {event.note}</span> : null}
                        </li>
                      );
                    })}
                  </ol>
                </details>
              )}
              {events.error && <p className="field-error">{events.error}</p>}
            </>
          )}
        </section>
      </div>

      <footer className="modal-foot">
        {onOpenClient && (
          <button type="button" className="btn" onClick={() => onOpenClient(rec.client_id)}>
            View client profile
          </button>
        )}
        {canEdit && (
          <button type="button" className="btn" onClick={() => onEditRecommendation(rec)}>
            Edit recommendation
          </button>
        )}
        {canClose && (
          <button type="button" className="btn" onClick={() => onCloseRecommendation(rec)}>
            Close follow-up…
          </button>
        )}
      </footer>
    </ModalShell>
  );
}
