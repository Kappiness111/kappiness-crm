"use client";

import Icon from "../Icon";
import AppointmentCard from "./AppointmentCard";
import AvailabilitySummary from "./AvailabilitySummary";
import CalendarAgendaView from "./CalendarAgendaView";
import CalendarDayView from "./CalendarDayView";
import CalendarHeader from "./CalendarHeader";
import CalendarMonthView from "./CalendarMonthView";
import CalendarWeekView from "./CalendarWeekView";
import { appointmentsOnDay, formatLongDate, isoWeekday } from "../../lib/calendar";
import styles from "./dashboard.module.css";

/* The centrepiece: header, the view itself, a legend and the selected-day schedule. */
export default function PsychologistCalendar({
  view,
  anchor,
  selected,
  now,
  narrow,
  appointments,
  supported,
  loading,
  error,
  periods,
  periodsLoading,
  periodsError,
  onView,
  onPrev,
  onNext,
  onToday,
  onSelectDate,
  onSelectAppointment,
  onRetry,
  onRetryPeriods,
}) {
  const effectiveView = narrow && view === "week" ? "day" : view;
  const dayItems = appointmentsOnDay(appointments, selected);
  const showPanel = !(narrow && effectiveView === "day");

  const common = { anchor, appointments, periods, selected, now, onSelectDate, onSelectAppointment };

  return (
    <div className={styles.calendarLayout}>
      <section className={`${styles.panel} ${styles.calendarPanel}`} aria-label="Calendar">
        <CalendarHeader
          view={effectiveView}
          anchor={anchor}
          selected={selected}
          today={now}
          narrow={narrow}
          onView={onView}
          onPrev={onPrev}
          onNext={onNext}
          onToday={onToday}
        />
        {loading ? <div className={styles.loadingBar} role="status" aria-label="Loading appointments" /> : null}

        {error ? (
          <div className={styles.stateBox} role="alert">
            <strong>Could not load appointments</strong>
            <p>{error}</p>
            <button className={styles.btn} onClick={onRetry}>Try again</button>
          </div>
        ) : (
          <>
            {effectiveView === "week" && <CalendarWeekView {...common} />}
            {effectiveView === "day" && !narrow && <CalendarDayView {...common} />}
            {effectiveView === "day" && narrow && <CalendarAgendaView {...common} supported={supported} />}
            {effectiveView === "month" && <CalendarMonthView {...common} />}

            <div className={styles.gridLegend} aria-label="Legend">
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swSession}`} /> Appointment</span>
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swFollow}`} /> Follow-up session</span>
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swDone}`} /> Completed</span>
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swCancelled}`} /> Cancelled</span>
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swMissed}`} /> Missed</span>
              <span className={styles.legendItem}><span className={`${styles.swatch} ${styles.swAvailable}`} /> Your working hours</span>
              <span className={styles.legendItem}>Unshaded times are outside your working hours</span>
            </div>
          </>
        )}
      </section>

      {showPanel && (
        <aside className={`${styles.panel} ${styles.dayPanel}`} aria-label="Selected day">
          <div>
            <h3 className={styles.dayPanelTitle}>{formatLongDate(selected)}</h3>
            <p className={styles.dayPanelSub}>
              {supported
                ? dayItems.length
                  ? `${dayItems.length} appointment${dayItems.length === 1 ? "" : "s"}`
                  : "No appointments"
                : "Appointments are not available yet"}
            </p>
          </div>

          <div>
            <p className={styles.sectionLabel}>Appointments</p>
            {dayItems.length === 0 ? (
              <p className={styles.emptyNote}>
                {supported ? "No appointments on this day." : "Your appointments will appear here once scheduling is set up."}
              </p>
            ) : (
              <ul className={styles.list}>
                {dayItems.map((item) => (
                  <li key={item.id}>
                    <AppointmentCard appointment={item} onSelect={onSelectAppointment} />
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div>
            <p className={styles.sectionLabel}>Your working hours</p>
            <AvailabilitySummary
              periods={periods}
              loading={periodsLoading}
              error={periodsError}
              weekday={isoWeekday(selected)}
              onRetry={onRetryPeriods}
            />
          </div>
        </aside>
      )}
    </div>
  );
}