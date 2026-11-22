import { useMemo, useState, type FormEvent } from 'react';
import { DateInput } from '../ui/DateInput';
import {
  CHART_DIMENSIONS,
  CHART_PALETTES,
  CHART_TYPES,
  QUICK_COLOR_SWATCHES,
  paletteColors,
  type ChartDimension,
  type ChartPaletteId,
  type ChartSeriesConfig,
  type ChartType,
  type ChartWidgetConfig,
} from '../../types/reportCharts';
import type { CustomReportContext } from '../../services/customReportEngine';
import {
  METRIC_GROUPS,
  getMetricDefinition,
  metricsForDimension,
} from '../../services/reportMetricsCatalog';
import { CustomizableChartCard } from './CustomizableChartCard';

type EditorTab = 'dados' | 'estilo' | 'titulo';

function makeSeriesId(): string {
  return `s-${Math.random().toString(36).slice(2, 9)}`;
}

export interface ChartEditorModalProps {
  initial: ChartWidgetConfig;
  isNew?: boolean;
  context: CustomReportContext;
  expenseCategories: string[];
  incomeCategories: string[];
  onClose: () => void;
  onSave: (next: ChartWidgetConfig) => void;
}

export function ChartEditorModal({
  initial,
  isNew = false,
  context,
  expenseCategories,
  incomeCategories,
  onClose,
  onSave,
}: ChartEditorModalProps) {
  const [draft, setDraft] = useState<ChartWidgetConfig>(() => structuredClone(initial));
  const [tab, setTab] = useState<EditorTab>('dados');
  const [categorySearch, setCategorySearch] = useState('');

  const availableMetrics = useMemo(() => metricsForDimension(draft.dimension), [draft.dimension]);
  const groupedMetrics = useMemo(
    () => METRIC_GROUPS.map((group) => ({
      ...group,
      items: availableMetrics.filter((m) => m.group === group.id),
    })).filter((g) => g.items.length > 0),
    [availableMetrics],
  );

  const availableChartTypes = useMemo(() => {
    const isTimeline = draft.dimension === 'timeline';
    return CHART_TYPES.filter((t) => (isTimeline ? t.supportsTimeline : t.supportsCategory));
  }, [draft.dimension]);

  const sortedExpenseCats = useMemo(() => {
    const fromData = Object.values(context.data.expenses ?? {}).map((e) => e.category);
    return [...new Set([...expenseCategories, ...fromData, 'Folha de pagamento'])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [expenseCategories, context.data.expenses]);

  const sortedIncomeCats = useMemo(() => {
    const fromData = Object.values(context.data.incomes ?? {}).map((e) => e.category);
    return [...new Set([...incomeCategories, ...fromData])]
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b, 'pt-BR'));
  }, [incomeCategories, context.data.incomes]);

  function updateDraft(patch: Partial<ChartWidgetConfig>) {
    setDraft((prev) => ({ ...prev, ...patch }));
  }

  function updateStyle(patch: Partial<ChartWidgetConfig['style']>) {
    setDraft((prev) => ({ ...prev, style: { ...prev.style, ...patch } }));
  }

  function changeDimension(nextDim: ChartDimension) {
    const compatMetrics = metricsForDimension(nextDim);
    const isTimeline = nextDim === 'timeline';
    const compatTypes = CHART_TYPES.filter((t) => (isTimeline ? t.supportsTimeline : t.supportsCategory));
    setDraft((prev) => {
      const nextChartType: ChartType = compatTypes.some((t) => t.id === prev.chartType)
        ? prev.chartType
        : (isTimeline ? 'bar' : 'horizontal_bar');
      const nextSeries = prev.series
        .map((s) => (compatMetrics.some((m) => m.id === s.metricId) ? s : null))
        .filter((s): s is ChartSeriesConfig => Boolean(s));
      const fallbackMetric = compatMetrics[0];
      const finalSeries = nextSeries.length > 0
        ? nextSeries
        : (fallbackMetric ? [{ id: makeSeriesId(), metricId: fallbackMetric.id, label: fallbackMetric.shortLabel, color: fallbackMetric.defaultColor }] : prev.series);
      return {
        ...prev,
        dimension: nextDim,
        chartType: nextChartType,
        series: finalSeries,
      };
    });
  }

  function applyPalette(paletteId: ChartPaletteId) {
    const cols = paletteColors(paletteId);
    setDraft((prev) => ({
      ...prev,
      style: { ...prev.style, paletteId },
      series: prev.series.map((s, idx) => ({ ...s, color: cols[idx % cols.length] })),
    }));
  }

  function updateSeries(seriesId: string, patch: Partial<ChartSeriesConfig>) {
    setDraft((prev) => ({
      ...prev,
      series: prev.series.map((s) => (s.id === seriesId ? { ...s, ...patch } : s)),
    }));
  }

  function changeSeriesMetric(seriesId: string, metricId: string) {
    const def = getMetricDefinition(metricId);
    updateSeries(seriesId, {
      metricId,
      label: def?.shortLabel ?? metricId,
      categories: def?.supportsCategoryFilter ? [] : undefined,
      basis: def?.supportsBasis ? 'accrual' : undefined,
    });
  }

  function toggleSeriesCategory(series: ChartSeriesConfig, category: string) {
    const current = series.categories ?? [];
    const exists = current.includes(category);
    const next = exists ? current.filter((c) => c !== category) : [...current, category];
    const autoLabel = next.length === 1
      ? next[0]
      : next.length > 1
        ? `${next.slice(0, 2).join(' + ')}${next.length > 2 ? ` (+${next.length - 2})` : ''}`
        : getMetricDefinition(series.metricId)?.shortLabel ?? series.label;
    updateSeries(series.id, { categories: next, label: autoLabel });
  }

  function addSeries() {
    const usedIds = new Set(draft.series.map((s) => s.metricId));
    const nextMetric = availableMetrics.find((m) => !usedIds.has(m.id)) ?? availableMetrics[0];
    if (!nextMetric) return;
    const cols = paletteColors(draft.style.paletteId);
    const nextColor = cols[draft.series.length % cols.length];
    const firstUnit = getMetricDefinition(draft.series[0]?.metricId ?? '')?.unit ?? 'currency';
    const nextSeries: ChartSeriesConfig = {
      id: makeSeriesId(),
      metricId: nextMetric.id,
      label: nextMetric.shortLabel,
      color: nextColor,
      ...(nextMetric.supportsCategoryFilter ? { categories: [] } : {}),
      ...(nextMetric.supportsBasis ? { basis: 'accrual' } : {}),
      ...(draft.chartType === 'composed' ? { visualType: draft.series.length === 0 ? 'bar' : 'line' } : {}),
      ...(nextMetric.unit !== firstUnit ? { yAxis: 'right' } : { yAxis: 'left' }),
    };
    setDraft((prev) => ({ ...prev, series: [...prev.series, nextSeries] }));
  }

  function removeSeries(seriesId: string) {
    setDraft((prev) => (prev.series.length <= 1 ? prev : { ...prev, series: prev.series.filter((s) => s.id !== seriesId) }));
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    onSave({
      ...draft,
      title: draft.title.trim() || 'Gráfico personalizado',
      description: draft.description.trim(),
    });
  }

  const activeTypeMeta = CHART_TYPES.find((t) => t.id === draft.chartType);
  const canMultiSeries = activeTypeMeta?.supportsMultiSeries ?? true;

  return (
    <div className="finance-modal-backdrop custom-editor-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form className="custom-editor-modal" role="dialog" aria-modal="true" aria-label={isNew ? 'Criar gráfico personalizado' : 'Editar gráfico'} onSubmit={handleSubmit}>
        <header className="custom-editor-header">
          <div>
            <small className="custom-editor-kicker">{isNew ? 'NOVO GRÁFICO' : 'EDITAR GRÁFICO'}</small>
            <h2>{draft.title || 'Gráfico personalizado'}</h2>
          </div>
          <button type="button" className="custom-icon-btn" onClick={onClose} aria-label="Fechar editor">✕</button>
        </header>

        <div className="custom-editor-body">
          {/* Left column: tabbed controls */}
          <div className="custom-editor-controls">
            <div className="report-segments custom-editor-tabs" role="tablist" aria-label="Seções do editor de gráfico">
              <button type="button" role="tab" aria-selected={tab === 'dados'} aria-pressed={tab === 'dados'} onClick={() => setTab('dados')}>1. Dados & Métricas</button>
              <button type="button" role="tab" aria-selected={tab === 'estilo'} aria-pressed={tab === 'estilo'} onClick={() => setTab('estilo')}>2. Cores & Estilo</button>
              <button type="button" role="tab" aria-selected={tab === 'titulo'} aria-pressed={tab === 'titulo'} onClick={() => setTab('titulo')}>3. Título & Opções</button>
            </div>

            {tab === 'dados' && (
              <div className="custom-editor-section">
                <label className="custom-field">
                  <span>Agrupar / Analisar por (Eixo principal)</span>
                  <select value={draft.dimension} onChange={(e) => changeDimension(e.target.value as ChartDimension)}>
                    {CHART_DIMENSIONS.map((d) => (
                      <option key={d.id} value={d.id}>{d.label} — {d.description}</option>
                    ))}
                  </select>
                </label>

                <div className="custom-series-header">
                  <strong>Informações analisadas ({draft.series.length})</strong>
                  {canMultiSeries && (
                    <button type="button" className="report-button" onClick={addSeries}>+ Adicionar série</button>
                  )}
                </div>

                {!canMultiSeries && draft.series.length > 1 && (
                  <p className="custom-editor-hint">Gráficos de rosca, pizza e ranking exibem a primeira série da lista. Troque para Barras ou Composto para comparar várias séries juntas.</p>
                )}

                <div className="custom-series-list">
                  {draft.series.map((s, index) => {
                    const def = getMetricDefinition(s.metricId);
                    const catList = def?.supportsCategoryFilter === 'expense'
                      ? sortedExpenseCats
                      : def?.supportsCategoryFilter === 'income'
                        ? sortedIncomeCats
                        : [];
                    const filteredCats = categorySearch.trim()
                      ? catList.filter((c) => c.toLocaleLowerCase('pt-BR').includes(categorySearch.trim().toLocaleLowerCase('pt-BR')))
                      : catList;

                    return (
                      <div key={s.id} className="custom-series-card">
                        <div className="custom-series-card-top">
                          <span className="custom-series-badge">
                            <input
                              type="color"
                              value={s.color}
                              aria-label={`Cor da série ${index + 1}`}
                              onChange={(e) => updateSeries(s.id, { color: e.target.value })}
                            />
                            Série {index + 1}
                          </span>
                          {draft.series.length > 1 && (
                            <button type="button" className="custom-icon-btn custom-icon-btn-danger" onClick={() => removeSeries(s.id)} title="Remover série">Remover</button>
                          )}
                        </div>

                        <label className="custom-field">
                          <span>Métrica</span>
                          <select value={s.metricId} onChange={(e) => changeSeriesMetric(s.id, e.target.value)}>
                            {groupedMetrics.map((g) => (
                              <optgroup key={g.id} label={g.label}>
                                {g.items.map((m) => (
                                  <option key={m.id} value={m.id}>{m.label}</option>
                                ))}
                              </optgroup>
                            ))}
                          </select>
                          {def && <small>{def.description}</small>}
                        </label>

                        <div className="custom-field-row">
                          <label className="custom-field">
                            <span>Rótulo na legenda</span>
                            <input
                              type="text"
                              value={s.label ?? ''}
                              placeholder={def?.shortLabel ?? ''}
                              onChange={(e) => updateSeries(s.id, { label: e.target.value })}
                            />
                          </label>

                          {def?.supportsBasis && (
                            <label className="custom-field">
                              <span>Regime</span>
                              <select value={s.basis ?? 'accrual'} onChange={(e) => updateSeries(s.id, { basis: e.target.value as 'accrual' | 'cash' })}>
                                <option value="accrual">Competência (registrada)</option>
                                <option value="cash">Caixa (efetivamente paga)</option>
                              </select>
                            </label>
                          )}
                        </div>

                        {draft.chartType === 'composed' && (
                          <div className="custom-field-row">
                            <label className="custom-field">
                              <span>Formato no composto</span>
                              <select value={s.visualType ?? (index === 0 ? 'bar' : 'line')} onChange={(e) => updateSeries(s.id, { visualType: e.target.value as 'bar' | 'line' | 'area' })}>
                                <option value="bar">Barras</option>
                                <option value="line">Linha</option>
                                <option value="area">Área</option>
                              </select>
                            </label>
                            <label className="custom-field">
                              <span>Eixo Y</span>
                              <select value={s.yAxis ?? 'left'} onChange={(e) => updateSeries(s.id, { yAxis: e.target.value as 'left' | 'right' })}>
                                <option value="left">Esquerdo (principal)</option>
                                <option value="right">Direito (secundário)</option>
                              </select>
                            </label>
                          </div>
                        )}

                        {def?.supportsCategoryFilter && (
                          <div className="custom-category-picker">
                            <div className="custom-category-picker-head">
                              <span>Filtrar categorias ({s.categories?.length ? `${s.categories.length} selecionada(s)` : 'Todas'})</span>
                              {Boolean(s.categories?.length) && (
                                <button type="button" className="custom-link-btn" onClick={() => updateSeries(s.id, { categories: [], label: def.shortLabel })}>Limpar (todas)</button>
                              )}
                            </div>
                            <input
                              type="search"
                              className="custom-cat-search"
                              placeholder="Buscar categoria (ex.: Material de limpeza, Manutenção...)"
                              value={categorySearch}
                              onChange={(e) => setCategorySearch(e.target.value)}
                            />
                            <div className="custom-cat-chips">
                              {filteredCats.map((cat) => {
                                const selected = Boolean(s.categories?.includes(cat));
                                return (
                                  <button
                                    key={cat}
                                    type="button"
                                    className="custom-cat-chip"
                                    aria-pressed={selected}
                                    onClick={() => toggleSeriesCategory(s, cat)}
                                  >
                                    {cat}
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Optional period override per chart */}
                <div className="custom-subbox">
                  <label className="custom-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.periodOverride?.enabled)}
                      onChange={(e) => updateDraft({
                        periodOverride: {
                          enabled: e.target.checked,
                          from: draft.periodOverride?.from || context.range.from,
                          to: draft.periodOverride?.to || context.range.to,
                        },
                      })}
                    />
                    <span>Usar período próprio neste gráfico (ignora o período global da tela)</span>
                  </label>
                  {draft.periodOverride?.enabled && (
                    <div className="custom-field-row">
                      <label className="custom-field">
                        <span>Data inicial</span>
                        <DateInput
                          name="chartFrom"
                          value={draft.periodOverride.from}
                          onValueChange={(from) => updateDraft({ periodOverride: { ...draft.periodOverride!, from } })}
                        />
                      </label>
                      <label className="custom-field">
                        <span>Data final</span>
                        <DateInput
                          name="chartTo"
                          value={draft.periodOverride.to}
                          onValueChange={(to) => updateDraft({ periodOverride: { ...draft.periodOverride!, to } })}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'estilo' && (
              <div className="custom-editor-section">
                <div className="custom-field">
                  <span>Tipo / Estilo do gráfico</span>
                  <div className="custom-type-grid">
                    {availableChartTypes.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        className="custom-type-btn"
                        aria-pressed={draft.chartType === t.id}
                        onClick={() => updateDraft({ chartType: t.id })}
                      >
                        <strong>{t.label}</strong>
                        <small>{t.shortHint}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="custom-field">
                  <span>Paleta de cores</span>
                  <div className="custom-palette-grid">
                    {CHART_PALETTES.map((pal) => (
                      <button
                        key={pal.id}
                        type="button"
                        className="custom-palette-btn"
                        aria-pressed={draft.style.paletteId === pal.id}
                        onClick={() => applyPalette(pal.id)}
                      >
                        <span className="custom-palette-dots">
                          {pal.colors.slice(0, 5).map((c) => <i key={c} style={{ background: c }} />)}
                        </span>
                        <small>{pal.name}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <div className="custom-field">
                  <span>Cores individuais por série</span>
                  <div className="custom-series-colors">
                    {draft.series.map((s) => (
                      <div key={s.id} className="custom-color-row">
                        <div className="custom-color-row-head">
                          <input
                            type="color"
                            value={s.color}
                            aria-label={`Cor de ${s.label || s.metricId}`}
                            onChange={(e) => updateSeries(s.id, { color: e.target.value })}
                          />
                          <span>{s.label || getMetricDefinition(s.metricId)?.shortLabel}</span>
                          <code>{s.color}</code>
                        </div>
                        <div className="custom-swatch-row">
                          {QUICK_COLOR_SWATCHES.map((hex) => (
                            <button
                              key={hex}
                              type="button"
                              className="custom-swatch"
                              aria-label={`Escolher cor ${hex}`}
                              aria-pressed={s.color.toLowerCase() === hex.toLowerCase()}
                              style={{ background: hex }}
                              onClick={() => updateSeries(s.id, { color: hex })}
                            />
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="custom-field-row">
                  <label className="custom-field">
                    <span>Largura no painel</span>
                    <select value={draft.size} onChange={(e) => updateDraft({ size: e.target.value as 'half' | 'full' })}>
                      <option value="half">Meia largura (2 por linha)</option>
                      <option value="full">Largura inteira</option>
                    </select>
                  </label>
                  <label className="custom-field">
                    <span>Altura</span>
                    <select value={draft.height} onChange={(e) => updateDraft({ height: e.target.value as 'compact' | 'normal' | 'tall' })}>
                      <option value="compact">Compacta</option>
                      <option value="normal">Padrão</option>
                      <option value="tall">Ampla</option>
                    </select>
                  </label>
                </div>

                {(draft.chartType === 'area' || draft.chartType === 'line' || draft.chartType === 'composed') && (
                  <div className="custom-field-row">
                    <label className="custom-field">
                      <span>Estilo da curva</span>
                      <select value={draft.style.curve} onChange={(e) => updateStyle({ curve: e.target.value as 'monotone' | 'linear' | 'step' })}>
                        <option value="monotone">Suave</option>
                        <option value="linear">Reta</option>
                        <option value="step">Degrau</option>
                      </select>
                    </label>
                    <label className="custom-field">
                      <span>Preenchimento (Área)</span>
                      <select value={draft.style.fillStyle} onChange={(e) => updateStyle({ fillStyle: e.target.value as 'gradient' | 'solid' | 'none' })}>
                        <option value="gradient">Gradiente suave</option>
                        <option value="solid">Translúcido sólido</option>
                        <option value="none">Somente linha</option>
                      </select>
                    </label>
                    <label className="custom-field">
                      <span>Espessura ({draft.style.strokeWidth}px)</span>
                      <input
                        type="range"
                        min={1}
                        max={5}
                        step={0.5}
                        value={draft.style.strokeWidth}
                        onChange={(e) => updateStyle({ strokeWidth: Number(e.target.value) })}
                      />
                    </label>
                  </div>
                )}

                {(draft.chartType === 'bar' || draft.chartType === 'stacked_bar' || draft.chartType === 'horizontal_bar' || draft.chartType === 'composed') && (
                  <label className="custom-field">
                    <span>Arredondamento das barras ({draft.style.barRadius}px)</span>
                    <input
                      type="range"
                      min={0}
                      max={12}
                      step={1}
                      value={draft.style.barRadius}
                      onChange={(e) => updateStyle({ barRadius: Number(e.target.value) })}
                    />
                  </label>
                )}

                {draft.chartType === 'donut' && (
                  <label className="custom-field">
                    <span>Espessura da rosca</span>
                    <select value={draft.style.donutThickness} onChange={(e) => updateStyle({ donutThickness: e.target.value as 'thin' | 'normal' | 'thick' })}>
                      <option value="thin">Fina</option>
                      <option value="normal">Padrão</option>
                      <option value="thick">Grossa</option>
                    </select>
                  </label>
                )}

                <div className="custom-toggles-grid">
                  <label className="custom-toggle">
                    <input type="checkbox" checked={draft.style.showGrid} onChange={(e) => updateStyle({ showGrid: e.target.checked })} />
                    <span>Mostrar linhas de grade</span>
                  </label>
                  <label className="custom-toggle">
                    <input type="checkbox" checked={draft.style.showValues} onChange={(e) => updateStyle({ showValues: e.target.checked })} />
                    <span>Mostrar valores sobre o gráfico</span>
                  </label>
                  <label className="custom-toggle">
                    <input type="checkbox" checked={draft.style.showComparison} onChange={(e) => updateStyle({ showComparison: e.target.checked })} />
                    <span>Comparar com período anterior</span>
                  </label>
                </div>

                {/* Goal / Reference line */}
                <div className="custom-subbox">
                  <label className="custom-toggle">
                    <input
                      type="checkbox"
                      checked={Boolean(draft.style.referenceLine?.enabled)}
                      onChange={(e) => updateStyle({
                        referenceLine: {
                          enabled: e.target.checked,
                          value: draft.style.referenceLine?.value ?? 1000,
                          label: draft.style.referenceLine?.label || 'Meta',
                          color: draft.style.referenceLine?.color || '#dc2626',
                        },
                      })}
                    />
                    <span>Exibir linha de meta ou teto de gasto</span>
                  </label>
                  {draft.style.referenceLine?.enabled && (
                    <div className="custom-field-row">
                      <label className="custom-field">
                        <span>Valor</span>
                        <input
                          type="number"
                          step="any"
                          value={draft.style.referenceLine.value}
                          onChange={(e) => updateStyle({
                            referenceLine: { ...draft.style.referenceLine!, value: Number(e.target.value) || 0 },
                          })}
                        />
                      </label>
                      <label className="custom-field">
                        <span>Texto</span>
                        <input
                          type="text"
                          value={draft.style.referenceLine.label}
                          onChange={(e) => updateStyle({
                            referenceLine: { ...draft.style.referenceLine!, label: e.target.value },
                          })}
                        />
                      </label>
                      <label className="custom-field">
                        <span>Cor</span>
                        <input
                          type="color"
                          value={draft.style.referenceLine.color}
                          onChange={(e) => updateStyle({
                            referenceLine: { ...draft.style.referenceLine!, color: e.target.value },
                          })}
                        />
                      </label>
                    </div>
                  )}
                </div>
              </div>
            )}

            {tab === 'titulo' && (
              <div className="custom-editor-section">
                <label className="custom-field">
                  <span>Título do gráfico</span>
                  <input type="text" required value={draft.title} onChange={(e) => updateDraft({ title: e.target.value })} />
                </label>
                <label className="custom-field">
                  <span>Subtítulo / explicação</span>
                  <textarea rows={2} value={draft.description} onChange={(e) => updateDraft({ description: e.target.value })} />
                </label>
                <div className="custom-field-row">
                  <label className="custom-field">
                    <span>Posição da legenda</span>
                    <select value={draft.style.legendPosition} onChange={(e) => updateStyle({ legendPosition: e.target.value as 'top' | 'bottom' | 'hidden' })}>
                      <option value="top">Acima do gráfico</option>
                      <option value="bottom">Abaixo do gráfico</option>
                      <option value="hidden">Oculta</option>
                    </select>
                  </label>
                  <label className="custom-field">
                    <span>Máximo de itens / fatias ({draft.style.topN})</span>
                    <input
                      type="number"
                      min={3}
                      max={20}
                      value={draft.style.topN}
                      onChange={(e) => updateStyle({ topN: Math.max(3, Math.min(20, Number(e.target.value) || 6)) })}
                    />
                  </label>
                </div>
              </div>
            )}
          </div>

          {/* Right column: live real-data preview */}
          <div className="custom-editor-preview">
            <div className="custom-preview-label">Pré-visualização ao vivo (com seus dados reais)</div>
            <CustomizableChartCard widget={{ ...draft, size: 'full' }} context={context} preview />
          </div>
        </div>

        <footer className="custom-editor-footer">
          <button type="button" className="report-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="report-button report-button-primary">
            {isNew ? 'Adicionar gráfico ao painel' : 'Salvar alterações'}
          </button>
        </footer>
      </form>
    </div>
  );
}
