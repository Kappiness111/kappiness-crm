"use client";

import Icon from "./Icon";

export default function Toast({ toast }) {
  if (!toast) return null;
  const error = toast.tone === "error";
  return (
    <div className={`toast ${error ? "error" : ""}`} role={error ? "alert" : "status"} aria-live="polite">
      <Icon name={error ? "alert" : "check"} /> {toast.message}
    </div>
  );
}
