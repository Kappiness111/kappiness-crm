"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import { Badge, DeliveryBadge, ResponseBadge } from "../ui/StatusBadges";
import AfterSessionPanel from "./AfterSessionPanel";
import styles from "../followups/followups.module.css";
import { describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import {
  CHECKLIST_STEPS,
  describeActivity,
  listChecklistActivity,
  listChecklists,
  listCompletedSessionTimes,
  tickedBy,
  updateChecklist,
} from "../../lib/checklistApi";
import { todayInputValue } from "../../lib/followUpsApi";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { listReminders } from "../../lib/remindersApi";
import { listSessions } from "../../lib/sessionsApi";
import { appointmentStatusLabel } from "../../lib/statusLabels";

// Cancelled and rescheduled appointments have no checklist (the database refuses them).
const SHOWN_STATUSES = ["Scheduled", "Confirmed", "Completed", "Missed"];

function dayRange(day) {
  const from = new Date(`${day}T00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

/* The day's appointments with the six manual checklist steps (session_checklists, via update_session_checklist).
   The checklist is only a record: ticking never changes appointment, session or reminder status.
   viewer: { isStaff, ownPsychologist }. psychologistId fixes the list to one psychologist (their own workspace).
   Ticking is allowed for staff and for the appointment's own psychologist (the database checks again).
   Staff also get "After session", the guided steps after a session. No clinical notes are shown here. */
export default function DailyChecklist({ viewer, psychologistId = null, psychologistNames = {}, notify }) {
  const [day, setDay] = useState(todayInputValue());
  const [psychologistFilter, setPsychologistFilter] = useState("");
  const [reload, setReload] = useState(0);
  const [data, setData] = useState({ key: "", status: "loading", message: "", appointments: [], sessions: {}, checklists: {}, activity: {}, reminders: {}, completed: {} });
  const [busy, setBusy] = useState(""); // `${appointmentId}:${step}`
  const [rowError, setRowError] = useState({}); // { appointmentId: message }
  const [afterSession, setAfterSession] = useState(null); // appointment
  const isStaff = Boolean(viewer && viewer.isStaff);
  const ownId = viewer && viewer.ownPsychologist ? String(viewer.ownPsychologist.id) : null;
  const scope = psychologistId || psychologistFilter || null;
  const base = `${day}|${scope || ""}`; // a new day or psychologist shows "Loading"; a refresh keeps the rows
  const key = `${base}|${reload}`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { from, to } = dayRange(day);
        const appointments = (await listAppointments({ from, to, psychologistId: scope, statuses: SHOWN_STATUSES })).sort(
          (a, b) => new Date(a.starts_at) - new Date(b.starts_at)
        );
        const ids = appointments.map((item) => item.id);
        const [sessionRows, checklists, reminderResult, completed] = await Promise.all([
          listSessions({ from, to, psychologistId: scope }),
          listChecklists(ids),
          isStaff ? listReminders(ids) : Promise.resolve({ rows: [] }),
          listCompletedSessionTimes(
            appointments.map((item) => item.client_id),
            to
          ),
        ]);
        const activity = await listChecklistActivity(Object.values(checklists).map((row) => row.id));
        const sessions = {};
        sessionRows.forEach((row) => {
          if (row.appointment_id) sessions[row.appointment_id] = row;
        });
        const reminders = {};
        reminderResult.rows.forEach((row) => {
          (reminders[row.appointment_id] = reminders[row.appointment_id] || {})[row.reminder_number] = row;
        });
        if (!cancelled) setData({ key, base, status: "ready", message: "", appointments, sessions, checklists, activity, reminders, completed });
      } catch (error) {
        console.error("Failed to load the daily checklist:", error);
        if (!cancelled) setData((current) => ({ ...current, key, base, status: "error", message: describeAppointmentError(error, "Could not load the checklist.") }));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [day, scope, isStaff, key, base]);

  const loading = data.base !== base;

  // Group by psychologist, in time order inside each group.
  const groups = useMemo(() => {
    const map = new Map();
    data.appointments.forEach((item) => {
      const id = String(item.psychologist_id);
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(item);
    });
    return [...map.entries()].sort((a, b) => String(psychologistNames[a[0]] || "").localeCompare(String(psychologistNames[b[0]] || "")));
  }, [data.appointments, psychologistNames]);

  function sessionInfo(item) {
    const session = data.sessions[item.id] || null;
    const followUp = Boolean(item.recommendation_id) || (session && session.session_type === "Follow-up");
    // F1 = first follow-up after the first completed session: count completed sessions before this one.
    const before = (data.completed[item.client_id] || []).filter((time) => time < new Date(item.starts_at).getTime()).length;
    return { session, followUp, number: followUp ? `F${Math.max(before, 1)}` : null };
  }

  async function toggle(item, stepId, value) {
    const id = `${item.id}:${stepId}`;
    if (busy) return;
    setBusy(id);
    setRowError((current) => ({ ...current, [item.id]: "" }));
    try {
      await updateChecklist(item.id, { [stepId]: value });
      setReload((current) => current + 1);
    } catch (error) {
      setRowError((current) => ({ ...current, [item.id]: describeAppointmentError(error, "Could not update the checklist.") }));
    } finally {
      setBusy("");
    }
  }

  const psychologistOptions = Object.entries(psychologistNames).sort((a, b) => String(a[1]).localeCompare(String(b[1])));

  return (
    <section className="panel" aria-label="Daily session checklist">
      <div className="toolbar">
        <label htmlFor="checklist-day" className="muted">
          Day
        </label>
        <input id="checklist-day" type="date" value={day} onChange={(event) => setDay(event.target.value || todayInputValue())} style={{ width: "auto" }} />
        {day !== todayInputValue() && (
          <button type="button" className="btn btn-sm" onClick={() => setDay(todayInputValue())}>
            Today
          </button>
        )}
        {!psychologistId && psychologistOptions.length > 0 && (
          <select value={psychologistFilter} onChange={(event) => setPsychologistFilter(event.target.value)} aria-label="Filter by psychologist">
            <option value="">All psychologists</option>
            {psychologistOptions.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
        <span className="spacer" />
        {!loading && data.status === "ready" && (
          <span className="count">
            {data.appointments.length} appointment{data.appointments.length === 1 ? "" : "s"}
          </span>
        )}
      </div>

      <p className={styles.hint} style={{ margin: "10px 16px 0" }}>
        A manual record of each session. Ticking a step does not change the appointment, the session or the reminders.
      </p>

      {data.status === "error" && !loading && (
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>Could not load the checklist</strong>
          <span>{data.message}</span>
          <button type="button" className="btn btn-sm" onClick={() => setReload((current) => current + 1)}>
            Try again
          </button>
        </div>
      )}
      {loading && <p className="appt-empty">Loading the day…</p>}
      {!loading && data.status === "ready" && data.appointments.length === 0 && (
        <div className="state">
          <Icon name="checkCircle" />
          <strong>No appointments on {formatDate(day)}</strong>
          <span>Choose another day{psychologistId ? "" : " or psychologist"}.</span>
        </div>
      )}

      {!loading &&
        data.status === "ready" &&
        groups.map(([groupId, items]) => (
          <div key={groupId}>
            {!psychologistId && (
              <h3 style={{ margin: 0, padding: "14px 16px 0", fontSize: 14 }}>
                {psychologistNames[groupId] || "Psychologist"} <span className="muted">· {items.length}</span>
              </h3>
            )}
            <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
              {items.map((item) => {
                const { followUp, number } = sessionInfo(item);
                const checklist = data.checklists[item.id] || null;
                const entries = checklist ? data.activity[checklist.id] || [] : [];
                const who = tickedBy(checklist, entries);
                const canTick = isStaff || (ownId && ownId === String(item.psychologist_id));
                const reminders = data.reminders[item.id] || {};
                const started = new Date(item.starts_at).getTime() <= Date.now();
                return (
                  <li key={item.id} className={styles.checkCard}>
                    <div className={styles.checkHead}>
                      <strong>
                        {formatTime(item.starts_at)}–{formatTime(item.ends_at)}
                      </strong>
                      <span>{item.client_name}</span>
                      <Badge tone={followUp ? "info" : "neutral"}>
                        {followUp ? "Follow-up Session" : "New Session"}
                        {number ? ` · ${number}` : ""}
                      </Badge>
                      <StatusPill status={item.status} label={appointmentStatusLabel(item.status)} />
                      {psychologistId ? null : <span className="muted">{psychologistNames[item.psychologist_id] || ""}</span>}
                      <span className="muted">{formatDate(item.starts_at)}</span>
                      <span className={styles.grow} />
                      {isStaff && started && ["Scheduled", "Confirmed", "Completed"].includes(item.status) && (
                        <button type="button" className="btn btn-sm" onClick={() => setAfterSession({ appointment: item, session: data.sessions[item.id] || null })}>
                          After session…
                        </button>
                      )}
                    </div>

                    {(item.recommendation_id || reminders[1] || reminders[2]) && (
                      <div className="reminder-cell" style={{ marginBottom: 10, flexWrap: "wrap" }}>
                        {!isStaff ? (
                          <span className="muted">Reminders are tracked by clinic staff.</span>
                        ) : (
                          [1, 2].map((n) => (
                            <span key={n} className="reminder-cell">
                              <span className="muted">Reminder {n}:</span>
                              {reminders[n] ? (
                                <>
                                  <DeliveryBadge status={reminders[n].delivery_status} />
                                  <ResponseBadge response={reminders[n].client_response} />
                                </>
                              ) : (
                                <span className="muted">none</span>
                              )}
                            </span>
                          ))
                        )}
                      </div>
                    )}

                    <fieldset className={styles.checkGrid} style={{ border: 0, padding: 0, margin: 0 }} disabled={!canTick}>
                      <legend className="sr-only">Checklist for {item.client_name}</legend>
                      {CHECKLIST_STEPS.map((step) => {
                        const checked = Boolean(checklist && checklist[step.id]);
                        const at = checklist ? checklist[`${step.id}_at`] : null;
                        const inputId = `chk-${item.id}-${step.id}`;
                        return (
                          <label key={step.id} htmlFor={inputId} className={styles.checkItem}>
                            <input
                              id={inputId}
                              type="checkbox"
                              checked={checked}
                              disabled={!canTick || Boolean(busy)}
                              onChange={(event) => toggle(item, step.id, event.target.checked)}
                            />
                            <span>
                              {step.label}
                              {busy === `${item.id}:${step.id}` ? <small>Saving…</small> : null}
                              {checked && at ? (
                                <small>
                                  {formatTime(at)}
                                  {who[step.id] ? ` · ${who[step.id]}` : ""}
                                </small>
                              ) : null}
                            </span>
                          </label>
                        );
                      })}
                    </fieldset>

                    {rowError[item.id] && (
                      <p className="field-error" role="alert">
                        {rowError[item.id]}
                      </p>
                    )}

                    {entries.length > 0 && (
                      <details className="reminder-history" style={{ marginTop: 8 }}>
                        <summary>Activity ({entries.length})</summary>
                        <ol className="status-trail">
                          {[...entries].reverse().map((entry) => (
                            <li key={entry.id}>
                              <strong>{describeActivity(entry)}</strong>
                              <span className="block muted">
                                {entry.actor_name || "Someone"} · {formatDateTime(entry.created_at)}
                              </span>
                              {entry.details && entry.details.note ? <span className="block">{entry.details.note}</span> : null}
                            </li>
                          ))}
                        </ol>
                      </details>
                    )}
                  </li>
                );
              })}
            </ul>
          </div>
        ))}

      {afterSession && (
        <AfterSessionPanel
          appointment={afterSession.appointment}
          session={afterSession.session}
          psychologistNames={psychologistNames}
          notify={notify}
          onClose={() => setAfterSession(null)}
          onChanged={() => setReload((current) => current + 1)}
        />
      )}
    </section>
  );
}
