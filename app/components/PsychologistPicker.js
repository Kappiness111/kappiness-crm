"use client";

import { useId, useMemo, useRef, useState } from "react";
import Icon from "./Icon";
import { periodsFor } from "../lib/appointmentSlots";
import { summarizeAvailability } from "../lib/psychologists";

/* Searchable psychologist selector (ARIA combobox). Lists active psychologists from the
   `psychologists` table with their weekly availability from `psychologist_availability`.
   value / onChange use the psychologist id (or null for unassigned). */

function availabilityText(availability, id) {
  const summary = summarizeAvailability(periodsFor(availability, id));
  return summary.label === "Not set" ? "Availability not set" : `Available ${summary.label}`;
}

export default function PsychologistPicker({
  id,
  psychologists = [],
  availability = [],
  value = null,
  onChange,
  disabled = false,
  loadState = "ready", // loading | ready | error
  onRetry,
  error,
  label = "Psychologist",
}) {
  const listId = useId();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const selected = psychologists.find((item) => String(item.id) === String(value)) || null;
  const options = useMemo(() => {
    const term = query.trim().toLowerCase();
    return psychologists
      .filter((item) => item.active || String(item.id) === String(value))
      .filter((item) => !term || item.name.toLowerCase().includes(term) || (item.phone || "").includes(term))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [psychologists, query, value]);

  function choose(item) {
    onChange(item ? item.id : null);
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.min(index + 1, Math.max(options.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActiveIndex((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open) {
      event.preventDefault();
      if (options[activeIndex]) choose(options[activeIndex]);
    } else if (event.key === "Escape" && open) {
      // Close only the list, not the surrounding drawer.
      event.preventDefault();
      event.stopPropagation();
      event.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  }

  const errorId = error ? `${id}-error` : undefined;
  const expanded = open && loadState === "ready";

  return (
    <div className={`psy-picker ${disabled ? "disabled" : ""}`}>
      <label htmlFor={id} className="psy-picker-label">
        {label}
      </label>

      {selected && (
        <div className="psy-picker-selected">
          <span className="psy-avatar" aria-hidden="true">
            {selected.name.charAt(0).toUpperCase()}
          </span>
          <span className="psy-picker-selected-text">
            <strong>{selected.name}</strong>
            <small>
              {availabilityText(availability, selected.id)}
              {!selected.active ? " · Inactive" : ""}
            </small>
          </span>
          {!disabled && (
            <button type="button" className="text-button" onClick={() => choose(null)}>
              Clear
            </button>
          )}
        </div>
      )}

      <div className="psy-picker-field">
        <span className="psy-picker-search" aria-hidden="true">
          <Icon name="search" />
        </span>
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          aria-autocomplete="list"
          aria-expanded={expanded}
          aria-controls={listId}
          aria-activedescendant={expanded && options[activeIndex] ? `${listId}-${options[activeIndex].id}` : undefined}
          aria-invalid={error ? "true" : undefined}
          aria-describedby={errorId}
          disabled={disabled || loadState !== "ready"}
          placeholder={
            loadState === "loading"
              ? "Loading psychologists…"
              : selected
                ? "Search to change psychologist"
                : "Search psychologists by name"
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActiveIndex(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onClick={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
      </div>

      {expanded && (
        <ul className="psy-picker-list" id={listId} role="listbox" aria-label="Psychologists">
          {options.map((item, index) => {
            const isSelected = String(item.id) === String(value);
            return (
              <li
                key={item.id}
                id={`${listId}-${item.id}`}
                role="option"
                aria-selected={isSelected}
                className={`psy-picker-option ${index === activeIndex ? "active" : ""}`}
                // mousedown keeps focus in the input so onBlur does not close the list first
                onMouseDown={(event) => {
                  event.preventDefault();
                  choose(item);
                }}
                onMouseEnter={() => setActiveIndex(index)}
              >
                <span className="psy-avatar" aria-hidden="true">
                  {item.name.charAt(0).toUpperCase()}
                </span>
                <span className="psy-picker-option-text">
                  <strong>{item.name}</strong>
                  <small>{availabilityText(availability, item.id)}</small>
                </span>
                {isSelected && (
                  <span className="psy-picker-check" aria-hidden="true">
                    <Icon name="check" />
                  </span>
                )}
              </li>
            );
          })}
          {options.length === 0 && (
            <li className="psy-picker-empty" role="presentation">
              {psychologists.some((item) => item.active)
                ? "No psychologist matches your search."
                : "No active psychologists yet. Add one on the Psychologists page."}
            </li>
          )}
        </ul>
      )}

      {loadState === "error" && (
        <p className="field-error" role="alert">
          Could not load psychologists.{" "}
          {onRetry && (
            <button type="button" className="text-button" onClick={onRetry}>
              Try again
            </button>
          )}
        </p>
      )}
      {error && (
        <p className="field-error" id={errorId} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
