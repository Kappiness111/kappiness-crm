"use client";

import { useEffect, useState } from "react";
import Dialog from "../Dialog";
import { StatusPill } from "../AppointmentTable";
import FollowUpBookingDialog from "../followups/FollowUpBookingDialog";
import styles from "../followups/followups.module.css";
import { recordAttendance } from "../../lib/appointmentsApi";
import { updateChecklist } from "../../lib/checklistApi";
import { closeFollowUp, createFollowUp, describeFollowUpError, getFollowUp, listFollowUps } from "../../lib/followUpsApi";
import { formatDate, formatTime } from "../../lib/leads";
import { listRecommendations, listSessions } from "../../lib/sessionsApi";
import { sessionStatusLabel } from "../../lib/statusLabels";

/* Guided steps after a session (staff only; the database checks every step again):
     a. Mark the appointment Completed with the existing attendance function (record_attendance).
     b. Show the client's updated session history (dates and statuses only; no clinical notes).
     c. Is a follow-up needed? Yes: create a Type A follow-up (linked to the open recommendation of this session if
        there is one) and book it with the follow-up booking dialog. No: record "No Follow-up Required" with a note.
     d. Tick "Session completed" and "Next follow-up discussed" on the checklist.
   Every finished step is listed, so if one fails the user knows exactly what was already saved.
   appointment: mapped appointment. session: its session row (or null). onChanged() after any change. */
