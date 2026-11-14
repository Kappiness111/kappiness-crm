"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Dialog from "../components/psychologists/Dialog";
import Icon from "../components/Icon";
import Notice from "../components/psychologists/Notice";
import PsychologistForm from "../components/psychologists/PsychologistForm";
import PsychologistsTabs from "../components/psychologists/PsychologistsTabs";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import PsychologistTable from "../components/psychologists/PsychologistTable";
import useCurrentUser from "../components/psychologists/useCurrentUser";
import { loadWorkload } from "../lib/workload";
import { canManagePsychologists, describeError, normalizePhone } from "../lib/psychologists";
import {
  createPsychologist,
  listAllAvailability,
  listPsychologists,
  updatePsychologist,
} from "../lib/psychologistsApi";

export default function PsychologistsPage() {
  const router = useRouter();
  const { role } = useCurrentUser();
  const canManage = canManagePsychologists(role);

  const [psychologists, setPsychologists] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [availabilityError, setAvailabilityError] = useState(false);
  const [workload, setWorkload] = useState(null);

  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");

  const [formState, setFormState] = useState(null); // null | { mode: "create" } | { mode: "edit", psychologist }
  const [deactivateTarget, setDeactivateTarget] = useState(null);
  const [busyIds, setBusyIds] = useState([]);
  const [notice, setNotice] = useState(null);

  const load = useCallback(async () => {
    try {
      setPsychologists(await listPsychologists());
      setError("");
    } catch (err) {
      console.error("Failed to load psychologists:", err);
      setError(describeError(err, "Could not load psychologists. Please check your connection and try again."));
      setLoading(false);
      return;
    }

    // The availability summary is optional: the list still works if it cannot be read.
    try {
      setAvailability(await listAllAvailability());
      setAvailabilityError(false);
    } catch (err) {
      console.error("Failed to load availability summary:", err);
      setAvailabilityError(true);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    // Initial fetch: state only changes after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    load();
  }, [load]);

  // Workload (clients, upcoming sessions, follow-ups) is optional: the list works without it.
  useEffect(() => {
    let cancelled = false;
    loadWorkload()
      .then((result) => {
        if (!cancelled) setWorkload(result.byId);
      })
      .catch((err) => {
        console.error("Failed to load workload:", err);
        if (!cancelled) setWorkload({});
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function retry() {
    setLoading(true);
    setError("");
    load();
  }

  const availabilityByPsychologist = useMemo(() => {
    const map = {};
    availability.forEach((period) => {
      (map[period.psychologist_id] = map[period.psychologist_id] || []).push(period);
    });
    return map;
  }, [availability]);

  const total = psychologists.length;
  const activeCount = psychologists.filter((item) => item.active).length;
  const inactiveCount = total - activeCount;

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    const phoneTerm = normalizePhone(search).toLowerCase();

    return psychologists.filter((item) => {
      const matchesSearch =
        !term ||
        item.name.toLowerCase().includes(term) ||
        (phoneTerm.length > 0 && normalizePhone(item.phone).toLowerCase().includes(phoneTerm));
      const matchesStatus =
        statusFilter === "All" || (statusFilter === "Active" ? item.active : !item.active);
      return matchesSearch && matchesStatus;
    });
  }, [psychologists, search, statusFilter]);

  const filtersApplied = search.trim() !== "" || statusFilter !== "All";

  function clearFilters() {
    setSearch("");
    setStatusFilter("All");
  }

  const flash = useCallback((message, tone = "success") => setNotice({ message, tone }), []);
  const dismissNotice = useCallback(() => setNotice(null), []);

  function openProfile(psychologist, hash = "") {
    router.push(`/psychologists/${psychologist.id}${hash}`);
  }

  async function handleSubmit(values) {
    const editing = formState && formState.mode === "edit";
    try {
      if (editing) {
        const saved = await updatePsychologist(formState.psychologist.id, values);
        setPsychologists((current) => current.map((item) => (item.id === saved.id ? saved : item)));
        flash(`${saved.name} updated`);
      } else {
        const saved = await createPsychologist(values);
        setPsychologists((current) => [saved, ...current]);
        flash(`${saved.name} added`);
      }
      setFormState(null);
      return { ok: true };
    } catch (err) {
      console.error("Failed to save psychologist:", err);
      return { ok: false, message: describeError(err, "Could not save this psychologist. Your entries are still here, so please try again.") };
    }
  }

  async function setActive(psychologist, active) {
    if (busyIds.includes(psychologist.id)) return;
    setBusyIds((ids) => [...ids, psychologist.id]);
    try {
      const saved = await updatePsychologist(psychologist.id, { active });
      setPsychologists((current) => current.map((item) => (item.id === saved.id ? saved : item)));
      flash(`${saved.name} ${active ? "activated" : "deactivated"}`);
    } catch (err) {
      console.error("Failed to change psychologist status:", err);
      flash(describeError(err, "Could not change the status. Please try again."), "error");
    } finally {
      setBusyIds((ids) => ids.filter((id) => id !== psychologist.id));
    }
  }

  function handleToggle(psychologist) {
    if (psychologist.active) setDeactivateTarget(psychologist);
    else setActive(psychologist, true);
  }

  return (
    <PsychologistShell crumbs={[{ label: "Psychologists" }]}>
      <PsychologistsTabs active="psychologists" />
      <header className="page-head">
        <div>
          <h1>Psychologists</h1>
          <p>Profiles, account status and weekly availability.</p>
        </div>
        {canManage && (
          <div className="page-actions">
            <button type="button" className="btn btn-primary" onClick={() => setFormState({ mode: "create" })}>
              <Icon name="plus" /> Add psychologist
            </button>
          </div>
        )}
      </header>

      <section className="kpis" aria-label="Summary">
        <button type="button" className="kpi" onClick={() => setStatusFilter("All")}>
          <span className="kpi-label">Total</span>
          <span className="kpi-value">{loading || error ? "—" : total}</span>
          <span className="kpi-meta">Profiles</span>
        </button>
        <button type="button" className="kpi" onClick={() => setStatusFilter("Active")}>
          <span className="kpi-label">Active</span>
          <span className="kpi-value">{loading || error ? "—" : activeCount}</span>
          <span className="kpi-meta">Available for sessions</span>
        </button>
        <button type="button" className="kpi" onClick={() => setStatusFilter("Inactive")}>
          <span className="kpi-label">Inactive</span>
          <span className="kpi-value">{loading || error ? "—" : inactiveCount}</span>
          <span className="kpi-meta">Kept on record</span>
        </button>
      </section>

      <section className="panel" aria-label="Psychologist list">
        <div className="toolbar">
          <label className="search">
            <Icon name="search" />
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or phone"
              aria-label="Search psychologists by name or phone number"
            />
          </label>

          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)} aria-label="Filter by account status">
            <option value="All">All statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>

          {filtersApplied && (
            <button type="button" className="link-btn" onClick={clearFilters}>
              Clear filters
            </button>
          )}

          <span className="spacer" />
          {!loading && !error && (
            <span className="count">
              {filtersApplied ? `${filtered.length} of ${total}` : `${total}`} psychologist{total === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {availabilityError && !loading && !error && (
          <div className="notice" role="status" style={{ margin: "12px 14px 0" }}>
            <Icon name="info" />
            <span>Availability could not be loaded, so that column is hidden. The rest of the list is unaffected.</span>
          </div>
        )}

        <PsychologistTable
          rows={filtered}
          loading={loading}
          error={error}
          availabilityByPsychologist={availabilityByPsychologist}
          availabilityUnavailable={availabilityError}
          workload={workload}
          hasAnyRecords={total > 0}
          canManage={canManage}
          busyIds={busyIds}
          onRetry={retry}
          onClearFilters={clearFilters}
          onAdd={() => setFormState({ mode: "create" })}
          onView={(item) => openProfile(item)}
          onEdit={(item) => setFormState({ mode: "edit", psychologist: item })}
          onAvailability={(item) => openProfile(item, "#availability")}
          onToggleActive={handleToggle}
        />
      </section>

      {formState && (
        <PsychologistForm
          mode={formState.mode}
          psychologist={formState.psychologist}
          onSubmit={handleSubmit}
          onClose={() => setFormState(null)}
        />
      )}

      {deactivateTarget && (
        <Dialog
          titleId="deactivate-title"
          title={`Deactivate ${deactivateTarget.name}?`}
          subtitle="The profile and its availability are kept, and you can activate it again at any time."
          onClose={() => setDeactivateTarget(null)}
          small
          footer={
            <>
              <button type="button" className="btn" onClick={() => setDeactivateTarget(null)}>Cancel</button>
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  const target = deactivateTarget;
                  setDeactivateTarget(null);
                  setActive(target, false);
                }}
              >
                Deactivate
              </button>
            </>
          }
        />
      )}

      <Notice notice={notice} onDismiss={dismissNotice} />
    </PsychologistShell>
  );
}