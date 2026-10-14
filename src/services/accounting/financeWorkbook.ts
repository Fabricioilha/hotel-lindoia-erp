import type { CellValue, Workbook, Worksheet } from 'exceljs';
import { PAYMENT_METHOD_LABELS, WALLET_LABELS, type FinanceData, type FinancePaymentMethod } from '../../types/finance';
import { buildMonthlyAccountingReport, type MonthlyAccountingReport } from './monthlyAccounting';

const currencyFormat = '"R$" #,##0.00;[Red]-"R$" #,##0.00';
const excelDate = (value: string) => new Date(`${value}T00:00:00Z`);
const headerFill = { type: 'pattern' as const, pattern: 'solid' as const, fgColor: { argb: 'FF183C66' } };
const tableRange = (name: string, column: string, length: number) => `'${name}'!${column}6:${column}${Math.max(6, length + 5)}`;
const textRowHeight = (text: string, width: number) => Math.min(409, Math.max(28, text.split('\n').reduce((lines, line) => lines + Math.max(1, Math.ceil(line.length / Math.max(1, width * 0.88))), 0) * 15 + 8));

function formatTable(sheet: Worksheet, title: string, description: string, headers: string[], rows: CellValue[][], widths: number[], moneyColumns: number[], dateColumns: number[]) {
  sheet.columns = widths.map((width) => ({ width }));
  sheet.mergeCells(1, 1, 1, headers.length);
  sheet.getCell('A1').value = title;
  sheet.getCell('A1').font = { name: 'Calibri', size: 18, bold: true, color: { argb: 'FF183C66' } };
  sheet.getRow(1).height = 32;
  sheet.mergeCells(2, 1, 3, headers.length);
  sheet.getCell('A2').value = description;
  sheet.getCell('A2').alignment = { vertical: 'top', wrapText: true };
  sheet.getCell('A2').font = { name: 'Calibri', size: 11, color: { argb: 'FF47566B' } };
  const header = sheet.getRow(5);
  header.values = headers;
  header.height = 31;
  header.eachCell((cell) => { cell.fill = headerFill; cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; cell.alignment = { wrapText: true, vertical: 'middle' }; });
  rows.forEach((values, index) => {
    const row = sheet.getRow(index + 6);
    row.values = values;
    row.height = Math.max(32, ...values.map((value, column) => typeof value === 'string' ? textRowHeight(value, widths[column] - 2) : 28));
    row.eachCell({ includeEmpty: true }, (cell) => {
      cell.font = { name: 'Calibri', size: 11 };
      cell.alignment = { vertical: 'top', wrapText: true };
      if (index % 2 === 0) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F5FA' } };
    });
  });
  moneyColumns.forEach((column) => { sheet.getColumn(column).numFmt = currencyFormat; sheet.getColumn(column).alignment = { horizontal: 'right', vertical: 'top' }; });
  dateColumns.forEach((column) => { sheet.getColumn(column).numFmt = 'dd/mm/yyyy'; });
  sheet.views = [{ state: 'frozen', ySplit: 5, showGridLines: false }];
  sheet.autoFilter = { from: { row: 5, column: 1 }, to: { row: Math.max(5, rows.length + 5), column: headers.length } };
  sheet.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0, printTitlesRow: '1:5' };
  sheet.headerFooter.oddFooter = 'Hotel Lindoia · &A · Página &P de &N';
}

function tableTotal(sheet: Worksheet, rowCount: number, column: number, amount: number) {
  const row = rowCount + 7;
  sheet.getCell(row, Math.max(1, column - 1)).value = 'Total';
  sheet.getCell(row, column).value = { formula: rowCount ? `SUM(${sheet.getColumn(column).letter}6:${sheet.getColumn(column).letter}${rowCount + 5})` : '0', result: amount };
  sheet.getRow(row).font = { name: 'Calibri', size: 11, bold: true };
  sheet.getCell(row, column).numFmt = currencyFormat;
}

