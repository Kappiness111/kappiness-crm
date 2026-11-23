"use client";

import { DAYS, formatRange } from "../../lib/psychologists";
import styles from "./dashboard.module.css";

/* Recurring weekly availability. Compact mode lists one weekday (used beside the calendar). */
export default function AvailabilitySummary({ periods, loading, error, weekday, onRetry }) {
  const note = "Your weekly working hours. Booked times and blocked dates are not shown here.";

  if (loading) {
    return (
      <div aria-busy="true">
        <div className={styles.skeleton} style={{ width: "70%", marginBottom: 10 }} />
        <div className={styles.skeleton} style={{ width: "50%" }} />
      </div>
    );
  }

  if (error) {
    return (
      <div className={styles.formAlert} role="alert">
        {error} {onRetry ? <button className={styles.btn} onClick={onRetry} style={{ marginLeft: 8 }}>Try again</button> : null}
      </div>
    );
  }

  if (weekday) {
    const dayPeriods = periods.filter((period) => period.day_of_week === weekday);
    if (dayPeriods.length === 0) return <p className={styles.help}>You are not available on this day of the week.</p>;
    return (
      <div className={styles.compactAvail}>
        {dayPeriods.map((period) => (
          <span key={period.id} className={`${styles.pill} ${period.is_active ? "" : styles.pillOff}`}>
            {formatRange(period.start_time, period.end_time)}
            <span className={`${styles.state} ${period.is_active ? styles.stateOn : styles.stateOff}`}>
              {period.is_active ? "Active" : "Inactive"}
            </span>
          </span>
        ))}
        <p className={styles.help}>{note}</p>
      </div>
    );
  }

  return (
    <>
      <ul className={styles.availGrid}>
        {DAYS.map((day) => {
          const dayPeriods = periods.filter((period) => period.day_of_week === day.value);
          return (
            <li key={day.value} className={styles.availRow}>
              <span className={styles.availDay}>{day.name}</span>
              <span className={styles.availTimes}>
                {dayPeriods.length === 0 ? (
                  <span className={styles.help}>Not working</span>
                ) : (
                  dayPeriods.map((period) => (
                    <span key={period.id} className={`${styles.pill} ${period.is_active ? "" : styles.pillOff}`}>
                      {formatRange(period.start_time, period.end_time)}
                      <span className={`${styles.state} ${period.is_active ? styles.stateOn : styles.stateOff}`}>
                        {period.is_active ? "Active" : "Inactive"}
                      </span>
                    </span>
                  ))
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <p className={styles.help} style={{ padding: "0 20px 18px" }}>{note}</p>
    </>
  );
}