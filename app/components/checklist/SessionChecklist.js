"use client";

import { useState } from "react";
import Icon from "../Icon";
import styles from "./checklist.module.css";
import { describeAppointmentError } from "../../lib/appointmentsApi";
import { CHECKLIST_GROUPS, CHECKLIST_STEPS, stepLabel, tickedBy, updateChecklist } from "../../lib/checklistApi";
import { formatTime } from "../../lib/leads";
import { setChecklistNotApplicable } from "../../lib/sessionFollowUpApi";

/* The six session steps as one compact block. Most steps write through update_session_checklist; the
   Session Management view can supply the canonical attendance action for session completion.
   checklist: the session_checklists row (or null). entries: its activity_log rows (for "who ticked").
   canTick: staff, or the appointment's own psychologist (the database checks again).
   notApplicable: { stepId: reason } from notApplicableSteps(); the legacy checklist view displays these.
   onSaved(row, stepId, value) after a successful change. notify(message) optional. */
export default function SessionChecklist({
  appointmentId,
  clientName = "",
  checklist,
  entries = [],
  canTick,
  notApplicable = {},
  onSaved,
  notify,
  compact = false,
  flat = false,
  appointmentStatus = "",
  onComplete,
}) {
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [announce, setAnnounce] = useState("");
  const [editingNotApplicable, setEditingNotApplicable] = useState("");
  const [reasonDraft, setReasonDraft] = useState("");
  // Session Progress ignores legacy Not Applicable metadata without changing its saved data.
  const automaticNotApplicable = flat ? {} : notApplicable;
  const reasons = flat ? {} : { ...((checklist && checklist.not_applicable) || {}), ...automaticNotApplicable };
  const who = tickedBy(checklist, entries);

  const applicable = CHECKLIST_STEPS.filter((step) => !reasons[step.id]);
  const countable = flat ? CHECKLIST_STEPS : applicable;
  const total = flat ? CHECKLIST_STEPS.length : applicable.length;
  const done = countable.filter((step) => checklist && checklist[step.id]).length;
  const groups = flat
    ? [{ id: "all", label: "", steps: CHECKLIST_STEPS.map((step) => step.id) }]
    : CHECKLIST_GROUPS;

  function labelFor(stepId) {
    return flat && stepId === "reminder_sent" ? "Reminder sent (if required)" : stepLabel(stepId);
  }

  async function toggle(stepId, value) {
    if (busy || !canTick) return;
    setBusy(stepId);
    setError("");
    try {
      if (stepId === "session_completed" && !value && appointmentStatus === "Completed") return;
      const saved = stepId === "session_completed" && value && onComplete
        ? await onComplete()
        : await updateChecklist(appointmentId, { [stepId]: value });
      const message = `${labelFor(stepId)} ${value ? "ticked" : "unticked"}${clientName ? ` for ${clientName}` : ""}.`;
      setAnnounce(message);
      if (notify) notify(message);
      if (onSaved) onSaved(saved, stepId, value);
    } catch (err) {
      setError(
        err && err.plain
          ? err.message
          : describeAppointmentError(err, flat ? "Could not update Session Progress." : "Could not update the checklist.")
      );
    } finally {
      setBusy("");
    }
  }

  async function saveNotApplicable(stepId, reason) {
    if (busy || !canTick) return;
    if (reason !== null && !reason.trim()) {
      setError("Add a reason before marking this step not applicable.");
      return;
    }
    setBusy(stepId);
    setError("");
    try {
      const saved = await setChecklistNotApplicable(appointmentId, stepId, reason);
      setEditingNotApplicable("");
      setReasonDraft("");
      const message = reason ? `${labelFor(stepId)} marked not applicable.` : `${labelFor(stepId)} made applicable.`;
      setAnnounce(message);
      if (notify) notify(message);
      if (onSaved) onSaved(saved, stepId, reason);
    } catch (err) {
      setError(describeAppointmentError(err, flat ? "Could not update Session Progress." : "Could not update the checklist."));
    } finally {
      setBusy("");
    }
  }

  return (
    <div className={`${styles.checklist} ${compact ? styles.compact : ""} ${flat ? styles.flat : ""}`}>
      <div className={styles.progressRow}>
        <span className={styles.progressText}>
          <strong>
            {done} of {total}
          </strong>{" "}
          done
        </span>
        <span className={styles.progressBar} aria-hidden="true">
          <span style={{ width: `${total ? Math.round((done / total) * 100) : 0}%` }} />
        </span>
        {!canTick && <span className="muted">View only</span>}
      </div>

      <div className={styles.groups}>
        {groups.map((group) => (
          <fieldset key={group.id} className={styles.group} disabled={!canTick}>
            {group.label && <legend className={styles.groupLabel}>{group.label}</legend>}
            <ol className={styles.steps}>
              {group.steps.map((stepId) => {
                const reason = reasons[stepId];
                const isAutomatic = Boolean(automaticNotApplicable[stepId]);
                const checked = Boolean(checklist && checklist[stepId]);
                const at = checklist ? checklist[`${stepId}_at`] : null;
                const inputId = `step-${appointmentId}-${stepId}`;
                const state = reason ? "na" : checked ? "done" : "pending";
                const label = labelFor(stepId);
                return (
                  <li key={stepId} className={`${styles.step} ${styles[state]}`}>
                    <input
                      id={inputId}
                      type="checkbox"
                      checked={checked && !reason}
                      disabled={
                        !canTick ||
                        Boolean(reason) ||
                        Boolean(busy) ||
                        (stepId === "session_completed" && appointmentStatus === "Completed" && checked)
                      }
                      onChange={(event) => toggle(stepId, event.target.checked)}
                      aria-describedby={`${inputId}-meta`}
                    />
                    <label htmlFor={inputId}>
                      <span className={styles.stepName}>
                        {!flat && state === "done" ? <Icon name="check" /> : null}
                        {label}
                      </span>
                      <small id={`${inputId}-meta`} className={styles.stepMeta}>
                        {busy === stepId
                          ? "Saving…"
                          : reason
                            ? `Not applicable · ${reason}`
                            : checked && at
                              ? `${formatTime(at)}${who[stepId] ? ` · ${who[stepId]}` : ""}`
                              : "Pending"}
                      </small>
                    </label>
                    {!flat && !reason && canTick && (
                      <button
                        type="button"
                        className={styles.naAction}
                        onClick={() => {
                          setEditingNotApplicable(stepId);
                          setReasonDraft("");
                          setError("");
                        }}
                        disabled={Boolean(busy)}
                      >
                        Not applicable
                      </button>
                    )}
                    {!flat && reason && canTick && !isAutomatic && (
                      <button type="button" className={styles.naAction} onClick={() => saveNotApplicable(stepId, null)} disabled={Boolean(busy)}>
                        Make applicable
                      </button>
                    )}
                    {!flat && editingNotApplicable === stepId && (
                      <form
                        className={styles.naForm}
                        onSubmit={(event) => {
                          event.preventDefault();
                          saveNotApplicable(stepId, reasonDraft);
                        }}
                      >
                        <input
                          autoFocus
                          aria-label={`Reason ${label} is not applicable`}
                          value={reasonDraft}
                          onChange={(event) => setReasonDraft(event.target.value)}
                          maxLength={200}
                          placeholder="Reason"
                          required
                        />
                        <button type="submit" className="btn btn-sm" disabled={Boolean(busy)}>
                          Save
                        </button>
                        <button type="button" className={styles.naAction} onClick={() => setEditingNotApplicable("")} disabled={Boolean(busy)}>
                          Cancel
                        </button>
                      </form>
                    )}
                  </li>
                );
              })}
            </ol>
          </fieldset>
        ))}
      </div>

      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <p className="sr-only" aria-live="polite">
        {announce}
      </p>
    </div>
  );
}
