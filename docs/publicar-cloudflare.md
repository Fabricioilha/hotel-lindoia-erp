# Front-end na Cloudflare Pages (Free)

Esta migração move o React/Vite para Pages. PocketBase continua na Oracle;
as funções de checkout manual e automático continuam no Netlify. Não exclua
nem pause o site Netlify: isso interromperia o checkout e o agendamento.

O build Cloudflare inclui um Worker pequeno que encaminha exclusivamente
`/.netlify/functions/checkout` ao Netlify, sem cache. O token do usuário é
validado pelo serviço existente. Nenhuma credencial de superusuário precisa
ser copiada para a Cloudflare. O restante é servido como arquivos estáticos;
Pages fornece o fallback de SPA quando não há `404.html` na raiz.

## Publicação pelo painel (upload)

1. Execute `npm run test:cloudflare && npm run build:cloudflare` na raiz.
   A `.env.local` deve conter `VITE_POCKETBASE_URL` com a URL HTTPS pública
   do PocketBase. O endereço atual está em `pocketbase/README.md`.
2. No painel Cloudflare, abra **Workers & Pages**, escolha criar aplicação
   e a opção **Pages / upload de arquivos**. Use o plano Free e o nome
   `hotel-lindoia-erp` (se disponível).
3. Envie somente a pasta `dist`. Inclua `_worker.js` e `_routes.json`;
   o modo avançado `_worker.js` é aceito no upload pelo painel. Nunca envie
   a raiz do projeto: ela contém backups, arquivos locais e chaves.
4. Nas configurações do projeto, em **Variables and Secrets**, configure
   `CHECKOUT_ORIGIN` para a origem HTTPS do site Netlify atual, por exemplo
   `https://nome-real-do-site.netlify.app`, sem caminho nem barra de checkout.
   Aplique em produção e também em preview, caso use previews.
5. Faça nova publicação para ativar a variável. Até ela estar configurada,
   a API retorna erro 503 explícito e não executa checkout.
6. Verifique o endereço `*.pages.dev` antes de entregar à equipe.

## Alternativa: terminal

Com a conta autenticada por `npx --yes wrangler@4 login`, execute
`npm run deploy:cloudflare`. Se solicitado, crie o projeto Pages e escolha
sua branch de produção. Configure `CHECKOUT_ORIGIN` no painel e publique
novamente. Não escolha Workers Paid nem adicione produtos pagos.

## Alternativa: integração Git

Depois que estes arquivos estiverem no GitHub, conecte o repositório ao Pages.
Use raiz do repositório, comando `npm run test:cloudflare && npm run build:cloudflare`,
saída `dist` e Node 22. Configure `VITE_POCKETBASE_URL` para o build e
`CHECKOUT_ORIGIN` para o Worker. Não copie senhas para variáveis `VITE_`.
Projetos Direct Upload não podem ser convertidos para integração Git; escolha
este fluxo desde o início se desejar publicação automática a cada push.

## Validação antes da troca

- Abrir `/login`, `/reservas` e `/recepcao` diretamente e atualizar a página.
- Entrar com conta de teste e validar leitura, realtime e permissões dos perfis.
- Sem autenticação, `/.netlify/functions/checkout` deve retornar JSON 401.
- Validar consulta de checkout e histórico com conta de teste.
- Em homologação, executar checkout de uma hospedagem de teste e conferir
  recebimentos e estado de limpeza; não usar hospedagem real como teste.
- Confirmar que `checkout-noon` continua Scheduled no Netlify e conferir seus logs.
- Só então divulgar a URL nova ou alterar o domínio. A sessão precisa de novo
  login, pois o armazenamento de autenticação pertence à origem do navegador.

## Gratuidade e limites

Conforme documentação consultada em novembro de 2026:

- Arquivos estáticos: requisições gratuitas e ilimitadas quando não invocam Functions.
- Ponte de checkout: franquia Workers Free de 100.000 requisições/dia,
  compartilhada com outros Workers/Functions da conta; renovação às 00:00 UTC.
- Pages Free: 500 builds/mês, até 20.000 arquivos e 25 MiB por arquivo;
  upload pelo painel tem limite de 1.000 arquivos.
- O subdomínio `pages.dev` evita a necessidade de comprar um domínio.
- Netlify e Oracle continuam sujeitos aos próprios planos, cotas e consumo.
  Esta etapa não elimina a dependência nem garante gratuidade desses serviços.

Para retirar completamente o Netlify, será necessário migrar a API de checkout
E seu agendamento para a Oracle ou outro runtime, com validação das operações.
Não basta publicar o `dist` padrão do Vite.

Referências:
- https://developers.cloudflare.com/pages/functions/pricing/
- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/configuration/serving-pages/
