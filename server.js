import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import config from "./config.js";
import * as cache from "./cache.js";
import {
  agregarHistorialSiCambio,
  buildSimulationFirestorePatch,
  ensureTripSimulationFields,
  generarRutaSimulada,
  getTripCode,
  getTripDestination,
  normalizeTripStatus
} from "./js/trip-simulation.js";
import {
  deleteFirebaseDoc,
  getFirebaseDoc,
  listFirebaseCollection,
  setFirebaseDoc,
  verificarIdToken
} from "./firebase-rest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = config.port;
const DATA_DIR = config.dataDir;
const DATA_FILE = path.join(DATA_DIR, "wayture-api.json");
const USE_FIREBASE_REST = config.useFirebaseRest;
const API_AUTH_ENABLED = config.apiAuthEnabled;
const JWT_SECRET = config.jwtSecret;
const CSRF_SECRET = config.csrfSecret;
const JWT_TTL_MS = config.jwtTtlMs;
// Margen para relojes desfasados entre maquinas al validar "iat".
const MARGEN_RELOJ_S = 60;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml"
};

// Unicas rutas estaticas que se sirven. Antes se servia TODA la carpeta del
// proyecto: /.env, /.git/config, /data/wayture-api.json (emails reales) y el
// codigo del servidor se podian descargar. En contenedores los estaticos los
// sirve Nginx (docker/nginx/default.conf) con la misma lista.
const STATIC_DIRS = ["css/", "js/", "assets/", "react-widget/dist/"];

// Politica unica de cabeceras de seguridad. Nginx replica la misma politica
// para los estaticos (docker/nginx/security-headers.conf): si cambias una,
// cambia la otra.
const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://unpkg.com https://www.gstatic.com https://www.googleapis.com https://maps.googleapis.com https://nominatim.openstreetmap.org https://*.tile.openstreetmap.org; style-src 'self' 'unsafe-inline' https://unpkg.com https://fonts.googleapis.com; img-src 'self' data: https: blob:; connect-src 'self' https://*.googleapis.com https://*.firebaseio.com https://*.firebase.com https://nominatim.openstreetmap.org https://*.tile.openstreetmap.org wss://*.firebaseio.com https://www.google.com; font-src 'self' data: https://fonts.gstatic.com https://unpkg.com; frame-src 'self' https://www.google.com https://maps.google.com; object-src 'none'; base-uri 'self'; form-action 'self' https://*.firebase.com; upgrade-insecure-requests",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Referrer-Policy": "strict-origin-when-cross-origin"
};

function withSecurityHeaders(extraHeaders = {}) {
  return {
    ...SECURITY_HEADERS,
    ...extraHeaders
  };
}

// CORS: antes "Access-Control-Allow-Origin: *" junto con
// "Allow-Credentials: true" (combinacion invalida y abierta a cualquier
// sitio). El frontend es del mismo origen y no necesita CORS; solo se
// responde a los origenes listados en CORS_ORIGINS.
const CORS_ORIGINS = String(process.env.CORS_ORIGINS || "").split(",").map(o => o.trim()).filter(Boolean);
// El origen se guarda en cada respuesta (res.origen), no en una variable
// global: con peticiones simultaneas una global mezclaria origenes.
function corsHeaders(res) {
  const origen = res?.origen || "";
  if (!origen || !CORS_ORIGINS.includes(origen)) return {};
  return {
    "Access-Control-Allow-Origin": origen,
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Vary": "Origin"
  };
}

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, withSecurityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    // Respuestas con datos de usuarios: que no queden en caches intermedias.
    "Cache-Control": "no-store",
    ...corsHeaders(res),
    ...extraHeaders
  }));
  res.end(JSON.stringify(payload, null, 2));
}

function b64url(input) {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function b64urlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Buffer.from(padded, "base64").toString("utf8");
}

function firmar(signingInput, secret) {
  return crypto.createHmac("sha256", secret).update(signingInput).digest("base64url");
}

function signJwt(payload, secret = JWT_SECRET) {
  const header = { alg: "HS256", typ: "JWT" };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  return `${signingInput}.${firmar(signingInput, secret)}`;
}

