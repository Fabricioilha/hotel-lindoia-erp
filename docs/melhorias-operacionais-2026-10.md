# Melhorias operacionais — outubro de 2026

## Uso

- **Taxas:** Fluxo de caixa → Configurações → Taxas da máquina de cartão. A gerência informa crédito e débito. Sem configuração, a taxa é zero. Novas configurações têm vigência a partir do salvamento e não recalculam recebimentos anteriores. Exemplo: R$ 100 brutos com 3% produzem R$ 97 líquidos e R$ 3 na categoria “Taxas da máquina de cartão”. A receita bruta permanece disponível para conferência; a despesa desconta a taxa uma única vez do saldo bancário.
- **Recebimentos:** o cadastro de hospedagem permite informar se o pagamento já foi recebido e sua data. A ficha do quarto recebe pagamentos posteriores ou parciais e mostra seu histórico. Alterar diárias ou check-in não reescreve os pagamentos. Hospedagens antigas mantêm os valores e datas existentes; não há migração retroativa de valores.
- **Contas a pagar:** mostra dívidas de meses anteriores e vencimentos futuros, com busca e filtro. A posição usa os pagamentos registrados até a data indicada; no mês corrente, até hoje, nos demais meses, até o encerramento do mês.
- **Checkout:** a recepção pode solicitar a liberação. Havendo saldo de hospedagem, adicionais ou geladeira, aparece um alerta com o valor e a liberação exige regularização. Após o checkout, o quarto fica sujo e indisponível até a conclusão da limpeza. Rotativos com saldo pendente precisam ser quitados antes de sua conversão em diária.
- **Adiantamentos:** registre a despesa na categoria “Adiantamento de salário”, com funcionário e competência. Na folha, aplique os adiantamentos identificados. O desconto reduz o saldo salarial sem lançar uma segunda saída. Um adiantamento compensado não pode ser excluído ou reaproveitado em outra folha sem desfazer seu vínculo.
- **Estoque:** entradas atualizam o custo médio ponderado, usando também o saldo real da geladeira após vendas. O último custo de compra continua separado. As movimentações passam a guardar o custo usado. Para produtos antigos sem custo médio, o custo cadastrado é a base inicial; não foram reconstruídos custos históricos sem documentação.

## Interface

Abas financeiras com estrutura estável, planilha como ação secundária, conteúdo mais amplo, resumo mensal recolhível, indicação explícita do período, contas vencidas visíveis, ações de exclusão em menu secundário, apresentação compacta de lançamentos no celular e melhorias de foco, Escape e aviso de formulário alterado nos modais. A ficha do quarto reúne recebimentos, adicionais e geladeira. Os atalhos laterais de hóspede/rotativo mantêm a página atual sob o modal.

A seção de Reservas permanece para integrações futuras. Não foram introduzidas mudanças de concorrência, no checkout automático, na política de exclusão/auditoria, no fechamento por plantão nem uma reestruturação geral do projeto.

## Persistência e publicação

Os recebimentos de hospedagem guardam valor bruto, percentual, taxa e líquido no próprio registro. A visão financeira gera as despesas de taxa a partir das entradas e materializa os registros financeiros de cartão ao salvar o Financeiro, mantendo a origem operacional como referência. Não substitua a receita bruta pelo líquido nas fórmulas existentes: isso descontaria a taxa novamente.

Esta entrega está no projeto local. Para publicar, aplicar `database.rules.json` e publicar o build com as funções Netlify da mesma versão. As regras incluem a leitura das taxas pela recepção, o registro de novos recebimentos pela recepção e o índice de data do último recebimento. Não houve escrita em dados de produção nem publicação nesta validação.

## Validação

83 testes automatizados aprovados, incluindo testes de domínio e de serviços com banco simulado local: taxas e centavos, persistência do líquido, edição sincronizada da conta, adiantamentos sem dupla saída, custo médio com vendas anteriores, recebimentos parciais/idempotentes, checkout e contas antigas. O validador local de regras não substitui o Firebase Emulator.

TypeScript do cliente e servidor, lint dos arquivos alterados e build Vite aprovados. O build mantém o aviso de tamanho do pacote de Excel já usado no projeto. Interface financeira conferida no navegador em desktop e em um frame de 390 px, usando exclusivamente dados fictícios.

Prévia reproduzível: `node node_modules/vite/bin/vite.js --config tests/ui-preview/vite.config.mjs`. O fixture substitui os serviços financeiros por memória local; não acessa Firebase. Captura: `docs/validacao/fluxo-caixa.png`.
