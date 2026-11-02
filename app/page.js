"use client";

import Image from "next/image";
import "./globals.css";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import AddLeadModal from "./components/AddLeadModal";
import Icon from "./components/Icon";
import LeadDetailsModal from "./components/LeadDetailsModal";
import ModalShell from "./components/ModalShell";
import StatusBadge from "./components/StatusBadge";
import { createClient } from "../utils/supabase/client";
import { canUpdateStatuses, getStaffName, getStaffRole } from "./lib/staff";
import {
  APPOINTMENT_STATUSES,
  PSYCHOLOGIST_CAN_SCHEDULE,
  createAppointment,
  describeAppointmentError,
  rescheduleAppointment,
  updateAppointmentStatus,
} from "./lib/appointmentsApi";
import { dayHasFreeSlot, periodsFor, slotsForDay } from "./lib/appointmentSlots";
import { formatClock as formatSlotTime, isSameDay, startOfDay } from "./lib/calendar";
import { getPsychologistByAuthUser, listAllAvailability, listPsychologists } from "./lib/psychologistsApi";
import BookingModal from "./components/BookingModal";
import MonthGrid from "./components/MonthGrid";
import AppointmentTable, { Avatar } from "./components/AppointmentTable";
import {
  CLOSED_STATUSES,
  DEFAULT_STATUS,
  STATUSES,
  UNCONFIRMED_STATUSES,
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
    contact_method: record.contact_method || "",
    assigned_staff: record.assigned_staff || "",
    status: record.status || DEFAULT_STATUS,
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
  if (["assigned_staff", "not_converted_reason", "notes", "contact_method"].includes(key)) return value ? value : null;
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
  { name: "Confirmed", icon: "check" },
  { name: "Psychologists", icon: "heart", href: "/psychologists" },
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
  const router = useRouter();
  const [activePage, setActivePage] = useState("Dashboard");
  const [leads, setLeads] = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [selectedLeadRecord, setSelectedLeadRecord] = useState(null);
  const [selectedLeadLoading, setSelectedLeadLoading] = useState(false);
  const [selectedLeadError, setSelectedLeadError] = useState("");
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
  const leadDetailRequestRef = useRef(0);
  // The clock is set after mount so server and browser markup always match.
  const [now, setNow] = useState(null);
  // Logged-in staff member, and the staff names saved on lead_activities rows.
  const [currentStaff, setCurrentStaff] = useState({ id: "", name: "", email: "", role: "" });
  const [psychologists, setPsychologists] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [ownPsychologist, setOwnPsychologist] = useState(null);
  const [bookingDialog, setBookingDialog] = useState(null); // { mode, lead?, appointment? }
  const [calAnchor, setCalAnchor] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const [calDay, setCalDay] = useState(null);
  const [calPsychologist, setCalPsychologist] = useState("all");
  const [notifications, setNotifications] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const [appointments, setAppointments] = useState([]);
  const appointmentsState = "ready"; // UI only: appointments are kept in memory for now
  const canEditStatuses = canUpdateStatuses(currentStaff.role);
  const [activityLog, setActivityLog] = useState([]);
  const [onlyMine, setOnlyMine] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function loadStaffAndActivity() {
      try {
        const supabase = createClient();
        const { data: userData } = await supabase.auth.getUser();
        if (!cancelled && userData && userData.user) {
          setCurrentStaff({
            id: userData.user.id,
            name: getStaffName(userData.user),
            email: userData.user.email || "",
            role: getStaffRole(userData.user),
          });
        }

        const { data, error } = await supabase
          .from("lead_activities")
          .select("lead_id, staff_member, occurred_at")
          .not("staff_member", "is", null)
          .order("occurred_at", { ascending: false })
          .limit(3000);
        if (!error && Array.isArray(data) && !cancelled) setActivityLog(data);
      } catch (error) {
        console.error("Failed to load staff or activity info:", error);
      }
    }

    loadStaffAndActivity();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadScheduling() {
      try {
        const [list, periods] = await Promise.all([listPsychologists(), listAllAvailability()]);
        if (cancelled) return;
        setPsychologists(list);
        setAvailability(periods);
      } catch (error) {
        console.error("Failed to load psychologists or availability:", error);
      }
    }

    loadScheduling();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (currentStaff.role !== "psychologist" || !currentStaff.id) return undefined;
    let cancelled = false;
    getPsychologistByAuthUser(currentStaff.id)
      .then((profile) => {
        if (!cancelled) setOwnPsychologist(profile);
      })
      .catch((error) => console.error("Failed to load own psychologist profile:", error));
    return () => {
      cancelled = true;
    };
  }, [currentStaff.role, currentStaff.id]);

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

  const selectedLead = selectedLeadRecord?.id === selectedLeadId ? selectedLeadRecord : null;


  /* ----- derived data ----- */

  const totalLeads = leads.length;
  const statusCounts = useMemo(() => {
    const counts = {};
    STATUSES.forEach((status) => {
      counts[status] = leads.filter((lead) => lead.status === status).length;
    });
    return counts;
  }, [leads]);

  const enquiryCount = statusCounts.Enquiry;
  const yetToConfirmCount = statusCounts["Yet to Confirm"];
  const willInformCount = statusCounts["Will Inform"];
  const confirmedCount = statusCounts.Confirmed;
  const activeCount = totalLeads - confirmedCount;
  // Share of leads that have moved past the first enquiry.
  const engagedPercent = totalLeads ? Math.round(((totalLeads - enquiryCount) / totalLeads) * 100) : 0;
  const staffCount = new Set(
    leads.map((lead) => (lead.assigned_staff || "").trim()).filter(Boolean)
  ).size;

  const staffOptions = useMemo(
    () =>
      [
        ...new Set(
          [...leads.map((lead) => (lead.assigned_staff || "").trim()), currentStaff.name.trim()].filter(Boolean)
        ),
      ].sort(),
    [leads, currentStaff.name]
  );

  const myName = currentStaff.name.trim().toLowerCase();

  // lead id -> name of the staff member who last logged something on it
  const lastUpdatedBy = useMemo(() => {
    const map = {};
    activityLog.forEach((row) => {
      if (row.staff_member && !map[row.lead_id]) map[row.lead_id] = row.staff_member;
    });
    return map;
  }, [activityLog]);

  // Leads that are assigned to me or that I have updated
  const myLeadIds = useMemo(() => {
    const ids = new Set();
    if (!myName) return ids;
    activityLog.forEach((row) => {
      if ((row.staff_member || "").trim().toLowerCase() === myName) ids.add(row.lead_id);
    });
    leads.forEach((lead) => {
      if ((lead.assigned_staff || "").trim().toLowerCase() === myName) ids.add(lead.id);
    });
    return ids;
  }, [activityLog, leads, myName]);

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

  const leadsById = useMemo(() => new Map(leads.map((lead) => [lead.id, lead])), [leads]);
  const appointmentsByLead = useMemo(() => {
    const map = {};
    appointments.forEach((item) => {
      (map[item.lead_id] = map[item.lead_id] || []).push(item);
    });
    return map;
  }, [appointments]);
  // Confirmed appointments (booked rows) and unconfirmed leads (no booking possible yet) are kept apart.
  const upcomingAppointments = appointments.filter((item) => item.status === "Scheduled");
  const pastAppointments = appointments.filter((item) => item.status !== "Scheduled");
  const unconfirmedLeads = leads.filter((lead) => UNCONFIRMED_STATUSES.includes(lead.status));
  const confirmedWithoutBooking = leads.filter(
    (lead) => lead.status === "Confirmed" && !(appointmentsByLead[lead.id] || []).some((item) => item.status === "Scheduled")
  );

  const psychologistNames = useMemo(() => {
    const map = {};
    psychologists.forEach((item) => {
      map[item.id] = item.name;
    });
    return map;
  }, [psychologists]);

  // Staff can schedule for any active psychologist. A psychologist can only schedule for themselves,
  // and only while PSYCHOLOGIST_CAN_SCHEDULE (the agreed permission) is on.
  const isPsychologistUser = currentStaff.role === "psychologist";
  const schedulablePsychologists = useMemo(() => {
    if (!isPsychologistUser) return psychologists.filter((item) => item.active);
    return PSYCHOLOGIST_CAN_SCHEDULE && ownPsychologist ? [ownPsychologist] : [];
  }, [isPsychologistUser, psychologists, ownPsychologist]);
  const canScheduleAppointments = schedulablePsychologists.length > 0;

  function canManageAppointment(item) {
    if (!isPsychologistUser) return true;
    return PSYCHOLOGIST_CAN_SCHEDULE && ownPsychologist && String(item.psychologist_id) === String(ownPsychologist.id);
  }

  // Reminders: booked appointments starting in the next 24 hours.
  const reminders = useMemo(() => {
    if (!now) return [];
    const limit = now.getTime() + 24 * 3600000;
    return appointments
      .filter((item) => item.status === "Scheduled")
      .filter((item) => {
        const start = new Date(item.starts_at).getTime();
        return start >= now.getTime() - 15 * 60000 && start <= limit;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }, [appointments, now]);

  const todayAppointments = now
    ? appointments.filter((item) => item.status === "Scheduled" && isSameDay(new Date(item.starts_at), now))
    : [];
  const weekAppointments = now
    ? appointments.filter((item) => {
        const start = new Date(item.starts_at).getTime();
        return item.status === "Scheduled" && start >= now.getTime() && start <= now.getTime() + 7 * 86400000;
      })
    : [];

  const unreadCount = notifications.filter((item) => !item.read).length;

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

      const matchesMine = !onlyMine || myLeadIds.has(lead.id);

      return matchesSearch && matchesStatus && matchesMine;
    })
    .sort(
      (a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
    );
}, [leads, search, statusFilter, onlyMine, myLeadIds]);

  /* ----- actions ----- */

  function navigateTo(page) {
    setActivePage(page);
    setMobileMenuOpen(false);
    closeLeadDetails();
    if (typeof window !== "undefined") window.scrollTo({ top: 0 });
  }

  function openPage(page) {
    const target = navigation.find((item) => item.name === page);
    if (target && target.href) {
      setMobileMenuOpen(false);
      router.push(target.href);
      return;
    }
    if (page === "Leads") {
      setOnlyMine(false);
      setStatusFilter("All");
      setSearch("");
    }
    navigateTo(page);
  }

  function goToLeads(status) {
    setOnlyMine(false);
    setStatusFilter(status);
    setSearch("");
    navigateTo("Leads");
  }

  // Shows the toast. Failures use the "error" tone.
  function flash(message, tone = "success") {
    setNoticeTone(tone);
    setNotice(message);
  }

  // In-app notification for staff (kept in memory until a backend channel exists).
  function pushNotification(text) {
    setNotifications((current) =>
      [{ id: newId(), text, at: new Date().toISOString(), read: false }, ...current].slice(0, 30)
    );
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
          staff_member: currentStaff.name || null,
          occurred_at: stamp,
          notes: entry.text || null,
          outcome: null,
          created_at: stamp,
        };
      });

      const { error } = await supabase.from("lead_activities").insert(rows);
      if (error) throw error;

      if (currentStaff.name) {
        setActivityLog((current) => [
          ...rows.map((row) => ({ lead_id: row.lead_id, staff_member: row.staff_member, occurred_at: row.occurred_at })),
          ...current,
        ]);
      }

      // Tells an open lead drawer to reload its history.
      setActivityRevisions((current) => ({ ...current, [leadId]: (current[leadId] || 0) + 1 }));
      return true;
    } catch (error) {
      console.error("Failed to save history entries to lead_activities:", error);
      return false;
    }
  }

  // Saves lead changes and their history atomically when both are present. Resolves to
  // { ok, message, eventsSaved }.
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

      if (entries.length > 0 && Object.keys(payload).length === 0) {
        return { ok: false, message: "No lead fields were saved, so the matching history entry was not recorded. Please refresh and try again." };
      }

      const hasAtomicHistory = Object.keys(payload).length > 0 && entries.length > 0;
      if (hasAtomicHistory) {
        const supabase = createClient();
        const { data, error } = await supabase.rpc("update_lead_with_history", {
          p_lead_id: lead.id,
          p_expected_status: lead.status,
          p_changes: payload,
          p_events: entries,
        });

        if (error) {
          console.error("Failed to update lead status and history atomically:", error);
          return {
            ok: false,
            message: error.code === "P0001"
              ? error.message
              : describeSaveError(error),
          };
        }
        if (!data?.ok || !data.lead) {
          return { ok: false, message: data?.message || "Supabase returned no updated lead. Please refresh and try again." };
        }

        const saved = mapLeadRecord({
          ...data.lead,
          activity: Array.isArray(data.lead.activity) ? data.lead.activity : lead.activity,
        });
        setLeads((current) => current.map((item) => (item.id === lead.id ? saved : item)));
        setSelectedLeadRecord((current) => (current?.id === lead.id ? saved : current));
        setActivityRevisions((current) => ({ ...current, [lead.id]: (current[lead.id] || 0) + 1 }));
        return { ok: true, eventsSaved: true };
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
        setSelectedLeadRecord((current) => (current?.id === lead.id ? saved : current));
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
    closeLeadDetails();
    setCreateLeadError("");
    setShowForm(true);
  }

  function openLead(lead, tab = "overview") {
    setShowForm(false);
    setSelectedLeadTab(tab);
    setSelectedLeadId(lead.id);
    setSelectedLeadRecord(null);
    setSelectedLeadLoading(true);
    setSelectedLeadError("");

    const requestId = ++leadDetailRequestRef.current;
    async function fetchLead() {
      try {
        const supabase = createClient();
        const { data, error } = await supabase
          .from("leads")
          .select("*")
          .eq("id", lead.id)
          .maybeSingle();

        if (requestId !== leadDetailRequestRef.current) return;
        if (error) throw error;
        if (!data) throw new Error("This lead could not be found. It may have been deleted.");

        const freshLead = mapLeadRecord(data);
        setLeads((current) => {
          const exists = current.some((item) => item.id === freshLead.id);
          return exists
            ? current.map((item) => (item.id === freshLead.id ? freshLead : item))
            : [freshLead, ...current];
        });
        setSelectedLeadRecord(freshLead);
      } catch (error) {
        console.error("Failed to fetch lead details from Supabase:", error);
        if (requestId === leadDetailRequestRef.current) {
          setSelectedLeadError(error instanceof Error ? error.message : "Could not load this lead from Supabase.");
        }
      } finally {
        if (requestId === leadDetailRequestRef.current) setSelectedLeadLoading(false);
      }
    }

    fetchLead();
  }

  function closeLeadDetails() {
    leadDetailRequestRef.current += 1;
    setSelectedLeadId(null);
    setSelectedLeadRecord(null);
    setSelectedLeadLoading(false);
    setSelectedLeadError("");
  }

  function closeDialogs() {
    setShowForm(false);
    closeLeadDetails();
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
          contact_method: values.contact_method,
          service_interest: values.service_interest,
          notes: values.notes || null,
          assigned_staff: values.assigned_staff || null,
          next_follow_up_at: values.next_follow_up_at
            ? parseDate(values.next_follow_up_at)?.toISOString() || null
            : null,
          status: DEFAULT_STATUS,
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

    if (changes.status && changes.status !== lead.status && !canEditStatuses) {
      return { ok: false, message: "You do not have permission to change lead statuses." };
    }

    const result = await persistLeadUpdate(lead, changes, entries);
    if (!result.ok) return result;

    const outcome =
      changes.status && changes.status !== lead.status ? `moved to ${changes.status}` : "updated";

    if (changes.status && changes.status !== lead.status) {
      pushNotification(`${lead.full_name}: status changed from ${lead.status} to ${changes.status}`);
    }
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
    const entries = [{ type: "followup", text: "Follow up marked as done" }];

    const result = await persistLeadUpdate(lead, { next_follow_up_at: "" }, entries);
    if (!result.ok) {
      flash(result.message, "error");
      return;
    }
    pushNotification(`Follow up with ${lead.full_name} marked as done`);
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
    pushNotification(`Follow up with ${lead.full_name} moved to tomorrow`);
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

      setActivityLog((current) => [
        { lead_id: data.lead_id, staff_member: data.staff_member, occurred_at: data.occurred_at },
        ...current,
      ]);

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

  /* ----- appointments (Supabase) ----- */

  function openBooking(lead = null) {
    closeLeadDetails();
    setBookingDialog({ mode: "book", lead });
  }

  function openReschedule(appointment) {
    closeLeadDetails();
    setBookingDialog({ mode: "reschedule", appointment });
  }

  // True when another booked appointment already uses this psychologist at that time.
  function hasConflict(values, ignoreId) {
    const start = new Date(values.starts_at).getTime();
    const end = new Date(values.ends_at).getTime();
    return appointments.some(
      (item) =>
        item.status === "Scheduled" &&
        String(item.id) !== String(ignoreId) &&
        String(item.psychologist_id) === String(values.psychologist_id) &&
        start < new Date(item.ends_at || new Date(item.starts_at).getTime() + 3600000).getTime() &&
        end > new Date(item.starts_at).getTime()
    );
  }

  // Called by the booking dialog. Resolves to { ok, message }.
  async function submitBooking(values) {
    const dialog = bookingDialog;
    if (!dialog) return { ok: false, message: "Nothing to save." };
    const reschedule = dialog.mode === "reschedule";
    const lead = leadsById.get(values.lead_id);
    if (!lead) return { ok: false, message: "This lead is no longer in the list. Please refresh the page." };

    if (!schedulablePsychologists.some((item) => String(item.id) === String(values.psychologist_id))) {
      return { ok: false, message: "You do not have permission to schedule for this psychologist." };
    }
    if (reschedule && !canManageAppointment(dialog.appointment)) {
      return { ok: false, message: "You do not have permission to reschedule this appointment." };
    }
    if (!reschedule && lead.status !== "Confirmed") {
      return { ok: false, message: "Only leads with status Confirmed can be booked." };
    }
    if (hasConflict(values, reschedule ? dialog.appointment.id : null)) {
      return { ok: false, message: "That slot was just taken. Please pick another one." };
    }

    try {
      const doctor = psychologistNames[values.psychologist_id] || "the psychologist";
      if (reschedule) {
        const saved = await rescheduleAppointment(dialog.appointment, values);
        setAppointments((current) => current.map((item) => (item.id === saved.id ? saved : item)));
        pushNotification(`${lead.full_name}: appointment moved to ${formatDateTime(saved.starts_at)} with ${doctor}`);
        flash(`Appointment rescheduled for ${lead.full_name}`);
      } else {
        const saved = await createAppointment({ id: newId(), ...values, booked_by: currentStaff.name });
        setAppointments((current) => [...current, saved]);
        pushNotification(`${lead.full_name}: appointment booked for ${formatDateTime(saved.starts_at)} with ${doctor}`);
        flash(`Appointment booked for ${lead.full_name}`);
      }
      // Keep the calendar on the month of the new booking.
      const when = new Date(values.starts_at);
      setCalAnchor(new Date(when.getFullYear(), when.getMonth(), 1));
      setCalDay(startOfDay(when));
      return { ok: true };
    } catch (error) {
      console.error("Failed to save appointment:", error);
      return { ok: false, message: describeAppointmentError(error) };
    }
  }

  async function changeAppointmentStatus(appointment, status) {
    if (!canManageAppointment(appointment)) return { ok: false, message: "You do not have permission to update this appointment." };
    if (!APPOINTMENT_STATUSES.includes(status)) return { ok: false, message: "Choose a valid appointment status." };
    try {
      const saved = await updateAppointmentStatus(appointment, status);
      setAppointments((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      const lead = leadsById.get(appointment.lead_id);
      pushNotification(`${lead ? lead.full_name : "Lead"}: appointment on ${formatDateTime(saved.starts_at)} marked ${status}`);
      flash(`Appointment marked ${status}`);
      return { ok: true };
    } catch (error) {
      console.error("Failed to update appointment status:", error);
      return { ok: false, message: describeAppointmentError(error) };
    }
  }

  function reminderLabel(item) {
    const minutes = Math.round((new Date(item.starts_at) - now) / 60000);
    if (minutes <= 0) return "Starting now";
    if (minutes < 60) return `In ${minutes} min`;
    const hours = Math.round(minutes / 60);
    return isSameDay(new Date(item.starts_at), now) ? `Today, in ${hours} hr` : `Tomorrow, in ${hours} hr`;
  }

  async function handleAppointmentStatus(item, status) {
    const result = await changeAppointmentStatus(item, status);
    if (!result.ok) flash(result.message, "error");
  }

  function renderAppointmentTable(items, empty) {
    return (
      <AppointmentTable
        items={items}
        empty={empty}
        leadsById={leadsById}
        psychologistNames={psychologistNames}
        canManage={canManageAppointment}
        onReschedule={openReschedule}
        onOpen={openLead}
        onStatusChange={handleAppointmentStatus}
      />
    );
  }

  // Leads without a booking (unconfirmed, or confirmed but not booked yet).
  function renderLeadTable(items, empty, action) {
    if (items.length === 0) return <p className="appt-empty">{empty}</p>;
    return (
      <div className="appt-table lead-cols" role="table">
        <div className="appt-row appt-head" role="row">
          <span role="columnheader">Client</span>
          <span role="columnheader">Source</span>
          <span role="columnheader">Assigned staff</span>
          <span role="columnheader">Status</span>
          <span role="columnheader" className="right">
            Actions
          </span>
        </div>
        {items.map((lead) => (
          <div className="appt-row" role="row" key={lead.id}>
            <span role="cell" className="appt-client">
              <Avatar name={lead.full_name} />
              <span>
                <strong>{lead.full_name}</strong>
                <small>{lead.lead_code}</small>
              </span>
            </span>
            <span role="cell" className="appt-doctor">{lead.source}</span>
            <span role="cell" className="appt-doctor">{lead.assigned_staff || "Unassigned"}</span>
            <span role="cell">
              <StatusBadge status={lead.status} />
            </span>
            <span role="cell" className="appt-actions">
              {action && action(lead)}
              <button type="button" className="appt-btn" onClick={() => openLead(lead)}>
                Open
              </button>
            </span>
          </div>
        ))}
      </div>
    );
  }

  function renderReminders() {
    if (reminders.length === 0) return null;
    return (
      <div className="reminder-strip" aria-label="Upcoming reminders">
        {reminders.map((item) => {
          const lead = leadsById.get(item.lead_id);
          const name = lead ? lead.full_name : "Unknown lead";
          return (
            <article className="reminder-card" key={`reminder-${item.id}`}>
              <span className="reminder-when">{reminderLabel(item)}</span>
              <div className="reminder-body">
                <Avatar name={name} />
                <div>
                  <strong>{name}</strong>
                  <small>
                    {formatTime(item.starts_at)} · {psychologistNames[item.psychologist_id] || "Psychologist not set"}
                  </small>
                </div>
              </div>
              {canManageAppointment(item) && (
                <button type="button" className="appt-btn" onClick={() => openReschedule(item)}>
                  Reschedule
                </button>
              )}
            </article>
          );
        })}
      </div>
    );
  }

  // Month calendar on the Appointments page: availability dots and booking counts.
  function calendarMeta(day) {
    const ids =
      calPsychologist === "all" ? schedulablePsychologists.map((item) => item.id) : [calPsychologist];
    const count = appointments.filter(
      (item) =>
        item.status === "Scheduled" &&
        isSameDay(new Date(item.starts_at), day) &&
        (calPsychologist === "all" || String(item.psychologist_id) === String(calPsychologist))
    ).length;
    const future = day.getTime() >= startOfDay(now || new Date()).getTime();
    const available =
      future &&
      ids.some((id) =>
        dayHasFreeSlot(periodsFor(availability, id), day, appointments, { psychologistId: id, now: now || new Date() })
      );
    return { available, count };
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
                <th>UPDATED BY</th>
                <th>NEXT FOLLOW UP</th>
                <th>DATE ADDED</th>
                <th aria-label="Actions" />
              </tr>
            </thead>

            <tbody>
              {leadsLoading && (
                <tr>
                  <td colSpan={9} role="status">Loading leads from Supabase...</td>
                </tr>
              )}

              {!leadsLoading && leadsError && (
                <tr>
                  <td colSpan={9} role="alert">{leadsError}</td>
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
                  <td>
                    {lastUpdatedBy[lead.id]
                      ? lastUpdatedBy[lead.id].trim().toLowerCase() === myName
                        ? "You"
                        : lastUpdatedBy[lead.id]
                      : "—"}
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
                  <td colSpan={9}>
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
            <div className="profile-avatar">{(currentStaff.name || "A").charAt(0).toUpperCase()}</div>
            <div className="profile-copy">
              <strong>{currentStaff.name || "CRM Admin"}</strong>
              <span>Staff</span>
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
            <div className="notif-wrap">
              <button
                className="top-icon notification-button"
                aria-label={`Notifications${unreadCount + reminders.length + attentionCount > 0 ? `, ${unreadCount + reminders.length + attentionCount} need attention` : ""}`}
                aria-expanded={notifOpen}
                onClick={() => setNotifOpen((open) => !open)}
              >
                <Icon name="bell" />
                {unreadCount + reminders.length + attentionCount > 0 && <span className="notification-dot" />}
              </button>

              {notifOpen && (
                <div className="notif-panel" role="dialog" aria-label="Notifications">
                  <div className="notif-head">
                    <strong>Notifications</strong>
                    <button
                      type="button"
                      className="text-button"
                      onClick={() => setNotifications((current) => current.map((item) => ({ ...item, read: true })))}
                    >
                      Mark all read
                    </button>
                  </div>

                  {attentionCount > 0 && (
                    <button
                      type="button"
                      className="notif-item"
                      onClick={() => {
                        setNotifOpen(false);
                        navigateTo("Follow Ups");
                      }}
                    >
                      <strong>{attentionCount} follow up{attentionCount > 1 ? "s" : ""} need attention</strong>
                      <small>Open follow ups</small>
                    </button>
                  )}

                  {reminders.map((item) => {
                    const lead = leadsById.get(item.lead_id);
                    return (
                      <button
                        type="button"
                        className="notif-item reminder"
                        key={`r-${item.id}`}
                        onClick={() => {
                          setNotifOpen(false);
                          navigateTo("Confirmed");
                        }}
                      >
                        <strong>Reminder: {lead ? lead.full_name : "Appointment"} at {formatTime(item.starts_at)}</strong>
                        <small>{reminderLabel(item)}</small>
                      </button>
                    );
                  })}

                  {notifications.map((item) => (
                    <div className={`notif-item ${item.read ? "" : "unread"}`} key={item.id}>
                      <strong>{item.text}</strong>
                      <small>{formatDateTime(item.at)}</small>
                    </div>
                  ))}

                  {notifications.length === 0 && reminders.length === 0 && attentionCount === 0 && (
                    <p className="subtle-text card-empty">You are all caught up.</p>
                  )}
                </div>
              )}
            </div>
          </div>
        </header>

        {activePage === "Dashboard" && (
          <>
            <section className="hero-panel">
              <div className="hero-content">
                <span className="eyebrow">YOUR WORKSPACE AT A GLANCE</span>
                <h1>
                  {getGreeting(now)}, <span>{currentStaff.name || "Team Kappiness"}</span>
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
                      <strong>{enquiryCount}</strong>
                      <span>Enquiries</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="clock" />
                    </span>
                    <div>
                      <strong>{openFollowUpCount}</strong>
                      <span>Follow Ups</span>
                    </div>
                  </div>

                  <div className="hero-stat">
                    <span className="hero-stat-icon">
                      <Icon name="check" />
                    </span>
                    <div>
                      <strong>{confirmedCount}</strong>
                      <span>Confirmed</span>
                    </div>
                  </div>
                </div>
              </div>

              <div className="hero-progress">
                <span className="progress-title">LEAD ENGAGEMENT</span>
                <ProgressRing value={engagedPercent} label="Engaged" />
                <p>Share of leads that have moved past the first enquiry.</p>
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
                    { name: "Enquiry", count: enquiryCount, color: "bar-amber" },
                    { name: "Yet to Confirm", count: yetToConfirmCount, color: "bar-beige" },
                    { name: "Will Inform", count: willInformCount, color: "bar-brown" },
                    { name: "Confirmed", count: confirmedCount, color: "bar-muted" },
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
                <span className="quick-stat-label">Confirmed appointments</span>
                <strong>{appointmentsState === "ready" ? upcomingAppointments.length : "—"}</strong>
                <button onClick={() => navigateTo("Confirmed")}>View confirmed ↗</button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="heart" />
                  </span>
                  <span className="quick-stat-tag">TEAM</span>
                </div>
                <span className="quick-stat-label">Assigned staff</span>
                <strong>{staffCount}</strong>
                <button onClick={() => openPage("Psychologists")}>View psychologists ↗</button>
              </article>

              <article className="quick-stat-card">
                <div className="quick-stat-top">
                  <span className="quick-stat-icon">
                    <Icon name="check" />
                  </span>
                  <span className="quick-stat-tag">CONFIRMED</span>
                </div>
                <span className="quick-stat-label">Confirmed leads</span>
                <strong>{confirmedCount}</strong>
                <button onClick={() => goToLeads("Confirmed")}>View confirmed ↗</button>
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
                    { label: "Enquiry", value: "Enquiry", count: enquiryCount },
                    { label: "Yet to confirm", value: "Yet to Confirm", count: yetToConfirmCount },
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
                <button
                  className={`table-tab ${onlyMine ? "active" : ""}`}
                  onClick={() => setOnlyMine((value) => !value)}
                >
                  My leads
                  <span>{myLeadIds.size}</span>
                </button>
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

        {activePage === "Appointments" && (
          <section className="appt-page">
            <header className="appt-page-head">
              <div>
                <span className="eyebrow">SCHEDULE</span>
                <h2>Appointments</h2>
                <p>Pick a date to see bookings and free slots. Booked appointments are listed on the Confirmed page.</p>
              </div>
              {canScheduleAppointments && (
                <button className="primary-button" onClick={() => openBooking()}>
                  <Icon name="plus" /> Book appointment
                </button>
              )}
            </header>

            <div className="appt-stats">
              <article className="appt-stat">
                <span>Today</span>
                <strong>{todayAppointments.length}</strong>
                <small>appointments</small>
              </article>
              <article className="appt-stat">
                <span>Next 7 days</span>
                <strong>{weekAppointments.length}</strong>
                <small>booked</small>
              </article>
              <article className="appt-stat">
                <span>Awaiting confirmation</span>
                <strong>{unconfirmedLeads.length}</strong>
                <small>leads</small>
              </article>
              <article className="appt-stat">
                <span>Ready to book</span>
                <strong>{confirmedWithoutBooking.length}</strong>
                <small>confirmed leads</small>
              </article>
            </div>

            {renderReminders()}

            <div className="appt-layout">
              <article className="appt-card">
                {!isPsychologistUser && (
                  <label className="cal-filter">
                    <span>Psychologist</span>
                    <select value={calPsychologist} onChange={(event) => setCalPsychologist(event.target.value)}>
                      <option value="all">All psychologists</option>
                      {schedulablePsychologists.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                <MonthGrid
                  anchor={calAnchor}
                  onAnchorChange={setCalAnchor}
                  selected={calDay}
                  today={now ? startOfDay(now) : null}
                  getMeta={calendarMeta}
                  onSelect={setCalDay}
                />
              </article>

              <article className="appt-card appt-day">
                {calDay ? (
                  <>
                    <header className="appt-day-head">
                      <strong>{calDay.getDate()}</strong>
                      <span>
                        {calDay.toLocaleDateString("en-GB", { weekday: "long" })}
                        <small>{calDay.toLocaleDateString("en-GB", { month: "long", year: "numeric" })}</small>
                      </span>
                    </header>

                    <h4 className="appt-sub">Booked</h4>
                    {renderAppointmentTable(
                      appointments
                        .filter(
                          (item) =>
                            isSameDay(new Date(item.starts_at), calDay) &&
                            (calPsychologist === "all" || String(item.psychologist_id) === String(calPsychologist))
                        )
                        .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)),
                      "No appointments on this day."
                    )}

                    <h4 className="appt-sub">Free slots</h4>
                    {schedulablePsychologists
                      .filter((item) => calPsychologist === "all" || String(item.id) === String(calPsychologist))
                      .map((item) => {
                        const free = slotsForDay(periodsFor(availability, item.id), calDay, appointments, {
                          psychologistId: item.id,
                          now: now || new Date(),
                        }).filter((slot) => slot.free);
                        return (
                          <div className="free-slots" key={item.id}>
                            <span className="free-name">{item.name}</span>
                            {free.length === 0 ? (
                              <span className="appt-empty inline">No free slots</span>
                            ) : (
                              <div className="slot-grid">
                                {free.map((slot) => (
                                  <span className="slot static" key={slot.start.toISOString()}>
                                    {formatSlotTime(slot.start)}
                                  </span>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                  </>
                ) : (
                  <div className="appt-placeholder">
                    <Icon name="calendar" />
                    <strong>Select a date</strong>
                    <p>Dates with a dot have free slots. A number shows how many appointments are already booked.</p>
                  </div>
                )}
              </article>
            </div>

            <article className="appt-card">
              <header className="appt-card-head">
                <div>
                  <h3>Awaiting confirmation</h3>
                  <p>These leads can be booked once their status is Confirmed.</p>
                </div>
                <span className="appt-count">{unconfirmedLeads.length}</span>
              </header>
              {renderLeadTable(unconfirmedLeads, "No unconfirmed leads.")}
            </article>
          </section>
        )}

        {activePage === "Confirmed" && (
          <section className="appt-page">
            <header className="appt-page-head">
              <div>
                <span className="eyebrow">CONFIRMED</span>
                <h2>Confirmed appointments</h2>
                <p>Booked appointments for confirmed leads. Reschedule or update the status from here.</p>
              </div>
              {canScheduleAppointments && (
                <button className="primary-button" onClick={() => openBooking()}>
                  <Icon name="plus" /> Book appointment
                </button>
              )}
            </header>

            {renderReminders()}

            <article className="appt-card">
              <header className="appt-card-head">
                <div>
                  <h3>Upcoming</h3>
                  <p>Sorted by date and time.</p>
                </div>
                <span className="appt-count">{upcomingAppointments.length}</span>
              </header>
              {renderAppointmentTable(
                [...upcomingAppointments].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)),
                "No upcoming confirmed appointments."
              )}
            </article>

            {confirmedWithoutBooking.length > 0 && (
              <article className="appt-card">
                <header className="appt-card-head">
                  <div>
                    <h3>Confirmed, not booked yet</h3>
                    <p>Pick a psychologist and a free slot for these leads.</p>
                  </div>
                  <span className="appt-count">{confirmedWithoutBooking.length}</span>
                </header>
                {renderLeadTable(confirmedWithoutBooking, "", (lead) =>
                  canScheduleAppointments ? (
                    <button type="button" className="appt-btn dark" onClick={() => openBooking(lead)}>
                      Book
                    </button>
                  ) : null
                )}
              </article>
            )}

            {pastAppointments.length > 0 && (
              <article className="appt-card">
                <header className="appt-card-head">
                  <div>
                    <h3>History</h3>
                    <p>Completed, cancelled and missed.</p>
                  </div>
                  <span className="appt-count">{pastAppointments.length}</span>
                </header>
                {renderAppointmentTable(pastAppointments, "")}
              </article>
            )}
          </section>
        )}

        {activePage === "Reports" && (
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
          currentStaffName={currentStaff.name}
          onClose={() => setShowForm(false)}
          onCreate={handleCreateLead}
          createError={createLeadError}
        />
      )}

      {selectedLeadId && !selectedLead && (
        <ModalShell
          labelledBy="lead-fetch-title"
          onRequestClose={closeLeadDetails}
          className="wide-modal"
        >
          <div className="modal-heading">
            <h2 id="lead-fetch-title">{selectedLeadLoading ? "Loading lead details" : "Could not load lead"}</h2>
            <button type="button" className="modal-close" onClick={closeLeadDetails} aria-label="Close">
              ×
            </button>
          </div>
          <div className="modal-body" role={selectedLeadError ? "alert" : "status"}>
            {selectedLeadError || "Fetching the latest lead details from Supabase…"}
          </div>
          {selectedLeadError && (
            <div className="modal-footer">
              <button
                type="button"
                className="secondary-button"
                onClick={() => {
                  const lead = leads.find((item) => item.id === selectedLeadId);
                  if (lead) openLead(lead, selectedLeadTab);
                  else closeLeadDetails();
                }}
              >
                Try again
              </button>
            </div>
          )}
        </ModalShell>
      )}

      {selectedLead && (
        <LeadDetailsModal
          key={selectedLead.id}
          lead={selectedLead}
          now={now}
          staffOptions={staffOptions}
          currentStaffName={currentStaff.name}
          canUpdateStatus={canEditStatuses}
          appointments={appointmentsByLead[selectedLead.id] || []}
          psychologistNames={psychologistNames}
          canManageAppointment={canManageAppointment}
          canScheduleAppointments={canScheduleAppointments}
          onRequestBooking={openBooking}
          onRequestReschedule={openReschedule}
          onUpdateAppointmentStatus={changeAppointmentStatus}
          onClose={closeLeadDetails}
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


      {bookingDialog && (
        <BookingModal
          key={bookingDialog.mode + (bookingDialog.appointment ? bookingDialog.appointment.id : bookingDialog.lead ? bookingDialog.lead.id : "new")}
          mode={bookingDialog.mode}
          lockedLead={bookingDialog.lead}
          appointment={bookingDialog.appointment}
          leads={leads.filter((lead) => lead.status === "Confirmed")}
          psychologists={schedulablePsychologists}
          availability={availability}
          appointments={appointments}
          now={now}
          onClose={() => setBookingDialog(null)}
          onSubmit={submitBooking}
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