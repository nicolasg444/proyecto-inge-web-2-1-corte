#!/usr/bin/env bash
# Demostracion de rolling update sin caidas: lanza el vigia, cambia la
# imagen de la API (por defecto 1.0 -> 1.1), espera el rollout y cuenta las
# lineas FALLO. Con "undo" hace el rollback.
# Uso: scripts/k8s-rolling.sh [1.1|1.0|undo]
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
K="kubectl --context kind-waytur -n waytur"
DESTINO="${1:-1.1}"
LOG="$(mktemp)"

bash "$RAIZ/scripts/vigia.sh" http://localhost:8082/quien 0.1 > "$LOG" &
VIGIA=$!
sleep 2

if [ "$DESTINO" = "undo" ]; then
  echo "==> kubectl rollout undo deployment/api"
  $K rollout undo deployment/api
else
  echo "==> kubectl set image deployment/api api=waytur-api:$DESTINO"
  $K set image deployment/api api="waytur-api:$DESTINO"
fi
$K rollout status deployment/api --timeout=300s
sleep 3
kill -TERM "$VIGIA" 2>/dev/null || true
wait "$VIGIA" 2>/dev/null || true

echo
echo "Versiones vistas durante la actualizacion:"
grep -oE '"version": *"[^"]*"' "$LOG" | tr -d ' ' | sort | uniq -c || true
echo "Peticiones OK:    $(grep -c ' OK ' "$LOG" || true)"
echo "Peticiones FALLO: $(grep -c "FALLO codigo=" "$LOG" || true)"
grep -B2 -A2 "FALLO codigo=" "$LOG" || true
$K rollout history deployment/api | tail -4
rm -f "$LOG"
