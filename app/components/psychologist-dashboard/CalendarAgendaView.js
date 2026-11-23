"use client";

import AppointmentCard from "./AppointmentCard";
import { appointmentsOnDay, isSameDay, weekDays } from "../../lib/calendar";
import styles from "./dashboard.module.css";

/* Phone layout: a strip of the week's days and the selected day's sessions as a simple list. */
export default function CalendarAgendaView({ anchor, appointments, selected, now, onSelectDate, onSelectAppointment, supported }) {
  const items = appointmentsOnDay(appointments, selected);

  return (
    <div>
      <div className={styles.dayStrip}>
        {weekDays(anchor).map((day) => (
          <button
            key={day.toISOString()}
            className={`${styles.stripBtn} ${isSameDay(day, selected) ? styles.stripSelected : ""} ${isSameDay(day, now) ? styles.stripToday : ""}`}
            onClick={() => onSelectDate(day)}
            aria-pressed={isSameDay(day, selected)}
            aria-label={day.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          >
            <small>{day.toLocaleDateString("en-GB", { weekday: "short" })}</small>
            <b>{day.getDate()}</b>
          </button>
        ))}
      </div>

      <div className={styles.agenda}>
        {items.length === 0 ? (
          <p className={styles.emptyNote}>
            {supported ? "No appointments on this day." : "Your appointments will appear here once scheduling is set up."}
          </p>
        ) : (
          items.map((item) => <AppointmentCard key={item.id} appointment={item} onSelect={onSelectAppointment} />)
        )}
      </div>
    </div>
  );
}