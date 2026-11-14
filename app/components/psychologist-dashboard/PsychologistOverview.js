"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { BarList, Legend, LineChart, RingGauge } from "../dashboard/Charts";
import { StatusPill } from "../AppointmentTable";
import { Badge, FollowUpStateBadge } from "../ui/StatusBadges";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, isMissingBackend, listAppointments } from "../../lib/appointmentsApi";
import { periodsFor, slotsForDay } from "../../lib/appointmentSlots";
import { listClients } from "../../lib/clientsApi";
import { getGreeting, formatDate, formatTime } from "../../lib/leads";
import { listAvailability } from "../../lib/psychologistsApi";
import { listBlocks, listServices } from "../../lib/schedulingApi";
import { listRecommendations, recommendationState } from "../../lib/sessionsApi";
import { appointmentStatusLabel, sessionTypeLabel } from "../../lib/statusLabels";

const WEEKS_BACK = 8;
const WEEKS_AHEAD = 4;
const DAY = 86400000;

function startOfWeek(date) {
  const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const day = (d.getDay() + 6) % 7; // Monday = 0
  d.setDate(d.getDate() - day);
  return d;
}

const isActive = (item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status);

function AgendaRow({ time, timeSub, title, onTitle, titleHint, flag, sub, status, closed = false, next = false, actionLabel, actionHint, onAction }) {
  return (
    <li className={`agenda-row ${time ? "" : "no-time"} ${closed ? "is-closed" : ""} ${next ? "is-next" : ""}`}>
      {time ? (
        <span className="agenda-when">
          {time}
          {timeSub ? <small>{timeSub}</small> : null}
        </span>
      ) : null}
      <div className="agenda-body">
        <div className="agenda-title">
          {onTitle ? (
            <button type="button" className="link-btn" onClick={onTitle} title={titleHint}>
              {title}
            </button>
          ) : (
            <strong>{title}</strong>
          )}
          {flag}
        </div>
        {sub ? <div className="agenda-sub">{sub}</div> : null}
        {status ? <div className="agenda-status">{status}</div> : null}
      </div>
      <button type="button" className="appt-btn" onClick={onAction} aria-label={actionHint}>
        {actionLabel}
      </button>
    </li>
  );
}

// "Dr Annie Thomas" -> "Dr Annie"; "Annie Thomas" -> "Annie". A title on its own is never used as the name.
const TITLES = new Set(["dr", "dr.", "mr", "mr.", "mrs", "mrs.", "ms", "ms.", "prof", "prof."]);
function greetingName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  if (TITLES.has(parts[0].toLowerCase())) return parts.length > 1 ? `${parts[0]} ${parts[1]}` : "";
  return parts[0];
}

/* The psychologist's day at a glance, from their own records only (RLS limits every query to them).
   Every number is counted from real appointments, clients, recommendations and working hours.
   onOpenAppointment(row) opens the existing appointment details; onNavigate(section, options) switches section. */
