# Publicar no Netlify

O checkout manual e o agendado usam as funções `checkout` e `checkout-noon`,
em `netlify/functions`. Publique o frontend e as duas funções da mesma versão.
As funções acessam o PocketBase usando credenciais de superusuário mantidas
somente no servidor.

## Configuração

No site Netlify, configure:

- `VITE_POCKETBASE_URL`: URL pública HTTPS da instância PocketBase. Essa
  variável é incluída no frontend.
- `POCKETBASE_URL`: URL HTTPS do PocketBase para uso pelas funções.
- `POCKETBASE_SUPERUSER_EMAIL`: e-mail de uma conta técnica do PocketBase.
- `POCKETBASE_SUPERUSER_PASSWORD`: senha dessa conta técnica.

As duas últimas variáveis devem ter escopo **Functions**. Use uma conta técnica
com senha exclusiva, rotacione credenciais compartilhadas anteriormente e não
coloque senhas em variáveis `VITE_`, arquivos do repositório, `public` ou `dist`.
O PocketBase precisa aceitar conexões do Netlify; não use endereço loopback em
produção.

## Publicar atualizações

1. Confirme que as migrações e hooks do diretório `pocketbase/` foram aplicados
   à instância de homologação e que existem contas de teste com papéis em
   `user_roles`.
2. No terminal da pasta do projeto, vincule o site Netlify uma única vez:

   ```sh
   npx --yes netlify-cli login
   npx --yes netlify-cli link
   ```

3. Execute `npm run deploy:netlify`.
4. No painel do Netlify, confirme que `checkout` responde e que
   `checkout-noon` aparece como **Scheduled**.
5. Teste login, permissões e checkout em homologação antes de usar a instância
   de produção.

Para executar frontend e funções localmente, use `npm run dev:netlify` com
`VITE_POCKETBASE_URL`, `POCKETBASE_URL` e as credenciais de superusuário
configuradas no terminal. Veja [PocketBase local](../pocketbase/README.md).

Agendamentos executam em produção conforme a
[documentação do Netlify](https://docs.netlify.com/build/functions/scheduled-functions/).
