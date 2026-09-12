# Salmos Café Loyalty

Programa de lealtad de **Salmos Café**: una SPA (React) para clientes, staff y
admin donde cada compra elegible suma una visita y la **8ª visita** gana un
café gratis. La cuenta del cliente vive en **Supabase** (Auth + Postgres +
Edge Functions) y se sincroniza con el registro de clientes del **POS
Loyverse** (crear, vincular y actualizar) sin duplicados.

El proyecto está en **desarrollo activo**: la base, la autenticación de
cliente y la sincronización con Loyverse están implementadas; el motor de
lealtad funciona con reglas reales, pero todavía sobre datos en memoria
hasta migrarlo a Supabase. **No está "production complete".**

## Latest checkpoint

Estado documental a esta fecha (**2026-09-12**). Últimos checkpoints
confirmados en el remoto `main`:

- `c32a989` — `feat: add branded Supabase email templates`
- `71e83bf` — `docs: document auth environment variables`

> Nota: los commits listados son los últimos confirmados en remoto. Esta
> actualización de `README.md` aún no está commiteada ni sincronizada.

## Project Status

- **En desarrollo activo.**
- ✅ Base funcional: app + motor de fidelización real (reglas verificadas por tests).
- ✅ Autenticación de cliente en Supabase (correo/teléfono + contraseña, OTP solo para recuperación, Google).
- ✅ Sincronización Loyverse: crear, vincular y **actualizar conservadoramente** a clientes existentes (Fase C — desplegado y validado en producción).
- ✅ **Navegación real por URL** (`/`, `/Staff`, `/Admin`) y **UI de Cliente/Auth limpia** (sin selector de demo; login "Bienvenido"; icono de Google).
- ✅ **Desplegado y validado en producción**: migraciones `0001`–`0006` aplicadas en el ambiente real y Edge Function `loyverse-customers` activa (`verify_jwt = true`).
- ✅ **Corrección de concurrencia Loyverse** validada con QA real: 2 invocaciones simultáneas → solo una procede; la perdedora responde `409 loyverse_sync_in_progress` (retriable) sin crear cliente duplicado.
- ✅ **Templates de email branded** para Supabase Auth en `email-templates/` (confirm-signup, reset-password, otp, change-email, welcome) + scripts `scripts/build-templates-payload.py` y `scripts/patch-email-templates.ps1`; el sistema legacy `supabase/templates/` fue eliminado.
- ✅ **Variables de entorno documentadas** en `.env.example`: SMTP custom (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_ADMIN_EMAIL`/`SMTP_SENDER_NAME`) y Google OAuth (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). Los secretos reales **jamás** se guardan en Git y `.env` permanece gitignored.
- ⏳ Siguiente paso: migrar el motor de lealtad a Supabase.

## Development Status

| Fase | Estado | Contenido |
|---|---|---|
| Fase A — Foundation | ✅ | Estructura de la app, arquitectura `services/`, reglas de lealtad (sobre mock) |
| Fase B — Authentication | ✅ | Supabase Auth real de cliente |
| Fase C — Loyverse Sync | ✅ | Crear/vincular/actualizar clientes sin duplicados, incl. claim atómico de concurrencia (código + tests + despliegue + QA real) |
| Fase D — Loyalty | ⏳ | Motor sobre mock → migrar a Supabase |
| Fase E — Sales / POS | ⏳ | `ManualSalesAdapter` hoy; ventas Loyverse no conectadas |

## Roadmap

- Foundation ✅
- Authentication ✅
- Loyverse integration ✅
- Loyverse customer sync ✅
- Branded email templates ✅
- Loyalty engine ⏳
- Customer loyalty experience ⏳
- Sales / POS integration ⏳
- Production hardening ⏳

## Tech Stack

- **React 18 + Vite 6** (SPA)
- **Supabase**: Auth · PostgreSQL 17 · Edge Functions (Deno)
- **Loyverse API (v1.0)** — solo server-side, desde la Edge Function
- **Tests**: test runner nativo de Node (`node --test`)

## Reglas de negocio implementadas

- Compra mínima válida: **$50 MXN**.
- Máximo **1 visita válida por cliente por día** (across ambas sucursales).
- Recompensa en la **8ª visita**, hasta **$150 MXN**.
- La recompensa **vence a los 3 meses** — se deriva en `rewardService`
  (`available` + `now > expiresAt` → `expired`), nunca depende de un cron.
- Cancelar una venta **revierte la visita**; si esa venta generó la 8ª
  visita, la recompensa se invalida y el ciclo se reabre. Si la
  recompensa ya fue redimida, la cancelación se **bloquea sin modificar
  nada**.
- **Idempotencia** por `externalSaleId`: reenviar la misma venta reutiliza
  el resultado, nunca duplica la visita.
- Dos sucursales (`branch_1`, `branch_2`) comparten la misma
  tarjeta/ciclo del cliente.

Ver `tests/loyalty.test.mjs`, `tests/loyverse-sync.test.mjs` y
`tests/auth.test.mjs` para las reglas verificadas (correr con `npm test`).

## Tests / calidad

- **130 tests pasando** (`npm test`): motor de lealtad, flujo de auth,
  sincronización Loyverse (crear/vincular/actualizar/conflicto/concurrencia) y
  navegación por pathname.
- `npm run build` compila sin errores (hay un aviso **preexistente** de
  tamaño de chunk de Vite > 500 kB, no introducido por Fase C).
- `npm audit` reporta **0 vulnerabilidades**.
- Los scripts de email templates (`scripts/build-templates-payload.py` y `scripts/patch-email-templates.ps1`, con `-DryRun` / `-ValidateRemoteTemplate`) validan de forma determinista que el payload enviado a Supabase coincide byte a byte con `email-templates/` y los subjects de `supabase/config.toml` (ver sección Email templates).

## Cómo correrlo

```bash
npm install
npm run dev
npm test        # motor de fidelización + sync Loyverse, sin navegador
```

Abre la URL que imprime Vite. Cada experiencia se elige por la URL,
**no por un selector**: `/` es **Cliente**, `/Staff` es **Staff** y
`/Admin` es **Admin** (la SPA resuelve la primera ruta del pathname, sin
dependencia de router). En producción son experiencias separadas, cada
una con su propio guard de autenticación.

Sin `.env`, el cliente corre en **modo demo** (auth mock en memoria).
Con `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` en `.env`, el registro
y login pasan a **Supabase Auth real** (ver sección de config debajo).

## Autenticación y sincronización con Loyverse

Fase 1 (completa): auth real de **cliente** sobre Supabase Auth (correo o
teléfono + contraseña), OTP **solo** como recuperación de contraseña, Google
como opción de acceso, y vínculo automático con el cliente correcto de
Loyverse, sin duplicados.

- `signUpWithEmail` → registro con **correo + contraseña** (el email es la
  identidad; el teléfono es opcional: contacto + alias de login). Si el
  proyecto tiene `email confirmations = on`, la cuenta queda pendiente hasta
  confirmar desde el correo.
- `signInWithPassword` → login con **correo o teléfono + contraseña**. El
  teléfono se resuelve al email de la cuenta con la función segura
  `resolve_email_for_login` (migración `0003`, SECURITY DEFINER) para no romper
  RLS; la validación de la contraseña la hace SIEMPRE GoTrue (Supabase), nunca
  esa función.
- `forgotPasswordStart/Verify/Resend` + `setNewPassword` → recuperación por
  **código al correo** (OTP). Sin proveedor SMS configurado, el código siempre
  va al correo, incluso si pides la recuperación con tu teléfono.
- `signInWithGoogle` → OAuth; la sesión llega por redirect
  (`detectSessionInUrl`). Un correo ya registrado con contraseña no se pisa:
  se reporta conflicto amigable y se invita a iniciar sesión con credenciales.
- Cada alta de sesión asegura la fila `customers` (con `customer_code`
  `SC-XXXXXXXX` como token QR) y dispara la sincronización Loyverse **solo a
  través de la Edge Function** — nunca directo.
- `retryLoyverseSync` re-dispara la sync desde el perfil/Home si quedó
  "failed" (banner "Reintentar sincronización" en modo real).
- Staff y Admin siguen siendo mock en esta fase (su auth real es un paso
  posterior).

Los errores de Supabase se traducen a mensajes amigables en español en
`src/services/auth/authErrors.js` (códigos + frase); la UI nunca muestra
errores crudos del servidor.

### Diagrama de flujo (clientes)

```
UI ── authService/ ──► Supabase Auth ──► customers (Postgres, RLS)
     (facade)        (registro/login)      │
                                          ▼
Edge Function loyverse-customers ──► api.loyverse.com  (LOYVERSE_ACCESS_TOKEN
     (JWT del usuario, RLS)             /v1.0/customers  SOLO aquí, en el server)
```

El navegador **nunca** llama a `api.loyverse.com`; `LOYVERSE_ACCESS_TOKEN`
no es una `VITE_*` y necesariamente vive en la Edge Function.

### Configuración (Supabase + Loyverse)

1. Crea un proyecto en Supabase y copia `.env.example` a `.env`:
   ```
   VITE_SUPABASE_URL=https://TU-PROYECTO.supabase.co
   VITE_SUPABASE_ANON_KEY=<tu anon key pública>
   VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL=   # opcional
   LOYVERSE_ACCESS_TOKEN=<token Loyverse con lectura/escritura>
   ```
2. Aplica las migraciones `supabase/migrations/0001_customers.sql`,
   `0002_loyalty_schema.sql`, `0003_auth_alias_rpc.sql`,
   `0004_loyverse_updated_event.sql`, `0005_loyalty_engine.sql` y
   `0006_loyverse_sync_claim.sql` (`supabase db push` o pégalas en el SQL
   Editor en orden).
3. Despliega la Edge Function:
   ```
   supabase functions deploy loyverse-customers
   ```
   (variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `LOYVERSE_ACCESS_TOKEN`
   configuradas en el proyecto — el token de Loyverse jamás en el frontend).
4. En Authentication → Providers habilita **Email** (y Google si quieres
   acceso con OAuth). El proveedor **Phone/SMS queda apagado**: la
   recuperación de contraseña usa el correo.

### Variables de entorno (`.env` / `.env.example`)

`.env.example` está commiteado y documenta **todas** las variables con
placeholders; los valores reales viven solo en `.env`, que está **gitignored**:

- **Frontend (públicas):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL` (opcional).
- **Edge Function (SOLO server, jamás `VITE_*`):** `LOYVERSE_ACCESS_TOKEN`.
- **SMTP custom (Supabase Auth):** `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`,
  `SMTP_PASS`, `SMTP_ADMIN_EMAIL`, `SMTP_SENDER_NAME` — activan el bloque
  `[auth.email.smtp]` (comentado en `config.toml` hasta tener proveedor/dominio).
- **Google OAuth (Supabase Auth):** `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`
  — activan `[auth.external.google]` (comentado en `config.toml`); credenciales
  desde Google Cloud Console.

Regla de la Edge Function (en `supabase/functions/_shared/loyverseCore.js`,
probada unitariamente): busca por email → busca por teléfono (la API de
Loyverse **no** filtra por `phone_number`, así que se página y filtra) →
vincula si coincide con uno solo → **conflicto** si email y teléfono
apuntan a clientes distintos (no crea un tercero) → crea solo si no
existe, con `customer_code` como nombre estable e idempotente.

### Sincronización de clientes existentes (Fase C)

Además de crear y vincular, la sincronización **actualiza** de forma
conservadora a los clientes que ya existen en Loyverse:

- Se busca por email y/o teléfono y se vincula al cliente correcto **sin
  duplicados**.
- Los **campos permitidos que faltan** en Loyverse (nombre, email,
  teléfono, `customer_code`) se sincronizan desde Salmos.
- La actualización es **conservadora**: nunca sobrescribe un valor distinto.
  Un email o teléfono **distinto** en el cliente existente **bloquea** el
  vínculo con un conflicto de identidad (el cliente es dirigido a entrar con
  esa cuenta o a recuperar su contraseña y vincular correo y teléfono).
- Datos del POS (`total_visits`, `total_spent`, `total_points`, recibos)
  permanecen **intocables**.
- Cada actualización real queda **auditada** y el flujo es **idempotente**
  (reintentos no duplican ni tocan nada que ya coincida).
- **Defensa de concurrencia server-side (0006 + `_shared/syncClaim.js`)**: la
  Edge adquiere un **claim atómico por fila** (`loyverse_sync_claim` +
  `loyverse_sync_claim_at`) antes de tocar la API; una segunda invocación
  simultánea del mismo perfil responde `409 loyverse_sync_in_progress`
  (`retriable: true`) sin llegar a Loyverse, y el claim se libera al terminar
  (lease de 10 min para claims abandonados; liberación solo por el token
  dueño). El guard **single-flight** del frontend sigue siendo la primera
  barrera (una sola llamada remota por perfil).

## Email templates de Supabase Auth (branded)

Los correos que envía Supabase Auth usan plantillas propias con la identidad de
Salmos Café (diseño en `docs/SALMOS_EMAIL_DESIGN.md`; auditoría en
`docs/AUTH_AUDIT.md`). La **fuente única** vive en `email-templates/` en la raíz
del repo y se mapea a los type keys nativos en `supabase/config.toml`
(`content_path` resuelto relativo a la raíz del repo):

| Type key de Supabase | Archivo | Uso |
|---|---|---|
| `confirmation` | `email-templates/confirm-signup.html` | Confirma el correo al registrarse |
| `recovery` | `email-templates/reset-password.html` | Link para restablecer contraseña |
| `magic_link` | `email-templates/otp.html` | Código **OTP de 6 dígitos** (`{{ .Token }}`, sin link) — es el correo real de la recuperación de la app (`signInWithOtp`) |
| `email_change` | `email-templates/change-email.html` | Confirma el cambio de correo |
| *(sin trigger nativo)* | `email-templates/welcome.html` | Bienvenida — envío **PENDIENTE MANUAL** (hook / Edge Function / proveedor de email) |

- Logo: `email-templates/assets/wordmark-cream.png` (único binario). Los 5
  templates usan la misma **URL provisional unificada**
  `https://raw.githubusercontent.com/salmoscafe/salmos-cafe-loyalty/main/email-templates/assets/wordmark-cream.png`
  (comentario `[LOGO_URL_PROVISIONAL]` en cada HTML); al publicar el dominio se
  hospeda el PNG en `https://salmos-cafe.com/email-assets/{...}` y se retiran
  los comentarios. No se usa ruta relativa en emails de Supabase.
- Footer de marca: eslogan **"Donde el café es un verso al paladar."** en las 5
  plantillas; asuntos y preheaders según diseño.
- Las plantillas legacy
  `supabase/templates/{confirmation,email_change,magic_link,recovery,welcome}.html`
  fueron **eliminadas** — `supabase/templates/` ya no existe.

Scripts (en `scripts/`):

- `build-templates-payload.py` — construye el payload de las **8 claves**
  (`mailer_templates_*_content` + `mailer_subjects_*`) leyendo los archivos
  exactos (UTF-8 sin BOM, aborta si hay BOM) de `email-templates/` y los
  subjects de `supabase/config.toml`. Modo `--out <json>` escribe el payload;
  en solitario imprime el reporte con SHA-256 por archivo.
- `patch-email-templates.ps1` — PATCH parcial y verificado a
  `https://api.supabase.com/v1/projects/<ref>/config/auth` con **solo** esas 8
  claves (regex de bloqueo: rechaza cualquier otra key de auth). Autentica con
  el token del Credential Manager de Windows (`Supabase CLI:supabase`, leído
  solo en memoria, jamás impreso). Flags: `-DryRun` (valida sin red),
  `-ValidateRemoteTemplate` (GET **solo lectura** que compara el template
  remoto con `confirm-signup.html`: longitudes, SHA-256 y match exacto),
  `-Diagnose`, `-Ref <project-ref>`.

Para el envío branded en remoto, el proyecto real tiene **SMTP custom
configurado**: `smtp.gmail.com:587`, remitente "Salmos Café", con
`smtp_user`/`smtp_pass`/`smtp_admin_email` presentes — confirmado con un **GET
de solo lectura a la Management API**. Es configuración remota; no implica
**entrega verificada** en este checkpoint. En local, el bloque
`[auth.email.smtp]` de `config.toml` sigue comentado y sus valores solo se
definen en `.env` (gitignored); los secretos reales nunca se suben a Git. Gmail
exige **App Password** para SMTP, no la contraseña de la cuenta.

## Seguridad

- El token de Loyverse vive **solo server-side** (Edge Function); el
  navegador nunca llama a `api.loyverse.com`.
- Crear/actualizar clientes ocurre **dentro de la Edge Function**, autenticada
  con el JWT del usuario (`verify_jwt`).
- **RLS activo**: cada usuario solo accede a su fila en Postgres.
- No se exponen secretos ni datos sensibles al frontend; los errores se
  traducen a mensajes amigables.

## Deployment (aplicado)

El cierre de despliegue de la Fase C y el hardening de concurrencia **ya se
aplicaron al ambiente real**:

1. Migraciones aplicadas en remoto: `0001`–`0006` (incluye `0004`
   `loyverse_updated` y `0006` del claim atómico de sync).
2. Edge Function `loyverse-customers` desplegada y activa (`verify_jwt =
   true`) con `_shared/syncClaim.js` y `loyverseCore.js` actualizado.

Comportamiento de concurrencia en producción: dos invocaciones simultáneas del
mismo perfil → la primera adquiere el claim de `customers`
(`loyverse_sync_claim`, lease de 10 min) y continúa; la segunda responde
`409 loyverse_sync_in_progress` (`retriable: true`) sin llamar a la API de
Loyverse. Un perfil ya `synced` responde `already_linked` sin tocar el claim.
El claim se libera al terminar (solo por el token dueño) y el fix `b0351f5`
sigue re-buscando ante un error de duplicado al crear.

## Credenciales de la demo

- **Cliente:** `javier@example.com` — contraseña `demo1234`.
  También puedes entrar con el teléfono `+52 664 123 4567` + `demo1234`.
  OTP de recuperación (demo): `123456` válido · `000000` vencido.
- **Staff:** PIN `1234` (Ana Beltrán), `5678` (Marco Reyes) o `2468`
  (Luisa Padilla).
- **Admin:** PIN `9999` (Diana Salazar) — el modo Admin en sí no pide
  login todavía (Fase 2).
- **Escáner de Staff:** el campo "Simular escaneo" viene precargado con
  `SC-004821`, la tarjeta de Javier.

## Estructura

```
src/
  data/mockDatabase.js     "backend falso": customers, cards, branches,
                            loyalty_cycles, sales, rewards, staff_profiles,
                            audit_logs
  services/                motor de fidelización real; única puerta de
                            entrada a los datos; cada método es async
    index.js               BARREL ÚNICO — las pantallas importan SOLO desde aquí
    auth/                  facade authService (Supabase real ↔ mock demo) +
                           authErrors (traducción de errores a mensajes amigables)
    loyalty/               loyaltyService + rewardService (reglas 8ª visita,
                            expiración, canje, cancelación)
    sales/                 salesService (único punto de entrada de ventas),
                            salesAdapters (ManualSalesAdapter hoy; Loyverse
                            después), ticketService
    customers/             customerService (perfil y búsqueda por token)
    staff/                 staffService (PIN, sesión, permisos) — mock ahora
    admin/                 adminService (dashboard, métricas por sucursal)
    loyverse/              loyverseEdgeClient (única puerta a la Edge Function,
                            el token NUNCA llega al navegador) +
                            loyverseCustomerService (normalización)
  components/
    common/                ui, BrandMark, icons — piezas visuales puras
    layout/                BottomNav, QrModal, QrCode — estructura de pantalla
    auth/                  piezas del flujo AuthScreen (login/registro/
                           recuperación por OTP/provisioning)
    loyalty/               StampTrack, SyncBanner — visuales de fidelización
  screens/client/          Home, Recompensas, Actividad, Perfil, Configuración
  screens/staff/           Home, Escanear, Cliente encontrado,
                            Registrar venta (con sucursal), Confirmación, Actividad
  screens/admin/           Dashboard (con desglose por sucursal), Clientes + stubs
  lib/
    supabase/client.js     ÚNICA creación del cliente Supabase (null en demo)
    utils/env.js           única lectura del entorno (Vite / tests)
    phone.js               teléfonos E.164 +52 (normalización, validación)
    delay.js               util de pausa simulada
    navigation.js          resolución de experiencia por pathname (/ /Staff /Admin)
  App.jsx                  orquestador raíz + resolución de experiencia por URL
  styles.css               identidad visual completa (paleta real del logo)
tests/loyalty.test.mjs      suite del motor de fidelización (node --test)
tests/loyverse-sync.test.mjs  lógica de sync Loyverse (normalización y conflicto)
tests/auth.test.mjs         suite del flujo de auth (contraseña + recuperación OTP)
tests/navigation.test.mjs   suite de navegación por pathname (sin router)

email-templates/            fuente única de las 5 plantillas de email branded
  confirm-signup.html       type key `confirmation`
  reset-password.html       type key `recovery`
  otp.html                  type key `magic_link` → OTP de 6 dígitos ({{ .Token }})
  change-email.html         type key `email_change`
  welcome.html              bienvenida (sin trigger nativo)
  assets/wordmark-cream.png logo (único binario; URL provisional en los 5 HTML)

scripts/
  build-templates-payload.py    construye el payload de 8 claves (config.toml + email-templates/)
  patch-email-templates.ps1     PATCH parcial verificado a Supabase (token vía Credential Manager)

supabase/
  config.toml                   subjects + content_path de templates (fuente única: email-templates/)
  functions/loyverse-customers/ Edge Function desplegada (verify_jwt = true) + _shared/ (loyverseCore, syncClaim)
  functions/loyalty-engine/     función del motor de lealtad (Fase D, ver Roadmap)
  templates/                    ELIMINADO — reemplazado por email-templates/
```

## Regla que gobierna todo el código

**El cliente nunca incrementa sus propias visitas.** `loyaltyService.addVisit`
es de uso interno; el único camino público es `salesService.registerSale()`
(Staff). Cancelar y redimir siguen la misma regla — ambas operaciones las
confirma Staff, nunca el cliente.

## Cómo crecer el código (convención)

1. Las pantallas (screens y componentes de pantalla) importan **solo** desde
   `services/index.js`. Nunca desde `mockDatabase`, `supabase/client` ni un
   servicio suelto.
2. Los servicios son async y viven en `services/<dominio>/`; cada archivo una
   sola responsabilidad. Internamente pueden importarse entre sí (p. ej.
   `customerService` reusa `currentCycleForCard` de `loyaltyService`).
3. Todo lo relacionado con Loyverse entra por `loyverse/loyverseEdgeClient.js`
   (Edge Function) y sale normalizado por `loyverseCustomerService.js`.
4. El entorno se lee solo con `readEnv` desde `lib/utils/env.js`.
5. Los componentes se clasifican por su función: `common/` (puros),
   `layout/` (estructura de app), `auth/` y `loyalty/` (dominio visual).

## Qué es real y qué sigue siendo mock

| Pieza | Estado |
|---|---|
| Motor de fidelización (monto mínimo, límite diario, 8ª visita, expiración, cancelación/reversión, idempotencia) | Real, en `services/`, cubierto por tests |
| Datos de lealtad (clientes, ventas, ciclos) | Mock, en memoria — se pierden al recargar la página |
| Auth Cliente (correo/teléfono + contraseña; OTP solo recuperación; Google; sesión persistente, Supabase) | Real, con `.env`; demo mock sin `.env` (facade `authService`) |
| Perfil `customers` + `customer_code` | Real (Postgres, RLS) cuando está configurado |
| Sync Loyverse (crear/vincular/actualizar clientes sin duplicar, con reintento, conflicto de identidad y auditoría `loyverse_updated`) | Real vía Edge Function desplegada (`verify_jwt = true`); migraciones `0001`–`0006` aplicadas en remoto; concurrencia validada en el ambiente real |
| Email templates de Auth (branded) | Real — 5 plantillas en `email-templates/`, cableadas en `config.toml`; `welcome` sin trigger nativo (envío PENDIENTE MANUAL) |
| SMTP custom / envío de correos | **Configurado en remoto** (verificado con GET de solo lectura a la Management API: `smtp.gmail.com:587`, remitente "Salmos Café", user/pass/admin presentes); entrega real **no verificada** en este checkpoint. En local, bloque `[auth.email.smtp]` comentado en `config.toml`; valores solo en `.env` (gitignored) |
| Auth Staff / Admin | Mock (PIN) |
| QR | Visual únicamente — `customer_code` sirve hoy de token; firmado en Fase 2 |
| Tickets/email | Fuera de alcance de V1 (decisión de negocio) — `tickets` queda como tabla/punto de extensión sin usar |
| Apple/Google Wallet | Solo el botón, sin integración |
| Loyverse en ventas | No conectado — `ManualSalesAdapter` es la única fuente hoy |
| Admin: Dashboard y Clientes | Reales contra el mock |
| Admin: Ventas, Recompensas, Staff, Configuración | Stubs navegables |

## Siguiente paso (no incluido aquí)

Migrar el motor de fidelización (ventas, ciclos, recompensas) a Supabase
con Edge Function transaccional para `registerSale`/`cancelSale`, QR con
token firmado, y `LoyverseSalesAdapter` cuando exista acceso real a la
cuenta — una vez migrado el motor, `ensureLoyaltyProfile` (DEV bridge en
`customerService`) se elimina junto con `mockDatabase`. En paralelo,
cerrar la entrega de los emails branded en producción: publicar el
dominio, hospedar `wordmark-cream.png` en su ruta definitiva y retirar los
comentarios `[LOGO_URL_PROVISIONAL]` (y decidir el disparador de
`welcome.html`).

## Documentation

- `docs/CURRENT_STATUS.md` — estado actual verificable del proyecto.
- `docs/AUTH_AND_LOYVERSE_FLOW.md` — flujo de auth y sincronización con Loyverse.
- `docs/AUTH_AUDIT.md` — auditoría AUTH-1/AUTH-2 (SMTP, plantillas de email, Google OAuth) y actualizaciones recientes.
- `docs/SALMOS_EMAIL_DESIGN.md` — diseño aprobado de los 5 emails branded.
- `docs/FASE_D1_DESIGN.md` — diseño de la Fase D (motor de lealtad).
- `AUTH_UX_DESIGN.md` — decisiones de UX del flujo de autenticación.
- `Salmos_Estructura_de_Datos.md` — auditoría original y modelo de datos completo.
