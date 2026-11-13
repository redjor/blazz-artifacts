import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api } from './api.ts';
import { formatCount, formatDate, formatUtcDay, formatUtcDayLong, relativeDate } from './format.ts';
import { getLocale, t, tn } from './i18n/index.ts';
import type { DayCount, StatsDto, Visibility } from './types.ts';

const DAYS = 30;
const PLOT_H = 112;
const TOP = 18; // room for the peak label
const AXIS_W = 28;
const LABEL_H = 22;
const BAR_MAX = 24;
const GAP = 2;

/** Round axis top above the peak: even under 10 (integer midpoint), then 15, 20, 25, 30, 40, 50, 60, 80, 100… */
function niceTop(max: number): number {
  if (max <= 1) return 1;
  if (max < 10) return Math.ceil(max / 2) * 2;
  const pow = 10 ** Math.floor(Math.log10(max));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * pow >= max) return m * pow;
  return 10 * pow;
}

/** Column with a rounded top (4 px) and a square base on the baseline. */
function barPath(x: number, w: number, h: number, base: number): string {
  const r = Math.min(4, w / 2, h);
  const y = base - h;
  return `M${x},${base}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${base}Z`;
}

const capitalize = (s: string) => s.charAt(0).toLocaleUpperCase(getLocale()) + s.slice(1);

