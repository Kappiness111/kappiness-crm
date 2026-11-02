"use client";

import { useMemo, useState } from "react";
import Field, { fieldProps } from "./Field";
import ModalShell from "./ModalShell";
import MonthGrid from "./MonthGrid";
import { NOTES_LIMIT, formatDateTime } from "../lib/leads";
import { dayHasFreeSlot, periodsFor, slotsForDay } from "../lib/appointmentSlots";
import { formatClock, startOfDay } from "../lib/calendar";

/* Book a new appointment or reschedule an existing one.
   The calendar only enables dates where the chosen psychologist has a free slot. */
export default function BookingModal({
  mode = "book", // "book" | "reschedule"
  leads = [], // confirmed leads that can be booked
  lockedLead = null, // booking from a lead: the lead is fixed
  appointment = null, // the appointment being rescheduled
  psychologists = [], // psychologists this user may schedule for
  availability = [],
  appointments = [],
  now,
  onClose,
  onSubmit,
}) {
  const reschedule = mode === "reschedule" && appointment;
  const today = startOfDay(now || new Date());

  const [leadId, setLeadId] = useState(lockedLead ? String(lockedLead.id) : reschedule ? String(appointment.lead_id) : "");
  const [psychologistId, setPsychologistId] = useState(() => {
    if (reschedule && psychologists.some((item) => String(item.id) === String(appointment.psychologist_id))) {
      return String(appointment.psychologist_id);
    }
    return psychologists.length === 1 ? String(psychologists[0].id) : "";
  });
  const [anchor, setAnchor] = useState(() => {
    const base = reschedule ? new Date(appointment.starts_at) : today;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [day, setDay] = useState(null);
  const [slotStart, setSlotStart] = useState(null); // ISO string
  const [notes, setNotes] = useState(reschedule ? appointment.notes || "" : "");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const periods = useMemo(() => (psychologistId ? periodsFor(availability, psychologistId) : []), [availability, psychologistId]);
  const slotOptions = { psychologistId, ignoreId: reschedule ? appointment.id : null, now: now || new Date() };
  const slots = day && psychologistId ? slotsForDay(periods, day, appointments, slotOptions) : [];

  const errors = {};
  if (!leadId) errors.lead = "Choose a lead.";
  if (!psychologistId) errors.psychologist = "Choose a psychologist.";
  if (!slotStart) errors.slot = "Pick a date and a time slot.";
  if (notes.length > NOTES_LIMIT) errors.notes = `Keep notes under ${NOTES_LIMIT} characters.`;
  const visible = (field) => (submitted ? errors[field] : undefined);

  function getMeta(date) {
    const before = date.getTime() < today.getTime();
    const free = !before && psychologistId ? dayHasFreeSlot(periods, date, appointments, slotOptions) : false;
    return { available: free, disabled: !free };
  }

  function changePsychologist(value) {
    setPsychologistId(value);
    setDay(null);
    setSlotStart(null);
  }

  async function submit(event) {
    event.preventDefault();
    if (saving) return;
    setSubmitted(true);
    if (Object.keys(errors).length > 0) return;

    const chosen = slots.find((slot) => slot.start.toISOString() === slotStart);
    if (!chosen || !chosen.free) {
      setError("That slot is no longer available. Please pick another one.");
      return;
    }

    setSaving(true);
    setError("");
    const result = await onSubmit({
      lead_id: leadId,
      psychologist_id: psychologistId,
      starts_at: chosen.start.toISOString(),
      ends_at: chosen.end.toISOString(),
      notes: notes.trim(),
    });
    setSaving(false);

    if (!result || !result.ok) {
      setError((result && result.message) || "Could not save the appointment. Please try again.");
      return;
    }
    onClose();
  }

  const title = reschedule ? "Reschedule appointment" : "Book appointment";
  const selectedLead = lockedLead || leads.find((item) => String(item.id) === leadId);

  return (
    <ModalShell labelledBy="booking-title" onRequestClose={saving ? () => {} : onClose} className="wide-modal booking-modal">
      <div className="modal-heading">
        <h2 id="booking-title">{title}</h2>
        <button type="button" className="modal-close" onClick={onClose} aria-label="Close" disabled={saving}>
          ×
        </button>
      </div>

      <form noValidate onSubmit={submit}>
        <div className="modal-body">
          {reschedule && (
            <p className="subtle-text">
              Currently booked for <strong>{formatDateTime(appointment.starts_at)}</strong>. Pick a new date and slot.
            </p>
          )}

          <div className="field-grid">
            <Field id="booking-lead" label="Lead" required error={visible("lead")}>
              {lockedLead || reschedule ? (
                <input id="booking-lead" value={selectedLead ? `${selectedLead.full_name} (${selectedLead.lead_code})` : ""} readOnly />
              ) : (
                <select
                  {...fieldProps("booking-lead", visible("lead"))}
                  value={leadId}
                  onChange={(event) => setLeadId(event.target.value)}
                >
                  <option value="">{leads.length ? "Select a confirmed lead" : "No confirmed leads to book"}</option>
                  {leads.map((lead) => (
                    <option key={lead.id} value={lead.id}>
                      {lead.full_name} ({lead.lead_code})
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field id="booking-psychologist" label="Psychologist" required error={visible("psychologist")}>
              <select
                {...fieldProps("booking-psychologist", visible("psychologist"))}
                value={psychologistId}
                onChange={(event) => changePsychologist(event.target.value)}
              >
                <option value="">{psychologists.length ? "Select a psychologist" : "No psychologists available"}</option>
                {psychologists.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          {psychologistId && periods.length === 0 && (
            <p className="subtle-text" role="status">
              This psychologist has no active availability yet. Add it under Psychologists to open slots.
            </p>
          )}

          <div className="booking-picker">
            <MonthGrid
              anchor={anchor}
              onAnchorChange={setAnchor}
              selected={day}
              today={today}
              getMeta={getMeta}
              onSelect={(date) => {
                setDay(date);
                setSlotStart(null);
              }}
            />

            <div className="slot-panel">
              <h4>
                {day
                  ? day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })
                  : "Available slots"}
              </h4>

              {!psychologistId && <p className="subtle-text">Choose a psychologist to see available dates.</p>}
              {psychologistId && !day && <p className="subtle-text">Pick a highlighted date to see its time slots.</p>}

              {day && slots.length === 0 && <p className="subtle-text">No slots on this day.</p>}

              <div className="slot-grid" role="radiogroup" aria-label="Time slots">
                {slots.map((slot) => {
                  const key = slot.start.toISOString();
                  return (
                    <button
                      type="button"
                      key={key}
                      role="radio"
                      aria-checked={slotStart === key}
                      className={`slot ${slotStart === key ? "active" : ""}`}
                      disabled={!slot.free}
                      title={slot.taken ? "Already booked" : slot.past ? "In the past" : undefined}
                      onClick={() => setSlotStart(key)}
                    >
                      {formatClock(slot.start)}
                    </button>
                  );
                })}
              </div>

              {visible("slot") && (
                <p className="field-error" role="alert">
                  {visible("slot")}
                </p>
              )}
            </div>
          </div>

          <Field
            id="booking-notes"
            label="Notes (optional)"
            error={visible("notes")}
            hint={
              <>
                Practical details only.
                <span className="char-count">
                  {notes.length}/{NOTES_LIMIT}
                </span>
              </>
            }
          >
            <textarea
              {...fieldProps("booking-notes", visible("notes"), "notes")}
              rows={2}
              value={notes}
              onChange={(event) => setNotes(event.target.value)}
            />
          </Field>

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-footer">
          <button type="button" className="secondary-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="submit" className="primary-button" disabled={saving}>
            {saving ? "Saving…" : reschedule ? "Reschedule" : "Book appointment"}
          </button>
        </div>
      </form>
    </ModalShell>
  );
}