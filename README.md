# Hotel Lindoia ERP
feito por Fabrício Nascimento
Aplicação web para apoiar a operação do Hotel Lindoia: reservas e quartos, recepção, limpeza, estoque, vendas da geladeira, escala e controle financeiro.

## Funcionalidades

- **Estoque (`/estoque`)**: produtos de limpeza, rouparia, manutenção e Geladeira - Recepção; saldos por local, custos, preços, fornecedores, validade, estoque mínimo e histórico de movimentações.
- **Vendas da geladeira (`/vendas`)**: lançamento de vendas, com pagamento na recepção ou cobrança no quarto para o checkout.
- **Reservas (`/reservas`) e quartos (`/quartos`)**: mapa de ocupação, reservas, hóspedes, quartos e limpeza.
- **Recepção (`/recepcao`)**: hospedagens, adicionais, caixa, conferências de troco e passagens de turno.
- **Outros módulos**: funcionários, tarifas, limpeza, saídas de estoque e financeiro.

## Reservas e quartos

As telas `/reservas` e `/quartos` usam os dados de `erp_geral/quartos` e são destinadas à gerência. O atendimento lançado em `/recepcao` é armazenado separadamente em `erp_geral/recepcao/stays`.

A grade do painel da gerência reúne reservas e hospedagens da recepção. Ao clicar no quarto, o gerente consulta o hóspede, período, valores e limpeza responsável, abre a edição do registro correspondente, faz o checkout ou remove um bloqueio de manutenção. O checkout conserva os recebimentos e deixa o quarto aguardando limpeza. Quartos ocupados precisam ter a hospedagem encerrada antes de serem bloqueados.

Para um cadastro feito por engano, o gerente pode usar **Excluir hospedagem** ou **Excluir reserva** no detalhe do quarto, após conferir a confirmação. A exclusão remove também os lançamentos vinculados; não substitui o checkout de uma hospedagem real, que preserva os recebimentos. A exclusão não depende do serviço de checkout.

Os links entre o painel, **Gerenciar quartos**, **Reservas e hospedagens** e **Controle de Limpeza de Quartos** conservam o contexto do quarto. A edição também está disponível para reservas já hospedadas; nome, quarto, datas e correções de recebimentos atualizam o índice de ocupação e o Fluxo de Caixa. Recebimentos de checkout mantêm seus identificadores, e pagamentos anulados não voltam a aparecer ao editar.

As tarefas das camareiras e o estado de limpeza do quarto são relacionados: designar uma limpeza marca o quarto em limpeza; concluir registra a camareira no histórico e marca o quarto limpo; cancelar deixa o quarto sujo. Conclusões pela gerência também atualizam a tarefa correspondente. As permissões e gravações são verificadas pelos hooks do PocketBase, que precisam acompanhar a publicação do aplicativo.

Ao concluir uma tarefa, a equipe pode escolher **Concluir e relatar indícios de uso**. O relato fica no histórico da limpeza e aparece no painel da gerência até ser conferido; alterações relevantes no registro exigem nova confirmação. O alerta é uma indicação para verificar hospedagens e caixa, não prova de irregularidade. Como a identificação da camareira é escolhida na tarefa e o registro pode ser feito pela equipe, esse mecanismo não substitui contas individuais, conferência independente ou controles físicos.

A busca de `/reservas` abre, por padrão, com os check-ins de hoje. Os campos **Check-in de** e **Até** permitem escolher o período. A tela consulta reservas e hospedagens da recepção pela data de check-in selecionada e busca recebimentos, cobranças e adicionais relacionados às reservas exibidas. O resumo de ocupação usa o índice operacional de reservas; a ocupação do painel administrativo também considera os quartos cadastrados.

## Dados e permissões

O app usa PocketBase Authentication e a coleção protegida `hotel_state`. Para desenvolvimento, configure `VITE_POCKETBASE_URL` e inicie o PocketBase local conforme as instruções em [PocketBase local](pocketbase/README.md). O adaptador centraliza leitura e gravação e controla concorrência por revisão; não há conexão com um banco remoto até que uma URL seja configurada.

O login usa e-mail e senha do PocketBase. O papel `admin` ou `viewer` é associado à conta na coleção privada `user_roles`. Os hooks do servidor negam acesso direto à coleção `hotel_state` e limitam as leituras e gravações por papel. Contas e permissões precisam ser criadas no PocketBase; credenciais e papéis antigos não são importados junto com os dados operacionais.

As telas de estoque, reservas, quartos, funcionários, tarifas e financeiro são restritas à gerência. A equipe acessa as operações necessárias por meio das rotas autenticadas do servidor; não configure permissões de leitura direta para a coleção `hotel_state`.

## Fluxo financeiro

O Fluxo de Caixa combina lançamentos financeiros salvos com dados derivados de operações, como hospedagens da recepção, adicionais, retiradas, vendas da geladeira e recebimentos de reservas. Os identificadores, ajustes e supressões evitam duplicações e preservam alterações feitas pela gerência. Alguns registros de recebimento são gravados no Financeiro ou sincronizados a partir de movimentações; não se deve presumir que todo valor exibido exista em um único caminho do banco. A folha de pagamento consulta apenas os registros financeiros, sem incluir lançamentos operacionais derivados.

