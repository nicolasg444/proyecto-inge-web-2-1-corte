#!/usr/bin/env bash
# Vigia: hace una peticion cada INTERVALO segundos e imprime una linea por
# respuesta (OK o FALLO). Para demostrar que un rolling update o un drain no
# corta el servicio. Ctrl+C muestra el resumen.
# Uso: scripts/vigia.sh [URL] [INTERVALO]
#      scripts/vigia.sh http://localhost:8082/quien 0.2
URL="${1:-http://localhost:8082/quien}"
INTERVALO="${2:-0.2}"
ok=0; fallo=0
resumen() { echo; echo "RESUMEN: OK=$ok FALLO=$fallo"; exit 0; }
trap resumen INT TERM
while true; do
  # tr: la API devuelve JSON con formato (varias lineas); se deja en una.
  cuerpo=$(curl -s -m 2 -w ' %{http_code}' "$URL" 2>/dev/null | tr -s ' \n' ' ')
  codigo="${cuerpo##* }"
  if [ "$codigo" = "200" ]; then
    ok=$((ok + 1)); echo "$(date +%T) OK    ${cuerpo% *}"
  else
    fallo=$((fallo + 1)); echo "$(date +%T) FALLO codigo=$codigo"
  fi
  sleep "$INTERVALO"
done
