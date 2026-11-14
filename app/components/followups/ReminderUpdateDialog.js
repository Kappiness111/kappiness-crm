"use client";

import { useState } from "react";
import Dialog from "../Dialog";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { CLIENT_RESPONSES, DELIVERY_NEXT, recordReminderDelivery, recordReminderResponse } from "../../lib/remindersApi";

function localInputValue(date) {
  const d = new Date(date);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/* Record what happened to ONE reminder: its delivery, or the client's response to it.
   The other reminder is never touched. mode: "delivery" | "response". onSaved(updatedReminder). */
export default function ReminderUpdateDialog({ reminder, mode, clientName, onClose, onSaved }) {
  const options = mode === "delivery" ? DELIVERY_NEXT[reminder.delivery_status] || [] : CLIENT_RESPONSES;
  const [value, setValue] = useState(mode === "response" && reminder.client_response ? reminder.client_response : options[0] || "");
  const [when, setWhen] = useState(localInputValue(new Date()));
  const [note, setNote] = useState(mode === "response" ? reminder.response_note || "" : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const noteRequired = mode === "delivery" && value === "Cancelled";
  const noteLabel = mode === "response" ? "Note (optional)" : value === "Failed" ? "Failure reason (optional)" : value === "Cancelled" ? "Reason" : "Note (optional)";

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    const at = new Date(when);
    if (Number.isNaN(at.getTime())) return setError("Enter a valid date and time.");
    if (at.getTime() > Date.now() + 60000) return setError("The time cannot be in the future.");
    if (noteRequired && !note.trim()) return setError("Add a reason for cancelling this reminder.");
    setBusy(true);
    setError("");
    try {
      const saved =
        mode === "delivery"
          ? await recordReminderDelivery(reminder.id, { status: value, occurredAt: at, note })
          : await recordReminderResponse(reminder.id, { response: value, note, respondedAt: at });
      onSaved(saved, value);
    } catch (err) {
      setError(describeAppointmentError(err, "Could not save the reminder. Please try again."));
      setBusy(false);
    }
  }

  const title = mode === "delivery" ? `Reminder ${reminder.reminder_number}: delivery` : `Reminder ${reminder.reminder_number}: client response`;

  return (
    <Dialog
      titleId="reminder-dialog-title"
      title={title}
      subtitle={`${clientName}. Records what happened; nothing is sent from the CRM.`}
      onClose={onClose}
      busy={busy}
      small
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form="reminder-dialog-form" className="btn btn-primary" disabled={busy || options.length === 0}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="reminder-dialog-form" className="modal-body" onSubmit={save} noValidate>
        {options.length === 0 ? (
          <p className="subtle-text">This reminder is {reminder.delivery_status}, which is final.</p>
        ) : (
          <>
            <fieldset className="field">
              <legend className="field-label">{mode === "delivery" ? "Delivery status" : "Client response"}</legend>
              <div className="choice-row">
                {options.map((option) => (
                  <label key={option} className={`choice ${value === option ? "is-checked" : ""}`}>
                    <input type="radio" name="reminder-value" value={option} checked={value === option} onChange={() => setValue(option)} />
                    {option}
                  </label>
                ))}
              </div>
            </fieldset>
            <div className="field">
              <label htmlFor="reminder-when">{mode === "delivery" ? "When" : "Responded at"}</label>
              <input id="reminder-when" type="datetime-local" value={when} max={localInputValue(new Date())} onChange={(event) => setWhen(event.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="reminder-note">{noteLabel}</label>
              <textarea id="reminder-note" rows={2} maxLength={mode === "response" ? 1000 : 500} value={note} onChange={(event) => setNote(event.target.value)} />
            </div>
            {mode === "response" && value === "Wants to Reschedule" && (
              <p className="subtle-text">After saving you can pick a new slot. The current booking stays until it is rescheduled.</p>
            )}
          </>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
