"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import SessionDetailsPanel from "./SessionDetailsPanel";
import { describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import { sessionKind } from "../../lib/checklistApi";
import { formatDate, formatTime } from "../../lib/leads";
import { listAppointmentSessionNumbers } from "../../lib/sessionFollowUpApi";
import { listSessions } from "../../lib/sessionsApi";
import { appointmentStatusLabel } from "../../lib/statusLabels";

const HISTORY_FILTERS = [
  { id: "all", label: "All Sessions", statuses: null },
  { id: "upcoming", label: "Upcoming", statuses: ["Scheduled", "Confirmed"] },
  { id: "completed", label: "Completed", statuses: ["Completed"] },
  { id: "cancelled", label: "Cancelled", statuses: ["Cancelled"] },
  { id: "missed", label: "Missed", statuses: ["Missed"] },
];

// Upcoming appointments start from now; every other category covers all dates.
function dateBounds(filter) {
  return { from: filter === "upcoming" ? new Date() : null, to: null };
}

export default function SessionHistory({ viewer, psychologistNames = {}, notify, onOpenClient }) {
  const [category, setCategory] = useState("all");
  const [psychologistId, setPsychologistId] = useState("");
  const [search, setSearch] = useState("");
  const [reload, setReload] = useState(0);
  const [selected, setSelected] = useState(null);
  const [data, setData] = useState({ key: "", status: "loading", message: "", appointments: [], sessions: {}, sessionNumbers: {} });
  const isStaff = Boolean(viewer && viewer.isStaff);
  const ownPsychologistId = !isStaff && viewer && viewer.ownPsychologist ? String(viewer.ownPsychologist.id) : null;
  const effectivePsychologistId = ownPsychologistId || psychologistId || null;
  const key = `${category}|${effectivePsychologistId || ""}|${reload}`;
  const activeFilter = HISTORY_FILTERS.find((filter) => filter.id === category) || HISTORY_FILTERS[0];
  const visible = useMemo(() => {
    const term = search.trim().toLowerCase();
    const rows = data.appointments.filter((item) => !term || String(item.client_name || "").toLowerCase().includes(term));
    rows.sort((a, b) =>
      category === "upcoming"
        ? new Date(a.starts_at) - new Date(b.starts_at)
        : new Date(b.starts_at) - new Date(a.starts_at)
    );
    return rows;
  }, [data.appointments, search, category]);
  const loading = data.key !== key;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { from, to } = dateBounds(category);
        const appointments = await listAppointments({
          from,
          to,
          psychologistId: effectivePsychologistId,
          statuses: activeFilter.statuses || undefined,
        });
        const ids = appointments.map((item) => item.id);
        const [sessionRows, sessionNumbers] = await Promise.all([
          listSessions({ from, to, psychologistId: effectivePsychologistId }),
          listAppointmentSessionNumbers(ids),
        ]);
        const sessions = {};
        sessionRows.forEach((row) => {
          if (row.appointment_id) sessions[row.appointment_id] = row;
        });
        if (!cancelled) {
          setData({ key, status: "ready", message: "", appointments, sessions, sessionNumbers });
        }
      } catch (error) {
        console.error("Failed to load session history:", error);
        if (!cancelled) {
          setData({
            key,
            status: "error",
            message: describeAppointmentError(error, "Could not load Session History."),
            appointments: [],
            sessions: {},
            sessionNumbers: {},
          });
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [activeFilter.statuses, category, effectivePsychologistId, key]);

  function clearFilters() {
    setCategory("all");
    setPsychologistId("");
    setSearch("");
  }

  const filterActive = category !== "all" || Boolean(psychologistId || search);
  const psychologistOptions = Object.entries(psychologistNames).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const opened = selected ? data.appointments.find((item) => item.id === selected.id) || selected : null;

  return (
    <section className="panel" aria-label="Session History">
      <div className="toolbar">
        <label className="search">
          <Icon name="search" />
          <span className="sr-only">Search by client name</span>
          <input type="search" placeholder="Search client" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        <select value={category} onChange={(event) => setCategory(event.target.value)} aria-label="Appointment category">
          {HISTORY_FILTERS.map((filter) => (
            <option key={filter.id} value={filter.id}>
              {filter.label}
            </option>
          ))}
        </select>
        {isStaff && psychologistOptions.length > 0 && (
          <select value={psychologistId} onChange={(event) => setPsychologistId(event.target.value)} aria-label="Filter by psychologist">
            <option value="">All psychologists</option>
            {psychologistOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        {filterActive && (
          <button type="button" className="btn btn-sm" onClick={clearFilters}>
            Clear filters
          </button>
        )}
        <span className="spacer" />
        {!loading && data.status === "ready" && <span className="count">{visible.length} appointments</span>}
      </div>

      {loading && <p className="appt-empty">Loading Session History…</p>}
      {!loading && data.status === "error" && (
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>Could not load Session History</strong>
          <span>{data.message}</span>
          <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      )}
      {!loading && data.status === "ready" && visible.length === 0 && (
        <div className="state">
          <Icon name="checkCircle" />
          <strong>{data.appointments.length ? "No appointments match" : "No appointments found"}</strong>
          <span>{data.appointments.length ? "Try another search or filter." : "Appointment records will appear here."}</span>
        </div>
      )}
      {!loading && data.status === "ready" && visible.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Session Type</th>
                <th scope="col">Psychologist</th>
                <th scope="col">Date</th>
                <th scope="col">Time</th>
                <th scope="col">Session Number</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((item) => {
                const kind = sessionKind(item, data.sessions[item.id] || null);
                return (
                  <tr key={item.id}>
                    <td>
                      {onOpenClient ? (
                        <button type="button" className="link-btn" onClick={() => onOpenClient(item.client_id)}>
                          {item.client_name}
                        </button>
                      ) : (
                        item.client_name
                      )}
                    </td>
                    <td>{kind.label}</td>
                    <td>{psychologistNames[item.psychologist_id] || "—"}</td>
                    <td>{formatDate(item.starts_at)}</td>
                    <td>{formatTime(item.starts_at)}–{formatTime(item.ends_at)}</td>
                    <td>{data.sessionNumbers[item.id] || "—"}</td>
                    <td>
                      <StatusPill status={item.status} label={item.status === "Scheduled" ? "Yet to confirm" : appointmentStatusLabel(item.status)} />
                    </td>
                    <td>
                      <button type="button" className="btn btn-sm" onClick={() => setSelected(item)}>
                        View details
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {opened && (
        <SessionDetailsPanel
          appointment={opened}
          viewer={viewer}
          psychologistNames={psychologistNames}
          notify={notify}
          onOpenClient={onOpenClient}
          onClose={() => setSelected(null)}
          onChanged={() => setReload((value) => value + 1)}
          sessionManagement
          readOnly
        />
      )}
    </section>
  );
}
