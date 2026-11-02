"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import FollowUpRecommendationForm from "./FollowUpRecommendationForm";
import { OPEN_STATUSES, STATUS_META, TYPE_META, formatClock, formatLongDate } from "../../lib/calendar";
import styles from "./dashboard.module.css";

const BADGE_CLASS = {
  confirmed: styles.badgeConfirmed,
  completed: styles.badgeCompleted,
  cancelled: styles.badgeCancelled,
  missed: styles.badgeMissed,
};

/* Side panel for one appointment. Actions go through the adapter in lib/psychologistAppointments.js,
   which reports honestly when the backend cannot do something yet. */
export default function AppointmentDetailsPanel({ appointment, capabilities, busy, onClose, onStatus, onRecommend }) {
  const [showForm, setShowForm] = useState(false);
  const closeRef = useRef(onClose);

  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (event) => {
      if (event.key === "Escape") closeRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const isOpen = OPEN_STATUSES.includes(appointment.status);
  const actionsReady = capabilities.updateStatus || capabilities.recommendFollowUp;

  return (
    <div
      className={styles.overlay}
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className={styles.drawer} role="dialog" aria-modal="true" aria-labelledby="appt-title">
        <header className={styles.drawerHead}>
          <div>
            <span className={styles.eyebrow}>Session details</span>
            <h2 id="appt-title" className={styles.drawerTitle}>{appointment.clientName}</h2>
          </div>
          <button className={styles.iconBtn} onClick={onClose} aria-label="Close details">
            <Icon name="close" />
          </button>
        </header>

        <div className={styles.drawerBody}>
          {!actionsReady && (
            <div className={styles.notice}>
              <span className={styles.noticeIcon}><Icon name="info" /></span>
              <div>
                <strong>Session actions are not connected yet</strong>
                Updating status and recommending follow-ups need backend support.
              </div>
            </div>
          )}

          <dl className={styles.kv}>
            <dt>Date</dt>
            <dd>{formatLongDate(appointment.start)}</dd>
            <dt>Time</dt>
            <dd>{formatClock(appointment.start)} – {formatClock(appointment.end)}</dd>
            <dt>Session type</dt>
            <dd>
              <span className={`${styles.badge} ${appointment.type === "follow_up" ? styles.badgeFollow : ""}`}>
                {TYPE_META[appointment.type].label}
              </span>
            </dd>
            <dt>Status</dt>
            <dd>
              <span className={`${styles.badge} ${BADGE_CLASS[appointment.status] || ""}`}>
                {STATUS_META[appointment.status].label}
              </span>
            </dd>
            <dt>Follow-up</dt>
            <dd>
              {appointment.followUpRecommendedAt
                ? `Recommended on ${new Date(appointment.followUpRecommendedAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
                : "No follow-up recommended yet"}
            </dd>
          </dl>

          <div>
            <p className={styles.sectionLabel}>Client details</p>
            <p className={styles.help}>
              Only details your access allows will appear here. No additional client details are connected yet.
            </p>
          </div>

          {showForm && (
            <FollowUpRecommendationForm
              appointment={appointment}
              allowNotes={capabilities.followUpNotes}
              onSubmit={onRecommend}
              onCancel={() => setShowForm(false)}
            />
          )}
        </div>

        <footer className={styles.drawerFoot}>
          {isOpen && (
            <>
              <button className={`${styles.btn} ${styles.btnPrimary}`} disabled={busy} onClick={() => onStatus(appointment, "completed")}>
                <Icon name="check" /> Mark completed
              </button>
              <button className={styles.btn} disabled={busy} onClick={() => onStatus(appointment, "missed")}>Mark missed</button>
              <button className={styles.btn} disabled={busy} onClick={() => onStatus(appointment, "cancelled")}>Mark cancelled</button>
            </>
          )}
          {!showForm && (
            <button className={styles.btn} onClick={() => setShowForm(true)}>Recommend follow-up</button>
          )}
        </footer>
      </aside>
    </div>
  );
}