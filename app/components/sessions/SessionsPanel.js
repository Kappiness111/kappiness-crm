"use client";

import { useEffect, useMemo, useState } from "react";
import Dialog from "../Dialog";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import { sessionStatusLabel } from "../../lib/statusLabels";
import FollowUpRecommendationForm from "../psychologist-dashboard/FollowUpRecommendationForm";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { formatDate, formatTime } from "../../lib/leads";
import {
  SESSION_STATUSES,
  SESSION_TYPES,
  createRecommendation,
  listSessionNotes,
  listSessions,
  updateSession,
} from "../../lib/sessionsApi";

const RANGES = [
  { id: "upcoming", label: "Upcoming sessions" },
  { id: "30", label: "Last 30 days" },
  { id: "90", label: "Last 90 days" },
  { id: "all", label: "All" },
];

/* Session management. A session is what actually happened for an appointment: its status follows attendance
   (recorded after the start time), and the psychologist adds the type, an outcome summary and clinical notes.
   viewer: { isStaff, isAdmin, ownPsychologist }. psychologistId limits the list (psychologist workspace). */
export default function SessionsPanel({ viewer, psychologistId = null, psychologistNames = {}, notify, onOpenClient }) {
  const [rows, setRows] = useState([]);
  const [notes, setNotes] = useState({});
  const [state, setState] = useState({ status: "loading", message: "" });
  const [range, setRange] = useState("30");
  const [statusFilter, setStatusFilter] = useState("All");
  const [psychologistFilter, setPsychologistFilter] = useState("all");
  const [reload, setReload] = useState(0);
  const [editing, setEditing] = useState(null); // session
  const [recommending, setRecommending] = useState(null); // session

  const ownId = viewer.ownPsychologist ? viewer.ownPsychologist.id : null;
  const workflow = useAppointmentWorkflow({ viewer, onChanged: () => setReload((value) => value + 1), notify });

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const now = new Date();
      const filters = { psychologistId };
      if (range === "upcoming") filters.from = now;
      else if (range !== "all") {
        filters.from = new Date(now.getTime() - Number(range) * 86400000);
        filters.to = new Date(now.getTime() + 86400000);
      }
      try {
        const list = await listSessions(filters);
        const noteMap = await listSessionNotes(list.map((item) => item.id)).catch(() => ({}));
        if (cancelled) return;
        setRows(range === "upcoming" ? [...list].reverse() : list);
        setNotes(noteMap);
        setState({ status: "ready", message: "" });
      } catch (error) {
        console.error("Failed to load sessions:", error);
        if (!cancelled) setState({ status: "error", message: describeAppointmentError(error, "Could not load sessions. Please try again.") });
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [psychologistId, range, reload]);

  const visible = useMemo(
    () =>
      rows.filter(
        (item) =>
          (statusFilter === "All" || item.status === statusFilter) &&
          (psychologistFilter === "all" || String(item.psychologist_id) === psychologistFilter)
      ),
    [rows, statusFilter, psychologistFilter]
  );
  const psychologistIds = [...new Set(rows.map((item) => String(item.psychologist_id)))];
  const counts = useMemo(() => {
    const map = {};
    SESSION_STATUSES.forEach((status) => {
      map[status] = rows.filter((item) => item.status === status).length;
    });
    return map;
  }, [rows]);

  const now = new Date();
  const isOwn = (session) => ownId && String(session.psychologist_id) === String(ownId);
  const canEdit = (session) => viewer.isStaff || isOwn(session);
  const awaitingAttendance = (session) => session.status === "Scheduled" && new Date(session.starts_at) <= now && canEdit(session);
  // The appointment fields the attendance actions need (the database re-checks the real appointment).
  const asAppointment = (session) => ({
    id: session.appointment_id,
    status: "Scheduled",
    psychologist_id: session.psychologist_id,
    starts_at: session.starts_at,
    client_name: session.client_name,
  });

  return (
    <>
      <div className="toolbar">
        <div className="range-tabs" role="radiogroup" aria-label="Period">
          {RANGES.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={range === item.id} className={range === item.id ? "is-active" : ""} onClick={() => setRange(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
        {!psychologistId && psychologistIds.length > 1 && (
          <select value={psychologistFilter} onChange={(event) => setPsychologistFilter(event.target.value)} aria-label="Filter by psychologist">
            <option value="all">All psychologists</option>
            {psychologistIds.map((id) => (
              <option key={id} value={id}>
                {psychologistNames[id] || "Psychologist"}
              </option>
            ))}
          </select>
        )}
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by status">
          <option value="All">All statuses ({rows.length})</option>
          {SESSION_STATUSES.map((status) => (
            <option key={status} value={status}>
              {sessionStatusLabel(status)} ({counts[status]})
            </option>
          ))}
        </select>
      </div>

      <div className="panel">
        {state.status === "loading" && <p className="appt-empty">Loading sessions…</p>}
        {state.status === "error" && (
          <div className="state" role="alert">
            <Icon name="alert" />
            <strong>Could not load sessions</strong>
            <span>{state.message}</span>
            <button type="button" className="btn btn-sm" onClick={() => setReload((value) => value + 1)}>
              Try again
            </button>
          </div>
        )}
        {state.status === "ready" && visible.length === 0 && (
          <div className="state">
            <Icon name="clipboard" />
            <strong>No sessions here</strong>
            <span>Each booked appointment has a session. Try another time range or status.</span>
          </div>
        )}
        {state.status === "ready" && visible.length > 0 && (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Client</th>
                  {!psychologistId && <th scope="col">Psychologist</th>}
                  <th scope="col">Session type</th>
                  <th scope="col">Status</th>
                  <th scope="col">Session summary</th>
                  <th scope="col" className="right">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((session) => (
                  <tr key={session.id}>
                    <td>
                      {formatDate(session.starts_at)}
                      <small className="muted">
                        {" "}
                        {formatTime(session.starts_at)}–{formatTime(session.ends_at)}
                      </small>
                    </td>
                    <td>
                      {onOpenClient ? (
                        <button type="button" className="link-btn" onClick={() => onOpenClient(session.client_id)}>
                          {session.client_name}
                        </button>
                      ) : (
                        session.client_name
                      )}
                    </td>
                    {!psychologistId && <td>{psychologistNames[session.psychologist_id] || "—"}</td>}
                    <td>{session.session_type}</td>
                    <td>
                      <StatusPill status={session.status} label={sessionStatusLabel(session.status)} />
                      {awaitingAttendance(session) && <small className="muted block">Started: please update</small>}
                    </td>
                    <td className="wrap">
                      {session.outcome || <span className="muted">—</span>}
                      {notes[session.id] ? <small className="muted session-has-notes"> · Notes recorded</small> : null}
                    </td>
                    <td className="right">
                      <span className="appt-actions">
                        {awaitingAttendance(session) && (
                          <>
                            <button type="button" className="appt-btn dark" disabled={workflow.busyId === session.appointment_id} onClick={() => workflow.runAction(asAppointment(session), "attended")}>
                              Mark as completed
                            </button>
                            <button type="button" className="appt-btn" disabled={workflow.busyId === session.appointment_id} onClick={() => workflow.runAction(asAppointment(session), "missed")}>
                              Mark as missed
                            </button>
                          </>
                        )}
                        {isOwn(session) && session.status === "Completed" && (
                          <button type="button" className="appt-btn" onClick={() => setRecommending(session)}>
                            Recommend a follow-up
                          </button>
                        )}
                        {canEdit(session) && (
                          <button type="button" className="appt-btn" onClick={() => setEditing(session)}>
                            View session
                          </button>
                        )}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {editing && (
        <SessionEditor
          session={editing}
          note={notes[editing.id]}
          canWriteNotes={isOwn(editing) || viewer.isAdmin}
          onClose={() => setEditing(null)}
          onSaved={() => {
            notify("Session details saved.");
            setEditing(null);
            setReload((value) => value + 1);
          }}
        />
      )}

      {recommending && (
        <Dialog titleId="recommend-title" title="Recommend a follow-up" subtitle={`${recommending.client_name}, session on ${formatDate(recommending.starts_at)}`} onClose={() => setRecommending(null)}>
          <div className="modal-body">
            <FollowUpRecommendationForm
              appointment={{ id: recommending.appointment_id, clientName: recommending.client_name }}
              onCancel={() => setRecommending(null)}
              onSubmit={async (values) => {
                try {
                  await createRecommendation({
                    sessionId: recommending.id,
                    recommendation: values.notes,
                    date: values.date,
                    time: values.time,
                    priority: values.priority,
                  });
                  notify("Follow-up recommended. The clinic team will arrange the booking with the client.");
                  setRecommending(null);
                  return { ok: true };
                } catch (error) {
                  return { ok: false, message: describeAppointmentError(error, "Could not save the recommendation.") };
                }
              }}
            />
          </div>
        </Dialog>
      )}

      {workflow.dialogs}
    </>
  );
}

function SessionEditor({ session, note, canWriteNotes, onClose, onSaved }) {
  const [type, setType] = useState(session.session_type);
  const [outcome, setOutcome] = useState(session.outcome || "");
  const [text, setText] = useState(note ? note.notes : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function save(event) {
    event.preventDefault();
    if (busy) return;
    if (outcome.length > 500) return setError("Keep the outcome under 500 characters.");
    if (text.length > 5000) return setError("Keep notes under 5000 characters.");
    if (canWriteNotes && note && !text.trim()) return setError("Notes cannot be left empty once saved. Add an update instead.");
    setBusy(true);
    setError("");
    try {
      const notesChanged = canWriteNotes && text.trim() !== (note ? note.notes : "");
      await updateSession(session.id, {
        sessionType: type,
        outcome,
        notes: notesChanged && text.trim() ? text.trim() : null,
      });
      onSaved();
    } catch (err) {
      setError(describeAppointmentError(err, "Could not save the session."));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      titleId="session-edit-title"
      title="Session details"
      subtitle={`${session.client_name}, ${formatDate(session.starts_at)} ${formatTime(session.starts_at)} · ${sessionStatusLabel(session.status)}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Close
          </button>
          <button type="submit" form="session-edit-form" className="btn btn-primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
        </>
      }
    >
      <form id="session-edit-form" className="modal-body" onSubmit={save} noValidate>
        <div className="field">
          <label htmlFor="session-type">Session type</label>
          <select id="session-type" value={type} onChange={(event) => setType(event.target.value)}>
            {SESSION_TYPES.map((item) => (
              <option key={item} value={item}>
                {item}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="session-outcome">Session summary</label>
          <textarea id="session-outcome" rows={2} maxLength={500} value={outcome} onChange={(event) => setOutcome(event.target.value)} />
          <p className="subtle-text">A short, non-clinical summary. The clinic team can see this.</p>
        </div>
        {canWriteNotes ? (
          <div className="field">
            <label htmlFor="session-notes">Clinical notes</label>
            <textarea id="session-notes" rows={6} maxLength={5000} value={text} onChange={(event) => setText(event.target.value)} />
            <p className="subtle-text">Private: only you and clinic administrators can read these.</p>
          </div>
        ) : (
          <p className="subtle-text">Clinical notes can only be written by the psychologist who held the session.</p>
        )}
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
      </form>
    </Dialog>
  );
}
