"use client";

import { useEffect, useRef, useState } from "react";
import Field, { fieldProps } from "./Field";
import Icon from "./Icon";
import ModalShell from "./ModalShell";
import StatusBadge from "./StatusBadge";
import {
  CONTACT_METHODS,
  NOTES_LIMIT,
  SERVICES,
  SOURCES,
  STATUSES,
  dueLabel,
  formatDate,
  formatDateTime,
  formatTime,
  getActivity,
  getFollowUpState,
  parseDate,
  quickFollowUpValue,
  relativeTime,
  toInputValue,
  whatsappLink,
} from "../lib/leads";
import { APPOINTMENT_STATUSES } from "../lib/appointmentsApi";

const ACTIVITY_ICONS = {
  created: "plus",
  note: "note",
  status: "check",
  followup: "clock",
  update: "edit",
};

// Activities logged by staff and stored in the Supabase `lead_activities` table.
const ACTIVITY_TYPES = ["Phone call", "Message", "Callback", "Email", "Meeting", "Note"];
const OUTCOMES = [
  "Answered",
  "No answer",
  "Callback requested",
  "Appointment booked",
  "Information shared",
  "Not interested",
  "Other",
];
const LOGGED_ACTIVITY_ICONS = {
  "Phone call": "phone",
  Message: "chat",
  Callback: "clock",
  Email: "mail",
  Meeting: "calendar",
  Note: "note",
  // System-generated history events saved by page.js
  "Lead created": "plus",
  "Status change": "check",
  "Follow-up": "clock",
  "Lead update": "edit",
};

function makeActivityDraft(lead, staffName = "") {
  return {
    activity_type: "Phone call",
    staff_member: (staffName || lead.assigned_staff || "").trim(),
    occurred_at: toInputValue(new Date()),
    notes: "",
    outcome: "",
  };
}

function validateActivityDraft(draft) {
  const errors = {};
  if (!ACTIVITY_TYPES.includes(draft.activity_type)) {
    errors.activity_type = "Choose an activity type.";
  }
  if (!draft.occurred_at) {
    errors.occurred_at = "Choose the date and time of the activity.";
  } else if (!parseDate(draft.occurred_at)) {
    errors.occurred_at = "Enter a valid date and time.";
  }
  if (draft.notes.length > NOTES_LIMIT) {
    errors.notes = `Keep notes under ${NOTES_LIMIT} characters.`;
  }
  if (draft.outcome && !OUTCOMES.includes(draft.outcome)) {
    errors.outcome = "Choose one of the listed outcomes.";
  }
  return errors;
}

function isDuplicateActivity(existing, draft) {
  const existingAt = parseDate(existing.at);
  const draftAt = parseDate(draft.occurred_at);
  if (!existingAt || !draftAt) return false;

  return (
    existing.type === draft.activity_type &&
    (existing.staff || "").trim() === draft.staff_member.trim() &&
    Math.floor(existingAt.getTime() / 60000) === Math.floor(draftAt.getTime() / 60000) &&
    (existing.text || "").trim() === draft.notes.trim() &&
    (existing.outcome || "") === draft.outcome
  );
}

function newActivityId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

function timeValue(value) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

