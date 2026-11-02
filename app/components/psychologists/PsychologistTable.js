"use client";

import Icon from "../Icon";
import { summarizeAvailability } from "../../lib/psychologists";
import styles from "./psychologists.module.css";

const SKELETON_ROWS = [0, 1, 2, 3];

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
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Psychologist</th>
            <th>Phone number</th>
            <th>Account status</th>
            <th>Availability</th>
            <th>Actions</th>
          </tr>
        </thead>

        <tbody>
          {loading &&
            SKELETON_ROWS.map((item) => (
              <tr key={item} className={styles.skeletonRow} aria-hidden="true">
                {[0, 1, 2, 3, 4].map((cell) => (
                  <td key={cell}>
                    <div className={styles.skeleton} style={{ width: cell === 0 ? "70%" : "55%" }} />
                  </td>
                ))}
              </tr>
            ))}

          {!loading && error && (
            <tr>
              <td colSpan={5} className={styles.stateCell}>
                <div className={`${styles.stateBox} ${styles.stateError}`} role="alert">
                  <span className={styles.stateIcon}><Icon name="info" /></span>
                  <strong>Could not load psychologists</strong>
                  <p>{error}</p>
                  <button className="secondary-button" onClick={onRetry}>Try again</button>
                </div>
              </td>
            </tr>
          )}

          {!loading && !error && rows.length === 0 && (
            <tr>
              <td colSpan={5} className={styles.stateCell}>
                <div className={styles.stateBox}>
                  <span className={styles.stateIcon}><Icon name={hasAnyRecords ? "search" : "heart"} /></span>
                  <strong>{hasAnyRecords ? "No psychologists match your search" : "No psychologists yet"}</strong>
                  <p>
                    {hasAnyRecords
                      ? "Try a different name or phone number, or change the status filter."
                      : "Psychologist profiles you can see will appear here."}
                  </p>
                  {hasAnyRecords ? (
                    <button className="secondary-button" onClick={onClearFilters}>Clear filters</button>
                  ) : canManage ? (
                    <button className="primary-button" onClick={onAdd}><Icon name="plus" /> Add psychologist</button>
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
                  <td data-label="Psychologist">
                    <div className={styles.nameCell}>
                      <span className={styles.avatar} aria-hidden="true">
                        {(psychologist.name || "?").charAt(0).toUpperCase()}
                      </span>
                      <span className={styles.nameText}>
                        <button className={styles.nameLink} onClick={() => onView(psychologist)}>
                          {psychologist.name || "Unnamed psychologist"}
                        </button>
                      </span>
                    </div>
                  </td>

                  <td data-label="Phone number">{psychologist.phone || <span className={styles.muted}>—</span>}</td>

                  <td data-label="Account status">
                    <span className={`${styles.badge} ${psychologist.active ? styles.badgeActive : styles.badgeInactive}`}>
                      {psychologist.active ? "Active" : "Inactive"}
                    </span>
                  </td>

                  <td data-label="Availability">
                    {availabilityUnavailable ? (
                      <span className={styles.muted}>—</span>
                    ) : (
                      <span>
                        <span className={styles.availLabel}>{summary.label}</span>
                        {summary.detail ? <span className={styles.availDetail}>{summary.detail}</span> : null}
                      </span>
                    )}
                  </td>

                  <td data-label="Actions">
                    <div className={styles.actions}>
                      <button className={styles.linkBtn} onClick={() => onView(psychologist)}>View Profile</button>
                      {canManage && (
                        <>
                          <button className={styles.linkBtn} onClick={() => onEdit(psychologist)}>Edit Profile</button>
                          <button className={styles.linkBtn} onClick={() => onAvailability(psychologist)}>Manage Availability</button>
                          <button
                            className={`${styles.linkBtn} ${psychologist.active ? styles.linkBtnDanger : ""}`}
                            disabled={busy}
                            onClick={() => onToggleActive(psychologist)}
                          >
                            {busy ? "Saving..." : psychologist.active ? "Deactivate" : "Activate"}
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