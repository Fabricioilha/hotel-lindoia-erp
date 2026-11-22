#!/usr/bin/env bash
# Backup oficial off-VM do PocketBase (via API /api/backups — NUNCA copia pb_data a quente).
# Verifica SHA-256, testa restauração SQLite (PRAGMA integrity_check) e aplica retenção local.
#
# Exemplo de uso:
#   POCKETBASE_URL="https://137-131-244-154.sslip.io" \
#   POCKETBASE_SUPERUSER_EMAIL="..." \
#   POCKETBASE_SUPERUSER_PASSWORD="..." \
#   BACKUP_OUT_DIR="$HOME/hotel-lindoia-backups" \
#   bash scripts/vm-offsite-backup.sh

set -euo pipefail

PB_URL="${POCKETBASE_URL:-https://137-131-244-154.sslip.io}"
EMAIL="${POCKETBASE_SUPERUSER_EMAIL:?Defina POCKETBASE_SUPERUSER_EMAIL}"
PASSWORD="${POCKETBASE_SUPERUSER_PASSWORD:?Defina POCKETBASE_SUPERUSER_PASSWORD}"
OUT_DIR="${BACKUP_OUT_DIR:-./offsite-backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
BACKUP_NAME="offsite_$(date -u +%Y%m%d_%H%M%S).zip"

mkdir -p "$OUT_DIR"

echo "[offsite-backup] Autenticando superusuário em ${PB_URL}..."
TOKEN="$(curl -sf -X POST "${PB_URL}/api/collections/_superusers/auth-with-password" \
  -H "Content-Type: application/json" \
  -H "X-ERP-Schema-Version: 2" \
  -d "{\"identity\":\"${EMAIL}\",\"password\":\"${PASSWORD}\"}" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")"

echo "[offsite-backup] Criando backup oficial no servidor: ${BACKUP_NAME}..."
curl -sf -X POST "${PB_URL}/api/backups" \
  -H "Authorization: ${TOKEN}" \
  -H "Content-Type: application/json" \
  -H "X-ERP-Schema-Version: 2" \
  -d "{\"name\":\"${BACKUP_NAME}\"}" >/dev/null

echo "[offsite-backup] Gerando token de download temporário..."
FILE_TOKEN="$(curl -sf -X POST "${PB_URL}/api/files/token" \
  -H "Authorization: ${TOKEN}" \
  -H "X-ERP-Schema-Version: 2" \
  | python3 -c "import sys,json; print(json.load(sys.stdin)['token'])")"

DEST="${OUT_DIR}/${BACKUP_NAME}"
echo "[offsite-backup] Baixando para ${DEST}..."
curl -sfL "${PB_URL}/api/backups/${BACKUP_NAME}?token=${FILE_TOKEN}" -o "$DEST"

sha256sum "$DEST" > "${DEST}.sha256"

# Validação de integridade do ZIP e SQLite data.db em diretório temporário isolado
TMP_CHECK="$(mktemp -d)"
trap 'rm -rf "$TMP_CHECK"' EXIT
unzip -q "$DEST" data.db -d "$TMP_CHECK"
INTEGRITY="$(python3 -c "import sqlite3,sys; c=sqlite3.connect(f'file:{sys.argv[1]}?mode=ro',uri=True); print(c.execute('PRAGMA integrity_check;').fetchone()[0])" "${TMP_CHECK}/data.db")"
if [[ "$INTEGRITY" != "ok" ]]; then
  echo "[offsite-backup] ERRO: data.db falhou no PRAGMA integrity_check: ${INTEGRITY}" >&2
  exit 1
fi

# Retenção local
find "$OUT_DIR" -type f \( -name 'offsite_*.zip' -o -name 'offsite_*.zip.sha256' \) -mtime "+${RETENTION_DAYS}" -delete

echo "[offsite-backup] Concluído e verificado (PRAGMA integrity_check=ok): ${DEST} ($(du -h "$DEST" | cut -f1))"
