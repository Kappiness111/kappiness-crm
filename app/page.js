"use client";

import "./globals.css";
import { useEffect, useMemo, useRef, useState } from "react";
import AddLeadModal from "./components/AddLeadModal";
import AppShell from "./components/AppShell";
import Dialog from "./components/Dialog";
import Icon from "./components/Icon";
import LeadDetailsModal from "./components/LeadDetailsModal";
import StatusBadge from "./components/StatusBadge";
import { CRM_NAV, CRM_VIEWS, roleLabel } from "./lib/navigation";
import { createClient } from "../utils/supabase/client";
import { canUpdateStatuses, getStaffName, getStaffRole } from "./lib/staff";
import {
  ACTIVE_APPOINTMENT_STATUSES,
  APPOINTMENT_STATUSES,
  PSYCHOLOGIST_CAN_SCHEDULE,
  appointmentActions,
  bookAppointment,
  cancelAppointment,
  confirmAppointment,
  describeAppointmentError,
  getAppointment,
  isMissingBackend,
  listAppointments,
  recordAttendance,
  rescheduleAppointment,
} from "./lib/appointmentsApi";
import { listClients } from "./lib/clientsApi";
import { listBlocks, listServices } from "./lib/schedulingApi";
import ReasonDialog from "./components/ReasonDialog";
import { useRouter } from "next/navigation";
import { dayHasFreeSlot, periodsFor, slotsForDay } from "./lib/appointmentSlots";
import { formatClock as formatSlotTime, isSameDay, startOfDay } from "./lib/calendar";
import { getPsychologistByAuthUser, listAllAvailability, listPsychologists } from "./lib/psychologistsApi";
import BookingModal from "./components/BookingModal";
import MonthGrid from "./components/MonthGrid";
import AppointmentTable, { Avatar, initialsOf } from "./components/AppointmentTable";
import { ArcGauge, BarList, GroupedBars, Legend, LineChart, ProgressMeter, RangeTabs, RingGauge, StatusColumns } from "./components/dashboard/Charts";
import { DEFAULT_RANGE, RANGE_OPTIONS, bucketIndexOf, buildBuckets } from "./lib/dashboardStats";
import {
  CLOSED_STATUSES,
  CONFIRMED_STATUS,
  CONFIRM_NEEDS_PSYCHOLOGIST,
  DEFAULT_STATUS,
  LOST_STATUS,
  PSYCHOLOGIST_COLUMN,
  SOURCES,
  STATUSES,
  UNCONFIRMED_STATUSES,
  describeLeadError,
  dueLabel,
  formatDate,
  formatDateTime,
  formatShort,
  formatTime,
  getFollowUpState,
  getGreeting,
  parseDate,
  parseLostReason,
  relativeTime,
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
    // null when unassigned, or when the column has not been added yet (see the migration in supabase/migrations).
    assigned_psychologist_id: record.assigned_psychologist_id ?? null,
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
  if (["assigned_staff", "not_converted_reason", "notes", "contact_method", PSYCHOLOGIST_COLUMN].includes(key)) {
    return value ? value : null;
  }
  return value;
}

// True when the lead's current value already equals the new UI value (so there is nothing to send).
function sameLeadValue(key, current, next) {
  if (key === "next_follow_up_at") {
    const a = current ? parseDate(current) : null;
    const b = next ? parseDate(next) : null;
    return (a ? a.getTime() : null) === (b ? b.getTime() : null);
  }
  return String(current ?? "") === String(next ?? "");
}

// Turns a Supabase error into a short message for staff. Full details go to the console.
function describeSaveError(error) {
  return describeLeadError(error, "Could not save your changes. Nothing was lost on screen, so please try again.");
}

// Leads shown per status, in pipeline order, with the colour tone used by their badge.

