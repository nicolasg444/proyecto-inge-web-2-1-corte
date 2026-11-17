# Decisiones técnicas de WayTure

Cada decisión responde tres preguntas: **qué hace**, **por qué** y **qué se
descartó**. Los archivos tienen además comentarios en las líneas no
obvias. Las cifras salen de mediciones reales en esta rama.

---

## 0. Hallazgos que motivaron cambios en el código

| # | Hallazgo (antes) | Cómo se comprobó | Corrección |
|---|---|---|---|
| 1 | `POST /api/auth/token` firmaba un JWT con el `uid`, el email y el **rol** que enviara el cliente | `{"uid":"x","rol":"admin"}` devolvía un JWT de admin | El servidor verifica el `idToken` de Firebase (`accounts:lookup`) y saca el rol del perfil en Firestore |
| 2 | La autenticación de la API estaba **apagada**: `npm start` no cargaba `.env` | `POST /api/viajes` sin token devolvía 201 | Activada por defecto; `npm start` usa `--env-file-if-exists=.env` |
| 3 | El servidor servía **toda** la carpeta | `/.env`, `/.git/config`, `/data/wayture-api.json` y `/server.js` respondían 200 | Lista blanca de estáticos en Node; en contenedores Nginx solo tiene los archivos públicos |
| 4 | `/api/usuarios` y `/api/viajeros/ubicaciones` eran públicos (emails y GPS) | Respondían 200 sin token | Solo admin |
| 5 | Secretos por defecto escritos en el código (`JWT_SECRET`, `CSRF_SECRET`) y la API key fija en `firebase-rest.js` | Lectura del código y del historial de Git | `leerSecreto()`: sin secreto la app no arranca, y rechaza los valores viejos |
| 6 | `data/wayture-api.json` versionado, con emails reales | `git ls-files` | `git rm --cached` y agregado a `.gitignore` |
| 7 | CSRF comparado con `===`; JWT aceptado sin `exp` | Lectura del código | `timingSafeEqual`; `exp` e `iat` obligatorios |
| 8 | CORS `*` junto con `Allow-Credentials: true` (combinación inválida) | Lectura del código | Sin CORS salvo `CORS_ORIGINS` |
| 9 | Firestore: `usuarios` legible sin sesión; las escrituras anónimas del servidor se rechazaban **en silencio** | Lectura anónima por REST; log `Missing or insufficient permissions` | Usuario servicio opcional y propuesta de reglas ([docs/firestore-reglas.md](docs/firestore-reglas.md)) |

---

## 1. Configuración y secretos

### 1.1 `leerSecreto(NOMBRE)`: primero `NOMBRE_FILE`, luego `NOMBRE`; si falta, no arranca
- **Por qué archivos**: Docker Compose y Kubernetes entregan los secretos
  como archivos en `/run/secrets`. Una variable de entorno aparece en
  `docker inspect`, en `/proc/<pid>/environ` y en volcados de error; un
  archivo no. Comprobado: `docker inspect` solo muestra las rutas
  `*_FILE`.
- **Por qué fallar rápido**: un secreto con valor por defecto es un secreto
  **público**. Los valores viejos están en Git (commit `f166a88`), y con
  ellos cualquiera podía firmar JWT válidos.
- **`JWT_SECRET` de 32 caracteres o más**: HMAC-SHA256 con una clave corta
  se puede romper por fuerza bruta sin conexión.
- **`CSRF_SECRET` distinto de `JWT_SECRET`**: `/api/auth/csrf` entrega a
  cualquiera un token firmado. Si se firmara con la misma clave, ese token
  pasaría como JWT de sesión. Además se marca `typ: "csrf"` y la sesión lo
  rechaza; está probado.
- **Descartado**: dotenv u otra dependencia. Node 22 ya trae
  `--env-file-if-exists`.

