# Hotel Lindoia ERP

Aplicação web para apoiar a operação do Hotel Lindoia: reservas e quartos, recepção, limpeza, estoque, vendas da geladeira, escala e controle financeiro.

## Funcionalidades

- **Estoque (`/estoque`)**: produtos de limpeza, rouparia, manutenção e Geladeira - Recepção; saldos por local, custos, preços, fornecedores, validade, estoque mínimo e histórico de movimentações.
- **Vendas da geladeira (`/vendas`)**: lançamento de vendas, com pagamento na recepção ou cobrança no quarto para o checkout.
- **Reservas (`/reservas`) e quartos (`/quartos`)**: mapa de ocupação, reservas, hóspedes, quartos e limpeza.
- **Recepção (`/recepcao`)**: hospedagens, adicionais, caixa, conferências de troco e passagens de turno.
- **Outros módulos**: funcionários, tarifas, limpeza, saídas de estoque e financeiro.

## Reservas e quartos

As telas `/reservas` e `/quartos` usam os dados de `erp_geral/quartos` e são destinadas à gerência. O atendimento lançado em `/recepcao` é armazenado separadamente em `erp_geral/recepcao/stays`.

A busca de `/reservas` abre, por padrão, com os check-ins de hoje. Os campos **Check-in de** e **Até** permitem escolher o período. A tela consulta reservas e hospedagens da recepção pela data de check-in selecionada e busca recebimentos, cobranças e adicionais relacionados às reservas exibidas. O resumo de ocupação usa o índice operacional de reservas; a ocupação do painel administrativo também considera os quartos cadastrados.

## Dados e permissões

O app usa Firebase Authentication e Realtime Database. A configuração de desenvolvimento também aponta para o Firebase configurado no projeto; não há configuração de emulador local. Portanto, alterações feitas durante o desenvolvimento podem gravar no banco conectado.

O login usa e-mail e senha. O papel é armazenado em `/roles/{uid}/role`: `admin` para gerência e `viewer` para equipe. As telas de estoque, reservas, quartos, funcionários, tarifas e financeiro são restritas à gerência. A equipe tem acesso a telas operacionais conforme as regras do Realtime Database. As regras começam negando acesso e estão em `database.rules.json`; `firebase.json` e `.firebaserc` apontam para o projeto `hotel-lindoia-erp`.

**Atenção: as regras atuais permitem que `viewer` leia o ramo inteiro `/erp_geral/recepcao` e o ramo `/erp_geral/frigobar/operations`.** Isso inclui os registros operacionais armazenados nesses caminhos, como hospedagens, cobranças e vendas. Filtros de período ou diretórios usados pela interface limitam as consultas da tela, mas não limitam o que um usuário autenticado como `viewer` pode ler diretamente do Realtime Database. O índice `erp_geral/quartos/reservationIndex` também é legível por `viewer`; o cadastro completo de reservas e o Financeiro são restritos a `admin` pelas regras.

Para liberar um usuário, crie a conta em **Firebase Authentication → Users**, copie o UID e, no Realtime Database, grave `/roles/{uid}/role` como `viewer` ou `admin`. As regras não permitem que o usuário altere o próprio papel. O catálogo da geladeira pode ser lido por usuários autenticados; dados de estoque, custos, fornecedores e patrimônio ficam no módulo de gerência.

Para publicar alterações nas regras, use `firebase deploy --only database`. Não coloque senhas ou credenciais de conta de serviço no código ou no repositório.

## Fluxo financeiro

O Fluxo de Caixa combina lançamentos financeiros salvos com dados derivados de operações, como hospedagens da recepção, adicionais, retiradas, vendas da geladeira e recebimentos de reservas. Os identificadores, ajustes e supressões evitam duplicações e preservam alterações feitas pela gerência. Alguns registros de recebimento são gravados no Financeiro ou sincronizados a partir de movimentações; não se deve presumir que todo valor exibido exista em um único caminho do banco. A folha de pagamento consulta apenas os registros financeiros, sem incluir lançamentos operacionais derivados.

- **Entradas no hotel** somam pagamentos recebidos diretamente pelo hotel e repasses da OYO para banco ou caixa físico. Pagamentos feitos diretamente à OYO são exibidos à parte.
- **Resultado de caixa** considera as entradas do hotel, despesas e folha pagas com caixa ou banco, e valores enviados à OYO. Transferências entre caixa e banco não alteram esse resultado.
- O histórico de pré-pagos mostra os valores brutos registrados como pagos à OYO. O cartão **Pré-Pagos (Retidos - OYO)** mostra o saldo da carteira OYO após os lançamentos e compensações registrados; o sistema não calcula comissões nem o acerto líquido com a OYO.
- Em pagamentos combinados, a parcela recebida pelo hotel aparece nas entradas do hotel e a parcela pré-paga fica no histórico da OYO.

## Funcionários e exclusões

O menu **Funcionários** mantém o cadastro em `erp_geral/escala/staff`, separado das credenciais do Firebase Authentication. Na primeira sessão da gerência, o sistema inicializa as sete pessoas configuradas para recepção e limpeza e importa nomes históricos não cadastrados como inativos. A marca `configured` evita recriar automaticamente pessoas ou categorias excluídas. Registros de turnos e operações mantêm a referência do funcionário e o nome histórico para preservar o histórico após renomeações ou exclusões.

A gerência pode excluir registros de reservas, hospedagens, adicionais, quartos, limpezas, conferências, passagens de turno e financeiro. Exclusões relacionadas são processadas em conjunto; pagamentos e adicionais vinculados são removidos conforme a operação, e bebidas podem devolver quantidades ao estoque. Os identificadores de exclusão ajudam a impedir que uma devolução seja aplicada mais de uma vez. Excluir um pagamento individual de hospedagem conserva a hospedagem e registra a anulação; excluir recebimento de reserva ajusta o saldo devido ou remove uma cobrança ainda pendente de conciliação.

Excluir um produto remove seu histórico de estoque e lançamentos financeiros gerados por esse histórico; vendas independentes já registradas permanecem. Excluir uma movimentação desfaz as quantidades correspondentes e remove seus lançamentos associados. Os eventos de auditoria ajudam a acompanhar alterações, mas não são uma trilha inviolável contra uma conta de gerência comprometida.

## Desenvolvimento

Instale as dependências e inicie o servidor local:

```bash
npm install
npm run dev
```

Os scripts disponíveis incluem `npm run build`, `npm run lint` e `npm run preview`.
