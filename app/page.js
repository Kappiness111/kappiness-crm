"use client";

import Image from "next/image";
import { useEffect, useMemo, useRef, useState } from "react";
import AddLeadModal from "./components/AddLeadModal";
import Icon from "./components/Icon";
import LeadDetailsModal from "./components/LeadDetailsModal";
import StatusBadge from "./components/StatusBadge";
import { createClient } from "../utils/supabase/client";
import {
  CLOSED_STATUSES,
  STATUSES,
  dueLabel,
  formatDate,
  formatDateTime,
  formatShort,
  formatTime,
  getFollowUpState,
  getGreeting,
  parseDate,
  toInputValue,
} from "./lib/leads";

function mapLeadRecord(record) {
  return {
    ...record,
    id: record.id,
    lead_code: record.lead_code || String(record.id),
    full_name: record.full_name || "",
    phone: record.phone || "",
    email: record.email || "",
    source: record.source || "Other",
    assigned_staff: record.assigned_staff || "",
    status: record.status || "New",
    next_follow_up_at: record.next_follow_up_at || "",
    service_interest: record.service_interest || "",
    not_converted_reason: record.not_converted_reason || "",
    notes: record.notes || "",
    activity: Array.isArray(record.activity) ? record.activity : [],
  };
}

// Columns we read from public.lead_activities (no invented columns).
const ACTIVITY_COLUMNS = "id, lead_id, activity_type, staff_member, occurred_at, notes, outcome, created_at";

// Maps a lead_activities database row to the shape the activity timeline renders.
function mapActivityRecord(record) {
  return {
    id: record.id, // React key
    type: record.activity_type || "Note", // displayed activity type
    staff: record.staff_member || "", // displayed staff member
    at: record.occurred_at, // activity date and time
    text: record.notes || "", // displayed notes
    outcome: record.outcome || "", // displayed outcome
    source: "database",
  };
}

// System-generated history events are stored in lead_activities (the same table as staff-logged activities)
// using these activity_type values. The modal maps the old local entry types to them.
const SYSTEM_EVENT_TYPES = {
  created: "Lead created",
  status: "Status change",
  followup: "Follow-up",
  update: "Lead update",
};

function newId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    return (char === "x" ? random : (random & 0x3) | 0x8).toString(16);
  });
}

// Converts a value from the UI into what the leads table stores.
function toDbValue(key, value) {
  if (key === "next_follow_up_at") return value ? parseDate(value)?.toISOString() || null : null;
  if (["assigned_staff", "not_converted_reason", "notes"].includes(key)) return value ? value : null;
  return value;
}

// True when the lead's current value already equals the new UI value (so there is nothing to send).
function sameLeadValue(key, current, next) {
  if (key === "next_follow_up_at") {
    const a = current ? parseDate(current) : null;
    const b = next ? parseDate(next) : null;
    return (a ? a.getTime() : null) === (b ? b.getTime() : null);
  }
  return (current || "") === (next || "");
}

// Turns a Supabase error into a short message for staff. Full details go to the console.
function describeSaveError(error) {
  const code = error && error.code;
  if (code === "PGRST116") {
    return "Supabase did not update this lead. It may have been deleted, or you may not have permission to edit it.";
  }
  if (code === "42501") {
    return "You do not have permission to save this change. Please ask your administrator to check access.";
  }
  if (code === "PGRST204" || code === "42703") {
    return "The leads table is missing a column this change needs. Please ask your administrator to check the database.";
  }
  return "Could not save your changes. Nothing was lost on screen, so please try again.";
}

const navigation = [
  { name: "Dashboard", icon: "dashboard" },
  { name: "Leads", icon: "users" },
  { name: "Follow Ups", icon: "clock" },
  { name: "Appointments", icon: "calendar" },
  { name: "Counsellors", icon: "heart" },
  { name: "Reports", icon: "chart" },
];

/* ------------------------------------------------------------------ */
/* Small presentational components                                     */
/* ------------------------------------------------------------------ */

function ProgressRing({ value = 0, label = "Engaged" }) {
  const radius = 53;
  const circumference = 2 * Math.PI * radius;
  const progress = (Math.min(Math.max(value, 0), 100) / 100) * circumference;

  return (
    <div className="ring-container">
      <svg viewBox="0 0 140 140" className="progress-ring" role="img" aria-label={`${value}% ${label}`}>
        <circle cx="70" cy="70" r={radius} fill="none" stroke="#E9DFD0" strokeWidth="9" />
        <circle
          cx="70"
          cy="70"
          r={radius}
          fill="none"
          stroke="#B96A08"
          strokeWidth="9"
          strokeLinecap="round"
          strokeDasharray={`${progress} ${circumference}`}
          transform="rotate(-90 70 70)"
          style={{ transition: "stroke-dasharray 400ms ease" }}
        />
        <text x="70" y="68" textAnchor="middle" className="ring-value">
          {value}%
        </text>
        <text x="70" y="86" textAnchor="middle" className="ring-subtitle">
          {label}
        </text>
      </svg>
    </div>
  );
}

