# syntax=docker/dockerfile:1

# Imagen web: estaticos de WayTure servidos por Nginx sin privilegios.
#   docker build -f docker/web.Dockerfile -t waytur-web:1.0 .
# Sin etapa de build: el frontend es HTML/CSS/JS plano y el widget React ya
# viene compilado en react-widget/dist (se versiona asi en el repo).
# Contexto = raiz; la lista blanca de docker/web.Dockerfile.dockerignore deja
# entrar SOLO lo publico.

# Version FIJA. nginx-unprivileged corre como usuario nginx (UID 101) y
# escucha en 8080; la imagen "nginx" oficial arranca como root para el 80.
ARG NGINX_VERSION=1.30.0
FROM nginxinc/nginx-unprivileged:${NGINX_VERSION}-alpine

# Configuracion (propiedad de root, solo lectura para nginx).
COPY docker/nginx/default.conf /etc/nginx/conf.d/default.conf
COPY docker/nginx/security-headers.conf docker/nginx/proxy-api.conf /etc/nginx/snippets/

# Solo archivos publicos. Ningun secreto: la config web de Firebase
# (js/firebase-config.js) es publica por diseno.
COPY *.html /usr/share/nginx/html/
COPY css/ /usr/share/nginx/html/css/
COPY js/ /usr/share/nginx/html/js/
COPY assets/ /usr/share/nginx/html/assets/
COPY react-widget/dist/ /usr/share/nginx/html/react-widget/dist/

EXPOSE 8080

# wget viene en BusyBox (Alpine).
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/salud-web"]
