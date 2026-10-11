# React + TypeScript + Vite

## Hotel Lindoia ERP

O módulo de estoque fica em `/estoque` e inclui:

- Produtos de limpeza, rouparia, manutenção e Geladeira - Recepção, com saldo por local, custo, preço de venda, fornecedor, validade e estoque mínimo.
- Histórico de entradas, saídas, transferências, perdas, vendas da geladeira e conferências de inventário.
- Vendas da Geladeira - Recepção podem ser recebidas na hora (dinheiro, Pix ou cartão) ou lançadas no quarto para cobrar no checkout.
- Atalho de vendas no painel inicial da equipe, com carrinho e baixa automática do saldo da recepção.
- Cadastro de fornecedores e controle separado de bens duráveis em Patrimônio.
- Alertas de saldo baixo, valor estimado em estoque e valores da geladeira recebidos ou pendentes por checkout.

### Persistência

O app usa o Firebase Authentication e o Realtime Database do Hotel Lindoia também durante o desenvolvimento. Não há emulador nem cópia local dos dados; alterações feitas com `npm run dev` são gravadas no Firebase configurado no projeto.

O login usa Firebase Authentication com e-mail e senha. O papel de cada usuário é lido em `roles/{uid}/role` no Realtime Database: `admin` para gerência ou `viewer` para funcionários. A escala permite leitura para ambos e gravação somente para admin; reservas, dados pessoais dos hóspedes, estoque completo e Financeiro são restritos a admin. A equipe usa o caixa da recepção e acessa apenas o diretório operacional de quartos e hospedagens ativas, sem leitura do cadastro completo de hóspedes ou do ledger financeiro.

### Reservas e quartos

As telas `/reservas` e `/quartos` compartilham `erp_geral/quartos` e são restritas à gerência. O atendimento feito pela equipe no caminho `/recepcao` continua sendo registrado em `erp_geral/recepcao/stays`; esse fluxo ainda não está unificado com o mapa de reservas. A equipe pode lançar vendas de frigobar para quartos hospedados usando um índice operacional sem CPF, data de nascimento, telefone ou endereço do hóspede. Os cards de chegadas e saídas contam quartos distintos, não hóspedes. A ocupação do módulo de reservas é derivada dos registros de reserva.

O painel administrativo usa as reservas e os quartos cadastrados para calcular ocupação atual, quartos limpos e liberados, chegadas e saídas de hoje e amanhã. Os diretórios operacionais usados pela equipe são separados para evitar que o listener leia os dados pessoais completos das reservas.

As regras de negação padrão estão em `database.rules.json`, vinculadas ao projeto `hotel-lindoia-erp` por `firebase.json` e `.firebaserc`. O catálogo público da geladeira contém somente nome, unidade, preço de venda e status; saldo e vendas ficam em `erp_geral/frigobar/operations`. Custos, fornecedores, patrimônio e Financeiro continuam restritos a admin. As contas de gerência (`admin`) e funcionário (`viewer`) estão provisionadas; os papéis ficam em `/roles/{uid}/role`.

Para liberar outro usuário, crie a conta em **Authentication → Users**, copie o UID e, no Realtime Database, crie `/roles/{uid}/role` com o valor string `viewer` para equipe ou `admin` para gerência. O usuário só acessa os módulos permitidos pelo papel após esse cadastro.

Cadastre papéis pelo Console Firebase, que tem permissão administrativa. As regras impedem que usuários alterem o próprio papel. Para publicar futuras alterações ao arquivo de regras, use `firebase deploy --only database`.

Não coloque senhas ou credenciais de conta de serviço no código ou no repositório. Tarifa, taxa e café da manhã pertencem à reserva; recebimentos ficam somente no Financeiro. A migração de recebimentos legados não roda automaticamente ao abrir o painel; ela deve ser executada como operação controlada. O saldo operacional da geladeira é sincronizado com as movimentações da gerência. O fluxo de caixa acompanha diretamente os registros operacionais em tempo real; cobranças da geladeira pendentes entram após a baixa no checkout. Reservas e lançamentos financeiros mantêm eventos de auditoria; esse histórico não é uma trilha inviolável contra uma conta admin comprometida.

### Fluxo financeiro

`subscribeFinance` reúne lançamentos manuais, hospedagens da recepção, adicionais dos quartos, retiradas, vendas recebidas da geladeira e recebimentos de reservas pendentes de conciliação. A visão operacional é calculada em `operationalLedger.ts`, sem depender de abrir o painel administrativo ou gravar cópias de cada recebimento. As permissões financeiras continuam exclusivas da gerência. A folha de pagamento não assina os registros operacionais.

Os ids dos lançamentos automáticos são mantidos para evitar duplicação com cópias históricas. Ajustes financeiros manuais prevalecem e exclusões registradas em `suppressed` continuam respeitadas. Categorias automáticas históricas de rotativo, taxas, extras e retiradas são corrigidas na apresentação, preservando valores e pagamentos. Novos ajustes manuais recebem `operationalOverride` para manter a classificação escolhida pela gerência.

