import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

async function waitForServer(port) {
  for (let i = 0; i < 50; i += 1) {
    try {
      const response = await fetch(`http://localhost:${port}/api/health`);
      if (response.ok) return;
    } catch {
      // esperar a que el servidor arranque
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Servidor no respondió en puerto ${port}`);
}

test('la API expone soporte de JWT y CSRF', async () => {
  const server = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: '3456', API_AUTH_ENABLED: 'true', JWT_SECRET: 'test-secret', CSRF_SECRET: 'csrf-secret' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  try {
    await waitForServer(3456);

    const csrfRes = await fetch('http://localhost:3456/api/auth/csrf', { method: 'GET' });
    assert.equal(csrfRes.status, 200, 'La ruta de CSRF debe responder 200');
    const csrfData = await csrfRes.json();
    assert.ok(csrfData.data && csrfData.data.token, 'Debe devolver un token CSRF');

    const loginRes = await fetch('http://localhost:3456/api/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfData.data.csrfToken },
      body: JSON.stringify({ uid: 'demo-user', email: 'demo@wayture.com', rol: 'usuario', csrfToken: csrfData.data.csrfToken })
    });

    assert.equal(loginRes.status, 200, 'La emisión de token debe responder 200');
    const loginData = await loginRes.json();
    assert.ok(loginData.data && loginData.data.token, 'Debe devolver un JWT');

    const uniqueCode = `WT-PRUEBA-${Date.now().toString(36).toUpperCase()}`;
    const protectedRes = await fetch('http://localhost:3456/api/viajes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${loginData.data.token}`,
        'X-CSRF-Token': csrfData.data.csrfToken
      },
      body: JSON.stringify({
        destino: 'Bogota',
        origen: 'Medellin',
        nombreViaje: 'Prueba JWT+CSRF',
        codigoViaje: uniqueCode
      })
    });

    assert.equal(protectedRes.status, 201, 'La creación de viaje protegida debe responder 201 con JWT y CSRF válidos');
  } finally {
    server.kill('SIGTERM');
  }
});