### 1.2 Configuración no secreta con valores por defecto de siempre
`PORT=3000` en `npm start` (8000 en contenedores), `HOST=0.0.0.0`,
`DATA_DIR=./data`, `FIREBASE_PROJECT_ID`, `APP_VERSION=1.0`,
`USE_FIREBASE_REST=true` y `API_AUTH_ENABLED=true`.

### 1.3 La API key web de Firebase como "secreto"
- No es secreta por diseño: el navegador la recibe en
  `js/firebase-config.js`. Se lee como secreto para que no quede **fija en
  el código del servidor** y se pueda cambiar sin tocar código.
  `generar-secretos.sh` la copia de la configuración web del propio
  proyecto; no la inventa.
- Lo que de verdad protege los datos son las **reglas de Firestore** y la
  **restricción de la key** en Google Cloud (manual).

### 1.4 Permisos de `secrets/`: carpeta 700 y archivos 644
- Sin Swarm, los secretos de Compose son *bind mounts* que conservan el
  dueño del anfitrión. El proceso del contenedor (UID 10001, 999) necesita
  leerlos. La carpeta 700 impide el acceso a otros usuarios del anfitrión.

---

## 2. Autenticación (JWT + CSRF)

### 2.1 Flujo
1. `GET /api/auth/csrf` entrega un `csrfToken` aleatorio, distinto en cada
   llamada.
2. `POST /api/auth/token {idToken, csrfToken}`: el servidor verifica el
   `idToken` con **Firebase `accounts:lookup`**, sin Admin SDK.
   - Firebase solo responde si el token es auténtico, está vigente y
     pertenece al proyecto.
   - El `uid` y el email salen de **esa** respuesta.
   - El rol sale del perfil en Firestore, leído con el propio `idToken`
     del usuario.
3. El JWT propio lleva `sub`, `uid`, `email`, `rol`, `csrf`, `iat` y `exp`.
4. Escrituras: `Authorization: Bearer <JWT>` más `X-CSRF-Token`, que debe
   coincidir con el claim `csrf` en tiempo constante.

### 2.2 Verificación del JWT
- Solo `alg: HS256`. `none` y cualquier otro algoritmo se rechazan.
- Firma comparada con `crypto.timingSafeEqual`, que no filtra por tiempos
  cuántos caracteres coinciden.
- `exp` obligatorio y en el futuro; `iat` obligatorio y no en el futuro (60
  s de margen).
- Probado: firma alterada, payload alterado, `none`, expirado, sin `exp`,
  `iat` futuro y token CSRF usado como sesión dan **401** (`npm test` y
  smoke).

### 2.3 Sin estado: funciona con varias réplicas
- Nada se guarda en memoria del pod: ni sesiones ni tokens CSRF. Cualquier
  réplica con el mismo `JWT_SECRET` valida cualquier token. Comprobado en
  kind: los 3 pods respondieron dentro del mismo flujo de login y escritura.

### 2.4 Honestidad sobre CSRF
- Como el JWT viaja en `Authorization` y no en una cookie, el navegador no lo
  adjunta solo a peticiones de otros sitios. El CSRF clásico no aplica, y el
  token CSRF es defensa en profundidad.
- El riesgo real con tokens en `localStorage` es el **XSS**. Por eso pesan
  la CSP, `escHtml()` en Leaflet y la lista blanca de estáticos.

### 2.5 Autorización
- `/api/usuarios` y `/api/viajeros/ubicaciones` exponen emails y GPS de
  todos los viajeros: solo admin.
- Un usuario normal solo crea viajes a su nombre (el `userEmail` sale del
  JWT) y solo modifica o borra los suyos.
- `/api/rastreo/:codigo` sigue siendo público, porque el rastreo se
  comparte por código.

---

## 3. Imágenes Docker

### 3.1 `node:22.21.1-alpine3.22` y `nginxinc/nginx-unprivileged:1.30.0-alpine`, versiones fijas
- `:latest` cambia sin aviso: el mismo Dockerfile produciría otra imagen
  mañana.

