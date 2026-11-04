"use client";

/* Lightweight SVG/HTML charts for the CRM dashboard (no chart library).
   Colours come from the --chart-* tokens in globals.css, which have separate light and dark steps. */

import { useEffect, useRef, useState } from "react";

/* ----- shared bits ----- */

function useElementWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width);
      setWidth((current) => (current === next ? current : next));
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return [ref, width];
}

// Clean axis maximum and step for whole-number counts (0 / 5 / 10 / 15 …).
function niceScale(max, tickCount = 4) {
  if (max <= tickCount) return { max: tickCount, step: 1 };
  const raw = max / tickCount;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / magnitude;
  const step = Math.max(1, (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * magnitude);
  return { max: Math.ceil(max / step) * step, step };
}

export function ChartEmpty({ title = "No data yet", text }) {
  return (
    <div className="chart-empty">
      <svg viewBox="0 0 48 32" aria-hidden="true">
        <path d="M2 30h44" />
        <path d="M6 24l10-8 9 5 9-11 9 6" />
      </svg>
      <strong>{title}</strong>
      {text && <span>{text}</span>}
    </div>
  );
}

export function Legend({ items }) {
  return (
    <ul className="chart-legend">
      {items.map((item) => (
        <li key={item.label}>
          <span className="chart-key" style={{ background: item.color }} aria-hidden="true" />
          {item.label}
        </li>
      ))}
    </ul>
  );
}

/* ----- ring gauge (single share of a whole) ----- */

export function RingGauge({ value, total, label, caption, size = 148, stroke = 10, sweep = 270, color = "var(--chart-1)" }) {
  const share = total > 0 ? Math.min(1, value / total) : 0;
  const pct = total > 0 ? Math.round(share * 100) : null;
  const r = (size - stroke) / 2;
  const circumference = 2 * Math.PI * r;
  const arc = (circumference * sweep) / 360;
  const rotate = 90 + (360 - sweep) / 2;

  return (
    <figure className="ring" style={{ width: size }} aria-label={`${label}: ${pct === null ? "no data" : `${pct}%`}${caption ? `, ${caption}` : ""}`}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        <g transform={`rotate(${rotate} ${size / 2} ${size / 2})`}>
          <circle className="ring-track" cx={size / 2} cy={size / 2} r={r} strokeWidth={stroke} strokeDasharray={`${arc} ${circumference}`} />
          {share > 0 && (
            <circle
              className="ring-value"
              cx={size / 2}
              cy={size / 2}
              r={r}
              strokeWidth={stroke}
              stroke={color}
              strokeDasharray={`${arc * share} ${circumference}`}
            />
          )}
        </g>
      </svg>
      <div className="ring-center">
        <span className="ring-pct">{pct === null ? "—" : `${pct}%`}</span>
        <span className="ring-label">{label}</span>
      </div>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/* ----- line chart (one or more series over buckets) ----- */

const PAD = { top: 14, right: 22, bottom: 26, left: 40 };

export function LineChart({ data, series, height = 230, ariaLabel, emptyTitle, emptyText }) {
  const [ref, width] = useElementWidth();
  const [active, setActive] = useState(null);
  const hasData = data.some((row) => series.some((s) => row[s.id] > 0));

  const n = data.length;
  const innerW = Math.max(0, width - PAD.left - PAD.right);
  const innerH = height - PAD.top - PAD.bottom;
  const peak = Math.max(0, ...data.flatMap((row) => series.map((s) => row[s.id] || 0)));
  const { max, step } = niceScale(peak);
  const ticks = [];
  for (let v = 0; v <= max; v += step) ticks.push(v);

  const x = (i) => PAD.left + (n <= 1 ? innerW / 2 : (i * innerW) / (n - 1));
  const y = (v) => PAD.top + innerH - (v / max) * innerH;
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(innerW / 54))));

  function indexFromPointer(event) {
    const rect = event.currentTarget.getBoundingClientRect();
    const px = event.clientX - rect.left - PAD.left;
    return Math.max(0, Math.min(n - 1, Math.round((px / Math.max(innerW, 1)) * (n - 1))));
  }

  function onKeyDown(event) {
    if (event.key === "ArrowRight") setActive((i) => Math.min(n - 1, (i ?? -1) + 1));
    else if (event.key === "ArrowLeft") setActive((i) => Math.max(0, (i ?? n) - 1));
    else if (event.key === "Escape") setActive(null);
    else return;
    event.preventDefault();
  }

  const summary =
    ariaLabel ||
    `${series.map((s) => s.label).join(" and ")}: ` + data.map((row) => `${row.full || row.label} ${series.map((s) => row[s.id]).join("/")}`).join(", ");

  const tipLeft = active !== null ? x(active) : 0;
  const flip = tipLeft > width - 170;

  return (
    <div className="line-chart" ref={ref} style={{ height }}>
      {!hasData ? (
        <ChartEmpty title={emptyTitle} text={emptyText} />
      ) : width > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-label={summary}
            tabIndex={0}
            onPointerMove={(event) => setActive(indexFromPointer(event))}
            onPointerLeave={() => setActive(null)}
            onFocus={() => setActive((i) => i ?? n - 1)}
            onBlur={() => setActive(null)}
            onKeyDown={onKeyDown}
          >
            {ticks.map((tick) => (
              <g key={tick}>
                <line className="chart-grid" x1={PAD.left} x2={width - PAD.right} y1={y(tick)} y2={y(tick)} />
                <text className="chart-tick" x={PAD.left - 8} y={y(tick)} dy="0.32em" textAnchor="end">
                  {tick}
                </text>
              </g>
            ))}
            {data.map((row, i) =>
              (i % labelEvery === 0 && n - 1 - i >= labelEvery) || i === n - 1 ? (
                <text
                  key={row.key}
                  className="chart-tick"
                  x={x(i)}
                  y={height - 6}
                  textAnchor="middle"
                >
                  {row.label}
                </text>
              ) : null
            )}

            {series.map((s, si) => {
              const line = data.map((row, i) => `${i ? "L" : "M"}${x(i)},${y(row[s.id] || 0)}`).join(" ");
              return (
                <g key={s.id}>
                  {si === 0 && (
                    <path className="chart-area" d={`${line} L${x(n - 1)},${y(0)} L${x(0)},${y(0)} Z`} fill={s.color} />
                  )}
                  <path className="chart-line" d={line} stroke={s.color} />
                  {active === null && (
                    <circle className="chart-dot" cx={x(n - 1)} cy={y(data[n - 1][s.id] || 0)} r={4} fill={s.color} />
                  )}
                </g>
              );
            })}

            {active !== null && (
              <g>
                <line className="chart-crosshair" x1={x(active)} x2={x(active)} y1={PAD.top} y2={PAD.top + innerH} />
                {series.map((s) => (
                  <circle key={s.id} className="chart-dot" cx={x(active)} cy={y(data[active][s.id] || 0)} r={4.5} fill={s.color} />
                ))}
              </g>
            )}
          </svg>

          {active !== null && (
            <div
              className="chart-tooltip"
              style={{ left: tipLeft, top: PAD.top, transform: flip ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
              aria-hidden="true"
            >
              <strong>{data[active].full || data[active].label}</strong>
              {series.map((s) => (
                <span key={s.id}>
                  <i style={{ background: s.color }} />
                  {s.label}
                  <b>{data[active][s.id] || 0}</b>
                </span>
              ))}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}

/* ----- horizontal bar list (one measure, ranked) ----- */

export function BarList({ rows, emptyTitle, emptyText, onSelect, total, color = "var(--chart-1)", ariaLabel }) {
  const visible = rows.filter((row) => row.value > 0);
  if (visible.length === 0) return <ChartEmpty title={emptyTitle} text={emptyText} />;
  const peak = Math.max(...visible.map((row) => row.value));
  const sum = total ?? visible.reduce((acc, row) => acc + row.value, 0);

  return (
    <ul className="bar-list" aria-label={ariaLabel}>
      {visible.map((row) => {
        const share = sum ? Math.round((row.value / sum) * 100) : 0;
        const content = (
          <>
            <span className="bar-list-label">{row.label}</span>
            <span className="bar-list-value">
              {row.value}
              <small>{share}%</small>
            </span>
            <span className="bar-list-track" aria-hidden="true">
              <span style={{ width: `${(row.value / peak) * 100}%`, background: color }} />
            </span>
          </>
        );
        return (
          <li key={row.key}>
            {onSelect ? (
              <button type="button" className="bar-list-row" onClick={() => onSelect(row)} title={`${row.name || row.key}: ${row.value} (${share}%)`}>
                {content}
              </button>
            ) : (
              <div className="bar-list-row" title={`${row.name || row.key}: ${row.value} (${share}%)`}>
                {content}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/* ----- grouped bars (two measures per row on one scale) ----- */

export function GroupedBars({ rows, series, emptyTitle, emptyText }) {
  if (rows.length === 0) return <ChartEmpty title={emptyTitle} text={emptyText} />;
  const peak = Math.max(1, ...rows.flatMap((row) => series.map((s) => row[s.id] || 0)));

  return (
    <div className="grouped">
      <Legend items={series} />
      <ul className="grouped-rows">
        {rows.map((row) => (
          <li key={row.key} title={`${row.label}: ${series.map((s) => `${s.label} ${row[s.id] || 0}`).join(", ")}`}>
            <span className="grouped-label">{row.label}</span>
            <span className="grouped-bars">
              {series.map((s) => (
                <span key={s.id} className="grouped-bar">
                  <span className="grouped-fill" style={{ width: `${((row[s.id] || 0) / peak) * 100}%`, background: s.color }} />
                  <b>{row[s.id] || 0}</b>
                </span>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ----- progress meter (part of a whole) ----- */

export function ProgressMeter({ label, value, total, hint, tone = "accent" }) {
  const pct = total > 0 ? Math.round((value / total) * 100) : null;
  return (
    <div className="meter">
      <div className="meter-head">
        <span>{label}</span>
        <b>{pct === null ? "—" : `${pct}%`}</b>
      </div>
      <div
        className={`meter-track tone-${tone}`}
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={total || 0}
        aria-valuenow={value}
      >
        <span style={{ width: `${pct || 0}%` }} />
      </div>
      <small>{total > 0 ? `${value} of ${total}${hint ? ` ${hint}` : ""}` : "Nothing to measure yet"}</small>
    </div>
  );
}

/* ----- segmented range control ----- */

export function RangeTabs({ options, value, onChange, label = "Date range" }) {
  return (
    <div className="range-tabs" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.id}
          type="button"
          role="radio"
          aria-checked={value === option.id}
          className={value === option.id ? "is-active" : ""}
          onClick={() => onChange(option.id)}
          title={option.title}
        >
          {option.short}
        </button>
      ))}
    </div>
  );
}

/* ----- arc gauge with tick labels and an end knob (hero figure) ----- */

export function ArcGauge({ value, total, label, caption, size = 230, stroke = 14, sweep = 240 }) {
  const share = total > 0 ? Math.min(1, value / total) : 0;
  const pct = total > 0 ? Math.round(share * 100) : null;
  const cx = size / 2;
  const cy = size / 2;
  const r = size / 2 - stroke / 2 - 22; // room for the tick labels outside the arc
  const half = sweep / 2;
  const point = (deg, radius) => {
    const rad = (deg * Math.PI) / 180;
    return [cx + radius * Math.sin(rad), cy - radius * Math.cos(rad)];
  };
  const arc = (from, to) => {
    const [x0, y0] = point(from, r);
    const [x1, y1] = point(to, r);
    return `M${x0} ${y0} A${r} ${r} 0 ${to - from > 180 ? 1 : 0} 1 ${x1} ${y1}`;
  };
  const end = -half + sweep * share;
  const [kx, ky] = point(end, r);
  // Lowest point is the tick label at either end of the arc.
  const height = Math.ceil(cy + (r + stroke / 2 + 13) * Math.max(0, Math.cos(((180 - half) * Math.PI) / 180)) + 12);

  return (
    <figure className="arc-gauge" aria-label={`${label}: ${pct === null ? "no data" : `${pct}%`}${caption ? `, ${caption}` : ""}`}>
      <svg width={size} height={height} viewBox={`0 0 ${size} ${height}`} aria-hidden="true">
        <path className="arc-track" d={arc(-half, half)} strokeWidth={stroke} />
        {share > 0 && <path className="arc-value" d={arc(-half, half)} strokeWidth={stroke} pathLength={100} strokeDasharray={`${share * 100} 100`} />}
        {[0, 20, 40, 60, 80, 100].map((tick) => {
          const [tx, ty] = point(-half + (sweep * tick) / 100, r + stroke / 2 + 13);
          return (
            <text key={tick} className="arc-tick" x={tx} y={ty} dy="0.32em" textAnchor="middle">
              {tick}
            </text>
          );
        })}
        {share > 0 && <circle className="arc-knob" cx={kx} cy={ky} r={stroke / 2 + 2} />}
        <text className="arc-pct" x={cx} y={cy - 2} textAnchor="middle">
          {pct === null ? "—" : `${pct}%`}
        </text>
        <text className="arc-label" x={cx} y={cy + 20} textAnchor="middle">
          {label}
        </text>
      </svg>
      {caption && <figcaption>{caption}</figcaption>}
    </figure>
  );
}

/* ----- tall status columns with a share bubble ----- */

export function StatusColumns({ rows, total, onSelect, height = 190, emptyTitle, emptyText }) {
  if (!total) return <ChartEmpty title={emptyTitle} text={emptyText} />;
  const peak = Math.max(1, ...rows.map((row) => row.value));
  const usable = height - 40; // label + count rows below the bars

  return (
    <div className="status-cols" style={{ height }} role="list" aria-label="Leads by status">
      {rows.map((row) => {
        const share = Math.round((row.value / total) * 100);
        const barPx = row.value > 0 ? Math.max(6, (row.value / peak) * (usable - 22)) : 3;
        const inside = barPx >= 44;
        return (
          <button
            key={row.key}
            type="button"
            role="listitem"
            className={`status-col tone-${row.tone}`}
            onClick={() => onSelect && onSelect(row)}
            title={`${row.label}: ${row.value} (${share}%)`}
            aria-label={`${row.label}: ${row.value} leads, ${share}%`}
          >
            <span className="status-col-plot">
              <span className="status-col-bar" style={{ height: barPx }}>
                <span className={`status-col-pct ${inside ? "inside" : "outside"}`}>{share}%</span>
              </span>
            </span>
            <span className="status-col-label">{row.label}</span>
            <span className="status-col-count">{row.value}</span>
          </button>
        );
      })}
    </div>
  );
}
