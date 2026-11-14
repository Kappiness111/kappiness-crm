/* Psychologist Schedule & Capacity: turns real records into the "10 numbered slots per practitioner" view.

   SOURCE OF TRUTH (nothing here is stored or invented)
     appointments                        bookings (status, time, client, notes)
     psychologist_availability           weekly working hours (several periods per day)
     psychologist_availability_exceptions blocked periods = leave (full day or part of a day)
     services                            session length + buffer used to cut working hours into time slots

   HOW SLOTS ARE NUMBERED (the database has no slot number)
     For one practitioner and one date, the bookable time slots are the working hours cut into session-length
     pieces (the same rule the booking screen and the database use). Booked appointments and the remaining time
     slots are put in time order and numbered S1, S2, ... The card always shows at least 10 positions (the
     spreadsheet layout); positions beyond the practitioner's working hours are shown as "Not working".

   CAPACITY (kept separate from the 10-position layout, see the report)
     capacity  = time slots inside working hours, not blocked by leave
     booked    = appointments occupying the day: Scheduled, Confirmed, Completed, Missed
                 (Cancelled and Rescheduled-away bookings release their time and are not counted)
     available = free time slots that have not started yet
     Utilisation = booked / capacity. */

import { periodsFor, slotsForDay } from "./appointmentSlots";
import { isoWeekday } from "./calendar";

export const SLOT_POSITIONS = 10;
export const OCCUPYING = ["Scheduled", "Confirmed", "Completed", "Missed"];

// Spreadsheet wording for CRM appointment statuses ("Will Inform" = booked, the client has not confirmed yet).
export const SLOT_STATUS = {
  Confirmed: { label: "Confirmed", tone: "confirmed" },
  Scheduled: { label: "Will inform", tone: "willinform", hint: "Booked, waiting for the client to confirm" },
  Rescheduled: { label: "Rescheduled", tone: "rescheduled" },
  Cancelled: { label: "Cancelled", tone: "cancelled" },
  Completed: { label: "Completed", tone: "completed" },
  Missed: { label: "Missed", tone: "missed" },
};

// Quick labels used in the clinic spreadsheet. Their meaning is not defined here; they are kept as note text.
export const NOTE_LABELS = ["F", "F1", "F3", "F10+", "N", "Child", "Couple", "Online"];

function dayBounds(date) {
  const start = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  return { start, end: new Date(start.getFullYear(), start.getMonth(), start.getDate() + 1) };
}

// 12-hour clinic style: "11 AM", "7:30 PM".
function clock(date) {
  return date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(":00", "");
}

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function hoursLabel(dayPeriods) {
  if (!dayPeriods.length) return "";
  const starts = dayPeriods.map((p) => toMinutes(p.start_time));
  const ends = dayPeriods.map((p) => toMinutes(p.end_time));
  const fmt = (m) => clock(new Date(2000, 0, 1, Math.floor(m / 60), m % 60));
  return `${fmt(Math.min(...starts))} – ${fmt(Math.max(...ends))}`;
}

/* One practitioner on one date.
   options: { slotMinutes, bufferMinutes, now } */
