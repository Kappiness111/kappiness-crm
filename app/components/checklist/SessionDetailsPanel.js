"use client";

import { useCallback, useEffect, useState } from "react";
import Icon from "../Icon";
import ModalShell from "../ModalShell";
import { StatusPill } from "../AppointmentTable";
import { Badge, DeliveryBadge, ResponseBadge } from "../ui/StatusBadges";
import SessionChecklist from "./SessionChecklist";
import SessionFollowUpDecision from "./SessionFollowUpDecision";
import styles from "./checklist.module.css";
import { FollowUpStatusCell, FollowUpTypeBadge, DueDate } from "../followups/FollowUpBadges";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { ACTIVE_APPOINTMENT_STATUSES, describeAppointmentError, getAppointment, listAppointments, recordAttendance } from "../../lib/appointmentsApi";
import {
  listChecklistActivity,
  listChecklists,
  notApplicableSteps,
  sessionKind,
  updateChecklist,
} from "../../lib/checklistApi";
import { listFollowUps } from "../../lib/followUpsApi";
import { formatDate, formatTime } from "../../lib/leads";
import { listReminders } from "../../lib/remindersApi";
import { listSessionFollowUpFlags } from "../../lib/sessionFollowUpApi";
import { getSessionByAppointment } from "../../lib/sessionsApi";
import { appointmentStatusLabel } from "../../lib/statusLabels";

/* Everything reception or the psychologist needs for ONE session, on one screen:
     top      client, New Session / Follow-up, psychologist, date and time, appointment status
     actions  confirm, mark completed / missed (existing attendance function), reschedule, cancel,
              and the psychologist's after-session decision
     middle   the session checklist (shared with the daily checklist)
     bottom   reminders (staff) and what comes next: the next appointment and the open follow-up
   Clinical notes and the session summary are never loaded here, so this screen is safe for reception.
   appointment: a mapped appointment (appointmentsApi). viewer: { isStaff, ownPsychologist }.
   onChanged() after any change so the list behind can refresh. */
