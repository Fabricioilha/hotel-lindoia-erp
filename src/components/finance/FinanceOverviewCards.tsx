import { FinanceMetric as Metric } from './FinanceMetric';
import type { financeOverview } from '../../services/financeOverview';
import { financeDateLabel } from '../../services/financePayments';
import { formatBRL as money } from '../../services/money';
import { oyoClosingAt, oyoEstimatedPosition, type OyoClosingRecords } from '../../services/oyoReconciliation';
import type { FinanceData } from '../../types/finance';

export function FinanceOverviewCards({ data, overview, closings, oyoReadError }: {
  data: FinanceData; overview: ReturnType<typeof financeOverview>; closings: OyoClosingRecords | null; oyoReadError: string;
}) {
  const closing = closings && !oyoReadError ? oyoClosingAt(closings, overview.asOf) : null;
  const simulated = closing ? oyoEstimatedPosition(data, closing, overview.asOf) : null;
  const reference = closing ? `RECOM ${closing.month.split('-').reverse().join('/')}`
    : oyoReadError ? 'Consulta indisponível' : closings ? 'Sem RECOM de referência' : 'Carregando RECOM';
  const cutoff = financeDateLabel(overview.asOf);
  return <div className="finance-overview-cards">
    <section className="finance-summary-section" aria-labelledby="overview-cash-heading">
      <h2 id="overview-cash-heading">Recebimentos e despesas</h2>
      <div className="finance-metrics">
        <Metric label="Entrou em dinheiro" value={money(overview.incomingCash)} tone="green" detail="Recebimentos no caixa físico"
          help="Soma os pagamentos em espécie e os repasses da OYO registrados com destino ao caixa físico no período. Depósitos entre caixa e banco são movimentos internos." />
        <Metric label="Entrou em cartão" value={money(overview.cardGross)} tone="blue" detail={`${money(overview.cardNet)} após taxas registradas`}
          help="Soma crédito e débito na data registrada do recebimento. A linha de baixo mostra o valor líquido após as taxas da máquina registradas. A data de crédito pode diferir no extrato." />
        <Metric label="Total de despesas" value={money(overview.expenses)} tone="coral" detail={`${money(overview.expensesPaid)} pagos no período`}
          help="O total soma despesas e folha com vencimento no período, pagas ou em aberto. Compras em fatura usam o vencimento da fatura. A linha de baixo soma pagamentos e compensações pela data em que ocorreram, inclusive de contas com outros vencimentos." />
      </div>
    </section>
    <section className="finance-summary-section" aria-labelledby="overview-sales-heading">
      <h2 id="overview-sales-heading">Vendas do período</h2>
      <div className="finance-metrics">
        <Metric label="Geladeira" value={money(overview.sales.geladeira)} tone="navy" detail="Inclui vendas a cobrar no checkout"
          help="Soma as vendas da Geladeira e do frigobar pela data da venda, inclusive as que aguardam pagamento, e as bebidas lançadas como adicionais. Um pagamento posterior da mesma venda entra apenas nos recebimentos." />
        <Metric label="Café da manhã" value={money(overview.sales.breakfast)} tone="gold" detail="Recebimentos identificados como café"
          help="Soma os cafés registrados separadamente nos recebimentos, inclusive os pré-pagos que pertencem ao hotel. Café incluído em uma diária sem preço separado segue no valor da hospedagem." />
        <Metric label="Extras" value={money(overview.sales.extras)} tone="gray" detail="Adicionais registrados nas hospedagens"
          help="Soma os recebimentos identificados como extras, incluindo cama ou colchão adicional, hóspede extra e alterações de entrada ou saída. Geladeira e café têm totais próprios." />
      </div>
    </section>
    <section className="finance-summary-section" aria-labelledby="overview-oyo-heading">
      <h2 id="overview-oyo-heading">Acerto com a OYO</h2>
      <div className="finance-metrics finance-metrics-four">
        <Metric label="Taxas OYO recebidas no hotel" value={money(overview.counterFees)} tone="gold" detail="Taxas cobradas no balcão no período"
          help="Soma as taxas que pertencem à OYO e foram recebidas pelo hotel no período. O acerto com a OYO registra a compensação. As taxas pagas diretamente à OYO ficam fora deste total." />
        <Metric label="Pré-pagos recebidos pela OYO" value={money(overview.prepaid)} tone="blue" detail="Parte que pertence ao hotel"
          help="Soma a parte do hotel nos pagamentos que hóspedes fizeram diretamente à OYO no período, excluídas as taxas da própria OYO." />
        <Metric label="Dívida oficial com a OYO" value={closing ? money(Math.max(0, -closing.balance)) : '—'} tone="coral"
          detail={closing && closing.balance > 0 ? `${reference} · ${money(closing.balance)} a receber` : reference}
          help={`Valor a pagar informado na última RECOM com competência encerrada até ${cutoff}. Quando a RECOM indica crédito do hotel, a dívida é zero e o crédito aparece abaixo.`} />
        <Metric label="Dívida simulada com a OYO" value={simulated ? money(Math.max(0, -simulated.balance)) : '—'} tone="navy"
          detail={simulated ? simulated.balance > 0 ? `${money(simulated.balance)} a receber na simulação` : `${money(simulated.prepaid)} em pré-pagos após a RECOM` : reference}
          help={`Parte da RECOM e considera os movimentos ainda fora do fechamento até ${cutoff}. Pré-pagos do hotel e pagamentos à OYO reduzem a dívida. Repasses já recebidos e despesas compensadas reduzem o crédito que o hotel tem na OYO.`} />
      </div>
    </section>
    <section className="finance-summary-section" aria-labelledby="overview-balances-heading">
      <h2 id="overview-balances-heading">Saldos acumulados</h2>
      <div className="finance-metrics finance-metrics-two">
        <Metric label="Dinheiro acumulado" value={money(overview.balances.cash)} detail={`Caixa físico até ${cutoff}`} tone="gold" negative={overview.balances.cash < 0}
          help="Saldo inicial mais entradas, menos saídas, com ajustes e transferências do caixa físico. O cálculo inclui o histórico anterior ao início do período." />
        <Metric label="Banco acumulado" value={money(overview.balances.bank)} detail={`Carteira Banco até ${cutoff}`} tone="navy" negative={overview.balances.bank < 0}
          help="Saldo inicial mais entradas, menos saídas, com transferências da carteira Banco. O cálculo inclui o histórico anterior ao início do período e usa as datas lançadas no ERP." />
      </div>
    </section>
  </div>;
}
