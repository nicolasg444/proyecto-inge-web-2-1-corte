#!/usr/bin/env bash
# Genera los secretos en secrets/ (ignorado por Git). Nunca imprime valores
# y NO sobrescribe archivos existentes.
# Uso: bash scripts/generar-secretos.sh
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/.." && pwd)"
DIR="$RAIZ/secrets"
command -v openssl >/dev/null || { echo "Falta openssl" >&2; exit 1; }

# 700: otros usuarios del anfitrion no pueden ni listar la carpeta.
mkdir -p "$DIR"; chmod 700 "$DIR" 2>/dev/null || true

guardar() { # $1=archivo; el valor llega por stdin
  # 644 y no 600: los secretos de Compose (sin Swarm) son bind mounts que
  # conservan el dueno del anfitrion, y el proceso del contenedor (UID 10001)
  # necesita leerlos. La carpeta 700 protege de otros usuarios del anfitrion.
  cat > "$DIR/$1"; chmod 644 "$DIR/$1" 2>/dev/null || true
}

aleatorio() { # $1=archivo $2=bytes
  if [ -s "$DIR/$1" ]; then echo "  = $1 ya existe (no se toca)"; return; fi
  # Hexadecimal: sin caracteres que rompan shells, URLs o YAML.
  printf '%s' "$(openssl rand -hex "$2")" | guardar "$1"
  echo "  + $1 generado"
}

echo "Secretos en $DIR:"
aleatorio jwt_secret.txt 32        # 64 caracteres (>= 32 exigidos)
aleatorio csrf_secret.txt 32       # distinto de jwt_secret (lo exige config.js)
aleatorio redis_password.txt 24

# API key WEB de Firebase: no es secreta por diseno (el navegador la recibe en
# js/firebase-config.js), pero el servidor la lee como secreto para no dejarla
# fija en su codigo. Se toma de la configuracion web del propio proyecto.
if [ -s "$DIR/firebase_api_key.txt" ]; then
  echo "  = firebase_api_key.txt ya existe (no se toca)"
else
  CLAVE="$(grep -oE 'apiKey:[[:space:]]*"[^"]+"' "$RAIZ/js/firebase-config.js" 2>/dev/null | sed -E 's/.*"([^"]+)"/\1/' || true)"
  if [ -n "$CLAVE" ]; then
    printf '%s' "$CLAVE" | guardar firebase_api_key.txt
    echo "  + firebase_api_key.txt copiado de js/firebase-config.js (clave web publica)"
  else
    echo "  ! Falta secrets/firebase_api_key.txt: pega ahi la API key web de Firebase"
    echo "    (Consola de Firebase > Configuracion del proyecto > Tus apps > apiKey)"
  fi
fi
unset CLAVE

# Usuario "servicio" de Firebase (opcional, ver docs/firestore-reglas.md).
# Se crean VACIOS: Compose exige que el archivo exista, y config.js trata un
# archivo vacio como "no configurado". El equipo pega aqui email y contrasena
# de la cuenta de servicio cuando la cree en la consola de Firebase.
for f in firebase_service_email.txt firebase_service_password.txt; do
  [ -e "$DIR/$f" ] || { : | guardar "$f"; echo "  + $f creado VACIO (opcional)"; }
done
echo "Listo. secrets/ NO se versiona (ver .gitignore)."
