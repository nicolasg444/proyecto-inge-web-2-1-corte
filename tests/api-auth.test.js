// tests/api-auth.test.js
// Pruebas de la API sin internet: un servidor local hace de Firebase Auth
// (accounts:lookup) y Firestore se desactiva (USE_FIREBASE_REST=false), asi
// que no se toca el proyecto real de Firebase.
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 3456;
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = randomBytes(32).toString("hex");
const CSRF_SECRET = randomBytes(32).toString("hex");

// Tokens que el Firebase falso acepta.
const USUARIOS_FIREBASE = {
  "idtoken-viajero": { localId: "uid-viajero", email: "viajero@ejemplo.test" },
  "idtoken-admin": { localId: "uid-admin", email: "admin@ejemplo.test" }
};

let firebaseFalso;
let servidor;
let dataDir;

const b64 = obj => Buffer.from(JSON.stringify(obj)).toString("base64url");
function firmar(payload, secreto = JWT_SECRET) {
  const base = `${b64({ alg: "HS256", typ: "JWT" })}.${b64(payload)}`;
  return `${base}.${createHmac("sha256", secreto).update(base).digest("base64url")}`;
}

async function esperarServidor() {
  for (let i = 0; i < 100; i += 1) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {
      // aun arrancando
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error("El servidor no arranco");
}

async function sesion(idToken) {
  const csrf = (await (await fetch(`${BASE}/api/auth/csrf`)).json()).data.csrfToken;
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf },
    body: JSON.stringify({ idToken, csrfToken: csrf })
  });
  const datos = await r.json();
  return { status: r.status, token: datos.data?.token, user: datos.data?.user, csrf };
}

function crearViaje({ token, csrf }, cuerpo) {
  return fetch(`${BASE}/api/viajes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-CSRF-Token": csrf },
    body: JSON.stringify(cuerpo)
  });
}

before(async () => {
  firebaseFalso = createServer((req, res) => {
    let cuerpo = "";
    req.on("data", c => { cuerpo += c; });
    req.on("end", () => {
      const { idToken } = JSON.parse(cuerpo || "{}");
      const usuario = req.url.startsWith("/accounts:lookup") && USUARIOS_FIREBASE[idToken];
      res.writeHead(usuario ? 200 : 400, { "Content-Type": "application/json" });
      res.end(JSON.stringify(usuario ? { users: [usuario] } : { error: { message: "INVALID_ID_TOKEN" } }));
    });
  });
  await new Promise(r => firebaseFalso.listen(0, "127.0.0.1", r));

  // Respaldo JSON temporal con un admin (el rol sale de aqui, no del cliente).
  dataDir = mkdtempSync(path.join(tmpdir(), "wayture-test-"));
  writeFileSync(path.join(dataDir, "wayture-api.json"), JSON.stringify({
    usuarios: [{ id: "uid-admin", uid: "uid-admin", email: "admin@ejemplo.test", rol: "admin" }],
    viajes: []
  }));

  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(REDIS_|JWT_|CSRF_|FIREBASE_|API_AUTH)/.test(k)) delete env[k];
  servidor = spawn(process.execPath, ["server.js"], {
    cwd: projectRoot,
    env: {
      ...env,
      PORT: String(PORT),
      HOST: "127.0.0.1",
      JWT_SECRET,
      CSRF_SECRET,
      FIREBASE_API_KEY: "clave-de-prueba",
      FIREBASE_AUTH_BASE_URL: `http://127.0.0.1:${firebaseFalso.address().port}`,
      USE_FIREBASE_REST: "false",
      DATA_DIR: dataDir
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  await esperarServidor();
});

after(() => {
  servidor?.kill("SIGTERM");
  firebaseFalso?.close();
  rmSync(dataDir, { recursive: true, force: true });
});

test("/health y /quien son publicos y no dependen de Firebase", async () => {
  const salud = await fetch(`${BASE}/health`);
  assert.equal(salud.status, 200);
  assert.deepEqual(await salud.json(), { estado: "ok" });
  const quien = await (await fetch(`${BASE}/quien`)).json();
  assert.ok(quien.pod);
  assert.equal(quien.version, "1.0");
});

test("GET /api/auth/csrf entrega token y csrfToken distintos en cada llamada", async () => {
  const a = (await (await fetch(`${BASE}/api/auth/csrf`)).json()).data;
  const b = (await (await fetch(`${BASE}/api/auth/csrf`)).json()).data;
  assert.ok(a.token && a.csrfToken);
  assert.notEqual(a.csrfToken, b.csrfToken);
  assert.notEqual(a.token, b.token);
});

test("sin credenciales la escritura responde 401", async () => {
  const r = await fetch(`${BASE}/api/viajes`, { method: "POST", body: "{}" });
  assert.equal(r.status, 401);
});