// Merges activity lists by stable id. Earlier lists win, so a fresh database row replaces an older copy.
function mergeById(...lists) {
  const seen = new Set();
  const merged = [];
  for (const list of lists) {
    for (const item of list) {
      const key = String(item.id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(item);
    }
  }
  return merged;
}

function makeDraft(lead) {
  return {
    status: lead.status,
    source: lead.source || "",
    contact_method: lead.contact_method || "",
    next_follow_up_at: toInputValue(lead.next_follow_up_at),
    assigned_staff: lead.assigned_staff || "",
    service_interest: lead.service_interest || SERVICES[0],
    notes: lead.notes || "",
  };
}

function validateDraft(draft, lead) {
  const errors = {};
  const originalSource = lead.source || "";
  const originalContactMethod = lead.contact_method || "";
  const sourceUnchanged = draft.source === originalSource;

  // Keep existing records editable when they contain values from an older
  // dropdown set. A changed source must use a current option and get a method.
  if (!SOURCES.includes(draft.source) && !(sourceUnchanged && originalSource)) {
    errors.source = "Choose a valid lead source.";
  }
  if (
    !CONTACT_METHODS.includes(draft.contact_method) &&
    !(sourceUnchanged && draft.contact_method === originalContactMethod)
  ) {
    errors.contact_method = "Choose a contact method.";
  }
  // The follow-up date is optional for every status.
  if (draft.next_follow_up_at && !parseDate(draft.next_follow_up_at)) {
    errors.next_follow_up_at = "Enter a valid date and time.";
  } else if (
    draft.next_follow_up_at &&
    draft.next_follow_up_at !== toInputValue(lead.next_follow_up_at) &&
    parseDate(draft.next_follow_up_at).getTime() < Date.now() - 60000
  ) {
    // Only a newly chosen time must be in the future; an existing overdue time can stay until it is handled.
    errors.next_follow_up_at = "Pick a time in the future.";
  }
  if (draft.notes.length > NOTES_LIMIT) {
    errors.notes = `Keep notes under ${NOTES_LIMIT} characters.`;
  }
  return errors;
}

// Builds a readable activity entry for each meaningful change.
function describeChanges(lead, draft) {
  const base = makeDraft(lead);
  const entries = [];
  const followUp = draft.next_follow_up_at;
  const staff = draft.assigned_staff.trim();

  if (draft.status !== base.status) {
    entries.push({ type: "status", text: `Status changed from ${base.status} to ${draft.status}` });
  }

  if (base.next_follow_up_at !== followUp) {
    entries.push({
      type: "followup",
      text: followUp ? `Follow up scheduled for ${formatDateTime(followUp)}` : "Follow up cleared",
    });
  }

  if (base.assigned_staff.trim() !== staff) {
    entries.push({ type: "update", text: staff ? `Assigned to ${staff}` : "Staff assignment removed" });
  }

  const detailFields = ["source", "contact_method", "service_interest", "notes"];
  if (detailFields.some((field) => base[field].trim() !== draft[field].trim())) {
    entries.push({ type: "update", text: "Lead details updated" });
  }

  return entries;
}

function InfoItem({ label, children, wide = false }) {
  return (
    <div className={`info-item ${wide ? "wide" : ""}`}>
      <span>{label}</span>
      <strong>{children}</strong>
    </div>
  );
}

export default function LeadDetailsModal({
  lead,
  now,
  staffOptions = [],
  currentStaffName = "",
  onClose,
  onSave,
  onLoadActivities,
  onLogActivity,
  activityRevision = 0,
  initialTab = "overview",
  followUpBusy = false,
  onDelete,
  onCompleteFollowUp,
  onSnoozeFollowUp,
  canUpdateStatus = true,
  appointments = [],
  psychologistNames = {},
  canManageAppointment = () => true,
  canScheduleAppointments = true,
  onRequestBooking,
  onRequestReschedule,
  onUpdateAppointmentStatus,
}) {
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => makeDraft(lead));
  const [submitted, setSubmitted] = useState(false);
  const [activityDraft, setActivityDraft] = useState(() => makeActivityDraft(lead, currentStaffName));
  const [activitySubmitted, setActivitySubmitted] = useState(false);
  const [activitySaving, setActivitySaving] = useState(false);
  const [activitySaveError, setActivitySaveError] = useState("");
  const [activityDuplicateWarning, setActivityDuplicateWarning] = useState(false);
  const [loggedActivities, setLoggedActivities] = useState([]);
  const [loadState, setLoadState] = useState("idle"); // idle | loading | ready | error
  const [loadKey, setLoadKey] = useState(0);
  const [editSaving, setEditSaving] = useState(false);
  const [editSaveError, setEditSaveError] = useState("");
  const loadedRevision = useRef(null);
  const loadSeq = useRef(0); // only the newest load request may update state
  const savedActivitiesRef = useRef(new Map()); // rows saved in this drawer, so an older load can never drop them
  const activityIdRef = useRef(null);
  const savingRef = useRef(false);
  const editSavingRef = useRef(false);
  // Quick status change on the Overview tab.
  const [statusSaving, setStatusSaving] = useState(false);
  const [statusError, setStatusError] = useState("");
  const statusSavingRef = useRef(false);
  const [apptBusyId, setApptBusyId] = useState(null);
  const [apptError, setApptError] = useState("");

  // Loads the saved activity history for this lead:
  //  - on mount and whenever the parent records new system history (activityRevision), so the badge is right
  //    before the Activity tab is opened, and
  //  - every time the Activity tab is opened, so it always shows the latest rows.
  useEffect(() => {
    if (typeof onLoadActivities !== "function") return undefined;
    if (tab !== "activity" && loadedRevision.current === activityRevision) return undefined;
    const requestId = ++loadSeq.current;
    let cancelled = false;

    async function load() {
      setLoadState((state) => (state === "ready" ? state : "loading"));
      try {
        const rows = await onLoadActivities(lead.id);
        if (cancelled || requestId !== loadSeq.current) return;
        loadedRevision.current = activityRevision;
        // Database rows win; rows saved in this drawer stay even if this request started before they were inserted.
        setLoggedActivities(mergeById(rows, [...savedActivitiesRef.current.values()]));
        setLoadState("ready");
      } catch {
        if (!cancelled && requestId === loadSeq.current) setLoadState("error");
      }
    }

    load();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, loadKey, lead.id, activityRevision]);

  // Single source for both the timeline and the Activity badge, newest first:
  //   database rows (deduplicated by id) + legacy local entries from the lead record.
  // A legacy entry is dropped when a database row has the same id, and the legacy "created" entry is
  // dropped once a "Lead created" row exists in lead_activities, so nothing shows or counts twice.
  const hasSavedCreated = loggedActivities.some((item) => item.type === "Lead created");
  const savedIds = new Set(loggedActivities.map((item) => String(item.id)));
  const localEntries = getActivity(lead)
    .filter((item) => !(hasSavedCreated && item.type === "created"))
    .filter((item) => !savedIds.has(String(item.id)))
    .map((item) => ({ ...item, id: `local-${item.id}`, source: "local" }));
  const activity = [...mergeById(loggedActivities), ...localEntries].sort((a, b) => timeValue(b.at) - timeValue(a.at));
  const activityErrors = validateActivityDraft(activityDraft);
  const activityError = (field) => (activitySubmitted ? activityErrors[field] : undefined);
  const activityProps = (field) => fieldProps(`activity-${field}`, activityError(field));
  const setActivityField = (field) => (event) => {
    setActivityDuplicateWarning(false);
    setActivityDraft((current) => ({ ...current, [field]: event.target.value }));
  };
  const activityStaffChoices = [
    ...new Set([...staffOptions, (lead.assigned_staff || "").trim(), currentStaffName].filter(Boolean)),
  ].sort();
  const followUpState = getFollowUpState(lead, now);
  const errors = validateDraft(draft, lead);
  const visibleError = (field) => (submitted ? errors[field] : undefined);
  const editDirty = tab === "edit" && JSON.stringify(draft) !== JSON.stringify(makeDraft(lead));

  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const onChange = (field) => (event) => setField(field, event.target.value);
  const props = (field) => fieldProps(`edit-${field}`, visibleError(field));

  function requestClose() {
    const activityDirty = Boolean(activityDraft.notes.trim() || activityDraft.outcome);
    if ((editDirty || activityDirty) && !window.confirm("Close without saving your changes?")) return;
    onClose();
  }

  async function changeStatus(newStatus) {
    if (statusSavingRef.current || newStatus === lead.status) return;
    if (!canUpdateStatus) {
      setStatusError("You do not have permission to change lead statuses.");
      return;
    }
    statusSavingRef.current = true;
    setStatusSaving(true);
    setStatusError("");

    let result = null;
    try {
      result = await onSave(
        lead.id,
        { status: newStatus },
        [{ type: "status", text: `Status changed from ${lead.status} to ${newStatus}` }]
      );
    } catch {
      result = null;
    }

    statusSavingRef.current = false;
    setStatusSaving(false);
    if (!result || !result.ok) {
      setStatusError((result && result.message) || "Could not save this change. Please try again.");
    }
  }

  async function changeAppointmentStatus(appointment, status) {
    if (apptBusyId || status === appointment.status) return;
    setApptBusyId(appointment.id);
    setApptError("");
    const result = await onUpdateAppointmentStatus(appointment, status);
    setApptBusyId(null);
    if (!result || !result.ok) setApptError((result && result.message) || "Could not update the appointment.");
  }

  function openEdit() {
    setDraft(makeDraft(lead));
    setSubmitted(false);
    setEditSaveError("");
    setTab("edit");
  }

  async function handleSave(event) {
    event.preventDefault();
    if (editSavingRef.current) return; // block duplicate submissions
    setSubmitted(true);

    const first = ["source", "contact_method", "next_follow_up_at", "notes"].find(
      (field) => errors[field]
    );
    if (first) {
      document.getElementById(`edit-${first}`)?.focus();
      return;
    }

    if (draft.status !== lead.status && !canUpdateStatus) {
      setEditSaveError("You do not have permission to change lead statuses.");
      return;
    }

    const entries = describeChanges(lead, draft);
    if (entries.length === 0) {
      setTab("overview");
      return;
    }

    editSavingRef.current = true;
    setEditSaving(true);
    setEditSaveError("");

    const result = await onSave(
      lead.id,
      {
        status: draft.status,
        source: draft.source,
        contact_method: draft.contact_method,
        assigned_staff: draft.assigned_staff.trim(),
        next_follow_up_at: draft.next_follow_up_at,
        service_interest: draft.service_interest,
        notes: draft.notes.trim(),
      },
      entries
    );

    editSavingRef.current = false;
    setEditSaving(false);

    if (!result || !result.ok) {
      // Stay on the Edit tab with everything the user typed still in place.
      setEditSaveError((result && result.message) || "Could not save your changes. Please try again.");
      return;
    }
    setTab("overview");
  }

  async function saveActivity(allowDuplicate = false) {
    if (savingRef.current) return; // block duplicate submissions
    setActivitySubmitted(true);
    setActivitySaveError("");

    const first = ["activity_type", "occurred_at", "notes", "outcome"].find((field) => activityErrors[field]);
    if (first) {
      document.getElementById(`activity-${first}`)?.focus();
      return;
    }

    if (
      !allowDuplicate &&
      loadState === "ready" &&
      loggedActivities.some((item) => isDuplicateActivity(item, activityDraft))
    ) {
      setActivityDuplicateWarning(true);
      return;
    }

    savingRef.current = true;
    setActivitySaving(true);
    // One id per entry: a retry after a failed save reuses it instead of creating a second row.
    if (!activityIdRef.current) activityIdRef.current = newActivityId();

    const result = await onLogActivity(lead, {
      id: activityIdRef.current,
      activity_type: activityDraft.activity_type,
      staff_member: activityDraft.staff_member.trim(),
      occurred_at: activityDraft.occurred_at,
      notes: activityDraft.notes.trim(),
      outcome: activityDraft.outcome,
    });

    savingRef.current = false;
    setActivitySaving(false);

    if (!result || !result.ok) {
      // Keep the form as typed so nothing is lost.
      setActivitySaveError((result && result.message) || "Could not save this activity. Please try again.");
      return;
    }

    // Shown only now that Supabase has confirmed the insert.
    savedActivitiesRef.current.set(String(result.activity.id), result.activity);
    setLoggedActivities((current) => mergeById([result.activity], current));
    activityIdRef.current = null;
    setActivityDraft(makeActivityDraft(lead, currentStaffName));
    setActivitySubmitted(false);
    setActivityDuplicateWarning(false);
  }

  function handleLogActivity(event) {
    event.preventDefault();
    void saveActivity(false);
  }

  function handleDelete() {
    if (!window.confirm(`Delete ${lead.full_name} (${lead.lead_code})? This cannot be undone.`)) return;
    onDelete(lead.id);
  }

  const tabs = [
    { id: "overview", label: "Overview" },
    { id: "activity", label: "Activity", count: activity.length },
    { id: "edit", label: "Edit" },
  ];

  return (
    <ModalShell variant="drawer" labelledBy="lead-details-title" onRequestClose={requestClose}>
      <div className="drawer-toolbar">
        <button type="button" className="drawer-back" onClick={requestClose}>
          <Icon name="arrowLeft" /> <span>Back to leads</span>
        </button>

        <div className="drawer-toolbar-actions">
          <a className="mini-button" href={`tel:${lead.phone.replace(/\s/g, "")}`}>
            <Icon name="phone" /> <span className="btn-label">Call</span>
          </a>
          <a className="mini-button" href={whatsappLink(lead.phone)} target="_blank" rel="noreferrer">
            <Icon name="chat" /> <span className="btn-label">WhatsApp</span>
          </a>
          {lead.email && (
            <a className="mini-button" href={`mailto:${lead.email}`}>
              <Icon name="mail" /> <span className="btn-label">Email</span>
            </a>
          )}
        </div>
      </div>

      <div className="drawer-profile">
        <div className="drawer-avatar">{lead.full_name.charAt(0).toUpperCase()}</div>

        <div className="drawer-profile-main">
          <h2 id="lead-details-title">{lead.full_name}</h2>
          <p className="drawer-sub">
            {lead.lead_code} · {lead.service_interest || "Service not set"}
          </p>
        </div>

        <StatusBadge status={lead.status} />
      </div>

      <div className="modal-tabs" role="tablist" aria-label="Lead sections">
        {tabs.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            id={`tab-${item.id}`}
            aria-selected={tab === item.id}
            aria-controls={`panel-${item.id}`}
            className={`modal-tab ${tab === item.id ? "active" : ""}`}
            onClick={() => (item.id === "edit" ? openEdit() : setTab(item.id))}
          >
            {item.label}
            {item.count ? <span>{item.count}</span> : null}
          </button>
        ))}
      </div>

      {tab === "overview" && (
        <div className="modal-body" role="tabpanel" id="panel-overview" aria-labelledby="tab-overview">
          <div className="drawer-columns">
            <div className="drawer-col">
              <section className="info-section">
                <h4>Contact information</h4>
                <div className="info-grid">
                  <InfoItem label="Phone">
                    <a href={`tel:${lead.phone.replace(/\s/g, "")}`}>{lead.phone}</a>
                  </InfoItem>
                  <InfoItem label="Email">
                    {lead.email ? <a href={`mailto:${lead.email}`}>{lead.email}</a> : "Not provided"}
                  </InfoItem>
                </div>
              </section>

              <section className="info-section">
                <h4>Enquiry information</h4>
                <div className="info-grid">
                  <InfoItem label="Source">{lead.source}</InfoItem>
                  <InfoItem label="Contact method">{lead.contact_method || "Not provided"}</InfoItem>
                  <InfoItem label="Service">{lead.service_interest || "Not set"}</InfoItem>
                  <InfoItem label="Assigned staff">{lead.assigned_staff || "Unassigned"}</InfoItem>
                  <InfoItem label="Date added">{formatDate(lead.created_at)}</InfoItem>
                  <InfoItem label="Last updated">{formatDate(lead.updated_at)}</InfoItem>
                </div>
              </section>
            </div>

            <div className="drawer-col">
              <section className="info-section">
                <h4>Next follow up</h4>
                <div className={`followup-banner ${followUpState === "overdue" ? "overdue" : ""}`}>
                  <div>
                    <strong>
                      {lead.next_follow_up_at ? formatDateTime(lead.next_follow_up_at) : "Not scheduled yet"}
                    </strong>
                    {followUpState && <small>{dueLabel(lead, now)}</small>}
                  </div>

                  {followUpState && (
                    <div className="followup-actions">
                      <button
                        type="button"
                        className="mini-button primary"
                        disabled={followUpBusy}
                        onClick={() => onCompleteFollowUp(lead)}
                      >
                        <Icon name="check" /> {followUpBusy ? "Saving…" : "Mark done"}
                      </button>
                      <button type="button" className="mini-button" disabled={followUpBusy} onClick={() => onSnoozeFollowUp(lead)}>
                        Tomorrow
                      </button>
                    </div>
                  )}

                  {!lead.next_follow_up_at && (
                    <button type="button" className="mini-button" onClick={openEdit}>
                      Schedule one
                    </button>
                  )}
                </div>
              </section>

              <section className="info-section">
                <h4>Status</h4>
                <Field id="overview-status" label="Lead status">
                  <select
                    id="overview-status"
                    value={lead.status}
                    disabled={statusSaving || !canUpdateStatus}
                    onChange={(event) => void changeStatus(event.target.value)}
                  >
                    {[...new Set([...STATUSES, lead.status])].map((status) => (
                      <option key={status} value={status}>
                        {status}
                      </option>
                    ))}
                  </select>
                </Field>
                {!canUpdateStatus && <p className="subtle-text">Your role cannot change lead statuses.</p>}
                {statusSaving && (
                  <p className="subtle-text" role="status">
                    Saving…
                  </p>
                )}
                {statusError && (
                  <p className="field-error" role="alert">
                    {statusError}
                  </p>
                )}
              </section>

              <section className="info-section">
                <h4>Appointments</h4>

                {lead.status !== "Confirmed" && (
                  <p className="subtle-text">
                    This lead is {lead.status}, so it has no confirmed appointment. Set the status to Confirmed to book one.
                  </p>
                )}

                {appointments.length > 0 && (
                  <ul className="activity-list">
                    {appointments.map((item) => (
                      <li key={item.id} className="activity-item">
                        <div>
                          <p className="activity-text">
                            <strong>{formatDateTime(item.starts_at)}</strong>
                            {item.ends_at ? ` – ${formatTime(item.ends_at)}` : ""}
                          </p>
                          <p className="activity-text">{psychologistNames[item.psychologist_id] || "Psychologist not set"}</p>
                          {item.notes ? <p className="activity-text">{item.notes}</p> : null}
                          {canManageAppointment(item) ? (
                            <>
                              <select
                                aria-label="Appointment status"
                                value={item.status}
                                disabled={apptBusyId === item.id}
                                onChange={(event) => void changeAppointmentStatus(item, event.target.value)}
                              >
                                {APPOINTMENT_STATUSES.map((status) => (
                                  <option key={status} value={status}>
                                    {status}
                                  </option>
                                ))}
                              </select>
                              {item.status === "Scheduled" && (
                                <button type="button" className="mini-button" onClick={() => onRequestReschedule(item)}>
                                  Reschedule
                                </button>
                              )}
                            </>
                          ) : (
                            <span className="chip small">{item.status}</span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                {apptError && (
                  <p className="field-error" role="alert">
                    {apptError}
                  </p>
                )}

                {lead.status === "Confirmed" && canScheduleAppointments && (
                  <button type="button" className="mini-button primary" onClick={() => onRequestBooking(lead)}>
                    <Icon name="calendar" /> Book appointment
                  </button>
                )}
              </section>

              <section className="info-section">
                <h4>Notes</h4>
                {lead.notes ? (
                  <p className="notes-box">{lead.notes}</p>
                ) : (
                  <p className="notes-box empty">No enquiry notes yet. Use the Edit tab to add some.</p>
                )}
              </section>
            </div>
          </div>
        </div>
      )}

      {tab === "activity" && (
        <div className="modal-body" role="tabpanel" id="panel-activity" aria-labelledby="tab-activity">
          <div className="drawer-columns activity-columns">
          <form className="activity-form" noValidate onSubmit={handleLogActivity} aria-busy={activitySaving}>
            <h4 className="field-label">Log an activity</h4>

            <fieldset disabled={activitySaving} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}>
              <div className="field-grid">
                <Field id="activity-activity_type" label="Activity type" required error={activityError("activity_type")}>
                  <select
                    {...activityProps("activity_type")}
                    value={activityDraft.activity_type}
                    onChange={setActivityField("activity_type")}
                  >
                    {ACTIVITY_TYPES.map((type) => (
                      <option key={type} value={type}>
                        {type}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field id="activity-staff_member" label="Staff member">
                  <select
                    {...activityProps("staff_member")}
                    value={activityDraft.staff_member}
                    onChange={setActivityField("staff_member")}
                  >
                    <option value="">Not specified</option>
                    {activityStaffChoices.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field id="activity-occurred_at" label="Date and time" required error={activityError("occurred_at")}>
                  <input
                    {...activityProps("occurred_at")}
                    type="datetime-local"
                    value={activityDraft.occurred_at}
                    onChange={setActivityField("occurred_at")}
                  />
                </Field>

                <Field id="activity-outcome" label="Outcome" error={activityError("outcome")}>
                  <select
                    {...activityProps("outcome")}
                    value={activityDraft.outcome}
                    onChange={setActivityField("outcome")}
                  >
                    <option value="">No outcome</option>
                    {OUTCOMES.map((outcome) => (
                      <option key={outcome} value={outcome}>
                        {outcome}
                      </option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="activity-notes"
                  label="Notes"
                  className="span-2"
                  error={activityError("notes")}
                  hint={
                    <>
                      Optional. Practical details only.
                      <span className="char-count">
                        {activityDraft.notes.length}/{NOTES_LIMIT}
                      </span>
                    </>
                  }
                >
                  <textarea
                    {...fieldProps("activity-notes", activityError("notes"), "notes")}
                    rows={3}
                    maxLength={NOTES_LIMIT}
                    value={activityDraft.notes}
                    onChange={setActivityField("notes")}
                    placeholder="For example: Asked us to ring again on Monday afternoon."
                  />
                </Field>
              </div>
            </fieldset>

            {activitySaveError && (
              <p className="field-error" role="alert" style={{ margin: "10px 0 0" }}>
                {activitySaveError}
              </p>
            )}

            {activityDuplicateWarning && (
              <div className="subtle-text" role="alert" style={{ margin: "10px 0 0" }}>
                This looks like an activity already saved for this lead. Check the history before adding it again.{" "}
                <button type="button" className="text-button" onClick={() => void saveActivity(true)}>
                  Log it anyway
                </button>
              </div>
            )}

            <div className="activity-form-actions">
              <button type="submit" className="primary-button" disabled={activitySaving}>
                <Icon name="plus" /> {activitySaving ? "Saving…" : "Log activity"}
              </button>
            </div>
          </form>

          <div className="drawer-col">
            {loadState === "loading" && (
              <p className="subtle-text" role="status">
                Loading activity…
              </p>
            )}

            {loadState === "error" && (
              <p className="subtle-text" role="alert">
                Could not load logged activity.{" "}
                <button type="button" className="text-button" onClick={() => setLoadKey((key) => key + 1)}>
                  Try again
                </button>
              </p>
            )}

            {loadState === "ready" && loggedActivities.length === 0 && (
              <p className="subtle-text">No calls, messages or notes logged yet. Use the form to add the first one.</p>
            )}

            <ol className="activity-list drawer-activity-scroll">
              {activity.map((item) => {
                const logged = item.source === "database";
                return (
                  <li key={item.id} className={`activity-item ${logged ? "logged" : item.type}`}>
                    <span className="activity-dot">
                      <Icon name={(logged ? LOGGED_ACTIVITY_ICONS[item.type] : ACTIVITY_ICONS[item.type]) || "settings"} />
                    </span>
                    <div>
                      {logged ? (
                        <p className="activity-text">
                          <strong>{item.type}</strong>
                          {item.staff ? ` · ${item.staff}` : ""}
                        </p>
                      ) : null}
                      {item.text ? <p className="activity-text">{item.text}</p> : null}
                      {item.outcome ? <span className="chip small">{item.outcome}</span> : null}
                      <span className="activity-time" title={relativeTime(item.at, now)}>
                        {formatDateTime(item.at)}
                      </span>
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
          </div>
        </div>
      )}

      {tab === "edit" && (
        <form className="lead-form" noValidate onSubmit={handleSave}>
          <div className="modal-body" role="tabpanel" id="panel-edit" aria-labelledby="tab-edit">
            <div className="drawer-columns">
            <section className="form-section">
              <div className="form-section-head">
                <span className="step">1</span>
                <div>
                  <h3>Status and follow up</h3>
                  <p>Keep the pipeline accurate.</p>
                </div>
              </div>

              <div className="field-grid">
                <Field id="edit-status" label="Status">
                  <select
                    {...props("status")}
                    value={draft.status}
                    disabled={!canUpdateStatus}
                    onChange={onChange("status")}
                  >
                    {[...new Set([...STATUSES, lead.status])].map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="edit-next_follow_up_at"
                  label="Next follow-up"
                  error={visibleError("next_follow_up_at")}
                  hint="Optional. Leave empty if no follow up is needed."
                >
                  <input
                    {...fieldProps("edit-next_follow_up_at", visibleError("next_follow_up_at"), "hint")}
                    type="datetime-local"
                    value={draft.next_follow_up_at}
                    onChange={onChange("next_follow_up_at")}
                  />
                </Field>

                {(
                  <div className="field span-2">
                    <div className="quick-chips">
                      {[
                        ["Tomorrow", 1],
                        ["In 3 days", 3],
                        ["Next week", 7],
                      ].map(([label, days]) => (
                        <button
                          type="button"
                          key={label}
                          className="chip small"
                          onClick={() => setField("next_follow_up_at", quickFollowUpValue(days))}
                        >
                          {label}
                        </button>
                      ))}
                      {draft.next_follow_up_at && (
                        <button type="button" className="chip small ghost" onClick={() => setField("next_follow_up_at", "")}>
                          Clear
                        </button>
                      )}
                    </div>
                  </div>
                )}

                <Field id="edit-assigned_staff" label="Assigned staff">
                  <input
                    {...props("assigned_staff")}
                    list="edit-staff-options"
                    autoComplete="off"
                    value={draft.assigned_staff}
                    onChange={onChange("assigned_staff")}
                    placeholder="Choose or type a name"
                  />
                  <datalist id="edit-staff-options">
                    {staffOptions.map((name) => (
                      <option key={name} value={name} />
                    ))}
                  </datalist>
                </Field>

              </div>
            </section>

            <section className="form-section">
              <div className="form-section-head">
                <span className="step">2</span>
                <div>
                  <h3>Client details</h3>
                  <p>Capture the service they are interested in and practical enquiry notes.</p>
                </div>
              </div>

              <div className="field-grid">
                <Field id="edit-service_interest" label="Service of interest">
                  <select {...props("service_interest")} value={draft.service_interest} onChange={onChange("service_interest")}>
                    {SERVICES.map((service) => (
                      <option key={service}>{service}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="edit-notes"
                  label="Enquiry notes"
                  className="span-2"
                  error={visibleError("notes")}
                  hint={
                    <>
                      Practical details only. Avoid sensitive clinical information.
                      <span className="char-count">
                        {draft.notes.length}/{NOTES_LIMIT}
                      </span>
                    </>
                  }
                >
                  <textarea
                    {...fieldProps("edit-notes", visibleError("notes"), "notes")}
                    rows={3}
                    value={draft.notes}
                    onChange={onChange("notes")}
                  />
                </Field>
              </div>
            </section>
            </div>
          </div>

          {editSaveError && (
            <p className="field-error" role="alert" style={{ margin: "0 0 10px" }}>
              {editSaveError}
            </p>
          )}

          <div className="modal-footer-sticky">
            <button type="button" className="danger-button" onClick={handleDelete} disabled={editSaving}>
              <Icon name="trash" /> Delete
            </button>
            <button type="button" className="secondary-button" onClick={() => setTab("overview")} disabled={editSaving}>
              Cancel
            </button>
            <button type="submit" className="primary-button" disabled={editSaving}>
              {editSaving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}