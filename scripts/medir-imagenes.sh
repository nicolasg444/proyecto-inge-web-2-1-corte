#!/usr/bin/env bash
# Compara la imagen ingenua (docker/ingenuo.Dockerfile) con la optimizada
# (docker/api.Dockerfile) e imprime una tabla Markdown para el informe.
# Uso: bash scripts/medir-imagenes.sh   (Linux, WSL o Git Bash)
set -euo pipefail
RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
export MSYS_NO_PATHCONV=1   # Git Bash: no convertir rutas como /app

ING="waytur-api:ingenua"
OPT="waytur-api:1.0"
CAMBIO="js/_medicion_tmp.js"
trap 'rm -f "$CAMBIO"' EXIT

ahora_ms() { echo $(( $(date +%s%N) / 1000000 )); }
construir() { docker build -q -f "$1" -t "$2" . >/dev/null; }

echo ">> Construccion inicial (calienta la cache)..." >&2
construir docker/ingenuo.Dockerfile "$ING"
construir docker/api.Dockerfile "$OPT"

echo ">> Reconstruccion tras modificar un archivo de codigo..." >&2
medir() {
  echo "// cambio $(date +%s%N)" > "$CAMBIO"
  local t0; t0=$(ahora_ms); construir "$1" "$2"; echo $(( $(ahora_ms) - t0 ))
}
T_ING=$(medir docker/ingenuo.Dockerfile "$ING")
T_OPT=$(medir docker/api.Dockerfile "$OPT")
rm -f "$CAMBIO"
construir docker/api.Dockerfile "$OPT"
construir docker/ingenuo.Dockerfile "$ING"

tamano()  { docker image ls "$1" --format '{{.Size}}' | head -1; }
capas()   { docker history -q "$1" | wc -l | tr -d ' '; }
usuario() { docker run --rm --entrypoint whoami "$1" 2>/dev/null || echo "?"; }
secreto() {
  # Solo SI/NO: nunca se imprime lo encontrado.
  if docker history --no-trunc "$1" | grep -qiE "secret|password|api_key|token"; then echo "SI (visible)"; else echo "NO"; fi
}
seg() { awk -v ms="$1" 'BEGIN { printf "%.1f s", ms/1000 }'; }

echo
echo "| Metrica | Ingenua (\`$ING\`) | Optimizada (\`$OPT\`) |"
echo "|---|---|---|"
echo "| Tamano | $(tamano "$ING") | $(tamano "$OPT") |"
echo "| Capas (docker history) | $(capas "$ING") | $(capas "$OPT") |"
echo "| Usuario (whoami) | $(usuario "$ING") | $(usuario "$OPT") |"
echo "| Reconstruccion tras tocar codigo | $(seg "$T_ING") | $(seg "$T_OPT") |"
echo "| Secreto en docker history --no-trunc | $(secreto "$ING") | $(secreto "$OPT") |"
echo
echo "Nota: los secretos de la imagen ingenua son FALSOS (secreto-de-ejemplo-NO-USAR)."
