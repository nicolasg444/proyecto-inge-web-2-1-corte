// config.js
// Configuracion central del servidor WayTure.
//
// - SECRETOS: leerSecreto(NOMBRE) busca primero NOMBRE_FILE (ruta a un
//   archivo, p. ej. /run/secrets/jwt_secret, que es como Docker Compose y
//   Kubernetes entregan los secretos) y si no existe usa la variable NOMBRE.
//   Si falta, la app NO arranca: fallar rapido es intencional. Un secreto con
//   valor por defecto es un secreto publico (los antiguos valores por defecto
//   estan en el historial de Git y se rechazan).
// - CONFIGURACION NO SECRETA: valores por defecto compatibles con hoy.
// - Nunca se imprime el valor de un secreto, ni siquiera en los errores.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Valores que estuvieron escritos en server.js (publicos en Git): se rechazan.
const SECRETOS_PUBLICOS = new Set([
  "wayture-dev-secret-change-me",
  "wayture-csrf-dev-secret"
]);

export class ErrorConfiguracion extends Error {}

export function leerSecreto(nombre, { minLargo = 1, opcional = false } = {}) {
  const ruta = process.env[`${nombre}_FILE`];
  let valor = "";
  if (ruta) {
    try {
      // trim(): quita el salto de linea final que dejan editores y "echo".
      valor = readFileSync(ruta, "utf8").trim();
    } catch (error) {
      throw new ErrorConfiguracion(`No se pudo leer ${nombre}_FILE (${error.code})`);
    }
  } else {
    valor = String(process.env[nombre] || "").trim();
  }

  if (!valor) {
    if (opcional) return null;
    throw new ErrorConfiguracion(
      `Falta el secreto ${nombre}: define ${nombre}_FILE (ruta a un archivo) o ${nombre}`
    );
  }
  if (valor.length < minLargo) {
    throw new ErrorConfiguracion(`El secreto ${nombre} debe tener al menos ${minLargo} caracteres`);
  }
  if (SECRETOS_PUBLICOS.has(valor)) {
    throw new ErrorConfiguracion(
      `El secreto ${nombre} usa un valor de ejemplo publico; genera uno nuevo (scripts/generar-secretos.sh)`
    );
  }
  return valor;
}

function booleano(nombre, porDefecto) {
  const valor = String(process.env[nombre] ?? "").trim().toLowerCase();
  if (!valor) return porDefecto;
  return valor === "true" || valor === "1";
}

const config = {
  // --- Red ---------------------------------------------------------------
  // 3000 = el puerto de siempre en "npm start". En contenedores se usa 8000.
  port: Number(process.env.PORT || 3000),
  // 0.0.0.0: dentro de un contenedor hay que escuchar en todas las interfaces.
  host: process.env.HOST || "0.0.0.0",

  // --- Datos -------------------------------------------------------------
  // Respaldo JSON (modo degradado si Firestore no responde). Configurable
  // para montar un volumen escribible con el sistema de archivos de solo
  // lectura del contenedor.
  dataDir: process.env.DATA_DIR || path.join(__dirname, "data"),
  useFirebaseRest: booleano("USE_FIREBASE_REST", true),
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID || "wayture-37479",
  // URLs base configurables solo para las pruebas automaticas (servidor
  // falso local). En uso normal apuntan a Google.
  firebaseAuthBaseUrl: process.env.FIREBASE_AUTH_BASE_URL || "https://identitytoolkit.googleapis.com/v1",
  firestoreBaseUrl: process.env.FIRESTORE_BASE_URL || "https://firestore.googleapis.com/v1",

  // --- Seguridad ---------------------------------------------------------
  // Antes la autenticacion de la API venia APAGADA por defecto (y .env no se
  // cargaba con "npm start"). Ahora esta encendida; solo se apaga a proposito.
  apiAuthEnabled: booleano("API_AUTH_ENABLED", true),
  jwtTtlMs: Number(process.env.JWT_TTL_MS || 1000 * 60 * 60 * 8),

  // --- Cache Redis (opcional) --------------------------------------------
  redisHost: process.env.REDIS_HOST || "",
  redisPort: Number(process.env.REDIS_PORT || 6379),
  cacheTtl: Number(process.env.CACHE_TTL || 30),

  appVersion: process.env.APP_VERSION || "1.0"
};

// Secretos obligatorios. HS256 con clave corta es atacable por fuerza bruta.
config.jwtSecret = leerSecreto("JWT_SECRET", { minLargo: 32 });
// Firma el token CSRF publico. DEBE ser distinto de JWT_SECRET: si fueran
// iguales, el token CSRF (que recibe cualquiera) pasaria como JWT de sesion.
config.csrfSecret = leerSecreto("CSRF_SECRET", { minLargo: 32 });
if (config.csrfSecret === config.jwtSecret) {
  throw new ErrorConfiguracion("CSRF_SECRET debe ser distinto de JWT_SECRET");
}
// Clave web de Firebase. No es secreta por diseno (va en el frontend), pero
// se trata como secreto para no dejarla fija en el codigo del servidor.
config.firebaseApiKey = leerSecreto("FIREBASE_API_KEY");
// Con REDIS_HOST la contrasena es obligatoria.
config.redisPassword = config.redisHost ? leerSecreto("REDIS_PASSWORD") : null;
// Usuario "servicio" de Firebase para que el servidor escriba en Firestore
// cuando las reglas exijan autenticacion (ver docs/firestore-reglas.md).
// Opcional: sin el, el servidor llama a Firestore sin credenciales (como hoy).
config.firebaseServiceEmail = leerSecreto("FIREBASE_SERVICE_EMAIL", { opcional: true });
config.firebaseServicePassword = config.firebaseServiceEmail
  ? leerSecreto("FIREBASE_SERVICE_PASSWORD")
  : null;

export default config;
