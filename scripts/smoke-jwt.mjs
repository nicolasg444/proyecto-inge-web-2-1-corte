#!/usr/bin/env node
// scripts/smoke-jwt.mjs - prueba de humo de seguridad contra un despliegue.
// Node 22+, sin dependencias (fetch y crypto nativos).
//
//   BASE_URL=http://localhost:8080 node scripts/smoke-jwt.mjs
//
// Cuenta de prueba de Firebase: SMOKE_EMAIL / SMOKE_PASSWORD (variables o el
// archivo .smoke.env de la raiz, ignorado por Git). Si no hay, se crea un
// usuario DESECHABLE en Firebase Auth (smoke-xxxx@ejemplo.test) que se borra
// al final (SMOKE_CREAR_USUARIO=0 lo impide).
// La API key web se lee de secrets/firebase_api_key.txt (o SMOKE_FIREBASE_API_KEY).
// El token expirado se firma con secrets/jwt_secret.txt (o SMOKE_JWT_SECRET_FILE).
// Nunca se imprimen tokens, contrasenas ni secretos.

import { createHmac, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), "..");

const archivoEnv = join(RAIZ, ".smoke.env");
if (existsSync(archivoEnv)) {
  for (const linea of readFileSync(archivoEnv, "utf8").split(/\r?\n/)) {
    const m = linea.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
}

const BASE = (process.env.BASE_URL || "http://localhost:8080").replace(/\/$/, "");
const leerArchivo = ruta => (existsSync(ruta) ? readFileSync(ruta, "utf8").trim() : "");
const API_KEY = process.env.SMOKE_FIREBASE_API_KEY || leerArchivo(join(RAIZ, "secrets", "firebase_api_key.txt"));
const AUTH_URL = "https://identitytoolkit.googleapis.com/v1/accounts";

let fallos = 0;
let omitidas = 0;
const ok = m => console.log(`  ✔ ${m}`);
const mal = m => { fallos++; console.log(`  ✘ ${m}`); };
const omitir = m => { omitidas++; console.log(`  - OMITIDA: ${m}`); };
const verificar = (c, m, d = "") => (c ? ok(m) : mal(`${m} ${d}`));
const titulo = t => console.log(`\n${t}`);

async function api(metodo, ruta, { token, csrf, cuerpo } = {}) {
  const headers = {};
  if (cuerpo !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  if (csrf) headers["X-CSRF-Token"] = csrf;
  const r = await fetch(BASE + ruta, { method: metodo, headers, body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo) });
  const texto = await r.text();
  let datos = texto;
  try { datos = JSON.parse(texto); } catch { /* no es JSON */ }
  return { status: r.status, headers: r.headers, datos };
}

async function firebaseAuth(metodo, cuerpo) {
  const r = await fetch(`${AUTH_URL}:${metodo}?key=${encodeURIComponent(API_KEY)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cuerpo)
  });
  const datos = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Firebase ${metodo}: ${datos.error?.message || r.status}`);
  return datos;
}

const b64 = x => Buffer.from(typeof x === "string" ? x : JSON.stringify(x)).toString("base64url");
function firmarHS256(payload, secreto) {
  const base = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${base}.${createHmac("sha256", secreto).update(base).digest("base64url")}`;
}

const creados = [];
let sesion = null;
let idTokenDesechable = null;

try {
  console.log(`Smoke test de seguridad contra ${BASE}`);
  if (!API_KEY) throw new Error("Falta la API key web de Firebase (secrets/firebase_api_key.txt)");

  titulo("1. Endpoints publicos y CSRF");
  const salud = await api("GET", "/health");
  verificar(salud.status === 200 && salud.datos?.estado === "ok", 'GET /health -> 200 {"estado":"ok"}');
  const pods = new Set();
  for (let i = 0; i < 12; i++) {
    const q = await api("GET", "/quien");
    if (q.status === 200) pods.add(`${q.datos.pod} (v${q.datos.version})`);
  }
  verificar(pods.size >= 1, `GET /quien; pods distintos en 12 llamadas: ${pods.size}`);
  console.log(`    ${[...pods].join(", ")}`);
  const c1 = (await api("GET", "/api/auth/csrf")).datos?.data || {};
  const c2 = (await api("GET", "/api/auth/csrf")).datos?.data || {};
  verificar(c1.token && c1.csrfToken, "GET /api/auth/csrf devuelve token y csrfToken");
  verificar(c1.csrfToken !== c2.csrfToken && c1.token !== c2.token, "cada llamada entrega valores distintos");

  titulo("2. Sin credenciales");
  let r = await api("POST", "/api/viajes", { cuerpo: { destino: "X" } });
  verificar(r.status === 401, "POST /api/viajes sin token -> 401", `(fue ${r.status})`);
  r = await api("POST", "/api/auth/token", { cuerpo: { uid: "cualquiera", email: "x@x.x", rol: "admin", csrfToken: c1.csrfToken } });
  verificar(r.status === 400, "POST /api/auth/token con uid/rol inventados (flujo antiguo) -> 400", `(fue ${r.status})`);
  r = await api("POST", "/api/auth/token", { cuerpo: { idToken: "falso", csrfToken: c1.csrfToken } });
  verificar(r.status === 401, "POST /api/auth/token con idToken falso -> 401", `(fue ${r.status})`);

  titulo("3. Flujo completo: Firebase -> csrf -> token -> POST /api/viajes");
  let idToken;
  if (process.env.SMOKE_EMAIL && process.env.SMOKE_PASSWORD) {
    idToken = (await firebaseAuth("signInWithPassword", { email: process.env.SMOKE_EMAIL, password: process.env.SMOKE_PASSWORD, returnSecureToken: true })).idToken;
    ok("inicio de sesion en Firebase con la cuenta de .smoke.env");
  } else if (process.env.SMOKE_CREAR_USUARIO !== "0") {
    const email = `smoke-${randomBytes(4).toString("hex")}@ejemplo.test`;
    idToken = (await firebaseAuth("signUp", { email, password: randomBytes(18).toString("base64url"), returnSecureToken: true })).idToken;
    idTokenDesechable = idToken;
    ok("usuario desechable creado en Firebase Auth (se borra al final)");
  } else {
    throw new Error("Define SMOKE_EMAIL/SMOKE_PASSWORD en .smoke.env");
  }
  const csrf = (await api("GET", "/api/auth/csrf")).datos.data.csrfToken;
  r = await api("POST", "/api/auth/token", { csrf, cuerpo: { idToken, csrfToken: csrf } });
  verificar(r.status === 200 && r.datos?.data?.token, "POST /api/auth/token con idToken real -> 200 + JWT", `(fue ${r.status})`);
  sesion = { token: r.datos.data.token, csrf, user: r.datos.data.user };
  verificar(sesion.user.rol === "usuario" || process.env.SMOKE_EMAIL, `rol tomado del perfil (no del cliente): ${sesion.user.rol}`);
  const codigo = `WT-SMOKE-${randomBytes(3).toString("hex").toUpperCase()}`;
  r = await api("POST", "/api/viajes", { ...sesion, cuerpo: { destino: "Cartagena", nombreViaje: "Viaje smoke test", codigoViaje: codigo } });
  verificar(r.status === 201, "POST /api/viajes con Authorization + X-CSRF-Token -> 201", `(fue ${r.status})`);
  if (r.datos?.data?.id) creados.push(r.datos.data.id);

  titulo("4. CSRF");
  r = await api("POST", "/api/viajes", { token: sesion.token, csrf: "csrf-que-no-coincide", cuerpo: { destino: "X" } });
  verificar(r.status === 403, "X-CSRF-Token distinto del claim csrf del JWT -> 403", `(fue ${r.status})`);
  r = await api("POST", "/api/viajes", { token: sesion.token, cuerpo: { destino: "X" } });
  verificar(r.status === 403, "sin X-CSRF-Token -> 403", `(fue ${r.status})`);

  titulo("5. JWT manipulados");
  const [cab, cuerpo, firma] = sesion.token.split(".");
  const payload = JSON.parse(Buffer.from(cuerpo, "base64url").toString());
  const pruebas = {
    "firma alterada": `${cab}.${cuerpo}.${firma[0] === "A" ? "B" : "A"}${firma.slice(1)}`,
    "payload con rol admin y firma original": `${cab}.${b64({ ...payload, rol: "admin" })}.${firma}`,
    'alg "none"': `${b64({ alg: "none", typ: "JWT" })}.${cuerpo}.`,
    "token del endpoint CSRF usado como sesion": c1.token
  };
  for (const [nombre, token] of Object.entries(pruebas)) {
    r = await api("POST", "/api/viajes", { token, csrf, cuerpo: { destino: "X" } });
    verificar(r.status === 401, `${nombre} -> 401`, `(fue ${r.status})`);
  }

  titulo("6. JWT expirado");
  const secreto = leerArchivo(process.env.SMOKE_JWT_SECRET_FILE || join(RAIZ, "secrets", "jwt_secret.txt"));
  if (!secreto) {
    omitir("no hay secrets/jwt_secret.txt");
  } else {
    const ahora = Math.floor(Date.now() / 1000);
    r = await api("POST", "/api/viajes", { token: firmarHS256({ ...payload, iat: ahora - 7200, exp: ahora - 3600 }, secreto), csrf, cuerpo: { destino: "X" } });
    verificar(r.status === 401, "token bien firmado pero vencido -> 401", `(fue ${r.status})`);
  }

  titulo("7. XSS: el payload se guarda y vuelve como texto");
  const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
  r = await api("POST", "/api/viajes", { ...sesion, cuerpo: { destino: "Lima", nombreViaje: xss, codigoViaje: `${codigo}-X` } });
  if (r.datos?.data?.id) creados.push(r.datos.data.id);
  const leido = await api("GET", `/api/viajes/${encodeURIComponent(r.datos?.data?.id)}`, { token: sesion.token });
  verificar(leido.datos?.data?.nombreViaje === xss, "nombreViaje vuelve literal (no se interpreta)");
  verificar((leido.headers.get("content-type") || "").startsWith("application/json"), "Content-Type: application/json");
  verificar(leido.headers.get("x-content-type-options") === "nosniff", "X-Content-Type-Options: nosniff");
  const mapa = await fetch(`${BASE}/js/tracking-map.js`).then(x => x.text());
  verificar(/bindPopup\(escHtml\(/.test(mapa) && /bindTooltip\(escHtml\(/.test(mapa), "tracking-map.js escapa con escHtml() en bindPopup/bindTooltip");

  titulo("8. Cabeceras de seguridad (HTML via Nginx y API)");
  for (const [nombre, ruta, token] of [["HTML /", "/", null], ["API /api/viajes", "/api/viajes", sesion.token], ["API /health", "/health", null]]) {
    const h = (await fetch(BASE + ruta, { headers: token ? { Authorization: `Bearer ${token}` } : {} })).headers;
    const csp = h.get("content-security-policy") || "";
    verificar(csp.includes("default-src 'self'") && csp.includes("unpkg.com") && csp.includes("gstatic.com"), `${nombre}: CSP con los origenes permitidos`);
    verificar(!csp.includes(", default-src"), `${nombre}: una sola CSP (sin duplicar)`);
    verificar(h.get("x-content-type-options") === "nosniff", `${nombre}: X-Content-Type-Options`);
    verificar(h.get("x-frame-options") === "DENY", `${nombre}: X-Frame-Options sin duplicar`, `(fue "${h.get("x-frame-options")}")`);
    verificar(!/\d/.test(h.get("server") || ""), `${nombre}: Server sin version`);
  }

  titulo("9. Autorizacion y archivos internos");
  r = await api("GET", "/api/usuarios", { token: sesion.token });
  verificar(r.status === 403 || sesion.user.rol === "admin", "GET /api/usuarios como usuario normal -> 403", `(fue ${r.status})`);
  for (const ruta of ["/.env", "/.git/config", "/data/wayture-api.json", "/server.js", "/package.json"]) {
    const s = (await fetch(BASE + ruta)).status;
    verificar(s === 404, `${ruta} no se sirve -> 404`, `(fue ${s})`);
  }

  titulo("10. Cache Redis");
  const l1 = await api("GET", "/api/viajes", { token: sesion.token });
  const l2 = await api("GET", "/api/viajes", { token: sesion.token });
  if (l2.headers.get("x-cache") === "HIT") {
    ok(`listado: ${l1.headers.get("x-cache")} -> HIT (segunda lectura desde Redis)`);
    r = await api("PATCH", `/api/viajes/${encodeURIComponent(creados[0])}/estado`, { ...sesion, cuerpo: { estado: "En ruta", progreso: 10 } });
    verificar(r.status === 200, "PATCH /api/viajes/:id/estado -> 200");
    const l3 = await api("GET", "/api/viajes", { token: sesion.token });
    verificar(l3.headers.get("x-cache") === "MISS", "la escritura invalida la cache (siguiente lectura MISS)");
  } else {
    omitir(`cache no activa (X-Cache: ${l1.headers.get("x-cache")} -> ${l2.headers.get("x-cache")})`);
  }
} catch (error) {
  mal(`error inesperado: ${error.message}`);
} finally {
  titulo("11. Limpieza");
  for (const id of creados) {
    const d = await api("DELETE", `/api/viajes/${encodeURIComponent(id)}`, sesion || {}).catch(() => ({ status: 0 }));
    verificar(d.status === 200, `DELETE /api/viajes/${id}`);
  }
  if (idTokenDesechable) {
    try {
      await firebaseAuth("delete", { idToken: idTokenDesechable });
      ok("usuario desechable borrado de Firebase Auth");
    } catch (error) {
      mal(`no se pudo borrar el usuario desechable: ${error.message}`);
    }
  }
  console.log(`\nResultado: ${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}${omitidas ? ` (${omitidas} omitida(s))` : ""}`);
  process.exitCode = fallos === 0 ? 0 : 1;
}
