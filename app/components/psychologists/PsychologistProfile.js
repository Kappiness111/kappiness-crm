"use client";

import Icon from "../Icon";
import { formatMemberSince } from "../../lib/psychologists";
import styles from "./psychologists.module.css";

/* Profile header and detail cards. No authentication identifiers are shown, only whether a login is linked. */
export default function PsychologistProfile({ psychologist, canManage, statusBusy, onBack, onEdit, onManageAvailability, onToggleActive }) {
  const since = formatMemberSince(psychologist.createdAt);

  return (
    <>
      <section className={`${styles.card} ${styles.profileHeader}`}>
        <span className={`${styles.avatar} ${styles.avatarLarge}`} aria-hidden="true">
          {(psychologist.name || "?").charAt(0).toUpperCase()}
        </span>

        <div className={styles.profileHeading}>
          <h1>{psychologist.name || "Unnamed psychologist"}</h1>
          <div className={styles.badgeRow}>
            <span className={`${styles.badge} ${psychologist.active ? styles.badgeActive : styles.badgeInactive}`}>
              {psychologist.active ? "Active" : "Inactive"}
            </span>
          </div>
        </div>

        <div className={styles.headerActions}>
          <button className="secondary-button" onClick={onBack}><Icon name="arrowLeft" /> All psychologists</button>
          {canManage && (
            <>
              <button className="secondary-button" onClick={onEdit}><Icon name="edit" /> Edit Profile</button>
              <button className="primary-button" onClick={onManageAvailability}><Icon name="calendar" /> Manage Availability</button>
            </>
          )}
        </div>
      </section>

      <div className={styles.twoCol}>
        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Profile details</h2>
          </div>
          <div className={styles.cardBody}>
            <dl className={styles.detailGrid} style={{ margin: 0 }}>
              <div className={styles.detailItem}>
                <dt>Full name</dt>
                <dd>{psychologist.name || "—"}</dd>
              </div>
              <div className={styles.detailItem}>
                <dt>Phone number</dt>
                <dd>{psychologist.phone || "—"}</dd>
              </div>
              <div className={styles.detailItem}>
                <dt>Account status</dt>
                <dd>{psychologist.active ? "Active" : "Inactive"}</dd>
              </div>
              <div className={styles.detailItem}>
                <dt>Profile created</dt>
                <dd>{since || "—"}</dd>
              </div>
            </dl>
          </div>
        </section>

        <section className={styles.card}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>Login account</h2>
          </div>
          <div className={styles.cardBody}>
            <span className={`${styles.badge} ${psychologist.hasLogin ? styles.badgeLinked : styles.badgeInactive}`}>
              {psychologist.hasLogin ? "Login linked" : "No login linked"}
            </span>
            <p className={styles.hint} style={{ marginTop: 10 }}>
              {psychologist.hasLogin
                ? "This profile is connected to a sign-in account. Account details are managed by the authentication system and are not shown here."
                : "This profile has no sign-in account yet. Linking one needs the backend account workflow."}
            </p>

            {canManage && (
              <div style={{ marginTop: 16 }}>
                <button
                  className={psychologist.active ? "secondary-button" : "primary-button"}
                  disabled={statusBusy}
                  onClick={onToggleActive}
                >
                  {statusBusy ? "Saving..." : psychologist.active ? "Deactivate profile" : "Activate profile"}
                </button>
              </div>
            )}
          </div>
        </section>
      </div>
    </>
  );
}