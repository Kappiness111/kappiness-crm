"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import { formatDate, formatTime } from "../../lib/leads";
import { loadWorkload } from "../../lib/workload";

/* A psychologist's current work, for staff: assigned clients, upcoming sessions and open follow-ups. */
export default function PsychologistWorkload({ psychologistId }) {
  const router = useRouter();
  const [state, setState] = useState({ status: "loading", data: null });
  const [reload, setReload] = useState(0);

  useEffect(() => {
    let cancelled = false;
    loadWorkload({ psychologistId })
      .then((data) => {
        if (!cancelled) setState({ status: "ready", data });
      })
      .catch((error) => {
        console.error("Failed to load workload:", error);
        if (!cancelled) setState({ status: "error", data: null });
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, reload]);

  const data = state.data;
  const clients = data ? data.clients.filter((item) => item.is_active) : [];
  const upcoming = data ? data.upcoming : [];
  const followUps = data ? data.followUps : [];

  return (
    <section className="section" aria-labelledby="workload-title">
      <div className="section-head">
        <div>
          <h2 id="workload-title">Clients and upcoming sessions</h2>
          <p>What this psychologist is working on now.</p>
        </div>
      </div>

      {state.status === "error" ? (
        <div className="panel">
          <div className="state" role="alert">
            <Icon name="alert" />
            <strong>We couldn&apos;t load this psychologist&apos;s sessions</strong>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </div>
        </div>
      ) : (
        <>
          <section className="kpis" aria-label="Workload">
            <div className="kpi">
              <span className="kpi-label">Assigned clients</span>
              <span className="kpi-value">{data ? clients.length : "…"}</span>
              <span className="kpi-meta">Active clients</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Upcoming sessions</span>
              <span className="kpi-value">{data ? upcoming.length : "…"}</span>
              <span className="kpi-meta">Booked from today on</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Follow-up sessions assigned</span>
              <span className="kpi-value">{data ? followUps.length : "…"}</span>
              <span className="kpi-meta">Recommended or booked, still open</span>
            </div>
          </section>

          <div className="client-grid">
            <div className="panel">
              <h3 className="panel-title panel-pad" style={{ marginBottom: 0, paddingBottom: 0 }}>
                Next sessions
              </h3>
              {state.status === "loading" ? (
                <p className="appt-empty">Loading…</p>
              ) : upcoming.length === 0 ? (
                <p className="appt-empty">No sessions booked from today on.</p>
              ) : (
                <ul className="list">
                  {upcoming.slice(0, 8).map((item) => (
                    <li key={item.id} className="list-row">
                      <span className="when">
                        {formatTime(item.starts_at)}
                        <small>{formatDate(item.starts_at).slice(0, 6)}</small>
                      </span>
                      <span className="grow">
                        <strong>{item.client_name}</strong>
                        <span>{item.service_type}</span>
                      </span>
                      <StatusPill status={item.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="panel">
              <h3 className="panel-title panel-pad" style={{ marginBottom: 0, paddingBottom: 0 }}>
                Assigned clients
              </h3>
              {state.status === "loading" ? (
                <p className="appt-empty">Loading…</p>
              ) : clients.length === 0 ? (
                <p className="appt-empty">No clients assigned yet.</p>
              ) : (
                <ul className="list">
                  {clients.slice(0, 8).map((item) => (
                    <li key={item.id} className="list-row">
                      <span className="grow">
                        <strong>{item.full_name}</strong>
                        <span>{item.service_interest || item.phone || ""}</span>
                      </span>
                      <button type="button" className="appt-btn" onClick={() => router.push(`/clients/${item.id}`)}>
                        View client
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {clients.length > 8 && <p className="subtle-text panel-pad">And {clients.length - 8} more. See Confirmed Clients for the full list.</p>}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
