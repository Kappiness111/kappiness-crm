"use client";

import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "../../utils/supabase/client";
import AppointmentDetailsPanel from "../components/psychologist-dashboard/AppointmentDetailsPanel";
import AvailabilitySummary from "../components/psychologist-dashboard/AvailabilitySummary";
import DashboardOverview from "../components/psychologist-dashboard/DashboardOverview";
import PsychologistCalendar from "../components/psychologist-dashboard/PsychologistCalendar";
import PsychologistSidebar from "../components/psychologist-dashboard/PsychologistSidebar";
import styles from "../components/psychologist-dashboard/dashboard.module.css";
import useIsNarrow from "../components/psychologist-dashboard/useIsNarrow";
import Icon from "../components/Icon";
import {
  addDays,
  addMonthsClamped,
  getVisibleRange,
  startOfDay,
} from "../lib/calendar";
import { describeError } from "../lib/psychologists";
import { getPsychologist, getPsychologistByAuthUser, listAvailability } from "../lib/psychologistsApi";
import {
  CAPABILITIES,
  fetchAppointments,
  recommendFollowUp,
  updateSessionStatus,
} from "../lib/psychologistAppointments";
import { getStaffName } from "../lib/staff";

// Preview mode exists only in `npm run dev` (never in a production build). It lets staff or admins review
// this screen without being a psychologist. It does not bypass any permission: data still loads through
// the signed-in user's normal access rules.
//   /psychologist?preview=1        empty preview (no psychologist data)
//   /psychologist?as=<profile id>  preview as an existing psychologist profile the user is allowed to read
const PREVIEW_ENABLED = process.env.NODE_ENV !== "production";

const SECTION_TITLES = {
  dashboard: "Dashboard",
  calendar: "My Calendar",
  availability: "My Availability",
  profile: "Profile",
};

