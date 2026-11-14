"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import ConfirmDialog from "../ConfirmDialog";
import Icon from "../Icon";
import AppointmentSlotDialog from "./AppointmentSlotDialog";
import DailyRoster from "./DailyRoster";
import MasterGrid from "./MasterGrid";
import MonthCapacity from "./MonthCapacity";
import PractitionerCard from "./PractitionerCard";
import useAppointmentWorkflow from "../scheduling/useAppointmentWorkflow";
import { confirmAppointment, describeAppointmentError, listAppointments } from "../../lib/appointmentsApi";
import { listClients } from "../../lib/clientsApi";
import { listAllAvailability, listPsychologists } from "../../lib/psychologistsApi";
import { addBlock, blockConflicts, listBlocks, listServices, removeBlock } from "../../lib/schedulingApi";
import { daySummary, formatSlotTime, monthOverview, scheduleForDay, slotNumbers } from "../../lib/scheduleCapacity";

const VIEWS = [
  { id: "cards", label: "10-Slot Cards" },
  { id: "grid", label: "Master Grid" },
  { id: "month", label: "Month" },
];

const STATUS_FILTERS = [
  { id: "all", label: "All statuses" },
  { id: "Confirmed", label: "Confirmed" },
  { id: "Scheduled", label: "Will inform (awaiting confirmation)" },
  { id: "rescheduled", label: "Rescheduled" },
  { id: "Completed", label: "Completed" },
  { id: "Missed", label: "Missed" },
  { id: "available", label: "Available slots" },
  { id: "leave", label: "Leave / unavailable" },
];

const pad = (n) => String(n).padStart(2, "0");
const toInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

/* Psychologist Schedule & Capacity board for staff. Reads real records only; every change goes through the
   existing database functions (book, confirm, reschedule, attendance, cancel, notes, blocked periods). */