export default function DashboardPage() {
  const [activePage, setActivePage] = useState("Dashboard");
  const [leads, setLeads] = useState([]);
  const [leadsLoading, setLeadsLoading] = useState(true);
  const [leadsError, setLeadsError] = useState("");
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState("All");
  const [showForm, setShowForm] = useState(false);
  const [selectedLeadId, setSelectedLeadId] = useState(null);
  const [selectedLeadRecord, setSelectedLeadRecord] = useState(null);
  const [selectedLeadLoading, setSelectedLeadLoading] = useState(false);
  const [selectedLeadError, setSelectedLeadError] = useState("");
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
  // Columns seen on a real leads row; null until known. Used to tell whether psychologist assignment is available.
  const [leadColumns, setLeadColumns] = useState(null);
  const createLeadBusyRef = useRef(false);
  // Lead ids with an update in flight, to block double clicks.
  const busyLeadIdsRef = useRef(new Set());
  const leadDetailRequestRef = useRef(0);
  // The clock is set after mount so server and browser markup always match.
  const [now, setNow] = useState(null);
  // Logged-in staff member, and the staff names saved on lead_activities rows.
  const [currentStaff, setCurrentStaff] = useState({ id: "", name: "", email: "", role: "" });
  const [psychologists, setPsychologists] = useState([]);
  const [psychologistsState, setPsychologistsState] = useState("loading"); // loading | ready | error
  const [psychologistsReload, setPsychologistsReload] = useState(0);
  const [availability, setAvailability] = useState([]);
  const [ownPsychologist, setOwnPsychologist] = useState(null);
  const [bookingDialog, setBookingDialog] = useState(null); // { mode, lead?, appointment? }
  // null until the user navigates months; until then the calendar shows the current month (from `now`, set after
  // mount). Reading the clock in a state initializer breaks prerendering with Cache Components.
  const [calAnchor, setCalAnchor] = useState(null);
  const [calDay, setCalDay] = useState(null);
  const [calPsychologist, setCalPsychologist] = useState("all");
  const [notifications, setNotifications] = useState([]);
  const [notifOpen, setNotifOpen] = useState(false);
  const router = useRouter();
  const [appointments, setAppointments] = useState([]);
  // Scheduling data from Supabase: loading | ready | missing (migration not applied) | error
  const [schedulingState, setSchedulingState] = useState("loading");
  const [clients, setClients] = useState([]);
  const [services, setServices] = useState([]);
  const [blocks, setBlocks] = useState([]);
  const [cancelTarget, setCancelTarget] = useState(null);
  const [apptBusyId, setApptBusyId] = useState(null);
  const canEditStatuses = canUpdateStatuses(currentStaff.role);
  const [activityLog, setActivityLog] = useState([]);
  const [onlyMine, setOnlyMine] = useState(false);
  // Dashboard analytics filters: date window and whose leads to count.
  const [dashRange, setDashRange] = useState(DEFAULT_RANGE);
  const [dashScope, setDashScope] = useState("all"); // all | mine
  const [dashTab, setDashTab] = useState("appointments"); // schedule card tab
  const [dashSearch, setDashSearch] = useState("");

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
          .select("lead_id, staff_member, occurred_at, activity_type, notes")
          .order("occurred_at", { ascending: false })
          .limit(3000);
        if (!error && Array.isArray(data) && !cancelled) setActivityLog(data);
        else if (error) console.error("Failed to load recent activity:", error);
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
      setPsychologistsState("loading");
      try {
        const [list, periods] = await Promise.all([listPsychologists(), listAllAvailability()]);
        if (cancelled) return;
        setPsychologists(list);
        setAvailability(periods);
        setPsychologistsState("ready");
      } catch (error) {
        console.error("Failed to load psychologists or availability:", error);
        if (!cancelled) setPsychologistsState("error");
      }
    }

    loadScheduling();
    return () => {
      cancelled = true;
    };
  }, [psychologistsReload]);

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
          if (data.length > 0) {
            leadColumnsRef.current = new Set(Object.keys(data[0]));
            setLeadColumns(leadColumnsRef.current);
          }
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
    const view = new URLSearchParams(window.location.search).get("view");
    // One-time sync from the address bar after mount (it is not available during prerendering).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (view && CRM_VIEWS.includes(view)) setActivePage(view);
  }, []);

  // ?lead=<id> (from a client profile's "Original lead") opens that lead once leads have loaded.
  const pendingLeadRef = useRef(null);
  useEffect(() => {
    pendingLeadRef.current = new URLSearchParams(window.location.search).get("lead");
  }, []);
  useEffect(() => {
    if (leadsLoading || !pendingLeadRef.current) return;
    const target = leads.find((lead) => String(lead.id) === pendingLeadRef.current);
    pendingLeadRef.current = null;
    if (target) openLead(target);
  }, [leadsLoading, leads]);

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

  const confirmedCount = statusCounts.Confirmed;
  const lostCount = statusCounts.Lost;
  const activeCount = totalLeads - confirmedCount - lostCount;
  // Psychologist assignment needs leads.assigned_psychologist_id (unknown until a lead row is loaded).
  const assignmentSupported = !leadColumns || leadColumns.has(PSYCHOLOGIST_COLUMN);
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
  const upcomingAppointments = appointments.filter((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status));
  const pastAppointments = appointments
    .filter((item) => !ACTIVE_APPOINTMENT_STATUSES.includes(item.status))
    .sort((a, b) => new Date(b.starts_at) - new Date(a.starts_at));
  const unconfirmedLeads = leads.filter((lead) => UNCONFIRMED_STATUSES.includes(lead.status));
  const confirmedWithoutBooking = leads.filter(
    (lead) =>
      lead.status === "Confirmed" &&
      !(appointmentsByLead[lead.id] || []).some((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status))
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

  const clientsByLead = useMemo(() => new Map(clients.map((item) => [item.lead_id, item])), [clients]);

  // Calendar availability dots use the shortest active service, so a day shows as free if anything fits.
  const slotDefaults = useMemo(() => {
    const active = services.filter((item) => item.is_active);
    const shortest = active.reduce((best, item) => (!best || item.duration_minutes < best.duration_minutes ? item : best), null);
    return {
      now: now || undefined, // never read the clock during render (prerendering)
      durationMinutes: shortest ? shortest.duration_minutes : 60,
      bufferMinutes: shortest ? shortest.buffer_minutes : 0,
      blocks,
    };
  }, [services, blocks, now]);

  // Appointments (13 months back, all future), services and blocked periods from Supabase.
  const [schedulingReload, setSchedulingReload] = useState(0);
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const from = new Date();
        from.setMonth(from.getMonth() - 13);
        const [rows, serviceRows, blockRows] = await Promise.all([
          listAppointments({ from }),
          listServices(),
          listBlocks({ from: new Date() }),
        ]);
        if (cancelled) return;
        setAppointments(rows);
        setServices(serviceRows);
        setBlocks(blockRows);
        setSchedulingState("ready");
      } catch (error) {
        console.error("Failed to load appointments:", error);
        if (!cancelled) setSchedulingState(isMissingBackend(error) ? "missing" : "error");
      }
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [schedulingReload]);

  // Clients are created by the database when a lead is Confirmed, so reload them whenever that count changes.
  const confirmedLeadCount = statusCounts.Confirmed || 0;
  useEffect(() => {
    let cancelled = false;
    listClients()
      .then((rows) => {
        if (!cancelled) setClients(rows);
      })
      .catch((error) => {
        if (!isMissingBackend(error)) console.error("Failed to load clients:", error);
      });
    return () => {
      cancelled = true;
    };
  }, [confirmedLeadCount]);

  // Reminders: booked appointments starting in the next 24 hours.
  const reminders = useMemo(() => {
    if (!now) return [];
    const limit = now.getTime() + 24 * 3600000;
    return appointments
      .filter((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status))
      .filter((item) => {
        const start = new Date(item.starts_at).getTime();
        return start >= now.getTime() - 15 * 60000 && start <= limit;
      })
      .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  }, [appointments, now]);

  const todayAppointments = now
    ? appointments.filter((item) => ACTIVE_APPOINTMENT_STATUSES.includes(item.status) && isSameDay(new Date(item.starts_at), now))
    : [];
  const weekAppointments = now
    ? appointments.filter((item) => {
        const start = new Date(item.starts_at).getTime();
        return ACTIVE_APPOINTMENT_STATUSES.includes(item.status) && start >= now.getTime() && start <= now.getTime() + 7 * 86400000;
      })
    : [];

  const unreadCount = notifications.filter((item) => !item.read).length;

  const attentionCount = followUps.overdue.length + followUps.today.length;
  const openFollowUpCount = attentionCount + followUps.upcoming.length;

  const dashboardFollowUps =
    attentionCount > 0
      ? [...followUps.overdue, ...followUps.today].slice(0, 4)
      : followUps.upcoming.slice(0, 4);

  // Dashboard analytics, all derived from the loaded Supabase leads (and the session's appointments) for the
  // selected window. Null until the clock is set after mount.
  const analytics = useMemo(() => {
    if (!now) return null;
    const period = buildBuckets(dashRange, now);
    const { buckets, start, end, previousStart } = period;
    const scoped = dashScope === "mine" ? leads.filter((lead) => myLeadIds.has(lead.id)) : leads;
    const createdAt = (lead) => parseDate(lead.created_at);
    const within = (date, from, to) => date && date >= from && date < to;

    const rangeLeads = scoped.filter((lead) => within(createdAt(lead), start, end));
    const previousCount = scoped.filter((lead) => within(createdAt(lead), previousStart, start)).length;

    const trend = buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, full: bucket.full, leads: 0, confirmed: 0 }));
    rangeLeads.forEach((lead) => {
      const index = bucketIndexOf(buckets, createdAt(lead));
      if (index < 0) return;
      trend[index].leads += 1;
      if (lead.status === CONFIRMED_STATUS) trend[index].confirmed += 1;
    });

    const byStatus = {};
    STATUSES.forEach((status) => {
      byStatus[status] = 0;
    });
    rangeLeads.forEach((lead) => {
      byStatus[lead.status] = (byStatus[lead.status] || 0) + 1;
    });

    // Predefined sources plus any custom ones on the records, without blanks or duplicates.
    const sourceCounts = new Map(SOURCES.map((source) => [source, 0]));
    rangeLeads.forEach((lead) => {
      const source = (lead.source || "").trim();
      if (source) sourceCounts.set(source, (sourceCounts.get(source) || 0) + 1);
    });
    const sources = [...sourceCounts.entries()]
      .map(([source, value]) => ({ key: source, label: source, value }))
      .sort((a, b) => b.value - a.value);

    const perPsychologist = new Map();
    rangeLeads.forEach((lead) => {
      if (!lead.assigned_psychologist_id) return;
      const id = String(lead.assigned_psychologist_id);
      const row = perPsychologist.get(id) || { key: id, label: psychologistNames[lead.assigned_psychologist_id] || "Unknown psychologist", assigned: 0, confirmed: 0 };
      row.assigned += 1;
      if (lead.status === CONFIRMED_STATUS) row.confirmed += 1;
      perPsychologist.set(id, row);
    });
    const psychologistRows = [...perPsychologist.values()].sort((a, b) => b.assigned - a.assigned || b.confirmed - a.confirmed).slice(0, 6);
    const unassignedCount = rangeLeads.filter((lead) => !lead.assigned_psychologist_id && lead.status !== LOST_STATUS).length;

    const scopedIds = new Set(scoped.map((lead) => lead.id));
    const rangeAppointments = appointments.filter(
      (item) => scopedIds.has(item.lead_id) && within(parseDate(item.starts_at), start, end)
    );
    const appointmentStatus = APPOINTMENT_STATUSES.map((status) => ({
      key: status,
      label: status,
      value: rangeAppointments.filter((item) => item.status === status).length,
    }));
    const appointmentTrend = buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, full: bucket.full, booked: 0 }));
    rangeAppointments.forEach((item) => {
      const index = bucketIndexOf(buckets, parseDate(item.starts_at));
      if (index >= 0) appointmentTrend[index].booked += 1;
    });
    const completed = rangeAppointments.filter((item) => item.status === "Completed").length;
    // Rescheduled bookings moved to a new appointment, so they are not outcomes of their own.
    const resolved = rangeAppointments.filter((item) => ["Completed", "Cancelled", "Missed"].includes(item.status)).length;

    const confirmedLeads = rangeLeads.filter((lead) => lead.status === CONFIRMED_STATUS);
    const confirmedBooked = confirmedLeads.filter((lead) =>
      appointments.some((item) => item.lead_id === lead.id && ["Scheduled", "Confirmed", "Completed"].includes(item.status))
    ).length;

    // Follow-up health covers every open lead in scope, not just new ones: follow-ups are about current work.
    const openLeads = scoped.filter((lead) => !CLOSED_STATUSES.includes(lead.status));
    const withFollowUp = openLeads.filter((lead) => parseDate(lead.next_follow_up_at));
    const overdue = withFollowUp.filter((lead) => getFollowUpState(lead, now) === "overdue").length;

    return {
      period,
      total: rangeLeads.length,
      previousCount,
      byStatus,
      trend,
      sources,
      psychologistRows,
      unassignedCount,
      appointmentCount: rangeAppointments.length,
      appointmentStatus,
      appointmentTrend,
      completed,
      resolved,
      confirmedTotal: confirmedLeads.length,
      confirmedBooked,
      openLeads: openLeads.length,
      withFollowUp: withFollowUp.length,
      onSchedule: withFollowUp.length - overdue,
    };
  }, [now, dashRange, dashScope, leads, myLeadIds, appointments, psychologistNames]);

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
      const matchesSource = sourceFilter === "All" || lead.source === sourceFilter;

      return matchesSearch && matchesStatus && matchesMine && matchesSource;
    })
    .sort(
      (a, b) =>
        new Date(b.created_at) - new Date(a.created_at)
    );
}, [leads, search, statusFilter, sourceFilter, onlyMine, myLeadIds]);

  /* ----- actions ----- */

  function navigateTo(page) {
    setActivePage(page);
    setNotifOpen(false);
    closeLeadDetails();
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", page === "Dashboard" ? "/" : `/?view=${encodeURIComponent(page)}`);
      window.scrollTo({ top: 0 });
    }
  }

  function openPage(page) {
    if (page === "Leads") {
      setOnlyMine(false);
      setStatusFilter("All");
      setSourceFilter("All");
      setSearch("");
    }
    navigateTo(page);
  }

  function goToLeads(status) {
    setOnlyMine(false);
    setStatusFilter(status);
    setSourceFilter("All");
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
          return { ok: false, message: describeSaveError(error) };
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


  async function handleCreateLead(values, { addAnother = false } = {}) {
    // A second click while the first insert is in flight must not create a duplicate lead.
    if (createLeadBusyRef.current) return false;
    createLeadBusyRef.current = true;
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
      if (!leadColumnsRef.current) {
        leadColumnsRef.current = new Set(Object.keys(data));
        setLeadColumns(leadColumnsRef.current);
      }
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
      // Supabase errors are plain objects (code, message, details), not Error instances.
      const fallback = error && error.message ? `Could not save this lead. ${error.message}` : "Could not save this lead. Please try again.";
      setCreateLeadError(describeLeadError(error, fallback));
      return false;
    } finally {
      createLeadBusyRef.current = false;
    }
  }

  // Called by the lead drawer. Resolves to { ok, message } so the drawer can keep the form open on failure.
  async function handleSaveLead(id, changes, entries) {
    const lead = leads.find((item) => item.id === id);
    if (!lead) return { ok: false, message: "This lead is no longer in the list. Please refresh the page." };

    if (changes.status && changes.status !== lead.status && !canEditStatuses) {
      return { ok: false, message: "You do not have permission to change lead statuses." };
    }
    if (PSYCHOLOGIST_COLUMN in changes && !canEditStatuses) {
      return { ok: false, message: "You do not have permission to assign psychologists." };
    }
    // Same workflow rules as the drawer and the update_lead_with_history RPC.
    const nextPsychologist = PSYCHOLOGIST_COLUMN in changes ? changes[PSYCHOLOGIST_COLUMN] : lead.assigned_psychologist_id;
    if (changes.status === CONFIRMED_STATUS && lead.status !== CONFIRMED_STATUS && !nextPsychologist) {
      return { ok: false, message: CONFIRM_NEEDS_PSYCHOLOGIST };
    }
    if (changes.status === LOST_STATUS && lead.status !== LOST_STATUS && !(changes.not_converted_reason || "").trim()) {
      return { ok: false, message: "Choose a lost reason before marking this lead as Lost." };
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

  /* ----- appointments (Supabase: public.appointments, migration 202611040001) ----- */

  // Booking needs an existing client. A lead becomes a client when it is Confirmed with a psychologist.
  function openBooking(lead = null) {
    closeLeadDetails();
    if (lead) {
      const client = clientsByLead.get(lead.id);
      if (!client) {
        flash("This lead has no client profile yet. Assign a psychologist and set it to Confirmed first.", "error");
        return;
      }
      setBookingDialog({ mode: "book", client });
      return;
    }
    setBookingDialog({ mode: "book" });
  }

  function openReschedule(appointment) {
    closeLeadDetails();
    setBookingDialog({ mode: "reschedule", appointment });
  }

  function storeAppointment(saved) {
    setAppointments((current) => {
      const exists = current.some((item) => item.id === saved.id);
      return exists ? current.map((item) => (item.id === saved.id ? saved : item)) : [...current, saved];
    });
  }

  // Called by the booking dialog. Resolves to { ok, message }.
  async function submitBooking(values) {
    const dialog = bookingDialog;
    if (!dialog) return { ok: false, message: "Nothing to save." };
    const reschedule = dialog.mode === "reschedule";
    if (!schedulablePsychologists.some((item) => String(item.id) === String(values.psychologist_id))) {
      return { ok: false, message: "You do not have permission to schedule for this psychologist." };
    }

    try {
      const doctor = psychologistNames[values.psychologist_id] || "the psychologist";
      let saved;
      if (reschedule) {
        saved = await rescheduleAppointment(dialog.appointment.id, {
          startsAt: values.starts_at,
          psychologistId: values.psychologist_id,
          reason: values.reason,
        });
        // The original keeps its time and becomes Rescheduled: reload it so the history shows that.
        const original = await getAppointment(dialog.appointment.id);
        if (original) storeAppointment(original);
        pushNotification(`${saved.client_name}: appointment moved to ${formatDateTime(saved.starts_at)} with ${doctor}`);
        flash(`Appointment rescheduled for ${saved.client_name}`);
      } else {
        saved = await bookAppointment({
          clientId: values.client_id,
          psychologistId: values.psychologist_id,
          serviceId: values.service_id,
          startsAt: values.starts_at,
          notes: values.notes,
          recommendationId: values.recommendation_id,
        });
        pushNotification(`${saved.client_name}: appointment booked for ${formatDateTime(saved.starts_at)} with ${doctor}`);
        flash(`Appointment booked for ${saved.client_name}`);
      }
      storeAppointment(saved);
      // Keep the calendar on the month of the new booking.
      const when = new Date(saved.starts_at);
      setCalAnchor(new Date(when.getFullYear(), when.getMonth(), 1));
      setCalDay(startOfDay(when));
      return { ok: true };
    } catch (error) {
      console.error("Failed to save appointment:", error);
      return { ok: false, message: describeAppointmentError(error) };
    }
  }

  function actionsFor(item) {
    return appointmentActions(item, {
      isStaff: !isPsychologistUser,
      ownPsychologistId: ownPsychologist ? ownPsychologist.id : null,
      now: now || undefined, // never read the clock during render (prerendering)
    });
  }

  // Runs one workflow action. "cancel" asks for a reason first; "reschedule" opens the booking dialog.
  async function runAppointmentAction(item, action) {
    if (!actionsFor(item).includes(action)) return { ok: false, message: "That change is not allowed for this appointment." };
    if (action === "reschedule") {
      openReschedule(item);
      return { ok: true };
    }
    if (action === "cancel") {
      setCancelTarget(item);
      return { ok: true };
    }
    setApptBusyId(item.id);
    try {
      let saved;
      if (action === "confirm") saved = await confirmAppointment(item.id);
      else if (action === "attended") saved = await recordAttendance(item.id, true);
      else if (action === "missed") saved = await recordAttendance(item.id, false);
      else return { ok: false, message: "Unknown action." };
      storeAppointment(saved);
      pushNotification(`${saved.client_name}: appointment on ${formatDateTime(saved.starts_at)} is now ${saved.status}`);
      flash(`Appointment marked ${saved.status}`);
      return { ok: true };
    } catch (error) {
      console.error("Failed to update appointment:", error);
      return { ok: false, message: describeAppointmentError(error) };
    } finally {
      setApptBusyId(null);
    }
  }

  async function submitCancellation(reason) {
    const item = cancelTarget;
    if (!item) return { ok: false, message: "Nothing to cancel." };
    try {
      const saved = await cancelAppointment(item.id, reason);
      storeAppointment(saved);
      pushNotification(`${saved.client_name}: appointment on ${formatDateTime(saved.starts_at)} cancelled`);
      flash(`Appointment cancelled for ${saved.client_name}. The slot is free again.`);
      return { ok: true };
    } catch (error) {
      console.error("Failed to cancel appointment:", error);
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

  async function handleAppointmentAction(item, action) {
    const result = await runAppointmentAction(item, action);
    if (!result.ok) flash(result.message, "error");
  }

  function openAppointmentClient(item) {
    if (item.client_id) router.push(`/clients/${item.client_id}`);
  }

  function renderAppointmentTable(items, empty) {
    return (
      <AppointmentTable
        items={items}
        empty={empty}
        psychologistNames={psychologistNames}
        actionsFor={actionsFor}
        onAction={handleAppointmentAction}
        onOpen={openAppointmentClient}
        busyId={apptBusyId}
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
          <span role="columnheader">Psychologist</span>
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
            <span role="cell" className="appt-doctor">
              {lead.assigned_psychologist_id ? psychologistNames[lead.assigned_psychologist_id] || "Assigned" : "Not assigned"}
            </span>
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

  // Month calendar on the Appointments page: availability dots and booking counts. A day is "available" when
  // any of the shown psychologists has a free slot for the shortest active service.
  function calendarMeta(day) {
    const ids = calPsychologist === "all" ? schedulablePsychologists.map((item) => item.id) : [calPsychologist];
    const count = appointments.filter(
      (item) =>
        ACTIVE_APPOINTMENT_STATUSES.includes(item.status) &&
        isSameDay(new Date(item.starts_at), day) &&
        (calPsychologist === "all" || String(item.psychologist_id) === String(calPsychologist))
    ).length;
    const future = day.getTime() >= startOfDay(now || new Date()).getTime();
    const available =
      future &&
      ids.some((id) => dayHasFreeSlot(periodsFor(availability, id), day, appointments, { ...slotDefaults, psychologistId: id }));
    return { available, count };
  }

  /* ----- shared renderers ----- */

  function renderDue(lead) {
    const state = getFollowUpState(lead, now);
    if (!lead.next_follow_up_at || CLOSED_STATUSES.includes(lead.status)) return <span className="muted-cell">—</span>;
    const tone = state === "overdue" ? "overdue" : state === "today" ? "today" : "";
    return (
      <span className={`due ${tone}`} title={formatDateTime(lead.next_follow_up_at)}>
        {state === "upcoming" ? formatShort(lead.next_follow_up_at) : `${dueLabel(lead, now)}, ${formatTime(lead.next_follow_up_at)}`}
      </span>
    );
  }

  function updatedByLabel(lead) {
    const name = lastUpdatedBy[lead.id];
    if (!name) return "—";
    return name.trim().toLowerCase() === myName ? "You" : name;
  }

  function psychologistLabel(lead) {
    if (!lead.assigned_psychologist_id) return <span className="muted-cell">Not assigned</span>;
    return psychologistNames[lead.assigned_psychologist_id] || "Assigned";
  }

  function renderPerson(lead, sub) {
    return (
      <div className="cell-person">
        <span className="avatar neutral" aria-hidden="true">
          {initialsOf(lead.full_name)}
        </span>
        <div>
          <strong>{lead.full_name}</strong>
          <span className="cell-sub">{sub}</span>
        </div>
      </div>
    );
  }

  function renderLeadsTable(rows, { compact = false } = {}) {
    const columns = compact ? 5 : 9;
    return (
      <div className="table-wrap">
        <table className="table sticky-first">
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">Status</th>
              {!compact && <th scope="col">Psychologist</th>}
              <th scope="col">Assigned staff</th>
              <th scope="col">Next follow-up</th>
              {!compact && <th scope="col">Source</th>}
              {!compact && <th scope="col">Updated by</th>}
              <th scope="col">Added</th>
              {!compact && (
                <th scope="col">
                  <span className="sr-only">Open</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {leadsLoading &&
              [0, 1, 2, 3, 4].map((row) => (
                <tr key={`skeleton-${row}`} aria-hidden="true">
                  {Array.from({ length: columns }, (_, cell) => (
                    <td key={cell}>
                      <div className="skeleton" style={{ width: cell === 0 ? 150 : 70 }} />
                    </td>
                  ))}
                </tr>
              ))}

            {!leadsLoading && leadsError && (
              <tr className="table-state">
                <td colSpan={columns}>
                  <div className="state error" role="alert">
                    <Icon name="alert" />
                    <strong>Leads could not be loaded</strong>
                    <span>{leadsError}</span>
                    <button type="button" className="btn btn-sm" onClick={() => window.location.reload()}>
                      Reload page
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {!leadsLoading &&
              !leadsError &&
              rows.map((lead) => (
                <tr key={lead.id} className="clickable" onClick={() => openLead(lead)}>
                  <td>
                    {renderPerson(
                      lead,
                      compact ? lead.lead_code : `${lead.lead_code} · ${(lead.phone || "").replace(/\s+/g, "")}`
                    )}
                  </td>
                  <td>
                    <StatusBadge status={lead.status} />
                  </td>
                  {!compact && <td>{psychologistLabel(lead)}</td>}
                  <td>{lead.assigned_staff || <span className="muted-cell">Unassigned</span>}</td>
                  <td>{renderDue(lead)}</td>
                  {!compact && <td>{lead.source}</td>}
                  {!compact && <td className="muted-cell">{updatedByLabel(lead)}</td>}
                  <td className="muted-cell num">{formatDate(lead.created_at)}</td>
                  {!compact && (
                    <td className="right">
                      <button
                        type="button"
                        className="row-btn"
                        onClick={(event) => {
                          event.stopPropagation();
                          openLead(lead);
                        }}
                        aria-label={`Open ${lead.full_name}`}
                      >
                        <Icon name="chevronRight" />
                      </button>
                    </td>
                  )}
                </tr>
              ))}

            {!leadsLoading && !leadsError && rows.length === 0 && (
              <tr className="table-state">
                <td colSpan={columns}>
                  {totalLeads === 0 ? (
                    <div className="state">
                      <Icon name="inbox" />
                      <strong>No leads yet</strong>
                      <span>New enquiries you add will appear here.</span>
                      <button type="button" className="btn btn-primary btn-sm" onClick={openAddForm}>
                        <Icon name="plus" /> Add lead
                      </button>
                    </div>
                  ) : (
                    <div className="state">
                      <Icon name="search" />
                      <strong>No leads match these filters</strong>
                      <span>Try another search, status or source.</span>
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => {
                          setSearch("");
                          setStatusFilter("All");
                          setSourceFilter("All");
                          setOnlyMine(false);
                        }}
                      >
                        Clear filters
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  }

  function renderFollowUpTable(items, { showActions = true } = {}) {
    return (
      <div className="table-wrap">
        <table className="table sticky-first">
          <thead>
            <tr>
              <th scope="col">Lead</th>
              <th scope="col">Due</th>
              <th scope="col">Status</th>
              <th scope="col">Assigned staff</th>
              {showActions && (
                <th scope="col" className="right">
                  <span className="sr-only">Actions</span>
                </th>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((lead) => {
              const busy = followUpBusyIds.includes(lead.id);
              return (
                <tr key={lead.id}>
                  <td>
                    <button type="button" className="link-btn quiet" onClick={() => openLead(lead)} style={{ textAlign: "left" }}>
                      {renderPerson(lead, `${lead.source} · ${(lead.phone || "").replace(/\s+/g, "")}`)}
                    </button>
                  </td>
                  <td>{lead.next_follow_up_at ? renderDue(lead) : <span className="muted-cell">Not scheduled</span>}</td>
                  <td>
                    <StatusBadge status={lead.status} />
                  </td>
                  <td>{lead.assigned_staff || <span className="muted-cell">Unassigned</span>}</td>
                  {showActions && (
                    <td>
                      <div className="actions">
                        {lead.next_follow_up_at ? (
                          <>
                            <button
                              type="button"
                              className="mini-button"
                              disabled={busy}
                              onClick={() => runFollowUpAction(lead, completeFollowUp)}
                            >
                              <Icon name="check" /> Done
                            </button>
                            <button
                              type="button"
                              className="mini-button"
                              disabled={busy}
                              onClick={() => runFollowUpAction(lead, snoozeFollowUp)}
                            >
                              Tomorrow
                            </button>
                          </>
                        ) : (
                          <button type="button" className="mini-button" onClick={() => openLead(lead, "edit")}>
                            Schedule
                          </button>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  function renderUpcomingList(items, empty) {
    if (items.length === 0) return <p className="list-empty">{empty}</p>;
    return (
      <ul className="list">
        {items.map((item) => {
          const lead = leadsById.get(item.lead_id);
          const start = new Date(item.starts_at);
          return (
            <li key={item.id} className="list-row">
              <span className="when">
                {formatTime(item.starts_at)}
                <small>{now && isSameDay(start, now) ? "Today" : formatDate(item.starts_at).slice(0, 6)}</small>
              </span>
              <span className="grow">
                <strong>{lead ? lead.full_name : "Unknown lead"}</strong>
                <span>{psychologistNames[item.psychologist_id] || "Psychologist not set"}</span>
              </span>
              {lead && (
                <button type="button" className="row-btn" onClick={() => openLead(lead)} aria-label={`Open ${lead.full_name}`}>
                  <Icon name="chevronRight" />
                </button>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  /* ----- dashboard ----- */

  function dashPanel(title, sub, body, { action, className = "" } = {}) {
    return (
      <section className={`dash-card ${className}`}>
        <header className="dash-card-head">
          <div>
            <h2>{title}</h2>
            {sub && <p>{sub}</p>}
          </div>
          {action}
        </header>
        <div className="dash-card-body">{body}</div>
      </section>
    );
  }

  // What the charts say while leads are still loading or failed to load, instead of a misleading "no data".
  function chartEmptyProps(fallbackTitle, fallbackText) {
    if (leadsError) return { emptyTitle: "Could not load leads", emptyText: leadsError };
    if (leadsLoading) return { emptyTitle: "Loading leads…", emptyText: "" };
    return { emptyTitle: fallbackTitle, emptyText: fallbackText };
  }

  function rangeOption() {
    return RANGE_OPTIONS.find((item) => item.id === dashRange) || RANGE_OPTIONS[1];
  }

  function deltaText(a, option) {
    const diff = a.total - a.previousCount;
    if (a.previousCount === 0) return a.total ? "none in the previous period" : "none in the previous period either";
    if (diff === 0) return "same as the previous period";
    return `${diff > 0 ? "▲" : "▼"} ${Math.abs(diff)} vs previous ${option.label}`;
  }

  function renderDashboardHero() {
    const a = analytics;
    const option = rangeOption();
    const total = a ? a.total : 0;
    const confirmed = a ? a.byStatus[CONFIRMED_STATUS] || 0 : 0;
    const lost = a ? a.byStatus[LOST_STATUS] || 0 : 0;
    const enquiries = a ? a.byStatus.Enquiry || 0 : 0;
    const pending = leadsLoading || !a;

    const kpis = [
      { label: "Total leads", value: total, icon: "users", status: "All" },
      { label: "New enquiries", value: enquiries, icon: "inbox", status: "Enquiry" },
      { label: "Confirmed", value: confirmed, icon: "userCheck", status: CONFIRMED_STATUS },
      { label: "Lost", value: lost, icon: "alert", status: LOST_STATUS },
      { label: "Upcoming sessions", value: weekAppointments.length, icon: "calendar", page: "Appointments", live: true },
    ];

    return (
      <section className="dash-hero" aria-label="Overview">
        <div className="dash-hero-main">
          <h1 className="dash-greeting">
            {getGreeting(now)}
            {firstName ? `, ${firstName}` : ""}
          </h1>
          <p className="dash-date">
            {now ? `It's ${now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}` : "Today"}
            {" · "}
            {attentionCount > 0
              ? `${attentionCount} follow-up${attentionCount > 1 ? "s" : ""} need${attentionCount > 1 ? "" : "s"} attention`
              : "No follow-ups due"}
          </p>
          <div className="dash-hero-rule" aria-hidden="true" />
          <div className="dash-kpis">
            {kpis.map((kpi) => (
              <button
                key={kpi.label}
                type="button"
                className="dash-kpi"
                onClick={() => (kpi.page ? navigateTo(kpi.page) : goToLeads(kpi.status))}
              >
                <span className="dash-kpi-value">
                  <span className="dash-kpi-icon" aria-hidden="true">
                    <Icon name={kpi.icon} />
                  </span>
                  {pending && !kpi.live ? "…" : kpi.value}
                </span>
                <span className="dash-kpi-label">{kpi.label}</span>
              </button>
            ))}
          </div>
          <p className="dash-kpi-note">
            Lead counts cover the last {option.label}
            {a && !leadsLoading ? ` (${deltaText(a, option)})` : ""}. Sessions cover the next 7 days.
          </p>
        </div>

        <div className="dash-hero-side">
          <div className="dash-hero-tools">
            <RangeTabs
              label="Leads counted"
              value={dashScope}
              onChange={setDashScope}
              options={[
                { id: "all", short: "All", title: "Every lead in the CRM" },
                { id: "mine", short: "Mine", title: "Leads assigned to or updated by you" },
              ]}
            />
            <RangeTabs value={dashRange} onChange={setDashRange} options={RANGE_OPTIONS.map((item) => ({ ...item, title: `Last ${item.label}` }))} />
            {canScheduleAppointments && (
              <button type="button" className="dash-icon-btn" onClick={() => openBooking()} aria-label="Book appointment" title="Book appointment">
                <Icon name="calendar" />
              </button>
            )}
            <button type="button" className="dash-icon-btn primary" onClick={openAddForm} aria-label="Add lead" title="Add lead">
              <Icon name="plus" />
            </button>
          </div>
          <ArcGauge
            value={confirmed}
            total={leadsLoading ? 0 : total}
            label="Lead conversion"
            caption={leadsLoading ? "Loading leads…" : total ? `${confirmed} of ${total} leads confirmed` : "No leads in this period"}
          />
        </div>
      </section>
    );
  }

  function renderSchedule() {
    const today = now ? now.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "Today";
    let items = [];
    let empty = "";
    let page = "Appointments";

    if (dashTab === "appointments") {
      items = nextAppointments.slice(0, 4).map((item) => {
        const lead = leadsById.get(item.lead_id);
        const start = new Date(item.starts_at);
        return {
          id: item.id,
          lead,
          title: lead ? lead.full_name : "Unknown lead",
          sub: psychologistNames[item.psychologist_id] || "Psychologist not set",
          chips: [
            now && isSameDay(start, now) ? "Today" : formatDate(item.starts_at).slice(0, 6),
            `${formatTime(item.starts_at)}${item.ends_at ? ` – ${formatTime(item.ends_at)}` : ""}`,
          ],
          person: lead ? lead.full_name : "",
        };
      });
      empty = "No appointments booked yet.";
    } else if (dashTab === "followups") {
      items = dashboardFollowUps.map((lead) => ({
        id: lead.id,
        lead,
        title: lead.full_name,
        sub: lead.service_interest || lead.source,
        chips: [lead.status, dueLabel(lead, now)].filter(Boolean),
        person: lead.full_name,
      }));
      empty = "No follow-ups are scheduled.";
      page = "Follow Ups";
    } else {
      items = activityLog
        .filter((row) => leadsById.has(row.lead_id))
        .slice(0, 4)
        .map((row, index) => {
          const lead = leadsById.get(row.lead_id);
          return {
            id: `${row.lead_id}-${row.occurred_at}-${index}`,
            lead,
            title: `${row.activity_type || "Update"} · ${lead.full_name}`,
            sub: row.notes || lead.lead_code,
            chips: [relativeTime(row.occurred_at, now), row.staff_member].filter(Boolean),
            person: row.staff_member || lead.full_name,
          };
        });
      empty = "No activity has been recorded yet.";
      page = "Leads";
    }

    return (
      <section className="dash-card dash-schedule">
        <header className="dash-schedule-head">
          <span className="dash-date-pill">
            <Icon name="calendar" /> {today}
          </span>
          <h2>Schedule</h2>
          <button
            type="button"
            className="dash-icon-btn round"
            onClick={() => (page === "Leads" ? goToLeads("All") : navigateTo(page))}
            aria-label={`Open ${page}`}
            title={`Open ${page}`}
          >
            <Icon name="arrowUpRight" />
          </button>
        </header>
        <div className="dash-tabs" role="tablist" aria-label="Schedule">
          {[
            ["appointments", "Sessions"],
            ["followups", "Follow-ups"],
            ["activity", "Activity"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={dashTab === id}
              className={dashTab === id ? "is-active" : ""}
              onClick={() => setDashTab(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="dash-schedule-list" role="tabpanel">
          {items.length === 0 ? (
            <div className="chart-empty">
              <strong>Nothing here yet</strong>
              <span>{empty}</span>
            </div>
          ) : (
            items.map((item, index) => (
              <button
                key={item.id}
                type="button"
                className={`dash-event ${index === 0 ? "featured" : ""}`}
                onClick={() => item.lead && openLead(item.lead)}
              >
                <span className="dash-event-title">{item.title}</span>
                <span className="dash-event-sub">{item.sub}</span>
                <span className="dash-event-foot">
                  {item.chips.map((chip) => (
                    <span key={chip} className="dash-chip">
                      {chip}
                    </span>
                  ))}
                  {item.person && <Avatar name={item.person} />}
                </span>
              </button>
            ))
          )}
        </div>
      </section>
    );
  }

  function renderTrendCard() {
    const a = analytics;
    const option = rangeOption();
    return (
      <section className="dash-card dash-trend">
        <header className="dash-trend-head">
          <div>
            <span className="dash-figure">
              <span className="dash-kpi-icon" aria-hidden="true">
                <Icon name="chart" />
              </span>
              {a && !leadsLoading ? a.total : "…"}
            </span>
            <p>New leads · last {option.label}</p>
          </div>
          <button type="button" className="dash-icon-btn round" onClick={() => navigateTo("Reports")} aria-label="Open reports" title="Open reports">
            <Icon name="arrowUpRight" />
          </button>
        </header>
        {a && a.total > 0 && (
          <Legend
            items={[
              { label: `New leads per ${option.unit}`, color: "var(--chart-1)" },
              { label: "Now confirmed", color: "var(--chart-2)" },
            ]}
          />
        )}
        {a && (
          <LineChart
            height={200}
            data={a.trend}
            series={[
              { id: "leads", label: "New leads", color: "var(--chart-1)" },
              { id: "confirmed", label: "Now confirmed", color: "var(--chart-2)" },
            ]}
            {...chartEmptyProps("No leads in this period", `Nothing was added in the last ${option.label}. Try a longer range.`)}
          />
        )}
      </section>
    );
  }

  function renderStatusCard() {
    const a = analytics;
    const tone = (status) => (status === CONFIRMED_STATUS ? "accent" : status === LOST_STATUS ? "dark" : "muted");
    return (
      <section className="dash-card dash-status">
        <header className="dash-card-head">
          <div>
            <h2>Lead status</h2>
          </div>
          <button type="button" className="dash-icon-btn round" onClick={() => goToLeads("All")} aria-label="Open leads" title="Open leads">
            <Icon name="arrowUpRight" />
          </button>
        </header>
        <div className="dash-status-total">
          <strong>{a && !leadsLoading ? a.total : "…"}</strong>
          <span>Leads in period</span>
        </div>
        {a && (
          <StatusColumns
            height={244}
            rows={STATUSES.map((status) => ({ key: status, label: status, value: a.byStatus[status] || 0, tone: tone(status) }))}
            total={leadsLoading ? 0 : a.total}
            onSelect={(row) => goToLeads(row.key)}
            {...chartEmptyProps("No leads in this period", "Statuses will chart here.")}
          />
        )}
      </section>
    );
  }

  function renderTiles() {
    const tiles = [
      { label: "Overdue follow-ups", value: followUps.overdue.length, tone: "danger", action: "Follow up", page: "Follow Ups" },
      { label: "Due today", value: followUps.today.length, tone: "warning", action: "Follow up", page: "Follow Ups" },
      { label: "Upcoming follow-ups", value: followUps.upcoming.length, tone: "info", action: "View", page: "Follow Ups" },
      { label: "No follow-up set", value: followUps.unscheduled.length, tone: "neutral", action: "Plan", page: "Follow Ups" },
      { label: "Ready to book", value: confirmedWithoutBooking.length, tone: "success", action: "Book", page: "Confirmed" },
    ];
    return (
      <div className="dash-tiles">
        {tiles.map((tile) => (
          <button key={tile.label} type="button" className="dash-tile" onClick={() => navigateTo(tile.page)}>
            <span className={`dash-tile-dot fill-${tile.tone}`} aria-hidden="true" />
            <span className="dash-tile-label">{tile.label}</span>
            <span className="dash-tile-value">
              {leadsLoading ? "…" : tile.value} <small>{tile.value === 1 ? "lead" : "leads"}</small>
            </span>
            <span className="dash-tile-foot">
              {tile.action}
              <span className="dash-tile-arrow" aria-hidden="true">
                <Icon name="arrowUpRight" />
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }

  function renderDashboardAnalytics() {
    if (!analytics) return null;
    const a = analytics;
    const rangeName = `last ${a.period.option.label}`;
    const perUnit = a.period.option.unit;
    const noLeads = chartEmptyProps("No leads in this period", `Nothing was added in the ${rangeName}. Try a longer range.`);

    return (
      <div className="dash-grid quarters">
        {dashPanel(
          "Lead sources",
          "Where this period's leads came from.",
          <BarList ariaLabel="Leads by source" rows={a.sources} total={a.total} {...noLeads} />
        )}
        {dashPanel(
          "Psychologist performance",
          "Assigned vs confirmed leads in this period.",
          <>
            <GroupedBars
              rows={a.psychologistRows}
              series={[
                { id: "assigned", label: "Assigned", color: "var(--chart-1)" },
                { id: "confirmed", label: "Confirmed", color: "var(--chart-2)" },
              ]}
              {...chartEmptyProps("No assigned leads", `No lead from the ${rangeName} has a psychologist yet.`)}
            />
            {a.unassignedCount > 0 && (
              <p className="dash-note">
                {a.unassignedCount} open lead{a.unassignedCount > 1 ? "s" : ""} in this period without a psychologist.
              </p>
            )}
          </>
        )}
        {dashPanel(
          "Appointments",
          "Sessions scheduled in this period.",
          <>
            <div className="dash-rings">
              <RingGauge
                size={108}
                stroke={9}
                value={a.completed}
                total={a.resolved}
                label="Completed"
                caption={a.resolved ? `${a.completed} of ${a.resolved} finished` : "None finished yet"}
              />
              <RingGauge
                size={108}
                stroke={9}
                color="var(--chart-2)"
                value={a.confirmedBooked}
                total={a.confirmedTotal}
                label="Booked"
                caption={a.confirmedTotal ? `${a.confirmedBooked} of ${a.confirmedTotal} confirmed` : "No confirmed leads"}
              />
            </div>
            <LineChart
              height={110}
              data={a.appointmentTrend}
              series={[{ id: "booked", label: "Appointments", color: "var(--chart-1)" }]}
              ariaLabel={`Appointments per ${perUnit}: ${a.appointmentTrend.map((row) => `${row.full} ${row.booked}`).join(", ")}`}
              emptyTitle="No appointments in this period"
              emptyText="Booked sessions will chart here."
            />
            <ul className="dash-chips" aria-label="Appointments by status">
              {a.appointmentStatus.map((row) => (
                <li key={row.key}>
                  {row.label} <b>{row.value}</b>
                </li>
              ))}
            </ul>
          </>
        )}
        {dashPanel(
          "Follow-up progress",
          "Open leads in the current scope.",
          <div className="meters">
            <ProgressMeter label="Follow-ups on schedule" value={a.onSchedule} total={a.withFollowUp} hint="not overdue" />
            <ProgressMeter label="Open leads with a follow-up planned" value={a.withFollowUp} total={a.openLeads} hint="open leads" />
            <ProgressMeter label="Appointments resolved" value={a.resolved} total={a.appointmentCount} hint="completed, cancelled or missed" />
          </div>
        )}
      </div>
    );
  }

  function renderRecentLeadsCard() {
    const term = dashSearch.trim().toLowerCase();
    const digits = term.replace(/\s+/g, "");
    const rows = [...leads]
      .filter(
        (lead) =>
          !term ||
          [lead.full_name, lead.email, lead.lead_code, lead.source, lead.status].some((field) => (field || "").toLowerCase().includes(term)) ||
          (digits && (lead.phone || "").replace(/\s+/g, "").includes(digits))
      )
      .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))
      .slice(0, 6);

    return (
      <section className="dash-card">
        <header className="dash-card-head dash-list-head">
          <div>
            <h2>Recent leads</h2>
          </div>
          <div className="dash-list-tools">
            <label className="dash-search">
              <Icon name="search" />
              <span className="sr-only">Search recent leads</span>
              <input type="search" placeholder="Search" value={dashSearch} onChange={(event) => setDashSearch(event.target.value)} />
            </label>
            <button type="button" className="dash-icon-btn round" onClick={() => goToLeads("All")} aria-label="All leads" title="All leads">
              <Icon name="arrowUpRight" />
            </button>
          </div>
        </header>
        <div className="dash-list-body">{renderLeadsTable(rows, { compact: true })}</div>
      </section>
    );
  }

  function countBy(getKey) {
    const map = new Map();
    leads.forEach((lead) => {
      const key = getKey(lead);
      if (key) map.set(key, (map.get(key) || 0) + 1);
    });
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }

  function renderBreakdown(title, rows, emptyText, firstColumn) {
    const total = rows.reduce((sum, [, count]) => sum + count, 0);
    return (
      <section className="section">
        <div className="section-head">
          <h2>{title}</h2>
        </div>
        <div className="panel">
          {rows.length === 0 ? (
            <p className="list-empty">{emptyText}</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th scope="col">{firstColumn}</th>
                    <th scope="col" className="right">
                      Leads
                    </th>
                    <th scope="col" style={{ width: "40%" }}>
                      Share
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map(([key, count]) => (
                    <tr key={key}>
                      <td className="wrap">{STATUSES.includes(key) ? <StatusBadge status={key} /> : key}</td>
                      <td className="right num">{count}</td>
                      <td>
                        <div className="bar-track" aria-label={`${Math.round((count / total) * 100)}%`}>
                          <span style={{ width: `${(count / total) * 100}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </section>
    );
  }

  /* ----- render ----- */

  const navItems = CRM_NAV.map((item) =>
    item.id === "Follow Ups" ? { ...item, count: attentionCount || undefined } : item
  );
  const attentionTotal = unreadCount + reminders.length + attentionCount;
  const overdueCount = followUps.overdue.length;
  const confirmedShare = totalLeads ? Math.round((confirmedCount / totalLeads) * 100) : 0;
  const nextAppointments = [...upcomingAppointments]
    .filter((item) => !now || new Date(item.starts_at).getTime() >= now.getTime() - 15 * 60000)
    .sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));
  const firstName = (currentStaff.name || "").split(" ")[0];

  const headerActions = (
    <div className="popover-wrap">
      <button
        type="button"
        className="icon-btn"
        aria-label={`Notifications${attentionTotal > 0 ? `, ${attentionTotal} need attention` : ""}`}
        aria-expanded={notifOpen}
        aria-haspopup="dialog"
        onClick={() => setNotifOpen((open) => !open)}
      >
        <Icon name="bell" />
        {attentionTotal > 0 && <span className="dot" />}
      </button>

      {notifOpen && (
        <div className="menu notif-panel" role="dialog" aria-label="Notifications">
          <div className="notif-head">
            <strong>Notifications</strong>
            {notifications.length > 0 && (
              <button
                type="button"
                className="text-button"
                onClick={() => setNotifications((current) => current.map((item) => ({ ...item, read: true })))}
              >
                Mark all read
              </button>
            )}
          </div>
          <div className="notif-list">
            {attentionCount > 0 && (
              <button type="button" className="notif-item" onClick={() => navigateTo("Follow Ups")}>
                <strong>
                  {attentionCount} follow-up{attentionCount > 1 ? "s" : ""} need attention
                </strong>
                <small>{overdueCount > 0 ? `${overdueCount} overdue` : "Due today"}</small>
              </button>
            )}
            {reminders.map((item) => {
              const lead = leadsById.get(item.lead_id);
              return (
                <button type="button" className="notif-item" key={`r-${item.id}`} onClick={() => navigateTo("Confirmed")}>
                  <strong>
                    {lead ? lead.full_name : "Appointment"} at {formatTime(item.starts_at)}
                  </strong>
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
              <p className="notif-empty">You are all caught up.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );

  const pageTitle = (CRM_NAV.find((item) => item.id === activePage) || {}).label || activePage;

  return (
    <AppShell
      nav={navItems}
      activeId={activePage}
      onNavigate={openPage}
      workspaceLabel="Client relations"
      crumbs={activePage === "Dashboard" ? [{ label: "Dashboard" }] : [{ label: "Dashboard", onClick: () => openPage("Dashboard") }, { label: pageTitle }]}
      headerActions={headerActions}
      user={{ name: currentStaff.name, email: currentStaff.email, roleLabel: roleLabel(currentStaff.role) }}
    >
      {activePage === "Dashboard" && (
        <div className="dash">
          {renderDashboardHero()}

          <div className="dash-main">
            {renderSchedule()}
            {renderTrendCard()}
            {renderStatusCard()}
            {renderTiles()}
          </div>

          {renderDashboardAnalytics()}
          {renderRecentLeadsCard()}
        </div>
      )}

      {activePage === "Leads" && (
        <>
          <header className="page-head">
            <div>
              <h1>Leads</h1>
              <p>
                {totalLeads} leads · {activeCount} open · {lostCount} lost
              </p>
            </div>
            <div className="page-actions">
              <button type="button" className="btn btn-primary" onClick={openAddForm}>
                <Icon name="plus" /> Add lead
              </button>
            </div>
          </header>

          <section className="panel" aria-label="Lead list">
            <div className="tabs" role="tablist" aria-label="Filter by status">
              {["All", ...STATUSES].map((status) => (
                <button
                  key={status}
                  type="button"
                  role="tab"
                  className="tab"
                  aria-selected={statusFilter === status}
                  onClick={() => setStatusFilter(status)}
                >
                  {status === "All" ? "All" : status}
                  <span className="tab-count">{status === "All" ? totalLeads : statusCounts[status]}</span>
                </button>
              ))}
            </div>

            <div className="toolbar">
              <label className="search">
                <Icon name="search" />
                <input
                  type="search"
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Search name, phone, ID, staff"
                  aria-label="Search leads"
                />
              </label>
              <select value={sourceFilter} onChange={(event) => setSourceFilter(event.target.value)} aria-label="Filter by source">
                <option value="All">All sources</option>
                {[...new Set([...SOURCES, ...leads.map((lead) => lead.source).filter(Boolean)])].map((source) => (
                  <option key={source} value={source}>
                    {source}
                  </option>
                ))}
              </select>
              <div className="seg" role="group" aria-label="Whose leads">
                <button type="button" aria-pressed={!onlyMine} onClick={() => setOnlyMine(false)}>
                  Everyone
                </button>
                <button type="button" aria-pressed={onlyMine} onClick={() => setOnlyMine(true)}>
                  Mine <span className="tab-count">{myLeadIds.size}</span>
                </button>
              </div>
              <span className="spacer" />
              <span className="count" aria-live="polite">
                {filteredLeads.length === totalLeads ? `${totalLeads} leads` : `${filteredLeads.length} of ${totalLeads}`}
              </span>
            </div>

            {renderLeadsTable(filteredLeads)}
          </section>
        </>
      )}

      {activePage === "Follow Ups" && (
        <>
          <header className="page-head">
            <div>
              <h1>Follow-ups</h1>
              <p>Every scheduled conversation, in the order it needs attention.</p>
            </div>
            <div className="page-actions">
              <button type="button" className="btn btn-primary" onClick={openAddForm}>
                <Icon name="plus" /> Add lead
              </button>
            </div>
          </header>

          <section className="kpis" aria-label="Follow-up summary">
            <div className="kpi">
              <span className="kpi-label">Overdue</span>
              <span className="kpi-value">{followUps.overdue.length}</span>
              <span className={`kpi-meta ${followUps.overdue.length ? "warn" : ""}`}>{followUps.overdue.length ? "Needs action" : "Nothing overdue"}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Due today</span>
              <span className="kpi-value">{followUps.today.length}</span>
              <span className="kpi-meta">Before end of day</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Upcoming</span>
              <span className="kpi-value">{followUps.upcoming.length}</span>
              <span className="kpi-meta">Scheduled later</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">No date set</span>
              <span className="kpi-value">{followUps.unscheduled.length}</span>
              <span className="kpi-meta">Open leads</span>
            </div>
          </section>

          {[
            { title: "Overdue", items: followUps.overdue },
            { title: "Due today", items: followUps.today },
            { title: "Upcoming", items: followUps.upcoming },
            { title: "Needs a follow-up date", items: followUps.unscheduled },
          ].map((group) =>
            group.items.length > 0 ? (
              <section className="section" key={group.title}>
                <div className="section-head">
                  <h2>
                    {group.title} <span className="muted num">{group.items.length}</span>
                  </h2>
                </div>
                <div className="panel">{renderFollowUpTable(group.items)}</div>
              </section>
            ) : null
          )}

          {openFollowUpCount === 0 && followUps.unscheduled.length === 0 && (
            <div className="panel">
              <div className="state">
                <Icon name="checkCircle" />
                <strong>You are all caught up</strong>
                <span>No follow-ups are scheduled right now.</span>
              </div>
            </div>
          )}
        </>
      )}

      {activePage === "Appointments" && (
        <>
          <header className="page-head">
            <div>
              <h1>Appointments</h1>
              <p>Pick a date to see bookings and free slots. Booked sessions are listed under Confirmed.</p>
            </div>
            {canScheduleAppointments && (
              <div className="page-actions">
                <button type="button" className="btn btn-primary" onClick={() => openBooking()}>
                  <Icon name="plus" /> Book appointment
                </button>
              </div>
            )}
          </header>

          {schedulingState === "missing" && (
            <div className="notice" role="status">
              <Icon name="info" />
              <div>
                <strong>Appointments are not set up in the database yet</strong>
                Apply migrations 202611030002 and 202611040001 in Supabase. Until then nothing can be booked or saved.
              </div>
            </div>
          )}
          {schedulingState === "error" && (
            <div className="notice" role="alert">
              <Icon name="alert" />
              <div>
                <strong>Could not load appointments</strong>
                Check your connection.{" "}
                <button type="button" className="link-btn" onClick={() => setSchedulingReload((value) => value + 1)}>
                  Try again
                </button>
              </div>
            </div>
          )}

          <section className="kpis" aria-label="Appointment summary">
            <div className="kpi">
              <span className="kpi-label">Today</span>
              <span className="kpi-value">{todayAppointments.length}</span>
              <span className="kpi-meta">Appointments</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Next 7 days</span>
              <span className="kpi-value">{weekAppointments.length}</span>
              <span className="kpi-meta">Booked</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Awaiting confirmation</span>
              <span className="kpi-value">{unconfirmedLeads.length}</span>
              <span className="kpi-meta">Leads</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Ready to book</span>
              <span className="kpi-value">{confirmedWithoutBooking.length}</span>
              <span className="kpi-meta">Confirmed leads</span>
            </div>
          </section>

          {reminders.length > 0 && (
            <section className="section">
              <div className="section-head">
                <h2>Starting soon</h2>
              </div>
              <div className="panel">{renderUpcomingList(reminders, "")}</div>
            </section>
          )}

          <section className="panel appt-layout" aria-label="Calendar">
            <div className="appt-cal">
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
                anchor={calAnchor || (now ? new Date(now.getFullYear(), now.getMonth(), 1) : new Date(2026, 0, 1))}
                onAnchorChange={setCalAnchor}
                selected={calDay}
                today={now ? startOfDay(now) : null}
                getMeta={calendarMeta}
                onSelect={setCalDay}
              />
            </div>

            <div className="appt-day">
              {calDay ? (
                <>
                  <h2 className="appt-day-title">
                    {calDay.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}
                  </h2>
                  <h3 className="appt-sub">Booked</h3>
                  <div className="panel">
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
                  </div>

                  <h3 className="appt-sub">
                    Free slots{" "}
                    <span className="muted">
                      ({slotDefaults.durationMinutes} min{slotDefaults.bufferMinutes ? ` + ${slotDefaults.bufferMinutes} min buffer` : ""})
                    </span>
                  </h3>
                  <div>
                    {schedulablePsychologists.length === 0 && <p className="appt-empty inline">No psychologists are available to schedule.</p>}
                    {schedulablePsychologists
                      .filter((item) => calPsychologist === "all" || String(item.id) === String(calPsychologist))
                      .map((item) => {
                        const free = slotsForDay(periodsFor(availability, item.id), calDay, appointments, {
                          ...slotDefaults,
                          psychologistId: item.id,
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
                  </div>
                </>
              ) : (
                <div className="state">
                  <Icon name="calendar" />
                  <strong>Select a date</strong>
                  <span>Dates with a green dot have free slots. A number shows bookings already on that day.</span>
                </div>
              )}
            </div>
          </section>

          <section className="section">
            <div className="section-head">
              <div>
                <h2>
                  Awaiting confirmation <span className="muted num">{unconfirmedLeads.length}</span>
                </h2>
                <p>These leads can be booked once their status is Confirmed and a psychologist is assigned.</p>
              </div>
            </div>
            <div className="panel">{renderLeadTable(unconfirmedLeads, "No leads are waiting for confirmation.")}</div>
          </section>
        </>
      )}

      {activePage === "Confirmed" && (
        <>
          <header className="page-head">
            <div>
              <h1>Confirmed</h1>
              <p>Appointments for confirmed clients. Record client confirmation, attendance, cancellations and reschedules here.</p>
            </div>
            {canScheduleAppointments && (
              <div className="page-actions">
                <button type="button" className="btn btn-primary" onClick={() => openBooking()}>
                  <Icon name="plus" /> Book appointment
                </button>
              </div>
            )}
          </header>

          {schedulingState === "missing" && (
            <div className="notice" role="status">
              <Icon name="info" />
              <div>
                <strong>Appointments are not set up in the database yet</strong>
                Apply migrations 202611030002 and 202611040001 in Supabase. Until then nothing can be booked or saved.
              </div>
            </div>
          )}
          {schedulingState === "error" && (
            <div className="notice" role="alert">
              <Icon name="alert" />
              <div>
                <strong>Could not load appointments</strong>
                Check your connection.{" "}
                <button type="button" className="link-btn" onClick={() => setSchedulingReload((value) => value + 1)}>
                  Try again
                </button>
              </div>
            </div>
          )}

          <section className="section">
            <div className="section-head">
              <h2>
                Upcoming <span className="muted num">{upcomingAppointments.length}</span>
              </h2>
            </div>
            <div className="panel">
              {renderAppointmentTable(
                [...upcomingAppointments].sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at)),
                "No upcoming appointments. Book one for a confirmed client."
              )}
            </div>
          </section>

          {confirmedWithoutBooking.length > 0 && (
            <section className="section">
              <div className="section-head">
                <div>
                  <h2>
                    Confirmed, not booked <span className="muted num">{confirmedWithoutBooking.length}</span>
                  </h2>
                  <p>Pick a free slot with the assigned psychologist.</p>
                </div>
              </div>
              <div className="panel">
                {renderLeadTable(confirmedWithoutBooking, "", (lead) =>
                  canScheduleAppointments ? (
                    <button type="button" className="appt-btn dark" onClick={() => openBooking(lead)}>
                      Book
                    </button>
                  ) : null
                )}
              </div>
            </section>
          )}

          {pastAppointments.length > 0 && (
            <section className="section">
              <div className="section-head">
                <div>
                  <h2>
                    History <span className="muted num">{pastAppointments.length}</span>
                  </h2>
                  <p>Completed, missed, cancelled and rescheduled appointments. Nothing is deleted.</p>
                </div>
              </div>
              <div className="panel">{renderAppointmentTable(pastAppointments, "")}</div>
            </section>
          )}
        </>
      )}

      {activePage === "Reports" && (
        <>
          <header className="page-head">
            <div>
              <h1>Reports</h1>
              <p>Breakdowns from the lead records currently in the CRM.</p>
            </div>
          </header>

          <section className="kpis" aria-label="Report summary">
            <div className="kpi">
              <span className="kpi-label">Total leads</span>
              <span className="kpi-value">{totalLeads}</span>
              <span className="kpi-meta">All time</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Confirmed</span>
              <span className="kpi-value">{confirmedCount}</span>
              <span className="kpi-meta">{totalLeads ? `${confirmedShare}% of leads` : "—"}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Lost</span>
              <span className="kpi-value">{lostCount}</span>
              <span className="kpi-meta">{totalLeads ? `${Math.round((lostCount / totalLeads) * 100)}% of leads` : "—"}</span>
            </div>
            <div className="kpi">
              <span className="kpi-label">Staff with leads</span>
              <span className="kpi-value">{staffCount}</span>
              <span className="kpi-meta">Assigned staff</span>
            </div>
          </section>

          <div className="split even">
            {renderBreakdown(
              "Leads by status",
              STATUSES.map((status) => [status, statusCounts[status]]).filter(([, count]) => count > 0),
              "No leads yet.",
              "Status"
            )}
            {renderBreakdown("Leads by source", countBy((lead) => lead.source), "No leads yet.", "Source")}
            {renderBreakdown(
              "Why leads were lost",
              countBy((lead) => (lead.status === LOST_STATUS ? parseLostReason(lead.not_converted_reason).choice || "No reason recorded" : "")),
              "No lost leads.",
              "Reason"
            )}
            {renderBreakdown("Leads per staff member", countBy((lead) => (lead.assigned_staff || "").trim() || "Unassigned"), "No leads yet.", "Staff member")}
          </div>
        </>
      )}

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
        <Dialog
          titleId="lead-fetch-title"
          title={selectedLeadLoading ? "Loading lead" : "Could not load lead"}
          onClose={closeLeadDetails}
          small
          footer={
            selectedLeadError ? (
              <>
                <button type="button" className="btn" onClick={closeLeadDetails}>
                  Close
                </button>
                <button
                  type="button"
                  className="btn btn-primary"
                  onClick={() => {
                    const lead = leads.find((item) => item.id === selectedLeadId);
                    if (lead) openLead(lead, selectedLeadTab);
                    else closeLeadDetails();
                  }}
                >
                  Try again
                </button>
              </>
            ) : null
          }
        >
          <div className="modal-body" role={selectedLeadError ? "alert" : "status"}>
            {selectedLeadError || (
              <>
                <div className="skeleton" style={{ width: "60%" }} />
                <div className="skeleton" style={{ width: "40%" }} />
              </>
            )}
          </div>
        </Dialog>
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
          psychologists={psychologists}
          availability={availability}
          psychologistsState={psychologistsState}
          onRetryPsychologists={() => setPsychologistsReload((value) => value + 1)}
          assignmentSupported={assignmentSupported}
          appointmentActionsFor={actionsFor}
          canScheduleAppointments={canScheduleAppointments}
          hasClientProfile={clientsByLead.has(selectedLead.id)}
          onRequestBooking={openBooking}
          onAppointmentAction={runAppointmentAction}
          onClose={closeLeadDetails}
          onSave={handleSaveLead}
          onLoadActivities={loadLeadActivities}
          onLogActivity={logLeadActivity}
          activityRevision={activityRevisions[selectedLead.id] || 0}
          initialTab={selectedLeadTab}
          followUpBusy={followUpBusyIds.includes(selectedLead.id)}
          onCompleteFollowUp={(item) => runFollowUpAction(item, completeFollowUp)}
          onSnoozeFollowUp={(item) => runFollowUpAction(item, snoozeFollowUp)}
        />
      )}

      {bookingDialog && (
        <BookingModal
          key={bookingDialog.mode + (bookingDialog.appointment ? bookingDialog.appointment.id : bookingDialog.client ? bookingDialog.client.id : "new")}
          mode={bookingDialog.mode}
          lockedClient={bookingDialog.client || null}
          appointment={bookingDialog.appointment}
          clients={clients.filter((item) => item.is_active)}
          psychologists={schedulablePsychologists}
          services={services.filter((item) => item.is_active)}
          availability={availability}
          blocks={blocks}
          appointments={appointments}
          now={now}
          onClose={() => setBookingDialog(null)}
          onSubmit={submitBooking}
        />
      )}

      {cancelTarget && (
        <ReasonDialog
          title="Cancel appointment"
          subtitle={`${cancelTarget.client_name}, ${formatDateTime(cancelTarget.starts_at)}. The record and its original time are kept; the slot becomes free.`}
          label="Reason for cancellation"
          confirmLabel="Cancel appointment"
          danger
          onClose={() => setCancelTarget(null)}
          onSubmit={submitCancellation}
        />
      )}

      {notice && (
        <div className={`toast ${noticeTone === "error" ? "error" : ""}`} role={noticeTone === "error" ? "alert" : "status"} aria-live="polite">
          <Icon name={noticeTone === "error" ? "alert" : "check"} /> {notice}
        </div>
      )}
    </AppShell>
  );
}
