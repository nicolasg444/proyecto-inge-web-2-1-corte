// test-csrf.js - prueba manual rapida del flujo JWT + CSRF.
// El flujo cambio: /api/auth/token ya no acepta uid/email/rol del cliente,
// sino el idToken de Firebase (verificado con accounts:lookup). Para probarlo
// hace falta iniciar sesion de verdad en Firebase; eso lo hace el smoke test:
//
//   BASE_URL=http://localhost:3000 node scripts/smoke-jwt.mjs
//
// Este script solo comprueba lo que no requiere cuenta:
//   node test-csrf.js            (con el servidor corriendo en :3000)
const BASE = process.env.BASE_URL || "http://localhost:3000";

const csrf = await (await fetch(`${BASE}/api/auth/csrf`)).json();
console.log("CSRF emitido:", Boolean(csrf.data?.csrfToken));

const sinToken = await fetch(`${BASE}/api/viajes`, {
  method: "POST",
  headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.data.csrfToken },
  body: JSON.stringify({ destino: "Test" })
});
console.log("POST /api/viajes sin JWT ->", sinToken.status, "(esperado 401)");

const flujoViejo = await fetch(`${BASE}/api/auth/token`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ uid: "test-uid", rol: "admin", csrfToken: csrf.data.csrfToken })
});
console.log("Token con uid/rol inventados ->", flujoViejo.status, "(esperado 400)");
