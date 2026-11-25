"use client";

import Icon from "../Icon";
import { EmptyState, ErrorState, TableSkeletonRows, TableStateRow } from "./States";

/* Reusable building blocks for buttons, filters and tables. They render the existing design-system classes
   (.btn, .toolbar, .search, .table), so screens built with them match the rest of the CRM in both themes. */

const VARIANT = { primary: "btn-primary", secondary: "", ghost: "btn-ghost", danger: "btn-danger" };

export function Button({ variant = "secondary", size, icon, children, className = "", type = "button", busy = false, ...rest }) {
  return (
    <button
      type={type}
      className={`btn ${VARIANT[variant] ?? ""} ${size === "sm" ? "btn-sm" : ""} ${className}`.trim()}
      aria-busy={busy || undefined}
      disabled={busy || rest.disabled}
      {...rest}
    >
      {icon ? <Icon name={icon} /> : null}
      {children}
    </button>
  );
}

// Toolbar row above a list: search on the left, filters, then a result count on the right.
export function FilterBar({ children, count = null }) {
  return (
    <div className="toolbar">
      {children}
      <span className="spacer" />
      {count !== null ? <span className="count">{count}</span> : null}
    </div>
  );
}

export function SearchInput({ label, value, onChange, placeholder }) {
  return (
    <label className="search">
      <Icon name="search" />
      <span className="sr-only">{label}</span>
      <input type="search" placeholder={placeholder || label} value={value} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

// options: [{ value, label }]
export function FilterSelect({ label, value, onChange, options }) {
  return (
    <select value={value} onChange={(event) => onChange(event.target.value)} aria-label={label}>
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

// Selectable chips for quick filters (status, period). Exactly one is active.
export function FilterChips({ label, value, onChange, options }) {
  return (
    <div className="filter-chips" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={value === option.value}
          className={`filter-chip ${value === option.value ? "active" : ""}`}
          onClick={() => onChange(option.value)}
        >
          {option.label}
          {option.count !== undefined ? <span className="tab-count">{option.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* A table with built-in loading, error and empty handling.
   columns: [{ key, label, className?, render(row) }]
   rowClassName(row) lets a screen add a highlight, for example "is-overdue". */
export function DataTable({
  caption,
  columns,
  rows,
  rowKey = (row) => row.id,
  loading = false,
  error = null,
  onRetry,
  empty = { title: "Nothing here yet" },
  onRowClick,
  rowLabel,
  rowClassName,
}) {
  const span = columns.length;
  return (
    <div className="table-wrap">
      <table className="table">
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.className}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {loading && <TableSkeletonRows columns={span} />}
          {!loading && error && (
            <TableStateRow columns={span}>
              <ErrorState title="Could not load this list" message={error} onRetry={onRetry} />
            </TableStateRow>
          )}
          {!loading && !error && rows.length === 0 && (
            <TableStateRow columns={span}>
              <EmptyState icon={empty.icon} title={empty.title} action={empty.action}>
                {empty.message}
              </EmptyState>
            </TableStateRow>
          )}
          {!loading &&
            !error &&
            rows.map((row) => (
              <tr
                key={rowKey(row)}
                className={`${onRowClick ? "clickable" : ""} ${rowClassName ? rowClassName(row) || "" : ""}`.trim() || undefined}
                tabIndex={onRowClick ? 0 : undefined}
                aria-label={onRowClick && rowLabel ? rowLabel(row) : undefined}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
              >
                {columns.map((column) => (
                  <td key={column.key} className={column.className}>
                    {column.render ? column.render(row) : row[column.key]}
                  </td>
                ))}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
