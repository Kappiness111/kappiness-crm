"use client";

import Icon from "../Icon";
import { OPEN_STATUSES, addDays, appointmentsOnDay, formatClock, startOfDay } from "../../lib/calendar";

function greeting(now) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/* Page heading and the three headline numbers. Numbers come only from real appointment data;
   when none is connected they show a dash and say so. */
export default function DashboardOverview({ name, now, appointments, supported, loading, onOpenCalendar }) {
  const today = startOfDay(now);
  const horizon = addDays(today, 30);

  const todays = appointmentsOnDay(appointments, today).filter((item) => item.status !== "cancelled");
  const nextToday = todays.find((item) => item.end > now && OPEN_STATUSES.includes(item.status));
  const upcoming = appointments.filter((item) => item.start > now && item.start < horizon && OPEN_STATUSES.includes(item.status));
  const followUps = upcoming.filter((item) => item.type === "follow_up");

  const ready = supported && !loading;
  const value = (count) => (ready ? count : "—");
  const offline = "Not connected yet";
  const firstName = (name || "").split(" ")[0];

  return (
    <>
      <header className="page-head">
        <div>
          <h1>
            {greeting(now)}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p>{now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} · Your sessions and availability</p>
        </div>
        {onOpenCalendar && (
          <div className="page-actions">
            <button type="button" className="btn" onClick={onOpenCalendar}>
              <Icon name="calendar" /> Open calendar
            </button>
          </div>
        )}
      </header>

      <section className="kpis" aria-label="Overview">
        <div className="kpi">
          <span className="kpi-label">Today&apos;s sessions</span>
          <span className="kpi-value">{value(todays.length)}</span>
          <span className="kpi-meta">
            {!supported
              ? offline
              : loading
                ? "Loading…"
                : nextToday
                  ? `Next at ${formatClock(nextToday.start)}`
                  : todays.length
                    ? "No more sessions today"
                    : "Nothing scheduled today"}
          </span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Upcoming appointments</span>
          <span className="kpi-value">{value(upcoming.length)}</span>
          <span className="kpi-meta">{supported ? "Next 30 days" : offline}</span>
        </div>
        <div className="kpi">
          <span className="kpi-label">Upcoming follow-ups</span>
          <span className="kpi-value">{value(followUps.length)}</span>
          <span className="kpi-meta">{supported ? "Next 30 days" : offline}</span>
        </div>
      </section>
    </>
  );
}
