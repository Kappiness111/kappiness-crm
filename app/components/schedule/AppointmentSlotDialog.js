"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import { SlotStatus } from "./PractitionerCard";
import { describeAppointmentError, updateAppointmentNotes } from "../../lib/appointmentsApi";
import { NOTE_LABELS, formatSlotTime } from "../../lib/scheduleCapacity";

/* Appointment details from the schedule. Notes (including the clinic's quick labels) are the editable detail;
   time, psychologist and status change only through the existing workflow (reschedule, confirm, attendance,
   cancel), so there is never a second copy of the appointment. */
export default function AppointmentSlotDialog({ appointment, slotLabel, psychologistName, canManage, workflow, onConfirm, onSaved, onOpenClient, onClose }) {
  const [notes, setNotes] = useState(appointment.notes || "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const actions = workflow.actionsFor(appointment);
  const notesChanged = notes.trim() !== (appointment.notes || "").trim();
  const start = new Date(appointment.starts_at);
  const end = new Date(appointment.ends_at);

  function addLabel(label) {
    const parts = notes.split(/[\s,]+/).filter(Boolean);
    if (parts.includes(label)) return;
    setNotes((current) => (current.trim() ? `${current.trim()} ${label}` : label));
  }

  async function saveNotes() {
    if (busy || !notesChanged) return;
    if (notes.length > 1000) return setError("Keep notes under 1000 characters.");
    setBusy(true);
    setError("");
    try {
      await updateAppointmentNotes(appointment.id, notes);
      onSaved("Appointment notes saved.");
    } catch (err) {
      setError(describeAppointmentError(err, "We couldn't save the notes. Please try again."));
      setBusy(false);
    }
  }

  const run = (action) => {
    onClose();
    workflow.runAction(appointment, action);
  };

  return (
    <Dialog
      titleId="slot-dialog-title"
      title={appointment.client_name}
      subtitle={`${slotLabel ? `${slotLabel} · ` : ""}${start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, ${formatSlotTime(start, end)}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          {onOpenClient && (
            <button type="button" className="btn" onClick={() => onOpenClient(appointment.client_id)}>
              View client
            </button>
          )}
          {canManage && (
            <button type="button" className="btn btn-primary" onClick={saveNotes} disabled={busy || !notesChanged}>
              {busy ? "Saving…" : "Save notes"}
            </button>
          )}
        </>
      }
    >
      <div className="modal-body">
        <dl className="kv">
          <dt>Status</dt>
          <dd>
            <SlotStatus appointment={appointment} />
          </dd>
          <dt>Psychologist</dt>
          <dd>{psychologistName || "—"}</dd>
          <dt>Service</dt>
          <dd>
            {appointment.service_type} ({Math.round((end - start) / 60000)} min)
          </dd>
          <dt>Phone</dt>
          <dd>{appointment.client_phone ? <a href={`tel:${appointment.client_phone.replace(/\s+/g, "")}`}>{appointment.client_phone}</a> : "Not recorded"}</dd>
          {appointment.booked_by ? (
            <>
              <dt>Booked by</dt>
              <dd>{appointment.booked_by}</dd>
            </>
          ) : null}
          {appointment.cancellation_reason ? (
            <>
              <dt>Cancellation reason</dt>
              <dd>{appointment.cancellation_reason}</dd>
            </>
          ) : null}
        </dl>

        <div className="field" style={{ marginTop: 14 }}>
          <label htmlFor="slot-notes">Notes and labels</label>
          <textarea id="slot-notes" rows={3} maxLength={1000} value={notes} onChange={(event) => setNotes(event.target.value)} disabled={!canManage} />
          {canManage && (
            <div className="label-chips" aria-label="Quick labels">
              {NOTE_LABELS.map((label) => (
                <button key={label} type="button" className="label-chip" onClick={() => addLabel(label)}>
                  + {label}
                </button>
              ))}
            </div>
          )}
          <p className="subtle-text">Quick labels from the clinic schedule are added as text, exactly as written.</p>
        </div>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        {actions.length > 0 && (
          <div className="slot-dialog-actions">
            <span className="field-label">Update this appointment</span>
            <div>
              {actions.includes("confirm") && (
                <button type="button" className="btn btn-sm" onClick={() => { onClose(); onConfirm(appointment); }}>
                  Record client confirmation
                </button>
              )}
              {actions.includes("attended") && (
                <button type="button" className="btn btn-sm" onClick={() => run("attended")}>
                  Mark as completed
                </button>
              )}
              {actions.includes("missed") && (
                <button type="button" className="btn btn-sm" onClick={() => run("missed")}>
                  Mark as missed
                </button>
              )}
              {actions.includes("reschedule") && (
                <button type="button" className="btn btn-sm" onClick={() => run("reschedule")}>
                  Reschedule
                </button>
              )}
              {actions.includes("cancel") && (
                <button type="button" className="btn btn-sm btn-danger" onClick={() => run("cancel")}>
                  Cancel appointment
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