test("el flujo antiguo (uid/rol en el cuerpo) ya no emite tokens", async () => {
  const r = await fetch(`${BASE}/api/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ uid: "cualquiera", email: "x@x.x", rol: "admin", csrfToken: "abc" })
  });
  assert.equal(r.status, 400);
});

test("un idToken falso no obtiene sesion", async () => {
  const s = await sesion("idtoken-inventado");
  assert.equal(s.status, 401);
});

test("flujo completo csrf -> token -> POST /api/viajes = 201; identidad desde Firebase", async () => {
  const s = await sesion("idtoken-viajero");
  assert.equal(s.status, 200);
  assert.equal(s.user.uid, "uid-viajero");
  assert.equal(s.user.rol, "usuario");
  const r = await crearViaje(s, { destino: "Bogota", codigoViaje: "WT-TEST-0001", userEmail: "otro@ejemplo.test" });
  assert.equal(r.status, 201);
  // Un usuario normal no puede crear viajes a nombre de otro.
  assert.equal((await r.json()).data.userEmail, "viajero@ejemplo.test");
});

test("el rol admin sale del perfil guardado, no del cliente", async () => {
  const s = await sesion("idtoken-admin");
  assert.equal(s.user.rol, "admin");
});

test("CSRF que no coincide con el JWT -> 403", async () => {
  const s = await sesion("idtoken-viajero");
  const r = await crearViaje({ token: s.token, csrf: "csrf-equivocado" }, { destino: "X" });
  assert.equal(r.status, 403);
});

test("JWT con firma alterada, alg none, expirado, sin exp o iat futuro -> 401", async () => {
  const s = await sesion("idtoken-viajero");
  const [cab, cuerpo, firma] = s.token.split(".");
  const payload = JSON.parse(Buffer.from(cuerpo, "base64url").toString());
  const ahora = Math.floor(Date.now() / 1000);
  const falsos = {
    firmaAlterada: `${cab}.${cuerpo}.${firma[0] === "A" ? "B" : "A"}${firma.slice(1)}`,
    payloadAdmin: `${cab}.${b64({ ...payload, rol: "admin" })}.${firma}`,
    algNone: `${b64({ alg: "none", typ: "JWT" })}.${cuerpo}.`,
    expirado: firmar({ ...payload, iat: ahora - 7200, exp: ahora - 3600 }),
    sinExp: firmar({ ...payload, exp: undefined }),
    iatFuturo: firmar({ ...payload, iat: ahora + 3600 })
  };
  for (const [nombre, token] of Object.entries(falsos)) {
    const r = await crearViaje({ token, csrf: s.csrf }, { destino: "X" });
    assert.equal(r.status, 401, nombre);
  }
});

test("el token del endpoint CSRF no sirve como JWT de sesion", async () => {
  const { token, csrfToken } = (await (await fetch(`${BASE}/api/auth/csrf`)).json()).data;
  const r = await crearViaje({ token, csrf: csrfToken }, { destino: "X" });
  assert.equal(r.status, 401);
});

test("listados con emails/ubicaciones de todos: solo admin", async () => {
  const viajero = await sesion("idtoken-viajero");
  const admin = await sesion("idtoken-admin");
  for (const ruta of ["/api/usuarios", "/api/viajeros/ubicaciones"]) {
    assert.equal((await fetch(BASE + ruta)).status, 401, `${ruta} sin token`);
    assert.equal((await fetch(BASE + ruta, { headers: { Authorization: `Bearer ${viajero.token}` } })).status, 403, `${ruta} viajero`);
    assert.equal((await fetch(BASE + ruta, { headers: { Authorization: `Bearer ${admin.token}` } })).status, 200, `${ruta} admin`);
  }
});

test("un usuario no puede borrar el viaje de otro", async () => {
  const admin = await sesion("idtoken-admin");
  const r = await crearViaje(admin, { destino: "Paris", codigoViaje: "WT-TEST-ADMIN", userEmail: "admin@ejemplo.test" });
  const id = (await r.json()).data.id;
  const viajero = await sesion("idtoken-viajero");
  const borrar = await fetch(`${BASE}/api/viajes/${id}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${viajero.token}`, "X-CSRF-Token": viajero.csrf }
  });
  assert.equal(borrar.status, 403);
});

test("no se sirven archivos internos", async () => {
  for (const ruta of ["/.env", "/.git/config", "/data/wayture-api.json", "/server.js", "/config.js", "/package.json", "/tests/api-auth.test.js"]) {
    assert.equal((await fetch(BASE + ruta)).status, 404, ruta);
  }
  assert.equal((await fetch(`${BASE}/index.html`)).status, 200);
  assert.equal((await fetch(`${BASE}/js/tracking-map.js`)).status, 200);
});

test("cabeceras de seguridad en HTML y en la API", async () => {
  for (const ruta of ["/", "/api/viajes", "/health"]) {
    const h = (await fetch(BASE + ruta)).headers;
    assert.match(h.get("content-security-policy") || "", /default-src 'self'/, ruta);
    assert.equal(h.get("x-content-type-options"), "nosniff", ruta);
    assert.equal(h.get("x-frame-options"), "DENY", ruta);
  }
});

test("CORS: ningun origen externo es aceptado", async () => {
  const r = await fetch(`${BASE}/api/viajes`, { headers: { Origin: "https://malicioso.example" } });
  assert.equal(r.headers.get("access-control-allow-origin"), null);
});
