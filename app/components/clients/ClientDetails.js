"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import AppointmentTable, { StatusPill } from "../AppointmentTable";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, listAppointmentHistory, listAppointments } from "../../lib/appointmentsApi";
import {
  assignClientPsychologist,
  clientIdLabel,
  getClient,
  listClientChanges,
  listClientEnquiries,
  listLeadActivities,
  setClientActive,
} from "../../lib/clientsApi";
import ReasonDialog from "../ReasonDialog";
import ClientEditDialog from "./ClientEditDialog";
import CommunicationPanel from "../communication/CommunicationPanel";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { appointmentStatusLabel, sessionStatusLabel } from "../../lib/statusLabels";
import { listRecommendations, listSessionNotes, listSessions, recommendationState } from "../../lib/sessionsApi";

/* Client profile: personal and contact details, assigned psychologist, service, appointments (upcoming and
   history, with every status change), sessions, follow-up recommendations and the original lead history.
   What each viewer sees is decided by RLS: a psychologist only reaches their own clients, session notes are
   limited to the session's psychologist and administrators, and lead history is staff only.

   Day 24: Client ID, referral source, Active/Inactive (with reason), editable details, total completed sessions,
   last / next appointment, every enquiry that belongs to the client (original + linked), communication history and
   the audited list of profile changes. Inactive clients keep every appointment, session and history row.

   viewer: { isStaff, isAdmin, ownPsychologist }  psychologists: [{ id, name, active }] for names / reassignment */
