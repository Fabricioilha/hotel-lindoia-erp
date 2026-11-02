# Ajuste histórico do caixa físico

Na gerência, abra **Financeiro → Fluxo de caixa → Ajuste de caixa (+ / −)**.

Informe a data a partir da qual o ajuste deve valer, o valor positivo ou negativo e o motivo. É possível selecionar janeiro de 2025 no mês da tela e depois informar o dia exato no formulário.

Um ajuste de **+R$ 1.000,00 em 31/01/2025** acrescenta R$ 1.000,00 ao fechamento de janeiro e aos saldos de fevereiro, março e todos os meses seguintes. Um ajuste de **−R$ 1.000,00** reduz esses saldos no mesmo valor. Entradas, pagamentos e transferências de cada mês continuam sendo calculados normalmente. O ajuste é considerado uma única vez, não é repetido como uma nova entrada a cada mês. Datas anteriores ao ajuste não são afetadas.

O valor é uma diferença a aplicar, não uma substituição do saldo total: se o sistema mostra R$ 200,00 e o saldo correto é R$ 1.000,00 nessa data, o ajuste é **+R$ 800,00**. Não duplique valores já informados em Saldos iniciais ou em lançamentos históricos.

A seção **Ajustes do caixa físico**, na aba Resumo, lista os ajustes do mês escolhido e permite editar ou excluir. Essas ações recalculam os saldos posteriores. O registro tem identificador estável, data de criação/alteração e auditoria; a gravação utiliza a proteção contra atualizações concorrentes do financeiro.

Os ajustes aparecem em uma aba própria da planilha mensal e participam da conciliação dos saldos. Não são classificados como receitas de hospedagem ou despesas operacionais. Em meses posteriores, compõem o saldo inicial acumulado. O caixa físico acumulado da gerência é separado do caixa do plantão em Conferir caixa; ajustes históricos não alteram o troco ou as movimentações do funcionário de hoje.

Publicar o frontend junto com as migrações e hooks atualizados do PocketBase. A coleção operacional guarda `erp_geral/financeiro/cashAdjustments`; nenhuma alteração de dados reais foi feita durante a implementação original.

Verificações automatizadas: valores positivos/negativos, datas anteriores/posteriores, acumulação de janeiro de 2025 a outubro de 2026, composição com entradas e pagamentos, edição/exclusão, persistência e recarga, rejeição de dados inválidos e conciliação/exportação XLSX.
