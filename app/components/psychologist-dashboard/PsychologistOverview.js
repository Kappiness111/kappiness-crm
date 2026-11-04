"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { BarList, Legend, LineChart, RingGauge } from "../dashboard/Charts";
import { StatusPill } from "../AppointmentTable";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, isMissingBackend, listAppointments } from "../../lib/appointmentsApi";
import { listClients } from "../../lib/clientsApi";
import { getGreeting, formatDate, formatTime } from "../../lib/leads";
import { listRecommendations, recommendationState } from "../../lib/sessionsApi";

const WEEKS_BACK = 8;
const WEEKS_AHEAD = 4;

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d;
}

/* Psychologist overview: KPIs and charts from the psychologist's own records (RLS limits every query to them).
   Nothing here is estimated: every number is counted from appointments, clients and recommendations. */
export default function PsychologistOverview({ psychologistId, name, now, onNavigate, onOpenClient }) {
  const [state, setState] = useState({ status: "loading", message: "" });
  const [appointments, setAppointments] = useState([]);
  const [clientCount, setClientCount] = useState(0);
  const [recommendations, setRecommendations] = useState([]);

  useEffect(() => {
    if (!psychologistId) return undefined;
    let cancelled = false;
    const from = startOfWeek(new Date());
    from.setDate(from.getDate() - WEEKS_BACK * 7);
    Promise.all([
      listAppointments({ psychologistId, from }),
      listClients({ psychologistId }),
      listRecommendations({ psychologistId }),
    ])
      .then(([appts, clients, recs]) => {
        if (cancelled) return;
        setAppointments(appts);
        setClientCount(clients.length);
        setRecommendations(recs);
        setState({ status: "ready", message: "" });
      })
      .catch((error) => {
        console.error("Failed to load overview:", error);
        if (!cancelled) {
          setState({
            status: isMissingBackend(error) ? "missing" : "error",
            message: describeAppointmentError(error, "Could not load your overview."),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId]);

  const stats = useMemo(() => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + 86400000);
    const active = appointments.filter((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status));
    const count = (status) => appointments.filter((item) => item.status === status).length;

    const weeks = [];
    const first = startOfWeek(now);
    first.setDate(first.getDate() - WEEKS_BACK * 7);
    for (let i = 0; i < WEEKS_BACK + WEEKS_AHEAD; i += 1) {
      const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i * 7);
      const label = start.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      weeks.push({ key: start.toISOString(), start, label, full: `Week of ${label}`, booked: 0, completed: 0 });
    }
    appointments.forEach((item) => {
      if (item.status === "Rescheduled") return; // moved to a new appointment, counted there
      const time = new Date(item.starts_at).getTime();
      const week = weeks.find((w) => time >= w.start.getTime() && time < w.start.getTime() + 7 * 86400000);
      if (!week) return;
      week.booked += 1;
      if (item.status === "Completed") week.completed += 1;
    });

    return {
      today: active.filter((item) => new Date(item.starts_at) >= today && new Date(item.starts_at) < tomorrow),
      upcoming: active.filter((item) => new Date(item.ends_at) >= now).sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)),
      awaiting: active.filter((item) => new Date(item.starts_at) <= now),
      completed: count("Completed"),
      cancelled: count("Cancelled"),
      missed: count("Missed"),
      rescheduled: count("Rescheduled"),
      weeks,
      pending: recommendations.filter((rec) => rec.status === "Open"),
      overdue: recommendations.filter((rec) => recommendationState(rec, now) === "overdue"),
    };
  }, [appointments, recommendations, now]);

  if (state.status === "missing") {
    return (
      <div className="notice" role="status">
        <Icon name="info" />
        <div>
          <strong>Appointments are not set up in the database yet</strong>
          Your overview will appear once the clinic applies the scheduling migration.
        </div>
      </div>
    );
  }

  const loading = state.status === "loading";
  const value = (n) => (loading ? "…" : n);
  const kpis = [
    { label: "Assigned clients", value: clientCount, icon: "users", go: "clients" },
    { label: "Today", value: stats.today.length, icon: "calendar", go: "calendar" },
    { label: "Upcoming", value: stats.upcoming.length, icon: "calendarCheck", go: "calendar" },
    { label: "Completed", value: stats.completed, icon: "checkCircle", go: "sessions" },
    { label: "Cancelled", value: stats.cancelled, icon: "close", go: "sessions" },
    { label: "Missed", value: stats.missed, icon: "alert", go: "sessions" },
    { label: "Pending follow-ups", value: stats.pending.length, icon: "note", go: "recommendations" },
  ];
  const statusRows = [
    { key: "Scheduled", label: "Scheduled", value: appointments.filter((item) => item.status === "Scheduled").length },
    { key: "Confirmed", label: "Confirmed", value: appointments.filter((item) => item.status === "Confirmed").length },
    { key: "Completed", label: "Completed", value: stats.completed },
    { key: "Missed", label: "Missed", value: stats.missed },
    { key: "Cancelled", label: "Cancelled", value: stats.cancelled },
    { key: "Rescheduled", label: "Rescheduled", value: stats.rescheduled },
  ];
  const statusTotal = statusRows.reduce((sum, row) => sum + row.value, 0);

  return (
    <div className="dash">
      <section className="dash-hero" aria-label="Overview">
        <div className="dash-hero-main">
          <h1 className="dash-greeting">
            {getGreeting(now)}
            {name ? `, ${name.split(" ")[0]}` : ""}
          </h1>
          <p className="dash-date">
            It&apos;s {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
            {" · "}
            {loading ? "Loading your day…" : `${stats.today.length} appointment${stats.today.length === 1 ? "" : "s"} today`}
          </p>
          <div className="dash-hero-rule" aria-hidden="true" />
          <div className="dash-kpis">
            {kpis.map((kpi) => (
              <button key={kpi.label} type="button" className="dash-kpi" onClick={() => onNavigate(kpi.go)}>
                <span className="dash-kpi-value">
                  <span className="dash-kpi-icon" aria-hidden="true">
                    <Icon name={kpi.icon} />
                  </span>
                  {value(kpi.value)}
                </span>
                <span className="dash-kpi-label">{kpi.label}</span>
              </button>
            ))}
          </div>
          <p className="dash-kpi-note">
            Appointment counts cover the last {WEEKS_BACK} weeks and everything booked ahead.
            {stats.awaiting.length > 0 ? ` ${stats.awaiting.length} past appointment(s) still need attendance recorded.` : ""}
          </p>
        </div>
        <div className="dash-hero-side">
          <RingGauge
            size={164}
            stroke={11}
            value={stats.completed}
            total={loading ? 0 : stats.completed + stats.missed}
            label="Attendance"
            caption={stats.completed + stats.missed ? `${stats.completed} completed vs ${stats.missed} missed` : "No attended or missed sessions yet"}
          />
        </div>
      </section>

      {state.status === "error" && (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <div>
            <strong>Could not load your overview</strong>
            {state.message}
          </div>
        </div>
      )}

      <div className="dash-grid psych">
        <section className="dash-card">
          <header className="dash-card-head">
            <div>
              <h2>Weekly appointments</h2>
              <p>Booked per week (rescheduled bookings count once), and how many were completed.</p>
            </div>
            <Legend
              items={[
                { label: "Booked", color: "var(--chart-1)" },
                { label: "Completed", color: "var(--chart-2)" },
              ]}
            />
          </header>
          <div className="dash-card-body">
            <LineChart
              height={210}
              data={stats.weeks}
              series={[
                { id: "booked", label: "Booked", color: "var(--chart-1)" },
                { id: "completed", label: "Completed", color: "var(--chart-2)" },
              ]}
              emptyTitle={loading ? "Loading…" : "No appointments in this period"}
              emptyText={loading ? "" : "Booked sessions will chart here."}
            />
          </div>
        </section>

        <section className="dash-card">
          <header className="dash-card-head">
            <div>
              <h2>Session status</h2>
              <p>All appointments in this period, by status.</p>
            </div>
          </header>
          <div className="dash-card-body">
            <BarList rows={statusRows} total={statusTotal} emptyTitle={loading ? "Loading…" : "No appointments yet"} emptyText="" ariaLabel="Appointments by status" />
          </div>
        </section>

        <section className="dash-card">
          <header className="dash-card-head">
            <div>
              <h2>Upcoming sessions</h2>
              <p>Your next booked appointments.</p>
            </div>
            <button type="button" className="dash-icon-btn round" onClick={() => onNavigate("calendar")} aria-label="Open calendar" title="Open calendar">
              <Icon name="arrowUpRight" />
            </button>
          </header>
          <div className="dash-card-body">
            {stats.upcoming.length === 0 ? (
              <p className="appt-empty">{loading ? "Loading…" : "Nothing booked ahead."}</p>
            ) : (
              <ul className="list">
                {stats.upcoming.slice(0, 5).map((item) => (
                  <li key={item.id} className="list-row">
                    <span className="when">
                      {formatTime(item.starts_at)}
                      <small>{formatDate(item.starts_at).slice(0, 6)}</small>
                    </span>
                    <span className="grow">
                      <button type="button" className="link-btn" onClick={() => onOpenClient(item.client_id)}>
                        {item.client_name}
                      </button>
                      <span>{item.service_type}</span>
                    </span>
                    <StatusPill status={item.status} />
                  </li>
                ))}
              </ul>
            )}
            {stats.overdue.length > 0 && (
              <p className="dash-note">
                {stats.overdue.length} recommended follow-up{stats.overdue.length > 1 ? "s are" : " is"} past the recommended date and not booked yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
