"use client";

import Icon from "../Icon";
import { DAYS, formatRange } from "../../lib/psychologists";
import styles from "./psychologists.module.css";

/* Weekly recurring availability, Monday to Sunday. Several periods per day are allowed.
   Periods are deactivated rather than deleted: no delete workflow has been agreed with the backend. */
export default function AvailabilitySchedule({ periods, loading, error, canManage, busyIds, onRetry, onAdd, onEdit, onToggle }) {
  return (
    <section className="section" id="availability" aria-labelledby="availability-title">
      <div className="section-head">
        <div>
          <h2 id="availability-title">Weekly working hours</h2>
          <p>
            The hours clients can be booked in, every week{canManage ? "" : " (view only)"}. A time is available unless it is already booked or blocked.
          </p>
        </div>
        {canManage && !loading && !error ? (
          <button type="button" className="btn btn-sm" onClick={() => onAdd(1)}>
            <Icon name="plus" /> Add working hours
          </button>
        ) : null}
      </div>

      <div className="panel">
        {loading && (
          <div className="panel-pad" aria-busy="true">
            {[0, 1, 2].map((item) => (
              <div key={item} className="skeleton" style={{ width: `${70 - item * 12}%`, margin: "12px 0" }} />
            ))}
          </div>
        )}

        {!loading && error && (
          <div className="state error" role="alert">
            <Icon name="alert" />
            <strong>Could not load availability</strong>
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
          </div>
        )}

        {!loading && !error && (
          <ul className={styles.week}>
            {DAYS.map((day) => {
              const dayPeriods = periods.filter((period) => period.day_of_week === day.value);

              return (
                <li className={styles.dayRow} key={day.value}>
                  <span className={styles.dayName}>{day.name}</span>

                  <div className={styles.periods}>
                    {dayPeriods.length === 0 && <span className={styles.none}>Not working</span>}

                    {dayPeriods.map((period) => {
                      const busy = busyIds.includes(period.id);
                      return (
                        <div key={period.id} className={`${styles.period} ${period.is_active ? "" : styles.periodOff}`}>
                          <span className="num">{formatRange(period.start_time, period.end_time)}</span>
                          {!period.is_active && <span className="badge">Turned off</span>}
                          {canManage && (
                            <span className={styles.periodActions}>
                              <button type="button" className="link-btn quiet" onClick={() => onEdit(period)}>
                                Edit
                              </button>
                              <button
                                type="button"
                                className={`link-btn ${period.is_active ? "danger" : ""}`}
                                disabled={busy}
                                onClick={() => onToggle(period)}
                              >
                                {busy ? "Saving…" : period.is_active ? "Turn off" : "Turn on"}
                              </button>
                            </span>
                          )}
                        </div>
                      );
                    })}
                  </div>

                  {canManage ? (
                    <button type="button" className="row-btn" onClick={() => onAdd(day.value)} aria-label={`Add availability on ${day.name}`} title={`Add on ${day.name}`}>
                      <Icon name="plus" />
                    </button>
                  ) : (
                    <span />
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
