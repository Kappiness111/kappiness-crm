"use client";

import { SLOT_STATUS, formatSlotTime } from "../../lib/scheduleCapacity";
import { formatDate } from "../../lib/leads";

/* Every appointment on the selected date in one table, including cancelled and moved ones, using the same slot
   numbers as the cards. */
export default function DailyRoster({ rows, slotLabels, psychologistNames, allAppointments, onOpen }) {
  const replacementOf = (appt) => allAppointments.find((item) => item.rescheduled_from_id === appt.id);

  return (
    <section className="section" aria-labelledby="roster-title">
      <div className="section-head">
        <div>
          <h2 id="roster-title">
            Daily client roster <span className="muted num">{rows.length}</span>
          </h2>
          <p>All appointments on this date in time order, including cancelled and moved bookings.</p>
        </div>
      </div>
      <div className="panel">
        {rows.length === 0 ? (
          <p className="appt-empty">No appointments on this date match the current search and filters.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Slot</th>
                  <th scope="col">Time</th>
                  <th scope="col">Client</th>
                  <th scope="col">Psychologist</th>
                  <th scope="col">Service</th>
                  <th scope="col">Notes</th>
                  <th scope="col">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((appt) => {
                  const meta = SLOT_STATUS[appt.status] || { label: appt.status, tone: "" };
                  const moved = appt.status === "Rescheduled" ? replacementOf(appt) : null;
                  return (
                    <tr key={appt.id} className="clickable" tabIndex={0} onClick={() => onOpen(appt)} onKeyDown={(event) => event.key === "Enter" && onOpen(appt)}>
                      <td className="num">{slotLabels[appt.id] || <span className="muted">—</span>}</td>
                      <td className="num">{formatSlotTime(new Date(appt.starts_at), new Date(appt.ends_at))}</td>
                      <td>
                        <strong>{appt.client_name}</strong>
                        {appt.client_phone ? <small className="muted block">{appt.client_phone}</small> : null}
                      </td>
                      <td>{psychologistNames[appt.psychologist_id] || "—"}</td>
                      <td>
                        {appt.service_type}
                        {appt.recommendation_id ? <small className="muted block">Follow-up session</small> : null}
                      </td>
                      <td className="wrap">{appt.notes || <span className="muted">—</span>}</td>
                      <td>
                        <span className={`slot-status tone-${meta.tone}`}>{meta.label}</span>
                        {moved ? <small className="muted block">Moved to {formatDate(moved.starts_at)}</small> : null}
                        {appt.status === "Cancelled" && appt.cancellation_reason ? <small className="muted block">{appt.cancellation_reason}</small> : null}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </section>
  );
}
