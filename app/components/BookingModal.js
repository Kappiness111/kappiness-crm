"use client";

import { useMemo, useState } from "react";
import Field, { fieldProps } from "./Field";
import Icon from "./Icon";
import ModalShell from "./ModalShell";
import MonthGrid from "./MonthGrid";
import { NOTES_LIMIT, formatDateTime } from "../lib/leads";
import { dayHasFreeSlot, periodsFor, slotsForDay } from "../lib/appointmentSlots";
import { formatClock, isoWeekday, startOfDay } from "../lib/calendar";

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
  preset = null, // { psychologistId, serviceId, day, slotStart } when opened from a schedule slot
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
    if (preset && canUse(preset.psychologistId)) return String(preset.psychologistId);
    const primary = (lockedClient || {}).primary_psychologist_id;
    if (canUse(primary)) return String(primary);
    return psychologists.length === 1 ? String(psychologists[0].id) : "";
  });
  const [serviceId, setServiceId] = useState(() => {
    if (reschedule && appointment.service_id) return String(appointment.service_id);
    if (preset && preset.serviceId && services.some((item) => String(item.id) === String(preset.serviceId))) return String(preset.serviceId);
    const interest = client && client.service_interest;
    const match = interest && services.find((item) => item.name === interest);
    if (match) return String(match.id);
    return services.length === 1 ? String(services[0].id) : "";
  });
  const [anchor, setAnchor] = useState(() => {
    let base = today;
    if (reschedule) base = new Date(appointment.starts_at);
    else if (recommendation) base = new Date(`${recommendation.recommended_date}T00:00`);
    else if (preset && preset.day) base = preset.day;
    return new Date(base.getFullYear(), base.getMonth(), 1);
  });
  const [day, setDay] = useState(() => (preset && preset.day ? startOfDay(preset.day) : null));
  const [slotStart, setSlotStart] = useState(() => (preset && preset.slotStart ? new Date(preset.slotStart).toISOString() : null)); // ISO string
  const [clientQuery, setClientQuery] = useState("");
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

  // A date can be opened when it is today or later and the psychologist works that weekday, even if every time is
  // taken or has passed: the slot list then says why, instead of the date silently being greyed out.
  function getMeta(date) {
    const before = date.getTime() < today.getTime();
    const works = periods.some((period) => Number(period.day_of_week) === isoWeekday(date));
    const free = !before && ready ? dayHasFreeSlot(periods, date, appointments, slotOptions) : false;
    return { available: free, disabled: before || !ready || !works };
  }

  // Why the chosen day has no bookable time (only used when none is free).
  function noSlotReason() {
    if (slots.length === 0) {
      return `The working hours on this day are too short for a ${durationMinutes}-minute session.`;
    }
    if (slots.every((slot) => slot.past)) return "All of today's times have passed. Please choose another date.";
    if (slots.every((slot) => slot.blocked || slot.past)) return "The psychologist is unavailable (blocked) for the rest of this day.";
    if (slots.every((slot) => slot.taken || slot.past || slot.blocked)) return "Every time on this day is already booked.";
    return "";
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

  // Review of what will be saved, shown once a time is picked.
  const chosenSlot = slotStart ? slots.find((slot) => slot.start.toISOString() === slotStart) : null;
  const psychologistName = (psychologists.find((item) => String(item.id) === psychologistId) || {}).name || "";
  const clientName = client ? client.full_name : appointment ? appointment.client_name : "";
  const when = (start, end) =>
    `${start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, ${formatClock(start)} – ${formatClock(end)}`;

  const title = reschedule ? "Reschedule appointment" : recommendation ? "Book recommended follow-up" : "Book appointment";

  return (
    <ModalShell labelledBy="booking-title" onRequestClose={saving ? () => {} : onClose} size="lg">
      <header className="modal-head">
        <div>
          <h2 id="booking-title">{title}</h2>
          <p>
            {reschedule
              ? "The original appointment is kept as Rescheduled and a new one is booked."
              : "Choose a client, a psychologist, a service and a free time. New bookings wait for the client's confirmation."}
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
                <>
                {clients.length > 8 && (
                  <input
                    type="search"
                    className="client-search"
                    placeholder="Search clients by name or phone"
                    aria-label="Search clients"
                    value={clientQuery}
                    onChange={(event) => setClientQuery(event.target.value)}
                  />
                )}
                <select {...fieldProps("booking-client", visible("client"))} value={clientId} onChange={(event) => setClientId(event.target.value)}>
                  <option value="">{clients.length ? "Select a client" : "No clients yet: confirm a lead first"}</option>
                  {clients
                    .filter((item) => {
                      const term = clientQuery.trim().toLowerCase();
                      if (!term || String(item.id) === clientId) return true;
                      return (item.full_name || "").toLowerCase().includes(term) || (item.phone || "").replace(/s+/g, "").includes(term.replace(/s+/g, ""));
                    })
                    .map((item) => (
                    <option key={item.id} value={item.id}>
                      {item.full_name}
                      {item.phone ? ` · ${item.phone}` : ""}
                    </option>
                  ))}
                </select>
                </>
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
                    setSlotStart(null); // keep the chosen date; times depend on the service length
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
              {day && !slots.some((slot) => slot.free) && (
                <p className="subtle-text" role="status">
                  {noSlotReason()}
                </p>
              )}

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

          {chosenSlot && (
            <div className="booking-review" role="status" aria-live="polite">
              <strong>{reschedule ? "Please check the new time" : "Please check before booking"}</strong>
              <dl>
                <dt>Client</dt>
                <dd>{clientName || "—"}</dd>
                <dt>Psychologist</dt>
                <dd>{psychologistName || "—"}</dd>
                {!reschedule && service ? (
                  <>
                    <dt>Service</dt>
                    <dd>
                      {service.name} ({service.duration_minutes} min)
                    </dd>
                  </>
                ) : null}
                {reschedule ? (
                  <>
                    <dt>Current time</dt>
                    <dd>
                      <s>{when(new Date(appointment.starts_at), new Date(appointment.ends_at))}</s> <span className="muted">(will be freed)</span>
                    </dd>
                  </>
                ) : null}
                <dt>{reschedule ? "New time" : "Time"}</dt>
                <dd>
                  <strong>{when(chosenSlot.start, chosenSlot.end)}</strong>
                </dd>
              </dl>
              <small className="muted">
                {reschedule
                  ? "The original appointment is kept in the history as Rescheduled."
                  : "The appointment starts as awaiting client confirmation."}{" "}
                The time is checked again when you save.
              </small>
            </div>
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
