"use client";

import { formatClock } from "../../lib/calendar";

/* One slot picker for every booking flow (lead conversion and follow-up booking both open BookingModal,
   which renders this). Slots come from slotsForDay() and carry a state:
     available  free to book (selectable)
     tentative  held by a booking still waiting for the client to confirm
     booked     held by a confirmed booking
     blocked    leave or a blocked period
     past       already started
   Only available slots can be picked. Every state is written out (legend, tooltip, screen-reader label),
   so colour is never the only signal. */

export const SLOT_STATE = {
  available: { label: "Available", hint: "Free to book" },
  tentative: { label: "Tentative", hint: "Held by a booking awaiting the client's confirmation" },
  booked: { label: "Booked", hint: "Taken by a confirmed booking" },
  blocked: { label: "Unavailable", hint: "Psychologist on leave or blocked" },
  past: { label: "Passed", hint: "This time has already started" },
};

function stateOf(slot) {
  if (slot.state) return slot.state;
  if (slot.blocked) return "blocked";
  if (slot.taken) return "booked";
  if (slot.past) return "past";
  return "available";
}

export function SlotLegend({ states = ["available", "tentative", "booked"] }) {
  return (
    <ul className="slot-legend" aria-label="Slot key">
      {states.map((state) => (
        <li key={state}>
          <span className={`slot-swatch slot-${state}`} aria-hidden="true" />
          {SLOT_STATE[state].label}
        </li>
      ))}
    </ul>
  );
}

export default function SlotPicker({ slots, value, onChange, label = "Time slots", showLegend = true }) {
  const present = new Set(slots.map(stateOf));
  const legendStates = ["available", "tentative", "booked", "blocked"].filter((state) => state === "available" || present.has(state));

  return (
    <div className="slot-picker">
      {showLegend && slots.length > 0 && <SlotLegend states={legendStates} />}
      <div className="slot-grid" role="radiogroup" aria-label={label}>
        {slots.map((slot) => {
          const key = slot.start.toISOString();
          const state = stateOf(slot);
          const selected = value === key;
          const range = `${formatClock(slot.start)} – ${formatClock(slot.end)}`;
          const meta = SLOT_STATE[state];
          return (
            <button
              type="button"
              key={key}
              role="radio"
              aria-checked={selected}
              aria-label={state === "available" ? range : `${range}, ${meta.label.toLowerCase()}`}
              className={`slot slot-${state} ${selected ? "active" : ""}`}
              disabled={state !== "available"}
              title={state === "available" ? range : `${range}: ${meta.hint}`}
              onClick={() => onChange(key)}
            >
              {formatClock(slot.start)}
              {state === "tentative" || state === "booked" ? <span className="slot-tag">{meta.label}</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
