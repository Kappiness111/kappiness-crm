"use client";

import { useEffect } from "react";
import Icon from "../Icon";

/* Toast for success and error messages (the CRM-wide toast style). notice = { message, tone } or null. */
export default function Notice({ notice, onDismiss }) {
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(onDismiss, notice.tone === "error" ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;
  const isError = notice.tone === "error";

  return (
    <div className={`toast ${isError ? "error" : ""}`} role={isError ? "alert" : "status"} aria-live="polite">
      <Icon name={isError ? "alert" : "check"} /> {notice.message}
    </div>
  );
}