/**
 * Verifica un JWT HS256. Devuelve el payload o null.
 * - Solo acepta alg HS256: rechaza "none" y cualquier otro algoritmo.
 * - Compara la firma en tiempo constante (crypto.timingSafeEqual).
 * - Exige exp e iat numericos: exp en el futuro, iat no en el futuro.
 */
function verifyJwt(token, secret = JWT_SECRET) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerBase64, payloadBase64, signature] = parts;
  try {
    const header = JSON.parse(b64urlDecode(headerBase64));
    if (header.alg !== "HS256") return null;
    const expected = Buffer.from(firmar(`${headerBase64}.${payloadBase64}`, secret));
    const recibida = Buffer.from(signature);
    if (expected.length !== recibida.length) return null;
    if (!crypto.timingSafeEqual(expected, recibida)) return null;
    const payload = JSON.parse(b64urlDecode(payloadBase64));
    const ahora = Math.floor(Date.now() / 1000);
    if (!Number.isFinite(payload.exp) || payload.exp <= ahora) return null;
    if (!Number.isFinite(payload.iat) || payload.iat > ahora + MARGEN_RELOJ_S) return null;
    return payload;
  } catch {
    return null;
  }
}

function iguales(a, b) {
  // Comparacion en tiempo constante (sobre hash para igualar longitudes).
  const ha = crypto.createHash("sha256").update(String(a)).digest();
  const hb = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getCsrfTokenFromRequest(req) {
  const header = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"];
  return clean(typeof header === "string" ? header : Array.isArray(header) ? header[0] : "");
}

function getBearer(req) {
  const match = String(req.headers.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : "";
}

/**
 * Exige un JWT de sesion valido y, si csrf=true, que la cabecera
 * X-CSRF-Token coincida (en tiempo constante) con el claim "csrf" del JWT.
 * Ninguna verificacion depende de memoria del proceso: cualquier replica con
 * el mismo JWT_SECRET la resuelve igual.
 */
function requireApiAuth(req, res, { csrf = true, admin = false } = {}) {
  if (!API_AUTH_ENABLED) return { ok: true, user: null };
  const payload = verifyJwt(getBearer(req), JWT_SECRET);

  if (!payload || payload.typ === "csrf" || !payload.uid) {
    json(res, 401, { ok: false, error: "Token JWT inválido o expirado." });
    return { ok: false };
  }

  if (csrf) {
    const csrfToken = getCsrfTokenFromRequest(req);
    if (!payload.csrf || !csrfToken || !iguales(csrfToken, payload.csrf)) {
      json(res, 403, { ok: false, error: "CSRF inválido. Solicita un nuevo token antes de actualizar la API." });
      return { ok: false };
    }
  }

  if (admin && payload.rol !== "admin") {
    json(res, 403, { ok: false, error: "Se requiere rol admin." });
    return { ok: false };
  }
  return { ok: true, user: payload };
}

function puedeModificarViaje(user, trip) {
  // Sin autenticacion (modo desarrollo) o admin: todo. Usuario: solo sus viajes.
  if (!user || user.rol === "admin") return true;
  return String(trip.userEmail || "").toLowerCase() === String(user.email || "").toLowerCase();
}

function notFound(res, message = "Ruta no encontrada") {
  json(res, 404, { ok: false, error: message });
}

function clean(text) {
  return String(text || "").trim();
}

function normalizeCode(value) {
  return clean(value).toUpperCase();
}

function makeCode(destination = "WAYTURE") {
  const base = clean(destination)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "")
    .slice(0, 4)
    .toUpperCase() || "WT";
  return `WT-${base}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

function idFromCode(code) {
  return normalizeCode(code).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function ensureDataFile() {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await writeFile(DATA_FILE, JSON.stringify({ viajes: [] }, null, 2), "utf8");
  }
}

async function readDb() {
  await ensureDataFile();
  const raw = await readFile(DATA_FILE, "utf8");
  const db = JSON.parse(raw || "{}");
  return {
    usuarios: Array.isArray(db.usuarios) ? db.usuarios : [],
    viajes: Array.isArray(db.viajes) ? db.viajes : []
  };
}

async function writeDb(db) {
  await ensureDataFile();
  await writeFile(DATA_FILE, JSON.stringify(db, null, 2), "utf8");
}

async function readApiDb() {
  const localDb = await readDb();
  if (!USE_FIREBASE_REST) return { ...localDb, source: "local" };
  try {
    const [usuarios, viajes] = await Promise.all([
      listFirebaseCollection("usuarios"),
      listFirebaseCollection("viajes")
    ]);
    return { usuarios, viajes, source: "firebase" };
  } catch (error) {
    console.warn("Firebase REST no disponible, usando JSON local:", error.message);
    return { ...localDb, source: "local-fallback", firebaseError: error.message };
  }
}

/** Coleccion de viajes para GET /api/viajes: Redis -> Firestore -> JSON. */
async function leerViajes() {
  const enCache = await cache.leer("viajes");
  if (enCache) return { ...enCache, cache: "HIT" };
  let resultado;
  if (!USE_FIREBASE_REST) {
    resultado = { viajes: (await readDb()).viajes, source: "local" };
  } else {
    try {
      resultado = { viajes: await listFirebaseCollection("viajes"), source: "firebase" };
    } catch (error) {
      console.warn("Firebase REST no disponible, usando JSON local:", error.message);
      return { viajes: (await readDb()).viajes, source: "local-fallback", cache: "MISS" };
    }
  }
  // El respaldo local no se cachea: asi, cuando Firestore vuelva, se usa ya.
  await cache.guardar("viajes", resultado);
  return { ...resultado, cache: "MISS" };
}

async function persistApiDoc(collectionName, id, data, db, localUpdater) {
  const updatedDb = localUpdater ? localUpdater(db) : db;
  await writeDb(updatedDb);
  if (collectionName === "viajes") await cache.invalidar("viajes");
  if (!USE_FIREBASE_REST) return data;
  try {
    return await setFirebaseDoc(collectionName, id, data);
  } catch (error) {
    console.warn(`No se pudo guardar en Firebase ${collectionName}/${id}:`, error.message);
    return data;
  }
}

async function deleteApiDoc(collectionName, id, db, localUpdater) {
  const updatedDb = localUpdater ? localUpdater(db) : db;
  await writeDb(updatedDb);
  if (collectionName === "viajes") await cache.invalidar("viajes");
  if (!USE_FIREBASE_REST) return true;
  try {
    await deleteFirebaseDoc(collectionName, id);
  } catch (error) {
    console.warn(`No se pudo eliminar en Firebase ${collectionName}/${id}:`, error.message);
  }
  return true;
}

async function readBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    // Limite de 1 MB: sin el, un cuerpo enorme agotaria la memoria del pod.
    if (total > 1024 * 1024) {
      const error = new Error("El cuerpo supera 1 MB.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("El cuerpo debe ser JSON valido.");
    error.status = 400;
    throw error;
  }
}

function toApiTrip(input = {}, existing = {}) {
  const destination = clean(input.destino || input.destination || existing.destino || existing.destination || "Destino");
  const origin = clean(input.origen || input.origin || existing.origen || existing.origin || "Aeropuerto Internacional El Dorado, Bogota");
  const code = normalizeCode(input.codigoViaje || input.code || existing.codigoViaje || existing.code || makeCode(destination));
  const route = Array.isArray(input.route) && input.route.length >= 2
    ? input.route
    : generarRutaSimulada(origin, destination, input.puntoIntermedio1 || existing.puntoIntermedio1, input.puntoIntermedio2 || existing.puntoIntermedio2);
  const base = {
    ...existing,
    ...input,
    id: existing.id || input.id || idFromCode(code),
    codigoViaje: code,
    code,
    origen: origin,
    destino: destination,
    destination,
    nombreViaje: clean(input.nombreViaje || input.name || input.tripName || existing.nombreViaje) || `Viaje a ${destination}`,
    route,
    estado: normalizeTripStatus(input.estado || input.status || existing.estado || existing.status || "Planificado"),
    status: normalizeTripStatus(input.estado || input.status || existing.estado || existing.status || "Planificado"),
    progreso: Number(input.progreso ?? input.progress ?? existing.progreso ?? 0) || 0,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  return ensureTripSimulationFields(base);
}

function publicTrip(trip) {
  const normalized = ensureTripSimulationFields(trip);
  return {
    id: normalized.id,
    codigoViaje: getTripCode(normalized),
    nombreViaje: normalized.nombreViaje,
    origen: normalized.origen,
    destino: getTripDestination(normalized),
    estado: normalized.estado,
    progreso: normalized.progreso,
    currentLocation: normalized.currentLocation,
    route: normalized.route,
    statusHistory: normalized.statusHistory,
    startDate: normalized.startDate || "",
    endDate: normalized.endDate || "",
    userEmail: normalized.userEmail || ""
  };
}

/** Rol del usuario segun su documento en Firestore (o el JSON local). */
async function rolDeUsuario(uid, idToken) {
  try {
    if (USE_FIREBASE_REST) {
      // Se lee con el idToken del propio usuario: funciona tambien cuando las
      // reglas de Firestore exigen autenticacion.
      const perfil = await getFirebaseDoc("usuarios", uid, idToken);
      return perfil.rol === "admin" ? "admin" : "usuario";
    }
    const local = (await readDb()).usuarios.find(u => u.uid === uid || u.id === uid);
    return local?.rol === "admin" ? "admin" : "usuario";
  } catch {
    // Sin perfil (usuario recien creado) o Firestore caido: el minimo.
    return "usuario";
  }
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, withSecurityHeaders(corsHeaders(res)));
    return res.end();
  }

  if (req.method === "GET" && url.pathname === "/api/auth/csrf") {
    const token = createCsrfToken();
    const ahora = Math.floor(Date.now() / 1000);
    // Sobre firmado con CSRF_SECRET (distinto de JWT_SECRET) y marcado
    // typ "csrf": nunca sirve como JWT de sesion.
    const csrfJwt = signJwt({
      typ: "csrf",
      csrf: token,
      iat: ahora,
      exp: ahora + Math.floor(JWT_TTL_MS / 1000)
    }, CSRF_SECRET);
    res.writeHead(200, withSecurityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(res),
      "Set-Cookie": `csrf_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`
    }));
    return res.end(JSON.stringify({ ok: true, data: { token: csrfJwt, csrfToken: token } }, null, 2));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/token") {
    const body = await readBody(req);
    const idToken = clean(body.idToken);
    const csrfToken = clean(body.csrfToken || getCsrfTokenFromRequest(req) || "");
    // Antes se firmaba un JWT con el uid, email y ROL que enviara el
    // cliente: cualquiera obtenia un token de admin sin iniciar sesion.
    // Ahora la identidad sale de Firebase (accounts:lookup) y el rol de su
    // perfil en Firestore; el cuerpo solo aporta el idToken.
    if (!idToken) {
      return json(res, 400, { ok: false, error: "Debes enviar el idToken de Firebase (user.getIdToken())." });
    }
    if (!csrfToken) {
      return json(res, 400, { ok: false, error: "Debes enviar el csrfToken obtenido en /api/auth/csrf." });
    }
    let identidad;
    try {
      identidad = await verificarIdToken(idToken);
    } catch {
      return json(res, 401, { ok: false, error: "idToken de Firebase inválido o expirado." });
    }
    const rol = await rolDeUsuario(identidad.uid, idToken);
    const ahora = Math.floor(Date.now() / 1000);
    const token = signJwt({
      sub: identidad.uid,
      uid: identidad.uid,
      email: identidad.email,
      rol,
      csrf: csrfToken,
      iat: ahora,
      exp: ahora + Math.floor(JWT_TTL_MS / 1000)
    }, JWT_SECRET);
    return json(res, 200, { ok: true, data: { token, user: { uid: identidad.uid, email: identidad.email, rol }, expiresIn: JWT_TTL_MS } });
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const db = await readApiDb();
    return json(res, 200, {
      ok: true,
      app: "WayTure API",
      status: "online",
      database: db.source,
      endpoints: ["/api/usuarios", "/api/viajes", "/api/rastreo/:codigo", "/api/viajeros/ubicaciones"]
    });
  }

  const parts = url.pathname.split("/").filter(Boolean);

  // Rastreo publico por codigo (se comparte con familiares): sin token.
  const esRastreoPublico = req.method === "GET" && parts[1] === "rastreo";
  let user = null;
  if (API_AUTH_ENABLED && !url.pathname.startsWith("/api/auth/") && !esRastreoPublico) {
    // Escrituras: JWT + CSRF. Lecturas: JWT. Listados con emails o
    // ubicaciones de todos los viajeros: solo admin.
    const soloAdmin = req.method === "GET" && (
      url.pathname === "/api/usuarios" || ["viajeros", "repartidores"].includes(parts[1])
    );
    const authCheck = requireApiAuth(req, res, { csrf: req.method !== "GET", admin: soloAdmin });
    if (!authCheck.ok) return;
    user = authCheck.user;
  }

  if (req.method === "GET" && url.pathname === "/api/viajes") {
    const q = clean(url.searchParams.get("q")).toLowerCase();
    const status = clean(url.searchParams.get("estado") || url.searchParams.get("status")).toLowerCase();
    const { viajes, cache: estadoCache } = await leerViajes();
    const trips = viajes
      .map(ensureTripSimulationFields)
      .filter(trip => !q || `${trip.codigoViaje} ${trip.nombreViaje} ${trip.destino} ${trip.userEmail || ""}`.toLowerCase().includes(q))
      .filter(trip => !status || trip.estado.toLowerCase().includes(status));
    return json(res, 200, { ok: true, data: trips }, { "X-Cache": estadoCache });
  }

  const db = await readApiDb();

  if (req.method === "GET" && url.pathname === "/api/usuarios") {
    return json(res, 200, { ok: true, data: db.usuarios });
  }

  if (req.method === "POST" && url.pathname === "/api/usuarios") {
    const body = await readBody(req);
    // Con sesion, el uid y el email salen del JWT verificado: un usuario
    // solo puede crear/actualizar su propio perfil.
    const uid = user ? user.uid : clean(body.uid || body.id);
    const email = user ? clean(user.email).toLowerCase() : clean(body.email).toLowerCase();
    if (!uid || !email) {
      return json(res, 400, { ok: false, error: "Debes enviar uid y email." });
    }
    const usuario = {
      id: uid,
      uid,
      nombre: clean(body.nombre || body.name || "Viajero"),
      alias: clean(body.alias || ""),
      email,
      rol: "usuario",
      creadoEn: body.creadoEn || new Date().toISOString(),
      actualizadoEn: new Date().toISOString()
    };
    const index = db.usuarios.findIndex(item => item.uid === uid || String(item.email).toLowerCase() === email);
    await persistApiDoc("usuarios", uid, usuario, db, current => {
      const next = { usuarios: [...current.usuarios], viajes: current.viajes };
      if (index >= 0) next.usuarios[index] = { ...next.usuarios[index], ...usuario, rol: next.usuarios[index].rol || "usuario" };
      else next.usuarios.push(usuario);
      return next;
    });
    return json(res, index >= 0 ? 200 : 201, { ok: true, data: usuario });
  }

  if (req.method === "POST" && url.pathname === "/api/viajes") {
    const body = await readBody(req);
    // Un usuario normal solo crea viajes a su nombre.
    if (user && user.rol !== "admin") body.userEmail = user.email;
    const trip = toApiTrip(body);
    if (db.viajes.some(item => normalizeCode(item.codigoViaje || item.code) === trip.codigoViaje)) {
      return json(res, 409, { ok: false, error: "Ya existe un viaje con ese codigo." });
    }
    await persistApiDoc("viajes", trip.id, trip, db, current => ({
      usuarios: current.usuarios,
      viajes: [...current.viajes, trip]
    }));
    return json(res, 201, { ok: true, data: trip });
  }

  if (parts[0] === "api" && parts[1] === "rastreo" && parts[2] && req.method === "GET") {
    const code = normalizeCode(decodeURIComponent(parts[2]));
    const trip = db.viajes.find(item => normalizeCode(item.codigoViaje || item.code) === code);
    if (!trip) return notFound(res, "No existe un viaje con ese codigo.");
    return json(res, 200, { ok: true, data: publicTrip(trip) });
  }

  if (parts[0] === "api" && ["viajeros", "repartidores"].includes(parts[1]) && parts[2] === "ubicaciones" && req.method === "GET") {
    return json(res, 200, {
      ok: true,
      data: db.viajes.map(ensureTripSimulationFields).map(trip => ({
        id: trip.id,
        codigoViaje: trip.codigoViaje,
        viajero: trip.userEmail || "Sin asignar",
        destino: trip.destino,
        estado: trip.estado,
        ubicacion: trip.currentLocation
      }))
    });
  }

  if (parts[0] === "api" && parts[1] === "viajes" && parts[2]) {
    const id = decodeURIComponent(parts[2]);
    const index = db.viajes.findIndex(item => item.id === id || normalizeCode(item.codigoViaje || item.code) === normalizeCode(id));
    if (index === -1) return notFound(res, "Viaje no encontrado.");
    const existing = ensureTripSimulationFields(db.viajes[index]);

    if (req.method === "GET" && parts.length === 3) {
      return json(res, 200, { ok: true, data: existing });
    }

    // Modificar o borrar: admin o el dueno del viaje.
    if (req.method !== "GET" && !puedeModificarViaje(user, existing)) {
      return json(res, 403, { ok: false, error: "Solo el dueño del viaje o un admin puede modificarlo." });
    }

    if (req.method === "PUT" && parts.length === 3) {
      const body = await readBody(req);
      if (user && user.rol !== "admin") body.userEmail = existing.userEmail;
      const updated = toApiTrip(body, existing);
      await persistApiDoc("viajes", updated.id, updated, db, current => {
        const next = { usuarios: current.usuarios, viajes: [...current.viajes] };
        next.viajes[index] = updated;
        return next;
      });
      return json(res, 200, { ok: true, data: updated });
    }

    if (req.method === "PATCH" && parts[3] === "estado") {
      const body = await readBody(req);
      const nextStatus = normalizeTripStatus(body.estado || body.status || existing.estado);
      const point = body.currentLocation || existing.currentLocation;
      const progreso = Number(body.progreso ?? existing.progreso) || 0;
      const statusHistory = agregarHistorialSiCambio(existing, nextStatus, point, progreso, body.observacion || "Estado actualizado desde API REST.");
      const updated = ensureTripSimulationFields({
        ...existing,
        estado: nextStatus,
        status: nextStatus,
        progreso,
        currentLocation: point,
        statusHistory,
        updatedAt: new Date().toISOString()
      });
      await persistApiDoc("viajes", updated.id, updated, db, current => {
        const next = { usuarios: current.usuarios, viajes: [...current.viajes] };
        next.viajes[index] = updated;
        return next;
      });
      return json(res, 200, { ok: true, data: updated });
    }

    if (req.method === "PATCH" && parts[3] === "gps") {
      const body = await readBody(req);
      const lat = Number(body.lat ?? body.latitude);
      const lng = Number(body.lng ?? body.longitude);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        return json(res, 400, { ok: false, error: "Debes enviar lat y lng numericos." });
      }
      const point = {
        lat,
        lng,
        label: clean(body.label || body.ubicacion || "GPS real del dispositivo"),
        accuracy: Number(body.accuracy) || null,
        capturedAt: new Date().toISOString()
      };
      const nextStatus = normalizeTripStatus(body.estado || body.status || "En ruta");
      const progreso = Number(body.progreso ?? existing.progreso) || existing.progreso || 0;
      const statusHistory = agregarHistorialSiCambio(existing, nextStatus, point, progreso, body.observacion || "Ubicacion GPS real actualizada desde API REST.");
      const updated = ensureTripSimulationFields({
        ...existing,
        ...buildSimulationFirestorePatch({ ...existing, currentLocation: point, estado: nextStatus, status: nextStatus, progreso }),
        currentLocation: point,
        estado: nextStatus,
        status: nextStatus,
        progreso,
        gpsRealActivo: true,
        statusHistory,
        updatedAt: new Date().toISOString()
      });
      await persistApiDoc("viajes", updated.id, updated, db, current => {
        const next = { usuarios: current.usuarios, viajes: [...current.viajes] };
        next.viajes[index] = updated;
        return next;
      });
      return json(res, 200, { ok: true, data: updated });
    }

    if (req.method === "DELETE" && parts.length === 3) {
      const deleted = db.viajes[index];
      await deleteApiDoc("viajes", deleted.id, db, current => {
        const next = { usuarios: current.usuarios, viajes: [...current.viajes] };
        next.viajes.splice(index, 1);
        return next;
      });
      return json(res, 200, { ok: true, data: deleted });
    }
  }

  return notFound(res);
}

function esRutaEstaticaPermitida(relativa) {
  // Paginas HTML de la raiz y archivos dentro de las carpetas publicas.
  if (!relativa.includes("/")) return relativa.endsWith(".html") || relativa === "favicon.ico";
  return STATIC_DIRS.some(dir => relativa.startsWith(dir));
}

async function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(__dirname, requested));
  // path.sep al final: "/app-otra" no debe pasar por "/app".
  if (!filePath.startsWith(__dirname + path.sep)) return notFound(res);
  const relativa = path.relative(__dirname, filePath).split(path.sep).join("/");
  const ext = path.extname(filePath).toLowerCase();
  if (!esRutaEstaticaPermitida(relativa) || !MIME_TYPES[ext]) {
    return notFound(res, "Archivo no encontrado.");
  }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, withSecurityHeaders({ "Content-Type": MIME_TYPES[ext] }));
    res.end(data);
  } catch {
    notFound(res, "Archivo no encontrado.");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    res.origen = String(req.headers.origin || "");

    // Publicos, sin JWT/CSRF y SIN consultar Firebase ni Redis: los usan las
    // probes de Docker/Kubernetes. Si dependieran de servicios externos, una
    // caida de Firebase haria reiniciar todos los pods sin arreglar nada.
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, 200, { estado: "ok" });
    }
    if (req.method === "GET" && url.pathname === "/quien") {
      // Nombre del pod/contenedor y version: demuestra balanceo y rolling update.
      return json(res, 200, { pod: os.hostname(), version: process.env.APP_VERSION || "1.0" });
    }

    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    // Los errores internos no se envian al cliente (podrian revelar rutas o
    // detalles de Firebase); se registran en el log.
    if (status >= 500) console.error("Error interno:", error.message);
    if (!res.headersSent) {
      json(res, status, { ok: false, error: status >= 500 ? "Error interno" : error.message });
    } else {
      res.end();
    }
  }
});

await cache.iniciarCache();

server.listen(PORT, config.host, () => {
  console.log(`WayTure listo en http://localhost:${PORT} (version ${process.env.APP_VERSION || "1.0"})`);
  console.log(`API REST lista en http://localhost:${PORT}/api/health`);
  console.log(`Autenticacion de la API: ${API_AUTH_ENABLED ? "activada" : "DESACTIVADA (solo desarrollo)"}`);
});

// Apagado ordenado: Docker y Kubernetes envian SIGTERM (Ctrl+C = SIGINT).
// server.close() deja de aceptar conexiones y espera a que terminen las
// peticiones en curso; luego se cierra Redis y se sale con codigo 0. Sin
// esto, el proceso moriria a mitad de peticiones durante un rolling update.
let cerrando = false;
function apagar(senal) {
  if (cerrando) return;
  cerrando = true;
  console.log(`${senal} recibido: cerrando de forma ordenada...`);
  // Si algo no termina en 20 s (menos que los 30 s de gracia de K8s), salir.
  setTimeout(() => process.exit(0), 20_000).unref();
  server.close(async () => {
    await cache.cerrarCache();
    process.exit(0);
  });
  // Las conexiones keep-alive inactivas no deben retrasar el cierre.
  server.closeIdleConnections();
}
process.on("SIGTERM", () => apagar("SIGTERM"));
process.on("SIGINT", () => apagar("SIGINT"));
