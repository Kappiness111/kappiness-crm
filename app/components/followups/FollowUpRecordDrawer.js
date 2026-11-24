"use client";

import { useCallback, useEffect, useState } from "react";
import Icon from "../Icon";
import ModalShell from "../ModalShell";
import ReasonDialog from "../ReasonDialog";
import { StatusPill } from "../AppointmentTable";
import CommunicationButtons from "./CommunicationButtons";
import FollowUpBookingDialog from "./FollowUpBookingDialog";
import ReminderCard from "./ReminderCard";
import ReminderUpdateDialog from "./ReminderUpdateDialog";
import { CommunicationBadge, ConfirmationBadge, DueDate, FollowUpStatusCell, FollowUpTypeBadge } from "./FollowUpBadges";
import { DeliveryBadge, ResponseBadge } from "../ui/StatusBadges";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { getAppointment } from "../../lib/appointmentsApi";
import {
  closeFollowUp,
  communicationLabel,
  describeFollowUpError,
  getSessionSummary,
  isClosedFollowUp,
  listContacts,
  todayInputValue,
  updateFollowUp,
  wantsReschedule,
} from "../../lib/followUpsApi";
import { formatDate, formatDateTime, formatTime } from "../../lib/leads";
import { listReminders } from "../../lib/remindersApi";
import { appointmentStatusLabel, sessionStatusLabel } from "../../lib/statusLabels";

// Reminder status from the view, for psychologists' read-only view (they cannot read appointment_reminders).
function ReminderLine({ number, status, response }) {
  return (
    <div className="followup-slot">
      <strong>Reminder {number}</strong>
      <span className="reminder-cell">
        {status ? <DeliveryBadge status={status} /> : <span className="muted">Not created</span>}
        {status ? <ResponseBadge response={response} /> : null}
      </span>
    </div>
  );
}

function formFrom(followUp) {
  return {
    key: followUp.updated_at,
    assignedStaffId: followUp.assigned_staff_id || "",
    dueOn: followUp.due_on || "",
    notes: followUp.notes || "",
  };
}

/* One follow-up record (a row of follow_ups_with_status). Staff can assign reception staff, change the due date
   and administrative notes (update_follow_up), record communication, record reminders and close it.
   Psychologists see the same record read-only. Clinical session notes are never shown here.
   staffNames: { userId: name } known from activity. onChanged(savedRow) after any change.
   A Type A follow-up without an appointment can be booked here ("Book follow-up", staff only). */