### 3.2 API multi-etapa: `deps` → `test` → `runtime`
- `deps`: primero solo `package.json` y `package-lock.json`, luego
  `npm ci --omit=dev`.
- `test`: ejecuta `npm test`; si falla, el build falla.
- `runtime`: copia solo `node_modules` de producción y los 5 archivos del
  servidor.
- **Medido** ([docs/evidencia/03-medicion.md](docs/evidencia/03-medicion.md)):
  - ingenua 1,99 GB contra optimizada 229 MB;
  - reconstrucción tras tocar código: 9,9 s contra 1,8 s;
  - `root` contra `app`;
  - secreto en `docker history`: sí contra no.

### 3.3 Listas blancas de contexto por Dockerfile
- `docker/api.Dockerfile.dockerignore` y `docker/web.Dockerfile.dockerignore`
  empiezan con `*` (excluir todo) y permiten solo lo necesario. Así es
  **imposible** que `.env`, `.git`, `secrets/` o `data/` entren a una
  imagen.
- **Descartado**: un `.dockerignore` de "lo que no hay que copiar", porque es
  fácil olvidar algo.

### 3.4 Usuario 10001 y código propiedad de root
- `USER app`; el código se copia **sin** `--chown`. Si explotan la app, no
  puede reescribir el código que se ejecuta.
- `/data` se crea con dueño `app` **antes** de usarse como volumen: un
  volumen nuevo hereda ese dueño.

### 3.5 `CMD ["node","server.js"]` en forma exec + apagado ordenado
- Node es el PID 1 y recibe SIGTERM. `server.js` llama a `server.close()`,
  espera a que terminen las peticiones en curso, cierra Redis y sale con 0
  (como máximo en 20 s).
- **Descartado**: la forma shell (`CMD node server.js`). `/bin/sh` no
  reenvía la señal y Docker mata el proceso a los 10 s.

### 3.6 Estructura: no se movieron archivos
- Los HTML usan rutas relativas (`js/`, `css/`, `assets/`) y el servidor
  importa `js/trip-simulation.js`. Moverlos a `api/` y `web/` rompería todo
  eso. En su lugar, los dos Dockerfiles viven en `docker/` con contexto en la
  raíz, y cada uno copia solo lo suyo.

---

## 4. Nginx

### 4.1 Cabeceras: la misma política que `server.js`, solo en los estáticos
- Al servir los estáticos desde Nginx, las cabeceras de `server.js` se
  perderían. `docker/nginx/security-headers.conf` repite **exactamente** la
  misma CSP, con los orígenes de unpkg.com, gstatic.com y googleapis.com,
  OpenStreetMap, Google Maps y Firebase.
- Se incluye en `location /` y **no** a nivel `server`. Si estuviera en
  `server`, se sumaría a las respuestas de la API, que ya traen las suyas, y
  quedarían duplicadas: dos CSP (el navegador aplica la intersección) y
  `X-Frame-Options: DENY, DENY`, que es inválido. El smoke test verifica que
  no haya duplicados.

### 4.2 `proxy_pass http://api:8000;` sin barra final
- Con `http://api:8000/` Nginx quitaría el prefijo `/api/` y la API
  respondería 404.

### 4.3 Sin fallback a `index.html`
- WayTure es multipágina, sin enrutador del lado del cliente. Una ruta
  inexistente debe dar un 404 real.

### 4.4 `/salud-web` propio
- La salud de la web no depende de la API. Si dependiera, una caída de la
  API reiniciaría también las réplicas web.

---

## 5. Docker Compose

### 5.1 Redes
- `redis`: solo en `backend` (`internal: true`).
- `api`: en `backend` y en `frontend`.
- `web`: solo en `frontend`.
- Solo `web` publica un puerto.

Por qué:
- La web ni resuelve el nombre `redis` (comprobado: `bad address`).
- La API necesita `frontend` también para **salir a internet** hacia
  Firebase, porque `backend` es interna. Comprobado: llega a Google.