export default function ClientDetails({ clientId, viewer, psychologists = [], onBack, notify, onOpenLead, onOpenClient }) {
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
  const [enquiries, setEnquiries] = useState([]);
  const [changes, setChanges] = useState([]);
  const [editOpen, setEditOpen] = useState(false);
  const [statusDialog, setStatusDialog] = useState(false);

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
        const [hist, noteMap, acts, enq, chg] = await Promise.all([
          listAppointmentHistory(appts.map((item) => item.id)),
          listSessionNotes(sess.map((item) => item.id)).catch(() => ({})),
          viewer.isStaff ? listLeadActivities(found.lead_id).catch(() => []) : Promise.resolve([]),
          viewer.isStaff ? listClientEnquiries(found).catch(() => []) : Promise.resolve([]),
          // Staff and the client's psychologists may read the audit (activity_log_client_audit_read decides).
          listClientChanges(found.id).catch(() => []),
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
        setEnquiries(enq);
        setChanges(chg);
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
        <span>{state.status === "missing" ? "This client may not exist, or they are not assigned to you." : state.message}</span>
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

  // Same rules as public.client_directory: only Completed sessions count; the last appointment is the latest one that
  // has started and was not cancelled or moved; the next one is the earliest upcoming booking.
  const totalSessions = client.total_sessions ?? sessions.filter((item) => item.status === "Completed").length;
  const lastAppointment = appointments
    .filter((item) => new Date(item.starts_at) <= now && ["Completed", "Missed", "Scheduled", "Confirmed"].includes(item.status))
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at))[0];
  const nextAppointment = appointments
    .filter((item) => new Date(item.starts_at) > now && ACTIVE_APPOINTMENT_STATUSES.includes(item.status))
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at))[0];
  const leadLabels = Object.fromEntries(enquiries.map((item) => [item.id, item.lead_code || "enquiry"]));

  async function changeActive(reason) {
    try {
      await setClientActive(client.id, !client.is_active, reason);
      notify(client.is_active ? `${client.full_name} marked inactive. Their history is kept.` : `${client.full_name} is active again`);
      refresh();
      return { ok: true };
    } catch (error) {
      return { ok: false, message: describeAppointmentError(error, "Could not change the client's status.") };
    }
  }

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
          <h1>
            {client.full_name}{" "}
            <span className={`badge ${client.is_active ? "tone-success" : ""}`} style={{ verticalAlign: "middle" }}>
              <span className="badge-dot" />
              {client.is_active ? "Active" : "Inactive"}
            </span>
          </h1>
          <p>
            <span className="client-id" title={client.id}>
              {clientIdLabel(client.id)}
            </span>{" "}
            · Client since {formatDate(client.created_at)} · Primary psychologist: {names[client.primary_psychologist_id] || client.psychologist_name || "Assigned"}
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
          {viewer.isStaff && (
            <button type="button" className="btn" onClick={() => setEditOpen(true)}>
              <Icon name="edit" /> Edit details
            </button>
          )}
          {viewer.isStaff && (
            <button type="button" className={`btn ${client.is_active ? "btn-danger" : ""}`} onClick={() => setStatusDialog(true)}>
              {client.is_active ? "Mark inactive" : "Reactivate"}
            </button>
          )}
          {canBook && (
            <button type="button" className="btn btn-primary" onClick={() => workflow.openBooking(client)}>
              <Icon name="calendar" /> Book appointment
            </button>
          )}
        </div>
      </header>

      {!client.is_active && (
        <div className="notice warn" role="status" style={{ marginBottom: 16 }}>
          <Icon name="info" />
          <div>
            <strong>This client is inactive.</strong>
            New appointments cannot be booked until the client is reactivated. Appointment, session and communication
            history is kept.
          </div>
        </div>
      )}

      <div className="client-grid">
        <section className="panel panel-pad">
          <h2 className="panel-title">Personal and contact information</h2>
          <dl className="kv">
            {info("Client ID", <span className="client-id-full">{client.id}</span>)}
            {info("Full name", client.full_name)}
            {info("Phone", client.phone ? <a href={`tel:${client.phone.replace(/\s/g, "")}`}>{client.phone}</a> : "")}
            {info("Email", client.email ? <a href={`mailto:${client.email}`}>{client.email}</a> : "")}
            {info("City", client.city)}
            {info("Preferred language", client.preferred_language)}
            {info("Preferred contact", client.preferred_contact)}
            {info("Best time to contact", client.best_time)}
            {info("Referral source", client.referral_source)}
            {info("Status", client.is_active ? "Active" : "Inactive")}
          </dl>
        </section>

        <section className="panel panel-pad">
          <h2 className="panel-title">Care</h2>
          <dl className="kv">
            {info("Service interest", client.service_interest)}
            {info("Primary psychologist", names[client.primary_psychologist_id] || "Assigned")}
            {info("Total sessions", `${totalSessions} completed`)}
            {info(
              "Last appointment",
              lastAppointment ? (
                <>
                  {formatDate(lastAppointment.starts_at)}, {formatTime(lastAppointment.starts_at)}{" "}
                  <StatusPill
                    status={lastAppointment.status}
                    label={ACTIVE_APPOINTMENT_STATUSES.includes(lastAppointment.status) ? "Attendance not recorded" : appointmentStatusLabel(lastAppointment.status)}
                  />
                </>
              ) : (
                "None yet"
              )
            )}
            {info(
              "Next appointment",
              nextAppointment ? (
                <>
                  {formatDate(nextAppointment.starts_at)}, {formatTime(nextAppointment.starts_at)}{" "}
                  <StatusPill status={nextAppointment.status} label={appointmentStatusLabel(nextAppointment.status)} />
                </>
              ) : (
                "Nothing booked"
              )
            )}
            {info("Upcoming appointments", String(upcoming.length))}
            {info("Follow-ups recommended", String(recommendations.filter((item) => item.status === "Open").length))}
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
            <p>Every appointment is kept here, including cancelled and rescheduled ones, with who changed it and when.</p>
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
                        <StatusPill status={item.status} label={appointmentStatusLabel(item.status)} />
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
            <p>Clinical notes are private: only the psychologist who held the session and clinic administrators can read them.</p>
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
                    <th scope="col">Session summary</th>
                    <th scope="col">Clinical notes</th>
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
                        <StatusPill status={item.status} label={sessionStatusLabel(item.status)} />
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
                          Schedule this follow-up
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
              <h2>
                Enquiries <span className="muted num">{enquiries.length}</span>
              </h2>
              <p>The enquiry that created this client and any later enquiry linked to them. Each keeps its own source and history.</p>
            </div>
          </div>
          <div className="panel panel-pad">
            {enquiries.length === 0 ? (
              <p className="appt-empty">No enquiries found.</p>
            ) : (
              <ul className="enquiry-list">
                {enquiries.map((lead) => (
                  <li key={lead.id}>
                    <span>
                      <strong>{lead.lead_code || "Enquiry"}</strong> · {formatDate(lead.created_at)} · {lead.source || "Source not set"} ·{" "}
                      {lead.status}
                      <small className="muted block">
                        {lead.original
                          ? "Original enquiry (created this client profile)"
                          : `Linked ${formatDate(lead.link?.linked_at)}${lead.link?.linked_by_name ? ` by ${lead.link.linked_by_name}` : ""}${
                              lead.link?.match_basis === "phone" ? " · same phone number" : " · linked manually"
                            }${lead.link?.note ? ` · ${lead.link.note}` : ""}`}
                      </small>
                    </span>
                    {onOpenLead && (
                      <button type="button" className="btn btn-sm" onClick={() => onOpenLead(lead.id)}>
                        Open enquiry
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </section>
      )}

      {viewer.isStaff && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>Communication</h2>
              <p>Calls, messages and reminders with this client and their enquiries, including follow-up contacts.</p>
            </div>
          </div>
          <div className="panel panel-pad">
            <CommunicationPanel
              subject={{ clientId: client.id }}
              name={client.full_name}
              phone={client.phone}
              includeLeadIds={enquiries.map((item) => item.id)}
              includeFollowUps
              leadLabels={leadLabels}
              canRecord={viewer.isStaff}
              notify={notify}
            />
          </div>
        </section>
      )}

      {changes.length > 0 && (
        <section className="section">
          <div className="section-head">
            <div>
              <h2>Profile changes</h2>
              <p>Every change to this client&apos;s details or status, with who made it and when.</p>
            </div>
          </div>
          <div className="panel">
            <ul className="list">
              {changes.map((row) => (
                <li key={row.id} className="list-row">
                  <span className="grow">
                    <strong>{row.action}</strong>
                    <span>
                      {Object.entries((row.details && row.details.changes) || {})
                        .map(([field, change]) => `${field.replace(/_/g, " ")}: ${change.from ?? "—"} → ${change.to ?? "—"}`)
                        .join("; ")}
                      {row.details && row.details.reason ? ` · Reason: ${row.details.reason}` : ""}
                    </span>
                  </span>
                  <span className="meta">
                    {formatDateTime(row.created_at)}
                    {row.actor_name ? ` · ${row.actor_name}` : ""}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      )}

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

      {editOpen && (
        <ClientEditDialog
          client={client}
          onClose={() => setEditOpen(false)}
          onOpenClient={onOpenClient}
          onSaved={(saved) => {
            notify(`${saved ? saved.full_name : "Client"}: details saved`);
            refresh();
          }}
        />
      )}

      {statusDialog && (
        <ReasonDialog
          title={client.is_active ? "Mark client inactive" : "Reactivate client"}
          subtitle={
            client.is_active
              ? `${client.full_name} will not be bookable. Every appointment, session and history entry is kept. Open appointments (upcoming, or past and awaiting attendance) must be cancelled or have attendance recorded first.`
              : `${client.full_name} can be booked again.`
          }
          label="Reason"
          confirmLabel={client.is_active ? "Mark inactive" : "Reactivate"}
          danger={client.is_active}
          onClose={() => setStatusDialog(false)}
          onSubmit={changeActive}
        />
      )}
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
          Mark as completed
        </button>
      )}
      {actions.includes("missed") && (
        <button type="button" className="appt-btn" disabled={workflow.busyId === item.id} onClick={() => workflow.runAction(item, "missed")}>
          Mark as missed
        </button>
      )}
    </div>
  );
}