export default function SessionDetailsPanel({
  appointment,
  viewer,
  psychologistNames = {},
  notify,
  onClose,
  onChanged,
  onOpenClient,
  sessionManagement = false,
  readOnly = false,
}) {
  const isStaff = Boolean(viewer && viewer.isStaff);
  const ownId = viewer && viewer.ownPsychologist ? String(viewer.ownPsychologist.id) : null;
  const [tick, setTick] = useState(0);
  const [data, setData] = useState({ key: "", status: "loading", message: "" });
  const [busy, setBusy] = useState("");

  const refresh = useCallback(() => {
    setTick((value) => value + 1);
    if (onChanged) onChanged();
  }, [onChanged]);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: refresh, notify });

  const key = `${appointment.id}|${tick}`;
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const appt = (await getAppointment(appointment.id)) || appointment;
        const [session, checklists, reminders, upcoming, openFollowUps, noFollowUp, original] = await Promise.all([
          getSessionByAppointment(appt.id),
          sessionManagement ? Promise.resolve({}) : listChecklists([appt.id]),
          isStaff ? listReminders([appt.id]) : Promise.resolve({ rows: [] }),
          listAppointments({ clientId: appt.client_id, from: new Date(), statuses: ACTIVE_APPOINTMENT_STATUSES }),
          listFollowUps({ clientId: appt.client_id, openOnly: true }),
          listFollowUps({ clientId: appt.client_id, type: "Type A", status: "No Follow-up Required" }),
          appt.rescheduled_from_id ? getAppointment(appt.rescheduled_from_id).catch(() => null) : Promise.resolve(null),
        ]);
        let followUpFlags = {};
        let followUpFlagError = "";
        if (session && !readOnly) {
          try {
            followUpFlags = await listSessionFollowUpFlags([session.id]);
          } catch (error) {
            console.error("Could not load session follow-up status:", error);
            followUpFlagError = "Follow-up status could not be loaded.";
          }
        }
        const checklist = checklists[appt.id] || null;
        const activity = checklist && !sessionManagement ? (await listChecklistActivity([checklist.id]))[checklist.id] || [] : [];
        if (cancelled) return;
        setData({
          key,
          status: "ready",
          message: "",
          appt,
          session,
          followUpRequired: session && followUpFlags[session.id] ? followUpFlags[session.id].required : undefined,
          followUpDate: session && followUpFlags[session.id] ? followUpFlags[session.id].date : null,
          followUpFlagError,
          checklist,
          activity,
          reminders: reminders.rows,
          next: upcoming.find((item) => item.id !== appt.id && new Date(item.starts_at) > new Date(appt.starts_at)) || null,
          followUps: openFollowUps,
          // Closed as "No Follow-up Required" after this session started.
          noFollowUpNeeded:
            (session && followUpFlags[session.id] && followUpFlags[session.id].required === false) ||
            noFollowUp.some((row) => row.closed_at && new Date(row.closed_at) >= new Date(appt.starts_at)),
          original,
        });
      } catch (error) {
        console.error("Failed to load the session:", error);
        if (!cancelled) setData((current) => ({ ...current, key, status: "error", message: describeAppointmentError(error, "Could not load this session.") }));
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [appointment, key, isStaff, readOnly, sessionManagement]);

  const ready = data.status === "ready";
  const appt = ready ? data.appt : appointment;
  const kind = sessionKind(appt, ready ? data.session : null);
  const canTick = isStaff || (ownId && ownId === String(appt.psychologist_id));
  const canEditDecision = ownId && String(appt.psychologist_id) === ownId;
  const actions = workflow.actionsFor(appt);
  const started = new Date(appt.starts_at).getTime() <= Date.now();
  const reminder1 = ready ? data.reminders.find((row) => row.reminder_number === 1) || null : null;
  const reminder2 = ready ? data.reminders.find((row) => row.reminder_number === 2) || null : null;

  // Existing attendance function, then tick "Session completed" so the checklist matches. Each step is reported.
  async function markCompleted() {
    if (busy) return;
    setBusy("completed");
    try {
      await recordAttendance(appt.id, true);
    } catch (error) {
      notify(describeAppointmentError(error, "Could not mark the session as completed."), "error");
      setBusy("");
      return;
    }
    try {
      await updateChecklist(appt.id, { session_completed: true });
      notify("Session marked as completed. Checklist updated.");
    } catch (error) {
      notify(`Session marked as completed, but the checklist was not updated: ${describeAppointmentError(error, "please tick it again.")}`, "error");
    }
    setBusy("");
    refresh();
  }

  return (
    <>
      <ModalShell variant="drawer" size="md" labelledBy="session-details-title" onRequestClose={onClose}>
        <header className="modal-head">
          <div>
            <p style={{ margin: 0 }}>Session</p>
            <h2 id="session-details-title">{appt.client_name || "Client"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close session details">
            <Icon name="close" />
          </button>
        </header>

        <div className="modal-body followup-body">
          <section className={`info-section ${styles.summary}`} aria-label="Appointment">
            <div className={styles.summaryRow}>
              <span className={styles.when}>
                {formatDate(appt.starts_at)}, {formatTime(appt.starts_at)}–{formatTime(appt.ends_at)}
              </span>
            </div>
            <div className={styles.summaryRow}>
              <Badge tone={kind.followUp ? "info" : "neutral"}>{kind.label}</Badge>
              <StatusPill status={appt.status} label={appt.status === "Scheduled" ? "Yet to confirm" : appointmentStatusLabel(appt.status)} />
              {ready && data.original ? <span className="muted">Rescheduled from {formatDate(data.original.starts_at)}</span> : null}
            </div>
            <div className={styles.summaryRow}>
              <span>
                <span className="muted">Psychologist </span>
                {psychologistNames[appt.psychologist_id] || "—"}
              </span>
              {appt.service_type ? (
                <span>
                  <span className="muted">Service </span>
                  {appt.service_type}
                </span>
              ) : null}
            </div>

            {!readOnly && (actions.length > 0 || (isStaff && started)) && (
              <div className={styles.actions} style={{ marginTop: 4 }}>
                {actions.includes("confirm") && (
                  <button type="button" className="btn btn-sm" disabled={Boolean(busy) || workflow.busyId === appt.id} onClick={() => workflow.runAction(appt, "confirm")}>
                    Record client confirmation
                  </button>
                )}
                {actions.includes("attended") && !sessionManagement && (
                  <button type="button" className="btn btn-primary btn-sm" disabled={Boolean(busy)} onClick={markCompleted}>
                    <Icon name="check" /> {busy === "completed" ? "Saving…" : "Mark as completed"}
                  </button>
                )}
                {actions.includes("missed") && (
                  <button type="button" className="btn btn-sm" disabled={Boolean(busy) || workflow.busyId === appt.id} onClick={() => workflow.runAction(appt, "missed")}>
                    Mark as missed
                  </button>
                )}
                {actions.includes("reschedule") && (
                  <button type="button" className="btn btn-sm" onClick={() => workflow.openReschedule(appt)}>
                    Reschedule
                  </button>
                )}
                {actions.includes("cancel") && (
                  <button type="button" className="btn btn-sm btn-danger" onClick={() => workflow.runAction(appt, "cancel")}>
                    Cancel
                  </button>
                )}
              </div>
            )}
          </section>

          {!sessionManagement && !readOnly && (
            <section className="info-section" aria-labelledby="session-checklist-title">
              <h4 id="session-checklist-title">Checklist</h4>
              {data.status === "error" && data.key === key ? (
                <p className="field-error" role="alert">
                  {data.message}
                </p>
              ) : !ready ? (
                <p className="subtle-text">Loading…</p>
              ) : ["Cancelled", "Rescheduled"].includes(appt.status) ? (
                <p className="subtle-text">A {appt.status.toLowerCase()} appointment has no checklist.</p>
              ) : (
                <SessionChecklist
                  appointmentId={appt.id}
                  clientName={appt.client_name}
                  checklist={data.checklist}
                  entries={data.activity}
                  canTick={canTick}
                  notApplicable={notApplicableSteps({ appointment: appt, noFollowUpNeeded: data.noFollowUpNeeded })}
                  notify={notify}
                  onSaved={refresh}
                />
              )}
            </section>
          )}

          {isStaff && (reminder1 || reminder2) && (
            <section className="info-section" aria-label="Reminders">
              <h4>Reminders</h4>
              <div className="reminder-cell" style={{ flexWrap: "wrap" }}>
                {[reminder1, reminder2].map((reminder, index) => (
                  <span key={index} className="reminder-cell">
                    <span className="muted">Reminder {index + 1}:</span>
                    {reminder ? (
                      <>
                        <DeliveryBadge status={reminder.delivery_status} />
                        <ResponseBadge response={reminder.client_response} />
                      </>
                    ) : (
                      <span className="muted">none</span>
                    )}
                  </span>
                ))}
              </div>
            </section>
          )}

          {ready && appt.status === "Completed" && !readOnly && (
            <section className="info-section" aria-label="After-session follow-up">
              <h4>After the session</h4>
              {data.followUpFlagError && <p className="field-error" role="alert">{data.followUpFlagError}</p>}
              {!data.session ? (
                <p className="field-error" role="alert">The session record could not be found.</p>
              ) : canEditDecision ? (
                <SessionFollowUpDecision sessionId={data.session.id} notify={notify} onSaved={refresh} />
              ) : viewer.isAdmin ? (
                <SessionFollowUpDecision sessionId={data.session.id} notify={notify} onSaved={refresh} canEdit={false} />
              ) : (
                <p className="subtle-text">
                  {data.followUpRequired === true
                    ? "The psychologist recorded that a follow-up is required."
                    : data.followUpRequired === false
                      ? "The psychologist recorded that no follow-up is required."
                      : "The psychologist will record the follow-up decision."}
                </p>
              )}
            </section>
          )}

          <section className="info-section" aria-labelledby="session-next-title">
            <h4 id="session-next-title">What comes next</h4>
            {!ready ? (
              <p className="subtle-text">Loading…</p>
            ) : (
              <div className={styles.nextGrid}>
                <div className={styles.nextCard}>
                  <h5>Next appointment</h5>
                  {data.next ? (
                    <>
                      <strong>
                        {formatDate(data.next.starts_at)}, {formatTime(data.next.starts_at)}
                      </strong>
                      <span>
                        <StatusPill status={data.next.status} label={data.next.status === "Scheduled" ? "Yet to confirm" : appointmentStatusLabel(data.next.status)} />{" "}
                        <span className="muted">{psychologistNames[data.next.psychologist_id] || ""}</span>
                      </span>
                    </>
                  ) : (
                    <span className="muted">None booked</span>
                  )}
                </div>
                <div className={styles.nextCard}>
                  <h5>Follow-up</h5>
                  {data.followUps.length > 0 ? (
                    data.followUps.slice(0, 2).map((row) => (
                      <span key={row.id} style={{ display: "grid", gap: 4 }}>
                        <span className="reminder-cell" style={{ flexWrap: "wrap" }}>
                          <FollowUpTypeBadge type={row.follow_up_type} />
                          <FollowUpStatusCell row={row} />
                        </span>
                        <span className="muted">
                          {row.proposed_starts_at ? (
                            `${formatDate(row.proposed_starts_at)}, ${formatTime(row.proposed_starts_at)}`
                          ) : (
                            <>
                              Due <DueDate row={row} />
                            </>
                          )}
                        </span>
                      </span>
                    ))
                  ) : data.followUpRequired === true ? (
                    <span className="muted">
                      Follow-up required{data.followUpDate ? ` · ${formatDate(data.followUpDate)}` : ""}
                    </span>
                  ) : (
                    <span className="muted">{data.followUpRequired === false || data.noFollowUpNeeded ? "No follow-up needed" : "No follow-up planned"}</span>
                  )}
                </div>
              </div>
            )}
          </section>
        </div>

        {onOpenClient && (
          <footer className="modal-foot">
            <button type="button" className="btn" onClick={() => onOpenClient(appt.client_id)}>
              View client profile
            </button>
          </footer>
        )}
      </ModalShell>

      {!readOnly && workflow.dialogs}
    </>
  );
}
