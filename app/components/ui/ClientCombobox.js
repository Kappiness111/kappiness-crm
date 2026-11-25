"use client";

import { useId, useRef, useState } from "react";
import Icon from "../Icon";

/* Search-and-pick for a client: type a name or phone number and matching clients appear right under the field.
   Pick one with the mouse, or with the arrow keys and Enter. Escape closes the list. */

const digitsOf = (value) => String(value || "").replace(/\D/g, "");
const initialsOf = (name) =>
  String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0].toUpperCase())
    .join("");

export default function ClientCombobox({ id, clients, value, onChange, invalid = false, describedBy, maxResults = 8 }) {
  const listId = useId();
  const inputRef = useRef(null);
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);

  const selected = clients.find((item) => String(item.id) === String(value)) || null;
  const term = query.trim().toLowerCase();
  const digits = digitsOf(term);
  const matches = clients
    .filter((item) => !term || (item.full_name || "").toLowerCase().includes(term) || (digits.length >= 3 && digitsOf(item.phone).includes(digits)))
    .slice(0, maxResults);
  const total = term
    ? clients.filter((item) => (item.full_name || "").toLowerCase().includes(term) || (digits.length >= 3 && digitsOf(item.phone).includes(digits))).length
    : clients.length;

  function pick(item) {
    onChange(String(item.id));
    setQuery("");
    setOpen(false);
  }

  function onKeyDown(event) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setActive((index) => Math.min(index + 1, Math.max(matches.length - 1, 0)));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((index) => Math.max(index - 1, 0));
    } else if (event.key === "Enter" && open && matches[active]) {
      event.preventDefault();
      pick(matches[active]);
    } else if (event.key === "Escape" && open) {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  }

  if (!clients.length) {
    return <input id={id} value="" placeholder="No clients yet: confirm a lead first" disabled readOnly />;
  }

  const showing = open ? query : selected ? `${selected.full_name}${selected.phone ? ` · ${selected.phone}` : ""}` : query;

  return (
    <div className={`combo ${open ? "is-open" : ""}`}>
      <span className="combo-icon" aria-hidden="true">
        <Icon name="search" />
      </span>
      <input
        ref={inputRef}
        id={id}
        type="text"
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={open && matches[active] ? `${listId}-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        autoComplete="off"
        placeholder="Search by name or phone number"
        value={showing}
        onFocus={() => {
          setOpen(true);
          setActive(0);
        }}
        onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(event) => {
          setQuery(event.target.value);
          setOpen(true);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
      />
      {selected && !open ? (
        <button
          type="button"
          className="combo-clear"
          aria-label="Change client"
          onClick={() => {
            onChange("");
            setQuery("");
            inputRef.current?.focus();
          }}
        >
          <Icon name="close" />
        </button>
      ) : null}

      {open && (
        <ul className="combo-list" id={listId} role="listbox" aria-label="Matching clients">
          {matches.length === 0 ? (
            <li className="combo-empty" role="presentation">
              No client matches “{query.trim()}”.
            </li>
          ) : (
            matches.map((item, index) => (
              <li
                key={item.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={String(item.id) === String(value)}
                className={`combo-option ${index === active ? "is-active" : ""}`}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(item);
                }}
              >
                <span className="combo-avatar" aria-hidden="true">
                  {initialsOf(item.full_name)}
                </span>
                <span className="combo-text">
                  <strong>{item.full_name}</strong>
                  <small>{item.phone || "No phone number"}</small>
                </span>
                {String(item.id) === String(value) ? <Icon name="check" /> : null}
              </li>
            ))
          )}
          {total > matches.length ? (
            <li className="combo-more" role="presentation">
              {total - matches.length} more. Keep typing to narrow it down.
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}
