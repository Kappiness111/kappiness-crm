/* Date helpers, appointment display metadata and time-grid layout for the psychologist calendar. */

export const HOUR_HEIGHT = 48; // px per hour in the week and day grids
export const DEFAULT_START_HOUR = 7;
export const DEFAULT_END_HOUR = 20;

/* ----- dates (all local time, weeks start on Monday) ----- */

export function startOfDay(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

export function addDays(date, count) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + count);
}

export function startOfWeek(date) {
  return addDays(startOfDay(date), -((date.getDay() + 6) % 7));
}

export function addMonthsClamped(date, count) {
  const target = new Date(date.getFullYear(), date.getMonth() + count, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  return new Date(target.getFullYear(), target.getMonth(), Math.min(date.getDate(), lastDay));
}

export function isSameDay(a, b) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

export function dateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Monday = 1 ... Sunday = 7, the convention used by psychologist_availability.day_of_week
export function isoWeekday(date) {
  return ((date.getDay() + 6) % 7) + 1;
}

export function weekDays(anchor) {
  const first = startOfWeek(anchor);
  return Array.from({ length: 7 }, (_, index) => addDays(first, index));
}

// Whole weeks covering the month of `anchor`, Monday first.
export function monthGrid(anchor) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const daysInMonth = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0).getDate();
  const offset = (first.getDay() + 6) % 7;
  const weekCount = Math.ceil((offset + daysInMonth) / 7);
  const start = startOfWeek(first);
  return Array.from({ length: weekCount }, (_, week) =>
    Array.from({ length: 7 }, (_, day) => addDays(start, week * 7 + day))
  );
}

// [start, end) of what the given view shows.
export function getVisibleRange(view, anchor) {
  if (view === "day") {
    const start = startOfDay(anchor);
    return { start, end: addDays(start, 1) };
  }
  if (view === "month") {
    const weeks = monthGrid(anchor);
    return { start: weeks[0][0], end: addDays(weeks[weeks.length - 1][6], 1) };
  }
  const start = startOfWeek(anchor);
  return { start, end: addDays(start, 7) };
}

/* ----- formatting ----- */

export function formatClock(date) {
  return date
    .toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true })
    .replace(/\s?(am|pm)/i, (match) => ` ${match.trim().toUpperCase()}`);
}

export function formatHourLabel(hour) {
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 === 0 ? 12 : hour % 12;
  return `${hour12} ${suffix}`;
}

export function formatLongDate(date) {
  return date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
}

export function formatRangeTitle(view, anchor) {
  if (view === "day") return formatLongDate(anchor);
  if (view === "month") return anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
  const days = weekDays(anchor);
  const first = days[0];
  const last = days[6];
  const sameMonth = first.getMonth() === last.getMonth();
  const left = first.toLocaleDateString("en-GB", sameMonth ? { day: "numeric" } : { day: "numeric", month: "short" });
  const right = last.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  return `${left} – ${right}`;
}

/* ----- appointment display metadata ----- */

export const TYPE_META = {
  regular: { label: "Session" },
  follow_up: { label: "Follow-up" },
};

export const STATUS_META = {
  scheduled: { label: "Scheduled" },
  confirmed: { label: "Confirmed" },
  rescheduled: { label: "Rescheduled" },
  completed: { label: "Completed" },
  cancelled: { label: "Cancelled" },
  missed: { label: "Missed" },
};

// Statuses that still count as something to attend.
export const OPEN_STATUSES = ["scheduled", "confirmed"];

export function appointmentsOnDay(appointments, day) {
  return appointments
    .filter((item) => isSameDay(item.start, day))
    .sort((a, b) => a.start - b.start);
}

/* ----- time grid ----- */

function minutesOfDay(date) {
  return date.getHours() * 60 + date.getMinutes();
}

// Hours shown in the grid: the default working window, widened to include anything outside it.
export function gridHours(appointments, periods) {
  let first = DEFAULT_START_HOUR;
  let last = DEFAULT_END_HOUR;

  appointments.forEach((item) => {
    first = Math.min(first, item.start.getHours());
    last = Math.max(last, item.end.getHours() + (item.end.getMinutes() > 0 ? 1 : 0));
  });
  periods.forEach((period) => {
    if (!period.is_active) return;
    const [startHour] = String(period.start_time).split(":").map(Number);
    const [endHour, endMinute] = String(period.end_time).split(":").map(Number);
    if (!Number.isNaN(startHour)) first = Math.min(first, startHour);
    if (!Number.isNaN(endHour)) last = Math.max(last, endHour + (endMinute > 0 ? 1 : 0));
  });

  first = Math.max(0, first);
  last = Math.min(24, Math.max(last, first + 1));
  return { first, last, hours: Array.from({ length: last - first }, (_, index) => first + index) };
}

// Positions one day's appointments. Overlapping appointments share the width of the column.
export function layoutDay(appointments, firstHour) {
  const sorted = [...appointments].sort((a, b) => a.start - b.start || a.end - b.end);
  const placed = [];
  let cluster = [];
  let clusterEnd = -1;

  function flush() {
    if (cluster.length === 0) return;
    const columnEnds = [];
    cluster.forEach((entry) => {
      let column = columnEnds.findIndex((end) => end <= entry.startMin);
      if (column === -1) {
        column = columnEnds.length;
        columnEnds.push(entry.endMin);
      } else {
        columnEnds[column] = entry.endMin;
      }
      entry.column = column;
    });
    cluster.forEach((entry) => {
      entry.columns = columnEnds.length;
      placed.push(entry);
    });
    cluster = [];
    clusterEnd = -1;
  }

  sorted.forEach((appointment) => {
    const startMin = minutesOfDay(appointment.start);
    const endMin = Math.max(startMin + 15, minutesOfDay(appointment.end));
    if (cluster.length > 0 && startMin >= clusterEnd) flush();
    cluster.push({
      appointment,
      startMin,
      endMin,
      top: ((startMin - firstHour * 60) / 60) * HOUR_HEIGHT,
      height: Math.max(((endMin - startMin) / 60) * HOUR_HEIGHT, 26),
    });
    clusterEnd = Math.max(clusterEnd, endMin);
  });
  flush();

  return placed;
}

// Recurring availability bands for one weekday, positioned on the same grid.
export function availabilityBands(periods, day, firstHour) {
  const weekday = isoWeekday(day);
  return periods
    .filter((period) => period.is_active && Number(period.day_of_week) === weekday)
    .map((period) => {
      const [startHour, startMinute] = String(period.start_time).split(":").map(Number);
      const [endHour, endMinute] = String(period.end_time).split(":").map(Number);
      const startMin = startHour * 60 + startMinute;
      const endMin = endHour * 60 + endMinute;
      return {
        id: period.id,
        top: ((startMin - firstHour * 60) / 60) * HOUR_HEIGHT,
        height: ((endMin - startMin) / 60) * HOUR_HEIGHT,
      };
    })
    .filter((band) => band.height > 0);
}