export async function createAccountingWorkbook(report: MonthlyAccountingReport): Promise<Workbook> {
  // ExcelJS loads only after export is requested; its browser bundle writes a native XLSX.
  const ExcelJS = await import('exceljs');
  const workbook = new ExcelJS.default.Workbook();
  workbook.creator = 'Hotel Lindoia';
  workbook.created = new Date(report.generatedAt);
  workbook.modified = new Date(report.generatedAt);
  workbook.calcProperties.fullCalcOnLoad = true;
  const summary = workbook.addWorksheet('Resumo');
  const entries = workbook.addWorksheet('Entradas');
  const payments = workbook.addWorksheet('Saídas');
  const prepaid = workbook.addWorksheet('Pré-pagos OYO');
  const transfers = workbook.addWorksheet('Transferências');
  const obligations = workbook.addWorksheet('Contas e folha');
  const period = `${report.from.slice(8, 10)}/${report.from.slice(5, 7)}/${report.from.slice(0, 4)} a ${report.to.slice(8, 10)}/${report.to.slice(5, 7)}/${report.to.slice(0, 4)}`;
  const receiptHeaders = ['Data', 'Categoria', 'Descrição do pagamento', 'Forma de pagamento', 'Carteira', 'Valor', 'Referência do registro/item', 'Observação'];
  const receiptRows = (rows: MonthlyAccountingReport['receipts']) => rows.map((row) => [excelDate(row.date), row.category, row.description, PAYMENT_METHOD_LABELS[row.method as FinancePaymentMethod], WALLET_LABELS[row.wallet], row.amount, row.reference, row.note]);
  formatTable(entries, 'Recebimentos diretos no hotel', `${period}. Uma linha por item e forma de pagamento. Repasses e pré-pagos externos ficam nas abas próprias.`, receiptHeaders, receiptRows(report.receipts), [14, 25, 45, 27, 22, 18, 45, 50], [6], [1]);
  formatTable(prepaid, 'Pré-pagos externos à OYO', `${period}. Pagamentos dos hóspedes retidos pela OYO. Estes valores não são recebimentos no caixa ou banco do hotel.`, receiptHeaders, receiptRows(report.prepaid), [14, 25, 45, 27, 28, 18, 45, 50], [6], [1]);
  formatTable(payments, 'Pagamentos e correções de despesas e folha', `${period}. Uma linha por parcela e carteira, na data do movimento. Correções aparecem com valor negativo. Datas de registros antigos sem data de pagamento usam o vencimento e estão identificadas.`, ['Data do movimento', 'Vencimento', 'Tipo', 'Categoria', 'Descrição / funcionário', 'Carteira', 'Valor pago / correção', 'Referência registro/parcela', 'Origem da data', 'Observação'], report.payments.map((row) => [excelDate(row.date), excelDate(row.dueDate), row.type, row.category, row.description, WALLET_LABELS[row.wallet], row.amount, row.reference, row.dateSource, row.note]), [16, 14, 23, 27, 42, 28, 20, 48, 37, 60], [7], [1, 2]);
  formatTable(transfers, 'Transferências e acertos com a OYO', `${period}. Transferências entre caixa e banco não são receita nem despesa. Repasses da OYO aumentam as disponibilidades do hotel. Pagamentos à OYO não geram novos pré-pagos.`, ['Data', 'Tipo', 'Origem', 'Destino', 'Valor transferido', 'Efeito caixa + banco', 'Referência', 'Observação'], report.transfers.map((row) => [excelDate(row.date), row.type, WALLET_LABELS[row.from], WALLET_LABELS[row.to], row.amount, row.hotelEffect, row.reference, row.note]), [14, 28, 30, 30, 20, 21, 42, 55], [5, 6], [1]);
  formatTable(obligations, 'Contas previstas e folha de pagamento', `Fechamento em ${period.slice(-10)}. Valores previstos não entram nas saídas até serem pagos. Inclui pendências de meses anteriores. Folha apresenta o valor líquido após adicionais e descontos.`, ['Vencimento', 'Tipo', 'Competência', 'Categoria', 'Funcionário', 'Valor previsto / líquido', 'Pago até o fechamento', 'Pendente no fechamento', 'Situação', 'Referência', 'Observação'], report.obligations.map((row) => [excelDate(row.dueDate), row.type, row.competence, row.category, row.employee, row.planned, row.paid, row.pending, row.status, row.reference, row.note]), [14, 15, 15, 27, 32, 21, 23, 23, 32, 42, 65], [6, 7, 8], [1]);
  tableTotal(entries, report.receipts.length, 6, report.totals.direct);
  tableTotal(prepaid, report.prepaid.length, 6, report.totals.prepaid);
  tableTotal(payments, report.payments.length, 7, report.totals.paidHotel + report.totals.paidOyo);
  tableTotal(obligations, report.obligations.length, 8, report.obligations.reduce((sum, row) => sum + row.pending, 0));

  summary.columns = [{ width: 43 }, ...Array.from({ length: 6 }, () => ({ width: 20 }))];
  summary.mergeCells('A1:G1'); summary.getCell('A1').value = 'Hotel Lindoia · Relatório mensal para a contabilidade';
  summary.getCell('A1').font = { name: 'Calibri', size: 17, bold: true, color: { argb: 'FF183C66' } }; summary.getRow(1).height = 32;
  summary.mergeCells('A2:G2'); summary.getCell('A2').value = `Mês ${report.month} · ${period} · Gerado em ${new Date(report.generatedAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`;
  summary.getCell('A2').font = { name: 'Calibri', size: 11, color: { argb: 'FF47566B' } };
  summary.mergeCells('A3:G3'); summary.getCell('A3').value = 'Regime de caixa: entradas pela data de recebimento; saídas pela data de cada pagamento. Previsto, pré-pagos OYO e transferências internas aparecem separados.'; summary.getCell('A3').alignment = { wrapText: true }; summary.getRow(3).height = 30;
  const incomeRange = tableRange('Entradas', 'F', report.receipts.length);
  const prepaidRange = tableRange('Pré-pagos OYO', 'F', report.prepaid.length);
  const paymentWalletRange = tableRange('Saídas', 'F', report.payments.length);
  const paymentAmountRange = tableRange('Saídas', 'G', report.payments.length);
  const transferTypeRange = tableRange('Transferências', 'B', report.transfers.length);
  const transferAmountRange = tableRange('Transferências', 'E', report.transfers.length);
  const metrics = [
    ['Recebimentos diretos no hotel', report.totals.direct, `SUM(${incomeRange})`, 'Pagamentos recebidos em caixa e banco.'],
    ['Repasses recebidos da OYO', report.totals.repasses, `SUMIF(${transferTypeRange},"Repasse da OYO",${transferAmountRange})`, 'Valores que saíram dos retidos e chegaram ao hotel.'],
    ['Entradas no caixa e banco', report.totals.direct + report.totals.repasses, 'B6+B7', 'Recebimentos diretos mais repasses.'],
    ['Despesas e folha pagas no hotel', report.totals.paidHotel, `SUMIF(${paymentWalletRange},"<>${WALLET_LABELS.oyo}",${paymentAmountRange})`, 'Pagamentos em caixa e banco, líquidos de correções.'],
    ['Pagamentos enviados à OYO', report.totals.sentToOyo, `SUMIF(${transferTypeRange},"Pagamento à OYO",${transferAmountRange})`, 'Saem das disponibilidades; não aumentam pré-pagos.'],
    ['Resultado de caixa e banco', report.totals.cashResult, 'B8-B9-B10', 'Variação conjunta do caixa e banco no mês.'],
    ['Pré-pagos dos hóspedes à OYO', report.totals.prepaid, `SUM(${prepaidRange})`, 'Pagamentos externos; não entram no resultado do hotel.'],
    ['Despesas compensadas com OYO', report.totals.paidOyo, `SUMIF(${paymentWalletRange},"${WALLET_LABELS.oyo}",${paymentAmountRange})`, 'Reduzem os retidos da OYO; não saem do caixa ou banco.'],
    ['Pendências da competência', report.totals.pendingMonth, '', 'Contas e folha da competência ainda não quitadas ao fim do mês.'],
    ['Pendências de meses anteriores', report.totals.pendingOverdue, '', 'Valores vencidos antes do mês e ainda em aberto no fechamento.'],
  ] as const;
  summary.getRow(5).values = ['Indicador', 'Valor (R$)', 'Critério']; summary.mergeCells('C5:G5');
  summary.getRow(5).eachCell((cell) => { cell.fill = headerFill; cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; });
  metrics.forEach(([label, value, formula, note], index) => {
    const row = index + 6;
    summary.getCell(row, 1).value = label;
    summary.getCell(row, 2).value = formula ? { formula, result: value } : value;
    summary.getCell(row, 2).numFmt = currencyFormat;
    summary.mergeCells(row, 3, row, 7); summary.getCell(row, 3).value = note;
    summary.getRow(row).height = 28; summary.getRow(row).font = { name: 'Calibri', size: 11, bold: index === 5 };
    summary.getCell(row, 3).alignment = { wrapText: true, vertical: 'middle' };
  });
  summary.mergeCells('A18:G18'); summary.getCell('A18').value = 'Conciliação de saldos por carteira'; summary.getCell('A18').font = { name: 'Calibri', size: 13, bold: true, color: { argb: 'FF183C66' } };
  summary.getRow(20).values = ['Carteira', 'Saldo inicial', 'Entradas na carteira', 'Saídas da carteira', 'Saldo calculado', 'Saldo no sistema', 'Diferença'];
  summary.getRow(20).eachCell((cell) => { cell.fill = headerFill; cell.font = { name: 'Calibri', size: 11, bold: true, color: { argb: 'FFFFFFFF' } }; cell.alignment = { wrapText: true }; }); summary.getRow(20).height = 32;
  report.wallets.forEach((wallet, index) => {
    const row = 21 + index;
    summary.getRow(row).values = [WALLET_LABELS[wallet.wallet], wallet.opening, wallet.incoming, wallet.outgoing, { formula: `ROUND(B${row}+C${row}-D${row},2)`, result: wallet.calculatedClosing }, wallet.closing, { formula: `ROUND(E${row}-F${row},2)`, result: wallet.difference }];
    summary.getRow(row).height = 31; summary.getRow(row).alignment = { wrapText: true, vertical: 'middle' }; summary.getRow(row).font = { name: 'Calibri', size: 11 };
    for (let column = 2; column <= 7; column += 1) summary.getCell(row, column).numFmt = currencyFormat;
  });
  const notes = [
    'Saldo inicial: fechamento do mês anterior, incluindo os saldos anteriores ao primeiro lançamento. As transferências internas afetam as carteiras e se anulam no resultado conjunto.',
    `${report.legacyPaymentCount} parcela(s) de pagamento neste mês sem data histórica informada: o vencimento foi usado e a origem da data consta na aba Saídas.`,
    'Os lançamentos operacionais de hospedagens, reservas, extras, frigobar, estoque e recepção são conciliados na mesma leitura. Registros anulados não são recriados no relatório.',
  ];
  notes.forEach((note, index) => { const row = 26 + index * 2; summary.mergeCells(row, 1, row, 7); summary.getCell(row, 1).value = note; summary.getCell(row, 1).alignment = { wrapText: true, vertical: 'top' }; summary.getCell(row, 1).font = { name: 'Calibri', size: 11, color: { argb: 'FF47566B' } }; summary.getRow(row).height = textRowHeight(note, 150); });
  summary.views = [{ state: 'frozen', ySplit: 5, showGridLines: false }];
  summary.pageSetup = { paperSize: 9, orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, printArea: 'A1:G31' };
  return workbook;
}

export async function downloadMonthlyAccounting(data: FinanceData, month: string): Promise<void> {
  const report = buildMonthlyAccountingReport(data, month);
  if (report.wallets.some((wallet) => Math.abs(wallet.difference) > 0.01)) throw new Error('Os saldos não conciliam com o histórico financeiro. Atualize os dados antes de exportar.');
  const workbook = await createAccountingWorkbook(report);
  const buffer = await workbook.xlsx.writeBuffer();
  const bytes = new Uint8Array(buffer);
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
  const link = document.createElement('a'); link.href = url; link.download = `hotel-lindoia-contabilidade-${month}.xlsx`;
  document.body.appendChild(link); link.click(); link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
