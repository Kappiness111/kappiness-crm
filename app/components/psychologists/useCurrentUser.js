"use client";

import { useEffect, useState } from "react";
import { createClient } from "../../../utils/supabase/client";
import { getStaffName } from "../../lib/staff";
import { getUserRole } from "../../lib/psychologists";

/* Reads the signed-in user from the existing Supabase session. Does not change authentication. */
export default function useCurrentUser() {
  const [state, setState] = useState({ loaded: false, user: null });

  useEffect(() => {
    let cancelled = false;
    createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setState({ loaded: true, user: (data && data.user) || null });
      })
      .catch(() => {
        if (!cancelled) setState({ loaded: true, user: null });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return {
    loaded: state.loaded,
    user: state.user,
    name: getStaffName(state.user),
    email: (state.user && state.user.email) || "",
    role: getUserRole(state.user),
  };
}