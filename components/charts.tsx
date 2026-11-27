"use client";

import { useEffect, useRef, useState } from "react";
import { CAT_HEX, CAT_LABEL, CATS, type Category } from "./util";

function useWidth(fallback = 560) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(fallback);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(240, Math.round(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

function niceMax(v: number) {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  const n = Math.ceil(v / p);
  return (n <= 2 ? 2 : n <= 5 ? 5 : 10) * p;
}

function dayLabel(d: string) {
  return new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** One series over time: area + 2px line, crosshair tooltip. */
export function AreaChart({ data, label, color = "#2f5bea", height = 220 }: { data: { day: string; v: number }[]; label: string; color?: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const pad = { l: 34, r: 10, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const max = niceMax(Math.max(1, ...data.map((d) => d.v)));
  const x = (i: number) => pad.l + (data.length <= 1 ? 0 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const line = data.map((d, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(d.v).toFixed(1)}`).join(" ");
  const area = `${line} L${x(data.length - 1)},${pad.t + ih} L${x(0)},${pad.t + ih} Z`;
  const ticks = [0, max / 2, max];
  const step = Math.ceil(data.length / Math.max(3, Math.floor(W / 90)));
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg
        viewBox={`0 0 ${W} ${height}`}
        role="img"
        aria-label={label}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          const i = Math.round(((px - pad.l) / iw) * (data.length - 1));
          setHover(Math.max(0, Math.min(data.length - 1, i)));
        }}
      >
        <defs>
          <linearGradient id="ag" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity="0.22" />
            <stop offset="1" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <g className="grid">
          {ticks.map((t) => (
            <line key={t} x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} />
          ))}
        </g>
        <g className="axis">
          {ticks.map((t) => (
            <text key={t} x={pad.l - 8} y={y(t) + 4} textAnchor="end">
              {Math.round(t)}
            </text>
          ))}
          {data.map((d, i) =>
            i % step === 0 || i === data.length - 1 ? (
              <text key={d.day} x={x(i)} y={height - 6} textAnchor="middle">
                {dayLabel(d.day)}
              </text>
            ) : null,
          )}
        </g>
        <path d={area} fill="url(#ag)" />
        <path d={line} fill="none" stroke={color} strokeWidth={2} strokeLinejoin="round" />
        {hover !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke="#c3cad6" strokeDasharray="3 3" />
            <circle cx={x(hover)} cy={y(data[hover].v)} r={5} fill={color} stroke="#fff" strokeWidth={2} />
          </g>
        )}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${(x(hover) / W) * 100}%`, top: `${(y(data[hover].v) / height) * 100}%` }}>
          <b>{dayLabel(data[hover].day)}</b> · {data[hover].v} {label.toLowerCase()}
        </div>
      )}
    </div>
  );
}

/** Daily new leads stacked by category, 2px gaps, 4px rounded tops. */
export function StackedBars({ data, height = 220 }: { data: { day: string; court: number; tax: number; debt: number }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [ref, W] = useWidth();
  const pad = { l: 30, r: 6, t: 10, b: 24 };
  const iw = W - pad.l - pad.r;
  const ih = height - pad.t - pad.b;
  const totals = data.map((d) => d.court + d.tax + d.debt);
  const max = niceMax(Math.max(1, ...totals));
  const slot = iw / data.length;
  const bw = Math.max(4, Math.min(22, slot - 4));
  const y = (v: number) => (v / max) * ih;
  return (
    <div className="chart" ref={ref} onMouseLeave={() => setHover(null)}>
      <svg viewBox={`0 0 ${W} ${height}`} role="img" aria-label="New leads per day by category">
        <g className="grid">
          {[0, max / 2, max].map((t) => (
            <line key={t} x1={pad.l} x2={W - pad.r} y1={pad.t + ih - y(t)} y2={pad.t + ih - y(t)} />
          ))}
        </g>
        <g className="axis">
          {[0, max / 2, max].map((t) => (
            <text key={t} x={pad.l - 8} y={pad.t + ih - y(t) + 4} textAnchor="end">
              {Math.round(t)}
            </text>
          ))}
          {data.map((d, i) =>
            i % Math.max(1, Math.ceil(28 / (W / data.length))) === 0 ? (
              <text key={d.day} x={pad.l + slot * i + slot / 2} y={height - 6} textAnchor="middle">
                {new Date(d.day + "T12:00:00").getDate()}
              </text>
            ) : null,
          )}
        </g>
        {data.map((d, i) => {
          const cx = pad.l + slot * i + (slot - bw) / 2;
          let base = pad.t + ih;
          const segs = CATS.filter((c) => d[c] > 0);
          return (
            <g key={d.day} onMouseEnter={() => setHover(i)}>
              <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
              {segs.map((c, k) => {
                const h = Math.max(2, y(d[c]) - (k < segs.length - 1 ? 2 : 0));
                base -= y(d[c]);
                const top = k === segs.length - 1;
                const r = top ? Math.min(4, bw / 2, h) : 0;
                const yTop = base + (k < segs.length - 1 ? 2 : 0);
                return (
                  <path
                    key={c}
                    d={`M${cx},${yTop + h} V${yTop + r} Q${cx},${yTop} ${cx + r},${yTop} H${cx + bw - r} Q${cx + bw},${yTop} ${cx + bw},${yTop + r} V${yTop + h} Z`}
                    fill={CAT_HEX[c]}
                    opacity={hover === null || hover === i ? 1 : 0.45}
                  />
                );
              })}
            </g>
          );
        })}
      </svg>
      {hover !== null && (
        <div className="tip" style={{ left: `${((pad.l + slot * hover + slot / 2) / W) * 100}%`, top: "18%" }}>
          <b>{dayLabel(data[hover].day)}</b>
          {CATS.map((c) => (
            <div className="row" key={c} style={{ gap: 6 }}>
              <span className="sw" style={{ background: CAT_HEX[c] }} />
              {CAT_LABEL[c]} {data[hover][c]}
            </div>
          ))}
        </div>
      )}
      <div className="legend" style={{ marginTop: 6 }}>
        {CATS.map((c) => (
          <span key={c}>
            <i style={{ background: CAT_HEX[c] }} />
            {CAT_LABEL[c]}
          </span>
        ))}
      </div>
    </div>
  );
}

/** Share of leads by category. */
export function Donut({ counts, onPick }: { counts: Record<Category, number>; onPick?: (c: Category) => void }) {
  const [hover, setHover] = useState<Category | null>(null);
  const total = CATS.reduce((s, c) => s + counts[c], 0);
  const R = 70;
  const r = 46;
  let a0 = -Math.PI / 2;
  const gap = total > 0 && CATS.filter((c) => counts[c] > 0).length > 1 ? 0.025 : 0;
  const arcs = CATS.map((c) => {
    const frac = total ? counts[c] / total : 0;
    const a1 = a0 + frac * Math.PI * 2;
    const s = a0 + gap / 2;
    const e = a1 - gap / 2;
    a0 = a1;
    if (frac <= 0) return null;
    if (frac >= 0.999) return { c, d: `M0,${-R} A${R},${R} 0 1 1 -0.01,${-R} L-0.01,${-r} A${r},${r} 0 1 0 0,${-r} Z` };
    const large = e - s > Math.PI ? 1 : 0;
    const p = (ang: number, rad: number) => `${(Math.cos(ang) * rad).toFixed(2)},${(Math.sin(ang) * rad).toFixed(2)}`;
    return { c, d: `M${p(s, R)} A${R},${R} 0 ${large} 1 ${p(e, R)} L${p(e, r)} A${r},${r} 0 ${large} 0 ${p(s, r)} Z` };
  });
  const shown = hover ?? null;
  return (
    <div className="donut-wrap">
      <svg viewBox="-80 -80 160 160" width="180" height="180" role="img" aria-label="Leads by category">
        {total === 0 && <circle r={(R + r) / 2} fill="none" stroke="var(--line)" strokeWidth={R - r} />}
        {arcs.map(
          (a) =>
            a && (
              <path
                key={a.c}
                d={a.d}
                fill={CAT_HEX[a.c]}
                opacity={hover && hover !== a.c ? 0.4 : 1}
                style={{ cursor: onPick ? "pointer" : "default" }}
                onMouseEnter={() => setHover(a.c)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onPick?.(a.c)}
              />
            ),
        )}
        <text textAnchor="middle" y={-2} style={{ fontSize: 22, fontWeight: 650, fill: "var(--ink)" }}>
          {shown ? counts[shown] : total}
        </text>
        <text textAnchor="middle" y={16} style={{ fontSize: 10, fill: "var(--ink-3)" }}>
          {shown ? CAT_LABEL[shown] : "leads"}
        </text>
      </svg>
      <div className="legend" style={{ justifyContent: "center" }}>
        {CATS.map((c) => (
          <span key={c} onMouseEnter={() => setHover(c)} onMouseLeave={() => setHover(null)} style={{ cursor: onPick ? "pointer" : "default" }} onClick={() => onPick?.(c)}>
            <i style={{ background: CAT_HEX[c] }} />
            {CAT_LABEL[c]} {counts[c]}
          </span>
        ))}
      </div>
    </div>
  );
}
