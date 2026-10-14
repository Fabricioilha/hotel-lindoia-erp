# Revisão do fluxo de caixa e do estoque

Revisão da estrutura e dos cálculos do sistema em 14/10/2026. As verificações usam dados fictícios e testes locais; os registros reais do hotel não foram alterados.

## Como o financeiro está estruturado

O Fluxo de Caixa reúne os lançamentos da gerência e os registros das operações do hotel. Há registros financeiros salvos e registros calculados a partir da operação que os originou. A tela e a exportação usam essa mesma composição, respeitando correções e anulações.

| Origem | O que aparece no financeiro |
| --- | --- |
| Entradas e despesas da gerência | Recebimentos, contas previstas e pagamentos registrados manualmente. |
| Hospedagens da recepção | Diárias, café, taxas e adicionais, com a forma de pagamento correspondente. |
| Reservas | Recebimentos já lançados e recebimentos do checkout, sem contar o mesmo registro duas vezes. |
| Geladeira | Vendas recebidas na recepção ou no checkout. Uma venda pendente não representa dinheiro recebido. |
| Compras de estoque | Valor da compra como despesa prevista; só a parte efetivamente paga movimenta caixa ou banco. |
| Saídas de caixa | Valores retirados para compras e despesas da operação. |
| Folha | Valor líquido previsto e cada pagamento por funcionário, competência e data. |
| OYO e transferências | Pré-pagos, repasses, compensações e movimentos entre carteiras tratados separadamente. |

Cada operação mantém uma referência estável. Assim, a mesma venda ou compra não se transforma em dois lançamentos quando a tela é reaberta ou a conciliação é repetida. Alterações feitas pela gerência permanecem identificadas; anulações impedem que um registro automático volte a aparecer.

## Problemas encontrados e corrigidos

### Relatório mensal e período da tela

A exportação anterior podia usar as entradas ou despesas filtradas pela aba aberta, enquanto outros totais continuavam considerando o mês. Um relatório mensal solicitado na visão de hoje podia ficar incompleto. A exportação agora consulta o histórico necessário de forma independente, aplica o mês selecionado e confere os saldos antes de gerar o Excel.

A consulta por vencimento também deixava de fora pagamentos de contas vencidas em outro mês. O corte de histórico em cinco anos não servia para calcular saldos acumulados. Os saldos agora consideram o histórico disponível; o período é aplicado aos recebimentos e às parcelas de pagamento, sem descartar os movimentos necessários ao saldo inicial.

### Pagamentos, vencimento e competência

Uma despesa antes guardava principalmente um vencimento e totais pagos. Isso não distinguia parcelas pagas em meses diferentes. Agora despesas e folha mantêm o histórico de pagamentos com data, carteira e valor, conservando também os totais para compatibilidade.

Ao aumentar um total pago, o sistema registra a diferença na data informada. Ao reduzir o total, registra a correção com valor negativo. Uma parcela já registrada pode ter sua data corrigida individualmente. A competência da folha é independente do vencimento e do mês do pagamento.

Contas previstas ou pendentes ficam separadas das saídas efetivamente pagas. Transferências entre caixa e banco alteram as carteiras, mas não são receita nem despesa. Pré-pagos feitos à OYO ficam separados dos recebimentos diretos no hotel; repasses da OYO entram nas disponibilidades quando são registrados.

Registros antigos que não possuem data de pagamento usam o vencimento cadastrado como referência histórica e aparecem identificados. O sistema permite confirmar ou corrigir essa data; não inventa uma data que não existia no cadastro.

### Coerência entre módulos

Compras e vendas de estoque passam a compor o financeiro mesmo quando não há uma tela de conciliação aberta. A edição de um lançamento calculado a partir da operação também funciona: a correção é salva e os demais registros automáticos permanecem vinculados à sua origem.

As operações financeiras concorrentes são protegidas para evitar perda de parcelas ou sobrescrita de uma correção feita em outra tela. Valores, datas, carteiras e somas dos itens são validados. Registros antigos inconsistentes são apresentados para correção, em vez de serem exportados silenciosamente. As datas financeiras seguem o horário de São Paulo, inclusive em vendas próximas à mudança do dia ou do mês.

