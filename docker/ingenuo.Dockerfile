# =============================================================================
#  MATERIAL DE LABORATORIO - NO USAR EN PRODUCCION
#  Dockerfile "ingenuo" a proposito, solo para compararlo con
#  docker/api.Dockerfile (scripts/medir-imagenes.sh). Cada linea comete un
#  error comun.
# =============================================================================

# ERROR: ":latest" cambia sin aviso, y es la imagen completa (~1 GB), no alpine.
FROM node:latest

WORKDIR /app

# ERROR: copiar TODO antes de instalar dependencias: cualquier cambio en
# cualquier archivo invalida la cache. Entra tambien assets/ (videos), .git,
# docs... (ver ingenuo.Dockerfile.dockerignore: solo se excluyen las
# credenciales REALES del equipo, para no meterlas en una imagen local).
COPY . .

RUN npm install

# ERROR: secretos en ENV. Quedan grabados en la imagen y se ven con
# "docker history --no-trunc" y "docker inspect". Valores FALSOS.
ENV JWT_SECRET="secreto-de-ejemplo-NO-USAR-0123456789abcdef" \
    CSRF_SECRET="secreto-de-ejemplo-NO-USAR-fedcba9876543210" \
    FIREBASE_API_KEY="secreto-de-ejemplo-NO-USAR"

# ERROR: sin USER -> corre como root.
EXPOSE 3000

# ERROR: forma shell -> /bin/sh es el PID 1 y no reenvia SIGTERM.
CMD node server.js
