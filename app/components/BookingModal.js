"use client";

import { useMemo, useState } from "react";
import Field, { fieldProps } from "./Field";
import Icon from "./Icon";
import ModalShell from "./ModalShell";
import MonthGrid from "./MonthGrid";
import { NOTES_LIMIT, formatDateTime } from "../lib/leads";
import { dayHasFreeSlot, periodsFor, slotsForDay } from "../lib/appointmentSlots";
import { formatClock, startOfDay } from "../lib/calendar";

/* Book a new appointment or reschedule an existing one.
   - Booking needs an existing client, a psychologist, a service and a free slot.
   - Slots come from the psychologist's weekly periods (several per day, breaks respected), the service's
     duration and buffer, existing active bookings and blocked periods.
   - Rescheduling keeps the original record (it becomes Rescheduled) and books a new Scheduled appointment.
   The database checks every rule again when saving. */
export default function BookingModal({
  mode = "book", // "book" | "reschedule"
  clients = [], // clients this user may book for
  lockedClient = null, // booking for a known client: the client is fixed
  appointment = null, // the appointment being rescheduled
  recommendation = null, // booking from a follow-up recommendation
  psychologists = [], // psychologists this user may schedule for
  services = [], // active services
  availability = [],
  blocks = [],
  appointments = [],
  now,
  onClose,
  onSubmit,
}) {
  const reschedule = mode === "reschedule" && appointment;
  const today = startOfDay(now || new Date());

  const [clientId, setClientId] = useState(() => {
    if (lockedClient) return String(lockedClient.id);
    if (reschedule) return String(appointment.client_id);
    if (recommendation) return String(recommendation.client_id);
    return "";
  });
  const client = lockedClient || clients.find((item) => String(item.id) === clientId) || null;

  const [psychologistId, setPsychologistId] = useState(() => {
    const canUse = (id) => id && psychologists.some((item) => String(item.id) === String(id));
    if (reschedule && canUse(appointment.psychologist_id)) return String(appointment.psychologist_id);
    if (recommendation && canUse(recommendation.psychologist_id)) return String(recommendation.psychologist_id);
    const primary = (lockedClient || {}).primary_psychologist_id;
    if (canUse(primary)) return String(primary);
    return psychologists.length === 1 ? String(psychologists[0].id) : "";
  });
  const [serviceId, setServiceId] = useState(() => {
    if (reschedule && appointment.service_id) return String(appointment.service_id);
    const interest = client && client.service_interest;
    const match = interest && services.find((item) => item.name === interest);
    if (match) return String(match.id);
    return services.length === 1 ? String(services[0].id) : "";
  });
  const [anchor, setAnchor] = useState(() => {
    let base = today;
    if (reschedule) base = new Date(appointment.starts_at);
    else if (recommendation) base = new Date(`${recommendation.recommended_date}T00:00`);
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [day, setDay] = useState(null);
  const [slotStart, setSlotStart] = useState(null); // ISO string
  const [notes, setNotes] = useState(reschedule ? appointment.notes || "" : "");
  const [reason, setReason] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  // Rescheduling keeps the original length and buffer; booking uses the chosen service.
  const service = services.find((item) => String(item.id) === serviceId) || null;
  const durationMinutes = reschedule
    ? Math.round((new Date(appointment.ends_at) - new Date(appointment.starts_at)) / 60000)
    : service
      ? service.duration_minutes
      : 0;
  const bufferMinutes = reschedule ? appointment.buffer_minutes || 0 : service ? service.buffer_minutes : 0;

  const periods = useMemo(() => (psychologistId ? periodsFor(availability, psychologistId) : []), [availability, psychologistId]);
  const slotOptions = {
    psychologistId,
    ignoreId: reschedule ? appointment.id : null,
    now: now || new Date(),
    durationMinutes,
    bufferMinutes,
    blocks,
  };
  const ready = Boolean(psychologistId && durationMinutes);
  const slots = day && ready ? slotsForDay(periods, day, appointments, slotOptions) : [];

  const errors = {};
  if (!clientId) errors.client = "Choose a client.";
  if (!psychologistId) errors.psychologist = "Choose a psychologist.";
  if (!reschedule && !serviceId) errors.service = "Choose a service.";
  if (!slotStart) errors.slot = "Pick a date and a time slot.";
  if (notes.length > NOTES_LIMIT) errors.notes = `Keep notes under ${NOTES_LIMIT} characters.`;
  const visible = (field) => (submitted ? errors[field] : undefined);

  function getMeta(date) {
    const before = date.getTime() < today.getTime();
    const free = !before && ready ? dayHasFreeSlot(periods, date, appointments, slotOptions) : false;
    return { available: free, disabled: !free };
  }

  function resetSlot() {
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
      client_id: clientId,
      lead_id: client ? client.lead_id : null,
      psychologist_id: psychologistId,
      service_id: serviceId || null,
      starts_at: chosen.start.toISOString(),
      notes: notes.trim(),
      reason: reason.trim(),
      recommendation_id: recommendation ? recommendation.id : null,
    });
    setSaving(false);

    if (!result || !result.ok) {
      setError((result && result.message) || "Could not save the appointment. Please try again.");
      return;
    }
    onClose();
  }

  const title = reschedule ? "Reschedule appointment" : recommendation ? "Book recommended follow-up" : "Book appointment";

  return (
    <ModalShell labelledBy="booking-title" onRequestClose={saving ? () => {} : onClose} size="lg">
      <header className="modal-head">
        <div>
          <h2 id="booking-title">{title}</h2>
          <p>
            {reschedule
              ? "The original appointment is kept as Rescheduled and a new one is booked."
              : "Choose a client, a psychologist, a service and a free slot. New bookings start as Scheduled."}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close" disabled={saving}>
          <Icon name="close" />
        </button>
      </header>

      <form noValidate onSubmit={submit}>
        <div className="modal-body">
          {reschedule && (
            <p className="subtle-text">
              Currently booked for <strong>{formatDateTime(appointment.starts_at)}</strong>
              {appointment.service_type ? ` (${appointment.service_type}, ${durationMinutes} min)` : ""}. Pick a new date and slot.
            </p>
          )}
          {recommendation && (
            <div className="notice" role="status">
              <Icon name="info" />
              <div>
                <strong>
                  Recommended for {new Date(`${recommendation.recommended_date}T00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}
                  {recommendation.recommended_time ? ` at ${String(recommendation.recommended_time).slice(0, 5)}` : ""}
                </strong>
                {recommendation.recommendation}
              </div>
            </div>
          )}

          <div className="field-grid">
            <Field id="booking-client" label="Client" required error={visible("client")}>
              {lockedClient || reschedule || recommendation ? (
                <input id="booking-client" value={client ? client.full_name : appointment ? appointment.client_name : ""} readOnly />
              ) : (
                <select {...fieldProps("booking-client", visible("client"))} value={clientId} onChange={(event) => setClientId(event.target.value)}>
                  <option value="">{clients.length ? "Select a client" : "No clients yet: confirm a lead first"}</option>
                  {clients.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.full_name}
                      {item.phone ? ` · ${item.phone}` : ""}
                    </option>
                  ))}
                </select>
              )}
            </Field>

            <Field id="booking-psychologist" label="Psychologist" required error={visible("psychologist")}>
              <select
                {...fieldProps("booking-psychologist", visible("psychologist"))}
                value={psychologistId}
                disabled={psychologists.length <= 1}
                onChange={(event) => {
                  setPsychologistId(event.target.value);
                  resetSlot();
                }}
              >
                <option value="">{psychologists.length ? "Select a psychologist" : "No psychologists available"}</option>
                {psychologists.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </Field>

            {!reschedule && (
              <Field id="booking-service" label="Service" required error={visible("service")}>
                <select
                  {...fieldProps("booking-service", visible("service"))}
                  value={serviceId}
                  onChange={(event) => {
                    setServiceId(event.target.value);
                    resetSlot();
                  }}
                >
                  <option value="">{services.length ? "Select a service" : "No active services configured"}</option>
                  {services.map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.name} · {item.duration_minutes} min{item.buffer_minutes ? ` + ${item.buffer_minutes} min buffer` : ""}
                    </option>
                  ))}
                </select>
              </Field>
            )}
          </div>

          {psychologistId && periods.length === 0 && (
            <p className="subtle-text" role="status">
              This psychologist has no active weekly availability yet, so there are no slots to offer.
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
              <h4>{day ? day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" }) : "Available slots"}</h4>

              {!ready && <p className="subtle-text">Choose a psychologist{reschedule ? "" : " and a service"} to see available dates.</p>}
              {ready && !day && <p className="subtle-text">Pick a highlighted date to see its time slots.</p>}
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
                      title={slot.taken ? "Already booked" : slot.blocked ? "Blocked" : slot.past ? "In the past" : `${formatClock(slot.start)} – ${formatClock(slot.end)}`}
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

          {reschedule ? (
            <Field id="booking-reason" label="Reason (optional)">
              <input id="booking-reason" value={reason} maxLength={200} onChange={(event) => setReason(event.target.value)} />
            </Field>
          ) : (
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
              <textarea {...fieldProps("booking-notes", visible("notes"), "notes")} rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} />
            </Field>
          )}

          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="modal-foot">
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
