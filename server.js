import { createServer } from "node:http";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  listFirebaseCollection,
  setFirebaseDoc
} from "./firebase-rest.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "wayture-api.json");
const USE_FIREBASE_REST = process.env.USE_FIREBASE_REST !== "false";
const API_AUTH_ENABLED = process.env.API_AUTH_ENABLED === "true" || process.env.API_AUTH_ENABLED === "1";
const JWT_SECRET = process.env.JWT_SECRET || "wayture-dev-secret-change-me";
const CSRF_SECRET = process.env.CSRF_SECRET || "wayture-csrf-dev-secret";
const JWT_TTL_MS = Number(process.env.JWT_TTL_MS || 1000 * 60 * 60 * 8);

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
  ".bmp": "image/bmp"
};

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

function json(res, status, payload, extraHeaders = {}) {
  res.writeHead(status, withSecurityHeaders({
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
    "Access-Control-Allow-Credentials": "true",
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

function signJwt(payload, secret = JWT_SECRET) {
  const header = { alg: "HS256", typ: "JWT" };
  const encodedHeader = b64url(JSON.stringify(header));
  const encodedPayload = b64url(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac("sha256", secret).update(signingInput).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  return `${signingInput}.${signature}`;
}

function verifyJwt(token, secret = JWT_SECRET) {
  if (!token || typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [headerBase64, payloadBase64, signature] = parts;
  const signingInput = `${headerBase64}.${payloadBase64}`;
  const expected = crypto.createHmac("sha256", secret).update(signingInput).digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length) return null;
  if (!crypto.timingSafeEqual(expectedBuffer, signatureBuffer)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(payloadBase64));
    if (payload.exp && Date.now() > payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function createCsrfToken() {
  return crypto.randomBytes(32).toString("base64url");
}

function getCsrfTokenFromRequest(req) {
  const header = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"];
  return clean(typeof header === "string" ? header : Array.isArray(header) ? header[0] : "");
}

function verifyCsrf(req, token) {
  const provided = getCsrfTokenFromRequest(req);
  if (!provided || !token || provided !== token) return false;
  return true;
}

function requireApiAuth(req, res) {
  if (!API_AUTH_ENABLED) return { ok: true, user: null };
  const authHeader = req.headers.authorization || "";
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = match ? match[1] : "";
  const payload = verifyJwt(token, JWT_SECRET);

  if (!payload) {
    json(res, 401, { ok: false, error: "Token JWT inválido o expirado." });
    return { ok: false };
  }

  const csrfToken = req.headers["x-csrf-token"] || req.headers["x-xsrf-token"] || "";
  const csrfValid = payload.csrf && String(csrfToken) === String(payload.csrf);

  if (!csrfValid) {
    json(res, 403, { ok: false, error: "CSRF inválido. Solicita un nuevo token antes de actualizar la API." });
    return { ok: false };
  }
  return { ok: true, user: payload };
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
    .replace(/[\u0300-\u036f]/g, "")
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

async function persistApiDoc(collectionName, id, data, db, localUpdater) {
  const updatedDb = localUpdater ? localUpdater(db) : db;
  await writeDb(updatedDb);
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
  for await (const chunk of req) chunks.push(chunk);
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

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return json(res, 200, { ok: true });

  if (req.method === "GET" && url.pathname === "/api/auth/csrf") {
    const token = createCsrfToken();
    const signingPayload = {
      csrf: token,
      issuedAt: Date.now(),
      exp: Date.now() + JWT_TTL_MS
    };
    const csrfJwt = signJwt(signingPayload, CSRF_SECRET);
    res.writeHead(200, withSecurityHeaders({
      "Content-Type": "application/json; charset=utf-8",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-CSRF-Token",
      "Set-Cookie": `csrf_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=3600`
    }));
    return res.end(JSON.stringify({ ok: true, data: { token: csrfJwt, csrfToken: token } }, null, 2));
  }

  if (req.method === "POST" && url.pathname === "/api/auth/token") {
    const body = await readBody(req);
    const uid = clean(body.uid || body.id || "");
    const email = clean(body.email || "").toLowerCase();
    const csrfToken = clean(body.csrfToken || getCsrfTokenFromRequest(req) || "");
    if (!uid && !email) {
      return json(res, 400, { ok: false, error: "Debes enviar uid o email para generar el token." });
    }
    const token = signJwt({
      uid,
      email,
      rol: clean(body.rol || "usuario"),
      csrf: csrfToken,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor((Date.now() + JWT_TTL_MS) / 1000)
    }, JWT_SECRET);
    return json(res, 200, { ok: true, data: { token, user: { uid, email, rol: clean(body.rol || "usuario") }, expiresIn: JWT_TTL_MS } });
  }

  if (API_AUTH_ENABLED && req.method !== "GET" && !url.pathname.startsWith("/api/auth/")) {
    const authCheck = requireApiAuth(req, res);
    if (!authCheck.ok) return;
  }

  const db = await readApiDb();
  const parts = url.pathname.split("/").filter(Boolean);

  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      app: "WayTure API",
      status: "online",
      database: db.source,
      endpoints: ["/api/usuarios", "/api/viajes", "/api/rastreo/:codigo", "/api/viajeros/ubicaciones"]
    });
  }

  if (req.method === "GET" && url.pathname === "/api/viajes") {
    const q = clean(url.searchParams.get("q")).toLowerCase();
    const status = clean(url.searchParams.get("estado") || url.searchParams.get("status")).toLowerCase();
    const trips = db.viajes
      .map(ensureTripSimulationFields)
      .filter(trip => !q || `${trip.codigoViaje} ${trip.nombreViaje} ${trip.destino} ${trip.userEmail || ""}`.toLowerCase().includes(q))
      .filter(trip => !status || trip.estado.toLowerCase().includes(status));
    return json(res, 200, { ok: true, data: trips });
  }

  if (req.method === "GET" && url.pathname === "/api/usuarios") {
    return json(res, 200, { ok: true, data: db.usuarios });
  }

  if (req.method === "POST" && url.pathname === "/api/usuarios") {
    const body = await readBody(req);
    const uid = clean(body.uid || body.id);
    const email = clean(body.email).toLowerCase();
    if (!uid || !email) {
      return json(res, 400, { ok: false, error: "Debes enviar uid y email." });
    }
    const user = {
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
    await persistApiDoc("usuarios", uid, user, db, current => {
      const next = { usuarios: [...current.usuarios], viajes: current.viajes };
      if (index >= 0) next.usuarios[index] = { ...next.usuarios[index], ...user };
      else next.usuarios.push(user);
      return next;
    });
    return json(res, index >= 0 ? 200 : 201, { ok: true, data: user });
  }

  if (req.method === "POST" && url.pathname === "/api/viajes") {
    const body = await readBody(req);
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

    if (req.method === "PUT" && parts.length === 3) {
      const body = await readBody(req);
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

async function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(__dirname, requested));
  if (!filePath.startsWith(__dirname)) return notFound(res);

  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, withSecurityHeaders({ "Content-Type": MIME_TYPES[ext] || "application/octet-stream" }));
    res.end(data);
  } catch {
    notFound(res, "Archivo no encontrado.");
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
      return;
    }
    await serveStatic(req, res, url);
  } catch (error) {
    json(res, error.status || 500, { ok: false, error: error.message || "Error interno" });
  }
});

server.listen(PORT, () => {
  console.log(`WayTure listo en http://localhost:${PORT}`);
  console.log(`API REST lista en http://localhost:${PORT}/api/health`);
});
