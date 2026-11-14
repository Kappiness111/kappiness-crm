"use client";

import Icon from "../Icon";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/* Month dashboard (Sunday to Saturday): booked, capacity and available slots per date, from the same appointment
   records and rules as the daily schedule. Selecting a date opens that day's schedule. */
export default function MonthCapacity({ anchor, days, selected, today, onPrev, onNext, onSelect }) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const leading = first.getDay();
  const cells = [...Array.from({ length: leading }, () => null), ...days];
  const totals = days.reduce(
    (acc, d) => ({ booked: acc.booked + d.booked, capacity: acc.capacity + d.capacity }),
    { booked: 0, capacity: 0 }
  );
  const sameDay = (a, b) => a && b && a.toDateString() === b.toDateString();

  return (
    <section className="panel month-cap" aria-label="Monthly capacity">
      <header className="month-cap-head">
        <button type="button" className="icon-btn" onClick={onPrev} aria-label="Previous month">
          <Icon name="chevronLeft" />
        </button>
        <div>
          <h2>{first.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</h2>
          <p className="muted">
            {totals.booked} booked of {totals.capacity} slots this month
            {totals.capacity ? ` · ${Math.round((Math.min(totals.booked, totals.capacity) / totals.capacity) * 100)}% used` : ""}
          </p>
        </div>
        <button type="button" className="icon-btn" onClick={onNext} aria-label="Next month">
          <Icon name="chevronRight" />
        </button>
      </header>
      <div className="month-cap-grid" role="grid" aria-label="Days">
        {WEEKDAYS.map((name) => (
          <div key={name} className="month-cap-dow" role="columnheader">
            {name}
          </div>
        ))}
        {cells.map((d, index) =>
          d ? (
            <button
              key={d.date.toISOString()}
              type="button"
              role="gridcell"
              className={`month-cap-day ${sameDay(d.date, selected) ? "is-selected" : ""} ${sameDay(d.date, today) ? "is-today" : ""} ${d.capacity === 0 ? "is-closed" : ""}`}
              onClick={() => onSelect(d.date)}
              aria-label={`${d.date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}: ${d.booked} booked of ${d.capacity} slots, ${d.available} available${d.onLeave ? `, ${d.onLeave} on leave` : ""}`}
            >
              <span className="month-cap-date">{d.date.getDate()}</span>
              {d.capacity > 0 || d.booked > 0 ? (
                <>
                  <span className="month-cap-count">
                    <strong>{d.booked}</strong>/{d.capacity}
                  </span>
                  <span className="month-cap-bar" aria-hidden="true">
                    <span style={{ width: `${d.capacity ? Math.min(100, (d.booked / d.capacity) * 100) : 0}%` }} />
                  </span>
                  <span className="month-cap-meta">
                    {d.available} free{d.onLeave ? ` · ${d.onLeave} on leave` : ""}
                  </span>
                </>
              ) : (
                <span className="month-cap-meta">No hours</span>
              )}
            </button>
          ) : (
            <span key={`pad-${index}`} className="month-cap-pad" aria-hidden="true" />
          )
        )}
      </div>
      <p className="subtle-text month-cap-note">Each date shows booked / capacity, then free slots. Select a date to open its schedule.</p>
    </section>
  );
}
