"use client";

import { useEffect, useRef, useState } from "react";
import Field, { fieldProps } from "./Field";
import Icon from "./Icon";
import ModalShell from "./ModalShell";
import StatusBadge from "./StatusBadge";
import {
  CLOSED_STATUSES,
  NOTES_LIMIT,
  SERVICES,
  STATUSES,
  dueLabel,
  formatDate,
  formatDateTime,
  getActivity,
  getFollowUpState,
  parseDate,
  quickFollowUpValue,
  relativeTime,
  toInputValue,
  whatsappLink,
} from "../lib/leads";

const STAGES = ["New", "Contacted", "Follow Up", "Converted"];

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

function makeActivityDraft(lead) {
  return {
    activity_type: "Phone call",
    staff_member: (lead.assigned_staff || "").trim(),
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
    next_follow_up_at: toInputValue(lead.next_follow_up_at),
    assigned_staff: lead.assigned_staff || "",
    service_interest: lead.service_interest || SERVICES[0],
    notes: lead.notes || "",
    not_converted_reason: lead.not_converted_reason || "",
  };
}

function validateDraft(draft, lead) {
  const errors = {};
  if (draft.status === "Lost" && !draft.not_converted_reason.trim()) {
    errors.not_converted_reason = "Add a short reason so the team knows why this lead was lost.";
  }
  if (draft.status === "Follow Up" && !draft.next_follow_up_at) {
    errors.next_follow_up_at = "Choose a follow-up date and time for leads in Follow Up.";
  } else if (draft.next_follow_up_at && !parseDate(draft.next_follow_up_at)) {
    errors.next_follow_up_at = "Enter a valid date and time.";
  } else if (
    draft.next_follow_up_at &&
    !CLOSED_STATUSES.includes(draft.status) &&
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
  const closed = CLOSED_STATUSES.includes(draft.status);
  const followUp = closed ? "" : draft.next_follow_up_at;
  const staff = draft.assigned_staff.trim();

  if (draft.status !== base.status) {
    const reason = draft.status === "Lost" ? `. Reason: ${draft.not_converted_reason.trim()}` : "";
    entries.push({ type: "status", text: `Status changed from ${base.status} to ${draft.status}${reason}` });
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

  const detailFields = ["service_interest", "notes"];
  if (detailFields.some((field) => base[field].trim() !== draft[field].trim())) {
    entries.push({ type: "update", text: "Lead details updated" });
  }

  // A reason edit on an already-lost lead is still worth recording.
  if (entries.length === 0 && draft.status === "Lost" && base.not_converted_reason.trim() !== draft.not_converted_reason.trim()) {
    entries.push({ type: "update", text: `Reason updated: ${draft.not_converted_reason.trim()}` });
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
}) {
  const [tab, setTab] = useState(initialTab);
  const [draft, setDraft] = useState(() => makeDraft(lead));
  const [submitted, setSubmitted] = useState(false);
  const [activityDraft, setActivityDraft] = useState(() => makeActivityDraft(lead));
  const [activitySubmitted, setActivitySubmitted] = useState(false);
  const [activitySaving, setActivitySaving] = useState(false);
  const [activitySaveError, setActivitySaveError] = useState("");
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
  // "Convert" / "Mark as lost" confirmation panel on the Overview tab.
  const [outcomeAction, setOutcomeAction] = useState(null); // null | "convert" | "lost"
  const [outcomeReason, setOutcomeReason] = useState("");
  const [outcomeSubmitted, setOutcomeSubmitted] = useState(false);
  const [outcomeSaving, setOutcomeSaving] = useState(false);
  const [outcomeError, setOutcomeError] = useState("");
  const outcomeSavingRef = useRef(false);

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
  const setActivityField = (field) => (event) =>
    setActivityDraft((current) => ({ ...current, [field]: event.target.value }));
  const activityStaffChoices = [
    ...new Set([...staffOptions, (lead.assigned_staff || "").trim()].filter(Boolean)),
  ].sort();
  const closed = CLOSED_STATUSES.includes(lead.status);
  const followUpState = getFollowUpState(lead, now);
  const draftClosed = CLOSED_STATUSES.includes(draft.status);
  const errors = validateDraft(draft, lead);
  const visibleError = (field) => (submitted ? errors[field] : undefined);
  const editDirty = tab === "edit" && JSON.stringify(draft) !== JSON.stringify(makeDraft(lead));
  const stageIndex = STAGES.indexOf(lead.status);

  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const onChange = (field) => (event) => setField(field, event.target.value);
  const props = (field) => fieldProps(`edit-${field}`, visibleError(field));

  function requestClose() {
    const activityDirty = Boolean(activityDraft.notes.trim() || activityDraft.outcome);
    const outcomeDirty = outcomeAction === "lost" && Boolean(outcomeReason.trim());
    if ((editDirty || activityDirty || outcomeDirty) && !window.confirm("Close without saving your changes?")) return;
    onClose();
  }

  function openOutcome(action) {
    if (outcomeSavingRef.current) return;
    setOutcomeAction(action);
    setOutcomeReason("");
    setOutcomeSubmitted(false);
    setOutcomeError("");
  }

  function cancelOutcome() {
    if (outcomeSavingRef.current) return; // cannot cancel while a save is in flight
    setOutcomeAction(null);
    setOutcomeReason("");
    setOutcomeSubmitted(false);
    setOutcomeError("");
  }

  // Converts the lead or marks it Lost. Uses the same save path as the Edit tab, so the status, the reason,
  // the cleared follow up and the history entries are saved together and nothing changes if saving fails.
  async function confirmOutcome(event) {
    event.preventDefault();
    if (outcomeSavingRef.current || !outcomeAction) return; // block duplicate submissions
    if (CLOSED_STATUSES.includes(lead.status)) {
      setOutcomeError("This lead is already closed. Its status cannot be changed again.");
      return;
    }
    const status = outcomeAction === "convert" ? "Converted" : "Lost";

    if (lead.status === status) {
      // Already done (for example a second click): nothing to save, and no second history entry.
      setOutcomeAction(null);
      return;
    }

    const reason = outcomeReason.trim();
    setOutcomeSubmitted(true);
    if (status === "Lost" && (!reason || reason.length > NOTES_LIMIT)) {
      document.getElementById("outcome-reason")?.focus();
      return;
    }

    const target = { ...makeDraft(lead), status, not_converted_reason: status === "Lost" ? reason : "" };
    const entries = describeChanges(lead, target);

    outcomeSavingRef.current = true;
    setOutcomeSaving(true);
    setOutcomeError("");

    let result = null;
    try {
      result = await onSave(
        lead.id,
        {
          status,
          assigned_staff: (lead.assigned_staff || "").trim(),
          next_follow_up_at: "", // converted and lost leads do not need a follow up
          not_converted_reason: target.not_converted_reason,
          service_interest: lead.service_interest || SERVICES[0],
          notes: (lead.notes || "").trim(),
        },
        entries
      );
    } catch {
      result = null;
    }

    outcomeSavingRef.current = false;
    setOutcomeSaving(false);

    if (!result || !result.ok) {
      // The lead keeps its saved status; the panel stays open so nothing typed is lost.
      setOutcomeError((result && result.message) || "Could not save this change. Please try again.");
      return;
    }
    setOutcomeAction(null);
    setOutcomeReason("");
    setOutcomeSubmitted(false);
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

    const first = ["next_follow_up_at", "notes", "not_converted_reason"].find((field) => errors[field]);
    if (first) {
      document.getElementById(`edit-${first}`)?.focus();
      return;
    }

    if (draft.status !== lead.status && (CLOSED_STATUSES.includes(draft.status) || CLOSED_STATUSES.includes(lead.status))) {
      setEditSaveError("Use the Convert or Mark as lost confirmation on the Overview tab to change a lead to a closed status.");
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
        assigned_staff: draft.assigned_staff.trim(),
        next_follow_up_at: draftClosed ? "" : draft.next_follow_up_at,
        not_converted_reason: draft.status === "Lost" ? draft.not_converted_reason.trim() : "",
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

  async function handleLogActivity(event) {
    event.preventDefault();
    if (savingRef.current) return; // block duplicate submissions
    setActivitySubmitted(true);
    setActivitySaveError("");

    const first = ["activity_type", "occurred_at", "notes", "outcome"].find((field) => activityErrors[field]);
    if (first) {
      document.getElementById(`activity-${first}`)?.focus();
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
    setActivityDraft(makeActivityDraft(lead));
    setActivitySubmitted(false);
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
                      {closed
                        ? "No follow up needed"
                        : lead.next_follow_up_at
                          ? formatDateTime(lead.next_follow_up_at)
                          : "Not scheduled yet"}
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

                  {!closed && !lead.next_follow_up_at && (
                    <button type="button" className="mini-button" onClick={openEdit}>
                      Schedule one
                    </button>
                  )}
                </div>
              </section>

              <section className="info-section">
                <h4>Progress</h4>
                {lead.status === "Lost" ? (
                  <div className="stage-lost" role="status">
                    <strong>Marked as lost</strong>
                    <span className="lost-reason">
                      {lead.not_converted_reason ? lead.not_converted_reason : "No reason was recorded."}
                    </span>
                  </div>
                ) : (
                  <ol className="stage-track" aria-label="Lead progress">
                    {STAGES.map((stage, index) => (
                      <li
                        key={stage}
                        className={`stage ${index < stageIndex ? "done" : ""} ${index === stageIndex ? "current" : ""}`}
                        aria-current={index === stageIndex ? "step" : undefined}
                      >
                        <span className="stage-dot">{index < stageIndex ? <Icon name="check" /> : index + 1}</span>
                        <span>{stage}</span>
                      </li>
                    ))}
                  </ol>
                )}

                {outcomeAction ? (
                  <form className="outcome-confirm" noValidate onSubmit={confirmOutcome} aria-labelledby="outcome-title">
                    <strong id="outcome-title">
                      {outcomeAction === "convert" ? `Convert ${lead.full_name}?` : `Mark ${lead.full_name} as lost?`}
                    </strong>
                    <p>
                      {outcomeAction === "convert"
                        ? "The status becomes Converted and any scheduled follow up is cleared. Activity history is kept."
                        : "The status becomes Lost and any scheduled follow up is cleared. Activity history is kept."}
                    </p>

                    {outcomeAction === "lost" && (
                      <Field
                        id="outcome-reason"
                        label="Reason not converted"
                        required
                        error={
                          outcomeSubmitted && !outcomeReason.trim()
                            ? "Add a short reason so the team knows why this lead was lost."
                            : outcomeSubmitted && outcomeReason.trim().length > NOTES_LIMIT
                              ? `Keep the reason under ${NOTES_LIMIT} characters.`
                              : undefined
                        }
                      >
                        <textarea
                          {...fieldProps(
                            "outcome-reason",
                            outcomeSubmitted && (!outcomeReason.trim() || outcomeReason.trim().length > NOTES_LIMIT)
                              ? "invalid"
                              : undefined
                          )}
                          rows={3}
                          autoFocus
                          disabled={outcomeSaving}
                          value={outcomeReason}
                          onChange={(event) => setOutcomeReason(event.target.value)}
                          placeholder="For example: chose another provider"
                        />
                      </Field>
                    )}

                    {outcomeError && (
                      <p className="field-error" role="alert">
                        {outcomeError}
                      </p>
                    )}

                    <div className="outcome-buttons">
                      <button type="button" className="secondary-button" onClick={cancelOutcome} disabled={outcomeSaving}>
                        Cancel
                      </button>
                      <button type="submit" className="primary-button" disabled={outcomeSaving}>
                        {outcomeSaving ? "Saving…" : outcomeAction === "convert" ? "Convert lead" : "Mark as lost"}
                      </button>
                    </div>
                  </form>
                ) : (
                  !closed && (
                    <div className="outcome-actions">
                      <button type="button" className="mini-button primary" onClick={() => openOutcome("convert")}>
                        <Icon name="check" /> Convert lead
                      </button>
                      <button type="button" className="mini-button danger" onClick={() => openOutcome("lost")}>
                        Mark as lost
                      </button>
                    </div>
                  )
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
                    disabled={CLOSED_STATUSES.includes(lead.status)}
                    onChange={onChange("status")}
                  >
                    {STATUSES.filter((status) => !CLOSED_STATUSES.includes(status) || status === lead.status).map((status) => (
                      <option key={status}>{status}</option>
                    ))}
                  </select>
                </Field>

                <Field
                  id="edit-next_follow_up_at"
                  label="Next follow-up"
                  error={visibleError("next_follow_up_at")}
                  hint={draftClosed ? "Converted and lost leads do not need a follow up." : undefined}
                >
                  <input
                    {...fieldProps(
                      "edit-next_follow_up_at",
                      visibleError("next_follow_up_at"),
                      draftClosed ? "hint" : undefined
                    )}
                    type="datetime-local"
                    disabled={draftClosed}
                    value={draftClosed ? "" : draft.next_follow_up_at}
                    onChange={onChange("next_follow_up_at")}
                  />
                </Field>

                {!draftClosed && (
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

                {draft.status === "Lost" && (
                  <Field
                    id="edit-not_converted_reason"
                    label="Reason not converted"
                    required
                    className="span-2"
                    error={visibleError("not_converted_reason")}
                  >
                    <input
                      {...props("not_converted_reason")}
                      value={draft.not_converted_reason}
                      onChange={onChange("not_converted_reason")}
                      placeholder="For example: chose another provider"
                    />
                  </Field>
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
