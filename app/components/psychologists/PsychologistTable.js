"use client";

import Icon from "../Icon";
import { summarizeAvailability } from "../../lib/psychologists";

const SKELETON_ROWS = [0, 1, 2, 3];
const COLUMNS = 5;

function initials(name) {
  const parts = String(name || "?").trim().split(/\s+/).filter(Boolean);
  return ((parts[0] || "?")[0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

/* The psychologist listing. All actions are callbacks owned by the page. */
export default function PsychologistTable({
  rows,
  loading,
  error,
  availabilityByPsychologist,
  availabilityUnavailable,
  hasAnyRecords,
  canManage,
  busyIds,
  onRetry,
  onClearFilters,
  onAdd,
  onView,
  onEdit,
  onAvailability,
  onToggleActive,
}) {
  return (
    <div className="table-wrap">
      <table className="table sticky-first">
        <thead>
          <tr>
            <th scope="col">Psychologist</th>
            <th scope="col">Phone</th>
            <th scope="col">Status</th>
            <th scope="col">Weekly availability</th>
            <th scope="col" className="right">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>

        <tbody>
          {loading &&
            SKELETON_ROWS.map((item) => (
              <tr key={item} aria-hidden="true">
                {Array.from({ length: COLUMNS }, (_, cell) => (
                  <td key={cell}>
                    <div className="skeleton" style={{ width: cell === 0 ? 160 : 80 }} />
                  </td>
                ))}
              </tr>
            ))}

          {!loading && error && (
            <tr className="table-state">
              <td colSpan={COLUMNS}>
                <div className="state error" role="alert">
                  <Icon name="alert" />
                  <strong>Could not load psychologists</strong>
                  <span>{error}</span>
                  <button type="button" className="btn btn-sm" onClick={onRetry}>
                    Try again
                  </button>
                </div>
              </td>
            </tr>
          )}

          {!loading && !error && rows.length === 0 && (
            <tr className="table-state">
              <td colSpan={COLUMNS}>
                <div className="state">
                  <Icon name={hasAnyRecords ? "search" : "userCheck"} />
                  <strong>{hasAnyRecords ? "No psychologists match your search" : "No psychologists yet"}</strong>
                  <span>
                    {hasAnyRecords
                      ? "Try a different name or phone number, or change the status filter."
                      : "Psychologist profiles you can see will appear here."}
                  </span>
                  {hasAnyRecords ? (
                    <button type="button" className="btn btn-sm" onClick={onClearFilters}>
                      Clear filters
                    </button>
                  ) : canManage ? (
                    <button type="button" className="btn btn-primary btn-sm" onClick={onAdd}>
                      <Icon name="plus" /> Add psychologist
                    </button>
                  ) : null}
                </div>
              </td>
            </tr>
          )}

          {!loading &&
            !error &&
            rows.map((psychologist) => {
              const busy = busyIds.includes(psychologist.id);
              const summary = summarizeAvailability(availabilityByPsychologist[psychologist.id]);

              return (
                <tr key={psychologist.id}>
                  <td>
                    <button type="button" className="link-btn quiet" onClick={() => onView(psychologist)}>
                      <span className="cell-person">
                        <span className="avatar neutral" aria-hidden="true">
                          {initials(psychologist.name)}
                        </span>
                        <strong>{psychologist.name || "Unnamed psychologist"}</strong>
                      </span>
                    </button>
                  </td>

                  <td className="num">{psychologist.phone || <span className="muted-cell">—</span>}</td>

                  <td>
                    <span className={`badge ${psychologist.active ? "tone-success" : ""}`}>
                      <span className="badge-dot" aria-hidden="true" />
                      {psychologist.active ? "Active" : "Inactive"}
                    </span>
                  </td>

                  <td>
                    {availabilityUnavailable ? (
                      <span className="muted-cell">—</span>
                    ) : (
                      <span>
                        {summary.label}
                        {summary.detail ? <span className="cell-sub"> · {summary.detail}</span> : null}
                      </span>
                    )}
                  </td>

                  <td>
                    <div className="actions">
                      <button type="button" className="mini-button" onClick={() => onView(psychologist)}>
                        View
                      </button>
                      {canManage && (
                        <>
                          <button type="button" className="mini-button" onClick={() => onEdit(psychologist)}>
                            Edit
                          </button>
                          <button type="button" className="mini-button" onClick={() => onAvailability(psychologist)}>
                            Availability
                          </button>
                          <button
                            type="button"
                            className={`link-btn ${psychologist.active ? "danger" : ""}`}
                            disabled={busy}
                            onClick={() => onToggleActive(psychologist)}
                            style={{ marginLeft: 6 }}
                          >
                            {busy ? "Saving…" : psychologist.active ? "Deactivate" : "Activate"}
                          </button>
                        </>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
    </div>
  );
}