- **Entradas no hotel** somam pagamentos recebidos diretamente pelo hotel e repasses da OYO para banco ou caixa físico. Pagamentos feitos diretamente à OYO são exibidos à parte.
- **Resultado de caixa** considera as entradas do hotel, despesas e folha pagas com caixa ou banco, e valores enviados à OYO. Transferências entre caixa e banco não alteram esse resultado.
- O histórico de pré-pagos mostra os valores brutos registrados como pagos à OYO. O cartão **Pré-Pagos (Retidos - OYO)** mostra o saldo da carteira OYO após os lançamentos e compensações registrados; o sistema não calcula comissões nem o acerto líquido com a OYO.
- Em pagamentos combinados, a parcela recebida pelo hotel aparece nas entradas do hotel e a parcela pré-paga fica no histórico da OYO.

Na aba **OYO**, consulte pré-pagos e repasses separados do resumo. A conciliação mensal editável recebe os totais e a participação do hotel (A) informados pela OYO, compara A com a soma das linhas e calcula o acerto após valores recebidos e pagamentos entre as partes. Eventuais diferenças devem ser esclarecidas com a OYO, sem presumir sua origem. Informe saldo anterior e ajustes com sinal negativo quando representarem débitos. O saldo da carteira de pré-pagos não representa o acerto líquido do relatório. A conciliação é informativa: não cria nem altera movimentos no financeiro, e deve ser conferida com o relatório e os lançamentos reais.

Em **Saída de caixa**, o motivo **Recolhido pela Gerência** registra a passagem do dinheiro do plantão para o cofre. O valor reduz a conferência do plantão, mas não gera despesa nem reduz o saldo do caixa físico do hotel, que inclui o cofre. O painel da gerência mantém o alerta até a confirmação; corrigir os dados do recolhimento exige nova confirmação. Em **Conferir caixa**, a gerência pode corrigir o motivo e o valor, inclusive convertendo entre recolhimento e despesa. As despesas originadas no plantão também podem ser corrigidas no Fluxo de caixa usando o formulário específico, que atualiza a saída original e o financeiro juntos.

No formulário financeiro dessas despesas, a gerência também pode corrigir a data operacional e o nome do plantonista; o horário original de registro permanece preservado. Recolhimentos, por não serem despesas, devem ser corrigidos em **Conferir caixa**.

Despesas e folha mantêm cada pagamento com data, carteira e valor. Vencimento, competência e pagamento são informações independentes. Ao corrigir um total pago, a diferença é registrada na data informada, preservando as parcelas anteriores. Datas de pagamentos antigos sem histórico aparecem identificadas e podem ser confirmadas ou corrigidas pela gerência.

### Folha de pagamento e vales

O vale (categoria **Adiantamento de salário**, lançado no Fluxo de caixa com funcionário e competência) sai do caixa ou do banco no momento em que é pago. Na **Folha de pagamento**, o lançamento mostra o **Salário base (referência)** cadastrado em **Funcionários**, lista automaticamente os **vales do período ainda não compensados** e pede apenas o **valor pago agora** (o contracheque, em caixa, banco ou dividido):

- **Total remuneração registrada** = valor pago no contracheque + vales já adiantados. A diferença para o salário base é registrada como acréscimo ou desconto da folha; sem salário base cadastrado, o total registrado vira a base.
- Os vales marcados ficam **vinculados e compensados** na folha (`advances`) e continuam com o próprio histórico de pagamento, mas **não saem do caixa novamente**: o saldo de caixa e banco só desconta o valor pago no ato da folha. O Fluxo de caixa identifica o vale como "Compensado na folha" e a planilha do contador traz os vales na observação da folha.
- Sem valor pago, a folha fica **pendente** (líquido previsto = salário base − vales). Com **Pagamento parcial**, o líquido previsto é mantido e o restante continua pendente; sem essa marcação, o valor pago fecha a folha.
- Registros antigos continuam válidos: os ajustes originais são preservados quando o total registrado não muda ao reabrir a folha.

## Tema escuro da gerência

Somente o login de **Gerente** vê, na barra lateral, o botão **Tema escuro** (Sol/Lua). Ele ativa o tema "Dark Glassmorphism" aplicando `data-manager-theme="dark-glass"` em `document.documentElement` e guarda a escolha no navegador em `localStorage` (`lindoia_manager_dark_glass`). O atributo é removido imediatamente ao encerrar a sessão, na tela de login e em qualquer sessão de funcionário, que mantém sempre o tema claro original (`src/services/managerTheme.ts`). Os estilos escuros ficam no fim de cada folha de estilo, sempre escopados em `[data-manager-theme="dark-glass"]`, e usam os tokens `--dg-*` definidos em `src/index.css`.

## Formulários e modais