O café tem forma de pagamento própria e permite pagamento combinado no cadastro e na conversão de rotativo em diária. Cadastros antigos sem essa informação conservam o método original; a forma realmente recebida não pode ser deduzida automaticamente.

- **Entradas no hotel:** pagamentos recebidos diretamente pelo hotel mais repasses da OYO para banco ou caixa físico.
- **Resultado de caixa:** entradas no hotel menos despesas pagas e transferências enviadas à OYO. Transferências entre caixa físico e banco não alteram esse resultado.
- **Pré-Pagos (Retidos - OYO):** saldo inicial informado mais pré-pagos dos hóspedes, menos repasses recebidos pelo hotel. Pagamentos enviados à OYO ficam discriminados separadamente e não aumentam o controle de pré-pagos. Este subtotal não é o acerto líquido com a OYO; comissões não são calculadas.
- **Entradas e resumo por origem:** somente as parcelas recebidas diretamente no hotel. Em pagamentos combinados, a parcela pré-paga aparece exclusivamente no histórico da OYO. O relatório mensal discrimina as duas parcelas.

No cadastro de hóspedes da recepção, uma taxa marcada como pré-paga fica fora do total a cobrar no hotel e permanece no histórico de pré-pagos da OYO. Quando a taxa é paga na recepção, ela entra no total do hóspede e gera uma despesa OYO pendente no fluxo de caixa para discriminar o valor a repassar.

Registre o repasse pelo botão **Registrar repasse da OYO**, escolhendo banco ou caixa físico como destino. O histórico de pré-pagos mantém o valor bruto dos pagamentos, enquanto o cartão exibe pré-pagos menos repasses, sem deduzir comissões. Um repasse já lançado como transferência não deve ser cadastrado novamente como entrada manual.

Execute `npm install` e `npm run dev` para iniciar o projeto. Use `npm run build` e `npm run lint` para validar.

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

You can also install [eslint-plugin-react-x](https://npmx.dev/package/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://npmx.dev/package/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])

```

### Cadastro único de funcionários e exclusões

O menu **Funcionários** concentra pessoas e categorias. O cadastro fica em `erp_geral/escala/staff`, aproveitando as permissões já existentes (leitura da equipe e alterações da gerência). Não armazena credenciais de login. Na primeira sessão da gerência, uma transação inicializa as sete pessoas atuais: Tatiana, Luana, Cevani e Paulo na recepção; Juliana, Thifani e Amanda na limpeza. Nomes antigos são importados como inativos, sem apagar dias ou turnos da escala. A marca `configured` impede recriar pessoas e categorias excluídas. A assinatura do cadastro é compartilhada entre as telas.

Novos turnos, hospedagens, adicionais, retiradas, conferências de troco, folhas e limpezas vinculam o funcionário por id, com nome histórico como alternativa. Renomear mantém aliases para registros antigos. Excluir um funcionário retira seu nome das seleções futuras, preservando seus turnos e os movimentos financeiros existentes.

A gerência pode excluir hospedagens, adicionais, reservas, quartos, limpezas, conferências e passagens de turno, além dos registros financeiros. Excluir uma reserva libera somente os horários ainda pertencentes a ela. Exclusões de hospedagens e reservas removem pagamentos e adicionais vinculados; exclusões de quartos também removem seus registros de hospedagem e limpeza. Bebidas devolvem quantidades ao estoque. Essas alterações e a retirada de lançamentos financeiros são gravadas atomicamente; identificadores de exclusão evitam devoluções duplicadas. Excluir somente um pagamento de hospedagem conserva o cadastro e registra a anulação também na operação, para que a conferência de caixa recalcule o valor recebido. Excluir um recebimento de reserva devolve esse valor ao saldo devido (ou remove a cobrança ainda pendente de conciliação).

A conferência de caixa apresenta os pagamentos à OYO separados dos recebimentos no hotel. Categorias financeiras automáticas também podem ser renomeadas ou excluídas; o mapeamento de categorias impede que elas reapareçam com o nome anterior e conserva os valores em “Sem categoria”. A gerência pode excluir registros individuais de auditoria financeira.

Exclusões de produtos removem seu histórico de estoque e os recebimentos/despesas gerados por esse histórico, preservando vendas independentes da geladeira. Excluir uma movimentação desfaz suas quantidades de origem/destino e retira seus lançamentos financeiros. Movimentos de uma saída para uso interno excluem a saída associada por completo. As saídas de produtos preservam a distribuição de quantidades por local; devoluções de registros antigos sem esse detalhamento retornam ao almoxarifado central quando a origem contém vários locais. Marcadores de exclusão impedem reaplicar uma saída antiga. Fornecedores e categorias removidos desvinculam os produtos, mantendo os cadastros e saldos. Patrimônio permite exclusão e seus totais são derivados dos registros restantes.