function DayChart({ days }: { days: DayCount[] }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useLayoutEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setWidth(Math.floor(e.contentRect.width)));
    ro.observe(el);
    setWidth(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);

  const sum = days.reduce((s, d) => s + d.views, 0);
  const peakIndex = days.reduce((best, d, i) => (d.views > days[best].views ? i : best), 0);
  const peak = days[peakIndex];
  const top = niceTop(peak.views);
  const plotW = Math.max(width - AXIS_W, 0);
  const slot = plotW / days.length;
  const barW = Math.max(Math.min(BAR_MAX, slot - GAP), 1);
  const base = TOP + PLOT_H;
  const height = base + LABEL_H;
  const y = (v: number) => (v / top) * PLOT_H;
  const ticks = top >= 2 && top % 2 === 0 ? [top / 2, top] : [top];

  const summary = sum === 0
    ? t('audience.noViewsDays', { days: days.length })
    : t('audience.summary', { views: tn('audience.views', sum), days: days.length, peak: tn('audience.views', peak.views), day: formatUtcDay(peak.day) });
  const current = active === null ? null : days[active];

  const onKey = (e: KeyboardEvent) => {
    const last = days.length - 1;
    const from = active ?? last;
    const to = { ArrowLeft: from - 1, ArrowRight: from + 1, Home: 0, End: last }[e.key];
    if (to === undefined) return;
    e.preventDefault();
    setActive(Math.min(Math.max(to, 0), last));
  };

  return (
    <div className="space-y-2">
      <p aria-live="polite" className="min-h-5 text-[13px] leading-5 text-muted">
        {current ? (
          <>
            <span className="text-ink">{capitalize(formatUtcDayLong(current.day))}</span>
            <span aria-hidden="true"> · </span>
            <span className="font-medium text-ink tabular-nums">{tn('audience.views', current.views)}</span>
            <span aria-hidden="true"> · </span>
            <span className="tabular-nums">{tn('audience.visitors', current.uniques)}</span>
          </>
        ) : summary}
      </p>
      {/* Keyboard: ←/→ (Home/End) move the day read out above. */}
      <div ref={wrap} tabIndex={0} role="group" aria-label={t('audience.chartLabel')}
        onKeyDown={onKey} onBlur={() => setActive(null)} onPointerLeave={() => setActive(null)}
        className="rounded-lg outline-offset-4">
        {width > 0 && (
          <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={summary} className="block overflow-visible">
            {ticks.map((t) => (
              <g key={t}>
                <line x1={AXIS_W} x2={width} y1={base - y(t)} y2={base - y(t)} className="stroke-line" strokeWidth={1} shapeRendering="crispEdges" />
                <text x={AXIS_W - 8} y={base - y(t)} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">{formatCount(t)}</text>
              </g>
            ))}
            <text x={AXIS_W - 8} y={base} dy="0.32em" textAnchor="end" className="fill-muted text-[11px] tabular-nums">0</text>
            {days.map((d, i) => {
              const h = y(d.views);
              const x = AXIS_W + i * slot + (slot - barW) / 2;
              const dim = active !== null && active !== i;
              return (
                <g key={d.day}>
                  {h > 0 && <path d={barPath(x, barW, h, base)} className={`fill-[var(--chart-bar)] transition-opacity duration-150 ${dim ? 'opacity-30' : ''}`} />}
                  {/* Hover zone: the full column height, wider than the bar. */}
                  <rect x={AXIS_W + i * slot} y={TOP - 4} width={slot} height={PLOT_H + 4} fill="transparent" onPointerEnter={() => setActive(i)} />
                </g>
              );
            })}
            <line x1={AXIS_W} x2={width} y1={base + 0.5} y2={base + 0.5} className="stroke-line-strong" strokeWidth={1} />
            {active !== null && (
              <line x1={AXIS_W + (active + 0.5) * slot} x2={AXIS_W + (active + 0.5) * slot} y1={base + 3} y2={base + 7} className="stroke-ink" strokeWidth={1.5} strokeLinecap="round" />
            )}
            {peak.views > 0 && active === null && (
              <text x={AXIS_W + (peakIndex + 0.5) * slot} y={base - y(peak.views) - 6} textAnchor={peakIndex > days.length - 3 ? 'end' : peakIndex < 2 ? 'start' : 'middle'}
                className="fill-ink text-[11px] font-medium tabular-nums">{formatCount(peak.views)}</text>
            )}
            <text x={AXIS_W} y={height - 4} className="fill-muted text-[11px]">{formatUtcDay(days[0].day)}</text>
            <text x={width} y={height - 4} textAnchor="end" className="fill-muted text-[11px]">{t('audience.today')}</text>
          </svg>
        )}
      </div>
      <table className="sr-only">
        <caption>{t('audience.caption', { days: days.length })}</caption>
        <thead><tr><th scope="col">{t('audience.day')}</th><th scope="col">{t('audience.viewsColumn')}</th><th scope="col">{t('audience.visitorsColumn')}</th></tr></thead>
        <tbody>
          {days.map((d) => <tr key={d.day}><th scope="row">{formatUtcDay(d.day)}</th><td>{formatCount(d.views)}</td><td>{formatCount(d.uniques)}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}

/**
 * "Audience" block: totals, 30-day series, last visit. Mounted (so reloaded) each time the tab opens.
 * `load` replaces the source (folder statistics); `emptyText` the message when there is no visit.
 */
export function Audience({ id, visibility, load, emptyText }: {
  id: string; visibility: Visibility; load?: (days: number) => Promise<StatsDto>; emptyText?: string;
}) {
  const [stats, setStats] = useState<StatsDto | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    // Another artifact: never the previous one's figures, even for an instant.
    setStats(null);
    setError(null);
    (load ? load(DAYS) : api.stats(id, DAYS)).then((s) => live && setStats(s), (e) => live && setError((e as Error).message));
    return () => {
      live = false;
    };
    // `load` follows `id` (same folder, same source): only an identifier change reloads.
  }, [id]);

  if (error) return <p className="text-sm text-danger">{t('audience.unavailable', { error })}</p>;
  if (!stats) return <p className="text-sm text-muted">{t('audience.loading')}</p>;

  const { views, uniques } = stats.total;
  if (views === 0) {
    return (
      <p className="text-sm text-muted">
        {emptyText ?? (visibility === 'private'
          ? t('audience.emptyPrivate')
          : t('audience.empty'))}
      </p>
    );
  }

  return (
    <div className="space-y-5">
      <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <dt className="text-[13px] text-muted">{t('audience.viewsColumn')}</dt>
          <dd className="text-2xl font-semibold tracking-[-0.01em]">{formatCount(views)}</dd>
        </div>
        <div>
          <dt className="text-[13px] text-muted">{t('audience.visitorsColumn')}</dt>
          <dd className="text-2xl font-semibold tracking-[-0.01em]">{formatCount(uniques)}</dd>
        </div>
        {stats.lastVisitAt && (
          <div>
            <dt className="text-[13px] text-muted">{t('audience.lastVisit')}</dt>
            <dd className="text-sm leading-8"><time dateTime={stats.lastVisitAt} title={formatDate(stats.lastVisitAt)}>{relativeDate(stats.lastVisitAt)}</time></dd>
          </div>
        )}
      </dl>
      <DayChart days={stats.days} />
    </div>
  );
}
