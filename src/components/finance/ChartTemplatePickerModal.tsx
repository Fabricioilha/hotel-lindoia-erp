import { CHART_TEMPLATES, type ChartTemplate } from '../../services/reportDashboardStore';
import type { ChartWidgetConfig } from '../../types/reportCharts';

export interface ChartTemplatePickerModalProps {
  onClose: () => void;
  onAddDirect: (widget: ChartWidgetConfig) => void;
  onCustomize: (widget: ChartWidgetConfig) => void;
}

export function ChartTemplatePickerModal({
  onClose,
  onAddDirect,
  onCustomize,
}: ChartTemplatePickerModalProps) {
  const selectTemplate = (tpl: ChartTemplate, customize: boolean) => {
    const widget = tpl.build();
    if (customize) onCustomize(widget);
    else onAddDirect(widget);
  };

  return (
    <div
      className="finance-modal-backdrop custom-editor-backdrop"
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="custom-template-modal" role="dialog" aria-modal="true" aria-label="Adicionar novo gráfico">
        <header className="custom-editor-header">
          <div>
            <small className="custom-editor-kicker">BIBLIOTECA DE ANÁLISES</small>
            <h2>Adicionar novo gráfico</h2>
          </div>
          <button type="button" className="custom-icon-btn" onClick={onClose} aria-label="Fechar">✕</button>
        </header>

        <div className="custom-template-grid">
          {CHART_TEMPLATES.map((tpl) => (
            <article key={tpl.id} className="custom-template-card">
              <span className="custom-template-badge">{tpl.category}</span>
              <h3>{tpl.name}</h3>
              <p>{tpl.description}</p>
              <div className="custom-template-actions">
                <button
                  type="button"
                  className="report-button report-button-primary"
                  onClick={() => selectTemplate(tpl, true)}
                >
                  Personalizar
                </button>
                {tpl.id !== 'tpl-em-branco' && (
                  <button
                    type="button"
                    className="report-button"
                    onClick={() => selectTemplate(tpl, false)}
                  >
                    Adicionar direto
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </div>
    </div>
  );
}
