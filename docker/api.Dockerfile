# syntax=docker/dockerfile:1
# ^ Fija la sintaxis del Dockerfile (BuildKit).

# Imagen de la API WayTure (Node, modulo http nativo).
#   docker build -f docker/api.Dockerfile -t waytur-api:1.0 .
#   docker build -f docker/api.Dockerfile --target test .   <- solo pruebas
# Contexto = raiz del repo; lo que entra lo decide la lista blanca de
# docker/api.Dockerfile.dockerignore.

# Version FIJA (nunca :latest). Alpine: Node no necesita glibc y la imagen
# queda en ~50 MB de base.
ARG NODE_VERSION=22.21.1

# ---------------------------------------------------------------------------
# Etapa 1: deps -> solo dependencias de produccion
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine3.22 AS deps
WORKDIR /app
# Primero SOLO los manifiestos: mientras no cambien las dependencias, esta
# capa sale de cache aunque cambie el codigo.
COPY package.json package-lock.json ./
# npm ci: instala exactamente lo del lockfile (build reproducible).
# --omit=dev: sin herramientas de desarrollo. mkdir: si no hay dependencias,
# npm no crea node_modules y el COPY de la etapa final fallaria.
RUN npm ci --omit=dev --no-audit --no-fund && mkdir -p node_modules

# ---------------------------------------------------------------------------
# Etapa 2: test -> ejecuta las pruebas (node:test). No llega a runtime.
# ---------------------------------------------------------------------------
FROM deps AS test
COPY config.js cache.js firebase-rest.js server.js index.html ./
COPY js/ js/
COPY tests/ tests/
# Si una prueba falla, el build falla.
RUN npm test

# ---------------------------------------------------------------------------
# Etapa 3: runtime -> imagen final minima
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine3.22 AS runtime

# Version que reporta /quien: docker build --build-arg APP_VERSION=1.1 ...
ARG APP_VERSION=1.0

# NODE_ENV=production: librerias en modo produccion.
# PORT 8000 dentro del contenedor (3000 sigue siendo el de "npm start").
# DATA_DIR: respaldo JSON en un volumen, porque la raiz sera de solo lectura.
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    PORT=8000 \
    HOST=0.0.0.0 \
    DATA_DIR=/data

# Usuario y grupo sin privilegios con UID/GID fijo 10001 (Kubernetes lo
# verifica con runAsUser: 10001). Sin shell de login ni home.
# El directorio de datos se crea ANTES de declararlo volumen y con dueno
# "app": un volumen nuevo copia ese dueno y la app puede escribir en el.
RUN addgroup -S -g 10001 app \
 && adduser -S -D -H -u 10001 -G app -s /sbin/nologin app \
 && mkdir -p /data \
 && chown app:app /data

WORKDIR /app

# Solo node_modules de produccion y el codigo del servidor. Los archivos
# quedan propiedad de root (sin --chown): si alguien explota la app como
# "app", no puede modificar el codigo que se ejecuta.
COPY --from=deps /app/node_modules ./node_modules
COPY package.json config.js cache.js firebase-rest.js server.js ./
# El servidor reutiliza la logica de simulacion de viajes del frontend.
COPY js/trip-simulation.js js/trip-simulation.js

# Documental: quien publica puertos es Compose/K8s.
EXPOSE 8000

USER app

# Healthcheck con el propio Node (fetch nativo; no hace falta curl).
# /health no consulta Firebase ni Redis.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:8000/health').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]

# Forma exec: node es el PID 1 y recibe SIGTERM directamente (apagado
# ordenado en server.js). En forma shell, /bin/sh seria el PID 1 y no
# reenviaria la senal: Docker mataria el proceso a los 10 s.
CMD ["node", "server.js"]