### Cadastro, movimentação e venda de estoque

Foi identificado um erro no início de transações: o Firebase podia chamar a validação antes de o produto ou saldo estar disponível no cache local. Algumas operações eram interrompidas como se o produto não existisse ou não tivesse estoque. As transações que dependem desses dados agora aguardam o carregamento necessário.

Editar o cadastro de um produto também podia substituir o saldo atual por um saldo antigo capturado na abertura do formulário. O cadastro agora conserva o saldo da transação atual; quantidades são alteradas por movimentação ou conferência. Rascunhos mantêm o mesmo identificador nas tentativas de salvamento, e os erros aparecem dentro do formulário.

Entradas, transferências, perdas, saídas e vendas validam o saldo disponível. As saídas internas exigem a quantidade completa e reservam pedidos concorrentes, evitando uma baixa parcial apresentada como concluída. A venda da geladeira usa proteção por produto e registro de débito para impedir baixa duplicada, permitir repetição segura e recuperar uma falha entre a baixa e a gravação da venda.

A sincronização entre o estoque gerencial e a geladeira mantém a revisão e a quantidade de referência já aplicada. Isso evita reaplicar o mesmo acréscimo ou aceitar uma atualização antiga sobre uma mais recente. Exclusões relacionadas desfazem os saldos e lançamentos correspondentes com as mesmas proteções.

### Tarifas

O erro anterior vinha de uma atualização de vários estados dentro de um efeito de sincronização. A tela agora usa os valores salvos como base e mantém um único rascunho quando há edição. Os campos aguardam o carregamento e o salvamento foi verificado preservando os demais preços, adicionais e feriados.

## Exportação mensal para o contador

Na página **Fluxo de caixa**, selecione o **Mês do resumo e da planilha** e clique em **Baixar planilha mensal (.xlsx)**. O arquivo contempla o mês completo, independentemente da aba, busca, carteira ou período visível na consulta.

| Aba | Conteúdo |
| --- | --- |
| Resumo | Entradas, saídas pagas, resultado, pendências e conferência de saldo por carteira. |
| Entradas | Uma linha por item e forma de pagamento recebida diretamente no hotel. |
| Saídas | Parcelas de despesas e folha pela data do pagamento, incluindo correções e origem da data histórica. |
| Pré-pagos OYO | Pagamentos dos hóspedes diretamente à plataforma. |
| Transferências | Movimentos internos, repasses e pagamentos à OYO, com seu efeito nas disponibilidades do hotel. |
| Contas e folha | Valores previstos, pagos e pendentes no fechamento, incluindo pendências anteriores. |

Os valores são números e as datas são datas do Excel. O arquivo inclui filtros, cabeçalhos fixos, referências dos registros e fórmulas de resumo. A conferência por carteira segue **saldo inicial + entradas − saídas = saldo final**. Essa conferência valida a composição do histórico cadastrado; a comparação com extratos bancários, caixa físico e demonstrativos da OYO continua dependendo desses documentos.

## Navegação e visualização

A página abre no resumo mensal. O mês e a exportação ficam sempre visíveis, com botões para avançar ou voltar um mês. As consultas de entradas e despesas têm atalhos para hoje e para o mês, busca e filtro por carteira. Os registros mostram separadamente o valor previsto, o total pago acumulado, o pagamento no período e o que falta pagar.

Trocar de aba conserva os dados carregados. As descrições podem ser lidas sem o truncamento anterior, e a biblioteca do Excel só é carregada quando a exportação é solicitada.

## Verificação e publicação

Os testes locais cobrem conciliação mensal, fontes operacionais, parcelas em meses distintos, correções, OYO, datas brasileiras, concorrência, anulações, cadastro de produto, movimentação, venda, saldo insuficiente e recuperação de falhas. A geração e a leitura do Excel verificam as seis abas, valores, datas, fórmulas e referências. O navegador também foi usado para conferir os fluxos com dados fictícios.

As mudanças do aplicativo e as regras atualizadas do Firebase devem ser publicadas juntas. As novas proteções de estoque dependem das permissões dos registros de controle incluídas em `database.rules.json`.
