# PocketBase local

O executável do PocketBase e o diretório `pb_data` ficam fora deste repositório.
Mantenha os dados locais e o arquivo de backup fora do controle de versão.

## Iniciar a instância local

1. Pare a instância atual com `Ctrl+C` no terminal em que ela está rodando.
2. Inicie o mesmo diretório de dados com as migrações e hooks do projeto:

   ```sh
   cd /home/fabricio/Downloads/pocketbase_0.41.1_linux_amd64
   ./pocketbase serve \
     --http=127.0.0.1:8090 \
     --dir=/home/fabricio/Downloads/pocketbase_0.41.1_linux_amd64/pb_data \
     --migrationsDir=/home/fabricio/Downloads/hotel-lindoia-erp/pocketbase/pb_migrations \
     --hooksDir=/home/fabricio/Downloads/hotel-lindoia-erp/pocketbase/pb_hooks
   ```

> Iniciar apenas com `./pocketbase serve` não carrega os hooks: a rota
> `/api/hotel/me` retorna 404 e o login do ERP falha. Use sempre o comando acima.

As migrações criam `hotel_state` e mantêm a coleção de staging anterior como
`migration_staging`, sem apagá-la. A coleção operacional não permite acesso
REST direto; os hooks fornecem autenticação, autorização por papel e gravação
transacional.

## Pré-visualizar e importar o backup

Na raiz do repositório, valide o arquivo sem enviar dados:

```sh
node scripts/pocketbase-import-backup.mjs
```

O importador lê exclusivamente os ramos de `erp_geral`; contas, senhas e papéis
não são importados. Para gravar, altere primeiro a senha compartilhada
anteriormente e use credenciais locais do superusuário:

```sh
export POCKETBASE_URL=http://127.0.0.1:8090
read -rp 'E-mail do superusuário PocketBase: ' POCKETBASE_SUPERUSER_EMAIL
read -rsp 'Senha do superusuário PocketBase: ' POCKETBASE_SUPERUSER_PASSWORD
printf '\n'
export POCKETBASE_SUPERUSER_EMAIL POCKETBASE_SUPERUSER_PASSWORD
node scripts/pocketbase-import-backup.mjs --apply
unset POCKETBASE_SUPERUSER_EMAIL POCKETBASE_SUPERUSER_PASSWORD
```

Confirme digitando `IMPORTAR`. O importador rejeita URLs que não sejam loopback,
registra o SHA-256 da origem, permite retomar uma importação interrompida do
mesmo arquivo e não sobrescreve registros de outra origem. Não aponte o
importador para uma base pública.

## Executar o aplicativo

Em outro terminal:

```sh
cd /home/fabricio/Downloads/hotel-lindoia-erp
export VITE_POCKETBASE_URL=http://127.0.0.1:8090
npm run dev:cloudflare
```

O endereço é injetado no frontend apenas para conectar ao serviço local. Para a API local do Worker, configure `POCKETBASE_URL`,
`POCKETBASE_SUPERUSER_EMAIL` e `POCKETBASE_SUPERUSER_PASSWORD` em `.dev.vars`
na raiz do ERP, usando a instância de testes. Nunca coloque credenciais no
código, nos arquivos servidos pelo navegador ou no repositório.

Antes de validar a operação:

1. No painel administrativo do PocketBase, crie uma conta por pessoa na coleção
   de autenticação `users`.
2. Na coleção privada `user_roles`, crie um registro com o ID da conta no campo
   `user` e selecione `admin` ou `viewer` no campo `role`.
3. Entre no ERP com as contas de teste e valide as permissões de cada perfil.

As contas e papéis anteriores não são migrados. Mantenha o backup original
intacto até validar os dados e os fluxos do aplicativo.

## Servidor na Oracle Cloud

O PocketBase 0.41.1 roda na VM como o serviço `pocketbase` (systemd), em
`/opt/pocketbase`, servido em `https://137-131-244-154.sslip.io` com certificado
Let's Encrypt emitido pelo próprio PocketBase. O IP público (137.131.244.154) é
reservado na Oracle e deve permanecer associado à VM; se mudar, o domínio
`sslip.io` (`<ip com hífens>.sslip.io`) e as variáveis da Cloudflare precisam mudar junto. Requer ingress TCP 80 e 443 na
Security List da VCN (a tela de ingress da Oracle) e liberação equivalente no
firewall da VM.

- Logs: `sudo journalctl -u pocketbase -f`
- Reiniciar: `sudo systemctl restart pocketbase`
- Atualizar hooks/migrações: copiar `pocketbase/pb_hooks` e `pocketbase/pb_migrations`
  para `/opt/pocketbase/` (dono `pocketbase`) e reiniciar o serviço.
- Backup automático: diário às 03:00 UTC, mantendo os 14 mais recentes em
  `/opt/pocketbase/pb_data/backups` (Settings > Backups no painel). Baixe cópias
  periodicamente para fora da VM.

Para o aplicativo usar este servidor:

```sh
export VITE_POCKETBASE_URL=https://137-131-244-154.sslip.io
```

Na Cloudflare, defina `VITE_POCKETBASE_URL` no build e `POCKETBASE_URL`
no runtime com o mesmo endereço. Configure `POCKETBASE_SUPERUSER_EMAIL` e
`POCKETBASE_SUPERUSER_PASSWORD` como secrets de runtime, conforme
[Publicação na Cloudflare](../docs/publicar-cloudflare.md). Nunca versione chaves SSH (`*.key`).
