/* Builds bookable time slots from psychologist_availability (weekly recurring periods)
   and removes anything already booked or in the past. */

import { isoWeekday, startOfDay } from "./calendar";

export const SLOT_MINUTES = 60;

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

// Slots for one day. `ignoreId` is the appointment being rescheduled, so its own slot counts as free.
// Each slot: { start, end, taken, past, free }.
export function slotsForDay(periods, day, appointments, { psychologistId, ignoreId = null, now = new Date() } = {}) {
  const weekday = isoWeekday(day);
  const base = startOfDay(day);

  const busy = appointments
    .filter(
      (item) =>
        item.status === "Scheduled" &&
        String(item.psychologist_id) === String(psychologistId) &&
        String(item.id) !== String(ignoreId)
    )
    .map((item) => {
      const start = new Date(item.starts_at).getTime();
      const end = item.ends_at ? new Date(item.ends_at).getTime() : start + SLOT_MINUTES * 60000;
      return [start, end];
    });

  const seen = new Set();
  const slots = [];

  periods
    .filter((period) => Number(period.day_of_week) === weekday)
    .forEach((period) => {
      const first = toMinutes(period.start_time);
      const last = toMinutes(period.end_time);
      if (first === null || last === null) return;

      for (let minute = first; minute + SLOT_MINUTES <= last; minute += SLOT_MINUTES) {
        if (seen.has(minute)) continue;
        seen.add(minute);
        const start = new Date(base.getFullYear(), base.getMonth(), base.getDate(), 0, minute);
        const end = new Date(start.getTime() + SLOT_MINUTES * 60000);
        const taken = busy.some(([busyStart, busyEnd]) => start.getTime() < busyEnd && end.getTime() > busyStart);
        const past = start.getTime() < now.getTime();
        slots.push({ start, end, taken, past, free: !taken && !past });
      }
    });

  return slots.sort((a, b) => a.start - b.start);
}

export function dayHasFreeSlot(periods, day, appointments, options) {
  return slotsForDay(periods, day, appointments, options).some((slot) => slot.free);
}