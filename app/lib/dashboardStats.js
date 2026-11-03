/* Date-range bucketing for the dashboard charts. Everything is computed from the records passed in;
   nothing here invents data. */

export const RANGE_OPTIONS = [
  { id: "30d", label: "30 days", short: "30D", unit: "day", count: 30 },
  { id: "90d", label: "90 days", short: "90D", unit: "week", count: 13 },
  { id: "6m", label: "6 months", short: "6M", unit: "month", count: 6 },
  { id: "12m", label: "12 months", short: "12M", unit: "month", count: 12 },
];
export const DEFAULT_RANGE = "90d";

const DAY = 86400000;

function dayStart(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function addDays(date, days) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

const dayLabel = (date) => date.toLocaleDateString("en-GB", { day: "numeric", month: "short" });

/* Returns consecutive buckets that end with the one containing `now`, plus the overall window
   [start, end) and the equally long window just before it (for period-over-period deltas). */
export function buildBuckets(rangeId, now) {
  const option = RANGE_OPTIONS.find((item) => item.id === rangeId) || RANGE_OPTIONS[1];
  const today = dayStart(now);
  const buckets = [];

  for (let i = 0; i < option.count; i += 1) {
    const back = option.count - 1 - i;
    let start;
    let end;
    let label;
    let full;

    if (option.unit === "day") {
      start = addDays(today, -back);
      end = addDays(start, 1);
      label = dayLabel(start);
      full = start.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
    } else if (option.unit === "week") {
      // Seven-day blocks ending today, so the last bucket is always "the past week".
      start = addDays(today, -6 - back * 7);
      end = addDays(start, 7);
      label = dayLabel(start);
      full = `${dayLabel(start)} – ${dayLabel(addDays(end, -1))}`;
    } else {
      start = new Date(today.getFullYear(), today.getMonth() - back, 1);
      end = new Date(today.getFullYear(), today.getMonth() - back + 1, 1);
      label = start.toLocaleDateString("en-GB", { month: "short" });
      full = start.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
    }

    buckets.push({ key: start.toISOString(), start, end, label, full });
  }

  const start = buckets[0].start;
  const end = buckets[buckets.length - 1].end;
  const span = end.getTime() - start.getTime();
  return {
    option,
    buckets,
    start,
    end,
    previousStart: new Date(start.getTime() - span),
    days: Math.round(span / DAY),
  };
}

// Index of the bucket that contains `date`, or -1.
export function bucketIndexOf(buckets, date) {
  if (!date) return -1;
  const time = date.getTime();
  for (let i = 0; i < buckets.length; i += 1) {
    if (time >= buckets[i].start.getTime() && time < buckets[i].end.getTime()) return i;
  }
  return -1;
}

export function percent(part, whole) {
  return whole > 0 ? Math.round((part / whole) * 100) : null;
}
