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

O módulo usa o Realtime Database padrão do projeto Firebase (`hotel-lindoia-erp-default-rtdb.firebaseio.com`) e grava em `erp_geral/estoque`. Para apontar para outra instância, configure `VITE_FIREBASE_DATABASE_URL` no `.env.local` e reinicie o Vite.

O login usa Firebase Authentication com e-mail e senha. O papel de cada usuário é lido em `roles/{uid}/role` no Realtime Database: `admin` para gerência ou `viewer` para funcionários. A escala permite leitura para ambos e gravação somente para admin; o estoque completo e o Financeiro ficam restritos a admin. Funcionários podem criar reservas e operar a Geladeira - Recepção por nós operacionais separados, sem leitura ou gravação do ledger financeiro.

### Reservas e quartos

As telas `/reservas` e `/quartos` compartilham `erp_geral/quartos`. Funcionários podem criar reservas com valor, taxa, origem e café da manhã, além de incluir extras tarifados antes do check-in. A origem Rotativo registra uma janela de quatro horas e bloqueia apenas intervalos de 15 minutos ocupados; reservas comuns bloqueiam as diárias. O ponto de venda “Lançar Venda” permite vender bebidas e lançar café da manhã, colchão extra, pessoa adicional, check-in antecipado e check-out tardio para uma hospedagem ativa; esses adicionais entram no saldo do quarto. Funcionários e gerência podem fazer check-in/check-out; o check-in exige quarto limpo e fora de manutenção. No checkout, a equipe vê o saldo devido e registra o valor recebido sem abrir o Financeiro; a cobrança fica numa fila operacional e a gerência a concilia no ledger. O checkout encerra a hospedagem e marca o quarto como sujo. Os cards de chegadas e saídas contam quartos distintos, não hóspedes. A ocupação é derivada das reservas com status `hospedado`, não de um campo manual separado.

O painel usa as reservas e os quartos cadastrados para calcular ocupação atual, quartos limpos e liberados, chegadas e saídas de hoje e amanhã (contagem de adultos e crianças). Os alertas de estoque usam os mesmos saldos e limites mínimos da tela de estoque. No desenvolvimento, quartos e reservas são salvos no `localStorage` deste navegador; em produção, usam o Realtime Database.

As regras de negação padrão estão em `database.rules.json`, vinculadas ao projeto `hotel-lindoia-erp` por `firebase.json` e `.firebaserc`. O catálogo público da geladeira contém somente nome, unidade, preço de venda e status; saldo e vendas ficam em `erp_geral/frigobar/operations`. Custos, fornecedores, patrimônio e Financeiro continuam restritos a admin. As contas de gerência (`admin`) e funcionário (`viewer`) estão provisionadas; os papéis ficam em `/roles/{uid}/role`.

Para liberar outro usuário, crie a conta em **Authentication → Users**, copie o UID e, no Realtime Database, crie `/roles/{uid}/role` com o valor string `viewer` para equipe ou `admin` para gerência. O usuário só acessa os módulos permitidos pelo papel após esse cadastro.

Cadastre papéis pelo Console Firebase, que tem permissão administrativa. As regras impedem que usuários alterem o próprio papel. Para publicar futuras alterações ao arquivo de regras, use `firebase deploy --only database`.

Não coloque senhas ou credenciais de conta de serviço no código ou no repositório. Tarifa, taxa e café da manhã pertencem à reserva; recebimentos ficam somente no Financeiro. Na primeira abertura por um admin, recebimentos legados são migrados para o ledger protegido e removidos das reservas compartilhadas. O saldo operacional da geladeira é sincronizado com as movimentações da gerência. Um admin conectado concilia vendas pagas com o Financeiro; cobranças pendentes entram após a baixa no checkout. Sem uma sessão admin ativa, a venda fica registrada no nó operacional e será conciliada quando a gerência abrir o sistema. Reservas e lançamentos financeiros mantêm eventos de criação, alteração e exclusão com data, usuário e identificador do registro; o histórico começa após esta versão e não é uma trilha inviolável contra uma conta admin comprometida.

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