export default function FollowUpRecordDrawer({
  followUp,
  viewer,
  currentUserId = null,
  staffNames = {},
  psychologistNames = {},
  notify,
  onChanged,
  onClose,
  onOpenClient,
}) {
  const isStaff = Boolean(viewer && viewer.isStaff);
  const closed = isClosedFollowUp(followUp);
  const canEdit = isStaff && !closed;

  const [contacts, setContacts] = useState({ key: "", rows: [], error: "" });
  const [previous, setPrevious] = useState({ id: null, row: null, error: "" });
  const [appt, setAppt] = useState({ key: "", appointment: null, reminders: [], error: "" });
  const [tick, setTick] = useState(0);
  const [form, setForm] = useState(() => formFrom(followUp));
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [closing, setClosing] = useState(false);
  const [reminderDialog, setReminderDialog] = useState(null); // { reminder, mode }
  const [booking, setBooking] = useState(false);

  // A newer version of the row (after a save or a reload) resets the form.
  if (form.key !== followUp.updated_at) setForm(formFrom(followUp));

  const changedAppointment = useCallback(() => {
    setTick((value) => value + 1);
    onChanged({ id: followUp.id });
  }, [onChanged, followUp.id]);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: changedAppointment, notify });

  const contactsKey = `${followUp.id}|${followUp.updated_at}`;
  useEffect(() => {
    let cancelled = false;
    listContacts(followUp.id)
      .then((rows) => {
        if (!cancelled) setContacts({ key: contactsKey, rows, error: "" });
      })
      .catch((error) => {
        if (!cancelled) setContacts({ key: contactsKey, rows: [], error: describeFollowUpError(error, "Could not load the contact history.") });
      });
    return () => {
      cancelled = true;
    };
  }, [followUp.id, contactsKey]);

  useEffect(() => {
    if (!followUp.previous_session_id) return undefined;
    let cancelled = false;
    getSessionSummary(followUp.previous_session_id)
      .then((row) => {
        if (!cancelled) setPrevious({ id: followUp.previous_session_id, row, error: "" });
      })
      .catch(() => {
        if (!cancelled) setPrevious({ id: followUp.previous_session_id, row: null, error: "Could not load the previous session." });
      });
    return () => {
      cancelled = true;
    };
  }, [followUp.previous_session_id]);

  // The booked appointment of a Type A follow-up, and (staff only) its two reminders.
  const apptKey = `${followUp.appointment_id || ""}|${followUp.updated_at}|${tick}`;
  useEffect(() => {
    if (!followUp.appointment_id) return undefined;
    let cancelled = false;
    Promise.all([getAppointment(followUp.appointment_id), isStaff ? listReminders([followUp.appointment_id]) : Promise.resolve({ rows: [] })])
      .then(([appointment, reminders]) => {
        if (!cancelled) setAppt({ key: apptKey, appointment, reminders: reminders.rows, error: "" });
      })
      .catch((error) => {
        if (!cancelled) setAppt({ key: apptKey, appointment: null, reminders: [], error: describeFollowUpError(error, "Could not load the appointment.") });
      });
    return () => {
      cancelled = true;
    };
  }, [followUp.appointment_id, apptKey, isStaff]);

  const staffOptions = { ...staffNames };
  if (currentUserId) staffOptions[currentUserId] = `${staffNames[currentUserId] || viewer.name || "Me"} (me)`;
  const assignedName = followUp.assigned_staff_id
    ? followUp.assigned_staff_id === currentUserId
      ? "You"
      : staffNames[followUp.assigned_staff_id] || "A staff member"
    : "Not assigned";

  const changed =
    (form.assignedStaffId || "") !== (followUp.assigned_staff_id || "") ||
    (form.dueOn || "") !== (followUp.due_on || "") ||
    form.notes !== (followUp.notes || "");

  async function save(event) {
    event.preventDefault();
    if (saving || !changed) return;
    if (!form.assignedStaffId && followUp.assigned_staff_id) {
      setFormError("A follow-up cannot be unassigned here. Choose a staff member.");
      return;
    }
    setSaving(true);
    setFormError("");
    try {
      const saved = await updateFollowUp(followUp.id, {
        assignedStaffId: form.assignedStaffId !== (followUp.assigned_staff_id || "") ? form.assignedStaffId : undefined,
        dueOn: form.dueOn && form.dueOn !== (followUp.due_on || "") ? form.dueOn : undefined,
        notes: form.notes !== (followUp.notes || "") ? form.notes : undefined,
      });
      notify("Follow-up updated");
      onChanged(saved);
    } catch (error) {
      setFormError(describeFollowUpError(error, "Could not update the follow-up."));
    } finally {
      setSaving(false);
    }
  }

  const prevSession = previous.id === followUp.previous_session_id ? previous.row : null;
  const appointment = appt.key === apptKey ? appt.appointment : null;
  const reminder1 = appt.key === apptKey ? appt.reminders.find((row) => row.reminder_number === 1) || null : null;
  const reminder2 = appt.key === apptKey ? appt.reminders.find((row) => row.reminder_number === 2) || null : null;
  const actions = appointment && isStaff ? workflow.actionsFor(appointment) : [];
  const reschedule = wantsReschedule(followUp);

  return (
    <>
      <ModalShell variant="drawer" size="md" labelledBy="fu-record-title" onRequestClose={onClose}>
        <header className="modal-head">
          <div>
            <p style={{ margin: 0 }}>
              <FollowUpTypeBadge type={followUp.follow_up_type} long />
            </p>
            <h2 id="fu-record-title">{followUp.client_name || "Client"}</h2>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details">
            <Icon name="close" />
          </button>
        </header>

        <div className="modal-body followup-body">
          {!isStaff && (
            <div className="notice" role="status">
              <Icon name="info" />
              <div>
                <strong>Read-only</strong>
                The clinic team assigns, contacts the client and updates this follow-up.
              </div>
            </div>
          )}

          {reschedule && (
            <div className="notice warn" role="status">
              <Icon name="alert" />
              <div>
                <strong>The client wants to reschedule</strong>
                {actions.includes("reschedule") ? "Choose a new time for the booked session." : "The clinic team will arrange a new time."}
                {actions.includes("reschedule") && (
                  <div style={{ marginTop: 8 }}>
                    <button type="button" className="btn btn-primary btn-sm" onClick={() => workflow.openReschedule(appointment)}>
                      Choose a new time
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}

          <section className="info-section">
            <h4>Follow-up</h4>
            <dl className="kv">
              <dt>Status</dt>
              <dd>
                <FollowUpStatusCell row={followUp} />
              </dd>
              <dt>Client</dt>
              <dd>{followUp.client_name || "—"}</dd>
              <dt>Psychologist</dt>
              <dd>{psychologistNames[followUp.psychologist_id] || (followUp.psychologist_id ? "Psychologist" : "—")}</dd>
              <dt>Due</dt>
              <dd>
                <DueDate row={followUp} />
              </dd>
              <dt>Session number</dt>
              <dd>{followUp.session_number || "—"}</dd>
              <dt>Previous session</dt>
              <dd>
                {!followUp.previous_session_id
                  ? "—"
                  : prevSession
                    ? `${formatDate(prevSession.starts_at)}, ${formatTime(prevSession.starts_at)} · ${sessionStatusLabel(prevSession.status)}`
                    : previous.error || "Loading…"}
              </dd>
              <dt>Proposed time</dt>
              <dd>
                {followUp.proposed_starts_at
                  ? `${formatDate(followUp.proposed_starts_at)}, ${formatTime(followUp.proposed_starts_at)}${
                      followUp.proposed_ends_at ? `–${formatTime(followUp.proposed_ends_at)}` : ""
                    }`
                  : "No time proposed yet"}
              </dd>
              <dt>Client answer</dt>
              <dd>
                <ConfirmationBadge status={followUp.confirmation_status} />
              </dd>
              <dt>Reception staff</dt>
              <dd>{assignedName}</dd>
              <dt>Communication</dt>
              <dd>
                <CommunicationBadge status={followUp.communication_status} />
                {followUp.communication_updated_at ? <small className="muted"> · {formatDateTime(followUp.communication_updated_at)}</small> : null}
              </dd>
              {!canEdit && (
                <>
                  <dt>Administrative notes</dt>
                  <dd className="wrap">{followUp.notes || "—"}</dd>
                </>
              )}
              {closed && followUp.closed_at ? (
                <>
                  <dt>Closed</dt>
                  <dd>
                    {formatDateTime(followUp.closed_at)}
                    {followUp.closed_by_name ? ` · ${followUp.closed_by_name}` : ""}
                  </dd>
                </>
              ) : null}
            </dl>
          </section>

          {followUp.follow_up_type === "Type A" && (
            <section className="info-section">
              <h4>Next session booking</h4>
              {!followUp.appointment_id ? (
                <>
                  <p className="subtle-text" style={{ marginTop: 0 }}>
                    {followUp.proposed_starts_at
                      ? "A time is held for the client. It is booked once the client confirms."
                      : "No time booked yet."}
                  </p>
                  {canEdit && (
                    <div className="followup-actions">
                      <button type="button" className="btn btn-primary btn-sm" onClick={() => setBooking(true)}>
                        <Icon name="calendar" /> {followUp.proposed_starts_at ? "Client answer / change time" : "Book follow-up"}
                      </button>
                    </div>
                  )}
                </>
              ) : appt.error ? (
                <p className="field-error">{appt.error}</p>
              ) : !appointment ? (
                <p className="subtle-text">Loading the appointment…</p>
              ) : (
                <>
                  <div className="followup-slot">
                    <div>
                      <strong>
                        {formatDate(appointment.starts_at)}, {formatTime(appointment.starts_at)}–{formatTime(appointment.ends_at)}
                      </strong>
                      <span className="muted">
                        {appointment.service_type} · {psychologistNames[appointment.psychologist_id] || "Psychologist"}
                      </span>
                    </div>
                    <StatusPill status={appointment.status} label={appointmentStatusLabel(appointment.status)} />
                  </div>
                  {actions.length > 0 && (
                    <div className="followup-actions">
                      {actions.includes("confirm") && (
                        <button type="button" className="btn btn-primary btn-sm" disabled={workflow.busyId === appointment.id} onClick={() => workflow.runAction(appointment, "confirm")}>
                          Record client confirmation
                        </button>
                      )}
                      {actions.includes("reschedule") && !reschedule && (
                        <button type="button" className="btn btn-sm" onClick={() => workflow.openReschedule(appointment)}>
                          Reschedule
                        </button>
                      )}
                      {actions.includes("cancel") && (
                        <button type="button" className="btn btn-sm btn-danger" onClick={() => workflow.runAction(appointment, "cancel")}>
                          Cancel appointment
                        </button>
                      )}
                    </div>
                  )}
                </>
              )}
            </section>
          )}

          <section className="info-section">
            <h4>Reminders</h4>
            {!followUp.appointment_id ? (
              <p className="subtle-text">Two reminders are created when the next session is booked.</p>
            ) : !isStaff ? (
              <div className="reminder-pair">
                <ReminderLine number={1} status={followUp.reminder_1_status} response={followUp.reminder_1_response} />
                <ReminderLine number={2} status={followUp.reminder_2_status} response={followUp.reminder_2_response} />
              </div>
            ) : (
              <div className="reminder-pair">
                <ReminderCard number={1} reminder={reminder1} canManage={!closed} onRecord={(reminder, mode) => setReminderDialog({ reminder, mode })} />
                <ReminderCard number={2} reminder={reminder2} canManage={!closed} onRecord={(reminder, mode) => setReminderDialog({ reminder, mode })} />
              </div>
            )}
          </section>

          {canEdit && (
            <section className="info-section">
              <h4>Record communication</h4>
              <CommunicationButtons followUp={followUp} notify={notify} onSaved={(result) => onChanged(result.followUp)} />
            </section>
          )}

          {canEdit && (
            <section className="info-section">
              <h4>Assign and update</h4>
              <form onSubmit={save} noValidate style={{ display: "grid", gap: 12 }}>
                <div className="field">
                  <label htmlFor="fu-assign">Reception staff</label>
                  <select id="fu-assign" value={form.assignedStaffId} onChange={(event) => setForm((current) => ({ ...current, assignedStaffId: event.target.value }))}>
                    {!followUp.assigned_staff_id && <option value="">Not assigned</option>}
                    {followUp.assigned_staff_id && !staffOptions[followUp.assigned_staff_id] && <option value={followUp.assigned_staff_id}>A staff member (current)</option>}
                    {Object.entries(staffOptions).map(([id, name]) => (
                      <option key={id} value={id}>
                        {name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="fu-due">Due date</label>
                  <input id="fu-due" type="date" min={todayInputValue()} value={form.dueOn} onChange={(event) => setForm((current) => ({ ...current, dueOn: event.target.value }))} />
                </div>
                <div className="field">
                  <label htmlFor="fu-notes">Administrative notes</label>
                  <textarea id="fu-notes" rows={3} maxLength={2000} value={form.notes} onChange={(event) => setForm((current) => ({ ...current, notes: event.target.value }))} />
                  <p className="field-hint">For scheduling and contact only. Do not write clinical details here.</p>
                </div>
                {formError && (
                  <p className="field-error" role="alert">
                    {formError}
                  </p>
                )}
                <div className="followup-actions" style={{ marginTop: 0 }}>
                  <button type="submit" className="btn btn-primary btn-sm" disabled={saving || !changed}>
                    {saving ? "Saving…" : "Save changes"}
                  </button>
                </div>
              </form>
            </section>
          )}

          <section className="info-section">
            <h4>Contact history</h4>
            {contacts.error ? (
              <p className="field-error">{contacts.error}</p>
            ) : contacts.key !== contactsKey ? (
              <p className="subtle-text">Loading…</p>
            ) : contacts.rows.length === 0 ? (
              <p className="subtle-text">No contact recorded yet.</p>
            ) : (
              <ol className="status-trail">
                {contacts.rows.map((row) => (
                  <li key={row.id}>
                    <strong>{communicationLabel(row.communication_status)}</strong>
                    {row.previous_status ? <span className="muted"> (was {communicationLabel(row.previous_status)})</span> : null}
                    <span className="block muted">
                      Recorded by {row.contacted_by_name || "a staff member"} on {formatDateTime(row.contacted_at)}
                    </span>
                    {row.note ? <span className="block">{row.note}</span> : null}
                    {row.created_follow_up_id ? <span className="block muted">A call follow-up (Contact client) was created for reception.</span> : null}
                  </li>
                ))}
              </ol>
            )}
          </section>
        </div>

        <footer className="modal-foot">
          {onOpenClient && (
            <button type="button" className="btn" onClick={() => onOpenClient(followUp.client_id)}>
              View client profile
            </button>
          )}
          {canEdit && (
            <button type="button" className="btn" onClick={() => setClosing(true)}>
              Close follow-up…
            </button>
          )}
        </footer>
      </ModalShell>

      {closing && (
        <ReasonDialog
          title="Close follow-up"
          subtitle={followUp.client_name}
          label="Note"
          confirmLabel="Close follow-up"
          choices={[
            { value: "Completed", label: "Completed" },
            { value: "No Follow-up Required", label: "No Follow-up Required" },
          ]}
          onClose={() => setClosing(false)}
          onSubmit={async (note, status) => {
            try {
              const saved = await closeFollowUp(followUp.id, status, note);
              notify(`Follow-up closed: ${status}`);
              onChanged(saved);
              return { ok: true };
            } catch (error) {
              return { ok: false, message: describeFollowUpError(error, "Could not close the follow-up.") };
            }
          }}
        />
      )}

      {reminderDialog && (
        <ReminderUpdateDialog
          reminder={reminderDialog.reminder}
          mode={reminderDialog.mode}
          clientName={followUp.client_name || "Client"}
          onClose={() => setReminderDialog(null)}
          onSaved={(saved, value) => {
            setReminderDialog(null);
            notify(
              reminderDialog.mode === "delivery"
                ? `Reminder ${saved.reminder_number} marked ${value}`
                : `Reminder ${saved.reminder_number}: client response "${value}" recorded`
            );
            changedAppointment();
          }}
        />
      )}

      {booking && (
        <FollowUpBookingDialog
          followUp={followUp}
          psychologistNames={psychologistNames}
          notify={notify}
          onClose={() => setBooking(false)}
          onChanged={(saved) => {
            setTick((value) => value + 1);
            onChanged(saved);
          }}
        />
      )}

      {workflow.dialogs}
    </>
  );
}
