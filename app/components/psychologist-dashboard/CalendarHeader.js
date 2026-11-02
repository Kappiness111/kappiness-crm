"use client";

import Glyph from "./Glyph";
import { formatLongDate, formatRangeTitle } from "../../lib/calendar";
import styles from "./dashboard.module.css";

const VIEWS = [
  { value: "day", label: "Day" },
  { value: "week", label: "Week" },
  { value: "month", label: "Month" },
];

export default function CalendarHeader({ view, anchor, selected, today, narrow, onView, onPrev, onNext, onToday }) {
  const views = narrow ? VIEWS.filter((item) => item.value !== "week") : VIEWS;
  const noun = view === "month" ? "month" : view === "week" ? "week" : "day";

  return (
    <header className={styles.calHead}>
      <div className={styles.calTitleBlock}>
        <h2 className={styles.calTitle}>{formatRangeTitle(view, anchor)}</h2>
        <p className={styles.calMeta}>
          Today <b>{formatLongDate(today)}</b>
          {view !== "day" ? (
            <>
              {" · "}Selected <b>{formatLongDate(selected)}</b>
            </>
          ) : null}
        </p>
      </div>

      <div className={styles.navGroup}>
        <button className={styles.iconBtn} onClick={onPrev} aria-label={`Previous ${noun}`}>
          <Glyph name="chevronLeft" />
        </button>
        <button className={styles.btn} onClick={onToday}>Today</button>
        <button className={styles.iconBtn} onClick={onNext} aria-label={`Next ${noun}`}>
          <Glyph name="chevronRight" />
        </button>
      </div>

      <div className={styles.segmented} role="group" aria-label="Calendar view">
        {views.map((item) => (
          <button
            key={item.value}
            className={`${styles.segment} ${view === item.value ? styles.segmentActive : ""}`}
            onClick={() => onView(item.value)}
            aria-pressed={view === item.value}
          >
            {item.label}
          </button>
        ))}
      </div>
    </header>
  );
}