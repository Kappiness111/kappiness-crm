/* Builds bookable time slots from psychologist_availability (weekly recurring periods, several per day allowed)
   and removes anything already booked, blocked or in the past. The database checks the same rules again
   when the booking is saved (book_appointment / reschedule_appointment). */

import { isoWeekday, startOfDay } from "./calendar";

export const SLOT_MINUTES = 60; // fallback when no service is chosen
const ACTIVE = ["Scheduled", "Confirmed"];

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

// Active availability periods of one psychologist.
export function periodsFor(availability, psychologistId) {
  return availability.filter(
    (period) => period.is_active && String(period.psychologist_id) === String(psychologistId)
  );
}

// Time an existing booking holds: its own length plus its buffer.
function busyRange(item) {
  const start = new Date(item.starts_at).getTime();
  const end = item.ends_at ? new Date(item.ends_at).getTime() : start + SLOT_MINUTES * 60000;
  const held = item.blocked_until ? new Date(item.blocked_until).getTime() : end + (Number(item.buffer_minutes) || 0) * 60000;
  return [start, held];
}

/* Slots for one day. Each slot: { start, end, taken, blocked, past, free }.
   options:
     psychologistId   whose bookings count as busy
     ignoreId         appointment being rescheduled (its own slot counts as free)
     durationMinutes  length of the session (service duration)
     bufferMinutes    gap kept after each session
     blocks           blocked periods [{ psychologist_id, starts_at, ends_at }]
     now              slots before this are past */
export function slotsForDay(periods, day, appointments, options = {}) {
  const {
    psychologistId,
    ignoreId = null,
    now = new Date(),
    durationMinutes = SLOT_MINUTES,
    bufferMinutes = 0,
    blocks = [],
  } = options;
  const duration = Math.max(5, Number(durationMinutes) || SLOT_MINUTES);
  const buffer = Math.max(0, Number(bufferMinutes) || 0);
  const weekday = isoWeekday(day);
  const base = startOfDay(day);

  const busy = appointments
    .filter(
      (item) =>
        ACTIVE.includes(item.status) &&
        String(item.psychologist_id) === String(psychologistId) &&
        String(item.id) !== String(ignoreId)
    )
    .map(busyRange);

  const blocked = blocks
    .filter((item) => String(item.psychologist_id) === String(psychologistId))
    .map((item) => [new Date(item.starts_at).getTime(), new Date(item.ends_at).getTime()]);

  const seen = new Set();
  const slots = [];

  periods
    .filter((period) => Number(period.day_of_week) === weekday)
    .sort((a, b) => toMinutes(a.start_time) - toMinutes(b.start_time))
    .forEach((period) => {
      const first = toMinutes(period.start_time);
      const last = toMinutes(period.end_time);
      if (first === null || last === null) return;

      // Each period is filled from its own start, so breaks between periods are respected.
      for (let minute = first; minute + duration <= last; minute += duration + buffer) {
        if (seen.has(minute)) continue;
        seen.add(minute);
        const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minute);
        const end = new Date(start.getTime() + duration * 60000);
        const heldUntil = end.getTime() + buffer * 60000;
        const taken = busy.some(([busyStart, busyEnd]) => start.getTime() < busyEnd && heldUntil > busyStart);
        const isBlocked = blocked.some(([blockStart, blockEnd]) => start.getTime() < blockEnd && end.getTime() > blockStart);
        const past = start.getTime() <= now.getTime();
        slots.push({ start, end, taken, blocked: isBlocked, past, free: !taken && !isBlocked && !past });
      }
    });

  return slots.sort((a, b) => a.start - b.start);
}

export function dayHasFreeSlot(periods, day, appointments, options) {
  return slotsForDay(periods, day, appointments, options).some((slot) => slot.free);
}

// Overlap check for weekly periods on one day (used before saving availability).
export function findOverlappingPeriod(periods, candidate, ignoreId = null) {
  const start = toMinutes(candidate.start_time);
  const end = toMinutes(candidate.end_time);
  return periods.find(
    (period) =>
      period.is_active &&
      String(period.id) !== String(ignoreId) &&
      Number(period.day_of_week) === Number(candidate.day_of_week) &&
      toMinutes(period.start_time) < end &&
      start < toMinutes(period.end_time)
  );
}