export default function ScheduleBoard({ viewer, notify, onOpenClient }) {
  const [date, setDate] = useState(() => startOfDay(new Date()));
  const [view, setView] = useState("cards");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [practitionerFilter, setPractitionerFilter] = useState("all");
  const [data, setData] = useState({ key: "", status: "loading", message: "" });
  const [reload, setReload] = useState(0);
  const [now, setNow] = useState(() => new Date());
  const [openAppt, setOpenAppt] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, body, label, danger, run }

  const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
  const loadKey = `${monthKey}|${reload}`;
  const canManage = Boolean(viewer.isStaff);
  const refresh = useCallback(() => setReload((value) => value + 1), []);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: refresh, notify });

  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  // One month of records around the selected date feeds the day views and the month view alike.
  useEffect(() => {
    let cancelled = false;
    const monthStart = new Date(date.getFullYear(), date.getMonth(), 1);
    const monthEnd = new Date(date.getFullYear(), date.getMonth() + 1, 1);
    Promise.all([
      listPsychologists(),
      listAllAvailability(),
      listServices({ activeOnly: true }),
      listBlocks({ from: monthStart }),
      listAppointments({ from: monthStart, to: monthEnd }),
    ])
      .then(([psychologists, availability, services, blocks, appointments]) => {
        if (cancelled) return;
        const shortest = services.reduce((best, s) => (!best || s.duration_minutes < best.duration_minutes ? s : best), null);
        setData({
          key: loadKey,
          status: "ready",
          message: "",
          psychologists: psychologists.filter((p) => p.active).sort((a, b) => a.name.localeCompare(b.name)),
          availability,
          services,
          blocks,
          appointments,
          slotService: shortest,
        });
        setNow(new Date());
      })
      .catch((error) => {
        console.error("Failed to load the schedule:", error);
        if (!cancelled) setData({ key: loadKey, status: "error", message: describeAppointmentError(error, "We couldn't load the schedule. Please try again.") });
      });
    return () => {
      cancelled = true;
    };
    // Reload only when the month changes or after a change; moving between days in a month reuses the records.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey]);

  const loading = data.key !== loadKey || data.status === "loading";
  const ready = data.status === "ready" && data.key === loadKey;
  const slotData = useMemo(
    () =>
      ready
        ? {
            availability: data.availability,
            appointments: data.appointments,
            blocks: data.blocks,
            slotMinutes: data.slotService ? data.slotService.duration_minutes : 60,
            bufferMinutes: data.slotService ? data.slotService.buffer_minutes : 0,
            now,
          }
        : null,
    [ready, data, now]
  );

  const days = useMemo(() => (slotData ? scheduleForDay(data.psychologists, date, slotData) : []), [slotData, data.psychologists, date]);
  const summary = useMemo(() => daySummary(days), [days]);
  const labels = useMemo(() => slotNumbers(days), [days]);
  const month = useMemo(() => (slotData && view === "month" ? monthOverview(data.psychologists, date, slotData) : []), [slotData, data.psychologists, date, view]);
  const names = useMemo(() => Object.fromEntries((data.psychologists || []).map((p) => [p.id, p.name])), [data.psychologists]);

  /* ----- search and filters (never change records) ----- */
  const term = search.trim().toLowerCase();
  const slotMatches = useCallback(
    (slot) => {
      const appt = slot.appointment;
      if (statusFilter === "available" && slot.kind !== "free") return false;
      if (statusFilter === "leave" && slot.kind !== "leave") return false;
      if (statusFilter === "rescheduled" && !(appt && appt.rescheduled_from_id)) return false;
      if (!["all", "available", "leave", "rescheduled"].includes(statusFilter) && (!appt || appt.status !== statusFilter)) return false;
      if (!term) return true;
      const text = [slot.label, appt && appt.client_name, appt && appt.notes, appt && appt.service_type, slot.start && formatSlotTime(slot.start, slot.end)]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return text.includes(term);
    },
    [statusFilter, term]
  );
  const filtering = term || statusFilter !== "all";
  const visibleDays = days.filter((day) => {
    if (practitionerFilter !== "all" && String(day.psychologist.id) !== practitionerFilter) return false;
    if (statusFilter === "leave" && day.onLeave) return true;
    if (!filtering) return true;
    if (term && day.psychologist.name.toLowerCase().includes(term) && statusFilter === "all") return true;
    return day.slots.some(slotMatches);
  });
  const rosterRows = days
    .filter((day) => practitionerFilter === "all" || String(day.psychologist.id) === practitionerFilter)
    .flatMap((day) => day.dayAppointments)
    .filter((appt) => {
      if (statusFilter === "rescheduled" && !appt.rescheduled_from_id && appt.status !== "Rescheduled") return false;
      if (!["all", "available", "leave", "rescheduled"].includes(statusFilter) && appt.status !== statusFilter) return false;
      if (["available", "leave"].includes(statusFilter)) return false;
      if (!term) return true;
      return [appt.client_name, appt.notes, appt.service_type, names[appt.psychologist_id], labels[appt.id]].filter(Boolean).join(" ").toLowerCase().includes(term);
    })
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

  /* ----- actions ----- */
  function shiftDay(delta) {
    setDate((current) => new Date(current.getFullYear(), current.getMonth(), current.getDate() + delta));
  }
  function shiftMonth(delta) {
    setDate((current) => new Date(current.getFullYear(), current.getMonth() + delta, 1));
  }

  async function bookSlot(day, slot) {
    try {
      const clients = (await listClients()).filter((item) => item.is_active);
      if (clients.length === 0) {
        notify("There are no clients to book yet. A lead becomes a client once it is Confirmed with a psychologist.", "error");
        return;
      }
      workflow.openBooking(null, null, clients, {
        psychologistId: day.psychologist.id,
        serviceId: data.slotService ? data.slotService.id : null,
        day: slot.start,
        slotStart: slot.start,
      });
    } catch (error) {
      notify(describeAppointmentError(error, "We couldn't open booking. Please try again."), "error");
    }
  }

  function askConfirm(appt) {
    setConfirm({
      title: "Record client confirmation",
      body: `${appt.client_name} has confirmed the appointment on ${new Date(appt.starts_at).toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })} at ${formatSlotTime(new Date(appt.starts_at), new Date(appt.ends_at))}.`,
      label: "Mark as confirmed",
      run: async () => {
        try {
          await confirmAppointment(appt.id);
          notify(`${appt.client_name}'s appointment is now confirmed.`);
          refresh();
          return { ok: true };
        } catch (error) {
          return { ok: false, message: describeAppointmentError(error) };
        }
      },
    });
  }

  function markSlotUnavailable(day, slot) {
    setConfirm({
      title: `Mark ${slot.label} unavailable`,
      body: `${day.psychologist.name} will not be bookable ${formatSlotTime(slot.start, slot.end)} on ${slot.start.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}. Nothing booked is changed.`,
      label: "Mark unavailable",
      run: async () => {
        try {
          await addBlock(day.psychologist.id, slot.start, slot.end, "Slot unavailable");
          notify(`${slot.label} marked unavailable.`);
          refresh();
          return { ok: true };
        } catch (error) {
          return { ok: false, message: describeAppointmentError(error, "We couldn't block this slot.") };
        }
      },
    });
  }

  function freeSlot(day, slot) {
    const block = slot.block;
    const range = `${new Date(block.starts_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} – ${new Date(block.ends_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}`;
    setConfirm({
      title: "Make this time available again",
      body: `This removes the blocked period ${range}${block.reason ? ` (${block.reason})` : ""} for ${day.psychologist.name}. Every slot inside that period becomes bookable again.`,
      label: "Remove block",
      run: async () => {
        try {
          await removeBlock(block.id);
          notify("The time is available again.");
          refresh();
          return { ok: true };
        } catch (error) {
          return { ok: false, message: describeAppointmentError(error, "We couldn't remove the block.") };
        }
      },
    });
  }

  async function toggleLeave(day) {
    const dayStart = startOfDay(date);
    const dayEnd = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate() + 1);
    const label = dayStart.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
    if (day.onLeave) {
      setConfirm({
        title: `Remove ${day.psychologist.name}'s leave`,
        body: `These blocked periods will be removed in full: ${day.blocks
          .map((b) => `${new Date(b.starts_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })} – ${new Date(b.ends_at).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })}${b.reason ? ` (${b.reason})` : ""}`)
          .join("; ")}. ${day.psychologist.name} becomes bookable again for those times.`,
        label: "Remove leave",
        run: async () => {
          try {
            for (const block of day.blocks) await removeBlock(block.id);
            notify(`${day.psychologist.name} is available on ${label}.`);
            refresh();
            return { ok: true };
          } catch (error) {
            return { ok: false, message: describeAppointmentError(error, "We couldn't remove the leave.") };
          }
        },
      });
      return;
    }
    let clashes = [];
    try {
      clashes = await blockConflicts(day.psychologist.id, dayStart, dayEnd);
    } catch (error) {
      notify(describeAppointmentError(error, "We couldn't check this day's bookings."), "error");
      return;
    }
    if (clashes.length) {
      setConfirm({
        title: `${day.psychologist.name} has bookings on ${label}`,
        body: `Leave can't be added while these appointments are booked: ${clashes.map((c) => `${c.client_name} (${formatSlotTime(new Date(c.starts_at), new Date(c.ends_at))})`).join(", ")}. Reschedule or cancel them first. Nothing has been changed.`,
        label: "OK",
        run: async () => ({ ok: true }),
      });
      return;
    }
    setConfirm({
      title: `Mark ${day.psychologist.name} on leave`,
      body: `${day.psychologist.name} will not be bookable on ${label}. You can remove the leave later.`,
      label: "Mark on leave",
      run: async () => {
        try {
          await addBlock(day.psychologist.id, dayStart, dayEnd, "Leave");
          notify(`${day.psychologist.name} is marked on leave for ${label}.`);
          refresh();
          return { ok: true };
        } catch (error) {
          return { ok: false, message: describeAppointmentError(error, "We couldn't add the leave.") };
        }
      },
    });
  }

  const openSlot = openAppt ? Object.entries(labels).find(([id]) => id === openAppt.id) : null;
  const pct = summary.capacity ? Math.round((Math.min(summary.booked, summary.capacity) / summary.capacity) * 100) : 0;
  const cards = [
    { id: "all", label: "Total booked", value: `${summary.booked} / ${summary.capacity}`, meta: `${summary.utilisation}% of capacity used`, bar: pct },
    { id: "available", label: "Available capacity", value: summary.available, meta: summary.available ? "Slots ready to book" : "No free slots left" },
    { id: "Confirmed", label: "Confirmed", value: summary.confirmed, meta: "Confirmed by the client" },
    { id: "Scheduled", label: "Will inform", value: summary.willInform, meta: "Waiting for the client to confirm" },
    { id: "rescheduled", label: "Rescheduled", value: summary.rescheduled, meta: "Bookings moved off this date" },
    { id: "leave", label: "Staff on leave", value: summary.onLeave, meta: "Full day" },
    { id: "practitioners", label: "Total practitioners", value: summary.practitioners, meta: "Active psychologists" },
  ];

  return (
    <>
      <div className="sched-toolbar">
        <div className="sched-date">
          <button type="button" className="icon-btn" onClick={() => shiftDay(-1)} aria-label="Previous day">
            <Icon name="chevronLeft" />
          </button>
          <input
            type="date"
            aria-label="Selected date"
            value={toInput(date)}
            onChange={(event) => {
              if (event.target.value) setDate(new Date(`${event.target.value}T00:00`));
            }}
          />
          <button type="button" className="icon-btn" onClick={() => shiftDay(1)} aria-label="Next day">
            <Icon name="chevronRight" />
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setDate(startOfDay(new Date()))}>
            Today
          </button>
          <strong className="sched-date-label">{date.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</strong>
        </div>
        <div className="range-tabs" role="radiogroup" aria-label="View">
          {VIEWS.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={view === item.id} className={view === item.id ? "is-active" : ""} onClick={() => setView(item.id)}>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {data.status === "error" && !loading && (
        <div className="notice" role="alert">
          <Icon name="alert" />
          <div>
            <strong>We couldn&apos;t load the schedule</strong>
            {data.message}{" "}
            <button type="button" className="link-btn" onClick={refresh}>
              Try again
            </button>
          </div>
        </div>
      )}

      {view === "month" ? (
        ready ? (
          <MonthCapacity
            anchor={date}
            days={month}
            selected={date}
            today={now}
            onPrev={() => shiftMonth(-1)}
            onNext={() => shiftMonth(1)}
            onSelect={(d) => {
              setDate(startOfDay(d));
              setView("cards");
            }}
          />
        ) : (
          <p className="appt-empty">Loading the month…</p>
        )
      ) : (
        <>
          <section className="kpis sched-kpis" aria-label="Daily summary">
            {cards.map((card) => (
              <button
                key={card.id}
                type="button"
                className="kpi"
                aria-pressed={card.id !== "practitioners" && statusFilter === card.id}
                onClick={() => card.id !== "practitioners" && setStatusFilter(card.id === statusFilter ? "all" : card.id)}
              >
                <span className="kpi-label">{card.label}</span>
                <span className="kpi-value">{loading ? "…" : card.value}</span>
                <span className="kpi-meta">{card.meta}</span>
                {card.bar !== undefined ? (
                  <span className="sched-kpi-bar" aria-hidden="true">
                    <span style={{ width: `${loading ? 0 : card.bar}%` }} />
                  </span>
                ) : null}
              </button>
            ))}
          </section>

          <div className="toolbar sched-filters">
            <label className="search">
              <Icon name="search" />
              <span className="sr-only">Search the schedule</span>
              <input type="search" placeholder="Search client, psychologist, or slot note..." value={search} onChange={(event) => setSearch(event.target.value)} />
            </label>
            <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Status">
              {STATUS_FILTERS.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label}
                </option>
              ))}
            </select>
            <select value={practitionerFilter} onChange={(event) => setPractitionerFilter(event.target.value)} aria-label="Psychologist">
              <option value="all">All psychologists</option>
              {(data.psychologists || []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <span className="spacer" />
            <span className="count">
              {loading ? "Loading…" : `${visibleDays.length} of ${days.length} practitioners`}
            </span>
          </div>

          {ready && data.slotService && (
            <p className="subtle-text sched-note">
              Slots are {data.slotService.duration_minutes}-minute sessions{data.slotService.buffer_minutes ? ` with ${data.slotService.buffer_minutes} minutes between them` : ""}, inside each
              psychologist&apos;s working hours. Capacity counts those slots, minus leave.
            </p>
          )}

          {loading && <p className="appt-empty">Loading the schedule…</p>}
          {ready && days.length === 0 && (
            <div className="panel">
              <div className="state">
                <Icon name="userCheck" />
                <strong>No active psychologists</strong>
                <span>Add a psychologist under Psychologists to start scheduling.</span>
              </div>
            </div>
          )}
          {ready && days.length > 0 && visibleDays.length === 0 && (
            <div className="panel">
              <div className="state">
                <Icon name="search" />
                <strong>No practitioners match</strong>
                <span>Try a different search or filter.</span>
              </div>
            </div>
          )}

          {ready && visibleDays.length > 0 && view === "cards" && (
            <div className="prac-grid">
              {visibleDays.map((day) => (
                <PractitionerCard
                  key={day.psychologist.id}
                  day={day}
                  matches={filtering ? slotMatches : null}
                  canManage={canManage}
                  now={now}
                  onBook={bookSlot}
                  onOpen={setOpenAppt}
                  onConfirm={askConfirm}
                  onReschedule={(appt) => workflow.runAction(appt, "reschedule")}
                  onMarkSlotUnavailable={markSlotUnavailable}
                  onFreeSlot={freeSlot}
                  onToggleLeave={toggleLeave}
                />
              ))}
            </div>
          )}

          {ready && visibleDays.length > 0 && view === "grid" && (
            <MasterGrid days={visibleDays} matches={filtering ? slotMatches : null} canManage={canManage} onBook={bookSlot} onOpen={setOpenAppt} />
          )}

          {ready && <DailyRoster rows={rosterRows} slotLabels={labels} psychologistNames={names} allAppointments={data.appointments} onOpen={setOpenAppt} />}
        </>
      )}

      {openAppt && (
        <AppointmentSlotDialog
          key={openAppt.id}
          appointment={openAppt}
          slotLabel={openSlot ? openSlot[1] : ""}
          psychologistName={names[openAppt.psychologist_id]}
          canManage={canManage}
          workflow={workflow}
          onConfirm={askConfirm}
          onSaved={(message) => {
            notify(message);
            setOpenAppt(null);
            refresh();
          }}
          onOpenClient={onOpenClient}
          onClose={() => setOpenAppt(null)}
        />
      )}

      {confirm && (
        <ConfirmDialog title={confirm.title} confirmLabel={confirm.label} danger={confirm.danger} onConfirm={confirm.run} onClose={() => setConfirm(null)}>
          <p>{confirm.body}</p>
        </ConfirmDialog>
      )}

      {workflow.dialogs}
    </>
  );
}