export default function AfterSessionPanel({ appointment, session, psychologistNames = {}, notify, onClose, onChanged }) {
  const [done, setDone] = useState([]); // [{ id, label }]
  const [failure, setFailure] = useState(""); // what failed and why
  const [busy, setBusy] = useState("");
  const [completed, setCompleted] = useState(appointment.status === "Completed");
  const [history, setHistory] = useState({ key: "", rows: [], error: "" });
  const [answer, setAnswer] = useState(""); // "yes" | "no"
  const [note, setNote] = useState("");
  const [booking, setBooking] = useState(null); // follow-up view row for the booking dialog
  const [finished, setFinished] = useState(false);

  const historyKey = `${appointment.client_id}|${completed}|${done.length}`;
  useEffect(() => {
    let cancelled = false;
    listSessions({ clientId: appointment.client_id })
      .then((rows) => {
        if (!cancelled) setHistory({ key: historyKey, rows, error: "" });
      })
      .catch((error) => {
        if (!cancelled) setHistory({ key: historyKey, rows: [], error: describeFollowUpError(error, "Could not load the session history.") });
      });
    return () => {
      cancelled = true;
    };
  }, [appointment.client_id, historyKey]);

  const record = (id, label) => setDone((list) => (list.some((item) => item.id === id) ? list : [...list, { id, label }]));
  const has = (id) => done.some((item) => item.id === id);

  // Runs one step; on failure keeps what was done and says which step failed.
  async function step(id, label, action) {
    setFailure("");
    try {
      const result = await action();
      record(id, label);
      onChanged();
      return { ok: true, result };
    } catch (error) {
      // Checks raised by this panel are plain errors written for people; database errors are translated.
      const reason = error && !error.code && error.plain ? error.message : describeFollowUpError(error, "Please try again.");
      setFailure(`Not saved: ${label}. ${reason}`);
      return { ok: false };
    }
  }

  const plainError = (message) => Object.assign(new Error(message), { plain: true });

  // Creating a follow-up is its own saved step, so a later failure never hides that it exists.
  async function createTypeA(recommendationId = null) {
    const saved = await createFollowUp({ clientId: appointment.client_id, type: "Type A", recommendationId });
    record("created", recommendationId ? "Follow-up created (Type A · Next session, linked to the recommendation)" : "Follow-up created (Type A · Next session)");
    onChanged();
    return saved;
  }

  async function markCompleted() {
    if (busy) return;
    setBusy("complete");
    const attended = await step("attendance", "Appointment marked Completed", () => recordAttendance(appointment.id, true));
    if (attended.ok) {
      setCompleted(true);
      await step("tick-completed", "Checklist: Session completed ticked", () => updateChecklist(appointment.id, { session_completed: true }));
    }
    setBusy("");
  }

  // The client's open Type A follow-up, or a new one (linked to this session's open recommendation if any).
  async function findOrCreateFollowUp() {
    const open = await listFollowUps({ clientId: appointment.client_id, type: "Type A", openOnly: true });
    if (open.length) {
      if (open[0].appointment_id) throw plainError("This client already has a booked next session.");
      record("created", "Existing follow-up used (Type A · Next session)");
      return open[0];
    }
    const recommendations = await listRecommendations({ clientId: appointment.client_id, statuses: ["Open"] });
    const linked = (session && recommendations.find((rec) => rec.session_id === session.id)) || recommendations[recommendations.length - 1] || null;
    const saved = await createTypeA(linked ? linked.id : null);
    return (await getFollowUp(saved.id)) || saved;
  }

  async function followUpYes() {
    if (busy) return;
    setBusy("yes");
    const found = await step("follow-up", "Follow-up ready for booking", findOrCreateFollowUp);
    if (found.ok) {
      await step("tick-discussed", "Checklist: Next follow-up discussed ticked", () => updateChecklist(appointment.id, { next_follow_up_discussed: true }));
      setBooking(found.result);
    }
    setBusy("");
  }

  async function followUpNo() {
    if (busy) return;
    if (!note.trim()) return setFailure("Add a note saying why no follow-up is needed.");
    setBusy("no");
    const closed = await step("no-follow-up", "No Follow-up Required recorded", async () => {
      const open = await listFollowUps({ clientId: appointment.client_id, type: "Type A", openOnly: true });
      if (open.some((row) => row.appointment_id)) throw plainError("A next session is already booked. Cancel it first if it is not needed.");
      const target = open[0] || (await createTypeA());
      return closeFollowUp(target.id, "No Follow-up Required", note);
    });
    if (closed.ok) {
      await step("tick-discussed", "Checklist: Next follow-up discussed ticked", () => updateChecklist(appointment.id, { next_follow_up_discussed: true }));
      setFinished(true);
    }
    setBusy("");
  }

  async function onBooked(saved, { confirmed }) {
    const label = confirmed
      ? `Next session booked for ${formatDate(saved.proposed_starts_at)}, ${formatTime(saved.proposed_starts_at)} (client confirmed)`
      : `Next session ${saved.status === "Pending Confirmation" ? "Pending Confirmation" : "held as Tentative"}: ${formatDate(saved.proposed_starts_at)}, ${formatTime(saved.proposed_starts_at)}`;
    setDone((list) => [...list.filter((item) => item.id !== "booking"), { id: "booking", label }]);
    onChanged();
    if (confirmed) {
      await step("tick-booked", "Checklist: Next appointment booked ticked", () => updateChecklist(appointment.id, { next_appointment_booked: true }));
      setFinished(true);
    }
  }

  const sessions = history.key === historyKey ? history.rows : [];

  return (
    <>
      <Dialog
        titleId="after-session-title"
        title="After the session"
        subtitle={`${appointment.client_name}, ${formatDate(appointment.starts_at)} ${formatTime(appointment.starts_at)} · ${psychologistNames[appointment.psychologist_id] || "Psychologist"}`}
        onClose={onClose}
        busy={Boolean(busy)}
        footer={
          <button type="button" className="btn" onClick={onClose} disabled={Boolean(busy)}>
            {finished ? "Done" : "Close"}
          </button>
        }
      >
        <div className="modal-body" style={{ display: "grid", gap: 16 }}>
          <section>
            <h4 style={{ margin: "0 0 6px" }}>1. Mark the session completed</h4>
            {completed ? (
              <p className="subtle-text" style={{ margin: 0 }}>
                {has("attendance") ? "Marked as completed." : "This appointment is already completed."}
              </p>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={markCompleted} disabled={Boolean(busy) || new Date(appointment.starts_at) > new Date()}>
                {busy === "complete" ? "Saving…" : "Mark as completed"}
              </button>
            )}
            {!completed && new Date(appointment.starts_at) > new Date() && <p className={styles.hint}>Available once the session has started.</p>}
          </section>

          <section>
            <h4 style={{ margin: "0 0 6px" }}>2. Session history</h4>
            {history.error ? (
              <p className="field-error">{history.error}</p>
            ) : history.key !== historyKey ? (
              <p className="subtle-text">Loading…</p>
            ) : sessions.length === 0 ? (
              <p className="subtle-text">No sessions yet.</p>
            ) : (
              <ol className="status-trail" style={{ maxHeight: 180, overflow: "auto" }}>
                {sessions.map((row) => (
                  <li key={row.id}>
                    {formatDate(row.starts_at)}, {formatTime(row.starts_at)} · {row.session_type} ·{" "}
                    <StatusPill status={row.status} label={sessionStatusLabel(row.status)} />
                  </li>
                ))}
              </ol>
            )}
          </section>

          {completed && (
            <section>
              <h4 style={{ margin: "0 0 6px" }}>3. Is a follow-up session needed?</h4>
              {!has("follow-up") && !has("no-follow-up") && (
                <div className={styles.choiceRow} role="radiogroup" aria-label="Follow-up needed">
                  <button type="button" className={`chip ${answer === "yes" ? "active" : ""}`} aria-checked={answer === "yes"} role="radio" onClick={() => setAnswer("yes")}>
                    Yes
                  </button>
                  <button type="button" className={`chip ${answer === "no" ? "active" : ""}`} aria-checked={answer === "no"} role="radio" onClick={() => setAnswer("no")}>
                    No
                  </button>
                </div>
              )}
              {answer === "yes" && !has("follow-up") && (
                <div style={{ marginTop: 8 }}>
                  <button type="button" className="btn btn-primary btn-sm" onClick={followUpYes} disabled={Boolean(busy)}>
                    {busy === "yes" ? "Preparing…" : "Choose the next session time"}
                  </button>
                </div>
              )}
              {has("follow-up") && !has("booking") && !booking && (
                <button type="button" className="btn btn-sm" style={{ marginTop: 8 }} onClick={async () => setBooking((await listFollowUps({ clientId: appointment.client_id, type: "Type A", openOnly: true }))[0] || null)}>
                  Open the booking again
                </button>
              )}
              {answer === "no" && !has("no-follow-up") && (
                <div className="field" style={{ marginTop: 8 }}>
                  <label htmlFor="after-no-note">Note</label>
                  <input id="after-no-note" type="text" maxLength={1000} value={note} onChange={(event) => setNote(event.target.value)} placeholder="For example: treatment finished" />
                  <div style={{ marginTop: 6 }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={followUpNo} disabled={Boolean(busy)}>
                      {busy === "no" ? "Saving…" : "Record No Follow-up Required"}
                    </button>
                  </div>
                </div>
              )}
            </section>
          )}

          {(done.length > 0 || failure) && (
            <section aria-live="polite">
              <h4 style={{ margin: "0 0 6px" }}>Saved so far</h4>
              {done.length === 0 ? (
                <p className="subtle-text" style={{ margin: 0 }}>
                  Nothing has been saved yet.
                </p>
              ) : (
                <ul className={styles.steps}>
                  {done.map((item) => (
                    <li key={item.id} className={styles.stepDone}>
                      {item.label}
                    </li>
                  ))}
                </ul>
              )}
              {failure && (
                <p className={`field-error ${styles.stepFailed}`} role="alert" style={{ marginTop: 6 }}>
                  {failure}
                </p>
              )}
            </section>
          )}
        </div>
      </Dialog>

      {booking && (
        <FollowUpBookingDialog
          followUp={booking}
          psychologistNames={psychologistNames}
          notify={notify}
          onClose={() => setBooking(null)}
          onChanged={onBooked}
        />
      )}
    </>
  );
}