function LeadTrendChart({ data }) {
  const peak = Math.max(...data.map((item) => item.count), 0);
  const max = Math.max(4, Math.ceil(peak / 4) * 4);
  const points = data.map((item, index) => ({
    x: (index / (data.length - 1)) * 500,
    y: 140 - (item.count / max) * 120,
  }));
  const line = points
    .map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`)
    .join(" ");
  const yLabels = [max, (max * 3) / 4, max / 2, max / 4, 0];

  return (
    <div className="chart-container">
      <div className="chart-y-axis" aria-hidden="true">
        {yLabels.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="chart-main">
        <svg
          viewBox="0 0 500 160"
          preserveAspectRatio="none"
          className="trend-chart"
          role="img"
          aria-label="New leads added per month over the last six months"
        >
          {[20, 50, 80, 110, 140].map((y) => (
            <line key={y} x1="0" y1={y} x2="500" y2={y} className="chart-grid" />
          ))}

          <path d={`${line} L500 160 L0 160 Z`} fill="#D99536" fillOpacity=".14" />

          <path
            d={line}
            fill="none"
            stroke="#B96A08"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>

        <div className="chart-months">
          {data.map((item) => (
            <span key={item.key}>{item.label}</span>
          ))}
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ eyebrow, title, action, onAction }) {
  return (
    <div className="section-heading">
      <div className="section-heading-copy">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
      </div>

      {action && (
        <button className="text-button" onClick={onAction}>
          {action}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function DashboardPage() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [leads, setLeads] = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const [noticeTone, setNoticeTone] = useState("success");
  const [activityRevisions, setActivityRevisions] = useState({});
  // Which tab the lead drawer opens on, and which leads have a follow up action saving right now.
  const [selectedLeadTab, setSelectedLeadTab] = useState("overview");
  const [followUpBusyIds, setFollowUpBusyIds] = useState([]);
  const followUpBusyRef = useRef(new Set());
  const [createLeadError, setCreateLeadError] = useState("");
  // Column names seen on the leads table, so we only write columns that really exist.
  const leadColumnsRef = useRef(null);
  // Lead ids with an update in flight, to block double clicks.
  const busyLeadIdsRef = useRef(new Set());
  // The clock is set after mount so server and browser markup always match.
  const [now, setNow] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadLeads() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("leads")
          .select("*")
          .order("created_at", { ascending: false });

        if (error) throw error;
        if (!Array.isArray(data)) throw new Error("Supabase returned an invalid leads response.");

        if (!cancelled) {
          if (data.length > 0) leadColumnsRef.current = new Set(Object.keys(data[0]));
          setLeads(data.map(mapLeadRecord));
          setLeadsError("");
        }
      } catch (error) {
        console.error("Failed to load leads from Supabase:", error);
        if (!cancelled) {
          setLeadsError("Could not load leads from Supabase. Please check your connection.");
        }
      } finally {
        if (!cancelled) setLeadsLoading(false);
      }
    }

    loadLeads();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setNow(new Date());
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(() => setNotice(""), 3200);
    return () => clearTimeout(timer);
  }, [notice]);

  const selectedLead = leads.find((lead) => lead.id === selectedLeadId) || null;


  /* ----- derived data ----- */

  const totalLeads = leads.length;
  const statusCounts = useMemo(() => {
    const counts = {};
    STATUSES.forEach((status) => {
      counts[status] = leads.filter((lead) => lead.status === status).length;
    });
    return counts;
  }, [leads]);

  const newCount = statusCounts.New;
  const contactedCount = statusCounts.Contacted;
  const followUpCount = statusCounts["Follow Up"];
  const convertedCount = statusCounts.Converted;
  const lostCount = statusCounts.Lost;
  const activeCount = totalLeads - convertedCount - lostCount;
  const engagedPercent = totalLeads
    ? Math.round(((contactedCount + followUpCount + convertedCount) / totalLeads) * 100)
    : 0;
  const staffCount = new Set(
    leads.map((lead) => (lead.assigned_staff || "").trim()).filter(Boolean)
  ).size;

  const staffOptions = useMemo(
    () =>
      [...new Set(leads.map((lead) => (lead.assigned_staff || "").trim()).filter(Boolean))].sort(),
    [leads]
  );

  const followUps = useMemo(() => {
    const groups = { overdue: [], today: [], upcoming: [], unscheduled: [] };

    leads.forEach((lead) => {
      if (CLOSED_STATUSES.includes(lead.status)) return;
      const state = getFollowUpState(lead, now);
      if (state) groups[state].push(lead);
      else if (!lead.next_follow_up_at) groups.unscheduled.push(lead);
    });

    const byDate = (a, b) => new Date(a.next_follow_up_at) - new Date(b.next_follow_up_at);
    groups.overdue.sort(byDate);
    groups.today.sort(byDate);
    groups.upcoming.sort(byDate);
    return groups;
  }, [leads, now]);

  const attentionCount = followUps.overdue.length + followUps.today.length;
  const openFollowUpCount = attentionCount + followUps.upcoming.length;

  const dashboardFollowUps =
    attentionCount > 0
      ? [...followUps.overdue, ...followUps.today].slice(0, 4)
      : followUps.upcoming.slice(0, 4);

  const trend = useMemo(() => {
    const base = now || new Date("2026-10-17T00:00:00");
    const months = [];

    for (let offset = 5; offset >= 0; offset -= 1) {
      const date = new Date(base.getFullYear(), base.getMonth() - offset, 1);
      months.push({
        key: `${date.getFullYear()}-${date.getMonth()}`,
        label: date.toLocaleDateString("en-GB", { month: "short" }),
        count: 0,
      });
    }

    leads.forEach((lead) => {
      const created = parseDate(lead.created_at);
      if (!created) return;
      const month = months.find((item) => item.key === `${created.getFullYear()}-${created.getMonth()}`);
      if (month) month.count += 1;
    });

    return months;
  }, [leads, now]);

const filteredLeads = useMemo(() => {
  const term = search.trim().toLowerCase();
  const normalizedTerm = term.replace(/\s+/g, "");

  return leads
    .filter((lead) => {
      const normalizedPhone = (lead.phone || "")
        .replace(/\s+/g, "")
        .toLowerCase();

      const matchesSearch =
        !term ||
        [
          lead.full_name,
          lead.email,
          lead.lead_code,
          lead.source,
          lead.assigned_staff,
          lead.service_interest,
        ].some((field) =>
          (field || "").toLowerCase().includes(term)
        ) ||
        normalizedPhone.includes(normalizedTerm);

      const matchesStatus =
        statusFilter === "All" || lead.status === statusFilter;

      return matchesSearch && matchesStatus;
    })
    .sort(
      (a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
    );
}, [leads, search, statusFilter]);

  /* ----- actions ----- */

  function navigateTo(page) {
    setActivePage(page);
    setMobileMenuOpen(false);
    setSelectedLeadId(null);
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  function openPage(page) {
    if (page === "Leads") {
      setStatusFilter("All");
      setSearch("");
    }
    navigateTo(page);
  }

  function goToLeads(status) {
    setStatusFilter(status);
    setSearch("");
    navigateTo("Leads");
  }

  // Shows the toast. Failures use the "error" tone.
  function flash(message, tone = "success") {
    setNoticeTone(tone);
    setNotice(message);
  }

  // Writes history events ({ type, text }) to lead_activities in one insert. Resolves to true only if Supabase confirmed it.
  async function saveLeadEvents(leadId, entries) {
    if (!entries || entries.length === 0) return true;

    try {
      const supabase = createClient();
      const base = Date.now();
      const rows = entries.map((entry, index) => {
        // One millisecond apart so events from the same save keep a stable order.
        const stamp = new Date(base + index).toISOString();
        return {
          id: newId(),
          lead_id: leadId,
          activity_type: SYSTEM_EVENT_TYPES[entry.type] || SYSTEM_EVENT_TYPES.update,
          staff_member: null,
          occurred_at: stamp,
          notes: entry.text || null,
          outcome: null,
          created_at: stamp,
        };
      });

      const { error } = await supabase.from("lead_activities").insert(rows);
      if (error) throw error;

      // Tells an open lead drawer to reload its history.
      setActivityRevisions((current) => ({ ...current, [leadId]: (current[leadId] || 0) + 1 }));
      return true;
    } catch (error) {
      console.error("Failed to save history entries to lead_activities:", error);
      return false;
    }
  }

  // Saves lead changes to Supabase, then records history events. The screen only changes after the
  // leads row is confirmed. Resolves to { ok, message, eventsSaved }.
  async function persistLeadUpdate(lead, changes, entries = []) {
    if (busyLeadIdsRef.current.has(lead.id)) {
      return { ok: false, message: "Another update to this lead is still saving. Please wait a moment." };
    }
    busyLeadIdsRef.current.add(lead.id);

    try {
      const columns = leadColumnsRef.current;
      const payload = {};

      for (const [key, value] of Object.entries(changes)) {
        if (sameLeadValue(key, lead[key], value)) continue;
        const dbValue = toDbValue(key, value);
        if (columns && !columns.has(key)) {
          if (dbValue === null || dbValue === "") continue; // clearing a column that does not exist is a no-op
          console.error(`The leads table has no "${key}" column, so this change cannot be saved.`);
          return { ok: false, message: "The leads table is missing a column this change needs. Please ask your administrator to check the database." };
        }
        payload[key] = dbValue;
      }

      // Only touch updated_at if the column exists; the database may also maintain it itself.
      if (Object.keys(payload).length > 0 && columns && columns.has("updated_at")) {
        payload.updated_at = new Date().toISOString();
      }

      if (Object.keys(payload).length > 0) {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("leads")
          .update(payload)
          .eq("id", lead.id)
          .select("*")
          .single();

        if (error) {
          console.error("Failed to update lead in Supabase:", error);
          return { ok: false, message: describeSaveError(error) };
        }
        if (!data) return { ok: false, message: "Supabase returned no updated lead. Please try again." };

        const saved = mapLeadRecord({
          ...data,
          activity: Array.isArray(data.activity) ? data.activity : lead.activity,
        });
        setLeads((current) => current.map((item) => (item.id === lead.id ? saved : item)));
      }

      const eventsSaved = await saveLeadEvents(lead.id, entries);
      return { ok: true, eventsSaved };
    } catch (error) {
      console.error("Unexpected error while saving lead:", error);
      return { ok: false, message: describeSaveError(error) };
    } finally {
      busyLeadIdsRef.current.delete(lead.id);
    }
  }

  function openAddForm() {
    setSelectedLeadId(null);
    setCreateLeadError("");
    setShowForm(true);
  }

  function openLead(lead, tab = "overview") {
    setShowForm(false);
    setSelectedLeadTab(tab);
    setSelectedLeadId(lead.id);
  }

  function closeDialogs() {
    setShowForm(false);
    setSelectedLeadId(null);
  }

  async function handleCreateLead(values, { addAnother = false } = {}) {
    setCreateLeadError("");

    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("leads")
        .insert({
          full_name: values.full_name,
          phone: values.phone,
          email: values.email || null,
          source: values.source,
          service_interest: values.service_interest,
          notes: values.notes || null,
          assigned_staff: values.assigned_staff || null,
          next_follow_up_at: values.next_follow_up_at
            ? parseDate(values.next_follow_up_at)?.toISOString() || null
            : null,
          status: "New",
        })
        .select("*")
        .single();

      if (error) throw error;
      if (!data) throw new Error("Supabase returned no saved lead.");

      const lead = mapLeadRecord(data);
      setLeads((current) => [lead, ...current]);

      // The lead itself is saved. Record its starting history in lead_activities.
      const events = [{ type: "created", text: `Lead created from ${values.source}` }];
      if (values.next_follow_up_at) {
        events.push({
          type: "followup",
          text: `Follow up scheduled for ${formatDateTime(values.next_follow_up_at)}`,
        });
      }
      const eventsSaved = await saveLeadEvents(lead.id, events);

      if (eventsSaved) flash(`${lead.full_name} added as ${lead.lead_code}`);
      else flash(`${lead.full_name} was saved, but its history entry could not be recorded.`, "error");

      if (!addAnother) {
        setShowForm(false);
        setStatusFilter("All");
        setSearch("");
        navigateTo("Leads");
      }
      return true;
    } catch (error) {
      console.error("Failed to create lead in Supabase:", error);
      const detail = error instanceof Error ? error.message : "Unexpected error.";
      setCreateLeadError(`Could not save this lead. ${detail}`);
      return false;
    }
  }

  // Called by the lead drawer. Resolves to { ok, message } so the drawer can keep the form open on failure.
  async function handleSaveLead(id, changes, entries) {
    const lead = leads.find((item) => item.id === id);
    if (!lead) return { ok: false, message: "This lead is no longer in the list. Please refresh the page." };

    const result = await persistLeadUpdate(lead, changes, entries);
    if (!result.ok) return result;

    const outcome =
      changes.status === "Converted" && lead.status !== "Converted"
        ? "converted"
        : changes.status === "Lost" && lead.status !== "Lost"
          ? "marked as lost"
          : "updated";

    if (result.eventsSaved) flash(`${lead.full_name} ${outcome}`);
    else flash(`${lead.full_name} was ${outcome}, but the history entry could not be recorded.`, "error");
    return result;
  }

  function handleDeleteLead(id) {
    const lead = leads.find((item) => item.id === id);
    setLeads((current) => current.filter((item) => item.id !== id));
    flash(`${lead ? lead.full_name : "Lead"} deleted from this screen only. It is not removed from Supabase yet.`, "error");
    closeDialogs();
  }

  async function completeFollowUp(lead) {
    const nextStatus = ["New", "Follow Up"].includes(lead.status) ? "Contacted" : lead.status;
    const entries = [{ type: "followup", text: "Follow up marked as done" }];

    if (nextStatus !== lead.status) {
      entries.push({ type: "status", text: `Status changed from ${lead.status} to ${nextStatus}` });
    }

    const result = await persistLeadUpdate(lead, { status: nextStatus, next_follow_up_at: "" }, entries);
    if (!result.ok) {
      flash(result.message, "error");
      return;
    }
    if (result.eventsSaved) flash(`Follow up with ${lead.full_name} marked as done`);
    else flash(`Follow up with ${lead.full_name} saved, but the history entry could not be recorded.`, "error");
  }

  // Runs "Done" / "Tomorrow" for one lead at a time, so a double click cannot save twice.
  async function runFollowUpAction(lead, action) {
    if (followUpBusyRef.current.has(lead.id)) return;
    followUpBusyRef.current.add(lead.id);
    setFollowUpBusyIds((ids) => [...ids, lead.id]);
    try {
      await action(lead);
    } finally {
      followUpBusyRef.current.delete(lead.id);
      setFollowUpBusyIds((ids) => ids.filter((id) => id !== lead.id));
    }
  }

  async function snoozeFollowUp(lead) {
    const original = parseDate(lead.next_follow_up_at) || new Date();
    const target = new Date(now || new Date());
    target.setDate(target.getDate() + 1);
    target.setHours(original.getHours(), original.getMinutes(), 0, 0);

    const result = await persistLeadUpdate(lead, { next_follow_up_at: toInputValue(target) }, [
      { type: "followup", text: `Follow up moved to ${formatDateTime(toInputValue(target))}` },
    ]);
    if (!result.ok) {
      flash(result.message, "error");
      return;
    }
    if (result.eventsSaved) flash(`${lead.full_name} moved to tomorrow`);
    else flash(`${lead.full_name} moved, but the history entry could not be recorded.`, "error");
  }


  /* ----- lead_activities (Supabase) ----- */

  // Loads one lead's logged activities, newest first. Throws on failure so the modal can show an error state.
  async function loadLeadActivities(leadId) {
    const supabase = createClient();
    const { data, error } = await supabase
      .from("lead_activities")
      .select(ACTIVITY_COLUMNS)
      .eq("lead_id", leadId)
      .order("occurred_at", { ascending: false })
      .order("created_at", { ascending: false });

    if (error) {
      console.error("Failed to load lead activities from Supabase:", error);
      throw error;
    }
    if (!Array.isArray(data)) throw new Error("Supabase returned an invalid activities response.");
    return data.map(mapActivityRecord);
  }

  // Inserts one activity. Resolves to { ok: true, activity } only after Supabase confirms the row.
  // `values.id` is generated by the form so a retry after a failure reuses the same id.
  async function logLeadActivity(lead, values) {
    try {
      const occurredAt = parseDate(values.occurred_at);
      if (!occurredAt) return { ok: false, message: "Enter a valid date and time." };

      const supabase = createClient();
      const { data, error } = await supabase
        .from("lead_activities")
        .insert({
          // id and created_at are sent explicitly because their database defaults are unverified.
          id: values.id,
          lead_id: lead.id,
          activity_type: values.activity_type,
          staff_member: values.staff_member || null,
          occurred_at: occurredAt.toISOString(),
          notes: values.notes || null,
          outcome: values.outcome || null,
          created_at: new Date().toISOString(),
        })
        .select(ACTIVITY_COLUMNS)
        .single();

      if (error) throw error;
      if (!data) throw new Error("Supabase returned no saved activity.");

      flash(`${values.activity_type} logged for ${lead.full_name}`);
      return { ok: true, activity: mapActivityRecord(data) };
    } catch (error) {
      console.error("Failed to save lead activity to Supabase:", error);
      const code = error && error.code;
      let message = "Could not save this activity. Your entry is still here, so please try again.";
      if (code === "42501") {
        message = "You do not have permission to save activities. Please ask your administrator to check access.";
      } else if (code === "23503") {
        message = "This lead could not be found in the database, so the activity was not saved.";
      } else if (code === "23505") {
        message = "This activity may already have been saved. Reopen the Activity tab to check.";
      }
      return { ok: false, message };
    }
  }

  /* ----- shared renderers ----- */

  function renderFollowUpCell(lead) {
    const state = getFollowUpState(lead, now);

    if (!lead.next_follow_up_at || CLOSED_STATUSES.includes(lead.status)) {
      return <span className="muted-cell">—</span>;
    }

    // Overdue, due today and upcoming each get their own tint; the title tells the same story as text.
    const tone = state === "overdue" ? "due-overdue" : state === "today" ? "due-today" : "";

    return (
      <span className={`due-chip ${tone}`} title={dueLabel(lead, now)}>
        {formatShort(lead.next_follow_up_at)}
      </span>
    );
  }

  function renderLeadsTable(limit) {
    const rows = limit ? filteredLeads.slice(0, limit) : filteredLeads;
    const isFiltered = filteredLeads.length !== totalLeads;

    return (
      <>
        <div className="table-scroll">
          <table className="leads-table">
            <thead>
              <tr>
                <th>LEAD</th>
                <th>LEAD ID</th>
                <th>SOURCE</th>
                <th>ASSIGNED STAFF</th>
                <th>STATUS</th>
                <th>NEXT FOLLOW UP</th>
                <th>DATE ADDED</th>
                <th aria-label="Actions" />
              </tr>
            </thead>

            <tbody>
              {leadsLoading && (
                <tr>
                  <td colSpan={8} role="status">Loading leads from Supabase...</td>
                </tr>
              )}

              {!leadsLoading && leadsError && (
                <tr>
                  <td colSpan={8} role="alert">{leadsError}</td>
                </tr>
              )}

              {!leadsLoading && !leadsError && rows.map((lead) => (
                <tr key={lead.id} onClick={() => openLead(lead)}>
                  <td>
                    <div className="person-cell">
                      <div className="person-avatar">{lead.full_name.charAt(0).toUpperCase()}</div>
                      <div className="person-info">
                        <strong>{lead.full_name}</strong>
                        <span>{(lead.phone || "").replace(/\s+/g, "")}</span>
                      </div>
                    </div>
                  </td>
                  <td className="muted-cell">{lead.lead_code}</td>
                  <td>{lead.source}</td>
                  <td>{lead.assigned_staff || "Unassigned"}</td>
                  <td>
                    <StatusBadge status={lead.status} />
                  </td>
                  <td>{renderFollowUpCell(lead)}</td>
                  <td>{formatDate(lead.created_at)}</td>
                  <td>
                    <button
                      className="row-action"
                      onClick={(event) => {
                        event.stopPropagation();
                        openLead(lead);
                      }}
                      aria-label={`View details for ${lead.full_name}`}
                    >
                      ⋯
                    </button>
                  </td>
                </tr>
              ))}

              {!leadsLoading && !leadsError && rows.length === 0 && (
                <tr className="empty-row">
                  <td colSpan={8}>
                    <div className="empty-state">
                      <span className="empty-state-icon">
                        <Icon name="search" />
                      </span>
                      <strong>No leads found</strong>
                      <p>Try another search or change the status filter.</p>
                      <button
                        className="text-button"
                        onClick={() => {
                          setSearch("");
                          setStatusFilter("All");
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        <div className="table-footer">
          <span>
            Showing {rows.length} of {filteredLeads.length} leads
            {isFiltered ? ` · ${totalLeads} total` : ""}
          </span>
          {limit && (
            <button className="text-button" onClick={() => goToLeads(statusFilter)}>
              View all leads <span aria-hidden="true">→</span>
            </button>
          )}
        </div>
      </>
    );
  }

  function renderFollowUpGroup(title, items, tone) {
    if (items.length === 0) return null;

    return (
      <div className="fu-group" key={title}>
        <h3>
          {title} <span>{items.length}</span>
        </h3>

        <div className="fu-list">
          {items.map((lead) => (
            <div className="fu-row" key={lead.id}>
              <div className="fu-when">
                <span className={tone === "overdue" ? "due-text-overdue" : ""}>
                  {lead.next_follow_up_at ? formatTime(lead.next_follow_up_at) : "Not scheduled"}
                </span>
                {lead.next_follow_up_at && <small>{dueLabel(lead, now)}</small>}
              </div>

              <div className="fu-main">
                <strong>{lead.full_name}</strong>
                <span>
                  {lead.source} · {lead.assigned_staff || "Unassigned"}
                </span>
              </div>

              <StatusBadge status={lead.status} />

              <div className="fu-actions">
                {lead.next_follow_up_at ? (
                  <>
                    <button
                      className="mini-button primary"
                      disabled={followUpBusyIds.includes(lead.id)}
                      onClick={() => runFollowUpAction(lead, completeFollowUp)}
                    >
                      <Icon name="check" /> Done
                    </button>
                    <button
                      className="mini-button"
                      disabled={followUpBusyIds.includes(lead.id)}
                      onClick={() => runFollowUpAction(lead, snoozeFollowUp)}
                    >
                      Tomorrow
                    </button>
                  </>
                ) : null}
                <button className="mini-button" onClick={() => openLead(lead, lead.next_follow_up_at ? "overview" : "edit")}>
                  {lead.next_follow_up_at ? "Open" : "Schedule"}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  const dateLabel = now
    ? now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })
    : "";

  /* ----- render ----- */

  return (
    <main className="crm-shell">
      {mobileMenuOpen && (
        <button
          className="mobile-overlay"
          onClick={() => setMobileMenuOpen(false)}
          aria-label="Close navigation"
        />
      )}

      <aside className={`sidebar ${mobileMenuOpen ? "sidebar-open" : ""}`}>
        <div className="brand">
          <div className="brand-logo">
            <Image
              src="/kappiness_logo_sq.jpeg"
              alt="Kappiness — Nourishing Minds, Pouring Happiness"
              width={180}
              height={100}
              priority
              className="brand-logo-image"
            />
          </div>

          <button className="mobile-close" onClick={() => setMobileMenuOpen(false)} aria-label="Close menu">
            <Icon name="close" />
          </button>
        </div>

        <div className="workspace-label">WORKSPACE</div>

        <nav className="main-nav" aria-label="Main navigation">
          {navigation.map((item) => (
            <button
              key={item.name}
              className={`nav-item ${activePage === item.name ? "active" : ""}`}
              onClick={() => openPage(item.name)}
              aria-current={activePage === item.name ? "page" : undefined}
            >
              <span className="ui-icon" aria-hidden="true">
                <Icon name={item.icon} />
              </span>
              <span className="nav-label">{item.name}</span>

              {item.name === "Follow Ups" && openFollowUpCount > 0 && (
                <span className="nav-count">{openFollowUpCount}</span>
              )}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon">
              <Icon name="info" />
            </span>
            <div>
              <strong>Need assistance?</strong>
              <span>Workspace guide</span>
            </div>
            <span className="help-arrow">
              <Icon name="arrowUpRight" />
            </span>
          </div>

          <div className="profile">
            <div className="profile-avatar">A</div>
            <div className="profile-copy">
              <strong>CRM Admin</strong>
              <span>Administrator</span>
            </div>
            <span className="profile-chevron">
              <Icon name="chevronDown" />
            </span>
          </div>
        </div>
      </aside>

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button
              className="mobile-menu-button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="Open navigation"
            >
              <Icon name="menu" />
            </button>
            <span>Workspace</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{activePage}</strong>
          </div>

          <div className="topbar-actions">
            <span className="today-label">{dateLabel}</span>
            <button className="top-icon" aria-label="Appointments" onClick={() => navigateTo("Appointments")}>
              <Icon name="calendar" />
            </button>
            <button
              className="top-icon notification-button"
              aria-label={
                attentionCount > 0
                  ? `${attentionCount} follow ups need attention`
                  : "No follow ups need attention"
              }
              onClick={() => navigateTo("Follow Ups")}
            >
              <Icon name="bell" />
              {attentionCount > 0 && <span className="notification-dot" />}
            </button>
          </div>
        </header>

        {activePage === "Dashboard" && (
          <>
            <section className="hero-panel">
              <div className="hero-content">
                <span className="eyebrow">YOUR WORKSPACE AT A GLANCE</span>
                <h1>
                  {getGreeting(now)}, <span>Team Kappiness</span>
                </h1>
                <p>
                  {attentionCount > 0
                    ? `${attentionCount} follow up${attentionCount > 1 ? "s need" : " needs"} your attention today.`
                    : "Here is what is happening with your leads today."}
                </p>

                <div className="hero-stats">
                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="users" />
                    </span>
                    <div>
                      <strong>{totalLeads}</strong>
                      <span>Total Leads</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="sparkle" />
                    </span>
                    <div>
                      <strong>{newCount}</strong>
                      <span>New Leads</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="clock" />
                    </span>
                    <div>
                      <strong>{followUpCount}</strong>
                      <span>Follow Ups</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="check" />
                    </span>
                    <div>
                      <strong>{convertedCount}</strong>
                      <span>Converted</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hero-progress">
                <span className="progress-title">LEAD ENGAGEMENT</span>
                <ProgressRing value={engagedPercent} label="Engaged" />
                <p>Share of leads that have been contacted or converted.</p>
              </div>
            </section>

            <section className="dashboard-grid">
              <article className="surface schedule-card">
                <SectionHeading
                  eyebrow="STAY CONNECTED"
                  title={attentionCount > 0 ? "Today's follow ups" : "Upcoming follow ups"}
                  action="View all →"
                  onAction={() => navigateTo("Follow Ups")}
                />

                <div className="schedule-date">
                  <span>{now ? now.toLocaleDateString("en-GB", { weekday: "short" }).toUpperCase() : "—"}</span>
                  <strong>{now ? now.getDate() : "—"}</strong>
                  <small>
                    {now ? now.toLocaleDateString("en-GB", { month: "short" }).toUpperCase() : ""}
                  </small>
                </div>

                <div className="follow-list">
                  {dashboardFollowUps.map((lead, index) => (
                    <div className="follow-item" key={lead.id}>
                      <span className={`timeline-dot timeline-dot-${index % 3}`} />

                      <span className="follow-time">{formatTime(lead.next_follow_up_at)}</span>

                      <div className="follow-details">
                        <strong>{lead.full_name}</strong>
                        <span>
                          {dueLabel(lead, now)} · {lead.source}
                        </span>
                        <small>{lead.assigned_staff || "Unassigned"}</small>
                      </div>

                      <button
                        className="round-arrow"
                        onClick={() => openLead(lead)}
                        aria-label={`Open follow up for ${lead.full_name}`}
                      >
                        <Icon name="arrowUpRight" />
                      </button>
                    </div>
                  ))}

                  {dashboardFollowUps.length === 0 && (
                    <p className="subtle-text card-empty">No follow ups scheduled. You are all caught up.</p>
                  )}
                </div>

                <button className="schedule-add" onClick={() => navigateTo("Follow Ups")}>
                  + View follow up schedule
                </button>
              </article>

              <article className="surface performance-card">
                <SectionHeading
                  eyebrow="LEAD ACTIVITY"
                  title="Lead overview"
                  action="Reports →"
                  onAction={() => navigateTo("Reports")}
                />

                <div className="performance-number">
                  <strong>{totalLeads}</strong>
                  <span className="trend-pill">{activeCount} active</span>
                </div>

                <p className="subtle-text">New leads added over the past six months</p>

                <LeadTrendChart data={trend} />

                <div className="chart-legend">
                  <span />
                  <span>New leads per month</span>
                </div>
              </article>

              <article className="surface status-card">
                <SectionHeading
                  eyebrow="PIPELINE"
                  title="Lead status"
                  action="View →"
                  onAction={() => goToLeads("All")}
                />

                <div className="pipeline-total">
                  <strong>{totalLeads}</strong>
                  <span>Total records</span>
                </div>

                <div className="status-bars">
                  {[
                    { name: "New", count: newCount, color: "bar-amber" },
                    { name: "Contacted", count: contactedCount, color: "bar-brown" },
                    { name: "Follow Up", count: followUpCount, color: "bar-beige" },
                    { name: "Converted", count: convertedCount, color: "bar-muted" },
                    { name: "Lost", count: lostCount, color: "bar-lost" },
                  ].map((item) => (
                    <button
                      key={item.name}
                      className="status-bar-item"
                      onClick={() => goToLeads(item.name)}
                      aria-label={`View ${item.count} ${item.name} leads`}
                    >
                      <div className="status-bar-track">
                        <div
                          className={`status-bar-fill ${item.color}`}
                          style={{
                            width: `${item.count === 0 ? 0 : Math.max(6, (item.count / Math.max(totalLeads, 1)) * 100)}%`,
                          }}
                        />
                      </div>
                      <strong>{item.count}</strong>
                      <span>{item.name}</span>
                    </button>
                  ))}
                </div>
              </article>
            </section>

            <section className="quick-stats">
              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="clock" />
                  </span>
                  <span className="quick-stat-tag">{attentionCount > 0 ? "NEEDS ACTION" : "TODAY"}</span>
                </div>
                <span className="quick-stat-label">Follow ups due</span>
                <strong>{attentionCount}</strong>
                <button onClick={() => navigateTo("Follow Ups")}>Review schedule ↗</button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="calendar" />
                  </span>
                  <span className="quick-stat-tag">UPCOMING</span>
                </div>
                <span className="quick-stat-label">Appointments</span>
                <strong>—</strong>
                <button onClick={() => navigateTo("Appointments")}>View appointments ↗</button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="heart" />
                  </span>
                  <span className="quick-stat-tag">TEAM</span>
                </div>
                <span className="quick-stat-label">Assigned counsellors</span>
                <strong>{staffCount}</strong>
                <button onClick={() => navigateTo("Counsellors")}>View team ↗</button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="check" />
                  </span>
                  <span className="quick-stat-tag">COMPLETED</span>
                </div>
                <span className="quick-stat-label">Converted leads</span>
                <strong>{convertedCount}</strong>
                <button onClick={() => goToLeads("Converted")}>View converted ↗</button>
              </article>
            </section>

            <section className="surface leads-section">
              <div className="leads-section-heading">
                <div>
                  <span className="eyebrow">YOUR LATEST RECORDS</span>
                  <h2>Recent leads</h2>
                  <p>Keep track of every new conversation.</p>
                </div>

                <button className="primary-button" onClick={openAddForm}>
                  <Icon name="plus" /> Add lead
                </button>
              </div>

              <div className="table-toolbar">
                <div className="table-tabs">
                  {[
                    { label: "All leads", value: "All", count: totalLeads },
                    { label: "New", value: "New", count: newCount },
                    { label: "Follow ups", value: "Follow Up", count: followUpCount },
                  ].map((tab) => (
                    <button
                      key={tab.value}
                      className={`table-tab ${statusFilter === tab.value ? "active" : ""}`}
                      onClick={() => setStatusFilter(tab.value)}
                    >
                      {tab.label}
                      <span>{tab.count}</span>
                    </button>
                  ))}
                </div>

                <div className="table-controls">
                  <label className="search-box">
                    <span aria-hidden="true">
                      <Icon name="search" />
                    </span>
                    <input
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="Search leads..."
                      aria-label="Search leads"
                    />
                  </label>

                  <select
                    className="filter-select"
                    value={statusFilter}
                    onChange={(event) => setStatusFilter(event.target.value)}
                    aria-label="Filter by lead status"
                  >
                    {["All", ...STATUSES].map((status) => (
                      <option key={status} value={status}>
                        {status === "All" ? "All statuses" : status}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              {renderLeadsTable(5)}
            </section>
          </>
        )}

        {activePage === "Leads" && (
          <section className="surface page-section">
            <div className="leads-section-heading">
              <div>
                <span className="eyebrow">RELATIONSHIP MANAGEMENT</span>
                <h2>Leads</h2>
                <p>Manage and track your enquiries in one place.</p>
              </div>
              <button className="primary-button" onClick={openAddForm}>
                <Icon name="plus" /> Add lead
              </button>
            </div>

            <div className="table-toolbar">
              <div className="table-tabs">
                {["All", ...STATUSES].map((status) => (
                  <button
                    key={status}
                    className={`table-tab ${statusFilter === status ? "active" : ""}`}
                    onClick={() => setStatusFilter(status)}
                  >
                    {status === "All" ? "All leads" : status}
                    <span>{status === "All" ? totalLeads : statusCounts[status]}</span>
                  </button>
                ))}
              </div>

              <label className="search-box page-search">
                <span aria-hidden="true">
                  <Icon name="search" />
                </span>
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search leads..."
                  aria-label="Search leads"
                />
              </label>
            </div>

            {renderLeadsTable()}
          </section>
        )}

        {activePage === "Follow Ups" && (
          <section className="surface page-section">
            <div className="leads-section-heading">
              <div>
                <span className="eyebrow">STAY CONNECTED</span>
                <h2>Follow ups</h2>
                <p>Every scheduled conversation, in the order it needs attention.</p>
              </div>
              <button className="primary-button" onClick={openAddForm}>
                <Icon name="plus" /> Add lead
              </button>
            </div>

            <div className="fu-summary">
              <div className="fu-summary-card">
                <strong className={followUps.overdue.length > 0 ? "due-text-overdue" : ""}>
                  {followUps.overdue.length}
                </strong>
                <span>Overdue</span>
              </div>
              <div className="fu-summary-card">
                <strong>{followUps.today.length}</strong>
                <span>Due today</span>
              </div>
              <div className="fu-summary-card">
                <strong>{followUps.upcoming.length}</strong>
                <span>Upcoming</span>
              </div>
              <div className="fu-summary-card">
                <strong>{followUps.unscheduled.length}</strong>
                <span>Not scheduled</span>
              </div>
            </div>

            {renderFollowUpGroup("Overdue", followUps.overdue, "overdue")}
            {renderFollowUpGroup("Due today", followUps.today, "today")}
            {renderFollowUpGroup("Upcoming", followUps.upcoming, "upcoming")}
            {renderFollowUpGroup("Needs a follow up date", followUps.unscheduled, "none")}

            {openFollowUpCount === 0 && followUps.unscheduled.length === 0 && (
              <div className="empty-state">
                <span className="empty-state-icon">
                  <Icon name="check" />
                </span>
                <strong>You are all caught up</strong>
                <p>No follow ups are scheduled right now.</p>
              </div>
            )}
          </section>
        )}

        {["Appointments", "Counsellors", "Reports"].includes(activePage) && (
          <section className="surface placeholder-page">
            <div className="placeholder-icon">
              <Icon name={navigation.find((item) => item.name === activePage)?.icon || "settings"} />
            </div>
            <span className="eyebrow">KAPPINESS CRM</span>
            <h2>{activePage}</h2>
            <p>This section is ready for the next implementation step.</p>

            <button className="secondary-button" onClick={() => navigateTo("Dashboard")}>
              <Icon name="arrowLeft" /> Back to dashboard
            </button>
          </section>
        )}

        <footer className="app-footer">
          <span>© 2026 Kappiness CRM</span>
          <span>Nourishing Minds, Pouring Happiness.</span>
        </footer>
      </section>

      {showForm && (
        <AddLeadModal
          leads={leads}
          staffOptions={staffOptions}
          onClose={() => setShowForm(false)}
          onCreate={handleCreateLead}
          createError={createLeadError}
        />
      )}

      {selectedLead && (
        <LeadDetailsModal
          key={selectedLead.id}
          lead={selectedLead}
          now={now}
          staffOptions={staffOptions}
          onClose={() => setSelectedLeadId(null)}
          onSave={handleSaveLead}
          onLoadActivities={loadLeadActivities}
          onLogActivity={logLeadActivity}
          activityRevision={activityRevisions[selectedLead.id] || 0}
          initialTab={selectedLeadTab}
          followUpBusy={followUpBusyIds.includes(selectedLead.id)}
          onDelete={handleDeleteLead}
          onCompleteFollowUp={(item) => runFollowUpAction(item, completeFollowUp)}
          onSnoozeFollowUp={(item) => runFollowUpAction(item, snoozeFollowUp)}
        />
      )}


      {notice && (
        <div
          className="toast"
          role={noticeTone === "error" ? "alert" : "status"}
          aria-live="polite"
          style={noticeTone === "error" ? { background: "#8c3b2d" } : undefined}
        >
          <Icon name={noticeTone === "error" ? "info" : "check"} /> {notice}
        </div>
      )}
    </main>
  );
}