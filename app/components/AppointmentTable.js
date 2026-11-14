"use client";

import { formatDate, formatTime } from "../lib/leads";
import { ACTION_LABELS } from "../lib/appointmentsApi";

export function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function Avatar({ name }) {
  return (
    <span className="appt-avatar" aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

// `label` lets a screen show friendlier wording (for example "Awaiting confirmation") for the same status.
export function StatusPill({ status, label }) {
  return <span className={`appt-pill pill-${String(status).toLowerCase()}`}>{label || status}</span>;
}

// A select that offers only the next steps allowed for this appointment (never a free status choice).
export function AppointmentActionSelect({ item, actions, onAction, label, disabled }) {
  if (!actions.length) return null;
  return (
    <select
      className="appt-action-select"
      aria-label={label || `Update appointment on ${formatDate(item.starts_at)}`}
      value=""
      disabled={disabled}
      onChange={(event) => {
        const action = event.target.value;
        event.target.value = "";
        if (action) onAction(item, action);
      }}
    >
      <option value="">Update…</option>
      {actions.map((action) => (
        <option key={action} value={action}>
          {ACTION_LABELS[action]}
        </option>
      ))}
    </select>
  );
}

/* Appointments as a table: When | Client | Psychologist | Service | Status | Actions. */
export default function AppointmentTable({
  items,
  psychologistNames,
  actionsFor, // (item) => allowed action ids
  onAction, // (item, actionId)
  onOpen, // (item) => open the client / lead
  busyId = null,
  empty = "Nothing here yet.",
}) {
  if (items.length === 0) return <p className="appt-empty">{empty}</p>;

  return (
    <div className="appt-table" role="table">
      <div className="appt-row appt-head" role="row">
        <span role="columnheader">When</span>
        <span role="columnheader">Client</span>
        <span role="columnheader">Psychologist</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="right">
          Actions
        </span>
      </div>

      {items.map((item) => {
        const name = item.client_name || "Client";
        const actions = actionsFor(item);
        const minutes = Math.round((new Date(item.ends_at) - new Date(item.starts_at)) / 60000);
        return (
          <div className="appt-row" role="row" key={item.id}>
            <span role="cell" className="appt-when">
              <strong>
                {formatTime(item.starts_at)}–{formatTime(item.ends_at)}
              </strong>
              <small>
                {formatDate(item.starts_at)} · {minutes} min
              </small>
            </span>

            <span role="cell" className="appt-client">
              <Avatar name={name} />
              <span>
                <strong>{name}</strong>
                <small>{item.service_type || ""}</small>
              </span>
            </span>

            <span role="cell" className="appt-doctor">
              {psychologistNames[item.psychologist_id] || "Not set"}
            </span>

            <span role="cell">
              <StatusPill status={item.status} />
            </span>

            <span role="cell" className="appt-actions">
              <AppointmentActionSelect item={item} actions={actions} onAction={onAction} label={`Update appointment for ${name}`} disabled={busyId === item.id} />
              {onOpen && (
                <button type="button" className="appt-btn" onClick={() => onOpen(item)}>
                  Open
                </button>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
