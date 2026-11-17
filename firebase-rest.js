// firebase-rest.js
// Acceso a Firebase por API REST (sin Admin SDK).
// La clave web y el projectId vienen de config.js: nada fijo en el codigo.

import config from "./config.js";

const FIRESTORE_BASE_URL = `${config.firestoreBaseUrl}/projects/${config.firebaseProjectId}/databases/(default)/documents`;
// Sin timeout, un Firebase lento dejaria la peticion del usuario colgada.
const TIMEOUT_MS = 8000;

function firestoreUrl(path) {
  return `${FIRESTORE_BASE_URL}/${path}?key=${encodeURIComponent(config.firebaseApiKey)}`;
}

function toFirestoreValue(value) {
  if (value === null || typeof value === "undefined") return { nullValue: null };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(toFirestoreValue) } };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") {
    return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  }
  if (typeof value === "object") {
    return {
      mapValue: {
        fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toFirestoreValue(item)]))
      }
    };
  }
  return { stringValue: String(value) };
}

function fromFirestoreValue(value = {}) {
  if ("stringValue" in value) return value.stringValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("booleanValue" in value) return Boolean(value.booleanValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("nullValue" in value) return null;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(fromFirestoreValue);
  if ("mapValue" in value) {
    return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, fromFirestoreValue(item)]));
  }
  return null;
}

function docFromFirestore(doc = {}) {
  const id = String(doc.name || "").split("/").pop();
  const data = Object.fromEntries(Object.entries(doc.fields || {}).map(([key, value]) => [key, fromFirestoreValue(value)]));
  return { id: data.id || id, ...data };
}

function docToFirestore(data = {}) {
  return {
    fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, toFirestoreValue(value)]))
  };
}

async function requestFirestore(path, options = {}, idToken = null) {
  // Con un idToken (del usuario o del usuario "servicio") Firestore aplica sus
  // reglas de seguridad como ese usuario; sin el, como anonimo.
  const token = idToken || await obtenerTokenServicio();
  const response = await fetch(firestoreUrl(path), {
    ...options,
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {})
    }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Firebase rechazo la peticion.");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function listFirebaseCollection(collection) {
  const payload = await requestFirestore(collection);
  return (payload.documents || []).map(docFromFirestore);
}

export async function getFirebaseDoc(collection, id, idToken = null) {
  const payload = await requestFirestore(`${collection}/${encodeURIComponent(id)}`, {}, idToken);
  return docFromFirestore(payload);
}

export async function setFirebaseDoc(collection, id, data) {
  const payload = await requestFirestore(`${collection}/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(docToFirestore({ ...data, id }))
  });
  return docFromFirestore(payload);
}

export async function deleteFirebaseDoc(collection, id) {
  await requestFirestore(`${collection}/${encodeURIComponent(id)}`, { method: "DELETE" });
  return true;
}

// ---------------------------------------------------------------------------
// Firebase Authentication por REST
// ---------------------------------------------------------------------------

async function requestAuth(metodo, cuerpo) {
  const response = await fetch(
    `${config.firebaseAuthBaseUrl}/accounts:${metodo}?key=${encodeURIComponent(config.firebaseApiKey)}`,
    {
      method: "POST",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo)
    }
  );
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error?.message || "Firebase Auth rechazo la peticion.");
    error.status = response.status;
    throw error;
  }
  return payload;
}

/**
 * Verifica un idToken de Firebase con accounts:lookup y devuelve
 * { uid, email, emailVerified }. Firebase solo responde si el token es
 * autentico, no expiro y pertenece a este proyecto: la identidad sale de
 * Firebase, nunca de lo que el cliente diga en el cuerpo de la peticion.
 */
export async function verificarIdToken(idToken) {
  const payload = await requestAuth("lookup", { idToken });
  const usuario = payload.users?.[0];
  if (!usuario?.localId) throw new Error("idToken sin usuario");
  return {
    uid: usuario.localId,
    email: String(usuario.email || "").toLowerCase(),
    emailVerified: Boolean(usuario.emailVerified)
  };
}

// --- Usuario "servicio" (opcional) -----------------------------------------
// Permite que el servidor escriba en Firestore cuando las reglas exigen
// autenticacion, sin Admin SDK: inicia sesion como un usuario normal de
// Firebase cuyo uid tiene permisos en las reglas (docs/firestore-reglas.md).
// El token dura 1 h; se renueva 5 min antes de vencer.
let tokenServicio = null;
let venceServicio = 0;

async function obtenerTokenServicio() {
  if (!config.firebaseServiceEmail) return null;
  if (tokenServicio && Date.now() < venceServicio) return tokenServicio;
  const payload = await requestAuth("signInWithPassword", {
    email: config.firebaseServiceEmail,
    password: config.firebaseServicePassword,
    returnSecureToken: true
  });
  tokenServicio = payload.idToken;
  venceServicio = Date.now() + (Number(payload.expiresIn || 3600) - 300) * 1000;
  return tokenServicio;
}
