const API_TOKEN_KEY = "wayture_api_token";
const API_CSRF_KEY = "wayture_api_csrf";

function getStoredApiToken() {
  return localStorage.getItem(API_TOKEN_KEY) || "";
}

function getStoredCsrfToken() {
  return localStorage.getItem(API_CSRF_KEY) || "";
}

function clearApiSession() {
  localStorage.removeItem(API_TOKEN_KEY);
  localStorage.removeItem(API_CSRF_KEY);
}

async function fetchCsrfToken() {
  const stored = getStoredCsrfToken();
  if (stored) return stored;

  const response = await fetch("/api/auth/csrf", {
    method: "GET",
    headers: { "Accept": "application/json" }
  });

  if (!response.ok) {
    throw new Error("No se pudo obtener el token CSRF de la API.");
  }

  const result = await response.json();
  const csrf = result?.data?.csrfToken || result?.data?.token || "";
  if (!csrf) throw new Error("La API no devolvió un CSRF válido.");

  localStorage.setItem(API_CSRF_KEY, csrf);
  return csrf;
}

async function ensureApiSession(uid, email, rol = "usuario") {
  const safeEmail = String(email || "").trim();
  if (!uid && !safeEmail) return null;

  const csrfToken = await fetchCsrfToken();
  const response = await fetch("/api/auth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-CSRF-Token": csrfToken
    },
    body: JSON.stringify({ uid, email: safeEmail, rol, csrfToken })
  });

  if (!response.ok) {
    throw new Error("No se pudo iniciar la sesión de la API.");
  }

  const result = await response.json();
  const token = result?.data?.token || "";

  if (!token) {
    throw new Error("La API no devolvió un JWT válido.");
  }

  localStorage.setItem(API_TOKEN_KEY, token);
  return { token, csrfToken };
}

async function apiFetch(url, options = {}) {
  const method = String(options.method || "GET").toUpperCase();
  const headers = { ...(options.headers || {}) };

  if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    const csrfToken = await fetchCsrfToken();
    headers["X-CSRF-Token"] = csrfToken;
    const token = getStoredApiToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }

  const response = await fetch(url, { ...options, headers });
  if (!response.ok && response.status === 401) {
    clearApiSession();
  }
  return response;
}

export {
  API_TOKEN_KEY,
  API_CSRF_KEY,
  apiFetch,
  clearApiSession,
  ensureApiSession,
  fetchCsrfToken,
  getStoredApiToken,
  getStoredCsrfToken
};
