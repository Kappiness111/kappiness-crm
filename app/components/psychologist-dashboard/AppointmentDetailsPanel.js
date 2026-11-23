"use client";

import { useState } from "react";
import Icon from "../Icon";
import ModalShell from "../ModalShell";
import FollowUpRecommendationForm from "./FollowUpRecommendationForm";
import { OPEN_STATUSES, STATUS_META, TYPE_META, formatClock, formatLongDate } from "../../lib/calendar";

const STATUS_TONE = {
  confirmed: "tone-info",
  scheduled: "tone-info",
  completed: "tone-success",
  cancelled: "",
  rescheduled: "",
  missed: "tone-danger",
};

/* Side drawer for one appointment in the psychologist workspace.
   Attendance can be recorded once the start time has passed; a follow-up can be recommended after a completed
   session. The database enforces the same rules. */
export default function AppointmentDetailsPanel({ appointment, now = new Date(), busy, onClose, onStatus, onRecommend, onOpenClient, onReschedule }) {
  const [form, setForm] = useState(null); // null | "recommend" | "cancel"
  const [reason, setReason] = useState("");
  const [reasonError, setReasonError] = useState("");
  const isOpen = OPEN_STATUSES.includes(appointment.status);
  const started = appointment.start.getTime() <= now.getTime();
  const minutes = Math.round((appointment.end - appointment.start) / 60000);

  function submitCancel(event) {
    event.preventDefault();
    if (!reason.trim()) {
      setReasonError("Add a reason for the cancellation.");
      return;
    }
    onStatus(appointment, "cancelled", { reason: reason.trim() });
  }

  return (
    <ModalShell variant="drawer" size="sm" labelledBy="appt-title" onRequestClose={onClose}>
      <header className="modal-head">
        <div>
          <p style={{ margin: 0 }}>Appointment details</p>
          <h2 id="appt-title">{appointment.clientName}</h2>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close appointment details">
          <Icon name="close" />
        </button>
      </header>

      <div className="modal-body">
        <dl className="kv">
          <dt>Date</dt>
          <dd>{formatLongDate(appointment.start)}</dd>
          <dt>Time</dt>
          <dd className="num">
            {formatClock(appointment.start)} – {formatClock(appointment.end)} ({minutes} min)
          </dd>
          <dt>Session type</dt>
          <dd>{appointment.serviceType || "—"}</dd>
          <dt>Booking</dt>
          <dd>
            <span className={`badge ${appointment.type === "follow_up" ? "tone-warning" : ""}`}>{TYPE_META[appointment.type].label}</span>
          </dd>
          <dt>Status</dt>
          <dd>
            <span className={`badge ${STATUS_TONE[appointment.status] || ""}`}>
              <span className="badge-dot" aria-hidden="true" />
              {STATUS_META[appointment.status].label}
            </span>
          </dd>
          {appointment.notes ? (
            <>
              <dt>Notes from booking</dt>
              <dd>{appointment.notes}</dd>
            </>
          ) : null}
        </dl>

        {isOpen && !started && (
          <p className="subtle-text">Once the appointment has started, you can mark the session as completed or missed here.</p>
        )}

        {form === "recommend" && (
          <FollowUpRecommendationForm appointment={appointment} onSubmit={onRecommend} onCancel={() => setForm(null)} />
        )}

        {form === "cancel" && (
          <form className="lost-prompt" onSubmit={submitCancel} noValidate style={{ display: "flex", flexDirection: "column", gap: 10 }}>
            <strong>Cancel this appointment</strong>
            <p className="subtle-text" style={{ margin: 0 }}>
              The appointment stays in the client&apos;s history, and the time becomes free for other bookings.
            </p>
            <div className="field">
              <label htmlFor="cancel-reason">Reason for cancelling</label>
              <textarea id="cancel-reason" rows={2} value={reason} aria-invalid={Boolean(reasonError)} onChange={(event) => { setReason(event.target.value); setReasonError(""); }} />
              {reasonError ? <p className="field-error" role="alert">{reasonError}</p> : null}
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button type="submit" className="btn btn-danger" disabled={busy}>{busy ? "Cancelling…" : "Cancel appointment"}</button>
              <button type="button" className="btn" onClick={() => setForm(null)} disabled={busy}>Keep appointment</button>
            </div>
          </form>
        )}
      </div>

      <footer className="modal-foot">
        {onOpenClient && appointment.clientId && (
          <button type="button" className="btn" onClick={() => onOpenClient(appointment.clientId)}>
            View client profile
          </button>
        )}
        {appointment.status === "completed" && form === null && (
          <button type="button" className="btn" onClick={() => setForm("recommend")}>
            Recommend a follow-up
          </button>
        )}
        {isOpen && form === null && (
          <>
            {!started && onReschedule && (
              <button type="button" className="btn" disabled={busy} onClick={() => onReschedule(appointment)}>
                Reschedule appointment
              </button>
            )}
            <button type="button" className="btn" disabled={busy} onClick={() => setForm("cancel")}>
              Cancel appointment
            </button>
            {started && (
              <>
                <button type="button" className="btn" disabled={busy} onClick={() => onStatus(appointment, "missed")}>
                  Mark as missed
                </button>
                <button type="button" className="btn btn-primary" disabled={busy} onClick={() => onStatus(appointment, "completed")}>
                  <Icon name="check" /> Mark as completed
                </button>
              </>
            )}
          </>
        )}
      </footer>
    </ModalShell>
  );
}
