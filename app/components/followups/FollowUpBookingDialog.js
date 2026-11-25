"use client";

import { useEffect, useMemo, useState } from "react";
import Dialog from "../Dialog";
import { Badge } from "../ui/StatusBadges";
import styles from "./followups.module.css";
import { confirmAppointment, describeAppointmentError } from "../../lib/appointmentsApi";
import {
  confirmFollowUpSlot,
  describeFollowUpError,
  listSlotStatus,
  proposeFollowUpSlot,
  releaseFollowUpSlot,
} from "../../lib/followUpsApi";
import { formatDate, formatTime } from "../../lib/leads";
import { listPsychologists } from "../../lib/psychologistsApi";
import { listServices } from "../../lib/schedulingApi";

const SLOT_TONE = { Available: "success", Tentative: "warning", Booked: "info", Confirmed: "neutral" };
const HELD = ["Tentative", "Pending Confirmation"];

function dayLabel(slotDate) {
  const date = new Date(`${slotDate}T12:00`);
  return {
    weekday: date.toLocaleDateString("en-GB", { weekday: "short" }),
    day: date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" }),
  };
}

/* Book the next session of a Type A follow-up (staff only; the database checks again).
   1. Choose psychologist, service and a slot from follow_up_slot_status (Available / Tentative / Booked /
      Confirmed, plus the follow-up slots left that day).
   2. Hold it: "Hold as Tentative", or "Mark Pending Confirmation" once the client has been asked.
   3. The client answers: "Client confirmed" books the appointment (confirm_follow_up_slot); "Client declined"
      releases the hold with a note. The follow-up stays held until the client confirms.
   onChanged(savedFollowUp, { confirmed }) after every change. */
