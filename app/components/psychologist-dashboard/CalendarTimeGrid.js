"use client";

import AppointmentCard from "./AppointmentCard";
import {
  HOUR_HEIGHT,
  appointmentsOnDay,
  availabilityBands,
  formatHourLabel,
  gridHours,
  isSameDay,
  layoutDay,
} from "../../lib/calendar";
import styles from "./dashboard.module.css";

/* Shared time grid for the week view (7 columns) and the day view (1 column).
   Time labels on the left, one column per day, cards positioned by start and end time. */
export default function CalendarTimeGrid({ days, appointments, periods, selected, now, onSelectDate, onSelectAppointment }) {
  const { first, hours } = gridHours(appointments, periods);
  const columns = `46px repeat(${days.length}, minmax(0, 1fr))`;
  const bodyHeight = hours.length * HOUR_HEIGHT;
  const minWidth = days.length > 1 ? 720 : 0;

  return (
    <div className={styles.gridScroll} style={{ "--hour-h": `${HOUR_HEIGHT}px` }}>
      <div style={{ minWidth }}>
        <div className={styles.gridHead} style={{ gridTemplateColumns: columns }}>
          <div className={styles.gutter} />
          {days.map((day) => {
            const isToday = isSameDay(day, now);
            const isSelected = isSameDay(day, selected);
            return (
              <button
                key={day.toISOString()}
                className={`${styles.dayHead} ${isToday ? styles.dayToday : ""} ${isSelected ? styles.daySelected : ""}`}
                onClick={() => onSelectDate(day)}
                aria-label={day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
                aria-pressed={isSelected}
              >
                <span className={styles.dayName}>{day.toLocaleDateString("en-GB", { weekday: "short" })}</span>
                <span className={styles.dayNum}>{day.getDate()}</span>
              </button>
            );
          })}
        </div>

        <div className={styles.gridBody} style={{ gridTemplateColumns: columns, height: bodyHeight }}>
          <div className={styles.timeCol}>
            {hours.map((hour, index) => (
              <span key={hour} className={styles.timeLabel} style={{ top: index === 0 ? 8 : index * HOUR_HEIGHT }}>
                {formatHourLabel(hour)}
              </span>
            ))}
          </div>

          {days.map((day) => {
            const isToday = isSameDay(day, now);
            const placed = layoutDay(appointmentsOnDay(appointments, day), first);
            const bands = availabilityBands(periods, day, first);
            const nowMinutes = now.getHours() * 60 + now.getMinutes();
            const nowTop = ((nowMinutes - first * 60) / 60) * HOUR_HEIGHT;

            return (
              <div key={day.toISOString()} className={`${styles.dayCol} ${isToday ? styles.colToday : ""}`}>
                {bands.map((band) => (
                  <div key={band.id} className={styles.band} style={{ top: band.top, height: band.height }} aria-hidden="true" />
                ))}
                {placed.map((entry) => (
                  <AppointmentCard
                    key={entry.appointment.id}
                    appointment={entry.appointment}
                    position={entry}
                    onSelect={onSelectAppointment}
                  />
                ))}
                {isToday && nowTop >= 0 && nowTop <= bodyHeight ? <div className={styles.nowLine} style={{ top: nowTop }} /> : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}