### 5.2 `read_only`, `tmpfs /tmp`, `cap_drop: ALL`, `no-new-privileges`
- Raíz de solo lectura, comprobada con `touch` (da `Read-only file system`),
  sin capabilities de Linux y sin escalada por binarios setuid.

### 5.3 Redis con `user: "999:1000"`
- El entrypoint oficial solo baja de root si el comando empieza por
  `redis-server`. Con `sh -c`, que hace falta para leer el secreto, seguiría
  como root.
- El healthcheck hace un `PING` autenticado con `REDISCLI_AUTH`.

### 5.4 Volumen `waytur-data` en `DATA_DIR`
- Es el respaldo JSON, un **modo degradado**: solo se usa si Firestore falla
  y no se sincroniza de vuelta. `down` lo conserva; `down -v` lo borra.

---

## 6. Redis (caché)

- **Qué**: guarda el listado de `viajes` que usa `GET /api/viajes`, con TTL
  de 30 s (`CACHE_TTL`). Toda escritura de viajes lo invalida. La cabecera
  `X-Cache: HIT/MISS` permite demostrarlo.
- **Clave global y no por usuario**: el listado es el mismo para todo
  usuario autenticado. Una clave por usuario no protegería nada y dejaría a
  los demás viendo datos viejos tras una escritura. Si algún día se filtra
  por usuario, la clave debe incluir el `uid` del JWT (`claveUsuario()`).
- **Degradación**:
  - `disableOfflineQueue` hace que un comando falle al instante en lugar de
    esperar a que Redis vuelva;
  - cada operación tiene un límite de 300 ms;
  - la reconexión ocurre en segundo plano;
  - se registra como mucho una advertencia cada 10 s, sin datos sensibles;
  - la caché nunca provoca un 500.
- **Librería `redis` (node-redis) y no el protocolo a mano**: reconexión,
  timeouts, autenticación y TLS (necesario para Azure Cache for Redis) son
  infraestructura donde un error sería silencioso.
- **Importación dinámica**: si el paquete no está instalado, la caché queda
  desactivada y la API funciona igual.
- **Sin persistencia en Kubernetes**: es una copia de 30 s; Firestore es la
  fuente de verdad.

---

## 7. Kubernetes

### 7.1 Namespace con Pod Security `restricted`
- El API server rechaza pods sin endurecer. Comprobado: `kubectl run intruso`
  da `Forbidden`.

### 7.2 `securityContext` de la API
- `runAsNonRoot`, `runAsUser: 10001`, `allowPrivilegeEscalation: false`,
  `readOnlyRootFilesystem: true`, `drop: [ALL]`, `seccomp RuntimeDefault`.
- `fsGroup: 10001` y `defaultMode: 0440` hacen que los secretos solo los lea
  el grupo de la app.

### 7.3 `automountServiceAccountToken: false` y `enableServiceLinks: false`
- **Token**: Kubernetes lo montaría en `/var/run/secrets/...`, y `/var/run`
  es `/run`. Chocaría con el volumen de secretos de solo lectura y el
  contenedor no arrancaría. Además, la app no habla con la API de Kubernetes
  y un token montado es una credencial robable.
- **Service links**: el Service `redis` inyectaría
  `REDIS_PORT=tcp://10.96.x.x:6379`, que pisa la configuración.

### 7.4 Secret creado por script, no en manifiestos
- `k8s-up.sh` lo crea desde `secrets/` con `--dry-run=client -o yaml |
  apply`, que es idempotente. Cada pod monta solo las claves que usa
  (`items:`).
- Un Secret de Kubernetes es base64, **no** cifrado. En Azure se reemplaza
  por Key Vault con el CSI Driver.

### 7.5 Probes
| Probe | Para qué | Si falla |
|---|---|---|
| `startupProbe` (60 s) | Dar tiempo a arrancar | Sigue esperando y después reinicia |
| `readinessProbe` | Decidir si el pod recibe tráfico | Lo saca del Service, sin reiniciar |
| `livenessProbe` | Detectar un proceso colgado | Reinicia el contenedor |

