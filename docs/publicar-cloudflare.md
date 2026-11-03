# Publicar na Cloudflare Workers Free

O frontend React/Vite, a API de checkout manual e o agendamento de checkout
rodam no Worker `hotel-lindoia-erp`. Não há chamadas ao Netlify nem proxy para
ele. PocketBase, autenticação e dados continuam na VM Oracle existente.

## Configuração do painel

O repositório GitHub deve conter esta versão antes do novo deploy. Em Builds:

| Campo | Valor |
| --- | --- |
| Production branch | `main` |
| Root directory | `/` |
| Build command | `npm run build` |
| Deploy command | `npx wrangler deploy` |

**Variável de build** (Builds → Variables and secrets):

- `VITE_POCKETBASE_URL=https://137-131-244-154.sslip.io`

**Variáveis de execução** (Settings → Runtime variables and secrets → Production):

| Nome | Tipo | Conteúdo |
| --- | --- | --- |
| `POCKETBASE_URL` | Variable | `https://137-131-244-154.sslip.io` |
| `POCKETBASE_SUPERUSER_EMAIL` | Secret | E-mail da conta técnica já usada no PocketBase |
| `POCKETBASE_SUPERUSER_PASSWORD` | Secret | Senha dessa conta técnica |

As credenciais precisam estar no **runtime**, não apenas em Builds. Nunca
use prefixo `VITE_` para credenciais. Remova as credenciais do escopo de build
após configurá-las no runtime. `CHECKOUT_ORIGIN` não é mais usado; remova-o
caso tenha sido cadastrado. `keep_vars` preserva variáveis do painel no deploy.
Não copie segredos para código, documentação ou GitHub.

Se o painel continuar mostrando **Configured API token unavailable**, selecione
ou configure um token válido de deploy em Builds antes de executar novamente.
Não compartilhe tokens nem senhas em mensagens ou capturas.

## Rotas e agendamento

`wrangler.jsonc` configura:

- Assets em `dist`, binding `ASSETS`, fallback SPA para `/reservas`, `/recepcao` etc.
- `workers_dev: true`, para habilitar o endereço público no próximo deploy.
- `/api/*` executa o Worker. `/api/checkout` oferece GET e POST autenticados;
  demais APIs retornam JSON 404. Respostas de API não são armazenadas em cache.
- Cron `*/5 0-2,15-23 * * *`: a cada cinco minutos entre 12:00 e 23:55,
  horário de São Paulo (UTC−3). A regra de negócio confere a data atual do hotel,
  preserva pendências financeiras e evita repetir checkout já concluído.
- Não existe endpoint HTTP público para disparar o checkout automático.

As regras operacionais continuam verificadas pelos hooks do PocketBase. As
credenciais de servidor são recebidas por `env` e cada execução cria seu próprio
cliente; sessões de superusuário não são compartilhadas com o navegador.

## Publicação e validação

1. Execute `npm run test:cloudflare`, `npm run test:checkout` e
   `npm run test:checkout-client`. Gere o build com `npm run build`.
2. Envie os arquivos para `main` e acompanhe o deploy conectado ao GitHub.
   Alternativamente, com Wrangler autenticado, use `npm run deploy:cloudflare`.
3. Confira o endereço `workers.dev` em Domains, abra rotas internas diretamente
   e atualize a página. Teste login, leitura e realtime com uma conta de teste.
4. Sem autenticação, `/api/checkout` deve retornar JSON 401; com sessão válida,
   teste consulta e histórico. Em homologação, teste checkout pago e bloqueio
   por pendência, preservação dos recebimentos e quarto marcado como sujo.
5. Confira o Cron em Trigger events e o resultado das execuções nos logs.
   Alterações de Cron podem levar até 15 minutos para propagar.
6. Confira CPU time e erros 1102 com carga representativa antes de considerar
   concluída a migração. Não habilite Workers Paid para contornar limites.
7. Depois da validação, desative o agendamento e o deploy antigos no painel
   Netlify e retire o endereço antigo de uso. Não é necessário apagar o site
   antes de validar; sua desativação não foi feita automaticamente pelo código.

A sessão exige novo login ao trocar de origem. O banco não é reimportado.
Se o Netlify ainda estiver ativo durante a transição, os dois jobs podem rodar;
a revisão transacional e a idempotência protegem a gravação, mas desative o
agendamento antigo após confirmar o novo para evitar trabalho duplicado.

## Desenvolvimento local

Use uma instância PocketBase de testes. Configure `VITE_POCKETBASE_URL` em
`.env.local` e as três variáveis de runtime em `.dev.vars` (arquivo ignorado
pelo Git). Execute `npm run dev:cloudflare` para build e servidor local completo.
`npm run dev` inicia somente o Vite, sem a API de checkout.
Não teste Cron ou checkout manual contra hospedagens reais.

## Plano gratuito

- Requisições estáticas são gratuitas e ilimitadas quando servidas sem Worker.
- O código de API está sujeito à franquia Workers Free de 100.000 requisições/dia,
  compartilhada pela conta; há limite de 10 ms de CPU por requisição e por Cron.
- Espera de rede não conta como CPU, mas leitura, clone e processamento do estado
  do hotel contam. Passar nos testes locais não comprova adequação aos 10 ms em
  produção. Se ultrapassar, será necessário otimizar ou processar a operação no
  servidor PocketBase já existente; não é preciso contratar um plano sem avaliar.
- Oracle continua sujeita ao próprio plano. Esta migração substitui o Netlify;
  não transfere o banco PocketBase para um serviço de banco Cloudflare.

Referências:
- https://developers.cloudflare.com/workers/static-assets/
- https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/
- https://developers.cloudflare.com/workers/configuration/cron-triggers/
- https://developers.cloudflare.com/workers/platform/limits/
