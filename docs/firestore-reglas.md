# Firestore: estado actual, problema y propuesta

> Las reglas de `firestore.rules` son una **propuesta**: no se publicaron.
> Publicarlas es un paso manual del equipo en la consola de Firebase.

## Qué se comprobó (17-nov-2026)

| Prueba | Resultado |
|---|---|
| Leer `usuarios` y `viajes` **sin iniciar sesión** (REST, solo la API key web) | **Permitido**: cualquiera puede leer perfiles (con emails) y viajes |
| Escribir en `viajes` sin iniciar sesión (lo que hacía el servidor) | **Rechazado**: `Missing or insufficient permissions` |

Consecuencias:

1. **Fuga de datos**: con la API key web, que es pública porque va en
   `js/firebase-config.js`, cualquiera lee los emails de `usuarios`.
2. **Las escrituras de la API REST nunca llegaron a Firestore.** El
   servidor escribía sin credenciales, Firestore lo rechazaba y el servidor
   solo guardaba en `data/wayture-api.json`, sin avisar: el `console.warn`
   quedaba en el log. Pasaba antes de los cambios de esta rama. Lo que la
   API "creaba" desde Postman solo existía en el JSON local.
3. **En Kubernetes, con 3 réplicas**, cada pod tiene su propio JSON. Un
   viaje creado por la API queda en un solo pod, y si la siguiente petición
   cae en otro, no lo encuentra. Por eso el smoke test falla en la lectura y
   el borrado del viaje de prueba cuando corre contra el clúster.

## Solución en dos pasos (manual)

### Paso 1: usuario "servicio" para el servidor (sin Admin SDK)

El servidor ya sabe iniciar sesión como un usuario normal de Firebase y
mandar su token a Firestore (`firebase-rest.js`, `obtenerTokenServicio`).
Para activarlo:

1. En **Firebase Console > Authentication > Usuarios > Agregar usuario**,
   crea por ejemplo `servidor-api@wayture.app` con una contraseña larga y
   aleatoria (`openssl rand -base64 24`).
2. Pega el email en `secrets/firebase_service_email.txt` y la contraseña en
   `secrets/firebase_service_password.txt`. Esos archivos ya existen vacíos
   y no se versionan.
3. Reinicia:
   - Compose: `docker compose -f compose.yaml up -d`.
   - Kubernetes: `bash scripts/k8s-up.sh` (actualiza el Secret) y
     `kubectl --context kind-waytur -n waytur rollout restart deploy/api`.
4. Copia el **UID** de ese usuario y ponlo en `firestore.rules` en lugar de
   `REEMPLAZAR_UID_DEL_USUARIO_SERVICIO`.

**No verificado**: no se probó escribir como usuario autenticado, para no
modificar datos reales. Como el frontend escribe en `viajes` con usuarios
normales, lo más probable es que las reglas actuales lo permitan. En ese
caso el paso 1 basta para que las escrituras de la API lleguen a Firestore.
Para comprobarlo después del paso 1:
1. crea un viaje con `POST /api/viajes`;
2. revisa que no aparezca `No se pudo guardar en Firebase` en
   `docker compose logs api`;
3. confirma que el viaje aparece en la consola de Firebase.

### Paso 2: publicar las reglas propuestas

1. Firebase Console > Firestore > **Reglas**. Guarda primero una copia de
   las reglas actuales.
2. Pega `firestore.rules` y usa **Rules Playground** para probar:
   - un usuario lee su perfil: permitido;
   - un usuario se pone `rol: "admin"`: denegado;
   - una lectura anónima de `usuarios`: denegada;
   - una lectura anónima de `viajes/<id>`: permitida.
3. Publica y prueba la app: registro, login, panel de usuario, panel admin,
   rastreo por código y formularios de la landing.

### Qué cambia para el frontend con las reglas propuestas

| Pantalla | Efecto |
|---|---|
| Login **por alias o nombre** (`login-page.js` lee **todos** los usuarios antes de iniciar sesión) | **Deja de funcionar**: un anónimo ya no puede listar `usuarios`. Login por email sigue igual. Para conservar el alias haría falta una colección pública `alias/{alias} → email` sin otros datos |
| Rastreo público por código | Sigue funcionando (`viajes` mantiene la lectura pública) |
| Panel admin | Igual (el admin lee todo) |
| Registro | Igual, siempre que cree el perfil con `rol: "usuario"` (ya lo hace) |

**Compromiso pendiente**: `viajes` sigue legible por cualquiera, emails
incluidos, para no romper el rastreo sin sesión. Lo correcto es hacer el
rastreo a través de la API (`GET /api/rastreo/:codigo`, con el usuario
servicio) y cerrar la lectura de `viajes` a usuarios autenticados. Es un
cambio de frontend que queda para otra iteración.

## La API key web y los secretos

- La API key web de Firebase **no es secreta** por diseño. Lo que protege
  los datos son las reglas. Aun así, conviene restringirla en **Google Cloud
  Console > APIs y servicios > Credenciales**:
  - restricción por *HTTP referrer* (tus dominios);
  - restricción por API (Identity Toolkit, Firestore, Token Service).
- En el historial de Git hay **2 API keys distintas**. Si la vieja ya no se
  usa, elimínala o restríngela en la misma pantalla.
- Los antiguos valores por defecto de `JWT_SECRET` y `CSRF_SECRET` están en
  el historial (commit `f166a88`). `config.js` ahora los **rechaza**: se usan
  los generados en `secrets/`.
