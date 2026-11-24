"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import FollowUpRecordDrawer from "./FollowUpRecordDrawer";
import useCurrentUser from "../psychologists/useCurrentUser";
import { describeFollowUpError, getFollowUp, knownStaffNames, listFollowUps } from "../../lib/followUpsApi";

/* Loads follow_ups_with_status for the given server-side filters and owns the record drawer.
   filters: the listFollowUps filters. Returns { state, rows, refresh, open, staffNames, drawer }. */
export default function useFollowUpRecords({ filters, viewer, psychologistNames, notify, onOpenClient }) {
  const { user } = useCurrentUser();
  const [state, setState] = useState({ status: "loading", message: "", rows: [], key: "" });
  const [reload, setReload] = useState(0);
  const [selectedId, setSelectedId] = useState(null);
  const [fresh, setFresh] = useState(null); // latest view row of the open record, read after a save
  const filterKey = JSON.stringify(filters);
  const refresh = useCallback(() => setReload((value) => value + 1), []);

  useEffect(() => {
    let cancelled = false;
    listFollowUps(JSON.parse(filterKey))
      .then((rows) => {
        if (!cancelled) setState({ status: "ready", message: "", rows, key: filterKey });
      })
      .catch((error) => {
        console.error("Failed to load follow-ups:", error);
        if (!cancelled) setState((current) => ({ ...current, status: "error", message: describeFollowUpError(error, "Could not load follow-ups.") }));
      });
    return () => {
      cancelled = true;
    };
  }, [filterKey, reload]);

  const staffNames = useMemo(() => knownStaffNames(state.rows), [state.rows]);

  const listed = selectedId ? state.rows.find((row) => row.id === selectedId) || null : null;
  const selected = fresh && fresh.id === selectedId && (!listed || fresh.updated_at >= listed.updated_at) ? fresh : listed;

  // The functions return the table row; read the view row again so due_state and client_name stay right.
  const handleChanged = useCallback(
    async (saved) => {
      refresh();
      if (!saved || !saved.id) return;
      try {
        const row = await getFollowUp(saved.id);
        if (row) setFresh(row);
      } catch (error) {
        console.error("Could not re-read the follow-up:", error);
      }
    },
    [refresh]
  );

  const drawer = selected ? (
    <FollowUpRecordDrawer
      followUp={selected}
      viewer={viewer}
      currentUserId={(user && user.id) || null}
      staffNames={staffNames}
      psychologistNames={psychologistNames}
      notify={notify}
      onChanged={handleChanged}
      onOpenClient={onOpenClient}
      onClose={() => {
        setSelectedId(null);
        setFresh(null);
      }}
    />
  ) : null;

  return {
    state,
    loading: state.status === "loading" || (state.status === "ready" && state.key !== filterKey),
    rows: state.rows,
    refresh,
    handleChanged,
    open: setSelectedId,
    staffNames,
    drawer,
  };
}
