import { useId, useMemo, useRef, useState } from 'react';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  LabelList,
  Line,
  LineChart,
  Pie,
  PieChart,
  ReferenceLine,
  ResponsiveContainer,
  Sector,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import {
  paletteColors,
  type ChartWidgetConfig,
  type MetricUnit,
} from '../../types/reportCharts';
import {
  evaluateChartWidget,
  type CustomReportContext,
  type EvaluatedChartRow,
  type EvaluatedSeriesMeta,
} from '../../services/customReportEngine';
import { exportCsv } from '../../services/financeCsv';
import { financeCents, financeDateLabel } from '../../services/financePayments';
import { reportChange } from '../../services/financeReports';
import { formatBRL as money } from '../../services/money';

const compactNum = new Intl.NumberFormat('pt-BR', { notation: 'compact', maximumFractionDigits: 1 });
const decimalNum = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
const pctFmt = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });

function formatMetricValue(value: number, unit: MetricUnit): string {
  if (!Number.isFinite(value)) return '—';
  if (unit === 'currency') return money(value);
  if (unit === 'percent') return `${decimalNum.format(value)}%`;
  if (unit === 'minutes') return `${decimalNum.format(value)} min`;
  return decimalNum.format(value);
}

function formatAxisTick(value: number, unit: MetricUnit): string {
  if (!Number.isFinite(value)) return '';
  if (unit === 'currency') return `R$ ${compactNum.format(value)}`;
  if (unit === 'percent') return `${decimalNum.format(value)}%`;
  if (unit === 'minutes') return `${decimalNum.format(value)}m`;
  return compactNum.format(value);
}

function variationText(value: number, previous: number | undefined, against: string): string {
  if (previous === undefined) return 'Sem base anterior';
  const change = reportChange(value, previous);
  return change === null ? 'Base anterior zerada' : `${change > 0 ? '+' : ''}${pctFmt.format(change)}% ${against}`;
}

function CustomChartTooltip({
  active,
  label,
  rows,
  series,
  isTimeline,
}: TooltipContentProps & {
  rows: EvaluatedChartRow[];
  series: EvaluatedSeriesMeta[];
  isTimeline: boolean;
}) {
  if (!active) return null;
  const idx = rows.findIndex((r) => r.label === label || r.key === label);
  const row = rows[idx];
  if (!row) return null;
  const prevRow = isTimeline && idx > 0 ? rows[idx - 1] : undefined;

  return (
    <div className="report-chart-tooltip" role="status">
      <strong>{row.fullLabel}</strong>
      {series.map((s) => {
        const val = row.values[s.id] ?? 0;
        const prevVal = prevRow ? prevRow.values[s.id] : row.previousValues?.[s.id];
        const against = prevRow ? 'vs. intervalo anterior' : 'vs. período anterior';
        return (
          <div key={s.id}>
            <span><i style={{ background: s.color }} />{s.label}</span>
            <b>{formatMetricValue(val, s.unit)}</b>
            {prevVal !== undefined && <small>{variationText(val, prevVal, against)}</small>}
          </div>
        );
      })}
    </div>
  );
}

function exportChartSvgToPng(container: HTMLElement | null, title: string, subtitle: string) {
  if (!container) return;
  const svg = container.querySelector('svg.recharts-surface') as SVGSVGElement | null;
  if (!svg) return;
  const rect = svg.getBoundingClientRect();
  const width = Math.max(480, Math.round(rect.width));
  const height = Math.max(260, Math.round(rect.height));
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));

  // Inline computed colors on SVG text/lines so dark-glass or CSS vars survive serialization
  const computedBg = getComputedStyle(container).getPropertyValue('--report-surface').trim() || '#ffffff';
  const computedInk = getComputedStyle(container).getPropertyValue('--report-ink').trim() || '#172135';
  const computedMuted = getComputedStyle(container).getPropertyValue('--report-muted').trim() || '#526177';

  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  img.onload = () => {
    const scale = 2;
    const padX = 28;
    const headerH = subtitle ? 64 : 46;
    const padBottom = 20;
    const canvas = document.createElement('canvas');
    canvas.width = (width + padX * 2) * scale;
    canvas.height = (height + headerH + padBottom) * scale;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.scale(scale, scale);
      ctx.fillStyle = computedBg;
      ctx.fillRect(0, 0, width + padX * 2, height + headerH + padBottom);
      ctx.fillStyle = computedInk;
      ctx.font = '700 16px system-ui, -apple-system, sans-serif';
      ctx.fillText(title, padX, 28);
      if (subtitle) {
        ctx.fillStyle = computedMuted;
        ctx.font = '400 12px system-ui, -apple-system, sans-serif';
        ctx.fillText(subtitle.slice(0, 110), padX, 47);
      }
      ctx.drawImage(img, padX, headerH, width, height);
      const link = document.createElement('a');
      const slug = title.toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grafico';
      link.download = `hotel-lindoia-${slug}.png`;
      link.href = canvas.toDataURL('image/png');
      link.click();
    }
    URL.revokeObjectURL(url);
  };
  img.onerror = () => URL.revokeObjectURL(url);
  img.src = url;
}

