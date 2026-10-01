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

Se o banco estiver indisponível ou as regras negarem leitura/gravação, o sistema mostra o erro em vez de trocar silenciosamente para dados locais.

As regras do Realtime Database precisam permitir leitura e gravação somente aos usuários autorizados. O login atual do projeto é demonstrativo e não autentica no Firebase; não libere acesso público ao banco para contornar isso. A cobrança pendente fica registrada no histórico do estoque, mas ainda não é lançada automaticamente na conta da reserva.

**Segurança pendente:** a verificação de conexão feita em 30/09/2026 confirmou que o nó de estoque aceita leitura e escrita sem autenticação. Não cadastre dados reais até habilitar autenticação Firebase e restringir as regras do Realtime Database.

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
