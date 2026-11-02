"use client";

import { OPEN_STATUSES, addDays, appointmentsOnDay, formatClock, startOfDay } from "../../lib/calendar";
import styles from "./dashboard.module.css";

function greeting(now) {
  const hour = now.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 17) return "Good afternoon";
  return "Good evening";
}

/* Greeting and the three headline numbers. Numbers come only from real appointment data;
   when none is connected they show a dash and say so. */
export default function DashboardOverview({ name, now, appointments, supported, loading }) {
  const today = startOfDay(now);
  const horizon = addDays(today, 30);

  const todays = appointmentsOnDay(appointments, today).filter((item) => item.status !== "cancelled");
  const nextToday = todays.find((item) => item.end > now && OPEN_STATUSES.includes(item.status));
  const upcoming = appointments.filter((item) => item.start > now && item.start < horizon && OPEN_STATUSES.includes(item.status));
  const followUps = upcoming.filter((item) => item.type === "follow_up");

  const ready = supported && !loading;
  const value = (count) => (ready ? count : "—");
  const offline = "Appears once appointment data is connected";

  return (
    <section className={styles.hero} aria-label="Overview">
      <div className={styles.heroInner}>
        <span className={styles.eyebrow}>
          {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
        </span>
        <h1 className={styles.heroTitle}>
          {greeting(now)}, <span>{name || "there"}</span>
        </h1>
        <p className={styles.heroText}>Your calendar, availability and upcoming sessions, in one calm place.</p>
      </div>

      <div className={styles.statGrid}>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Today&apos;s sessions</span>
          <strong className={styles.statValue}>{value(todays.length)}</strong>
          <span className={styles.statHint}>
            {!supported ? offline : loading ? "Loading..." : nextToday ? `Next at ${formatClock(nextToday.start)}` : todays.length ? "No more sessions today" : "Nothing scheduled today"}
          </span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Upcoming appointments</span>
          <strong className={styles.statValue}>{value(upcoming.length)}</strong>
          <span className={styles.statHint}>{supported ? "In the next 30 days" : offline}</span>
        </div>
        <div className={styles.stat}>
          <span className={styles.statLabel}>Upcoming follow-ups</span>
          <strong className={styles.statValue}>{value(followUps.length)}</strong>
          <span className={styles.statHint}>{supported ? "In the next 30 days" : offline}</span>
        </div>
      </div>
    </section>
  );
}