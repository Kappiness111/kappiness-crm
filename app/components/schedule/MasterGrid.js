"use client";

import { SLOT_STATUS, formatSlotTime } from "../../lib/scheduleCapacity";

/* Compact overview: one row per practitioner, one column per numbered slot. Same data as the cards. */
export default function MasterGrid({ days, matches, canManage, onBook, onOpen }) {
  const columns = Math.max(10, ...days.map((d) => d.slots.length));
  const headers = Array.from({ length: columns }, (_, i) => `S${i + 1}`);

  return (
    <div className="panel">
      <div className="table-wrap">
        <table className="table master-grid">
          <thead>
            <tr>
              <th scope="col" className="mg-sticky">
                Practitioner
              </th>
              {headers.map((label) => (
                <th key={label} scope="col">
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((day) => (
              <tr key={day.psychologist.id}>
                <th scope="row" className="mg-sticky">
                  <strong>{day.psychologist.name}</strong>
                  <small className="muted block">
                    Psychologist{day.hours ? ` · ${day.hours}` : ""}
                  </small>
                  <small className="block">
                    {day.onLeave ? <span className="slot-status tone-leave">On leave</span> : `${day.booked} / ${day.capacity} booked`}
                  </small>
                </th>
                {headers.map((label, index) => {
                  const slot = day.slots[index];
                  const dim = slot && matches && !matches(slot) ? "is-dim" : "";
                  if (!slot || slot.kind === "off") {
                    return (
                      <td key={label} className={`mg-cell mg-off ${dim}`}>
                        <span className="muted">—</span>
                      </td>
                    );
                  }
                  if (slot.kind === "booked") {
                    const appt = slot.appointment;
                    const meta = SLOT_STATUS[appt.status] || { label: appt.status, tone: "" };
                    return (
                      <td key={label} className={`mg-cell ${dim}`}>
                        <button type="button" className={`mg-btn tone-${meta.tone}`} onClick={() => onOpen(appt)} title={`${appt.client_name}, ${formatSlotTime(slot.start, slot.end)}, ${meta.label}${appt.notes ? `. ${appt.notes}` : ""}`}>
                          <span className="mg-name">{appt.client_name}</span>
                          <span className="mg-time">{formatSlotTime(slot.start, slot.end)}</span>
                          <span className="mg-status">{meta.label}</span>
                        </button>
                      </td>
                    );
                  }
                  if (slot.kind === "free") {
                    return (
                      <td key={label} className={`mg-cell ${dim}`}>
                        <button type="button" className="mg-btn mg-free" onClick={() => onBook(day, slot)} disabled={!canManage} title={`Book ${formatSlotTime(slot.start, slot.end)}`}>
                          <span className="mg-name">Free</span>
                          <span className="mg-time">{formatSlotTime(slot.start, slot.end)}</span>
                        </button>
                      </td>
                    );
                  }
                  return (
                    <td key={label} className={`mg-cell ${dim}`}>
                      <span className={`mg-btn is-static ${slot.kind === "leave" ? "tone-leave" : "mg-passed"}`}>
                        <span className="mg-name">{slot.kind === "leave" ? "Leave" : "Passed"}</span>
                        <span className="mg-time">{formatSlotTime(slot.start, slot.end)}</span>
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