Las tres usan `/health`, que **no** consulta Firebase ni Redis: si
dependiera de ellos, una caída de Firebase reiniciaría las 3 réplicas en
bucle.

### 7.6 Rolling update sin caídas
- `maxUnavailable: 0`, `maxSurge: 1`, `preStop: sleep 5` y
  `terminationGracePeriodSeconds: 30`. El periodo de gracia debe ser mayor
  que el preStop (5 s) más el cierre de `server.js` (como máximo 20 s).
- **Por qué el preStop**: Kubernetes envía SIGTERM y **en paralelo** quita el
  pod de los Endpoints. Sin la espera, el pod cerraría antes de que
  kube-proxy deje de enviarle tráfico.
- **Medido**: 1.0 → 1.1 dio 31 OK y **0 FALLO**; el `rollout undo` dio 29 OK
  y **0 FALLO**.
- **`APP_VERSION` viene de la imagen**, no del manifiesto. Si estuviera en
  el manifiesto, `set image ... 1.1` seguiría diciendo 1.0.

### 7.7 PDB `minAvailable: 2`
- **Medido**: durante el `drain`, Kubernetes respondió "Cannot evict pod as it
  would violate the pod's disruption budget", desalojó de a uno y hubo 0
  fallos.
- Solo protege de interrupciones voluntarias. Al hacer `uncordon`, los pods
  no vuelven solos a ese nodo.

### 7.8 `topologySpreadConstraints`
- `maxSkew: 1` por `kubernetes.io/hostname` con `ScheduleAnyway` reparte las
  3 réplicas entre los 2 workers (2 y 1).
- `matchLabelKeys: [pod-template-hash]` calcula el reparto por versión
  durante un rollout.
- En Azure se usaría por zona (`topology.kubernetes.io/zone`).

### 7.9 requests/limits y QoS
- **API**: requests `100m/128Mi`, limits `500m/256Mi`.
- **QoS Burstable** (comprobado) porque requests ≠ limits.
- **Para Guaranteed**: requests **igual** a limits en CPU y memoria, en
  todos los contenedores del pod (p. ej. `500m/256Mi` en ambos). Es más
  predecible, pero reserva más recursos.
- **Laboratorio**:
  - `glotona` termina en OOMKilled (código 137): el límite de memoria se
    hace cumplir matando el proceso;
  - `api-gigante` queda Pending por "Insufficient cpu": requests es una
    reserva que debe caber en algún nodo.

### 7.10 LimitRange sin `max`, numerado 05
- Da valores por defecto a pods sin `resources`. Todos los manifiestos
  declaran los suyos, así que aplicarlo después de los Deployments no cambia
  nada. Sin `max`, `api-gigante` queda Pending en lugar de ser rechazado.

### 7.11 Respaldo JSON en un `emptyDir` por pod: limitación real
- Cada réplica tiene **su propio** respaldo. En modo local
  (`USE_FIREBASE_REST=false`), un viaje creado en un pod no existe en los
  otros. Medido: el smoke test contra kind falla en **entre 2 y 4**
  comprobaciones, según a qué pod caiga cada petición. Siempre son las que
  leen, modifican (`PATCH`) o borran el viaje recién creado. Si el `PATCH`
  cae en un pod sin el viaje, responde 404 y la caché no se invalida.
  Todas las demás (JWT, CSRF, cabeceras, autorización, caché compartida)
  pasan.
- La solución es que Firestore sea el almacén compartido, lo que requiere el
  usuario servicio ([docs/firestore-reglas.md](docs/firestore-reglas.md)).

### 7.12 Puertos de kind
- NodePort 30080 publicado en `127.0.0.1:8082`. No en 8080: Compose usa el
  8080 y en el equipo de desarrollo lo ocupa Apache.
