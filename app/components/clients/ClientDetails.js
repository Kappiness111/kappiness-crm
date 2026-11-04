"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import AppointmentTable, { StatusPill } from "../AppointmentTable";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, listAppointmentHistory, listAppointments } from "../../lib/appointmentsApi";
import { assignClientPsychologist, getClient, listLeadActivities } from "../../lib/clientsApi";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { listRecommendations, listSessionNotes, listSessions, recommendationState } from "../../lib/sessionsApi";

/* Client profile: personal and contact details, assigned psychologist, service, appointments (upcoming and
   history, with every status change), sessions, follow-up recommendations and the original lead history.
   What each viewer sees is decided by RLS: a psychologist only reaches their own clients, session notes are
   limited to the session's psychologist and administrators, and lead history is staff only.

   viewer: { isStaff, isAdmin, ownPsychologist }  psychologists: [{ id, name, active }] for names / reassignment */
export default function ClientDetails({ clientId, viewer, psychologists = [], onBack, notify, onOpenLead }) {
  const [state, setState] = useState({ status: "loading", message: "" });
  const [client, setClient] = useState(null);
  const [appointments, setAppointments] = useState([]);
  const [history, setHistory] = useState([]);
  const [sessions, setSessions] = useState([]);
  const [notes, setNotes] = useState({});
  const [recommendations, setRecommendations] = useState([]);
  const [activities, setActivities] = useState([]);
  const [reload, setReload] = useState(0);
  const [assignDraft, setAssignDraft] = useState("");
  const [assignBusy, setAssignBusy] = useState(false);

  const names = useMemo(() => {
    const map = {};
    psychologists.forEach((item) => {
      map[item.id] = item.name;
    });
    if (viewer.ownPsychologist) map[viewer.ownPsychologist.id] = viewer.ownPsychologist.name;
    return map;
  }, [psychologists, viewer.ownPsychologist]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const found = await getClient(clientId);
        if (cancelled) return;
        if (!found) {
          setState({ status: "missing", message: "" });
          return;
        }
        const [appts, sess, recs] = await Promise.all([
          listAppointments({ clientId }),
          listSessions({ clientId }),
          listRecommendations({ clientId }),
        ]);
        const [hist, noteMap, acts] = await Promise.all([
          listAppointmentHistory(appts.map((item) => item.id)),
          listSessionNotes(sess.map((item) => item.id)).catch(() => ({})),
          viewer.isStaff ? listLeadActivities(found.lead_id).catch(() => []) : Promise.resolve([]),
        ]);
        if (cancelled) return;
        setClient(found);
        setAssignDraft(String(found.primary_psychologist_id));
        setAppointments(appts);
        setSessions(sess);
        setRecommendations(recs);
        setHistory(hist);
        setNotes(noteMap);
        setActivities(acts);
        setState({ status: "ready", message: "" });
      } catch (error) {
        console.error("Failed to load client:", error);
        if (!cancelled) setState({ status: "error", message: describeAppointmentError(error, "Could not load this client. Please try again.") });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [clientId, reload, viewer.isStaff]);

  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: refresh, notify });

  if (state.status === "loading") {
    return (
      <div className="state" aria-busy="true">
        <strong>Loading client…</strong>
      </div>
    );
  }
  if (state.status === "missing" || state.status === "error") {
    return (
      <div className="state" role={state.status === "error" ? "alert" : "status"}>
        <Icon name={state.status === "error" ? "alert" : "info"} />
        <strong>{state.status === "missing" ? "Client not found" : "Could not load this client"}</strong>
        <span>{state.status === "missing" ? "It does not exist, or it is not assigned to you." : state.message}</span>
        <div style={{ display: "flex", gap: 8 }}>
          {state.status === "error" && (
            <button type="button" className="btn" onClick={refresh}>
              Try again
            </button>
          )}
          {onBack && (
            <button type="button" className="btn" onClick={onBack}>
              Back to clients
            </button>
          )}
        </div>
      </div>
    );
  }

  const now = new Date();
  const upcoming = appointments.filter((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status) && new Date(item.ends_at) >= now);
  const past = appointments
    .filter((item) => !upcoming.includes(item))
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  const canBook =
    client.is_active && (viewer.isStaff || (viewer.ownPsychologist && String(client.primary_psychologist_id) === String(viewer.ownPsychologist.id)));
  const historyFor = (id) => history.filter((row) => row.appointment_id === id);

  async function saveAssignment() {
    if (!assignDraft || assignDraft === String(client.primary_psychologist_id)) return;
    setAssignBusy(true);
    try {
      await assignClientPsychologist(client.id, assignDraft);
      notify(`Primary psychologist changed to ${names[assignDraft] || "the selected psychologist"}`);
      refresh();
    } catch (error) {
      notify(describeAppointmentError(error, "Could not change the psychologist."), "error");
    } finally {
      setAssignBusy(false);
    }
  }

  const info = (label, value) => (
    <>
      <dt>{label}</dt>
      <dd>{value || <span className="muted">—</span>}</dd>
    </>
  );

  return (
    <>
      <header className="page-head">
        <div>
          <h1>{client.full_name}</h1>
          <p>
            Client since {formatDate(client.created_at)} · {client.is_active ? "Active" : "Inactive"} · Primary psychologist:{" "}
            {names[client.primary_psychologist_id] || "Assigned"}
          </p>
        </div>
        <div className="page-actions">
          {onBack && (
            <button type="button" className="btn" onClick={onBack}>
              <Icon name="arrowLeft" /> Clients
            </button>
          )}
          {viewer.isStaff && onOpenLead && (
            <button type="button" className="btn" onClick={() => onOpenLead(client.lead_id)}>
              Original lead
            </button>
          )}
          {canBook && (
            <button type="button" className="btn btn-primary" onClick={() => workflow.openBooking(client)}>
              <Icon name="calendar" /> Book appointment
            </button>
          )}
        </div>
      </header>

      <div className="client-grid">
        <section className="panel panel-pad">
          <h2 className="panel-title">Personal and contact information</h2>
          <dl className="kv">
            {info("Full name", client.full_name)}
            {info("Phone", client.phone ? <a href={`tel:${client.phone.replace(/\s/g, "")}`}>{client.phone}</a> : "")}
            {info("Email", client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : "")}
            {info("City", client.city)}
            {info("Preferred language", client.preferred_language)}
            {info("Preferred contact", client.preferred_contact)}
            {info("Best time to contact", client.best_time)}
          </dl>
        </section>

        <section className="panel panel-pad">
          <h2 className="panel-title">Care</h2>
          <dl className="kv">
            {info("Service interest", client.service_interest)}
            {info("Primary psychologist", names[client.primary_psychologist_id] || "Assigned")}
            {info("Sessions completed", String(sessions.filter((item) => item.status === "Completed").length))}
            {info("Upcoming appointments", String(upcoming.length))}
            {info("Open recommendations", String(recommendations.filter((item) => item.status === "Open").length))}
          </dl>
          {viewer.isStaff && (
            <div className="field" style={{ marginTop: 14 }}>
              <label htmlFor="client-psychologist">Change primary psychologist</label>
              <div style={{ display: "flex", gap: 8 }}>
                <select id="client-psychologist" value={assignDraft} onChange={(event) => setAssignDraft(event.target.value)} disabled={assignBusy}>
                  {psychologists
                    .filter((item) => item.active || String(item.id) === String(client.primary_psychologist_id))
                    .map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                        {item.active ? "" : " (inactive)"}
                      </option>
                    ))}
                </select>
                <button
                  type="button"
                  className="btn"
                  onClick={saveAssignment}
                  disabled={assignBusy || assignDraft === String(client.primary_psychologist_id)}
                >
                  {assignBusy ? "Saving…" : "Save"}
                </button>
              </div>
              <p className="subtle-text">Existing appointments keep their psychologist. The lead&apos;s assignment is updated too.</p>
            </div>
          )}
        </section>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>
            Upcoming appointments <span className="muted num">{upcoming.length}</span>
          </h2>
        </div>
        <div className="panel">
          <AppointmentTable
            items={upcoming}
            psychologistNames={names}
            actionsFor={workflow.actionsFor}
            onAction={workflow.runAction}
            busyId={workflow.busyId}
            empty="No upcoming appointments."
          />
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>
              Appointment history <span className="muted num">{past.length}</span>
            </h2>
            <p>Every booking is kept, including cancelled and rescheduled ones, with each status change.</p>
          </div>
        </div>
        <div className="panel">
          {past.length === 0 ? (
            <p className="appt-empty">No past appointments yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Service</th>
                    <th scope="col">Psychologist</th>
                    <th scope="col">Status</th>
                    <th scope="col">History</th>
                  </tr>
                </thead>
                <tbody>
                  {past.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {formatDate(item.starts_at)}, {formatTime(item.starts_at)}–{formatTime(item.ends_at)}
                      </td>
                      <td>{item.service_type}</td>
                      <td>{names[item.psychologist_id] || "—"}</td>
                      <td>
                        <StatusPill status={item.status} />
                        <AppointmentActionsInline item={item} workflow={workflow} />
                      </td>
                      <td className="wrap">
                        <ol className="status-trail">
                          {historyFor(item.id).map((row) => (
                            <li key={row.id}>
                              <strong>{row.new_status}</strong> · {formatDateTime(row.changed_at)}
                              {row.changed_by_name ? ` · ${row.changed_by_name}` : ""}
                              {row.reason ? <span className="muted"> · {row.reason}</span> : null}
                            </li>
                          ))}
                        </ol>
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
              Session history <span className="muted num">{sessions.length}</span>
            </h2>
            <p>Clinical notes are visible only to the session&apos;s psychologist and administrators.</p>
          </div>
        </div>
        <div className="panel">
          {sessions.length === 0 ? (
            <p className="appt-empty">No sessions yet.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">Date</th>
                    <th scope="col">Type</th>
                    <th scope="col">Psychologist</th>
                    <th scope="col">Status</th>
                    <th scope="col">Outcome</th>
                    <th scope="col">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {sessions.map((item) => (
                    <tr key={item.id}>
                      <td>
                        {formatDate(item.starts_at)}, {formatTime(item.starts_at)}
                      </td>
                      <td>{item.session_type}</td>
                      <td>{names[item.psychologist_id] || "—"}</td>
                      <td>
                        <StatusPill status={item.status} />
                      </td>
                      <td className="wrap">{item.outcome || <span className="muted">—</span>}</td>
                      <td className="wrap">{notes[item.id] ? notes[item.id].notes : <span className="muted">—</span>}</td>
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
          <h2>
            Follow-up recommendations <span className="muted num">{recommendations.length}</span>
          </h2>
        </div>
        <div className="panel">
          {recommendations.length === 0 ? (
            <p className="appt-empty">No recommendations yet.</p>
          ) : (
            <ul className="rec-list">
              {recommendations.map((rec) => {
                const recState = recommendationState(rec, now);
                return (
                  <li key={rec.id} className="rec-item">
                    <div className="rec-main">
                      <strong>
                        {formatDate(rec.recommended_date)}
                        {rec.recommended_time ? `, ${String(rec.recommended_time).slice(0, 5)}` : ""}
                      </strong>
                      <span className={`badge rec-${recState}`}>{recState === "overdue" ? "Overdue" : rec.status}</span>
                      {rec.priority !== "Normal" && <span className="badge tone-warning">{rec.priority}</span>}
                    </div>
                    <p>{rec.recommendation}</p>
                    <small className="muted">
                      By {names[rec.psychologist_id] || "psychologist"} on {formatDate(rec.created_at)}
                      {rec.outcome ? ` · Outcome: ${rec.outcome}` : ""}
                    </small>
                    {rec.status === "Open" && canBook && (
                      <div>
                        <button type="button" className="appt-btn dark" onClick={() => workflow.openBooking(client, rec)}>
                          Book this follow-up
                        </button>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {viewer.isStaff && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>Activity history</h2>
              <p>The original lead history, kept with the client.</p>
            </div>
          </div>
          <div className="panel">
            {activities.length === 0 ? (
              <p className="appt-empty">No activity recorded.</p>
            ) : (
              <ul className="list">
                {activities.map((row) => (
                  <li key={row.id} className="list-row">
                    <span className="grow">
                      <strong>{row.activity_type || "Update"}</strong>
                      <span>{row.notes || row.outcome || ""}</span>
                    </span>
                    <span className="meta">
                      {formatDateTime(row.occurred_at)}
                      {row.staff_member ? ` · ${row.staff_member}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {workflow.dialogs}
    </>
  );
}

// Past appointments that are still open (start time passed, attendance not recorded yet) get their actions inline.
function AppointmentActionsInline({ item, workflow }) {
  const actions = workflow.actionsFor(item);
  if (!actions.length) return null;
  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, flexWrap: "wrap" }}>
      {actions.includes("attended") && (
        <button type="button" className="appt-btn dark" disabled={workflow.busyId === item.id} onClick={() => workflow.runAction(item, "attended")}>
          Attended
        </button>
      )}
      {actions.includes("missed") && (
        <button type="button" className="appt-btn" disabled={workflow.busyId === item.id} onClick={() => workflow.runAction(item, "missed")}>
          Missed
        </button>
      )}
    </div>
  );
}