export default function PsychologistOverview({ psychologistId, name, now, onNavigate, onOpenClient, onOpenAppointment }) {
  const [state, setState] = useState({ status: "loading", message: "" });
  const [appointments, setAppointments] = useState([]);
  const [clientCount, setClientCount] = useState(0);
  const [recommendations, setRecommendations] = useState([]);
  const [slotData, setSlotData] = useState({ periods: [], services: [], blocks: [] });

  useEffect(() => {
    if (!psychologistId) return undefined;
    let cancelled = false;
    const from = startOfWeek(new Date());
    from.setDate(from.getDate() - WEEKS_BACK * 7);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    Promise.all([
      listAppointments({ psychologistId, from }),
      listClients({ psychologistId }),
      listRecommendations({ psychologistId }),
    ])
      .then(([appts, clients, recs]) => {
        if (cancelled) return;
        setAppointments(appts);
        setClientCount(clients.filter((item) => item.is_active).length);
        setRecommendations(recs);
        setState({ status: "ready", message: "" });
      })
      .catch((error) => {
        console.error("Failed to load overview:", error);
        if (!cancelled) {
          setState({
            status: isMissingBackend(error) ? "missing" : "error",
            message: describeAppointmentError(error, "We couldn't load your day. Please try again."),
          });
        }
      });
    // Open time slots are optional: the rest of the page works without them.
    Promise.all([listAvailability(psychologistId), listServices({ activeOnly: true }), listBlocks({ psychologistId, from: today })])
      .then(([periods, services, blocks]) => {
        if (!cancelled) setSlotData({ periods, services, blocks });
      })
      .catch((error) => console.error("Failed to load working hours:", error));
    return () => {
      cancelled = true;
    };
  }, [psychologistId]);

  const stats = useMemo(() => {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrow = new Date(today.getTime() + DAY);
    const nextWeek = new Date(tomorrow.getTime() + 7 * DAY);
    const start = (item) => new Date(item.starts_at);

    const todays = appointments.filter((item) => start(item) >= today && start(item) < tomorrow).sort((a, b) => start(a) - start(b));
    const todaysActive = todays.filter(isActive);
    // The appointment happening now, or else the next one still to come today.
    const next =
      todaysActive.find((item) => start(item) <= now && new Date(item.ends_at) > now) ||
      todaysActive.find((item) => start(item) > now) ||
      null;
    const needsUpdate = appointments.filter((item) => isActive(item) && start(item) <= now).sort((a, b) => start(a) - start(b));
    const upcoming = appointments.filter((item) => isActive(item) && start(item) >= tomorrow).sort((a, b) => start(a) - start(b));
    const toReview = recommendations
      .filter((rec) => rec.status === "Open")
      .map((rec) => ({ ...rec, state: recommendationState(rec, now) === "overdue" ? "overdue" : "open" }))
      .sort((a, b) => String(a.recommended_date).localeCompare(String(b.recommended_date)));

    const count = (status) => appointments.filter((item) => item.status === status).length;
    const weeks = [];
    const first = startOfWeek(now);
    first.setDate(first.getDate() - WEEKS_BACK * 7);
    for (let i = 0; i < WEEKS_BACK + WEEKS_AHEAD; i += 1) {
      const weekStart = new Date(first.getFullYear(), first.getMonth(), first.getDate() + i * 7);
      const label = weekStart.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
      weeks.push({ key: weekStart.toISOString(), start: weekStart, label, full: `Week of ${label}`, booked: 0, completed: 0 });
    }
    appointments.forEach((item) => {
      if (item.status === "Rescheduled") return; // moved to a new appointment, counted there
      const time = start(item).getTime();
      const week = weeks.find((w) => time >= w.start.getTime() && time < w.start.getTime() + 7 * DAY);
      if (!week) return;
      week.booked += 1;
      if (item.status === "Completed") week.completed += 1;
    });

    // Open slots left today, using the shortest active session length (the same rule the booking screen uses).
    const shortest = slotData.services.reduce((best, item) => (!best || item.duration_minutes < best.duration_minutes ? item : best), null);
    const openSlots =
      shortest && slotData.periods.length
        ? slotsForDay(periodsFor(slotData.periods, psychologistId), today, appointments, {
            psychologistId,
            durationMinutes: shortest.duration_minutes,
            bufferMinutes: shortest.buffer_minutes,
            blocks: slotData.blocks,
            now,
          }).filter((slot) => slot.free).length
        : null;

    return {
      todays,
      todaysActive,
      next,
      needsUpdate,
      upcoming,
      upcomingWeek: upcoming.filter((item) => start(item) < nextWeek),
      toReview,
      overdueReview: toReview.filter((rec) => rec.state === "overdue"),
      completed: count("Completed"),
      cancelled: count("Cancelled"),
      missed: count("Missed"),
      rescheduled: count("Rescheduled"),
      awaitingConfirmation: count("Scheduled"),
      confirmed: count("Confirmed"),
      weeks,
      openSlots,
      slotLength: shortest ? shortest.duration_minutes : null,
    };
  }, [appointments, recommendations, slotData, now, psychologistId]);

  if (state.status === "missing") {
    return (
      <div className="notice" role="status">
        <Icon name="info" />
        <div>
          <strong>Your schedule isn&apos;t available yet</strong>
          Appointments will appear here once the clinic has finished setting up scheduling.
        </div>
      </div>
    );
  }

  const loading = state.status === "loading";
  const value = (n) => (loading || n === null ? "…" : n);
  const pendingCount = stats.needsUpdate.length + stats.overdueReview.length;
  const kpis = [
    { label: "Appointments today", value: stats.todaysActive.length, icon: "calendar", go: "calendar" },
    { label: "Next 7 days", value: stats.upcomingWeek.length, icon: "calendarCheck", go: "calendar" },
    { label: "Follow-ups to review", value: stats.toReview.length, icon: "note", go: "recommendations" },
    { label: "Open slots today", value: stats.openSlots, icon: "clock", go: "availability" },
    { label: "Sessions completed", value: stats.completed, icon: "checkCircle", go: "sessions" },
    { label: "Pending actions", value: pendingCount, icon: "alert", go: stats.needsUpdate.length ? "sessions" : "recommendations" },
  ];
  const statusRows = [
    { key: "Scheduled", label: "Awaiting confirmation", value: stats.awaitingConfirmation },
    { key: "Confirmed", label: "Confirmed", value: stats.confirmed },
    { key: "Completed", label: "Completed", value: stats.completed },
    { key: "Missed", label: "Missed", value: stats.missed },
    { key: "Cancelled", label: "Cancelled", value: stats.cancelled },
    { key: "Rescheduled", label: "Rescheduled", value: stats.rescheduled },
  ];
  const statusTotal = statusRows.reduce((sum, row) => sum + row.value, 0);
  const allClear = !loading && stats.todays.length === 0 && pendingCount === 0;

  return (
    <div className="dash">
      <section className="dash-hero" aria-label="Your day at a glance">
        <div className="dash-hero-main">
          <h1 className="dash-greeting">
            {getGreeting(now)}
            {greetingName(name) ? `, ${greetingName(name)}` : ""}!
          </h1>
          <p className="dash-date">
            Here&apos;s your day at a glance · {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
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
            {[
              clientCount ? `${clientCount} active client${clientCount === 1 ? "" : "s"}` : "",
              stats.slotLength ? `Open slots are for ${stats.slotLength}-minute sessions` : "",
              `Sessions completed covers the last ${WEEKS_BACK} weeks`,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="dash-hero-side">
          <RingGauge
            size={164}
            stroke={11}
            value={stats.completed}
            total={loading ? 0 : stats.completed + stats.missed}
            label="Attended"
            caption={
              stats.completed + stats.missed
                ? `${stats.completed} completed, ${stats.missed} missed (last ${WEEKS_BACK} weeks)`
                : "No completed or missed sessions yet"
            }
          />
        </div>
      </section>

      {state.status === "error" && (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <div>
            <strong>We couldn&apos;t load your day</strong>
            {state.message}
          </div>
        </div>
      )}

      <div className="dash-grid psych">
        <section className="dash-card" aria-labelledby="today-title">
          <header className="dash-card-head">
            <div>
              <h2 id="today-title">Today&apos;s schedule</h2>
              <p>
                {loading
                  ? "Loading your appointments…"
                  : stats.todays.length
                    ? `${stats.todaysActive.length} appointment${stats.todaysActive.length === 1 ? "" : "s"}, in time order.`
                    : "No appointments today."}
              </p>
            </div>
            <button type="button" className="dash-icon-btn round" onClick={() => onNavigate("calendar")} aria-label="Open your calendar" title="Open your calendar">
              <Icon name="arrowUpRight" />
            </button>
          </header>
          <div className="dash-card-body">
            {pendingCount > 0 && (
              <div className="notice warn" role="status">
                <Icon name="alert" />
                <div>
                  <strong>Waiting for you</strong>
                  <ul className="pending-list">
                    {stats.needsUpdate.slice(0, 4).map((item) => (
                      <li key={item.id}>
                        <span>
                          {item.client_name}&apos;s session on {formatDate(item.starts_at)} at {formatTime(item.starts_at)} has started. Mark it as completed or missed.
                        </span>
                        <button type="button" className="appt-btn" onClick={() => onOpenAppointment(item)}>
                          Update session
                        </button>
                      </li>
                    ))}
                    {stats.overdueReview.slice(0, 3).map((rec) => (
                      <li key={rec.id}>
                        <span>
                          A follow-up for {rec.client_name} was recommended for {formatDate(rec.recommended_date)} and is not booked yet.
                        </span>
                        <button type="button" className="appt-btn" onClick={() => onNavigate("recommendations", { focusId: rec.id })}>
                          View recommendation
                        </button>
                      </li>
                    ))}
                  </ul>
                  {pendingCount > 7 ? <small className="muted">And {pendingCount - 7} more.</small> : null}
                </div>
              </div>
            )}

            {allClear && (
              <div className="chart-empty">
                <strong>You&apos;re all caught up for today. Enjoy the extra time!</strong>
                <span>New appointments will appear here as soon as they are booked.</span>
              </div>
            )}

            {stats.todays.length > 0 && (
              <ul className="agenda">
                {stats.todays.map((item) => {
                  const isNext = stats.next && stats.next.id === item.id;
                  const inProgress = isNext && new Date(item.starts_at) <= now;
                  return (
                    <AgendaRow
                      key={item.id}
                      time={formatTime(item.starts_at)}
                      timeSub={`to ${formatTime(item.ends_at)}`}
                      title={item.client_name}
                      onTitle={() => onOpenClient(item.client_id)}
                      titleHint="View client profile"
                      flag={isNext ? <Badge tone="info">{inProgress ? "Now" : "Next"}</Badge> : null}
                      sub={sessionTypeLabel(item)}
                      status={<StatusPill status={item.status} label={appointmentStatusLabel(item.status)} />}
                      closed={!isActive(item)}
                      next={isNext}
                      actionLabel="View details"
                      actionHint={`View details of ${item.client_name}'s appointment`}
                      onAction={() => onOpenAppointment(item)}
                    />
                  );
                })}
              </ul>
            )}
          </div>
        </section>

        <section className="dash-card" aria-labelledby="upcoming-title">
          <header className="dash-card-head">
            <div>
              <h2 id="upcoming-title">Your upcoming appointments</h2>
              <p>Booked after today.</p>
            </div>
          </header>
          <div className="dash-card-body">
            {stats.upcoming.length === 0 ? (
              <p className="appt-empty">{loading ? "Loading…" : "No appointments booked after today yet."}</p>
            ) : (
              <ul className="agenda">
                {stats.upcoming.slice(0, 5).map((item) => (
                  <AgendaRow
                    key={item.id}
                    time={new Date(item.starts_at).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}
                    timeSub={formatTime(item.starts_at)}
                    title={item.client_name}
                    onTitle={() => onOpenClient(item.client_id)}
                    titleHint="View client profile"
                    sub={sessionTypeLabel(item)}
                    status={<StatusPill status={item.status} label={appointmentStatusLabel(item.status)} />}
                    actionLabel="View"
                    actionHint={`View ${item.client_name}'s appointment`}
                    onAction={() => onOpenAppointment(item)}
                  />
                ))}
              </ul>
            )}
            {stats.upcoming.length > 5 && (
              <button type="button" className="link-btn" onClick={() => onNavigate("calendar")}>
                See all {stats.upcoming.length} in your calendar
              </button>
            )}
          </div>
        </section>

        <section className="dash-card" aria-labelledby="review-title">
          <header className="dash-card-head">
            <div>
              <h2 id="review-title">Follow-ups to review</h2>
              <p>Recommended, not booked yet.</p>
            </div>
            <button type="button" className="dash-icon-btn round" onClick={() => onNavigate("recommendations")} aria-label="Open all follow-ups" title="Open all follow-ups">
              <Icon name="arrowUpRight" />
            </button>
          </header>
          <div className="dash-card-body">
            {stats.toReview.length === 0 ? (
              <p className="appt-empty">{loading ? "Loading…" : "Nothing to review. Follow-ups you recommend stay here until they are booked."}</p>
            ) : (
              <ul className="agenda">
                {stats.toReview.slice(0, 5).map((rec) => (
                  <AgendaRow
                    key={rec.id}
                    title={rec.client_name}
                    onTitle={() => onOpenClient(rec.client_id)}
                    titleHint="View client profile"
                    sub={`For ${formatDate(rec.recommended_date)}${rec.recommended_time ? `, ${String(rec.recommended_time).slice(0, 5)}` : ""}`}
                    status={<FollowUpStateBadge state={rec.state} />}
                    actionLabel="View"
                    actionHint={`View the follow-up recommended for ${rec.client_name}`}
                    onAction={() => onNavigate("recommendations", { focusId: rec.id })}
                  />
                ))}
              </ul>
            )}
          </div>
        </section>
      </div>

      <div className="dash-grid halves">
        <section className="dash-card">
          <header className="dash-card-head">
            <div>
              <h2>Appointments per week</h2>
              <p>Appointments booked each week, and how many sessions were completed.</p>
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
              emptyTitle={loading ? "Loading…" : "No appointments in these weeks"}
              emptyText={loading ? "" : "Your booked appointments will show here."}
            />
          </div>
        </section>

        <section className="dash-card">
          <header className="dash-card-head">
            <div>
              <h2>Where your appointments stand</h2>
              <p>Appointments from the last {WEEKS_BACK} weeks and everything booked ahead.</p>
            </div>
          </header>
          <div className="dash-card-body">
            <BarList rows={statusRows} total={statusTotal} emptyTitle={loading ? "Loading…" : "No appointments yet"} emptyText="" ariaLabel="Appointments by status" />
          </div>
        </section>
      </div>
    </div>
  );
}
