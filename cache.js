// cache.js
// Cache de lecturas en Redis con degradacion elegante.
//
// - Se cachea la coleccion "viajes" que usa GET /api/viajes (TTL corto,
//   CACHE_TTL segundos) para reducir lecturas a Firestore.
// - La clave es GLOBAL (no por usuario) porque GET /api/viajes devuelve la
//   misma lista a todo usuario autenticado: una clave por usuario no
//   protegeria nada y dejaria a los demas viendo datos viejos tras una
//   escritura. Si algun dia el listado se filtra por usuario, la clave debe
//   incluir el uid del JWT verificado (ver claveUsuario()).
// - Toda escritura de viajes invalida la clave.
// - Si Redis no responde, la API sigue con Firestore: se registra una
//   advertencia (sin datos sensibles) y NUNCA se devuelve 500 por la cache.
//
// Por que la libreria "redis" (node-redis) y no el protocolo a mano: un
// cliente correcto necesita reconexion, timeouts, autenticacion, TLS (Azure
// Cache for Redis) y manejo de respuestas parciales; es infraestructura que
// no aporta al curso y donde un error seria silencioso.

import config from "./config.js";

const PREFIJO = "waytur:cache:";
// Una cache lenta es peor que no tener cache.
const TIMEOUT_MS = 300;

let cliente = null;
let ultimoAviso = 0;

function avisar(operacion, error) {
  // Como mucho un aviso cada 10 s para no inundar los logs. Solo el tipo o
  // codigo de error: el mensaje podria incluir host o credenciales.
  if (Date.now() - ultimoAviso < 10_000) return;
  ultimoAviso = Date.now();
  console.warn(`Redis no disponible (${operacion}: ${error?.code || error?.name || "error"}); se usa Firestore directamente`);
}

export async function iniciarCache() {
  if (!config.redisHost || cliente) return;
  // Importacion dinamica: si el paquete "redis" no esta instalado, la cache
  // queda desactivada y la API funciona igual (solo con Firestore).
  let createClient;
  try {
    ({ createClient } = await import("redis"));
  } catch {
    console.warn("Paquete 'redis' no instalado: cache desactivada (npm install)");
    return;
  }
  cliente = createClient({
    socket: {
      host: config.redisHost,
      port: config.redisPort,
      connectTimeout: 1000,
      // Reintenta en segundo plano para siempre, con espera creciente (max 5 s).
      reconnectStrategy: intentos => Math.min(200 * (intentos + 1), 5000)
    },
    password: config.redisPassword,
    // Sin cola offline: si Redis esta caido, el comando falla al instante en
    // vez de quedar esperando a que vuelva (colgaria la peticion).
    disableOfflineQueue: true
  });
  // Sin este manejador, un error de conexion terminaria el proceso.
  cliente.on("error", error => avisar("conexion", error));
  cliente.connect().catch(error => avisar("conexion", error));
}

async function conLimite(promesa) {
  let temporizador;
  const limite = new Promise((_, rechazar) => {
    temporizador = setTimeout(() => rechazar(Object.assign(new Error("timeout"), { code: "TIMEOUT" })), TIMEOUT_MS);
  });
  try {
    return await Promise.race([promesa, limite]);
  } finally {
    clearTimeout(temporizador);
  }
}

function disponible() {
  return Boolean(cliente?.isReady);
}

export function claveUsuario(recurso, uid) {
  return `${recurso}:usuario:${uid}`;
}

export async function leer(recurso) {
  if (!disponible()) return null;
  try {
    const valor = await conLimite(cliente.get(PREFIJO + recurso));
    return valor ? JSON.parse(valor) : null;
  } catch (error) {
    avisar("lectura", error);
    return null;
  }
}

export async function guardar(recurso, datos) {
  if (!disponible()) return;
  try {
    await conLimite(cliente.set(PREFIJO + recurso, JSON.stringify(datos), { EX: config.cacheTtl }));
  } catch (error) {
    avisar("escritura", error);
  }
}

export async function invalidar(...recursos) {
  if (!disponible()) return;
  try {
    await conLimite(cliente.del(recursos.map(r => PREFIJO + r)));
  } catch (error) {
    // Si falla, el dato viejo expira solo en CACHE_TTL segundos.
    avisar("invalidacion", error);
  }
}

export async function cerrarCache() {
  if (!cliente) return;
  try {
    await conLimite(cliente.quit());
  } catch {
    cliente.destroy?.();
  }
}
