"use client";

import { useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { createClient } from "../../utils/supabase/client";
import AppointmentDetailsPanel from "../components/psychologist-dashboard/AppointmentDetailsPanel";
import PsychologistCalendar from "../components/psychologist-dashboard/PsychologistCalendar";
import PsychologistOverview from "../components/psychologist-dashboard/PsychologistOverview";
import styles from "../components/psychologist-dashboard/dashboard.module.css";
import useIsNarrow from "../components/psychologist-dashboard/useIsNarrow";
import AppShell from "../components/AppShell";
import Icon from "../components/Icon";
import Toast from "../components/Toast";
import ClientDetails from "../components/clients/ClientDetails";
import ClientList from "../components/clients/ClientList";
import AvailabilityManager from "../components/scheduling/AvailabilityManager";
import useAppointmentWorkflow from "../components/scheduling/useAppointmentWorkflow";
import RecommendationsPanel from "../components/sessions/RecommendationsPanel";
import SessionsPanel from "../components/sessions/SessionsPanel";
import { PSYCHOLOGIST_NAV } from "../lib/navigation";
import { addDays, addMonthsClamped, getVisibleRange, startOfDay } from "../lib/calendar";
import { describeError } from "../lib/psychologists";
import { getPsychologist, getPsychologistByAuthUser, listAvailability } from "../lib/psychologistsApi";
import { fetchAppointments, recommendFollowUp, updateSessionStatus } from "../lib/psychologistAppointments";
import { listClients } from "../lib/clientsApi";
import { getStaffName } from "../lib/staff";

// Preview mode exists only in `npm run dev` (never in a production build). It lets staff or admins review
// this screen without being a psychologist. It does not bypass any permission: data still loads through
// the signed-in user's normal access rules, so writes are refused by the database.
//   /psychologist?preview=1        empty preview (no psychologist data)
//   /psychologist?as=<profile id>  preview as an existing psychologist profile the user is allowed to read
const PREVIEW_ENABLED = process.env.NODE_ENV !== "production";

const SECTION_TITLES = Object.fromEntries(PSYCHOLOGIST_NAV.map((item) => [item.id, item.label]));
const SECTIONS = PSYCHOLOGIST_NAV.map((item) => item.id);

function PsychologistDashboard() {
  const router = useRouter();
  const narrow = useIsNarrow();

  const [now, setNow] = useState(() => new Date());
  const [section, setSection] = useState("dashboard");
  const [clientId, setClientId] = useState(null); // client profile open in "My clients"
  const [loggingOut, setLoggingOut] = useState(false);

  // auth + profile: { status: "loading" | "ready" | "no-profile" | "error", user, psychologist, message }
  const [auth, setAuth] = useState({ status: "loading", user: null, psychologist: null, message: "", preview: false });

  // availability (calendar shading)
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
  const notify = useCallback((message, tone = "success") => setToast({ message, tone }), []);

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

  // Deep links: /psychologist?section=clients&client=<id>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const fromUrl = params.get("section");
    // One-time sync from the address bar after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (fromUrl && SECTIONS.includes(fromUrl)) setSection(fromUrl);
    if (params.get("client")) setClientId(params.get("client"));
  }, []);

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

  // Recurring availability (calendar shading).
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

  // Appointments for what the calendar shows.
  const effectiveView = narrow && view === "week" ? "day" : view;
  const fetchRange = useMemo(() => {
    const visible = getVisibleRange(narrow && effectiveView === "day" ? "week" : effectiveView, anchor);
    return { start: visible.start, end: visible.end };
  }, [narrow, effectiveView, anchor]);

  const apptKey = psychologistId ? `${psychologistId}|${+fetchRange.start}|${+fetchRange.end}|${apptTick}` : "";

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
          setApptState({ key: apptKey, items: [], supported: true, error: describeError(error, "Could not load appointments. Please try again.") });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [psychologistId, apptKey, fetchRange]);

  const apptLoading = Boolean(psychologistId) && apptState.key !== apptKey;

  const viewer = useMemo(
    () => ({ isStaff: false, isAdmin: false, ownPsychologist: psychologist && psychologist.id ? psychologist : null }),
    [psychologist]
  );
  const refreshAppointments = useCallback(() => setApptTick((tick) => tick + 1), []);
  const workflow = useAppointmentWorkflow({ viewer, onChanged: refreshAppointments, notify });

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

  /* ----- appointment actions ----- */

  async function handleStatus(appointment, status, extra = {}) {
    setActionBusy(true);
    const result = await updateSessionStatus(appointment.id, status, extra);
    setActionBusy(false);
    if (result.ok) {
      notify(status === "cancelled" ? "Appointment cancelled. The slot is free again." : `Marked ${status}`);
      setOpenAppointment(null);
      refreshAppointments();
    } else {
      notify(result.message, "error");
    }
  }

  async function handleRecommend(values) {
    const result = await recommendFollowUp(values);
    if (result.ok) {
      notify("Follow-up recommended. Staff will track it.");
      setOpenAppointment(null);
    }
    return result;
  }

  async function bookFromCalendar() {
    try {
      const clients = await listClients({ psychologistId });
      if (clients.length === 0) {
        notify("You have no assigned clients yet. Staff assign clients when a lead is confirmed.", "error");
        return;
      }
      workflow.openBooking(null, null, clients.filter((item) => item.is_active));
    } catch (error) {
      notify(describeError(error, "Could not load your clients."), "error");
    }
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

  const navigate = useCallback((id, options = {}) => {
    setSection(id);
    setClientId(options.clientId || null);
    setOpenAppointment(null);
    const params = new URLSearchParams();
    if (id !== "dashboard") params.set("section", id);
    if (options.clientId) params.set("client", options.clientId);
    const query = params.toString();
    window.history.replaceState(null, "", query ? `/psychologist?${query}` : "/psychologist");
    window.scrollTo({ top: 0 });
  }, []);

  const openClient = useCallback((id) => navigate("clients", { clientId: id }), [navigate]);

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
              Developer preview: add <strong>?preview=1</strong> to the address to review this dashboard without a psychologist account.
            </p>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            {!missing && (
              <button type="button" className="btn" onClick={() => window.location.reload()}>
                Try again
              </button>
            )}
            <button type="button" className="btn" onClick={() => router.push("/")}>
              Go to CRM dashboard
            </button>
            <button type="button" className="btn btn-primary" onClick={handleLogout} disabled={loggingOut}>
              {loggingOut ? "Signing out…" : "Log out"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  const name = psychologist.name || getStaffName(auth.user);
  const hasProfile = Boolean(psychologistId);
  const crumbs = [
    { label: "My workspace", onClick: section === "dashboard" ? undefined : () => navigate("dashboard") },
    { label: SECTION_TITLES[section], onClick: section === "clients" && clientId ? () => navigate("clients") : undefined },
    ...(section === "clients" && clientId ? [{ label: "Client profile" }] : []),
  ];

  return (
    <AppShell
      nav={PSYCHOLOGIST_NAV}
      activeId={section}
      onNavigate={(id) => navigate(id)}
      workspaceLabel="Psychologist"
      crumbs={crumbs}
      user={{ name, email: auth.user.email || "", roleLabel: "Psychologist" }}
    >
      <div className={styles.scope} style={{ display: "contents" }}>
        {auth.preview && (
          <div className="notice" role="status">
            <Icon name="info" />
            <div>
              <strong>Preview mode (development only)</strong>
              You are reviewing this dashboard as {psychologist.id ? psychologist.name : "an empty profile"}, not as a psychologist. The database
              will refuse any change.
            </div>
          </div>
        )}

        {section === "dashboard" && hasProfile && (
          <PsychologistOverview psychologistId={psychologistId} name={name} now={now} onNavigate={(id) => navigate(id)} onOpenClient={openClient} />
        )}

        {section === "clients" && hasProfile && !clientId && (
          <>
            <header className="page-head">
              <div>
                <h1>My clients</h1>
                <p>Clients assigned to you. Open one for their history, sessions and follow-ups.</p>
              </div>
            </header>
            <ClientList psychologistId={psychologistId} showPsychologist={false} onOpen={(client) => openClient(client.id)} />
          </>
        )}

        {section === "clients" && hasProfile && clientId && (
          <ClientDetails key={clientId} clientId={clientId} viewer={viewer} psychologists={[psychologist]} notify={notify} onBack={() => navigate("clients")} />
        )}

        {section === "calendar" && (
          <>
            <header className="page-head">
              <div>
                <h1>Appointments</h1>
                <p>Your appointments by day, week or month, with your weekly availability shaded.</p>
              </div>
              {hasProfile && (
                <div className="page-actions">
                  <button type="button" className="btn btn-primary" onClick={bookFromCalendar}>
                    <Icon name="plus" /> Book appointment
                  </button>
                </div>
              )}
            </header>

            {!apptLoading && !apptState.error && !apptState.supported && (
              <div className="notice" role="status">
                <Icon name="info" />
                <div>
                  <strong>Appointments are not set up in the database yet</strong>
                  The calendar shows your weekly availability. Appointments appear once the clinic applies the scheduling migration.
                </div>
              </div>
            )}

            <PsychologistCalendar
              view={view}
              anchor={anchor}
              selected={selected}
              now={now}
              narrow={narrow}
              appointments={apptState.items}
              supported={apptState.supported}
              loading={apptLoading}
              error={apptState.error}
              periods={periodsState.items}
              periodsLoading={periodsLoading}
              periodsError={periodsState.error}
              onView={changeView}
              onPrev={() => shift(-1)}
              onNext={() => shift(1)}
              onToday={goToday}
              onSelectDate={selectDate}
              onSelectAppointment={setOpenAppointment}
              onRetry={refreshAppointments}
              onRetryPeriods={() => setPeriodsTick((tick) => tick + 1)}
            />
          </>
        )}

        {section === "sessions" && hasProfile && (
          <>
            <header className="page-head">
              <div>
                <h1>Sessions</h1>
                <p>Record attendance after each appointment, add the session outcome and notes, and recommend follow-ups.</p>
              </div>
            </header>
            <SessionsPanel viewer={viewer} psychologistId={psychologistId} notify={notify} onOpenClient={openClient} />
          </>
        )}

        {section === "availability" && hasProfile && (
          <>
            <header className="page-head">
              <div>
                <h1>My availability</h1>
                <p>Your weekly working periods (several per day, with breaks) and dates you are unavailable.</p>
              </div>
            </header>
            <AvailabilityManager psychologistId={psychologistId} notify={notify} onChanged={() => setPeriodsTick((tick) => tick + 1)} />
          </>
        )}

        {section === "recommendations" && hasProfile && (
          <>
            <header className="page-head">
              <div>
                <h1>Follow-up recommendations</h1>
                <p>Your recommendations after sessions. Staff book them through the normal appointment process.</p>
              </div>
            </header>
            <RecommendationsPanel viewer={viewer} psychologistId={psychologistId} notify={notify} onOpenClient={openClient} />
          </>
        )}

        {section !== "profile" && section !== "calendar" && !hasProfile && (
          <div className="notice" role="status">
            <Icon name="info" />
            <div>
              <strong>Empty preview</strong>
              Open the preview with ?as=&lt;psychologist id&gt; to see a profile&apos;s data.
            </div>
          </div>
        )}

        {section === "profile" && (
          <>
            <header className="page-head">
              <div>
                <h1>Profile</h1>
                <p>Your details as held by the clinic. Contact an administrator to change them. Appearance is in Profile settings.</p>
              </div>
            </header>
            <section className="panel panel-pad">
              <dl className="kv">
                <dt>Full name</dt>
                <dd>{psychologist.name || "—"}</dd>
                <dt>Phone number</dt>
                <dd>{psychologist.phone || "—"}</dd>
                <dt>Account status</dt>
                <dd>{psychologist.active ? "Active" : "Inactive"}</dd>
                <dt>Login email</dt>
                <dd>{auth.user.email || "—"}</dd>
              </dl>
            </section>
          </>
        )}
      </div>

      {openAppointment && (
        <AppointmentDetailsPanel
          appointment={openAppointment}
          now={now}
          busy={actionBusy}
          onClose={() => setOpenAppointment(null)}
          onStatus={handleStatus}
          onRecommend={handleRecommend}
          onOpenClient={openClient}
          onReschedule={(item) => {
            setOpenAppointment(null);
            workflow.openReschedule(item.raw);
          }}
        />
      )}

      {workflow.dialogs}
      <Toast toast={toast} />
    </AppShell>
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
