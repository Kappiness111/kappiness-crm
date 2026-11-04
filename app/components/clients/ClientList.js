"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { Avatar } from "../AppointmentTable";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import { listClients } from "../../lib/clientsApi";
import { formatDate, formatTime } from "../../lib/leads";

/* Client list for staff (all clients) and psychologists (own clients: psychologistId set, RLS enforces it).
   onOpen(client) opens the client profile. */
export default function ClientList({ psychologistId = null, psychologistNames = {}, showPsychologist = true, onOpen }) {
  const [state, setState] = useState({ status: "loading", message: "" });
  const [clients, setClients] = useState([]);
  const [nextByClient, setNextByClient] = useState({});
  const [search, setSearch] = useState("");
  const [psychologistFilter, setPsychologistFilter] = useState("all");
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const from = new Date();
        const [rows, upcoming] = await Promise.all([
          listClients({ psychologistId }),
          listAppointments({ from, statuses: ACTIVE_APPOINTMENT_STATUSES, psychologistId }),
        ]);
        if (cancelled) return;
        const next = {};
        upcoming.forEach((item) => {
          if (!next[item.client_id]) next[item.client_id] = item;
        });
        setClients(rows);
        setNextByClient(next);
        setState({ status: "ready", message: "" });
      } catch (error) {
        console.error("Failed to load clients:", error);
        if (!cancelled) setState({ status: "error", message: describeAppointmentError(error, "Could not load clients. Please try again.") });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [psychologistId, reload]);

  const rows = useMemo(() => {
    const term = search.trim().toLowerCase();
    const digits = term.replace(/\s+/g, "");
    return clients.filter((client) => {
      if (psychologistFilter !== "all" && String(client.primary_psychologist_id) !== psychologistFilter) return false;
      if (!term) return true;
      return (
        [client.full_name, client.email, client.city, client.service_interest].some((field) => (field || "").toLowerCase().includes(term)) ||
        (digits && client.phone.replace(/\s+/g, "").includes(digits))
      );
    });
  }, [clients, search, psychologistFilter]);

  if (state.status === "loading") {
    return (
      <div className="panel">
        <div className="state" aria-busy="true">
          <strong>Loading clients…</strong>
        </div>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="panel">
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>Could not load clients</strong>
          <span>{state.message}</span>
          <button type="button" className="btn" onClick={() => setReload((value) => value + 1)}>
            Try again
          </button>
        </div>
      </div>
    );
  }

  const psychologistIds = [...new Set(clients.map((item) => String(item.primary_psychologist_id)))];

  return (
    <>
      <div className="toolbar">
        <label className="search">
          <Icon name="search" />
          <span className="sr-only">Search clients</span>
          <input type="search" placeholder="Search name, phone, email, city" value={search} onChange={(event) => setSearch(event.target.value)} />
        </label>
        {showPsychologist && psychologistIds.length > 1 && (
          <select value={psychologistFilter} onChange={(event) => setPsychologistFilter(event.target.value)} aria-label="Filter by psychologist">
            <option value="all">All psychologists</option>
            {psychologistIds.map((id) => (
              <option key={id} value={id}>
                {psychologistNames[id] || "Psychologist"}
              </option>
            ))}
          </select>
        )}
      </div>

      <div className="panel">
        {rows.length === 0 ? (
          <div className="state">
            <Icon name="users" />
            <strong>{clients.length === 0 ? "No clients yet" : "No matching clients"}</strong>
            <span>
              {clients.length === 0
                ? "A client profile is created when a lead is set to Confirmed with a psychologist."
                : "Try another search or filter."}
            </span>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Client</th>
                  <th scope="col">Contact</th>
                  {showPsychologist && <th scope="col">Psychologist</th>}
                  <th scope="col">Service</th>
                  <th scope="col">Next appointment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((client) => {
                  const next = nextByClient[client.id];
                  return (
                    <tr key={client.id} className="clickable" tabIndex={0} onClick={() => onOpen(client)} onKeyDown={(event) => event.key === "Enter" && onOpen(client)}>
                      <td>
                        <span className="person">
                          <Avatar name={client.full_name} />
                          <span>
                            <strong>{client.full_name}</strong>
                            <small className="muted">{client.city || (client.is_active ? "Active" : "Inactive")}</small>
                          </span>
                        </span>
                      </td>
                      <td>
                        {client.phone || "—"}
                        {client.preferred_contact ? <small className="muted"> · {client.preferred_contact}</small> : null}
                      </td>
                      {showPsychologist && <td>{psychologistNames[client.primary_psychologist_id] || "—"}</td>}
                      <td>{client.service_interest || <span className="muted">—</span>}</td>
                      <td>
                        {next ? (
                          `${formatDate(next.starts_at)}, ${formatTime(next.starts_at)}`
                        ) : (
                          <span className="muted">None booked</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
