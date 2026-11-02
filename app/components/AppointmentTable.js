"use client";

import { formatDate, formatTime } from "../lib/leads";
import { APPOINTMENT_STATUSES } from "../lib/appointmentsApi";

const TONES = ["#c9892b", "#8a5a2b", "#a3743f", "#6f4a2a", "#b5651d", "#7d5a3c"];

export function initialsOf(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export function toneOf(name) {
  let sum = 0;
  for (const char of String(name || "")) sum += char.charCodeAt(0);
  return TONES[sum % TONES.length];
}

export function Avatar({ name }) {
  return (
    <span className="appt-avatar" style={{ background: toneOf(name) }} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

export function StatusPill({ status }) {
  return <span className={`appt-pill pill-${String(status).toLowerCase()}`}>{status}</span>;
}

/* Appointments as a real table: When | Client | Psychologist | Status | Actions. */
export default function AppointmentTable({
  items,
  leadsById,
  psychologistNames,
  canManage,
  onReschedule,
  onOpen,
  onStatusChange,
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
        const lead = leadsById.get(item.lead_id);
        const name = lead ? lead.full_name : "Unknown lead";
        const manage = canManage(item);
        return (
          <div className="appt-row" role="row" key={item.id}>
            <span role="cell" className="appt-when">
              <strong>{formatTime(item.starts_at)}</strong>
              <small>{formatDate(item.starts_at)}</small>
            </span>

            <span role="cell" className="appt-client">
              <Avatar name={name} />
              <span>
                <strong>{name}</strong>
                <small>{lead ? lead.lead_code : ""}</small>
              </span>
            </span>

            <span role="cell" className="appt-doctor">
              {psychologistNames[item.psychologist_id] || "Not set"}
            </span>

            <span role="cell">
              {manage ? (
                <select
                  className={`appt-pill pill-select pill-${item.status.toLowerCase()}`}
                  aria-label={`Status for ${name}`}
                  value={item.status}
                  onChange={(event) => onStatusChange(item, event.target.value)}
                >
                  {APPOINTMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </select>
              ) : (
                <StatusPill status={item.status} />
              )}
            </span>

            <span role="cell" className="appt-actions">
              {manage && item.status === "Scheduled" && (
                <button type="button" className="appt-btn dark" onClick={() => onReschedule(item)}>
                  Reschedule
                </button>
              )}
              {lead && (
                <button type="button" className="appt-btn" onClick={() => onOpen(lead)}>
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