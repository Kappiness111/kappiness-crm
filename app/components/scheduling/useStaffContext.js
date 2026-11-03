"use client";

import { useEffect, useMemo, useState } from "react";
import useCurrentUser from "../psychologists/useCurrentUser";
import { listPsychologists } from "../../lib/psychologistsApi";

/* What staff pages need about the viewer: role, the psychologist list (names, reassignment) and a toast.
   Psychologists never reach staff routes (proxy.js sends them to /psychologist); RLS is the real guard. */
export default function useStaffContext() {
  const { role, name, email } = useCurrentUser();
  const [psychologists, setPsychologists] = useState([]);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let cancelled = false;
    listPsychologists()
      .then((rows) => {
        if (!cancelled) setPsychologists(rows);
      })
      .catch((error) => console.error("Failed to load psychologists:", error));
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!toast) return undefined;
    const timer = setTimeout(() => setToast(null), toast.tone === "error" ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [toast]);

  const psychologistNames = useMemo(() => {
    const map = {};
    psychologists.forEach((item) => {
      map[item.id] = item.name;
    });
    return map;
  }, [psychologists]);

  const viewer = useMemo(
    () => ({ isStaff: role !== "psychologist", isAdmin: role === "admin", ownPsychologist: null, name, email }),
    [role, name, email]
  );

  return {
    viewer,
    psychologists,
    psychologistNames,
    notify: (message, tone = "success") => setToast({ message, tone }),
    toast,
  };
}
