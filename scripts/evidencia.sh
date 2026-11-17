#!/usr/bin/env bash
# Guarda la evidencia de la entrega en docs/evidencia/ (texto plano).
# Ninguna salida contiene valores de secretos: al final se verifica buscando
# cada valor real de secrets/*.txt dentro de los archivos generados.
#
# Uso: scripts/evidencia.sh
#   COMPOSE_URL (por defecto http://localhost:${WEB_PORT:-8080})
#   K8S_URL     (por defecto http://localhost:8082)
#   MEDIR=0     omite la medicion ingenua vs optimizada (tarda ~1 min)
set -uo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
export MSYS_NO_PATHCONV=1
OUT="docs/evidencia"
mkdir -p "$OUT"
COMPOSE_URL="${COMPOSE_URL:-http://localhost:${WEB_PORT:-8080}}"
K8S_URL="${K8S_URL:-http://localhost:8082}"
KC="kubectl --context kind-waytur"

encabezado() { echo "# $1"; echo "# Generado: $(date '+%Y-%m-%d %H:%M:%S')"; echo; }

# Valores reales de los secretos (solo en memoria, nunca se imprimen).
SECRETOS=()
# firebase_api_key.txt se excluye: es la clave WEB publica (va en
# js/firebase-config.js por diseno), no un secreto.
for f in secrets/*.txt; do
  case "$f" in *firebase_api_key.txt) continue ;; esac
  [ -s "$f" ] && SECRETOS+=("$(cat "$f")")
done

echo "1) Docker Compose"
{
  encabezado "docker compose ps"
  docker compose -f compose.yaml ps -a 2>&1 || echo "(Compose no esta levantado)"
} > "$OUT/01-compose-ps.txt"

{
  encabezado "docker image ls (imagenes del proyecto)"
  docker image ls --format 'table {{.Repository}}:{{.Tag}}\t{{.Size}}\t{{.CreatedSince}}' | grep -E "REPOSITORY|waytur"
} > "$OUT/02-imagenes.txt"

if [ "${MEDIR:-1}" = "1" ]; then
  echo "2) Medicion ingenua vs optimizada"
  # A un temporal fuera del repo: la imagen ingenua hace "COPY . ." y no
  # debe ver un archivo que cambia mientras se construye.
  TMP_MED="$(mktemp)"
  { encabezado "Imagen ingenua vs optimizada"; bash scripts/medir-imagenes.sh 2>&1; } > "$TMP_MED"
  mv "$TMP_MED" "$OUT/03-medicion.md"
fi

echo "3) Auditoria de secretos"
{
  encabezado "Auditoria de secretos"
  echo "## Coincidencias de palabras clave en el historial (archivo: cantidad)"
  echo "## Son NOMBRES de variables y codigo (DB_PASSWORD_FILE, hash de contrasenas...),"
  echo "## no valores. Ver la busqueda de valores reales mas abajo."
  for c in $(git rev-list --all); do
    git grep -IciE "password|secret|token" "$c" -- . ':!package-lock.json' ':!react-widget/package-lock.json' ':!react-widget/dist' 2>/dev/null
  done | sed -E 's/^[0-9a-f]+://' | awk -F: '{max[$1] = ($2 > max[$1] ? $2 : max[$1])} END {for (f in max) print "  " f ": " max[f]}' | sort
  echo
  echo "## Archivos sensibles versionados (git ls-files | grep .env$ / secrets/)"
  git ls-files | grep -E '(^|/)\.env$|(^|/)secrets/' || echo "  ninguno"
  echo
  echo "## .gitignore cubre los archivos sensibles (git check-ignore -v)"
  git check-ignore -v .env secrets/jwt_secret.txt .smoke.env data/wayture-api.json 2>&1 | sed 's/^/  /'
  echo
  echo "## Valores REALES de secrets/*.txt buscados en todo el historial de Git"
  n=0
  for v in "${SECRETOS[@]}"; do
    git log -p --all | grep -qF "$v" && n=$((n + 1))
  done
  echo "  secretos encontrados en el historial: $n de ${#SECRETOS[@]}"
  echo
  echo "## ... en el arbol de trabajo versionado (git grep)"
  n=0
  for v in "${SECRETOS[@]}"; do git grep -qF "$v" && n=$((n + 1)); done
  echo "  secretos encontrados en archivos versionados: $n de ${#SECRETOS[@]}"
  echo
  echo "## docker history --no-trunc de las imagenes del proyecto"
  for img in waytur-api:1.0 waytur-api:1.1 waytur-web:1.0; do
    docker image inspect "$img" >/dev/null 2>&1 || continue
    palabras=$(docker history --no-trunc "$img" | grep -ciE "password|token|secret")
    valores=0
    for v in "${SECRETOS[@]}"; do docker history --no-trunc "$img" | grep -qF "$v" && valores=$((valores + 1)); done
    echo "  $img: lineas con password/token/secret=$palabras, valores reales=$valores"
  done
  echo
  echo "## docker inspect Config.Env de los contenedores en ejecucion"
  for c in $(docker compose -f compose.yaml ps -q 2>/dev/null); do
    nombre=$(docker inspect -f '{{.Name}}' "$c")
    valores=0
    for v in "${SECRETOS[@]}"; do docker inspect "$c" | grep -qF "$v" && valores=$((valores + 1)); done
    echo "  $nombre: valores reales en inspect=$valores; variables de secretos:"
    docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$c" | grep -iE "secret|password" | sed 's/^/      /'
  done
} > "$OUT/04-auditoria-secretos.txt"

echo "4) Kubernetes"
if $KC get ns waytur >/dev/null 2>&1; then
  {
    encabezado "kubectl get deploy,rs,pods,svc,pdb -o wide"
    $KC -n waytur get deploy,rs,pods,svc,pdb -o wide
    echo
    echo "## Clase QoS por pod"
    $KC -n waytur get pods -o custom-columns='POD:.metadata.name,QOS:.status.qosClass,NODO:.spec.nodeName'
    echo
    echo "## Historial de despliegues de la API"
    $KC -n waytur rollout history deployment/api
    echo
    echo "## Secret: describe muestra solo claves y tamanos, nunca valores"
    $KC -n waytur describe secret waytur-secretos | sed -n '/^Data/,$p'
    echo
    echo "## Configuracion de la API (ConfigMap): los secretos aparecen solo como rutas *_FILE"
    $KC -n waytur get configmap api-config -o go-template='{{range $k, $v := .data}}{{$k}}={{$v}}{{"\n"}}{{end}}' | grep -E "_FILE="
  } > "$OUT/05-kubernetes.txt"
else
  echo "(cluster kind-waytur no disponible)" > "$OUT/05-kubernetes.txt"
fi

echo "5) Smoke tests"
for destino in "compose $COMPOSE_URL" "k8s $K8S_URL"; do
  set -- $destino
  # Redireccion del shell y no "curl -o /dev/null": en Git Bash, con
  # MSYS_NO_PATHCONV=1, el curl de Windows no entiende /dev/null.
  if curl -s -m 3 "$2/health" >/dev/null; then
    { encabezado "smoke-jwt.mjs contra $2 ($1)"; BASE_URL="$2" node scripts/smoke-jwt.mjs 2>&1; } > "$OUT/06-smoke-$1.txt"
  else
    echo "($1 no responde en $2)" > "$OUT/06-smoke-$1.txt"
  fi
done

echo "6) Verificacion: ningun archivo de evidencia contiene un secreto"
fuga=0
for v in "${SECRETOS[@]}"; do
  if grep -rqF "$v" "$OUT"; then fuga=1; fi
done
if [ "$fuga" = "1" ]; then
  echo "ERROR: un archivo de evidencia contiene un valor secreto; se borra $OUT" >&2
  rm -rf "$OUT"
  exit 1
fi
echo "OK. Evidencia en $OUT/:"
ls -1 "$OUT"
