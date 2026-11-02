"use client";

import Icon from "./Icon";
import { addMonthsClamped, isSameDay, monthGrid } from "../lib/calendar";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/* Month calendar. getMeta(day) -> { available, count, disabled }.
   available = the day has bookable slots, count = appointments already on the day. */
export default function MonthGrid({ anchor, onAnchorChange, selected, onSelect, getMeta, today }) {
  const weeks = monthGrid(anchor);
  const title = anchor.toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <div className="cal">
      <div className="cal-head">
        <button type="button" className="cal-nav" aria-label="Previous month" onClick={() => onAnchorChange(addMonthsClamped(anchor, -1))}>
          <Icon name="arrowLeft" />
        </button>
        <strong className="cal-title">{title}</strong>
        <button type="button" className="cal-nav next" aria-label="Next month" onClick={() => onAnchorChange(addMonthsClamped(anchor, 1))}>
          <Icon name="arrowLeft" />
        </button>
      </div>

      <div className="cal-grid cal-weekdays" aria-hidden="true">
        {WEEKDAYS.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>

      <div className="cal-grid">
        {weeks.flat().map((day) => {
          const meta = getMeta(day) || {};
          const outside = day.getMonth() !== anchor.getMonth();
          const classes = [
            "cal-day",
            outside ? "outside" : "",
            selected && isSameDay(day, selected) ? "selected" : "",
            today && isSameDay(day, today) ? "today" : "",
            meta.available ? "has-slots" : "",
            meta.count ? "has-appts" : "",
          ]
            .filter(Boolean)
            .join(" ");

          return (
            <button
              type="button"
              key={day.toISOString()}
              className={classes}
              disabled={Boolean(meta.disabled)}
              aria-pressed={Boolean(selected && isSameDay(day, selected))}
              aria-label={`${day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}${
                meta.available ? ", slots available" : ""
              }${meta.count ? `, ${meta.count} appointment${meta.count > 1 ? "s" : ""}` : ""}`}
              onClick={() => onSelect(day)}
            >
              <span className="cal-num">{day.getDate()}</span>
              {meta.count ? <span className="cal-count">{meta.count}</span> : null}
              {meta.available ? <span className="cal-dot" aria-hidden="true" /> : null}
            </button>
          );
        })}
      </div>

      <p className="cal-legend">
        <span className="cal-dot" aria-hidden="true" /> Slots available
        <span className="cal-count">n</span> Booked
      </p>
    </div>
  );
}