export function practitionerDay(psychologist, date, { availability, appointments, blocks, slotMinutes, bufferMinutes, now }) {
  const { start, end } = dayBounds(date);
  const periods = periodsFor(availability, psychologist.id);
  const dayPeriods = periods.filter((p) => Number(p.day_of_week) === isoWeekday(date));
  const ownBlocks = blocks.filter(
    (b) => String(b.psychologist_id) === String(psychologist.id) && new Date(b.starts_at) < end && new Date(b.ends_at) > start
  );
  const dayAppointments = appointments.filter(
    (a) => String(a.psychologist_id) === String(psychologist.id) && new Date(a.starts_at) >= start && new Date(a.starts_at) < end
  );
  const occupying = dayAppointments.filter((a) => OCCUPYING.includes(a.status)).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  // Time slots inside working hours (taken / blocked / past flags come from the shared slot rule).
  const timeSlots = slotsForDay(periods, date, occupying, {
    psychologistId: psychologist.id,
    durationMinutes: slotMinutes,
    bufferMinutes,
    blocks: ownBlocks,
    now,
  });
  const capacitySlots = timeSlots.filter((slot) => !slot.blocked);
  const fullDayLeave = ownBlocks.length > 0 && (timeSlots.length > 0 ? timeSlots.every((slot) => slot.blocked) : ownBlocks.some((b) => new Date(b.starts_at) <= start && new Date(b.ends_at) >= end));

  // Positions: every booking, plus every time slot no booking overlaps, in time order.
  const entries = occupying.map((appointment) => ({
    kind: "booked",
    start: new Date(appointment.starts_at),
    end: new Date(appointment.ends_at),
    appointment,
  }));
  timeSlots.forEach((slot) => {
    const overlapped = occupying.some((a) => new Date(a.starts_at) < slot.end && new Date(a.ends_at) > slot.start);
    if (overlapped) return;
    const block = slot.blocked ? ownBlocks.find((b) => new Date(b.starts_at) < slot.end && new Date(b.ends_at) > slot.start) : null;
    entries.push({
      kind: slot.blocked ? "leave" : slot.past ? "passed" : "free",
      start: slot.start,
      end: slot.end,
      block,
    });
  });
  entries.sort((a, b) => a.start - b.start);
  while (entries.length < SLOT_POSITIONS) entries.push({ kind: "off" });
  const slots = entries.map((entry, index) => ({ ...entry, number: index + 1, label: `S${index + 1}` }));

  const booked = occupying.length;
  const available = slots.filter((s) => s.kind === "free").length;
  return {
    psychologist,
    working: dayPeriods.length > 0,
    hours: hoursLabel(dayPeriods),
    onLeave: fullDayLeave,
    blocks: ownBlocks,
    slots,
    booked,
    capacity: capacitySlots.length,
    available,
    leaveSlots: slots.filter((s) => s.kind === "leave").length,
    dayAppointments,
  };
}

export function scheduleForDay(psychologists, date, data) {
  return psychologists.map((p) => practitionerDay(p, date, data));
}

// Totals for the summary cards. Every number is derived from the same practitioner days as the cards.
export function daySummary(days) {
  const sum = (fn) => days.reduce((total, d) => total + fn(d), 0);
  const all = days.flatMap((d) => d.dayAppointments);
  const booked = sum((d) => d.booked);
  const capacity = sum((d) => d.capacity);
  return {
    booked,
    capacity,
    available: sum((d) => d.available),
    utilisation: capacity ? Math.round((Math.min(booked, capacity) / capacity) * 100) : 0,
    confirmed: all.filter((a) => a.status === "Confirmed").length,
    willInform: all.filter((a) => a.status === "Scheduled").length,
    // Bookings on this date that were moved elsewhere (the replacement is counted where it now is).
    rescheduled: all.filter((a) => a.status === "Rescheduled").length,
    onLeave: days.filter((d) => d.onLeave).length,
    practitioners: days.length,
  };
}

// The slot number of each appointment on the day (for the roster), from the same numbering as the cards.
export function slotNumbers(days) {
  const map = {};
  days.forEach((d) => d.slots.forEach((s) => {
    if (s.appointment) map[s.appointment.id] = s.label;
  }));
  return map;
}

// Month overview: booked / capacity / available per date, from the same rules.
export function monthOverview(psychologists, monthAnchor, data) {
  const first = new Date(monthAnchor.getFullYear(), monthAnchor.getMonth(), 1);
  const days = [];
  for (let d = new Date(first); d.getMonth() === first.getMonth(); d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    const summary = daySummary(scheduleForDay(psychologists, d, data));
    days.push({ date: d, ...summary });
  }
  return days;
}

// "11:00–11:50 AM", or "11:30 AM–12:20 PM" when the period changes.
export function formatSlotTime(start, end) {
  const t = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const a = t(start);
  const b = t(end);
  const [aTime, aPeriod] = a.split(" ");
  const [, bPeriod] = b.split(" ");
  return aPeriod && aPeriod === bPeriod ? `${aTime}–${b}` : `${a}–${b}`;
}
