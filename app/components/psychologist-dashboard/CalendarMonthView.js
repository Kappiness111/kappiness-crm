"use client";

import { appointmentsOnDay, isSameDay, monthGrid } from "../../lib/calendar";
import styles from "./dashboard.module.css";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const MAX_CHIPS = 3;

function chipClass(appointment) {
  if (appointment.status === "completed") return styles.chipCompleted;
  if (appointment.status === "cancelled") return styles.chipCancelled;
  if (appointment.status === "missed") return styles.chipMissed;
  return appointment.type === "follow_up" ? styles.chipFollow : "";
}

export default function CalendarMonthView({ anchor, appointments, selected, now, onSelectDate }) {
  const weeks = monthGrid(anchor);

  return (
    <div>
      <div className={styles.monthHead}>
        {WEEKDAYS.map((name) => (
          <span key={name}>{name}</span>
        ))}
      </div>
      <div className={styles.monthGrid}>
        {weeks.flat().map((day) => {
          const items = appointmentsOnDay(appointments, day);
          const outside = day.getMonth() !== anchor.getMonth();
          const classes = [
            styles.monthCell,
            outside ? styles.monthOut : "",
            isSameDay(day, selected) ? styles.monthSelected : "",
            isSameDay(day, now) ? styles.monthToday : "",
          ].join(" ");

          return (
            <button
              key={day.toISOString()}
              className={classes}
              onClick={() => onSelectDate(day)}
              aria-label={`${day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}, ${items.length} appointment${items.length === 1 ? "" : "s"}`}
              aria-pressed={isSameDay(day, selected)}
            >
              <span className={styles.monthNum}>{day.getDate()}</span>
              {items.slice(0, MAX_CHIPS).map((item) => (
                <span key={item.id} className={`${styles.chip} ${chipClass(item)}`}>
                  {item.start.toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: false })} {item.clientName}
                </span>
              ))}
              {items.length > MAX_CHIPS ? <span className={styles.more}>+{items.length - MAX_CHIPS} more</span> : null}
              {items.length > 0 ? (
                <span className={styles.dots} aria-hidden="true">
                  {items.slice(0, 4).map((item) => (
                    <span key={item.id} className={`${styles.dot} ${item.type === "follow_up" ? styles.dotFollow : ""}`} />
                  ))}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}