"use client";

import { useParams, useRouter } from "next/navigation";
import { Suspense, useCallback, useEffect, useState } from "react";
import AvailabilityForm from "../../components/psychologists/AvailabilityForm";
import AvailabilitySchedule from "../../components/psychologists/AvailabilitySchedule";
import Icon from "../../components/Icon";
import Notice from "../../components/psychologists/Notice";
import PsychologistForm from "../../components/psychologists/PsychologistForm";
import PsychologistProfile from "../../components/psychologists/PsychologistProfile";
import BlockedPeriods from "../../components/scheduling/BlockedPeriods";
import PsychologistShell from "../../components/psychologists/PsychologistShell";
import useCurrentUser from "../../components/psychologists/useCurrentUser";
import { canManagePsychologists, describeError } from "../../lib/psychologists";
import {
  createAvailability,
  getPsychologist,
  listAvailability,
  updateAvailability,
  updatePsychologist,
} from "../../lib/psychologistsApi";

function PsychologistProfileView() {
  const router = useRouter();
  const params = useParams();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const { role } = useCurrentUser();
  const canManage = canManagePsychologists(role);

  const [psychologist, setPsychologist] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const [periods, setPeriods] = useState([]);
  const [periodsLoading, setPeriodsLoading] = useState(true);
  const [periodsError, setPeriodsError] = useState("");

  const [editingProfile, setEditingProfile] = useState(false);
  const [availabilityForm, setAvailabilityForm] = useState(null); // null | { period } | { defaultDay }
  const [statusBusy, setStatusBusy] = useState(false);
  const [busyPeriodIds, setBusyPeriodIds] = useState([]);
  const [notice, setNotice] = useState(null);

  const flash = useCallback((message, tone = "success") => setNotice({ message, tone }), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  const loadProfile = useCallback(async () => {
    try {
      setPsychologist(await getPsychologist(id));
      setError("");
    } catch (err) {
      console.error("Failed to load psychologist:", err);
      setError(describeError(err, "Could not load this profile. Please check your connection and try again."));
    } finally {
      setLoading(false);
    }
  }, [id]);

  const loadPeriods = useCallback(async () => {
    try {
      setPeriods(await listAvailability(id));
      setPeriodsError("");
    } catch (err) {
      console.error("Failed to load availability:", err);
      setPeriodsError(describeError(err, "Could not load availability. Please try again."));
    } finally {
      setPeriodsLoading(false);
    }
  }, [id]);

  useEffect(() => {
    // Initial fetch: state only changes after the requests resolve.
    /* eslint-disable react-hooks/set-state-in-effect */
    loadProfile();
    loadPeriods();
    /* eslint-enable react-hooks/set-state-in-effect */
  }, [loadProfile, loadPeriods]);

  function retryProfile() {
    setLoading(true);
    setError("");
    loadProfile();
  }

  function retryPeriods() {
    setPeriodsLoading(true);
    setPeriodsError("");
    loadPeriods();
  }

  // Opens at the schedule when the URL ends in #availability (from "Manage Availability" in the list).
  useEffect(() => {
    if (loading || periodsLoading) return;
    if (window.location.hash === "#availability") {
      document.getElementById("availability")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [loading, periodsLoading]);

  function scrollToAvailability() {
    document.getElementById("availability")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function handleProfileSave(values) {
    try {
      const saved = await updatePsychologist(psychologist.id, values);
      setPsychologist(saved);
      setEditingProfile(false);
      flash("Profile updated");
      return { ok: true };
    } catch (err) {
      console.error("Failed to update profile:", err);
      return { ok: false, message: describeError(err, "Could not save the profile. Your entries are still here, so please try again.") };
    }
  }

  async function toggleProfileActive() {
    if (statusBusy) return;
    setStatusBusy(true);
    const next = !psychologist.active;
    try {
      setPsychologist(await updatePsychologist(psychologist.id, { active: next }));
      flash(next ? "Profile activated" : "Profile deactivated");
    } catch (err) {
      console.error("Failed to change status:", err);
      flash(describeError(err, "Could not change the status. Please try again."), "error");
    } finally {
      setStatusBusy(false);
    }
  }

  async function handleAvailabilitySave(values) {
    const editingPeriod = availabilityForm && availabilityForm.period;
    try {
      if (editingPeriod) {
        const saved = await updateAvailability(editingPeriod.id, values);
        setPeriods((current) => current.map((item) => (item.id === saved.id ? saved : item)));
        flash("Availability updated");
      } else {
        const saved = await createAvailability(psychologist.id, values);
        setPeriods((current) => [...current, saved]);
        flash("Availability added");
      }
      setAvailabilityForm(null);
      return { ok: true };
    } catch (err) {
      console.error("Failed to save availability:", err);
      return { ok: false, message: describeError(err, "Could not save this availability. Your entries are still here, so please try again.") };
    }
  }

  async function togglePeriod(period) {
    if (busyPeriodIds.includes(period.id)) return;

    // Re-activating must not create an overlap with another active period.
    if (!period.is_active) {
      const start = period.start_time;
      const end = period.end_time;
      const clash = periods.find(
        (other) =>
          other.id !== period.id &&
          other.is_active &&
          other.day_of_week === period.day_of_week &&
          other.start_time < end &&
          other.end_time > start
      );
      if (clash) {
        flash("This period overlaps another active period on the same day. Edit one of them first.", "error");
        return;
      }
    }

    setBusyPeriodIds((ids) => [...ids, period.id]);
    try {
      const saved = await updateAvailability(period.id, { is_active: !period.is_active });
      setPeriods((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      flash(saved.is_active ? "Availability activated" : "Availability deactivated");
    } catch (err) {
      console.error("Failed to change availability status:", err);
      flash(describeError(err, "Could not change the availability. Please try again."), "error");
    } finally {
      setBusyPeriodIds((ids) => ids.filter((item) => item !== period.id));
    }
  }

  const crumbs = [
    { label: "Psychologists", href: "/psychologists" },
    { label: psychologist ? psychologist.name || "Profile" : "Profile" },
  ];

  return (
    <PsychologistShell crumbs={crumbs}>
      {loading && (
        <section className="page-head" aria-busy="true" aria-label="Loading profile">
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <span className="avatar lg" aria-hidden="true" />
            <div>
              <div className="skeleton" style={{ width: 220, height: 18, marginBottom: 10 }} />
              <div className="skeleton" style={{ width: 120 }} />
            </div>
          </div>
        </section>
      )}

      {!loading && error && (
        <div className="panel">
          <div className="state error" role="alert">
            <Icon name="alert" />
            <strong>Could not load this profile</strong>
            <span>{error}</span>
            <button type="button" className="btn btn-sm" onClick={retryProfile}>
              Try again
            </button>
          </div>
        </div>
      )}

      {!loading && !error && !psychologist && (
        <div className="panel">
          <div className="state">
            <Icon name="search" />
            <strong>Psychologist not found</strong>
            <span>This profile does not exist, or you do not have access to it.</span>
            <button type="button" className="btn btn-sm" onClick={() => router.push("/psychologists")}>
              <Icon name="arrowLeft" /> Back to psychologists
            </button>
          </div>
        </div>
      )}

      {!loading && !error && psychologist && (
        <>
          <PsychologistProfile
            psychologist={psychologist}
            canManage={canManage}
            statusBusy={statusBusy}
            onBack={() => router.push("/psychologists")}
            onEdit={() => setEditingProfile(true)}
            onManageAvailability={scrollToAvailability}
            onToggleActive={toggleProfileActive}
          />

          <AvailabilitySchedule
            periods={periods}
            loading={periodsLoading}
            error={periodsError}
            canManage={canManage}
            busyIds={busyPeriodIds}
            onRetry={retryPeriods}
            onAdd={(day) => setAvailabilityForm({ defaultDay: day })}
            onEdit={(period) => setAvailabilityForm({ period })}
            onToggle={togglePeriod}
          />

          <BlockedPeriods psychologistId={psychologist.id} canManage={canManage} notify={flash} />
        </>
      )}

      {editingProfile && psychologist && (
        <PsychologistForm
          mode="edit"
          psychologist={psychologist}
          onSubmit={handleProfileSave}
          onClose={() => setEditingProfile(false)}
        />
      )}

      {availabilityForm && (
        <AvailabilityForm
          period={availabilityForm.period}
          defaultDay={availabilityForm.defaultDay}
          existingPeriods={periods}
          onSubmit={handleAvailabilitySave}
          onClose={() => setAvailabilityForm(null)}
        />
      )}

      <Notice notice={notice} onDismiss={dismissNotice} />
    </PsychologistShell>
  );
}

export default function PsychologistProfilePage() {
  return (
    <Suspense fallback={null}>
      <PsychologistProfileView />
    </Suspense>
  );
}