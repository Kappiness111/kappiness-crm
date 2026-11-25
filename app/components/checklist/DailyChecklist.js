"use client";

import { Fragment, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Icon from "../Icon";
import { StatusPill } from "../AppointmentTable";
import { Badge, DeliveryBadge, ResponseBadge } from "../ui/StatusBadges";
import SessionChecklist from "./SessionChecklist";
import SessionDetailsPanel from "./SessionDetailsPanel";
import styles from "./checklist.module.css";
import { APPOINTMENT_STATUSES, describeAppointmentError, listAppointments, recordAttendance } from "../../lib/appointmentsApi";
import {
  describeActivity,
  listChecklistActivity,
  listChecklists,
  notApplicableSteps,
  sessionKind,
  updateChecklist,
} from "../../lib/checklistApi";
import { listFollowUps, todayInputValue } from "../../lib/followUpsApi";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { listReminders } from "../../lib/remindersApi";
import { listSessions } from "../../lib/sessionsApi";
import { listAppointmentSessionNumbers, listSessionFollowUpFlags } from "../../lib/sessionFollowUpApi";
import { appointmentStatusLabel } from "../../lib/statusLabels";

// Cancelled and rescheduled appointments have no checklist (the database refuses them).
const SHOWN_STATUSES = ["Scheduled", "Confirmed", "Completed", "Missed"];
const NO_PROGRESS_STATUSES = ["Cancelled", "Rescheduled", "Missed"];

function dayRange(day) {
  const from = new Date(`${day}T00:00`);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  return { from, to };
}

// "Wednesday, 25 November 2026" for a YYYY-MM-DD day, read in local time.
function formatLongDay(day) {
  const date = new Date(`${day}T00:00`);
  const weekday = date.toLocaleDateString("en-GB", { weekday: "long" });
  const rest = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric" });
  return `${weekday}, ${rest}`;
}

function getProgressDropdownPosition(anchor) {
  const rect = anchor.getBoundingClientRect();
  const viewportMargin = 12;
  const gap = 8;
  const width = Math.min(320, window.innerWidth - viewportMargin * 2);
  const left = Math.max(viewportMargin, Math.min(rect.left, window.innerWidth - width - viewportMargin));
  const preferredHeight = Math.min(420, window.innerHeight - viewportMargin * 2);
  const below = window.innerHeight - rect.bottom - gap - viewportMargin;
  const above = rect.top - gap - viewportMargin;
  const placement = below < Math.min(preferredHeight, 280) && above > below ? "above" : "below";
  const availableHeight = placement === "above" ? above : below;

  return {
    left,
    top: placement === "above" ? rect.top - gap : rect.bottom + gap,
    maxHeight: Math.max(80, Math.min(preferredHeight, availableHeight)),
    placement,
  };
}

/* The day at a glance: every appointment of the day with its checklist (the same SessionChecklist block as the
   session details panel, so there is one checklist). "Open" shows the whole session on one screen: details,
   attendance, checklist, reminders and what comes next.
   The checklist is only a record: ticking never changes appointment, session or reminder status.
   viewer: { isStaff, ownPsychologist }. psychologistId fixes the list to one psychologist (their own workspace).
   Ticking is allowed for staff and for the appointment's own psychologist (the database checks again).
   No clinical notes or session summaries are loaded here. */
export default function DailyChecklist({
  viewer,
  psychologistId = null,
  psychologistNames = {},
  notify,
  onOpenClient,
  view = "daily",
  sessionManagement = false,
}) {
  const [day, setDay] = useState(todayInputValue());
  const [psychologistFilter, setPsychologistFilter] = useState("");
  const [reload, setReload] = useState(0);
  const [data, setData] = useState({
    key: "",
    status: "loading",
    message: "",
    appointments: [],
    sessions: {},
    checklists: {},
    activity: {},
    reminders: {},
    noFollowUp: [],
    followUpFlags: {},
    followUpFlagsError: "",
    sessionNumbers: {},
  });
  const [openId, setOpenId] = useState(null);
  const [expandedId, setExpandedId] = useState(null);
  const progressAnchorRef = useRef(null);
  const progressDropdownRef = useRef(null);
  const [progressPosition, setProgressPosition] = useState(null);
  const isStaff = Boolean(viewer && viewer.isStaff);
  const ownId = viewer && viewer.ownPsychologist ? String(viewer.ownPsychologist.id) : null;
  const scope = psychologistId || psychologistFilter || null;
  const base = `${view}|${sessionManagement}|${day}|${scope || ""}`; // a new view, day or psychologist shows "Loading".
  const key = `${base}|${reload}`;
  const refresh = () => setReload((current) => current + 1);

  // Daily Sessions always shows the current day: follow the system date when it changes
  // (midnight, or the tab coming back after sleep). Saved checklist progress lives in the database, so it is untouched.
  useEffect(() => {
    if (!sessionManagement) return undefined;
    const syncToday = () => setDay((current) => (current === todayInputValue() ? current : todayInputValue()));
    syncToday();
    const timer = window.setInterval(syncToday, 30000);
    const onVisible = () => {
      if (document.visibilityState === "visible") syncToday();
    };
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("focus", syncToday);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("focus", syncToday);
    };
  }, [sessionManagement]);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const { from: dayFrom, to: dayTo } = dayRange(day);
        const from = view === "upcoming" ? new Date() : dayFrom;
        const to = view === "upcoming" ? null : dayTo;
        const statuses = sessionManagement
          ? APPOINTMENT_STATUSES
          : view === "upcoming"
            ? ["Scheduled", "Confirmed"]
            : SHOWN_STATUSES;
        const appointments = (await listAppointments({ from, to, psychologistId: scope, statuses })).sort(
          (a, b) => new Date(a.starts_at) - new Date(b.starts_at)
        );
        const ids = appointments.map((item) => item.id);
        const [sessionRows, checklists, reminderResult, noFollowUp, sessionNumbers] = await Promise.all([
          listSessions({ from, to, psychologistId: scope }),
          listChecklists(ids),
          isStaff ? listReminders(ids) : Promise.resolve({ rows: [] }),
          view === "daily" && ids.length
            ? listFollowUps({ psychologistId: scope, type: "Type A", status: "No Follow-up Required" })
            : Promise.resolve([]),
          listAppointmentSessionNumbers(ids),
        ]);
        const activity = await listChecklistActivity(Object.values(checklists).map((row) => row.id));
        let followUpFlags = {};
        let followUpFlagsError = "";
        try {
          followUpFlags = await listSessionFollowUpFlags(sessionRows.map((row) => row.id));
        } catch (error) {
          console.error("Could not load session follow-up status:", error);
          followUpFlagsError = "Follow-up status could not be loaded. Appointments and Session Progress are still available.";
        }
        const sessions = {};
        sessionRows.forEach((row) => {
          if (row.appointment_id) sessions[row.appointment_id] = row;
        });
        const reminders = {};
        reminderResult.rows.forEach((row) => {
          (reminders[row.appointment_id] = reminders[row.appointment_id] || {})[row.reminder_number] = row;
        });
        if (!cancelled) {
          setData({
            key,
            base,
            status: "ready",
            message: "",
            appointments,
            sessions,
            checklists,
            activity,
            reminders,
            noFollowUp,
            followUpFlags,
            followUpFlagsError,
            sessionNumbers,
          });
        }
      } catch (error) {
        console.error("Failed to load the daily checklist:", error);
        if (!cancelled) {
          setData((current) => ({
            ...current,
            key,
            base,
            status: "error",
            message: describeAppointmentError(error, sessionManagement ? "Could not load Daily Sessions." : "Could not load the checklist."),
          }));
        }
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [day, scope, isStaff, key, base, view, sessionManagement]);

  useEffect(() => {
    setExpandedId(null);
    setProgressPosition(null);
    progressAnchorRef.current = null;
  }, [base]);

  useEffect(() => {
    if (!expandedId || !progressDropdownRef.current) return;
    const firstCheckbox = progressDropdownRef.current.querySelector('input[type="checkbox"]:not(:disabled)');
    if (firstCheckbox) firstCheckbox.focus();
  }, [expandedId]);

  useEffect(() => {
    if (!expandedId) return undefined;
    function updatePosition() {
      if (progressAnchorRef.current && progressAnchorRef.current.isConnected) {
        setProgressPosition(getProgressDropdownPosition(progressAnchorRef.current));
      }
    }
    function handlePointerDown(event) {
      if (
        progressDropdownRef.current &&
        progressDropdownRef.current.contains(event.target)
      ) {
        return;
      }
      if (progressAnchorRef.current && progressAnchorRef.current.contains(event.target)) return;
      setExpandedId(null);
      setProgressPosition(null);
      progressAnchorRef.current = null;
    }
    function handleKeyDown(event) {
      if (event.key !== "Escape") return;
      if (progressAnchorRef.current) progressAnchorRef.current.focus();
      setExpandedId(null);
      setProgressPosition(null);
      progressAnchorRef.current = null;
    }

    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [expandedId]);

  const loading = data.base !== base;

  function kindOf(item) {
    return sessionKind(item, data.sessions[item.id] || null);
  }

  function noFollowUpNeeded(item) {
    const session = data.sessions[item.id];
    return (
      Boolean(session && data.followUpFlags[session.id] && data.followUpFlags[session.id].required === false) ||
      data.noFollowUp.some((row) => row.client_id === item.client_id && row.closed_at && new Date(row.closed_at) >= new Date(item.starts_at))
    );
  }

  async function completeSession(item) {
    if (item.status !== "Completed") await recordAttendance(item.id, true);
    try {
      return await updateChecklist(item.id, { session_completed: true });
    } catch (error) {
      refresh();
      setOpenId(item.id);
      throw Object.assign(
        new Error(`Session completed, but Session Progress could not be saved: ${describeAppointmentError(error, "Please try again.")}`),
        { plain: true }
      );
    }
  }

  function closeProgressDropdown() {
    setExpandedId(null);
    setProgressPosition(null);
    progressAnchorRef.current = null;
  }

  function toggleProgressDropdown(itemId, event) {
    if (expandedId === itemId) {
      closeProgressDropdown();
      return;
    }
    progressAnchorRef.current = event.currentTarget;
    setExpandedId(itemId);
    setProgressPosition(getProgressDropdownPosition(event.currentTarget));
  }

  const psychologistOptions = Object.entries(psychologistNames).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const opened = openId ? data.appointments.find((item) => item.id === openId) || null : null;
  const progressItem = expandedId ? data.appointments.find((item) => item.id === expandedId) || null : null;
  const progressChecklist = progressItem ? data.checklists[progressItem.id] || null : null;
  const progressEntries = progressChecklist ? data.activity[progressChecklist.id] || [] : [];
  const progressCanTick =
    progressItem && (isStaff || (ownId && ownId === String(progressItem.psychologist_id)));
  // Session Management offers Session Progress for every eligible appointment of the day, whatever its time.
  const progressAvailable =
    progressItem &&
    (sessionManagement || new Date(progressItem.starts_at).getTime() <= Date.now()) &&
    !NO_PROGRESS_STATUSES.includes(progressItem.status);

  return (
    <section className="panel" aria-label={sessionManagement ? "Daily Sessions" : view === "upcoming" ? "Upcoming sessions" : "Daily sessions"}>
      <div className="toolbar">
        {view === "daily" && sessionManagement && (
          <h2 className={styles.currentDay} aria-live="polite">
            <Icon name="calendar" />
            <time dateTime={day}>{formatLongDay(day)}</time>
          </h2>
        )}
        {view === "daily" && !sessionManagement && (
          <label htmlFor="checklist-day" className={styles.datePicker}>
            <Icon name="calendar" />
            <span className="sr-only">Select session date</span>
            <input id="checklist-day" type="date" value={day} onChange={(event) => setDay(event.target.value || todayInputValue())} />
          </label>
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

      {!sessionManagement && (
        <p className="subtle-text" style={{ margin: "10px 16px 0" }}>
          Expand an appointment to update its checklist, or open it to manage attendance and session details.
        </p>
      )}

      {data.status === "error" && !loading && (
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>{sessionManagement ? "Could not load Daily Sessions" : "Could not load the checklist"}</strong>
          <span>{data.message}</span>
          <button type="button" className="btn btn-sm" onClick={refresh}>
            Try again
          </button>
        </div>
      )}
      {loading && <p className="appt-empty">Loading the day…</p>}
      {sessionManagement && data.status === "ready" && data.followUpFlagsError && (
        <p className="field-error" role="alert" style={{ margin: "10px 16px 0" }}>
          {data.followUpFlagsError}
        </p>
      )}
      {!loading && data.status === "ready" && data.appointments.length === 0 && (
        <div className="state">
          <Icon name="checkCircle" />
          <strong>{view === "upcoming" ? "No upcoming sessions" : `No appointments on ${formatDate(day)}`}</strong>
          <span>
            {view === "upcoming"
              ? "There are no scheduled appointments ahead."
              : sessionManagement
                ? `There are no appointments scheduled for today${psychologistId || !psychologistFilter ? "" : " for this psychologist"}.`
                : `Choose another date${psychologistId ? "" : " or psychologist"}.`}
          </span>
        </div>
      )}

      {!loading && sessionManagement && data.status === "ready" && data.appointments.length > 0 && (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th scope="col">Client</th>
                <th scope="col">Session Type</th>
                <th scope="col">Psychologist</th>
                <th scope="col">Time</th>
                <th scope="col">Session Number</th>
                <th scope="col">Status</th>
                <th scope="col">Action</th>
              </tr>
            </thead>
            <tbody>
              {data.appointments.map((item) => {
                const kind = kindOf(item);
                const checklist = data.checklists[item.id] || null;
                const entries = checklist ? data.activity[checklist.id] || [] : [];
                const canTick = isStaff || (ownId && ownId === String(item.psychologist_id));
                const expanded = expandedId === item.id;
                const sessionNumber = data.sessionNumbers[item.id];
                const progressAvailable = !NO_PROGRESS_STATUSES.includes(item.status);
                return (
                  <Fragment key={item.id}>
                    <tr>
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
                      <td>{formatTime(item.starts_at)}–{formatTime(item.ends_at)}</td>
                      <td>{sessionNumber || "—"}</td>
                      <td>
                        <StatusPill
                          status={item.status}
                          label={item.status === "Scheduled" ? "Yet to confirm" : appointmentStatusLabel(item.status)}
                        />
                      </td>
                      <td>
                        <div className="appt-actions">
                          {progressAvailable && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              ref={expanded ? progressAnchorRef : null}
                              aria-expanded={expanded}
                              aria-controls={`session-progress-${item.id}`}
                              onClick={(event) => toggleProgressDropdown(item.id, event)}
                            >
                              Session Progress
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn btn-sm"
                            onClick={() => setOpenId(item.id)}
                            aria-label={`View details for ${item.client_name}`}
                          >
                            View details
                          </button>
                        </div>
                      </td>
                    </tr>
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {!loading && !sessionManagement && data.status === "ready" && data.appointments.length > 0 && (
        <ul className={styles.dayList}>
          {data.appointments.map((item) => {
                const kind = kindOf(item);
                const session = data.sessions[item.id] || null;
                const followUpDecision = session ? data.followUpFlags[session.id] : undefined;
                const followUpFlag = followUpDecision ? followUpDecision.required : undefined;
                const checklist = data.checklists[item.id] || null;
                const entries = checklist ? data.activity[checklist.id] || [] : [];
                const canTick = isStaff || (ownId && ownId === String(item.psychologist_id));
                const reminders = data.reminders[item.id] || {};
                const expanded = expandedId === item.id;
                const sessionNumber = data.sessionNumbers[item.id];
                return (
                  <li key={item.id} className={styles.dayRow}>
                    <div className={styles.dayHead}>
                      <strong>
                        {formatTime(item.starts_at)}–{formatTime(item.ends_at)}
                      </strong>
                      {onOpenClient ? (
                        <button type="button" className="link-btn" onClick={() => onOpenClient(item.client_id)}>
                          {item.client_name}
                        </button>
                      ) : (
                        <span>{item.client_name}</span>
                      )}
                      <Badge tone={kind.followUp ? "info" : "neutral"}>{kind.label}</Badge>
                      {sessionNumber ? <span className="muted">Session {sessionNumber}</span> : null}
                      <StatusPill status={item.status} label={item.status === "Scheduled" ? "Yet to confirm" : appointmentStatusLabel(item.status)} />
                      <span className={styles.therapist}>
                        <span className="muted">Therapist:</span> {psychologistNames[item.psychologist_id] || "Assigned"}
                      </span>
                      <span className={styles.reminderStatus}>
                        <span className="muted">Reminder:</span>
                        {!isStaff ? (
                          <span className="muted">Tracked by reception</span>
                        ) : reminders[1] || reminders[2] ? (
                          [1, 2].map((number) =>
                            reminders[number] ? (
                              <span key={number} className="reminder-cell">
                                <span className="muted">R{number}</span>
                                <DeliveryBadge status={reminders[number].delivery_status} />
                                {reminders[number].client_response ? <ResponseBadge response={reminders[number].client_response} /> : null}
                              </span>
                            ) : null
                          )
                        ) : (
                          <span className="muted">No reminder record</span>
                        )}
                      </span>
                      {item.status === "Completed" && (
                        <Badge tone={followUpFlag === true ? "info" : followUpFlag === false ? "neutral" : "warning"}>
                          {followUpFlag === true
                            ? `Follow-up required${followUpDecision.date ? ` · ${formatDate(followUpDecision.date)}` : ""}`
                            : followUpFlag === false
                              ? "No follow-up required"
                              : "Follow-up decision pending"}
                        </Badge>
                      )}
                      <span className={styles.grow} />
                      <button
                        type="button"
                        className="btn btn-sm"
                        aria-expanded={expanded}
                        aria-controls={`session-checklist-${item.id}`}
                        onClick={() => setExpandedId(expanded ? null : item.id)}
                      >
                        {expanded ? "Hide checklist" : "Checklist"}
                      </button>
                      <button type="button" className="btn btn-sm" onClick={() => setOpenId(item.id)} aria-label={`Open session for ${item.client_name}`}>
                        Open
                      </button>
                    </div>

                    {expanded && (
                      <div id={`session-checklist-${item.id}`} className={styles.expandedChecklist}>
                        <SessionChecklist
                          compact
                          appointmentId={item.id}
                          clientName={item.client_name}
                          checklist={checklist}
                          entries={entries}
                          canTick={canTick}
                          notApplicable={notApplicableSteps({ appointment: item, noFollowUpNeeded: noFollowUpNeeded(item) })}
                          onSaved={refresh}
                        />

                        {entries.length > 0 && (
                          <details className="reminder-history">
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
                      </div>
                    )}
                  </li>
                );
          })}
        </ul>
      )}

      {opened && (
        <SessionDetailsPanel
          appointment={opened}
          viewer={viewer}
          psychologistNames={psychologistNames}
          notify={notify}
          onOpenClient={onOpenClient}
          onClose={() => setOpenId(null)}
          onChanged={refresh}
          sessionManagement={sessionManagement}
        />
      )}
      {sessionManagement && !loading && progressAvailable && progressPosition && typeof document !== "undefined" &&
        createPortal(
          <div
            id={`session-progress-${progressItem.id}`}
            ref={progressDropdownRef}
            className={styles.progressDropdown}
            role="region"
            aria-label={`Session Progress for ${progressItem.client_name}`}
            tabIndex={0}
            style={{
              left: progressPosition.left,
              top: progressPosition.top,
              maxHeight: progressPosition.maxHeight,
              transform: progressPosition.placement === "above" ? "translateY(-100%)" : undefined,
            }}
          >
            <SessionChecklist
              compact
              flat
              appointmentId={progressItem.id}
              clientName={progressItem.client_name}
              checklist={progressChecklist}
              entries={progressEntries}
              canTick={progressCanTick}
              appointmentStatus={progressItem.status}
              onComplete={() => completeSession(progressItem)}
              onSaved={(saved, stepId, value) => {
                if (stepId === "session_completed" && value) {
                  setOpenId(progressItem.id);
                  closeProgressDropdown();
                }
                refresh();
              }}
            />
          </div>,
          document.body
        )}
    </section>
  );
}
