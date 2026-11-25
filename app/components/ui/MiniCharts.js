"use client";

import { useEffect, useRef, useState } from "react";

/* Small animated charts shared by the dashboard and Availability & Leave.
   Every chart also says its numbers in words (aria-label and visible text), so colour is never the only signal.
   Animations are skipped for people who ask for reduced motion. */

function prefersReducedMotion() {
  return typeof window !== "undefined" && window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Counts up from 0 to `value` once it is known. Non-numbers (like "—") are returned as they are.
export function useCountUp(value, duration = 700) {
  const target = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [shown, setShown] = useState(target === null ? value : 0);
  const from = useRef(0);
  useEffect(() => {
    if (target === null) return undefined;
    if (prefersReducedMotion()) {
      from.current = target;
      const id = requestAnimationFrame(() => setShown(target));
      return () => cancelAnimationFrame(id);
    }
    const start = performance.now();
    const begin = from.current;
    let frame;
    const tick = (time) => {
      const t = Math.min(1, (time - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(Math.round(begin + (target - begin) * eased));
      if (t < 1) frame = requestAnimationFrame(tick);
      else from.current = target;
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);
  return target === null ? value : shown;
}

export function CountUp({ value, suffix = "" }) {
  const shown = useCountUp(value);
  return (
    <>
      {shown}
      {typeof shown === "number" ? suffix : ""}
    </>
  );
}

// Becomes true one frame after mount, so CSS transitions animate from their empty state.
function useMounted() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    const id = requestAnimationFrame(() => setMounted(true));
    return () => cancelAnimationFrame(id);
  }, []);
  return mounted;
}

/* Ring chart. segments: [{ value, tone }] where tone is ok | wait | free | info | late | brand | muted.
   With one segment and a total, it draws a progress ring. */
export function Ring({ segments, total, size = 96, stroke = 10, label, children }) {
  const mounted = useMounted();
  const sum = total ?? segments.reduce((s, x) => s + x.value, 0);
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  let offset = 0;
  return (
    <div className="mc-ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size}>
        <circle className="mc-ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} />
        {sum > 0 &&
          segments.map((seg, i) => {
            const len = (seg.value / sum) * c;
            const gap = segments.length > 1 && seg.value > 0 ? Math.min(3, len / 3) : 0;
            const el = (
              <circle
                key={i}
                className={`mc-ring-seg tone-${seg.tone}`}
                cx={size / 2}
                cy={size / 2}
                r={r}
                strokeWidth={stroke}
                strokeDasharray={`${mounted ? Math.max(0, len - gap) : 0} ${c}`}
                strokeDashoffset={-offset}
                style={{ transitionDelay: `${i * 120}ms` }}
              />
            );
            offset += len;
            return el;
          })}
      </svg>
      {children ? <div className="mc-ring-center">{children}</div> : null}
    </div>
  );
}

/* One row of slots as a bar: booked / waiting / free / leave segments grow in from the left. */
export function SlotBar({ parts, label }) {
  const mounted = useMounted();
  const sum = parts.reduce((s, p) => s + p.value, 0);
  return (
    <div className="mc-bar" role="img" aria-label={label}>
      {sum === 0 ? <span className="mc-bar-empty" /> : null}
      {parts.map((p, i) =>
        p.value > 0 ? (
          <span key={i} className={`mc-bar-seg tone-${p.tone}`} style={{ flexGrow: mounted ? p.value : 0, transitionDelay: `${i * 90}ms` }} />
        ) : null
      )}
    </div>
  );
}
