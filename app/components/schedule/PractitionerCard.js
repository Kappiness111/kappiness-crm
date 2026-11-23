"use client";

import Icon from "../Icon";
import { SLOT_STATUS, formatSlotTime } from "../../lib/scheduleCapacity";

/* One practitioner's day: header with hours, leave and capacity, then the numbered slots S1–S10.
   Every slot action calls a real operation through the handlers passed in by the board. */
export function SlotStatus({ appointment }) {
  const meta = SLOT_STATUS[appointment.status] || { label: appointment.status, tone: "" };
  return (
    <span className="slot-tags">
      <span className={`slot-status tone-${meta.tone}`} title={meta.hint}>
        {meta.label}
      </span>
      {appointment.rescheduled_from_id && appointment.status !== "Rescheduled" ? (
        <span className="slot-status tone-rescheduled" title="Moved here from another date or time">
          Rescheduled
        </span>
      ) : null}
      {appointment.recommendation_id ? <span className="slot-status tone-plain">Follow-up</span> : null}
    </span>
  );
}

export default function PractitionerCard({ day, matches, canManage, now, onBook, onOpen, onConfirm, onReschedule, onMarkSlotUnavailable, onFreeSlot, onToggleLeave }) {
  const { psychologist, slots, booked, capacity, available, onLeave, working, hours } = day;
  const pct = capacity ? Math.min(100, Math.round((booked / capacity) * 100)) : 0;
  const remainingText = !working ? "Not working this day" : onLeave ? "On leave" : `${available} slot${available === 1 ? "" : "s"} available`;

  return (
    <article className={`prac-card ${onLeave ? "is-leave" : ""}`} aria-label={`${psychologist.name}, ${booked} of ${capacity} slots booked`}>
      <header className="prac-head">
        <div className="prac-id">
          <h3>
            {psychologist.name}
            {hours ? <span className="prac-hours"> ({hours})</span> : null}
          </h3>
          <span className="prac-role">Psychologist</span>
        </div>
        <div className="prac-count">
          {onLeave ? (
            <span className="slot-status tone-leave">On leave</span>
          ) : (
            <>
              <strong>
                {booked} / {capacity}
              </strong>
              <span>slots</span>
            </>
          )}
        </div>
      </header>
      <div className="prac-meter" role="progressbar" aria-label="Slots booked" aria-valuemin={0} aria-valuemax={capacity} aria-valuenow={booked}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="prac-sub">
        <span>{remainingText}</span>
        {canManage && working && (
          <button type="button" className="text-button" onClick={() => onToggleLeave(day)}>
            {onLeave ? "Remove leave" : "Mark on leave"}
          </button>
        )}
      </div>

      <ol className="slot-list">
        {slots.map((slot) => {
          const dim = matches && !matches(slot);
          if (slot.kind === "booked") {
            const appt = slot.appointment;
            const active = appt.status === "Scheduled" || appt.status === "Confirmed";
            const started = new Date(appt.starts_at) <= now;
            return (
              <li key={slot.label} className={`sched-slot slot-booked tone-${(SLOT_STATUS[appt.status] || {}).tone || ""} ${dim ? "is-dim" : ""}`}>
                <span className="slot-no">{slot.label}</span>
                <button type="button" className="slot-main" onClick={() => onOpen(appt)} title={`${appt.client_name}: open appointment details`}>
                  <span className="slot-name">{appt.client_name}</span>
                  <span className="slot-time">
                    {formatSlotTime(slot.start, slot.end)}
                    {appt.notes ? <span className="slot-note"> · {appt.notes}</span> : null}
                  </span>
                  <SlotStatus appointment={appt} />
                </button>
                <span className="slot-actions">
                  {canManage && appt.status === "Scheduled" && (
                    <button type="button" className="slot-icon" onClick={() => onConfirm(appt)} aria-label={`Record client confirmation for ${appt.client_name}`} title="Record client confirmation">
                      <Icon name="check" />
                    </button>
                  )}
                  {appt.client_phone ? (
                    <a className="slot-icon" href={`tel:${appt.client_phone.replace(/\s+/g, "")}`} aria-label={`Call ${appt.client_name}`} title={`Call ${appt.client_phone}`}>
                      <Icon name="phone" />
                    </a>
                  ) : null}
                  {canManage && active && !started && (
                    <button type="button" className="slot-icon" onClick={() => onReschedule(appt)} aria-label={`Reschedule ${appt.client_name}`} title="Reschedule">
                      <Icon name="calendar" />
                    </button>
                  )}
                  <button type="button" className="slot-icon" onClick={() => onOpen(appt)} aria-label={`Edit appointment for ${appt.client_name}`} title="Edit or update appointment">
                    <Icon name="edit" />
                  </button>
                </span>
              </li>
            );
          }
          if (slot.kind === "free") {
            return (
              <li key={slot.label} className={`sched-slot slot-free ${dim ? "is-dim" : ""}`}>
                <span className="slot-no">{slot.label}</span>
                <button type="button" className="slot-main" onClick={() => onBook(day, slot)} disabled={!canManage}>
                  <span className="slot-name">+ Book {formatSlotTime(slot.start, slot.end)}</span>
                </button>
                {canManage && (
                  <span className="slot-actions">
                    <button type="button" className="slot-icon" onClick={() => onMarkSlotUnavailable(day, slot)} aria-label={`Mark ${slot.label} unavailable`} title="Mark this slot unavailable">
                      <Icon name="close" />
                    </button>
                  </span>
                )}
              </li>
            );
          }
          if (slot.kind === "leave") {
            return (
              <li key={slot.label} className={`sched-slot slot-leave ${dim ? "is-dim" : ""}`}>
                <span className="slot-no">{slot.label}</span>
                <span className="slot-main is-static">
                  <span className="slot-name">Unavailable · {formatSlotTime(slot.start, slot.end)}</span>
                  <span className="slot-time">{(slot.block && slot.block.reason) || "Leave"}</span>
                </span>
                {canManage && slot.block && (
                  <span className="slot-actions">
                    <button type="button" className="slot-icon" onClick={() => onFreeSlot(day, slot)} aria-label={`Make ${slot.label} available again`} title="Make available again">
                      <Icon name="plus" />
                    </button>
                  </span>
                )}
              </li>
            );
          }
          if (slot.kind === "passed") {
            return (
              <li key={slot.label} className={`sched-slot slot-off ${dim ? "is-dim" : ""}`}>
                <span className="slot-no">{slot.label}</span>
                <span className="slot-main is-static">
                  <span className="slot-name">{formatSlotTime(slot.start, slot.end)} · time has passed</span>
                </span>
              </li>
            );
          }
          return (
            <li key={slot.label} className={`sched-slot slot-off ${dim ? "is-dim" : ""}`}>
              <span className="slot-no">{slot.label}</span>
              <span className="slot-main is-static">
                <span className="slot-name">{working ? "Outside working hours" : "Not working"}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </article>
  );
}
