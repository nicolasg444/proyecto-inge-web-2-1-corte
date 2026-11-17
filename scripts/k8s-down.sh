#!/usr/bin/env bash
# Elimina el cluster kind completo (pods, volumenes de MySQL incluidos).
# No toca otros clusters ni las imagenes locales de Docker.
set -euo pipefail
kind delete cluster --name waytur
