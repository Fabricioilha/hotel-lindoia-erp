#!/usr/bin/env bash
# Monitoramento preventivo da VM Oracle (RAM, Disco, PocketBase health e tamanho de SQLite).
# Uso recomendado via cron (a cada 5 minutos):
#   */5 * * * * /opt/pocketbase/vm-health-monitor.sh

set -euo pipefail

PB_URL="${PB_URL:-http://127.0.0.1:8090}"
PB_DATA_DIR="${PB_DATA_DIR:-/opt/pocketbase/pb_data}"
LOG_FILE="${LOG_FILE:-/var/log/hotel-erp-health.log}"
RAM_WARN_MIB="${RAM_WARN_MIB:-150}"
RAM_CRIT_MIB="${RAM_CRIT_MIB:-90}"
DISK_WARN_PCT="${DISK_WARN_PCT:-80}"
DISK_CRIT_PCT="${DISK_CRIT_PCT:-90}"
AUX_WARN_MIB="${AUX_WARN_MIB:-500}"

TS="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
STATUS="OK"
ALERTS=()

# 1. RAM disponível (MiB)
MEM_AVAIL_KB="$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)"
MEM_AVAIL_MIB="$(( MEM_AVAIL_KB / 1024 ))"
if (( MEM_AVAIL_MIB < RAM_CRIT_MIB )); then
  STATUS="CRITICAL"
  ALERTS+=("RAM_CRITICAL=${MEM_AVAIL_MIB}MiB<${RAM_CRIT_MIB}MiB")
elif (( MEM_AVAIL_MIB < RAM_WARN_MIB )); then
  [[ "$STATUS" == "OK" ]] && STATUS="WARN"
  ALERTS+=("RAM_WARN=${MEM_AVAIL_MIB}MiB<${RAM_WARN_MIB}MiB")
fi

# 2. Uso de disco na raiz (%)
DISK_PCT="$(df -P / | awk 'NR==2 {gsub("%","",$5); print $5}')"
if (( DISK_PCT >= DISK_CRIT_PCT )); then
  STATUS="CRITICAL"
  ALERTS+=("DISK_CRITICAL=${DISK_PCT}%>=${DISK_CRIT_PCT}%")
elif (( DISK_PCT >= DISK_WARN_PCT )); then
  [[ "$STATUS" == "OK" ]] && STATUS="WARN"
  ALERTS+=("DISK_WARN=${DISK_PCT}%>=${DISK_WARN_PCT}%")
fi

# 3. PocketBase RSS & Healthcheck
PB_PID="$(pgrep -f '/opt/pocketbase/pocketbase serve' | head -n1 || true)"
PB_RSS_MIB=0
if [[ -n "$PB_PID" && -r "/proc/${PB_PID}/status" ]]; then
  PB_RSS_KB="$(awk '/^VmRSS:/ {print $2}' "/proc/${PB_PID}/status")"
  PB_RSS_MIB="$(( PB_RSS_KB / 1024 ))"
fi
if ! curl -sf --max-time 5 "${PB_URL}/api/health" >/dev/null 2>&1; then
  STATUS="CRITICAL"
  ALERTS+=("PB_HEALTH_FAIL")
fi

# 4. Tamanho dos bancos SQLite (data.db e auxiliary.db)
DATA_MIB=0
AUX_MIB=0
if [[ -f "${PB_DATA_DIR}/data.db" ]]; then
  DATA_MIB="$(( $(stat -c%s "${PB_DATA_DIR}/data.db") / 1048576 ))"
fi
if [[ -f "${PB_DATA_DIR}/auxiliary.db" ]]; then
  AUX_MIB="$(( $(stat -c%s "${PB_DATA_DIR}/auxiliary.db") / 1048576 ))"
  if (( AUX_MIB >= AUX_WARN_MIB )); then
    [[ "$STATUS" == "OK" ]] && STATUS="WARN"
    ALERTS+=("AUXILIARY_DB_LARGE=${AUX_MIB}MiB>=${AUX_WARN_MIB}MiB")
  fi
fi

ALERT_STR="${ALERTS[*]:-none}"
LINE="${TS} status=${STATUS} mem_avail_mib=${MEM_AVAIL_MIB} pb_rss_mib=${PB_RSS_MIB} disk_pct=${DISK_PCT} data_db_mib=${DATA_MIB} aux_db_mib=${AUX_MIB} alerts=${ALERT_STR}"

if [[ -w "$(dirname "$LOG_FILE")" ]]; then
  echo "$LINE" >> "$LOG_FILE"
  # Mantém no máximo as últimas 2.000 linhas (~7 dias de coleta a cada 5 min)
  if (( $(wc -l < "$LOG_FILE") > 2500 )); then
    tail -n 2000 "$LOG_FILE" > "${LOG_FILE}.tmp" && mv "${LOG_FILE}.tmp" "$LOG_FILE"
  fi
fi

if [[ "$STATUS" != "OK" ]]; then
  logger -t hotel-erp-monitor -p user.warning "$LINE" || true
  echo "$LINE" >&2
  exit 1
fi
