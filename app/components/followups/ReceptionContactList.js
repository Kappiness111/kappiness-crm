"use client";

import { useEffect, useMemo, useState } from "react";
import Icon from "../Icon";
import CommunicationButtons from "./CommunicationButtons";
import FollowUpFilters, { EMPTY_FOLLOW_UP_FILTERS } from "./FollowUpFilters";
import WhatsAppMessageDialog from "./WhatsAppMessageDialog";
import { CommunicationBadge, DueDate, FollowUpStatusCell, FollowUpTypeBadge } from "./FollowUpBadges";
import styles from "./followups.module.css";
import { listClientPhones, needsContact, sortFollowUps } from "../../lib/followUpsApi";
import { formatDate, formatTime } from "../../lib/leads";
import useFollowUpRecords from "./useFollowUpRecords";

// Statuses that can still need contact (closed follow-ups never do).
const CONTACT_STATUSES = ["Contact Needed", "Due Today", "Overdue", "Upcoming", "Pending Confirmation"];

/* Reception's contact list: open follow-ups that need the client contacted (Type B, Contact Needed, or due /
   overdue with communication Reminder Pending or No Response). Staff only; the database checks again.
   Opening WhatsApp or the dialler records nothing: staff choose the communication status afterwards. */
export default function ReceptionContactList({ viewer, psychologistNames = {}, notify, onOpenClient }) {
  const [filters, setFilters] = useState({ ...EMPTY_FOLLOW_UP_FILTERS });
  const [phones, setPhones] = useState({ key: "", map: {} });
  const [whatsapp, setWhatsapp] = useState(null); // follow-up row
  const serverFilters = useMemo(
    () => ({
      psychologistId: filters.psychologistId || null,
      status: filters.status || null,
      dateFrom: filters.dateFrom || null,
      dateTo: filters.dateTo || null,
      openOnly: true,
    }),
    [filters]
  );
  const records = useFollowUpRecords({ filters: serverFilters, viewer, psychologistNames, notify, onOpenClient });
  const { state, loading } = records;
  const rows = useMemo(() => sortFollowUps(records.rows.filter(needsContact)), [records.rows]);

  const clientKey = [...new Set(rows.map((row) => row.client_id))].sort().join(",");
  useEffect(() => {
    if (!clientKey || !viewer.isStaff) return undefined;
    let cancelled = false;
    listClientPhones(clientKey.split(","))
      .then((map) => {
        if (!cancelled) setPhones({ key: clientKey, map });
      })
      .catch((error) => console.error("Could not load client phone numbers:", error));
    return () => {
      cancelled = true;
    };
  }, [clientKey, viewer.isStaff]);

  if (!viewer.isStaff) {
    return (
      <div className="notice" role="status">
        <Icon name="info" />
        <div>
          <strong>For clinic staff</strong>
          Reception contacts clients and records the outcome here.
        </div>
      </div>
    );
  }

  const phonesReady = phones.key === clientKey;

  return (
    <section className="panel" aria-label="Clients to contact">
      <FollowUpFilters
        value={filters}
        onChange={setFilters}
        psychologistNames={psychologistNames}
        statuses={CONTACT_STATUSES}
        show={{ type: false }}
        count={loading ? "" : `${rows.length} to contact`}
        idPrefix="fu-contact"
      />

      <p className={styles.hint} style={{ margin: "10px 16px 0" }}>
        Calling or opening WhatsApp does not record anything. After you speak to or message the client, choose what happened below.
        <strong> No Response</strong> creates a call follow-up for reception.
      </p>

      {state.status === "error" && (
        <div className="state" role="alert">
          <Icon name="alert" />
          <strong>Could not load the contact list</strong>
          <span>{state.message}</span>
          <button type="button" className="btn btn-sm" onClick={records.refresh}>
            Try again
          </button>
        </div>
      )}
      {loading && state.status !== "error" && <p className="appt-empty">Loading clients to contact…</p>}
      {!loading && state.status === "ready" && rows.length === 0 && (
        <div className="state">
          <Icon name="checkCircle" />
          <strong>Nobody to contact</strong>
          <span>No follow-up needs a call or message for these filters.</span>
        </div>
      )}
      {!loading && state.status === "ready" && rows.length > 0 && (
        <ul className={styles.contactList}>
          {rows.map((row) => {
            const phone = phonesReady ? phones.map[row.client_id] : null;
            return (
              <li key={row.id} className={`${styles.contactRow} ${row.due_state === "Overdue" ? styles.rowOverdue : ""}`}>
                <div className={styles.contactHead}>
                  <button type="button" className="link-btn" onClick={() => records.open(row.id)} aria-label={`Open follow-up for ${row.client_name || "client"}`}>
                    <strong>{row.client_name || "Client"}</strong>
                  </button>
                  <FollowUpTypeBadge type={row.follow_up_type} />
                  <FollowUpStatusCell row={row} />
                  <span className="muted">
                    {row.proposed_starts_at ? (
                      `${formatDate(row.proposed_starts_at)}, ${formatTime(row.proposed_starts_at)}`
                    ) : (
                      <>
                        Due <DueDate row={row} />
                      </>
                    )}
                  </span>
                  {psychologistNames[row.psychologist_id] ? <span className="muted">· {psychologistNames[row.psychologist_id]}</span> : null}
                  <span className={styles.grow} />
                  <span className="muted">Now:</span>
                  <CommunicationBadge status={row.communication_status} />
                </div>

                <div className={styles.contactActions} style={{ marginTop: 8 }}>
                  {phone ? (
                    <>
                      <a className="btn btn-sm" href={`tel:${phone}`}>
                        <Icon name="phone" /> Call
                      </a>
                      <button type="button" className="btn btn-sm" onClick={() => setWhatsapp({ row, phone })}>
                        WhatsApp
                      </button>
                    </>
                  ) : (
                    <span className="muted">{phonesReady ? "No phone number saved" : "Loading phone number…"}</span>
                  )}
                </div>

                {row.notes ? <p className="subtle-text wrap">Administrative notes: {row.notes}</p> : null}

                <div style={{ marginTop: 10 }}>
                  <CommunicationButtons followUp={row} notify={notify} onSaved={(result) => records.handleChanged(result.followUp)} />
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {whatsapp && (
        <WhatsAppMessageDialog
          followUp={whatsapp.row}
          phone={whatsapp.phone}
          psychologistName={psychologistNames[whatsapp.row.psychologist_id] || ""}
          onClose={() => setWhatsapp(null)}
        />
      )}

      {records.drawer}
    </section>
  );
}
