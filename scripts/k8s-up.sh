#!/usr/bin/env bash
# Levanta WayTure en Kubernetes (kind) desde cero, en orden:
#   1. cluster  2. secretos locales  3. imagenes  4. carga en kind
#   5. namespace + Secret  6. kubectl apply -f k8s/  7. espera rollout
# Idempotente. Uso:
#   bash scripts/k8s-up.sh
#   USE_FIREBASE_REST=false bash scripts/k8s-up.sh   # modo local (sin Firestore)
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
cd "$RAIZ"
export MSYS_NO_PATHCONV=1   # Git Bash: no convertir rutas tipo /run/...

CLUSTER=waytur
NS=waytur
# --context explicito: nunca tocar otro cluster que este como actual.
K="kubectl --context kind-$CLUSTER"

paso() { printf '\n==> %s\n' "$*"; }

paso "1/7 Cluster kind '$CLUSTER'"
if kind get clusters 2>/dev/null | grep -qx "$CLUSTER"; then
  echo "ya existe"
else
  kind create cluster --config k8s/kind/kind-waytur.yaml
fi

paso "2/7 Secretos locales"
bash scripts/generar-secretos.sh
[ -s secrets/firebase_api_key.txt ] || { echo "Falta secrets/firebase_api_key.txt" >&2; exit 1; }

paso "3/7 Construyendo imagenes"
docker build -q -f docker/api.Dockerfile --build-arg APP_VERSION=1.0 -t waytur-api:1.0 .
# Mismo codigo, otra version en /quien: para el rolling update y el rollback.
docker build -q -f docker/api.Dockerfile --build-arg APP_VERSION=1.1 -t waytur-api:1.1 .
docker build -q -f docker/web.Dockerfile -t waytur-web:1.0 .

paso "4/7 Cargando imagenes en los nodos"
# Las imagenes propias no estan en ningun registro: se copian a cada nodo
# (por eso imagePullPolicy: IfNotPresent en los manifiestos).
kind load docker-image --name "$CLUSTER" waytur-api:1.0 waytur-api:1.1 waytur-web:1.0
# Redis: si no se puede precargar, los nodos la descargan de Docker Hub.
docker image inspect redis:7.4.6-alpine >/dev/null 2>&1 || docker pull -q redis:7.4.6-alpine
kind load docker-image --name "$CLUSTER" redis:7.4.6-alpine >/dev/null 2>&1 \
  || echo "aviso: no se pudo precargar redis; los nodos la descargaran"

paso "5/7 Namespace y Secret"
$K apply -f k8s/00-namespace.yaml
# El Secret NO esta en k8s/ (seria subir credenciales a Git): se crea desde
# secrets/. "--dry-run=client -o yaml | apply" = crear o actualizar.
# Ningun valor se imprime.
$K -n "$NS" create secret generic waytur-secretos \
  --from-file=jwt_secret=secrets/jwt_secret.txt \
  --from-file=csrf_secret=secrets/csrf_secret.txt \
  --from-file=firebase_api_key=secrets/firebase_api_key.txt \
  --from-file=redis_password=secrets/redis_password.txt \
  --from-file=firebase_service_email=secrets/firebase_service_email.txt \
  --from-file=firebase_service_password=secrets/firebase_service_password.txt \
  --dry-run=client -o yaml | $K apply -f - >/dev/null
echo "secret/waytur-secretos aplicado"

paso "6/7 kubectl apply -f k8s/"
$K apply -f k8s/
if [ -n "${USE_FIREBASE_REST:-}" ]; then
  # Cambia solo esa clave del ConfigMap y reinicia la API para que la tome.
  $K -n "$NS" patch configmap api-config --type merge -p "{\"data\":{\"USE_FIREBASE_REST\":\"$USE_FIREBASE_REST\"}}"
  $K -n "$NS" rollout restart deployment/api
fi

paso "7/7 Esperando a que todo este listo"
$K -n "$NS" rollout status deployment/redis --timeout=120s
$K -n "$NS" rollout status deployment/api --timeout=300s
$K -n "$NS" rollout status deployment/web --timeout=120s
$K -n "$NS" get pods -o wide

cat <<FIN

Listo:  http://localhost:8082   (/health, /quien, /api/...)
Prueba: BASE_URL=http://localhost:8082 node scripts/smoke-jwt.mjs
Bajar:  bash scripts/k8s-down.sh
FIN