Os modais de formulário e edição usam a mesma largura (`min(94vw, 820px)`; fluxos longos como recepção e lançamento de entrada/despesa mantêm 900px e confirmações ficam compactas), rótulos de `0.85rem`, campos de `0.925rem` com altura mínima de 42px, grades de duas colunas no desktop (uma no celular) e rodapé `Cancelar` / `Salvar` à direita. Linhas de checkbox ou radio devem usar a classe `modal-check-row` (ou `label` com `input` direto), que alinha a caixa de 18px ao texto. Valores em reais usam `MoneyInput` (`R$ 2.150,50`).

Para registrar uma compra, selecione sua categoria e a forma de pagamento na despesa ou na entrada de estoque. Dinheiro e Pix debitam a carteira na data da compra; cartão mantém a compra pendente, vinculada ao cartão cadastrado em **Configurações**, sem debitar as carteiras. Quando a fatura for paga, edite a despesa e registre o pagamento em dinheiro ou pelo banco. Não lance o mesmo pagamento novamente como outra despesa.

Em **Conferir caixa**, a gerência pode corrigir recebimentos, adicionais, vendas da geladeira e saídas. As correções atualizam os registros financeiros correspondentes; os recebimentos parciais continuam parciais.

Para enviar o movimento mensal ao contador, abra **Fluxo de caixa**, selecione o **Mês do resumo e da planilha** e clique em **Baixar planilha mensal (.xlsx)**. O arquivo inclui resumo, entradas, saídas, pré-pagos OYO, transferências e contas/folha, com conferência de saldo por carteira. A exportação usa o mês completo independentemente dos filtros da consulta. Consulte a [análise do financeiro e do estoque](docs/revisao-financeiro-estoque.md) para conhecer os critérios e as correções aplicadas.

## Funcionários e exclusões

O menu **Funcionários** mantém o cadastro em `erp_geral/escala/staff`, separado das contas usadas para entrar no sistema. Na primeira sessão da gerência, o sistema inicializa as sete pessoas configuradas para recepção e limpeza e importa nomes históricos não cadastrados como inativos. A marca `configured` evita recriar automaticamente pessoas ou categorias excluídas. Registros de turnos e operações mantêm a referência do funcionário e o nome histórico para preservar o histórico após renomeações ou exclusões.

A página lista os funcionários em cartões com busca por nome ou função, filtro **Ativos / Inativos / Todos**, **Salário base** em reais, resumo dos vales pendentes do mês e ações de editar, ativar/inativar e excluir. O cadastro e a edição abrem em um modal amplo com o campo **Salário Base (R$)**, gravado como `baseSalary` (número, em reais) no funcionário. Cadastros antigos sem `baseSalary` continuam válidos e valem 0; salvar sem informar o campo preserva o valor existente e informar 0 remove o salário.

A gerência pode excluir registros de reservas, hospedagens, adicionais, quartos, limpezas, conferências, passagens de turno e financeiro. Exclusões relacionadas são processadas em conjunto; pagamentos e adicionais vinculados são removidos conforme a operação, e bebidas podem devolver quantidades ao estoque. Os identificadores de exclusão ajudam a impedir que uma devolução seja aplicada mais de uma vez. Excluir um pagamento individual de hospedagem conserva a hospedagem e registra a anulação; excluir recebimento de reserva ajusta o saldo devido ou remove uma cobrança ainda pendente de conciliação.

Excluir um produto remove seu histórico de estoque e lançamentos financeiros gerados por esse histórico; vendas independentes já registradas permanecem. Excluir uma movimentação desfaz as quantidades correspondentes e remove seus lançamentos associados. Os eventos de auditoria ajudam a acompanhar alterações, mas não são uma trilha inviolável contra uma conta de gerência comprometida.

## Publicação na Cloudflare

Frontend, checkout manual e checkout automático são publicados no Cloudflare
Worker `hotel-lindoia-erp`. O PocketBase permanece na Oracle. Não há dependência
do Netlify. Veja [Publicação na Cloudflare](docs/publicar-cloudflare.md) para
configurar variáveis de build, segredos de runtime, Cron e validar o plano Free.

Use `npm run deploy:cloudflare` com Wrangler autenticado, ou publique pelo GitHub
com `npm run build` e `npx wrangler deploy`.

## Desenvolvimento

```bash
npm install
npm run dev:cloudflare
```

Antes, configure as variáveis locais e inicie o PocketBase seguindo
[PocketBase local](pocketbase/README.md).

Os scripts disponíveis incluem `npm run build`, `npm run lint` e `npm run preview`.

`npm test` executa todas as suítes em sequência. Os testes `npm run test:operations`, `npm run test:cleaning`, `npm run test:finance`, `npm run test:improvements`, `npm run test:inventory`, `npm run test:accounting`, `npm run test:dialog-behavior` e `npm run test:pocketbase-import` verificam operações, limpeza, conciliação financeira (inclusive folha com vales sem dupla saída de caixa), cadastro de funcionários com salário base, tema escuro da gerência, padrão dos modais, concorrência, estoque, geração do Excel e validações do importador usando dados locais.
