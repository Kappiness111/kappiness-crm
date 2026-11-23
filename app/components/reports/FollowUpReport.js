"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import { APPOINTMENT_STATUSES, describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import { formatDate, formatTime } from "../../lib/leads";
import { listRecommendations } from "../../lib/sessionsApi";

const STATUS_HELP = {
  Scheduled: "Booked, client has not confirmed yet",
  Confirmed: "Booked and confirmed by the client",
  Rescheduled: "Moved to another time (the new booking is counted separately)",
  Completed: "The client attended",
  Cancelled: "Cancelled before it took place",
  Missed: "The client did not attend",
};

function dateKey(value) {
  const d = new Date(value);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/* Total Follow-up Sessions report. A follow-up session is a booked appointment that came from a psychologist's
   recommendation (appointments.recommendation_id). Every booking counts once; a rescheduled booking counts as
   Rescheduled and its replacement counts under its own status. Totals are counted from real records in the browser. */
export default function FollowUpReport({ psychologistNames = {}, onOpenClient }) {
  const [data, setData] = useState({ status: "loading", message: "", rows: [], notBooked: [] });
  const [reload, setReload] = useState(0);
  const [search, setSearch] = useState("");
  const [psychologist, setPsychologist] = useState("all");
  const [status, setStatus] = useState("all");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  useEffect(() => {
    let cancelled = false;
    Promise.all([listAppointments({ followUpsOnly: true }), listRecommendations({ statuses: ["Open"] })])
      .then(([rows, notBooked]) => {
        if (!cancelled) setData({ status: "ready", message: "", rows, notBooked });
      })
      .catch((error) => {
        console.error("Failed to load the follow-up report:", error);
        if (!cancelled) setData({ status: "error", message: describeAppointmentError(error, "We couldn't load the report."), rows: [], notBooked: [] });
      });
    return () => {
      cancelled = true;
    };
  }, [reload]);

  // Filters other than status: the summary cards then show the status split of what is selected.
  const scoped = useMemo(() => {
    const term = search.trim().toLowerCase();
    return data.rows.filter((row) => {
      if (psychologist !== "all" && String(row.psychologist_id) !== psychologist) return false;
      const day = dateKey(row.starts_at);
      if (from && day < from) return false;
      if (to && day > to) return false;
      if (!term) return true;
      return [row.client_name, row.service_type, psychologistNames[row.psychologist_id]].some((field) => String(field || "").toLowerCase().includes(term));
    });
  }, [data.rows, psychologist, from, to, search, psychologistNames]);
  const visible = useMemo(
    () => (status === "all" ? scoped : scoped.filter((row) => row.status === status)).sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at)),
    [scoped, status]
  );

  const counts = useMemo(() => {
    const map = {};
    APPOINTMENT_STATUSES.forEach((key) => {
      map[key] = scoped.filter((row) => row.status === key).length;
    });
    return map;
  }, [scoped]);

  const byPsychologist = useMemo(() => {
    const map = new Map();
    scoped.forEach((row) => {
      const id = String(row.psychologist_id);
      const entry = map.get(id) || { id, total: 0, ...Object.fromEntries(APPOINTMENT_STATUSES.map((key) => [key, 0])) };
      entry.total += 1;
      entry[row.status] += 1;
      map.set(id, entry);
    });
    return [...map.values()].sort((a, b) => b.total - a.total);
  }, [scoped]);
  const peak = Math.max(1, ...byPsychologist.map((row) => row.total));
  const psychologistIds = [...new Set(data.rows.map((row) => String(row.psychologist_id)))];
  const filtered = search || psychologist !== "all" || status !== "all" || from || to;

  if (data.status === "loading") return <p className="appt-empty">Loading the follow-up report…</p>;
  if (data.status === "error") {
    return (
      <div className="panel">
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>We couldn&apos;t load the report</strong>
          <span>{data.message}</span>
          <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  return (
    <>
      <section className="kpis" aria-label="Follow-up sessions by status">
        <button type="button" className="kpi" onClick={() => setStatus("all")} aria-pressed={status === "all"}>
          <span className="kpi-label">Total follow-up sessions</span>
          <span className="kpi-value">{scoped.length}</span>
          <span className="kpi-meta">Booked follow-ups{filtered ? " matching your filters" : ""}</span>
        </button>
        {APPOINTMENT_STATUSES.map((key) => (
          <button key={key} type="button" className="kpi" onClick={() => setStatus(key)} aria-pressed={status === key} title={STATUS_HELP[key]}>
            <span className="kpi-label">{key}</span>
            <span className="kpi-value">{counts[key]}</span>
            <span className="kpi-meta">{STATUS_HELP[key]}</span>
          </button>
        ))}
      </section>
      <p className="subtle-text report-note">
        Each booking of a recommended follow-up counts once. {data.notBooked.length} more follow-up
        {data.notBooked.length === 1 ? " is" : "s are"} recommended but not booked yet, so not counted above.
      </p>

      <div className="toolbar report-toolbar">
        <label className="search">
          <Icon name="search" />
          <span className="sr-only">Search follow-up sessions</span>
          <input type="search" placeholder="Search client, psychologist or service" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select value={psychologist} onChange={(event) => setPsychologist(event.target.value)} aria-label="Psychologist">
          <option value="all">All psychologists</option>
          {psychologistIds.map((id) => (
            <option key={id} value={id}>
              {psychologistNames[id] || "Psychologist"}
            </option>
          ))}
        </select>
        <select value={status} onChange={(event) => setStatus(event.target.value)} aria-label="Status">
          <option value="all">All statuses</option>
          {APPOINTMENT_STATUSES.map((key) => (
            <option key={key} value={key}>
              {key}
            </option>
          ))}
        </select>
        <label className="date-filter">
          <span>From</span>
          <input type="date" value={from} max={to || undefined} onChange={(event) => setFrom(event.target.value)} />
        </label>
        <label className="date-filter">
          <span>To</span>
          <input type="date" value={to} min={from || undefined} onChange={(event) => setTo(event.target.value)} />
        </label>
        {filtered && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              setSearch("");
              setPsychologist("all");
              setStatus("all");
              setFrom("");
              setTo("");
            }}
          >
            Clear filters
          </button>
        )}
      </div>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Follow-up sessions per psychologist</h2>
            <p>Select a psychologist to see only their sessions below.</p>
          </div>
        </div>
        <div className="panel">
          {byPsychologist.length === 0 ? (
            <p className="appt-empty">No follow-up sessions match these filters.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Psychologist</th>
                    <th scope="col" className="right">
                      Total
                    </th>
                    {APPOINTMENT_STATUSES.map((key) => (
                      <th key={key} scope="col" className="right">
                        {key}
                      </th>
                    ))}
                    <th scope="col" style={{ width: "18%" }}>
                      <span className="sr-only">Share of all follow-up sessions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {byPsychologist.map((row) => (
                    <tr key={row.id} className="clickable" tabIndex={0} onClick={() => setPsychologist(row.id)} onKeyDown={(event) => event.key === "Enter" && setPsychologist(row.id)}>
                      <td>{psychologistNames[row.id] || "Psychologist"}</td>
                      <td className="right num">
                        <strong>{row.total}</strong>
                      </td>
                      {APPOINTMENT_STATUSES.map((key) => (
                        <td key={key} className="right num">
                          {row[key] || <span className="muted">0</span>}
                        </td>
                      ))}
                      <td>
                        <div className="bar-track" aria-hidden="true">
                          <span style={{ width: `${(row.total / peak) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>
              Follow-up session details <span className="muted num">{visible.length}</span>
            </h2>
            <p>Newest first.</p>
          </div>
        </div>
        <div className="panel">
          {visible.length === 0 ? (
            <div className="state">
              <Icon name="search" />
              <strong>No follow-up sessions found</strong>
              <span>{data.rows.length === 0 ? "Follow-ups appear here once a recommended follow-up is booked." : "Try different filters."}</span>
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date and time</th>
                    <th scope="col">Client</th>
                    <th scope="col">Psychologist</th>
                    <th scope="col">Service</th>
                    <th scope="col">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((row) => (
                    <tr key={row.id}>
                      <td>
                        {formatDate(row.starts_at)}, {formatTime(row.starts_at)}
                        {row.rescheduled_from_id ? <small className="muted block">Replaces an earlier booking</small> : null}
                      </td>
                      <td>
                        {onOpenClient ? (
                          <button type="button" className="link-btn" onClick={() => onOpenClient(row.client_id)}>
                            {row.client_name}
                          </button>
                        ) : (
                          row.client_name
                        )}
                      </td>
                      <td>{psychologistNames[row.psychologist_id] || "—"}</td>
                      <td>{row.service_type}</td>
                      <td>
                        <StatusPill status={row.status} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    </>
  );
}
