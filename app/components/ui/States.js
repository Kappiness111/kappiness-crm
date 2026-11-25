"use client";

import Icon from "../Icon";

/* Empty, loading and error states used by every list, table and panel.
   They share the .state styles, so a blank table, a failed load and a loading list look the same everywhere.
   Every state says what happened in words and, where it helps, offers the next step as a button. */

export function EmptyState({ icon = "inbox", title, children, action = null, compact = false }) {
  return (
    <div className={`state ${compact ? "compact" : ""}`} role="status">
      <Icon name={icon} />
      <strong>{title}</strong>
      {children ? <span>{children}</span> : null}
      {action}
    </div>
  );
}

export function ErrorState({ title = "Something went wrong", message, onRetry, retryLabel = "Try again", compact = false }) {
  return (
    <div className={`state error ${compact ? "compact" : ""}`} role="alert">
      <Icon name="alert" />
      <strong>{title}</strong>
      {message ? <span>{message}</span> : null}
      {onRetry ? (
        <button type="button" className="btn btn-sm" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

// A short line of skeleton bars while data loads, announced once to screen readers.
export function LoadingState({ label = "Loading…", rows = 3, compact = false }) {
  return (
    <div className={`state-loading ${compact ? "compact" : ""}`} role="status" aria-live="polite">
      <span className="sr-only">{label}</span>
      {Array.from({ length: rows }, (_, index) => (
        <div key={index} className="skeleton" style={{ width: `${88 - index * 14}%` }} aria-hidden="true" />
      ))}
    </div>
  );
}

// Skeleton rows for a table body while it loads.
export function TableSkeletonRows({ rows = 5, columns }) {
  return Array.from({ length: rows }, (_, row) => (
    <tr key={`skeleton-${row}`} aria-hidden="true">
      {Array.from({ length: columns }, (_, cell) => (
        <td key={cell}>
          <div className="skeleton" style={{ width: cell === 0 ? 150 : 70 }} />
        </td>
      ))}
    </tr>
  ));
}

// A full-width table row holding one of the states above.
export function TableStateRow({ columns, children }) {
  return (
    <tr className="table-state">
      <td colSpan={columns}>{children}</td>
    </tr>
  );
}