export default function FollowUpBookingDialog({ followUp, psychologistNames = {}, notify, onClose, onChanged }) {
  const [options, setOptions] = useState({ status: "loading", psychologists: [], services: [], message: "" });
  const [psychologistId, setPsychologistId] = useState(followUp.psychologist_id || "");
  const [serviceId, setServiceId] = useState(followUp.proposed_service_id || "");
  const [slots, setSlots] = useState({ key: "", rows: [], error: "" });
  const [day, setDay] = useState(null); // slot_date chosen by the user; default: the held day, else the first open day
  const [picked, setPicked] = useState(null); // slot_start ISO
  const [current, setCurrent] = useState(followUp); // the follow-up as last saved here
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [declining, setDeclining] = useState(false);
  const [declineNote, setDeclineNote] = useState("");
  const [booked, setBooked] = useState(null); // saved follow-up after the client confirmed
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    Promise.all([listPsychologists(), listServices({ activeOnly: true })])
      .then(([psychologists, services]) => {
        if (cancelled) return;
        setOptions({ status: "ready", psychologists: psychologists.filter((item) => item.active), services, message: "" });
        setServiceId((value) => value || (services[0] && services[0].id) || "");
      })
      .catch((err) => {
        if (!cancelled) setOptions({ status: "error", psychologists: [], services: [], message: describeFollowUpError(err, "Could not load psychologists and services.") });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const slotsKey = `${psychologistId}|${reload}`;
  useEffect(() => {
    if (!psychologistId) return undefined;
    let cancelled = false;
    listSlotStatus({ psychologistId })
      .then((rows) => {
        if (!cancelled) setSlots({ key: slotsKey, rows, error: "" });
      })
      .catch((err) => {
        if (!cancelled) setSlots({ key: slotsKey, rows: [], error: describeFollowUpError(err, "Could not load the free slots.") });
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, slotsKey]);

  const loadingSlots = Boolean(psychologistId) && slots.key !== slotsKey;
  const days = useMemo(() => {
    const map = new Map();
    slots.rows.forEach((row) => {
      if (!map.has(row.slot_date)) {
        map.set(row.slot_date, { date: row.slot_date, remaining: row.day_remaining_slots, used: row.day_follow_up_slots_used, capacity: row.day_follow_up_capacity, limited: row.max_follow_up_slots_per_day !== null, slots: [] });
      }
      map.get(row.slot_date).slots.push(row);
    });
    return [...map.values()];
  }, [slots.rows]);

  const isHeld = HELD.includes(current.status) && Boolean(current.proposed_starts_at);
  const heldDate = isHeld ? days.find((item) => item.slots.some((slot) => slot.held_by_follow_up_id === current.id)) : null;
  const firstOpen = days.find((item) => item.remaining > 0);
  const activeDay = days.find((item) => item.date === day) || heldDate || firstOpen || days[0] || null;
  const service = options.services.find((item) => item.id === serviceId) || null;

  const ownSlot = (slot) => slot.held_by_follow_up_id === current.id;
  const selectable = (slot, dayInfo) => ownSlot(slot) || (slot.slot_state === "Available" && dayInfo.remaining > 0);
  const pickedSlot = picked && activeDay ? activeDay.slots.find((slot) => slot.slot_start === picked) || null : null;

  async function run(label, action, success) {
    if (busy) return;
    setBusy(label);
    setError("");
    try {
      const saved = await action();
      setCurrent((value) => ({ ...value, ...saved }));
      notify(success(saved));
      onChanged(saved, { confirmed: label === "confirm" });
      setPicked(null);
      setReload((value) => value + 1);
      return saved;
    } catch (err) {
      setError(describeFollowUpError(err, "Could not save. Please try again."));
      return null;
    } finally {
      setBusy("");
    }
  }

  function hold(status) {
    // A new slot when one is picked; otherwise keep the current hold and only change its status.
    const startsAt = pickedSlot ? pickedSlot.slot_start : isHeld ? current.proposed_starts_at : null;
    if (!startsAt) return setError("Choose a slot first.");
    if (!serviceId) return setError("Choose a service.");
    return run(
      status,
      () => proposeFollowUpSlot(current.id, { startsAt, serviceId, psychologistId, status }),
      (saved) =>
        status === "Tentative"
          ? `Held as Tentative: ${formatDate(saved.proposed_starts_at)}, ${formatTime(saved.proposed_starts_at)}`
          : `Pending Confirmation: waiting for the client to confirm ${formatDate(saved.proposed_starts_at)}, ${formatTime(saved.proposed_starts_at)}`
    );
  }

  async function clientConfirmed() {
    const saved = await run("confirm", () => confirmFollowUpSlot(current.id), (row) => `Booked for ${formatDate(row.proposed_starts_at)}, ${formatTime(row.proposed_starts_at)}`);
    if (saved) setBooked(saved);
  }

  async function clientDeclined() {
    if (!declineNote.trim()) return setError("Add a short note about the client's answer.");
    const saved = await run("decline", () => releaseFollowUpSlot(current.id, { declined: true, note: declineNote }), () => "The held time was released. The follow-up is back to Upcoming.");
    if (saved) {
      setDeclining(false);
      setDeclineNote("");
    }
  }

  async function confirmBookedAppointment() {
    if (!booked || !booked.appointment_id || busy) return;
    setBusy("appointment");
    setError("");
    try {
      await confirmAppointment(booked.appointment_id);
      notify("Client confirmation recorded on the appointment.");
      onChanged(booked, { confirmed: true });
      onClose();
    } catch (err) {
      setError(describeAppointmentError(err, "Could not record the confirmation."));
    } finally {
      setBusy("");
    }
  }

  // After the client confirmed: the appointment exists but is still "awaiting confirmation" until recorded.
  if (booked) {
    return (
      <Dialog
        titleId="fu-book-title"
        title="Next session booked"
        subtitle={followUp.client_name}
        onClose={onClose}
        busy={Boolean(busy)}
        small
        footer={
          <>
            <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>
              Done
            </button>
            {booked.appointment_id && (
              <button type="button" className="btn btn-primary" onClick={confirmBookedAppointment} disabled={Boolean(busy)}>
                {busy === "appointment" ? "Saving…" : "Record client confirmation"}
              </button>
            )}
          </>
        }
      >
        <div className="modal-body">
          <p style={{ marginTop: 0 }}>
            <strong>
              {formatDate(booked.proposed_starts_at)}, {formatTime(booked.proposed_starts_at)}
            </strong>{" "}
            with {psychologistNames[booked.psychologist_id] || "the psychologist"}.
          </p>
          <p className="subtle-text">
            The appointment shows as awaiting confirmation until the client&apos;s confirmation is recorded. If the client has already
            confirmed this exact time, record it now.
          </p>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      titleId="fu-book-title"
      title="Book follow-up"
      subtitle={`${followUp.client_name || "Client"} · next session`}
      onClose={onClose}
      busy={Boolean(busy)}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>
            Close
          </button>
          <button type="button" className="btn" onClick={() => hold("Tentative")} disabled={Boolean(busy) || (!pickedSlot && !isHeld)}>
            {busy === "Tentative" ? "Saving…" : "Hold as Tentative"}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => hold("Pending Confirmation")} disabled={Boolean(busy) || (!pickedSlot && !isHeld)}>
            {busy === "Pending Confirmation" ? "Saving…" : "Mark Pending Confirmation"}
          </button>
        </>
      }
    >
      <div className="modal-body" style={{ display: "grid", gap: 14 }}>
        {isHeld && (
          <div className="notice" role="status">
            <div style={{ width: "100%" }}>
              <strong>
                Held: {formatDate(current.proposed_starts_at)}, {formatTime(current.proposed_starts_at)} · {current.status}
              </strong>
              The time stays held until the client answers.
              <div className="followup-actions" style={{ marginTop: 8 }}>
                <button type="button" className="btn btn-primary btn-sm" onClick={clientConfirmed} disabled={Boolean(busy)}>
                  {busy === "confirm" ? "Booking…" : "Client confirmed"}
                </button>
                <button type="button" className="btn btn-sm" onClick={() => setDeclining((value) => !value)} disabled={Boolean(busy)} aria-expanded={declining}>
                  Client declined
                </button>
              </div>
              {declining && (
                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor="fu-decline-note">Note</label>
                  <input id="fu-decline-note" type="text" maxLength={500} value={declineNote} onChange={(event) => setDeclineNote(event.target.value)} placeholder="For example: prefers next month" />
                  <div className="followup-actions" style={{ marginTop: 6 }}>
                    <button type="button" className="btn btn-sm btn-danger" onClick={clientDeclined} disabled={Boolean(busy)}>
                      {busy === "decline" ? "Releasing…" : "Release the held time"}
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {options.status === "error" && <p className="field-error">{options.message}</p>}

        <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))" }}>
          <div className="field">
            <label htmlFor="fu-book-psy">Psychologist</label>
            <select
              id="fu-book-psy"
              value={psychologistId}
              onChange={(event) => {
                setPsychologistId(event.target.value);
                setDay(null);
                setPicked(null);
              }}
              disabled={options.status !== "ready"}
            >
              {!options.psychologists.some((item) => item.id === psychologistId) && psychologistId && (
                <option value={psychologistId}>{psychologistNames[psychologistId] || "Current psychologist"}</option>
              )}
              {options.psychologists.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="fu-book-service">Service</label>
            <select id="fu-book-service" value={serviceId} onChange={(event) => setServiceId(event.target.value)} disabled={options.status !== "ready"}>
              {options.services.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name} ({item.duration_minutes} min)
                </option>
              ))}
            </select>
          </div>
        </div>

        {slots.error && <p className="field-error">{slots.error}</p>}
        {loadingSlots && <p className="subtle-text">Loading free slots…</p>}
        {!loadingSlots && !slots.error && days.length === 0 && (
          <p className="subtle-text">No working hours in the next four weeks for this psychologist. Choose another psychologist.</p>
        )}

        {!loadingSlots && days.length > 0 && activeDay && (
          <>
            <div className={styles.dayRow} role="group" aria-label="Day">
              {days.map((item) => {
                const label = dayLabel(item.date);
                return (
                  <button
                    key={item.date}
                    type="button"
                    className={`${styles.dayBtn} ${item.remaining === 0 ? styles.dayFull : ""}`}
                    aria-pressed={item.date === activeDay.date}
                    onClick={() => {
                      setDay(item.date);
                      setPicked(null);
                    }}
                  >
                    <span>{label.weekday}</span>
                    <strong>{label.day}</strong>
                    <small>{item.remaining === 0 ? "Full" : `${item.remaining} left`}</small>
                  </button>
                );
              })}
            </div>

            <p className="subtle-text" style={{ margin: 0 }}>
              {formatDate(activeDay.date)}: {activeDay.remaining} follow-up slot{activeDay.remaining === 1 ? "" : "s"} left
              {activeDay.limited ? ` (daily limit ${activeDay.capacity}, ${activeDay.used} used)` : ""}.
              {service && Number(service.duration_minutes) !== 50 ? ` Times are shown in standard 50-minute steps; a ${service.duration_minutes}-minute session is checked when you save.` : ""}
            </p>

            <div className={styles.slotGrid} role="group" aria-label="Time">
              {activeDay.slots.map((slot) => {
                const own = ownSlot(slot);
                const canPick = selectable(slot, activeDay);
                const label = own ? "Held for this client" : slot.slot_state;
                return (
                  <button
                    key={slot.slot_start}
                    type="button"
                    className={styles.slotBtn}
                    aria-pressed={picked === slot.slot_start}
                    disabled={!canPick || Boolean(busy)}
                    onClick={() => setPicked(slot.slot_start)}
                    title={!canPick && slot.slot_state === "Available" ? "No follow-up slots left that day" : undefined}
                  >
                    <strong>{formatTime(slot.slot_start)}</strong>
                    <Badge tone={own ? "warning" : SLOT_TONE[slot.slot_state] || "neutral"}>{label}</Badge>
                  </button>
                );
              })}
            </div>
          </>
        )}

        {pickedSlot && (
          <p style={{ margin: 0 }}>
            Selected: <strong>{formatDate(pickedSlot.slot_start)}, {formatTime(pickedSlot.slot_start)}</strong>
            {isHeld ? " (moves the current hold)" : ""}
          </p>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
}
