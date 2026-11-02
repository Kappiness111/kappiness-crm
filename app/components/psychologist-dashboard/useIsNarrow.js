"use client";

import { useSyncExternalStore } from "react";

/* True on phone-sized screens, where the 7-column week grid is replaced by a day agenda. */
const QUERY = "(max-width: 720px)";

function subscribe(callback) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", callback);
  return () => media.removeEventListener("change", callback);
}

export default function useIsNarrow() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false
  );
}