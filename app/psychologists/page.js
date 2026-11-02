"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import Dialog from "../components/psychologists/Dialog";
import Icon from "../components/Icon";
import Notice from "../components/psychologists/Notice";
import PsychologistForm from "../components/psychologists/PsychologistForm";
import PsychologistShell from "../components/psychologists/PsychologistShell";
import PsychologistTable from "../components/psychologists/PsychologistTable";
import useCurrentUser from "../components/psychologists/useCurrentUser";
import styles from "../components/psychologists/psychologists.module.css";
import { canManagePsychologists, describeError, normalizePhone } from "../lib/psychologists";
import {
  createPsychologist,
  listAllAvailability,
  listPsychologists,
  updatePsychologist,
} from "../lib/psychologistsApi";

export default function PsychologistsPage() {
  const router = useRouter();
  const { name: staffName, email: staffEmail, role } = useCurrentUser();
  const canManage = canManagePsychologists(role);

  const [psychologists, setPsychologists] = useState([]);
  const [availability, setAvailability] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [availabilityError, setAvailabilityError] = useState(false);

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
    <PsychologistShell crumbs={[{ label: "Psychologists" }]} staffName={staffName} staffEmail={staffEmail}>
      <header className={styles.pageHeader}>
        <div>
          <h1 className={styles.title}>Psychologist Management</h1>
          <p className={styles.subtitle}>Manage psychologist profiles, availability and schedules.</p>
        </div>
        {canManage && (
          <div className={styles.headerActions}>
            <button className="primary-button" onClick={() => setFormState({ mode: "create" })}>
              <Icon name="plus" /> Add Psychologist
            </button>
          </div>
        )}
      </header>

      <section className={styles.summaryGrid} aria-label="Summary">
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Total Psychologists</span>
          <strong className={styles.summaryValue}>{loading || error ? "—" : total}</strong>
        </div>
        <div className={`${styles.summaryCard} ${styles.accent}`}>
          <span className={styles.summaryLabel}>Active Psychologists</span>
          <strong className={styles.summaryValue}>{loading || error ? "—" : activeCount}</strong>
        </div>
        <div className={styles.summaryCard}>
          <span className={styles.summaryLabel}>Inactive Psychologists</span>
          <strong className={styles.summaryValue}>{loading || error ? "—" : inactiveCount}</strong>
        </div>
      </section>

      <section className={styles.card}>
        <div className={styles.toolbar}>
          <label className={styles.searchWrap}>
            <Icon name="search" />
            <input
              className={styles.searchInput}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search by name or phone number"
              aria-label="Search psychologists by name or phone number"
            />
          </label>

          <select
            className={styles.select}
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value)}
            aria-label="Filter by account status"
          >
            <option value="All">All statuses</option>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </select>

          {filtersApplied && (
            <button className={styles.clearBtn} onClick={clearFilters}>Clear filters</button>
          )}

          {!loading && !error && (
            <span className={styles.resultCount}>
              {filtersApplied ? `${filtered.length} of ${total}` : `${total}`} psychologist{total === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {availabilityError && !loading && !error && (
          <div className={styles.inlineAlert} role="status">
            Availability could not be loaded, so the summary is hidden. The rest of the list is unaffected.
          </div>
        )}

        <PsychologistTable
          rows={filtered}
          loading={loading}
          error={error}
          availabilityByPsychologist={availabilityByPsychologist}
          availabilityUnavailable={availabilityError}
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
              <button className="secondary-button" onClick={() => setDeactivateTarget(null)}>Cancel</button>
              <button
                className="primary-button"
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