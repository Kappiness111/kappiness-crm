"use client";

import { useEffect, useRef, useState } from "react";
import Icon from "../Icon";
import StatusBadge from "../StatusBadge";
import ReminderUpdateDialog from "../followups/ReminderUpdateDialog";
import { listDueReminders } from "../../lib/remindersApi";
import { listRecommendations } from "../../lib/sessionsApi";
import { APPOINTMENT_STATUS_LABEL } from "../../lib/statusLabels";
import { CountUp, Ring, SlotBar } from "../ui/MiniCharts";

/* Staff dashboard: what needs attention today.
   Search · five summary cards · lead follow-up calls · psychologist availability · today's appointments ·
   follow-up reminders · quick actions · recent activity. Every number comes from the CRM records. */

const tel = (phone) => `tel:${String(phone || "").replace(/[^\d+]/g, "")}`;
const whatsapp = (phone) => {
  let digits = String(phone || "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`;
  return `https://wa.me/${digits}`;
};
const clock = (value) => new Date(value).toLocaleTimeString("en-GB", { hour: "numeric", minute: "2-digit", hour12: true });
const shortDay = (value) => new Date(value).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const initials = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");
const digitsOf = (value) => String(value || "").replace(/\D/g, "");
const firstNameOf = (name) => String(name || "").replace(/^(dr|mr|mrs|ms|prof).?s+/i, "").split(/s+/)[0] || "Psychologist";
function ago(value, now) {
  const minutes = Math.max(0, Math.round((now - new Date(value)) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? "yesterday" : `${days} days ago`;
}

function useOutside(ref, open, close) {
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event) => ref.current && !ref.current.contains(event.target) && close();
    const onKey = (event) => event.key === "Escape" && close();
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [ref, open, close]);
}

function Card({ icon, title, action, onAction, className = "", children }) {
  return (
    <section className={`cd-card ${className}`} aria-label={title}>
      <header className="cd-card-head">
        <h2>
          <span className="cd-head-icon" aria-hidden="true">
            <Icon name={icon} />
          </span>
          {title}
        </h2>
        {action ? (
          <button type="button" className="cd-link" onClick={onAction}>
            {action} <Icon name="arrowRight" />
          </button>
        ) : null}
      </header>
      {children}
    </section>
  );
}

/* Search leads, clients and appointments from one box. */
function GlobalSearch({ leads, clients, appointments, onOpenLead, onOpenClient, onOpenAppointments }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  useOutside(wrapRef, open, () => setOpen(false));
  const term = query.trim().toLowerCase();
  const digits = digitsOf(term);
  const hit = (name, phone, extra = "") =>
    String(name || "").toLowerCase().includes(term) || String(extra).toLowerCase().includes(term) || (digits.length >= 3 && digitsOf(phone).includes(digits));
  const results = term
    ? [
        ...leads.filter((l) => hit(l.full_name, l.phone, l.lead_code)).slice(0, 4).map((l) => ({ kind: "Lead", key: `l${l.id}`, title: l.full_name, sub: [l.lead_code, l.phone].filter(Boolean).join(" · "), badge: l.status, run: () => onOpenLead(l) })),
        ...clients.filter((c) => hit(c.full_name, c.phone)).slice(0, 3).map((c) => ({ kind: "Client", key: `c${c.id}`, title: c.full_name, sub: c.phone || "Client", run: () => onOpenClient(c.id) })),
        ...appointments
          .filter((a) => hit(a.client_name, a.client_phone))
          .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))
          .slice(0, 3)
          .map((a) => ({ kind: "Appointment", key: `a${a.id}`, title: a.client_name, sub: `${shortDay(a.starts_at)}, ${clock(a.starts_at)} · ${APPOINTMENT_STATUS_LABEL[a.status] || a.status}`, run: onOpenAppointments })),
      ]
    : [];
  return (
    <div className="cd-search" ref={wrapRef}>
      <Icon name="search" />
      <input
        type="search"
        placeholder="Search leads, clients, appointments…"
        aria-label="Search leads, clients and appointments"
        value={query}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
        }}
      />
      {open && term ? (
        <div className="cd-search-results" role="listbox" aria-label="Search results">
          {results.length === 0 ? <p className="cd-muted">Nothing matches “{query.trim()}”.</p> : null}
          {results.map((r) => (
            <button
              key={r.key}
              type="button"
              role="option"
              aria-selected="false"
              className="cd-result"
              onClick={() => {
                setOpen(false);
                setQuery("");
                r.run();
              }}
            >
              <span className={`cd-avatar kind-${r.kind.toLowerCase()}`} aria-hidden="true">
                {initials(r.title)}
              </span>
              <span className="cd-result-text">
                <strong>{r.title}</strong>
                <small>{r.sub}</small>
              </span>
              {r.badge ? <StatusBadge status={r.badge} /> : <span className="cd-kind">{r.kind}</span>}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* Pick a lead or client, then call or message them. */
function ContactPicker({ mode, people, onClose }) {
  const [query, setQuery] = useState("");
  const term = query.trim().toLowerCase();
  const digits = digitsOf(term);
  const matches = term
    ? people.filter((p) => p.phone && (p.name.toLowerCase().includes(term) || (digits.length >= 3 && digitsOf(p.phone).includes(digits)))).slice(0, 6)
    : people.filter((p) => p.phone).slice(0, 5);
  return (
    <div className="cd-picker" role="dialog" aria-label={mode === "call" ? "Call a lead or client" : "Message a lead or client"}>
      <div className="cd-picker-head">
        <strong>{mode === "call" ? "Who do you want to call?" : "Who do you want to message?"}</strong>
        <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
          <Icon name="close" />
        </button>
      </div>
      <label className="cd-search is-small">
        <Icon name="search" />
        <span className="sr-only">Search</span>
        <input autoFocus type="search" placeholder="Name or phone number" value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      {term && matches.length === 0 ? <p className="cd-muted">Nobody with a phone number matches.</p> : null}
      <ul className="cd-picker-list">
        {matches.map((p) => (
          <li key={`${p.kind}-${p.id}`}>
            <a href={mode === "call" ? tel(p.phone) : whatsapp(p.phone)} target={mode === "call" ? undefined : "_blank"} rel="noreferrer">
              <span className="cd-avatar" aria-hidden="true">
                {initials(p.name)}
              </span>
              <span className="cd-result-text">
                <strong>{p.name}</strong>
                <small>
                  {p.phone} · {p.kind}
                </small>
              </span>
              <Icon name={mode === "call" ? "phone" : "chat"} />
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Availability({ days, onSeeSchedule }) {
  const working = days.filter((d) => d.working);
  if (working.length === 0) {
    return (
      <div className="cd-avail is-empty">
        <p className="cd-muted">No psychologist is working today.</p>
        <button type="button" className="cd-pill-btn" onClick={onSeeSchedule}>
          Open Availability &amp; Leave
        </button>
      </div>
    );
  }
  const sorted = [...working].sort((x, y) => Number(x.onLeave) - Number(y.onLeave) || y.available - x.available);
  return (
    <div className="cd-psy">
      <ul className="cd-psy-list">
        {sorted.slice(0, 5).map((d) => {
          const waiting = d.dayAppointments.filter((item) => item.status === "Scheduled").length;
          const confirmed = Math.max(0, d.booked - waiting);
          return (
            <li key={d.psychologist.id} className={d.onLeave ? "is-leave" : ""}>
              <div className="cd-psy-top">
                <strong>{d.psychologist.name || "Psychologist"}</strong>
                <span className={`cd-psy-free ${d.onLeave ? "is-leave" : d.available ? "is-ok" : "is-full"}`}>
                  {d.onLeave ? "On leave" : d.available ? `${d.available} free` : "Full"}
                </span>
              </div>
              <SlotBar
                label={`${d.booked} of ${d.capacity} slots booked`}
                parts={
                  d.onLeave
                    ? [{ value: 1, tone: "late" }]
                    : [
                        { value: confirmed, tone: "ok" },
                        { value: waiting, tone: "wait" },
                        { value: d.available, tone: "free" },
                      ]
                }
              />
              <small className="cd-muted">
                {d.hours || "Working today"} · {d.booked} of {d.capacity} booked
              </small>
            </li>
          );
        })}
      </ul>
      {sorted.length > 5 ? <p className="cd-muted">+{sorted.length - 5} more psychologists</p> : null}
      <button type="button" className="cd-pill-btn" onClick={onSeeSchedule}>
        View schedule <Icon name="arrowRight" />
      </button>
    </div>
  );
}

/* Decoration for the greeting band: faint contour lines across it. Hidden from screen readers. */
function HeroArt() {
  const contours = [0, 1, 2, 3, 4, 5, 6];
  return (
    <>
      <svg className="cd-hero-lines" viewBox="0 0 1200 360" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
        {contours.map((i) => (
          <path
            key={i}
            d={`M-60 ${250 - i * 34} C 180 ${170 - i * 30}, 330 ${330 - i * 36}, 600 ${250 - i * 32} S 1010 ${180 - i * 30}, 1260 ${270 - i * 34}`}
          />
        ))}
      </svg>
    </>
  );
}

/* Appointments booked for each of the next seven days, today first. */
function WeekBars({ appointments, now }) {
  const [hover, setHover] = useState(null);
  const [grown, setGrown] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setGrown(true));
    return () => cancelAnimationFrame(id);
  }, []);
  if (!now) return null;
  const days = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() + i);
    const next = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);
    const count = appointments.filter((a) => ["Scheduled", "Confirmed", "Completed"].includes(a.status) && new Date(a.starts_at) >= day && new Date(a.starts_at) < next).length;
    return { key: day.toDateString(), label: i === 0 ? "Today" : day.toLocaleDateString("en-GB", { weekday: "short" }), date: day, count };
  });
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((sum, d) => sum + d.count, 0);
  return (
    <div className="cd-week" aria-label={`${total} appointments in the next 7 days`}>
      <div className="cd-week-head">
        <span>Next 7 days</span>
        <b>
          <CountUp value={total} /> <small>appointments</small>
        </b>
      </div>
      <div className="cd-week-bars" onMouseLeave={() => setHover(null)}>
        {days.map((d, i) => (
          <div key={d.key} className={`cd-week-col ${i === 0 ? "is-today" : ""}`} onMouseEnter={() => setHover(i)}>
            <span className="cd-week-n">{hover === i || (hover === null && i === 0) ? d.count : ""}</span>
            <span className="cd-week-track">
              <span className="cd-week-fill" style={{ height: grown ? `${Math.max(6, (d.count / max) * 100)}%` : "0%", transitionDelay: `${i * 60}ms` }} />
            </span>
            <span className="cd-week-label">{d.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function ClinicDashboard({
  now,
  greeting,
  firstName,
  leads,
  leadsLoading,
  clients,
  appointments,
  schedulingReady,
  todayDays,
  activityLog,
  canBook,
  onAddLead,
  onBook,
  onOpenLead,
  onOpenClient,
  onSeeCalls,
  onSeeCalendar,
  onSeeAppointments,
  onSeeSchedule,
  onSeeFollowUps,
  notify,
}) {
  const [reminders, setReminders] = useState({ status: "loading", rows: [], allowed: true });
  const [recs, setRecs] = useState({ status: "loading", rows: [] });
  const [reload, setReload] = useState(0);
  const [recording, setRecording] = useState(null);
  const [picker, setPicker] = useState(null); // "call" | "message"
  const pickerRef = useRef(null);
  useOutside(pickerRef, Boolean(picker), () => setPicker(null));

  useEffect(() => {
    if (!now) return undefined;
    let cancelled = false;
    listDueReminders()
      .then((r) => !cancelled && setReminders({ status: "ready", rows: r.rows, allowed: r.allowed }))
      .catch((error) => {
        console.error("Failed to load reminders:", error);
        if (!cancelled) setReminders({ status: "error", rows: [], allowed: true });
      });
    listRecommendations({ statuses: ["Open"] })
      .then((rows) => !cancelled && setRecs({ status: "ready", rows }))
      .catch((error) => {
        console.error("Failed to load recommendations:", error);
        if (!cancelled) setRecs({ status: "error", rows: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [now, reload]);

  const startOfDay = now ? new Date(now.getFullYear(), now.getMonth(), now.getDate()) : null;
  const endOfDay = now ? new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1) : null;

  // Calls: open leads whose follow-up is due by the end of today (late ones first)
  const calls = now
    ? leads
        .filter((l) => l.next_follow_up_at && l.status !== "Confirmed" && l.status !== "Lost" && new Date(l.next_follow_up_at) < endOfDay)
        .map((l) => ({ lead: l, at: new Date(l.next_follow_up_at), late: new Date(l.next_follow_up_at) < now }))
        .sort((a, b) => Number(b.late) - Number(a.late) || a.at - b.at)
    : [];
  const lateCalls = calls.filter((c) => c.late).length;

  // Today's appointments and the next 7 days' confirmation rate
  const todays = now
    ? appointments
        .filter((a) => new Date(a.starts_at) >= startOfDay && new Date(a.starts_at) < endOfDay && a.status !== "Rescheduled")
        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))
    : [];
  const dayParts = [
    ["ok", "Confirmed", todays.filter((item) => item.status === "Confirmed").length],
    ["wait", "Awaiting", todays.filter((item) => item.status === "Scheduled").length],
    ["brand", "Completed", todays.filter((item) => item.status === "Completed").length],
    ["late", "Cancelled or missed", todays.filter((item) => item.status === "Cancelled" || item.status === "Missed").length],
  ];
  const weekEnd = now ? new Date(startOfDay.getTime() + 7 * 86400000) : null;
  const upcoming = now ? appointments.filter((a) => (a.status === "Scheduled" || a.status === "Confirmed") && new Date(a.starts_at) >= startOfDay && new Date(a.starts_at) < weekEnd) : [];
  const confirmedUpcoming = upcoming.filter((a) => a.status === "Confirmed").length;
  const rate = upcoming.length ? Math.round((confirmedUpcoming / upcoming.length) * 100) : null;

  const availableToday = todayDays.filter((d) => d.working && !d.onLeave);
  const dueReminders = reminders.rows.map((r) => ({ row: r, at: new Date(r.due_at), late: now && new Date(r.due_at) < now }));

  // Recent activity: lead notes and calls, new leads, bookings
  const leadName = Object.fromEntries(leads.map((l) => [l.id, l.full_name]));
  const activity = now
    ? [
        ...activityLog.slice(0, 40).map((a, i) => ({
          key: `act${i}`,
          at: a.occurred_at,
          tone: "blue",
          text: `${a.activity_type || "Update"}${leadName[a.lead_id] ? `: ${leadName[a.lead_id]}` : ""}`,
          who: a.staff_member,
        })),
        ...leads.filter((l) => l.created_at).slice(0, 40).map((l) => ({ key: `lead${l.id}`, at: l.created_at, tone: "green", text: `New lead: ${l.full_name}`, who: "" })),
        ...appointments.filter((a) => a.created_at).slice(-40).map((a) => ({ key: `ap${a.id}`, at: a.created_at, tone: "amber", text: `Appointment booked: ${a.client_name}`, who: "" })),
      ]
        .filter((a) => a.at && new Date(a.at) <= now)
        .sort((a, b) => new Date(b.at) - new Date(a.at))
        .slice(0, 5)
    : [];

  const people = [
    ...clients.map((c) => ({ id: c.id, name: c.full_name, phone: c.phone, kind: "Client" })),
    ...leads.filter((l) => l.status !== "Confirmed").map((l) => ({ id: l.id, name: l.full_name || "Lead", phone: l.phone, kind: "Lead" })),
  ];

  const loading = (v) => (v === null ? "…" : v);
  const kpis = [
    {
      key: "calls",
      tint: "blue",
      icon: "phone",
      value: leadsLoading ? null : calls.length,
      label: "Leads to call today",
      tag: lateCalls ? { tone: "danger", text: `${lateCalls} overdue` } : null,
      action: "View calls",
      onClick: onSeeCalls,
    },
    {
      key: "reminders",
      tint: "green",
      icon: "bell",
      value: reminders.status === "loading" ? null : reminders.rows.length,
      label: "Follow-up reminders due",
      tag: null,
      action: "View all",
      onClick: () => onSeeFollowUps("action"),
    },
    {
      key: "psy",
      tint: "blue",
      icon: "users",
      value: schedulingReady ? availableToday.length : null,
      label: `Psychologist${availableToday.length === 1 ? "" : "s"} available today`,
      tag: availableToday[0] ? { tone: "ok", text: availableToday.map((d) => firstNameOf(d.psychologist.name)).slice(0, 2).join(", ") + (availableToday.length > 2 ? ` +${availableToday.length - 2}` : "") } : null,
      action: "View schedule",
      onClick: onSeeSchedule,
    },
    {
      key: "recs",
      tint: "amber",
      icon: "clipboard",
      value: recs.status === "loading" ? null : recs.rows.length,
      label: "Sessions recommended, not booked",
      tag: null,
      action: "View details",
      onClick: () => onSeeFollowUps("open"),
    },
    {
      key: "rate",
      tint: "green",
      icon: "checkCircle",
      value: schedulingReady ? (rate === null ? "—" : rate) : null,
      suffix: "%",
      ring: schedulingReady && rate !== null ? rate : null,
      label: "Appointments confirmed",
      tag: upcoming.length ? { tone: "plain", text: `${confirmedUpcoming} of ${upcoming.length} this week` } : null,
      action: "View appointments",
      onClick: onSeeAppointments,
    },
  ];

  return (
    <div className="cd">
      <section className="cd-hero">
        <HeroArt />
        <div className="cd-hero-main">
          <div className="cd-top">
            <GlobalSearch leads={leads} clients={clients} appointments={appointments} onOpenLead={onOpenLead} onOpenClient={onOpenClient} onOpenAppointments={onSeeAppointments} />
            <span className="cd-date">
              <Icon name="calendar" />
              {now ? now.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", year: "numeric" }) : ""}
            </span>
          </div>
    
          <header className="cd-hello">
            <h1>
              {greeting}
              {firstName ? `, ${firstName}` : ""}
            </h1>
            <p>Here&apos;s what needs your attention today.</p>
          </header>
        </div>
        <WeekBars appointments={appointments} now={now} />
      </section>

      <div className="cd-kpis">
        {kpis.map((k) => (
          <button key={k.key} type="button" className={`cd-kpi tint-${k.tint}`} onClick={k.onClick}>
            <span className="cd-kpi-row">
              {k.ring !== null && k.ring !== undefined ? (
                <Ring size={34} stroke={4} total={100} segments={[{ value: k.ring, tone: "ok" }]} label={`${k.ring}% confirmed`} />
              ) : (
                <span className="cd-kpi-icon" aria-hidden="true">
                  <Icon name={k.icon} />
                </span>
              )}
              <span className="cd-kpi-text">
                <b>{k.value === null ? "…" : <CountUp value={k.value} suffix={k.suffix || ""} />}</b>
                <span>{k.label}</span>
              </span>
            </span>
            {k.tag ? (
              <span className={`cd-tag tone-${k.tag.tone}`}>
                {k.tag.tone === "danger" ? <Icon name="alert" /> : k.tag.tone === "ok" ? <i aria-hidden="true" /> : null}
                {k.tag.text}
              </span>
            ) : null}
            <span className="cd-kpi-foot">
              <span className="cd-kpi-go">
                {k.action} <Icon name="arrowRight" />
              </span>
            </span>
          </button>
        ))}
      </div>

      <div className="cd-row cd-row-a">
        <Card icon="phone" title="Lead follow-up calls" action="View all" onAction={onSeeCalls} className="cd-calls">
          {calls.length > 0 ? (
            <p className={`cd-alert ${lateCalls ? "is-danger" : ""}`}>
              <Icon name={lateCalls ? "alert" : "clock"} />
              {calls.length} lead{calls.length === 1 ? " needs" : "s need"} a call today{lateCalls ? `, ${lateCalls} overdue` : ""}
            </p>
          ) : null}
          {leadsLoading ? <p className="cd-muted">Loading…</p> : null}
          {!leadsLoading && calls.length === 0 ? (
            <p className="cd-done">
              <Icon name="checkCircle" /> No calls due today.
            </p>
          ) : null}
          {calls.length > 0 ? (
            <div className="cd-table-wrap">
              <table className="cd-table">
                <thead>
                  <tr>
                    <th scope="col">Lead</th>
                    <th scope="col">Status</th>
                    <th scope="col">Priority</th>
                    <th scope="col" className="cd-right">
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {calls.slice(0, 5).map(({ lead, at, late }) => (
                    <tr key={lead.id}>
                      <td>
                        <button type="button" className="cd-name" onClick={() => onOpenLead(lead)}>
                          {lead.full_name}
                        </button>
                        <small className="cd-sub">
                          {lead.phone ? `${lead.phone} · ` : ""}
                          {late ? `was due ${shortDay(at)}, ${clock(at)}` : `today, ${clock(at)}`}
                        </small>
                      </td>
                      <td>
                        <StatusBadge status={lead.status} />
                      </td>
                      <td>
                        <span className={`cd-prio ${late ? "is-high" : "is-medium"}`}>{late ? "High" : "Medium"}</span>
                      </td>
                      <td className="cd-right">
                        {lead.phone ? (
                          <a className="cd-call" href={tel(lead.phone)} aria-label={`Call ${lead.full_name}`} title={`Call ${lead.phone}`}>
                            <Icon name="phone" />
                            <span>Call</span>
                          </a>
                        ) : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : null}
        </Card>

        <Card icon="userCheck" title="Psychologist availability" className="cd-avail-card">
          {schedulingReady ? <Availability days={todayDays} onSeeSchedule={onSeeSchedule} /> : <p className="cd-muted">Loading…</p>}
        </Card>

        <Card icon="calendar" title="Appointments today" action="View calendar" onAction={onSeeCalendar}>
          {!schedulingReady ? <p className="cd-muted">Loading…</p> : null}
          {schedulingReady && todays.length === 0 ? <p className="cd-muted">No appointments today.</p> : null}
          {schedulingReady && todays.length > 0 ? (
            <div className="cd-day-ring">
              <Ring size={84} stroke={9} label={`${todays.length} appointments today`} segments={dayParts.map(([tone, , n]) => ({ value: n, tone }))}>
                <b>
                  <CountUp value={todays.length} />
                </b>
                <small>today</small>
              </Ring>
              <ul className="cd-legend">
                {dayParts
                  .filter(([, , n]) => n > 0)
                  .map(([tone, text, n]) => (
                    <li key={tone}>
                      <i className={`tone-${tone}`} aria-hidden="true" />
                      {text}
                      <b>{n}</b>
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}
          <ol className="cd-timeline">
            {todays.slice(0, 5).map((a) => (
              <li key={a.id} className={a.status === "Cancelled" || a.status === "Missed" ? "is-dim" : ""}>
                <span className="cd-time">{clock(a.starts_at)}</span>
                <span className="cd-dot" aria-hidden="true" />
                <span className="cd-tl-text">
                  <strong>{a.client_name}</strong>
                  <small>{a.service_type || "Session"}</small>
                </span>
                <span className={`cd-status st-${String(a.status).toLowerCase()}`} title={APPOINTMENT_STATUS_LABEL[a.status] || a.status}>
                  {a.status === "Scheduled" ? "Awaiting" : APPOINTMENT_STATUS_LABEL[a.status] || a.status}
                </span>
              </li>
            ))}
          </ol>
          {todays.length > 5 ? (
            <button type="button" className="cd-link is-block" onClick={onSeeAppointments}>
              +{todays.length - 5} more today
            </button>
          ) : null}
        </Card>
      </div>

      <div className="cd-row cd-row-b">
        <Card icon="bell" title="Follow-up reminders" action="View all" onAction={() => onSeeFollowUps("action")}>
          {reminders.status === "loading" ? <p className="cd-muted">Loading…</p> : null}
          {reminders.status === "error" ? (
            <p className="cd-muted">
              Reminders couldn&apos;t load.{" "}
              <button type="button" className="link-btn" onClick={() => setReload((n) => n + 1)}>
                Try again
              </button>
            </p>
          ) : null}
          {reminders.status === "ready" && !reminders.allowed ? <p className="cd-muted">Reminders are handled by the front desk.</p> : null}
          {reminders.status === "ready" && reminders.allowed && dueReminders.length === 0 ? (
            <p className="cd-done">
              <Icon name="checkCircle" /> No reminders to send today.
            </p>
          ) : null}
          <ul className="cd-list">
            {dueReminders.slice(0, 4).map(({ row, late }) => (
              <li key={row.id}>
                <span className={`cd-list-icon ${late ? "is-late" : ""}`} aria-hidden="true">
                  <Icon name="bell" />
                </span>
                <span className="cd-list-text">
                  <strong>
                    Reminder {row.reminder_number} for {row.appointment.client?.full_name || "client"}
                  </strong>
                  <small>
                    Session {shortDay(row.appointment.starts_at)}, {clock(row.appointment.starts_at)}
                  </small>
                </span>
                <span className={`cd-prio ${late ? "is-high" : "is-medium"}`}>{late ? "Due now" : `By ${clock(row.due_at)}`}</span>
                <button type="button" className="cd-mini" onClick={() => setRecording(row)}>
                  Mark sent
                </button>
              </li>
            ))}
          </ul>
        </Card>

        <Card icon="sparkle" title="Quick actions" className="cd-quick">
          <div className="cd-actions" ref={pickerRef}>
            <button type="button" className="cd-action" onClick={() => setPicker(picker === "call" ? null : "call")} aria-expanded={picker === "call"}>
              <Icon name="phone" />
              Call lead
            </button>
            {canBook ? (
              <button type="button" className="cd-action" onClick={onBook}>
                <Icon name="calendarCheck" />
                Book appointment
              </button>
            ) : null}
            <button type="button" className="cd-action" onClick={() => setPicker(picker === "message" ? null : "message")} aria-expanded={picker === "message"}>
              <Icon name="chat" />
              Send message
            </button>
            <button type="button" className="cd-action" onClick={onAddLead}>
              <Icon name="plus" />
              Add lead
            </button>
            {picker ? <ContactPicker mode={picker} people={people} onClose={() => setPicker(null)} /> : null}
          </div>
        </Card>

        <Card icon="activity" title="Recent activity">
          {activity.length === 0 ? <p className="cd-muted">Nothing yet today.</p> : null}
          <ul className="cd-activity">
            {activity.map((a) => (
              <li key={a.key}>
                <i className={`tone-${a.tone}`} aria-hidden="true" />
                <span className="cd-act-text">
                  {a.text}
                  {a.who ? <small> · {a.who}</small> : null}
                </span>
                <time dateTime={a.at}>{ago(a.at, now)}</time>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {recording && (
        <ReminderUpdateDialog
          reminder={recording}
          mode="delivery"
          clientName={recording.appointment.client?.full_name || "Client"}
          onClose={() => setRecording(null)}
          onSaved={(_saved, value) => {
            notify(`Reminder ${recording.reminder_number} marked ${String(value).toLowerCase()}.`);
            setRecording(null);
            setReload((n) => n + 1);
          }}
        />
      )}
    </div>
  );
}