function PsychologistDashboard() {
  const router = useRouter();
  const narrow = useIsNarrow();

  const [now, setNow] = useState(() => new Date());
  const [section, setSection] = useState("dashboard");
  const [menuOpen, setMenuOpen] = useState(false);
  const [loggingOut, setLoggingOut] = useState(false);

  // auth + profile: { status: "loading" | "ready" | "no-profile" | "error", user, psychologist, message }
  const [auth, setAuth] = useState({ status: "loading", user: null, psychologist: null, message: "", preview: false });

  // availability
  const [periodsState, setPeriodsState] = useState({ key: "", items: [], error: "" });
  const [periodsTick, setPeriodsTick] = useState(0);

  // calendar
  const [view, setView] = useState("week");
  const [anchor, setAnchor] = useState(() => startOfDay(new Date()));
  const [selected, setSelected] = useState(() => startOfDay(new Date()));
  const [apptState, setApptState] = useState({ key: "", items: [], supported: true, error: "" });
  const [apptTick, setApptTick] = useState(0);

  const [openAppointment, setOpenAppointment] = useState(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [toast, setToast] = useState(null);

  const psychologist = auth.psychologist;
  const psychologistId = psychologist ? psychologist.id : null;

  // Keeps "today" and the current-time line fresh.
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 60000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  // Identify the psychologist from the signed-in user (existing auth_user_id mapping).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        const supabase = createClient();
        const { data } = await supabase.auth.getUser();
        const user = data && data.user;
        if (!user) {
          router.replace("/login");
          return;
        }
        let profile = await getPsychologistByAuthUser(user.id);
        let preview = false;

        if (!profile && PREVIEW_ENABLED) {
          const params = new URLSearchParams(window.location.search);
          const asId = params.get("as");
          if (asId) profile = await getPsychologist(asId);
          if (!profile && (asId || params.has("preview"))) {
            profile = { id: null, name: "Preview", phone: "", active: true, hasLogin: false, createdAt: "" };
          }
          preview = Boolean(profile);
        }

        if (cancelled) return;
        setAuth(
          profile
            ? { status: "ready", user, psychologist: profile, message: "", preview }
            : { status: "no-profile", user, psychologist: null, message: "", preview: false }
        );
      } catch (error) {
        console.error("Failed to load psychologist profile:", error);
        if (!cancelled) {
          setAuth({
            status: "error",
            user: null,
            psychologist: null,
            message: describeError(error, "Could not load your profile. Please try again."),
            preview: false,
          });
        }
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [router]);

  // Recurring availability from the existing psychologist_availability table.
  const periodsKey = psychologistId ? `${psychologistId}|${periodsTick}` : "";
  useEffect(() => {
    if (!psychologistId) return undefined;
    let cancelled = false;
    listAvailability(psychologistId)
      .then((items) => {
        if (!cancelled) setPeriodsState({ key: periodsKey, items, error: "" });
      })
      .catch((error) => {
        console.error("Failed to load availability:", error);
        if (!cancelled) {
          setPeriodsState({ key: periodsKey, items: [], error: describeError(error, "Could not load your availability.") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, periodsKey]);

  const periodsLoading = Boolean(psychologistId) && periodsState.key !== periodsKey;

  // Appointments for what the calendar shows, plus the next 30 days for the overview numbers.
  const effectiveView = narrow && view === "week" ? "day" : view;
  const fetchRange = useMemo(() => {
    const visible = getVisibleRange(narrow && effectiveView === "day" ? "week" : effectiveView, anchor);
    const today = startOfDay(now);
    const start = visible.start < today ? visible.start : today;
    const horizon = addDays(today, 30);
    const end = visible.end > horizon ? visible.end : horizon;
    return { start, end };
  }, [narrow, effectiveView, anchor, now]);

  const apptKey = psychologistId
    ? `${psychologistId}|${+fetchRange.start}|${+fetchRange.end}|${apptTick}`
    : "";

  useEffect(() => {
    if (!psychologistId) return undefined;
    let cancelled = false;
    fetchAppointments(psychologistId, fetchRange.start, fetchRange.end)
      .then((result) => {
        if (!cancelled) setApptState({ key: apptKey, items: result.items, supported: result.supported, error: "" });
      })
      .catch((error) => {
        console.error("Failed to load appointments:", error);
        if (!cancelled) {
          setApptState({
            key: apptKey,
            items: [],
            supported: true,
            error: describeError(error, "Could not load appointments. Please try again."),
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, apptKey, fetchRange]);

  const apptLoading = Boolean(psychologistId) && apptState.key !== apptKey;

  /* ----- calendar navigation ----- */

  function shift(direction) {
    const move = (date) => {
      if (effectiveView === "month") return addMonthsClamped(date, direction);
      return addDays(date, (effectiveView === "week" ? 7 : 1) * direction);
    };
    setAnchor((current) => move(current));
    setSelected((current) => move(current));
  }

  function goToday() {
    const today = startOfDay(new Date());
    setAnchor(today);
    setSelected(today);
  }

  function selectDate(date) {
    const day = startOfDay(date);
    setSelected(day);
    if (effectiveView === "day" || day.getMonth() !== anchor.getMonth()) setAnchor(day);
  }

  function changeView(next) {
    setView(next);
    setAnchor(selected);
  }

  /* ----- appointment actions (all through the adapter) ----- */

  async function handleStatus(appointment, status) {
    setActionBusy(true);
    const result = await updateSessionStatus(appointment.id, status);
    setActionBusy(false);
    if (result.ok) {
      setToast({ message: "Session updated", tone: "success" });
      setOpenAppointment(null);
      setApptTick((tick) => tick + 1);
    } else {
      setToast({ message: result.message, tone: "error" });
    }
  }

  async function handleRecommend(values) {
    const result = await recommendFollowUp(values);
    if (result.ok) {
      setToast({ message: "Follow-up recommended", tone: "success" });
      setOpenAppointment(null);
      setApptTick((tick) => tick + 1);
    }
    return result;
  }

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await createClient().auth.signOut();
    } catch (error) {
      console.error("Sign out failed:", error);
    }
    router.replace("/login");
    router.refresh();
  }

  const navigate = useCallback((id) => {
    setSection(id);
    setMenuOpen(false);
    window.scrollTo({ top: 0 });
  }, []);

  /* ----- states before the dashboard ----- */

  if (auth.status === "loading") {
    return (
      <div className={`${styles.scope} ${styles.fullCenter}`} aria-busy="true">
        <div className={styles.fullCard}>
          <div className={styles.skeleton} style={{ width: 160 }} />
          <p>Opening your workspace...</p>
        </div>
      </div>
    );
  }

  if (auth.status === "error" || auth.status === "no-profile") {
    const missing = auth.status === "no-profile";
    return (
      <div className={`${styles.scope} ${styles.fullCenter}`}>
        <div className={styles.fullCard} role={missing ? "status" : "alert"}>
          <h1>{missing ? "No psychologist profile linked" : "Could not open your workspace"}</h1>
          <p>
            {missing
              ? "This login is not linked to a psychologist profile, or you do not have access to it. Please ask your administrator to link your account."
              : auth.message}
          </p>
          {missing && PREVIEW_ENABLED && (
            <p>
              Developer preview: add <strong>?preview=1</strong> to the address to review this dashboard without a
              psychologist account.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {!missing && <button className={styles.btn} onClick={() => window.location.reload()}>Try again</button>}
            <button className={styles.btn} onClick={() => router.push("/")}>Go to CRM dashboard</button>
            <button className={styles.btn} onClick={handleLogout}>Logout</button>
          </div>
        </div>
      </div>
    );
  }

  const name = psychologist.name || getStaffName(auth.user);
  const calendarProps = {
    view,
    anchor,
    selected,
    now,
    narrow,
    appointments: apptState.items,
    supported: apptState.supported,
    loading: apptLoading,
    error: apptState.error,
    periods: periodsState.items,
    periodsLoading,
    periodsError: periodsState.error,
    onView: changeView,
    onPrev: () => shift(-1),
    onNext: () => shift(1),
    onToday: goToday,
    onSelectDate: selectDate,
    onSelectAppointment: setOpenAppointment,
    onRetry: () => setApptTick((tick) => tick + 1),
    onRetryPeriods: () => setPeriodsTick((tick) => tick + 1),
  };

  const notConnected = !apptLoading && !apptState.error && !apptState.supported;

  return (
    <main className={`crm-shell ${styles.scope}`}>
      <PsychologistSidebar
        active={section}
        name={name}
        open={menuOpen}
        onNavigate={navigate}
        onLogout={handleLogout}
        loggingOut={loggingOut}
        onClose={() => setMenuOpen(false)}
      />

      <section className="main-panel">
        <header className="topbar">
          <div className="breadcrumb">
            <button className="mobile-menu-button" onClick={() => setMenuOpen(true)} aria-label="Open navigation">
              <Icon name="menu" />
            </button>
            <span>Psychologist</span>
            <span className="breadcrumb-divider">/</span>
            <strong>{SECTION_TITLES[section]}</strong>
          </div>
        </header>

        <div className={styles.content}>
          {auth.preview && (
            <div className={styles.notice} role="status">
              <span className={styles.noticeIcon}><Icon name="info" /></span>
              <div>
                <strong>Preview mode (development only)</strong>
                You are reviewing this dashboard as {psychologist.id ? psychologist.name : "an empty profile"}, not as a
                psychologist. Nothing here is saved, and it is not available in the live site.
              </div>
            </div>
          )}

          {section === "dashboard" && (
            <DashboardOverview
              name={name}
              now={now}
              appointments={apptState.items}
              supported={apptState.supported && !apptState.error}
              loading={apptLoading}
            />
          )}

          {(section === "dashboard" || section === "calendar") && (
            <>
              {section === "calendar" && (
                <div className={styles.pageHead}>
                  <div>
                    <h1 className={styles.pageTitle}>My Calendar</h1>
                    <p className={styles.pageSub}>Your sessions by day, week or month.</p>
                  </div>
                </div>
              )}

              {notConnected && (
                <div className={styles.notice} role="status">
                  <span className={styles.noticeIcon}><Icon name="info" /></span>
                  <div>
                    <strong>Appointments are not connected yet</strong>
                    The calendar shows your recurring availability as shaded bands. Sessions, today&apos;s count and
                    follow-ups will appear once the backend provides appointment data.
                  </div>
                </div>
              )}

              <PsychologistCalendar {...calendarProps} />
            </>
          )}

          {section === "availability" && (
            <>
              <div className={styles.pageHead}>
                <div>
                  <h1 className={styles.pageTitle}>My Availability</h1>
                  <p className={styles.pageSub}>Your recurring weekly working hours.</p>
                </div>
              </div>
              <section className={styles.panel}>
                <AvailabilitySummary
                  periods={periodsState.items}
                  loading={periodsLoading}
                  error={periodsState.error}
                  onRetry={() => setPeriodsTick((tick) => tick + 1)}
                />
              </section>
            </>
          )}

          {section === "profile" && (
            <>
              <div className={styles.pageHead}>
                <div>
                  <h1 className={styles.pageTitle}>Profile</h1>
                  <p className={styles.pageSub}>Your details as held by the clinic. Contact an administrator to change them.</p>
                </div>
              </div>
              <section className={styles.panel}>
                <dl className={styles.detailGrid}>
                  <div className={styles.detail}><dt>Full name</dt><dd>{psychologist.name || "—"}</dd></div>
                  <div className={styles.detail}><dt>Phone number</dt><dd>{psychologist.phone || "—"}</dd></div>
                  <div className={styles.detail}><dt>Account status</dt><dd>{psychologist.active ? "Active" : "Inactive"}</dd></div>
                  <div className={styles.detail}><dt>Login email</dt><dd>{auth.user.email || "—"}</dd></div>
                </dl>
              </section>
            </>
          )}
        </div>

        <footer className="app-footer">
          <span>© 2026 Kappiness CRM</span>
          <span>Nourishing Minds, Pouring Happiness.</span>
        </footer>
      </section>

      {openAppointment && (
        <AppointmentDetailsPanel
          appointment={openAppointment}
          capabilities={CAPABILITIES}
          busy={actionBusy}
          onClose={() => setOpenAppointment(null)}
          onStatus={handleStatus}
          onRecommend={handleRecommend}
        />
      )}

      {toast && (
        <div className={`${styles.toast} ${toast.tone === "error" ? styles.toastError : ""}`} role={toast.tone === "error" ? "alert" : "status"}>
          {toast.message}
        </div>
      )}
    </main>
  );
}

export default function PsychologistDashboardPage() {
  // The dashboard reads the current time on the client, so it renders behind Suspense.
  return (
    <Suspense
      fallback={
        <div className={`${styles.scope} ${styles.fullCenter}`} aria-busy="true">
          <div className={styles.fullCard}>
            <div className={styles.skeleton} style={{ width: 160 }} />
            <p>Opening your workspace...</p>
          </div>
        </div>
      }
    >
      <PsychologistDashboard />
    </Suspense>
  );
}