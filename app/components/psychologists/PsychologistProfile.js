"use client";

import Icon from "../Icon";
import { formatMemberSince } from "../../lib/psychologists";
import styles from "./psychologists.module.css";

/* Profile header and details. No authentication identifiers are shown, only whether a login is linked. */
export default function PsychologistProfile({ psychologist, canManage, statusBusy, onBack, onEdit, onManageAvailability, onToggleActive }) {
  const since = formatMemberSince(psychologist.createdAt);
  const name = psychologist.name || "Unnamed psychologist";

  return (
    <>
      <header className="page-head">
        <div className={styles.identity}>
          <span className="avatar lg" aria-hidden="true">
            {name.charAt(0).toUpperCase()}
          </span>
          <div>
            <h1>{name}</h1>
            <p className={styles.identityMeta}>
              <span className={`badge ${psychologist.active ? "tone-success" : ""}`}>
                <span className="badge-dot" aria-hidden="true" />
                {psychologist.active ? "Active" : "Inactive"}
              </span>
              <span>{psychologist.hasLogin ? "Login linked" : "No login linked"}</span>
              {since ? <span>Since {since}</span> : null}
            </p>
          </div>
        </div>

        <div className="page-actions">
          <button type="button" className="btn btn-ghost" onClick={onBack}>
            <Icon name="arrowLeft" /> All psychologists
          </button>
          {canManage && (
            <>
              <button type="button" className="btn" onClick={onEdit}>
                <Icon name="edit" /> Edit profile
              </button>
              <button type="button" className="btn btn-primary" onClick={onManageAvailability}>
                <Icon name="calendar" /> Manage availability
              </button>
            </>
          )}
        </div>
      </header>

      <section className="section" aria-labelledby="profile-details-title">
        <div className="section-head">
          <h2 id="profile-details-title">Details</h2>
        </div>
        <div className={`panel ${styles.detailsPanel}`}>
          <dl className={styles.details}>
            <div>
              <dt>Full name</dt>
              <dd>{psychologist.name || "—"}</dd>
            </div>
            <div>
              <dt>Phone number</dt>
              <dd className="num">{psychologist.phone || "—"}</dd>
            </div>
            <div>
              <dt>Account status</dt>
              <dd>{psychologist.active ? "Active" : "Inactive"}</dd>
            </div>
            <div>
              <dt>Profile created</dt>
              <dd>{since || "—"}</dd>
            </div>
          </dl>

          <div className={styles.loginBox}>
            <strong>Sign-in account</strong>
            <p>
              {psychologist.hasLogin
                ? "Connected to a sign-in account. Account details are managed by the authentication system and are not shown here."
                : "No sign-in account yet. Linking one needs the backend account workflow."}
            </p>
            {canManage && (
              <button
                type="button"
                className={`btn btn-sm ${psychologist.active ? "btn-danger" : ""}`}
                disabled={statusBusy}
                onClick={onToggleActive}
              >
                {statusBusy ? "Saving…" : psychologist.active ? "Deactivate profile" : "Activate profile"}
              </button>
            )}
          </div>
        </div>
      </section>
    </>
  );
}