export interface CustomizableChartCardProps {
  widget: ChartWidgetConfig;
  context: CustomReportContext;
  preview?: boolean;
  canMoveLeft?: boolean;
  canMoveRight?: boolean;
  onEdit?: () => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onMove?: (direction: -1 | 1) => void;
}

export function CustomizableChartCard({
  widget,
  context,
  preview = false,
  canMoveLeft = false,
  canMoveRight = false,
  onEdit,
  onDuplicate,
  onDelete,
  onMove,
}: CustomizableChartCardProps) {
  const titleId = useId();
  const gradientPrefix = useId().replace(/:/g, '');
  const cardRef = useRef<HTMLElement | null>(null);
  const [hiddenSeriesIds, setHiddenSeriesIds] = useState<string[]>([]);
  const [activeSlice, setActiveSlice] = useState<number | null>(null);

  const evaluated = useMemo(() => evaluateChartWidget(widget, context), [widget, context]);
  const visibleSeries = useMemo(() => {
    const active = evaluated.series.filter((s) => !hiddenSeriesIds.includes(s.id));
    return active.length > 0 ? active : evaluated.series;
  }, [evaluated.series, hiddenSeriesIds]);

  const flatRows = useMemo(
    () => evaluated.rows.map((row) => ({ __key: row.key, __label: row.label, ...row.values })),
    [evaluated.rows],
  );

  const isEmpty = !evaluated.rows.some((r) => visibleSeries.some((s) => (r.values[s.id] ?? 0) !== 0));
  const primary = visibleSeries[0];
  const palColors = paletteColors(widget.style.paletteId);
  const showLegend = widget.style.legendPosition !== 'hidden' && widget.chartType !== 'kpi' && widget.chartType !== 'donut' && widget.chartType !== 'pie';
  const isTimeline = widget.dimension === 'timeline';

  const plotHeightClass = widget.height === 'compact'
    ? 'report-plot-compact'
    : widget.height === 'tall'
      ? 'report-plot-tall'
      : 'report-plot-normal';

  const toggleSeries = (id: string) => {
    setHiddenSeriesIds((prev) => {
      if (prev.includes(id)) return prev.filter((item) => item !== id);
      if (evaluated.series.length - prev.length <= 1) return prev;
      return [...prev, id];
    });
  };

  const handleExportCsv = () => {
    const slug = widget.title.toLocaleLowerCase('pt-BR').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'grafico';
    exportCsv(`hotel-lindoia-${slug}.csv`, [
      [widget.title],
      ['Período', `${evaluated.effectiveRange.from} a ${evaluated.effectiveRange.to}`],
      [],
      ['Item / Período', ...visibleSeries.map((s) => s.label)],
      ...evaluated.rows.map((r) => [r.fullLabel, ...visibleSeries.map((s) => r.values[s.id] ?? 0)]),
    ], true);
  };

  const handleExportPng = () => {
    exportChartSvgToPng(
      cardRef.current,
      widget.title,
      `${financeDateLabel(evaluated.effectiveRange.from)} a ${financeDateLabel(evaluated.effectiveRange.to)}`,
    );
  };

  const legendNode = showLegend ? (
    <div
      className={`report-series-controls flex flex-wrap items-center gap-2 ${widget.style.legendPosition === 'bottom' ? 'report-legend-bottom' : ''}`}
      role="group"
      aria-label={`Séries exibidas em ${widget.title}`}
    >
      {evaluated.series.map((s) => {
        const active = visibleSeries.some((v) => v.id === s.id);
        return (
          <button
            key={s.id}
            type="button"
            aria-pressed={active}
            onClick={() => toggleSeries(s.id)}
            title={evaluated.series.length > 1 ? 'Clique para mostrar ou ocultar esta série' : undefined}
          >
            <i style={{ background: s.color }} />
            <span>{s.label}</span>
            <strong className="report-series-chip-val">{formatMetricValue(s.total, s.unit)}</strong>
          </button>
        );
      })}
    </div>
  ) : null;

  const refLine = widget.style.referenceLine?.enabled && Number.isFinite(widget.style.referenceLine.value)
    ? widget.style.referenceLine
    : null;

  const renderChartBody = () => {
    if (widget.chartType === 'kpi') {
      return (
        <div className="custom-kpi-grid">
          {evaluated.series.map((s) => {
            const change = s.changePct;
            const direction = change === null || change === 0 ? 'flat' : change > 0 ? 'up' : 'down';
            const sentiment = direction === 'flat' ? 'neutral' : (direction === 'up') !== s.lessIsBetter ? 'good' : 'bad';
            return (
              <div key={s.id} className="custom-kpi-tile" style={{ borderLeftColor: s.color }}>
                <span className="custom-kpi-label"><i style={{ background: s.color }} />{s.label}</span>
                <strong className={`custom-kpi-value tabular-nums ${s.total < 0 ? 'finance-amount-negative' : ''}`}>
                  {formatMetricValue(s.total, s.unit)}
                </strong>
                {widget.style.showComparison && evaluated.comparisonLabel && (
                  <div className="report-metric-trend">
                    <span data-sentiment={sentiment}>
                      <i>{direction === 'up' ? '↑' : direction === 'down' ? '↓' : '•'}</i>
                      {change === null ? 'Sem base' : `${change > 0 ? '+' : ''}${pctFmt.format(change)}%`}
                    </span>
                    <small>{evaluated.comparisonLabel}</small>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      );
    }

    if (isEmpty || !primary) {
      return <div className="report-chart-empty">Sem valores registrados no período para esta seleção.</div>;
    }

    if (widget.chartType === 'breakdown') {
      const max = Math.max(0, ...evaluated.rows.map((r) => Math.abs(r.values[primary.id] ?? 0)));
      const totalCents = evaluated.rows.reduce((sum, r) => sum + Math.max(0, financeCents(r.values[primary.id] ?? 0)), 0);
      return (
        <ul className="report-breakdown custom-breakdown-list">
          {evaluated.rows.map((row, idx) => {
            const val = row.values[primary.id] ?? 0;
            const share = totalCents > 0 && val > 0 ? (financeCents(val) / totalCents) * 100 : null;
            const barColor = evaluated.series.length === 1 && widget.style.paletteId !== 'hotel'
              ? palColors[idx % palColors.length]
              : primary.color;
            return (
              <li key={row.key}>
                <div>
                  <span>{row.label}</span>
                  <strong>
                    {formatMetricValue(val, primary.unit)}
                    {share !== null && <small className="custom-breakdown-share"> · {pctFmt.format(share)}%</small>}
                  </strong>
                </div>
                <div className="report-breakdown-track" aria-hidden="true">
                  <i style={{ width: `${max > 0 ? (Math.abs(val) / max) * 100 : 0}%`, background: barColor }} />
                </div>
              </li>
            );
          })}
        </ul>
      );
    }

    if (widget.chartType === 'donut' || widget.chartType === 'pie') {
      const positiveRows = evaluated.rows.filter((r) => (r.values[primary.id] ?? 0) > 0);
      const totalCents = positiveRows.reduce((sum, r) => sum + financeCents(r.values[primary.id] ?? 0), 0);
      if (totalCents <= 0) {
        return <div className="report-chart-empty">Sem valores positivos para distribuir em fatias.</div>;
      }
      const segments = positiveRows.map((row, idx) => {
        const val = row.values[primary.id] ?? 0;
        return {
          label: row.label,
          value: val,
          previous: row.previousValues?.[primary.id],
          share: (financeCents(val) / totalCents) * 100,
          fill: palColors[idx % palColors.length],
        };
      });
      const selected = activeSlice === null ? undefined : segments[activeSlice];
      const innerR = widget.chartType === 'pie'
        ? 0
        : widget.style.donutThickness === 'thin'
          ? 76
          : widget.style.donutThickness === 'thick'
            ? 46
            : 66;
      const outerR = 92;

      return (
        <div className="custom-pie-layout">
          <div className="report-donut-plot" onPointerLeave={() => setActiveSlice(null)}>
            <div aria-hidden="true" className={widget.chartType === 'pie' ? 'custom-pie-chart' : 'report-donut-chart'}>
              <PieChart width={212} height={212} accessibilityLayer={false}>
                <Pie
                  data={segments}
                  dataKey="value"
                  nameKey="label"
                  innerRadius={innerR}
                  outerRadius={outerR}
                  startAngle={90}
                  endAngle={-270}
                  paddingAngle={segments.length > 1 ? 2 : 0}
                  stroke="none"
                  isAnimationActive={false}
                  rootTabIndex={-1}
                  onMouseEnter={(_, idx) => setActiveSlice(idx)}
                  onClick={(_, idx) => setActiveSlice(idx)}
                  shape={(props) => (
                    <Sector
                      {...props}
                      opacity={selected && activeSlice !== props.index ? 0.42 : 1}
                      outerRadius={props.outerRadius + (activeSlice === props.index ? 4 : 0)}
                    />
                  )}
                />
              </PieChart>
            </div>
            {widget.chartType === 'donut' && (
              <div className="report-donut-center">
                <span>{selected ? selected.label : 'Total'}</span>
                <strong>{formatMetricValue(selected?.value ?? totalCents / 100, primary.unit)}</strong>
                {selected && <small>{pctFmt.format(selected.share)}%</small>}
              </div>
            )}
          </div>
          <ul className="report-donut-legend">
            {segments.map((seg, idx) => (
              <li key={seg.label}>
                <button
                  type="button"
                  className="report-donut-row"
                  aria-pressed={activeSlice === idx}
                  onFocus={() => setActiveSlice(idx)}
                  onBlur={() => setActiveSlice(null)}
                  onPointerEnter={() => setActiveSlice(idx)}
                  onPointerLeave={() => setActiveSlice(null)}
                  onClick={() => setActiveSlice(idx)}
                >
                  <i style={{ background: seg.fill }} />
                  <span>{seg.label}</span>
                  <b>{formatMetricValue(seg.value, primary.unit)} · {pctFmt.format(seg.share)}%</b>
                </button>
              </li>
            ))}
          </ul>
          <div className="report-donut-note" aria-live="polite">
            {selected
              ? `${selected.label}: ${formatMetricValue(selected.value, primary.unit)} (${variationText(selected.value, widget.style.showComparison ? selected.previous : undefined, 'vs. período anterior')})`
              : 'Passe o mouse ou clique em um item para inspecionar.'}
          </div>
        </div>
      );
    }

    if (widget.chartType === 'horizontal_bar') {
      const dynamicHeight = Math.max(220, Math.min(540, evaluated.rows.length * 40 + 40));
      return (
        <div className="report-chart-plot" style={{ height: `${dynamicHeight}px` }}>
          <ResponsiveContainer width="100%" height="100%" minWidth={0}>
            <BarChart data={flatRows} layout="vertical" margin={{ top: 8, right: widget.style.showValues ? 64 : 18, left: 6, bottom: 4 }}>
              {widget.style.showGrid && <CartesianGrid stroke="var(--report-grid)" strokeDasharray="3 4" horizontal={false} />}
              <XAxis
                type="number"
                tickFormatter={(v: number) => formatAxisTick(v, evaluated.leftUnit)}
                tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                type="category"
                dataKey="__label"
                width={132}
                tick={{ fill: 'var(--report-ink)', fontSize: 11 }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip
                content={(props) => <CustomChartTooltip {...props} rows={evaluated.rows} series={visibleSeries} isTimeline={false} />}
                cursor={{ fill: 'var(--report-subtle)', opacity: 0.7 }}
                isAnimationActive={false}
              />
              {refLine && (
                <ReferenceLine x={refLine.value} stroke={refLine.color} strokeDasharray="4 4" label={{ value: refLine.label, fill: refLine.color, fontSize: 11, position: 'top' }} />
              )}
              {visibleSeries.map((s) => (
                <Bar
                  key={s.id}
                  dataKey={s.id}
                  name={s.label}
                  fill={s.color}
                  radius={[0, widget.style.barRadius, widget.style.barRadius, 0]}
                  maxBarSize={26}
                  isAnimationActive={!preview}
                  animationDuration={360}
                >
                  {widget.style.showValues && (
                    <LabelList
                      dataKey={s.id}
                      position="right"
                      formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                      style={{ fill: 'var(--report-muted)', fontSize: 10, fontWeight: 600 }}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          </ResponsiveContainer>
        </div>
      );
    }

    const commonMargins = { top: widget.style.showValues ? 22 : 12, right: evaluated.hasRightAxis ? 14 : 10, left: 2, bottom: 0 };
    const sharedAxes = (
      <>
        {widget.style.showGrid && <CartesianGrid stroke="var(--report-grid)" strokeDasharray="3 4" vertical={false} />}
        <XAxis
          dataKey="__label"
          tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickMargin={9}
          minTickGap={16}
          interval="preserveStartEnd"
        />
        <YAxis
          yAxisId="left"
          tickFormatter={(v: number) => formatAxisTick(v, evaluated.leftUnit)}
          tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
          tickLine={false}
          axisLine={false}
          tickMargin={7}
          width={evaluated.leftUnit === 'currency' ? 68 : 48}
          tickCount={5}
        />
        {evaluated.hasRightAxis && (
          <YAxis
            yAxisId="right"
            orientation="right"
            tickFormatter={(v: number) => formatAxisTick(v, evaluated.rightUnit)}
            tick={{ fill: 'var(--report-muted)', fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            tickMargin={7}
            width={evaluated.rightUnit === 'currency' ? 68 : 48}
            tickCount={5}
          />
        )}
        <ReferenceLine yAxisId="left" y={0} stroke="var(--report-border)" />
        {refLine && (
          <ReferenceLine
            yAxisId="left"
            y={refLine.value}
            stroke={refLine.color}
            strokeDasharray="5 4"
            strokeWidth={1.5}
            label={{ value: refLine.label, fill: refLine.color, fontSize: 11, position: 'insideTopRight' }}
          />
        )}
        <Tooltip
          content={(props) => <CustomChartTooltip {...props} rows={evaluated.rows} series={visibleSeries} isTimeline={isTimeline} />}
          cursor={widget.chartType === 'area' || widget.chartType === 'line'
            ? { stroke: 'var(--report-muted)', strokeDasharray: '3 4' }
            : { fill: 'var(--report-subtle)', opacity: 0.78 }}
          isAnimationActive={false}
        />
      </>
    );

    const gradientDefs = (
      <defs>
        {visibleSeries.map((s) => (
          <linearGradient key={s.id} id={`${gradientPrefix}-${s.id}`} x1="0%" x2="0%" y1="0%" y2="100%">
            <stop offset="0%" stopColor={s.color} stopOpacity={0.34} />
            <stop offset="100%" stopColor={s.color} stopOpacity={0.03} />
          </linearGradient>
        ))}
      </defs>
    );

    const resolveFill = (s: EvaluatedSeriesMeta) => {
      if (widget.style.fillStyle === 'none') return 'transparent';
      if (widget.style.fillStyle === 'solid') return s.color;
      return `url(#${gradientPrefix}-${s.id})`;
    };

    const resolveFillOpacity = () => {
      if (widget.style.fillStyle === 'none') return 0;
      if (widget.style.fillStyle === 'solid') return 0.2;
      return 1;
    };

    return (
      <div className={`report-chart-plot ${plotHeightClass}`}>
        <ResponsiveContainer width="100%" height="100%" minWidth={0}>
          {widget.chartType === 'area' ? (
            <AreaChart data={flatRows} margin={commonMargins} accessibilityLayer title={widget.title}>
              {gradientDefs}
              {sharedAxes}
              {visibleSeries.map((s) => (
                <Area
                  key={s.id}
                  yAxisId={s.yAxis}
                  dataKey={s.id}
                  name={s.label}
                  type={widget.style.curve}
                  stroke={s.color}
                  strokeWidth={widget.style.strokeWidth}
                  fill={resolveFill(s)}
                  fillOpacity={resolveFillOpacity()}
                  dot={flatRows.length <= 12 ? { r: 3, fill: s.color } : false}
                  activeDot={{ r: 5, stroke: 'var(--report-surface)', strokeWidth: 2 }}
                  isAnimationActive={!preview}
                  animationDuration={380}
                >
                  {widget.style.showValues && (
                    <LabelList
                      dataKey={s.id}
                      position="top"
                      formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                      style={{ fill: 'var(--report-muted)', fontSize: 10 }}
                    />
                  )}
                </Area>
              ))}
            </AreaChart>
          ) : widget.chartType === 'line' ? (
            <LineChart data={flatRows} margin={commonMargins} accessibilityLayer title={widget.title}>
              {sharedAxes}
              {visibleSeries.map((s) => (
                <Line
                  key={s.id}
                  yAxisId={s.yAxis}
                  dataKey={s.id}
                  name={s.label}
                  type={widget.style.curve}
                  stroke={s.color}
                  strokeWidth={widget.style.strokeWidth}
                  dot={flatRows.length <= 20 ? { r: 3, fill: s.color } : false}
                  activeDot={{ r: 5, stroke: 'var(--report-surface)', strokeWidth: 2 }}
                  isAnimationActive={!preview}
                  animationDuration={380}
                >
                  {widget.style.showValues && (
                    <LabelList
                      dataKey={s.id}
                      position="top"
                      formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                      style={{ fill: 'var(--report-muted)', fontSize: 10 }}
                    />
                  )}
                </Line>
              ))}
            </LineChart>
          ) : widget.chartType === 'composed' ? (
            <ComposedChart data={flatRows} margin={commonMargins} accessibilityLayer title={widget.title}>
              {gradientDefs}
              {sharedAxes}
              {visibleSeries.map((s) => {
                if (s.visualType === 'line') {
                  return (
                    <Line
                      key={s.id}
                      yAxisId={s.yAxis}
                      dataKey={s.id}
                      name={s.label}
                      type={widget.style.curve}
                      stroke={s.color}
                      strokeWidth={widget.style.strokeWidth}
                      dot={{ r: 3.5, fill: s.color }}
                      activeDot={{ r: 5.5, stroke: 'var(--report-surface)', strokeWidth: 2 }}
                      isAnimationActive={!preview}
                      animationDuration={380}
                    >
                      {widget.style.showValues && (
                        <LabelList
                          dataKey={s.id}
                          position="top"
                          formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                          style={{ fill: s.color, fontSize: 10, fontWeight: 700 }}
                        />
                      )}
                    </Line>
                  );
                }
                if (s.visualType === 'area') {
                  return (
                    <Area
                      key={s.id}
                      yAxisId={s.yAxis}
                      dataKey={s.id}
                      name={s.label}
                      type={widget.style.curve}
                      stroke={s.color}
                      strokeWidth={widget.style.strokeWidth}
                      fill={resolveFill(s)}
                      fillOpacity={resolveFillOpacity()}
                      isAnimationActive={!preview}
                      animationDuration={380}
                    />
                  );
                }
                return (
                  <Bar
                    key={s.id}
                    yAxisId={s.yAxis}
                    dataKey={s.id}
                    name={s.label}
                    fill={s.color}
                    radius={[widget.style.barRadius, widget.style.barRadius, 0, 0]}
                    maxBarSize={34}
                    isAnimationActive={!preview}
                    animationDuration={380}
                  >
                    {widget.style.showValues && (
                      <LabelList
                        dataKey={s.id}
                        position="top"
                        formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                        style={{ fill: 'var(--report-muted)', fontSize: 10 }}
                      />
                    )}
                  </Bar>
                );
              })}
            </ComposedChart>
          ) : (
            <BarChart data={flatRows} margin={commonMargins} accessibilityLayer title={widget.title}>
              {sharedAxes}
              {visibleSeries.map((s) => (
                <Bar
                  key={s.id}
                  yAxisId={s.yAxis}
                  dataKey={s.id}
                  name={s.label}
                  fill={s.color}
                  stackId={widget.chartType === 'stacked_bar' ? 'stack' : undefined}
                  radius={widget.chartType === 'stacked_bar' ? [2, 2, 0, 0] : [widget.style.barRadius, widget.style.barRadius, 0, 0]}
                  maxBarSize={34}
                  isAnimationActive={!preview}
                  animationDuration={380}
                >
                  {widget.style.showValues && (
                    <LabelList
                      dataKey={s.id}
                      position="top"
                      formatter={(v) => (typeof v === 'number' && v !== 0 ? formatAxisTick(v, s.unit) : '')}
                      style={{ fill: 'var(--report-muted)', fontSize: 10 }}
                    />
                  )}
                </Bar>
              ))}
            </BarChart>
          )}
        </ResponsiveContainer>
      </div>
    );
  };

  return (
    <section
      ref={cardRef}
      className={`report-surface report-chart-card custom-chart-card min-w-0 rounded-2xl border p-4 shadow-sm sm:p-6 ${widget.size === 'full' ? 'report-wide' : ''}`}
      aria-labelledby={titleId}
    >
      <div className="report-chart-heading flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h2 id={titleId}>{widget.title}</h2>
            {widget.periodOverride?.enabled && (
              <span className="custom-period-badge" title="Período próprio configurado neste gráfico">
                {financeDateLabel(evaluated.effectiveRange.from)} a {financeDateLabel(evaluated.effectiveRange.to)}
              </span>
            )}
          </div>
          {widget.description && <p>{widget.description}</p>}
        </div>

        <div className="custom-card-header-right">
          {visibleSeries.length === 1 && widget.chartType !== 'kpi' && primary && (
            <strong className="report-chart-summary tabular-nums">
              {formatMetricValue(primary.total, primary.unit)}
            </strong>
          )}
          {!preview && (
            <div className="custom-card-actions" role="toolbar" aria-label={`Ações do gráfico ${widget.title}`}>
              {onEdit && (
                <button type="button" className="custom-icon-btn custom-icon-btn-primary" onClick={onEdit} title="Editar dados, cores e estilo">
                  Editar
                </button>
              )}
              {onDuplicate && (
                <button type="button" className="custom-icon-btn" onClick={onDuplicate} title="Duplicar gráfico">
                  Duplicar
                </button>
              )}
              <button type="button" className="custom-icon-btn" onClick={handleExportCsv} title="Exportar dados deste gráfico em CSV">
                CSV
              </button>
              {widget.chartType !== 'kpi' && widget.chartType !== 'breakdown' && (
                <button type="button" className="custom-icon-btn" onClick={handleExportPng} title="Baixar gráfico como imagem PNG">
                  PNG
                </button>
              )}
              {onMove && (
                <>
                  <button type="button" className="custom-icon-btn" disabled={!canMoveLeft} onClick={() => onMove(-1)} title="Mover para antes" aria-label="Mover gráfico para antes">
                    ←
                  </button>
                  <button type="button" className="custom-icon-btn" disabled={!canMoveRight} onClick={() => onMove(1)} title="Mover para depois" aria-label="Mover gráfico para depois">
                    →
                  </button>
                </>
              )}
              {onDelete && (
                <button type="button" className="custom-icon-btn custom-icon-btn-danger" onClick={onDelete} title="Remover gráfico">
                  ✕
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {widget.style.legendPosition === 'top' && legendNode}
      {renderChartBody()}
      {widget.style.legendPosition === 'bottom' && legendNode}

      {evaluated.dataNotes.length > 0 && (
        <div className="custom-data-notes">
          {evaluated.dataNotes.map((note) => <small key={note}>ⓘ {note}</small>)}
        </div>
      )}

      {!preview && widget.chartType !== 'kpi' && evaluated.rows.length > 0 && (
        <details className="report-chart-data">
          <summary>Ver valores do gráfico ({evaluated.rows.length})</summary>
          <div className="finance-table-wrap">
            <table className="finance-table">
              <thead>
                <tr>
                  <th>{isTimeline ? 'Intervalo' : 'Item'}</th>
                  {visibleSeries.map((s) => <th key={s.id} className="numeric">{s.label}</th>)}
                </tr>
              </thead>
              <tbody>
                {evaluated.rows.map((row) => (
                  <tr key={row.key}>
                    <td>{row.fullLabel}</td>
                    {visibleSeries.map((s) => (
                      <td key={s.id} className="numeric">{formatMetricValue(row.values[s.id] ?? 0, s.unit)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </details>
      )}
    </section>
  );
}
