(async () => {
  const csrfRes = await fetch('http://localhost:3000/api/auth/csrf');
  const csrfData = await csrfRes.json();
  const csrfToken = csrfData.data.csrfToken;

  const tokenRes = await fetch('http://localhost:3000/api/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      uid: 'test-uid',
      email: 'test@wayture.com',
      rol: 'usuario',
      csrfToken
    })
  });
  const tokenData = await tokenRes.json();
  const jwt = tokenData.data.token;

  const res = await fetch('http://localhost:3000/api/viajes', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + jwt,
      'X-CSRF-Token': csrfToken
    },
    body: JSON.stringify({ nombre: 'Viaje de prueba CSRF', destino: 'Test' })
  });
  console.log('STATUS', res.status);
  console.log(await res.text());
})();
