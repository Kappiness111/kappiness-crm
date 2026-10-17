"use client";

import { useState } from "react";
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

function validateDraft(draft) {
  const errors = {};
  if (draft.status === "Lost" && !draft.not_converted_reason.trim()) {
    errors.not_converted_reason = "Add a short reason so the team knows why this lead was lost.";
  }
  if (draft.status === "Follow Up" && !draft.next_follow_up_at) {
    errors.next_follow_up_at = "Choose a follow-up date and time for leads in Follow Up.";
  } else if (draft.next_follow_up_at && !parseDate(draft.next_follow_up_at)) {
    errors.next_follow_up_at = "Enter a valid date and time.";
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
  onAddNote,
  onDelete,
  onCompleteFollowUp,
  onSnoozeFollowUp,
}) {
  const [tab, setTab] = useState("overview");
  const [draft, setDraft] = useState(() => makeDraft(lead));
  const [submitted, setSubmitted] = useState(false);
  const [noteText, setNoteText] = useState("");

  const activity = getActivity(lead);
  const closed = CLOSED_STATUSES.includes(lead.status);
  const followUpState = getFollowUpState(lead, now);
  const draftClosed = CLOSED_STATUSES.includes(draft.status);
  const errors = validateDraft(draft);
  const visibleError = (field) => (submitted ? errors[field] : undefined);
  const editDirty = tab === "edit" && JSON.stringify(draft) !== JSON.stringify(makeDraft(lead));
  const stageIndex = STAGES.indexOf(lead.status);

  const setField = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const onChange = (field) => (event) => setField(field, event.target.value);
  const props = (field) => fieldProps(`edit-${field}`, visibleError(field));

  function requestClose() {
    if ((editDirty || noteText.trim()) && !window.confirm("Close without saving your changes?")) return;
    onClose();
  }

  function openEdit() {
    setDraft(makeDraft(lead));
    setSubmitted(false);
    setTab("edit");
  }

  function handleSave(event) {
    event.preventDefault();
    setSubmitted(true);

    const first = ["next_follow_up_at", "notes", "not_converted_reason"].find((field) => errors[field]);
    if (first) {
      document.getElementById(`edit-${first}`)?.focus();
      return;
    }

    const entries = describeChanges(lead, draft);
    if (entries.length === 0) {
      setTab("overview");
      return;
    }

    onSave(
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
    setTab("overview");
  }

  function handleAddNote(event) {
    event.preventDefault();
    const text = noteText.trim();
    if (!text) return;
    onAddNote(lead.id, text);
    setNoteText("");
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
                      <button type="button" className="mini-button primary" onClick={() => onCompleteFollowUp(lead)}>
                        <Icon name="check" /> Mark done
                      </button>
                      <button type="button" className="mini-button" onClick={() => onSnoozeFollowUp(lead)}>
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
                  <p className="stage-lost">
                    Marked as lost{lead.not_converted_reason ? `: ${lead.not_converted_reason}` : "."}
                  </p>
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
          <form className="activity-form" onSubmit={handleAddNote}>
            <label htmlFor="activity-note" className="field-label">
              Log a call, message or note
            </label>
            <textarea
              id="activity-note"
              rows={3}
              maxLength={NOTES_LIMIT}
              value={noteText}
              onChange={(event) => setNoteText(event.target.value)}
              placeholder="For example: Called at 4 PM, asked us to ring again on Monday."
            />
            <div className="activity-form-actions">
              <span className="field-hint">
                {noteText.length}/{NOTES_LIMIT}
              </span>
              <button type="submit" className="primary-button" disabled={!noteText.trim()}>
                <Icon name="plus" /> Add note
              </button>
            </div>
          </form>

          <ol className="activity-list drawer-activity-scroll">
            {activity.map((item) => (
              <li key={item.id} className={`activity-item ${item.type}`}>
                <span className="activity-dot">
                  <Icon name={ACTIVITY_ICONS[item.type] || "settings"} />
                </span>
                <div>
                  <p className="activity-text">{item.text}</p>
                  <span className="activity-time" title={formatDateTime(item.at)}>
                    {relativeTime(item.at, now)}
                  </span>
                </div>
              </li>
            ))}
          </ol>
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
                  <select {...props("status")} value={draft.status} onChange={onChange("status")}>
                    {STATUSES.map((status) => (
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

          <div className="modal-footer-sticky">
            <button type="button" className="danger-button" onClick={handleDelete}>
              <Icon name="trash" /> Delete
            </button>
            <button type="button" className="secondary-button" onClick={() => setTab("overview")}>
              Cancel
            </button>
            <button type="submit" className="primary-button">
              Save changes
            </button>
          </div>
        </form>
      )}
    </ModalShell>
  );
}