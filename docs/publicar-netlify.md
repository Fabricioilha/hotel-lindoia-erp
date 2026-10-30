# Publicar telas e checkout juntos

O checkout manual e o automático dependem das funções `checkout` e `checkout-noon`, em `netlify/functions`. Atualizar somente os arquivos das telas não confirma a publicação dessas funções. Se a chamada `/.netlify/functions/checkout` retornar HTML, a tela não recebeu a resposta do serviço. O sistema conserva a hospedagem nesse caso.

## Correção de 25/10/2026

A consulta pública ao site `https://erp-lindoia.netlify.app/.netlify/functions/checkout` retornou HTTP 502 com `ERR_REQUIRE_ESM`: `jwks-rsa` tentou carregar `jose` via `require`. A função estava publicada, mas falhava antes de iniciar. A mensagem anterior do aplicativo atribuía incorretamente qualquer resposta não JSON à falta de publicação.

O `package.json` agora fixa a família compatível `jose@^5.10.0` somente dentro de `jwks-rsa`, mantendo Firebase Admin 14. O `package-lock.json` deve ser publicado junto. O build do Netlify executa um teste que carrega Auth/Database com `--no-experimental-require-module` e verifica uma assinatura RSA local. O teste não conecta ao banco nem utiliza credenciais reais.

Republique o projeto completo, incluindo os dois arquivos de dependências e as funções. Se o Netlify reutilizar dependências antigas, limpe o cache do build antes de republicar. As configurações de Firebase existentes devem ser preservadas; só configure as variáveis abaixo se estiverem ausentes.

## Configuração inicial

1. No projeto existente do Netlify, configure as variáveis de ambiente com escopo **Functions**:
   - `FIREBASE_SERVICE_ACCOUNT`: JSON da conta de serviço do Firebase do hotel.
   - `FIREBASE_DATABASE_URL`: URL do Realtime Database do mesmo projeto.
2. As credenciais são exclusivas do servidor. Não use prefixo `VITE_`, não coloque o JSON em `public` ou `dist` e não inclua credenciais na pasta enviada.
3. No terminal da pasta do projeto, execute `npx --yes netlify-cli login` e `npx --yes netlify-cli link`. Selecione o site já utilizado pelo hotel.

## A cada atualização

Execute `npm run deploy:netlify`. O comando compila o projeto e publica telas e funções usando `netlify.toml`. Isso substitui o envio manual da pasta. Alternativamente, conecte um repositório Git ao mesmo site para o Netlify executar o build completo.

Após a publicação, confirme na área **Functions** do Netlify:

- `checkout` existe e está respondendo;
- `checkout-noon` existe com a indicação **Scheduled**;
- o registro de execução não mostra falta de configuração do Firebase.

Abra a grade autenticado. As saídas de hoje após 12h aparecem como **Saída pendente** até o servidor concluir o checkout. O agendamento verifica novamente a cada cinco minutos, do meio-dia até o fim do dia em São Paulo. Saldo de hospedagem, adicionais ou geladeira impede o encerramento. A confirmação conserva o histórico e deixa o quarto aguardando limpeza.

Para uma hospedagem cuja execução do meio-dia falhou, use **Liberar quarto para limpeza** após publicar e configurar o serviço. Registros anteriores não são encerrados em massa pelo agendamento.

Para desenvolvimento com funções, use `npm run dev:netlify`. O Vite isolado (`npm run dev` ou `npm run preview`) serve apenas as telas.

Referências oficiais: [publicar funções](https://docs.netlify.com/build/functions/get-started/), [comando deploy](https://cli.netlify.com/commands/deploy/), [agendamento](https://docs.netlify.com/build/functions/scheduled-functions/).
