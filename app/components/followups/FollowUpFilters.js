"use client";

import { FOLLOW_UP_FILTER_STATUSES, FOLLOW_UP_TYPE_META, FOLLOW_UP_TYPES } from "../../lib/followUpsApi";

export const EMPTY_FOLLOW_UP_FILTERS = { psychologistId: "", status: "", type: "", dateFrom: "", dateTo: "" };

/* Filters for follow-ups: psychologist, status, type and a due-date range. Uses the existing .toolbar styles.
   show: which filters to render, e.g. { psychologist: true, type: false }. statuses: the status choices. */
export default function FollowUpFilters({
  value,
  onChange,
  psychologistNames = {},
  show = {},
  statuses = FOLLOW_UP_FILTER_STATUSES,
  count = null,
  idPrefix = "fu",
  search = null, // optional search box rendered first
}) {
  const set = (key) => (event) => onChange({ ...value, [key]: event.target.value });
  const psychologists = Object.entries(psychologistNames).sort((a, b) => String(a[1]).localeCompare(String(b[1])));
  const active = Object.values(value).some(Boolean);

  return (
    <div className="toolbar">
      {search}
      {show.psychologist !== false && psychologists.length > 0 && (
        <select value={value.psychologistId} onChange={set("psychologistId")} aria-label="Filter by psychologist">
          <option value="">All psychologists</option>
          {psychologists.map(([id, name]) => (
            <option key={id} value={id}>
              {name}
            </option>
          ))}
        </select>
      )}
      {show.status !== false && (
        <select value={value.status} onChange={set("status")} aria-label="Filter by status">
          <option value="">All statuses</option>
          {statuses.map((status) => (
            <option key={status} value={status}>
              {status}
            </option>
          ))}
        </select>
      )}
      {show.type !== false && (
        <select value={value.type} onChange={set("type")} aria-label="Filter by type">
          <option value="">Type A and Type B</option>
          {FOLLOW_UP_TYPES.map((type) => (
            <option key={type} value={type}>
              {type} · {FOLLOW_UP_TYPE_META[type].label}
            </option>
          ))}
        </select>
      )}
      {show.date !== false && (
        <>
          <label htmlFor={`${idPrefix}-from`} className="muted">
            Due from
          </label>
          <input id={`${idPrefix}-from`} type="date" value={value.dateFrom} max={value.dateTo || undefined} onChange={set("dateFrom")} style={{ width: "auto" }} />
          <label htmlFor={`${idPrefix}-to`} className="muted">
            to
          </label>
          <input id={`${idPrefix}-to`} type="date" value={value.dateTo} min={value.dateFrom || undefined} onChange={set("dateTo")} style={{ width: "auto" }} />
        </>
      )}
      {active && (
        <button type="button" className="btn btn-sm" onClick={() => onChange({ ...EMPTY_FOLLOW_UP_FILTERS })}>
          Clear filters
        </button>
      )}
      <span className="spacer" />
      {count !== null && <span className="count">{count}</span>}
    </div>
  );
}
