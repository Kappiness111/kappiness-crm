"use client";

import { STATUS_META, TYPE_META, formatClock } from "../../lib/calendar";
import styles from "./dashboard.module.css";

const STATUS_CLASS = {
  confirmed: styles.statusConfirmed,
  completed: styles.statusCompleted,
  cancelled: styles.statusCancelled,
  rescheduled: styles.statusCancelled,
  missed: styles.statusMissed,
};

/* One appointment. `position` places it inside the time grid; without it the card sits in a list.
   Type and status are always written out as well as coloured, so colour is never the only signal. */
export default function AppointmentCard({ appointment, position, onSelect }) {
  const isFollowUp = appointment.type === "follow_up";
  const showStatus = appointment.status !== "scheduled";
  const classes = [
    styles.card,
    isFollowUp ? styles.typeFollow : "",
    STATUS_CLASS[appointment.status] || "",
    position ? "" : styles.cardStatic,
  ].join(" ");

  let style;
  if (position) {
    const width = 100 / position.columns;
    style = {
      top: position.top,
      height: position.height,
      left: `calc(${position.column * width}% + 2px)`,
      width: `calc(${width}% - 4px)`,
    };
  }

  const label = `${appointment.clientName}, ${formatClock(appointment.start)} to ${formatClock(appointment.end)}, ${
    TYPE_META[appointment.type].label
  }, ${STATUS_META[appointment.status].label}`;

  return (
    <button type="button" className={classes} style={style} onClick={() => onSelect(appointment)} aria-label={label}>
      <span className={styles.cardTime}>
        {formatClock(appointment.start)} – {formatClock(appointment.end)}
      </span>
      <span className={styles.cardName}>{appointment.clientName}</span>
      {(isFollowUp || showStatus) && (!position || position.height >= 62) ? (
        <span className={styles.cardTags}>
          {isFollowUp ? <span className={styles.tag}>Follow-up</span> : null}
          {showStatus ? <span className={styles.tag}>{STATUS_META[appointment.status].label}</span> : null}
        </span>
      ) : null}
    </button>
  );
}