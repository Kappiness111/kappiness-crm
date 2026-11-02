"use client";
 
import Icon from "../Icon";
import { DAYS, formatRange } from "../../lib/psychologists";
import styles from "./psychologists.module.css";
 
/* Weekly recurring availability, Monday to Sunday. Several periods per day are allowed.
   Periods are deactivated rather than deleted: no delete workflow has been agreed with the backend. */
export default function AvailabilitySchedule({ periods, loading, error, canManage, busyIds, onRetry, onAdd, onEdit, onToggle }) {
  return (
    <section className={styles.card} id="availability" aria-labelledby="availability-title">
      <div className={styles.cardHead}>
        <div>
          <h2 id="availability-title" className={styles.cardTitle}>Weekly availability</h2>
          <p className={styles.cardHint}>
            {canManage ? "Add, edit or deactivate recurring working hours." : "Recurring working hours (view only)."}
          </p>
        </div>
        {canManage && !loading && !error ? (
          <button className="secondary-button" onClick={() => onAdd(1)}>
            <Icon name="plus" /> Add availability
          </button>
        ) : null}
      </div>
 
      <p className={styles.scheduleNote} style={{ marginTop: 14 }}>
        Recurring availability is not appointment availability. Bookable slots also depend on existing appointments, holidays and exceptions.
      </p>
 
      {loading && (
        <div className={styles.cardBody} aria-busy="true">
          {[0, 1, 2].map((item) => (
            <div key={item} className={styles.skeleton} style={{ width: `${70 - item * 12}%`, margin: "14px 0" }} />
          ))}
        </div>
      )}
 
      {!loading && error && (
        <div className={`${styles.stateBox} ${styles.stateError}`} role="alert">
          <span className={styles.stateIcon}><Icon name="info" /></span>
          <strong>Could not load availability</strong>
          <p>{error}</p>
          <button className="secondary-button" onClick={onRetry}>Try again</button>
        </div>
      )}
 
      {!loading && !error && (
        <ul className={styles.dayList}>
          {DAYS.map((day) => {
            const dayPeriods = periods.filter((period) => period.day_of_week === day.value);
 
            return (
              <li className={styles.dayRow} key={day.value}>
                <span className={styles.dayName}>{day.name}</span>
 
                <div className={styles.periods}>
                  {dayPeriods.length === 0 && <span className={styles.noPeriods}>No availability</span>}
 
                  {dayPeriods.map((period) => {
                    const busy = busyIds.includes(period.id);
                    return (
                      <div key={period.id} className={`${styles.period} ${period.is_active ? "" : styles.periodInactive}`}>
                        <span className={styles.periodMain}>
                          <span className={styles.periodTime}>{formatRange(period.start_time, period.end_time)}</span>
                          <span className={`${styles.badge} ${period.is_active ? styles.badgeActive : styles.badgeInactive}`}>
                            {period.is_active ? "Active" : "Inactive"}
                          </span>
                        </span>
 
                        {canManage && (
                          <span className={styles.actions}>
                            <button className={styles.linkBtn} onClick={() => onEdit(period)}>Edit</button>
                            <button
                              className={`${styles.linkBtn} ${period.is_active ? styles.linkBtnMuted : ""}`}
                              disabled={busy}
                              onClick={() => onToggle(period)}
                            >
                              {busy ? "Saving..." : period.is_active ? "Deactivate" : "Activate"}
                            </button>
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
 
                {canManage ? (
                  <button className={`${styles.linkBtn} ${styles.addBtn}`} onClick={() => onAdd(day.value)} aria-label={`Add availability on ${day.name}`}>
                    + Add
                  </button>
                ) : (
                  <span />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
 
