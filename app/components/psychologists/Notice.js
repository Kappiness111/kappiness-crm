"use client";

import { useEffect } from "react";
import Icon from "../Icon";
import styles from "./psychologists.module.css";

/* Toast for success and error messages. notice = { message, tone } or null. */
export default function Notice({ notice, onDismiss }) {
  useEffect(() => {
    if (!notice) return undefined;
    const timer = setTimeout(onDismiss, notice.tone === "error" ? 6000 : 3500);
    return () => clearTimeout(timer);
  }, [notice, onDismiss]);

  if (!notice) return null;
  const isError = notice.tone === "error";

  return (
    <div
      className={`${styles.notice} ${isError ? styles.noticeError : ""}`}
      role={isError ? "alert" : "status"}
      aria-live="polite"
    >
      <Icon name={isError ? "info" : "check"} /> {notice.message}
    </div>
  );
}