# Salmos Café Loyalty

Programa de lealtad de **Salmos Café**: una SPA (React) para clientes, staff y
admin donde cada compra elegible suma una visita y la **8ª visita** gana un
café gratis. La cuenta del cliente vive en **Supabase** (Auth + Postgres +
Edge Functions) y se sincroniza con el registro de clientes del **POS
Loyverse** (crear, vincular y actualizar) sin duplicados.

El proyecto está en **desarrollo activo**: la base, la autenticación de
cliente y la sincronización con Loyverse (clientes y receipts) están
implementadas; el motor de lealtad corre con reglas reales en Postgres y
las **lecturas del cliente (Home/Recompensas/Actividad/Perfil) consumen
datos reales de Supabase**. El **motor de escrituras** del flujo Staff
(registrar venta manual, canjear, cancelar desde la app) sigue sobre mock
en el frontend, a la espera de migrarlo a las RPCs transaccionales.
**No está "production complete".**

## Current checkpoint — 2026-09-14

Estado verificable del repositorio en esta fecha (checkpoint documental de Git).

- **Migraciones sincronizadas `0001`–`0008`.** La `0008` es el hardening de
  identidad de clientes: índices únicos normalizados de email/teléfono,
  grants mínimos para `authenticated` y campos de vinculación Loyverse bajo
  control server-side / `service_role`.
- **Hardening H1 + C4 completado**: el navegador ya no escribe
  `loyverse_customer_id` / `loyverse_sync_status`; la vinculación Loyverse la
  hace la Edge Function `loyverse-customers` con la identidad del usuario
  autenticado + `service_role`; `body.email` dejó de ser fuente de identidad;
  la vinculación solo por teléfono queda **bloqueada hasta verificar**; los
  índices únicos normalizados previenen duplicados/ambigüedad de identidad.
- **Tests: 155/155 pasando** (`node --test "tests/*.test.mjs"`).
- **Build: pasa** (`npm run build`; solo el aviso preexistente de chunk Vite
  > 500 kB, no se tocó en este checkpoint).
- **Sync de receipts Loyverse desplegado y validado**: Edge Function
  `loyverse-receipts-sync`; la última corrida real procesó **979 receipts** y
  registró **2 visitas válidas** (ventana `LOYVERSE_WINDOW_DAYS = 30` y
  checkpoint clampado a la historia disponible del plan).
- **La app lee datos reales de Supabase**: el cliente de prueba **Javier
  refleja 2/8** visitas del pipeline real Loyverse → Edge Function → Supabase
  → App Salmos.
- **Reglas de lealtad vigentes**: recompensa en la **8ª visita**; compra
  mínima **$50 MXN**; **máx. 1 visita válida por cliente por día**;
  recompensa de **1 bebida o hasta $150 MXN**; vigencia **3 meses**; cancelar
  revierte la visita y, si era la 8ª generadora, invalida la recompensa y
  reabre el ciclo; una recompensa **ya redimida no se puede cancelar**;
  marketing diferido para después.
- **SMS OTP: analizado, NO implementado.** Dirección planificada: mantener
  email/contraseña como método primario; añadir OTP por SMS más adelante
  para A) recuperación de contraseña por teléfono y C) verificación/cambio
  de teléfono en Settings. **Sin login passwordless.** H1+C4 se mantiene.
- **Twilio Verify seleccionado como dirección futura** (integración nativa
  Supabase, `provider = "twilio_verify"`), SMS solo como canal de OTP.
  El setup de Twilio está **temporalmente pausado** (el alta de cuenta quedó
  bloqueada por un mensaje temporal de "Too many attempts" de verificación);
  no se implementa Twilio/SMS en este checkpoint.
- **SMTP**: la configuración remota existente permanece intacta (sin cambios
  en este checkpoint).
- **Git**: rama `main`, remote `origin` → `github.com/salmoscafe/salmos-
  cafe-loyalty`; este checkpoint se documenta en un commit de `docs:` que
  toca únicamente `README.md`.

### Checkpoint oficial — 2026-09-14

Estado documental verificado a esta fecha. Todo lo listado aquí refleja lo
que hay en el repositorio en este momento y las validaciones realizadas.

#### 1) Arquitectura actual: App Salmos → Supabase → Loyverse

```
App Salmos (React/Vite) ──► Supabase ──► api.loyverse.com
    (Cliente / Staff / Admin)   (Auth + Postgres + Edge Fns)
```

- **App Salmos (React + Vite `src/`)**: experiencia Cliente/Staff/Admin
  por pathname (`/`, `/Staff`, `/Admin`). El Cliente se autentica con
  Supabase Auth y **lee su tarjeta, ciclo, visitas y recompensas
  directamente desde Postgres** (RLS: solo lo suyo) vía `services/`.
  Las RPCs de lealtad (escrituras) se invocan server-side; el cliente
  nunca incrementa sus propias visitas.
- **Supabase (PostgreSQL 17 + Auth + Edge Functions)**: fuente de verdad
  de identidad, reglas de lealtad (RPCs transaccionales idempotentes),
  datos (`customers`, `loyalty_cycles`, `loyalty_visits`, `rewards`,
  `audit_logs`), estado del sync (`loyverse_sync_state`) y la defensa de
  concurrencia (claims). Toda escritura sensible pasa por RPCs
  `SECURITY DEFINER` con grants de `service_role`.
- **Loyverse (API v1.0)**: POS como fuente de verdad de ventas/receipts y
  del catálogo de clientes. Únicamente server-side desde Edge Functions.

#### 2) Reglas oficiales de lealtad

Reglas implementadas en el motor SQL (migraciones `0002`/`0005`/`0007`):

- Recompensa en la **8ª visita** activa del ciclo (`required_visits`
  default 8; el motor lee el valor de `loyalty_cycles.required_visits`).
- Compra mínima **$50 MXN** (`loyalty_visits.amount >= 50`, CHECK).
- Máximo **1 visita activa por cliente por día** (índice único parcial
  `(customer_id, visit_date) WHERE status = 'active'` + lógica
  transaccional).
- Recompensa: bebida "Café gratis" o consumo hasta **$150 MXN**
  (`rewards.max_value` default 150).
- Vigencia **3 meses** (`expires_at = earned_at + interval '3 months'`);
  el estado "expired" se deriva en lectura.
- Cancelación **revierte la visita** (`cancel_visit`).
- Cancelar la **8ª visita invalida la recompensa y reabre el ciclo**
  (`rewards.status = 'cancelled'`, el ciclo vuelve a `active`).
- **No se puede cancelar** una visita cuyo ciclo ya fue **redimido**
  (la RPC bloquea con `P0001` sin modificar nada).
- Idempotencia por `external_sale_id UNIQUE`: reenviar la misma venta
  reutiliza el resultado, nunca duplica.

#### 3) Integración Loyverse

- **Customer mapping Supabase ↔ Loyverse**: `customers.loyverse_customer_id`;
  vínculo por email → teléfono → conflicto → crear; actualización
  conservadora y defensa de concurrencia (migración `0006` + `_shared
  /syncClaim.js`). Edge `loyverse-customers` (desplegada, `verify_jwt
  = true`).
- **Receipts sync**: Edge Function `loyverse-receipts-sync` (cron externo)
  consulta `GET /v1.0/receipts` (`limit` 250 + `cursor`) dentro de una
  ventana `updated_at` fija; registra visitas con `register_visit` y
  revierte con `cancel_visit_by_sale`.
- **Secret**: header `x-sync-secret` == variable `SYNC_CRON_SECRET`;
  `verify_jwt = false` en `supabase/config.toml` (la invoca un scheduler,
  no un usuario).
- **Ventana máxima de 30 días**: el plan gratuito solo expone receipts de
  los últimos 31 días; el checkpoint inicial/heredado se clampea a
  `now - 30 days` (`LOYVERSE_WINDOW_DAYS = 30`) sin regresar avances
  progresivos.
- **Checkpoint/watermark**: tabla `loyverse_sync_state`
  (`updated_at_min`/`updated_at_max`, `cursor`, estado, claim atómico).
  El watermark solo avanza si la corrida termina sin errores de
  infraestructura; errores de negocio (`P0001`) se reportan en
  `conflicts` y no bloquean el avance.
- **Receipts sin cliente**: se clasifican (`no_customer`,
  `unmapped_customer`) y se ignoran — nunca se auto-crea un cliente de
  Salmos a partir de un receipt.
- **Idempotencia y cancelaciones**: `external_sale_id` UNIQUE; un receipt
  cancelado sin visita previa es un no-op (`visit_found = false`);
  ya-cancelado responde `already_cancelled`; reward redimida → conflicto
  de negocio que no rompe el avance del watermark.

#### 4) Base de datos — migraciones `supabase/migrations/` `0001`–`0007`

| Migración | Propósito (relacionado con loyalty/sync) |
|---|---|
| `0001_customers.sql` | `customers` + `customer_sync_events`; RLS por `auth.uid() = auth_user_id` |
| `0002_loyalty_schema.sql` | `loyalty_cycles`, `loyalty_visits`, `rewards`, `audit_logs`; índices (idempotencia, 1 visita/día); RLS client-select |
| `0003_auth_alias_rpc.sql` | `resolve_email_for_login` y `phone_is_registered` (login por teléfono sin romper RLS) |
| `0004_loyverse_updated_event.sql` | Evento `loyverse_updated` de auditoría de la actualización conservadora de clientes |
| `0005_loyalty_engine.sql` | RPCs `register_visit`, `cancel_visit`, `redeem_reward`, `assert_loyalty_actor`, `visit_summary`; columnas `required_visits`, `source` |
| `0006_loyverse_sync_claim.sql` | Claim atómico de sync de clientes (`loyverse_sync_claim`/`_at`) |
| `0007_loyverse_receipts_sync.sql` | `triggered_reward_id`, `cancel_visit_by_sale`, tabla `loyverse_sync_state`; RPCs de `0005` recreadas |

#### 5) Frontend

- **Home ahora consume datos reales de Supabase**: `App.jsx` llama
  `getCardForCustomer(session.customer.profileId || session.customer.id)`
  — usa el `customers.id` real (`profileId`) en modo real.
- **`src/services/loyalty/loyaltyService.js`**: `getCardForCustomer` y
  `getCycleHistory` consultan `customers` + `loyalty_cycles` +
  `loyalty_visits` (progreso **derivado** de visitas activas, como define
  el esquema); sintetizan `card` desde `customer_code`. `addVisit`
  (uso interno del flujo Staff/mock) intacto. Fallback a mockDatabase sin
  Supabase (demo).
- **`src/services/loyalty/rewardService.js`**: `getRewardsForCard` (y sus
  derivadas `getCurrentReward`/`getPastRewards`) leen `rewards` reales por
  `customer_id`; la expiración se sigue derivando en cliente.
  `redeemReward` (flujo Staff) intacto. Fallback demo.
- **`src/App.jsx`**: pasa `profileId` al cargar la lealtad; Renderiza
  `HomeScreen` con `cycle.visits` / `cycle.requiredVisits` /
  `currentReward`.
- **Home muestra actualmente 2/8** para el cliente de prueba Javier.

#### 6) Validaciones realizadas

- **Tests completos: 155/155** (`npm test`) — incluyen las suites de
  `receipts-sync-core`, `loyalty-engine`, `sync-claim`, `single-flight`,
  `loyalty`, `loyverse-sync`, `auth` y `navigation`.
- **Build exitoso**: `npm run build` (solo el aviso preexistente de chunk
  Vite > 500 kB, ajeno al sync).
- **Sync real exitoso** Loyverse → Supabase: **el último sync procesó
  979 receipts** (corrida contra el ambiente real, reportada por el
  operador del checkpoint).
- **2 visitas reales registradas** para Javier
  (`customer_id 896c337f-adcd-4014-81c0-7f4131437d80`, `source =
  'loyverse'`).
- **Home refleja 2/8** para el cliente de prueba.

#### 7) Estado actual

**TERMINADO / VALIDADO (este checkpoint):**
- Motor de lealtad SQL (migraciones `0001`–`0007`) y RPCs transaccionales.
- Sync de receipts: Edge `loyverse-receipts-sync`, estado/watermark
  (`loyverse_sync_state`), ventana de 30 días, idempotencia y cancelaciones.
- Lecturas del cliente (Home y pantallas derivadas) desde Supabase real.
- Sync de clientes Loyverse (Fase C) desplegado y validado previamente.
- 155 tests + build verde al día de hoy.

**PENDIENTE:**
- Migrar las **escrituras** del flujo Staff al motor real
  (`registerSale`/`cancelSale`/`redeemReward` desde la app sobre las RPCs
  `register_visit`/`cancel_visit`/`redeem_reward`) y eliminar el DEV
  bridge (`ensureLoyaltyProfile` + mockDatabase) al cierre de esa
  migración.
- Despliegue formal/scheduler de `loyverse-receipts-sync` en el ambiente
  productivo final (definir el cron que invoque con `x-sync-secret`).
- QR con token firmado; entregar emails branded (dominio, logo en ruta
  definitiva, trigger de `welcome.html`).
- Ventas Loyverse en la UI (Activity ya muestra recompensas reales; las
  ventas manuales del staff siguen en mock y `ManualSalesAdapter` sigue
  siendo la única fuente de ventas).

#### 8) Cómo volver a probar el flujo (Loyverse → Supabase → Home)

1. `<npm test>` (esperado 155/155) y `npm run build`.
2. Invoca la Edge `loyverse-receipts-sync` con `POST` y header
   `x-sync-secret: <SYNC_CRON_SECRET>`.
3. Verifica en Supabase: `loyverse_sync_state.last_status = 'ok'`
   (con `processed` y `window.updatedAtMax`), nuevas filas en
   `loyalty_visits` (`source = 'loyverse'`, `external_sale_id` =
   `loyverse_receipt_<store>_<receipt_number>`), y `audit_logs` con
   `VISIT_ADDED`/`REWARD_EARNED`.
4. Un receipt cancelado debe producir la reversa vía
   `cancel_visit_by_sale` (no-op idempotente si nunca se registró).
5. Abre la app con `.env` real, entra como el cliente de prueba y en `/`
   confirma el contador (`2/8`) y, si corresponde, `currentReward`.

#### 9) Refinamiento visual — Home / branding

* Commit: `b8c7f66`
* Se refinó la presentación visual del Home del cliente.
* Se agregó el slogan oficial: **“Donde el café es un verso al paladar”**, centrado después de la tarjeta digital.
* Se eliminó el pequeño IconMark/S de la tarjeta, dejando el Wordmark de Salmos Café.
* Los cambios visuales corresponden a:

  * `src/screens/client/Home.jsx`
  * `src/styles.css`

## Project Status

- **En desarrollo activo.**
- ✅ Base funcional: app + motor de fidelización real (reglas verificadas por tests).
- ✅ Autenticación de cliente en Supabase (correo/teléfono + contraseña, OTP solo para recuperación, Google).
- ✅ Sincronización Loyverse: crear, vincular y **actualizar conservadoramente** a clientes existentes (Fase C — desplegado y validado en producción).
- ✅ **Navegación real por URL** (`/`, `/Staff`, `/Admin`) y **UI de Cliente/Auth limpia** (sin selector de demo; login "Bienvenido"; icono de Google).
- ✅ **Desplegado y validado en producción**: migraciones `0001`–`0006` aplicadas en el ambiente real y Edge Function `loyverse-customers` activa (`verify_jwt = true`).
- ✅ **Corrección de concurrencia Loyverse** validada con QA real: 2 invocaciones simultáneas → solo una procede; la perdedora responde `409 loyverse_sync_in_progress` (retriable) sin crear cliente duplicado.
- ✅ **Sync de receipts Loyverse** (Fase D2-v1): migración `0007` + Edge `loyverse-receipts-sync` (secret `x-sync-secret`, watermark en `loyverse_sync_state`, ventana de 30 días, idempotencia y cancelaciones) validado con sync real (**979 receipts** procesados).
- ✅ **Lecturas reales del Cliente**: Home y pantallas derivadas leen tarjeta/ciclo/visitas/recompensas directamente de Supabase (RLS) — `loyaltyService`/`rewardService` con fallback demo.
- ✅ **Templates de email branded** para Supabase Auth en `email-templates/` (confirm-signup, reset-password, otp, change-email, welcome) + scripts `scripts/build-templates-payload.py` y `scripts/patch-email-templates.ps1`; el sistema legacy `supabase/templates/` fue eliminado.
- ✅ **Variables de entorno documentadas** en `.env.example`: SMTP custom (`SMTP_HOST`/`SMTP_PORT`/`SMTP_USER`/`SMTP_PASS`/`SMTP_ADMIN_EMAIL`/`SMTP_SENDER_NAME`) y Google OAuth (`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET`). Los secretos reales **jamás** se guardan en Git y `.env` permanece gitignored.
- ⏳ Siguiente paso: migrar el **motor de escrituras** (ventas Staff, canje, cancelación) a las RPCs transaccionales reales; las lecturas del cliente ya son reales.

## Development Status

| Fase | Estado | Contenido |
|---|---|---|
| Fase A — Foundation | ✅ | Estructura de la app, arquitectura `services/`, reglas de lealtad (sobre mock) |
| Fase B — Authentication | ✅ | Supabase Auth real de cliente |
| Fase C — Loyverse Sync | ✅ | Crear/vincular/actualizar clientes sin duplicados, incl. claim atómico de concurrencia (código + tests + despliegue + QA real) |
| Fase D — Loyalty | ~ | Motor SQL real (migraciones `0005`/`0007`) + **lecturas del Cliente reales (Home/Perfil)** + sync de receipts; pendiente: escrituras Staff sobre las RPCs |
| Fase E — Sales / POS | ⏳ | `ManualSalesAdapter` hoy; ventas Loyverse no conectadas |

## Roadmap

- Foundation ✅
- Authentication ✅
- Loyverse integration ✅
- Loyverse customer sync ✅
- Branded email templates ✅
- Loyalty engine ⏳ (~SQL real + lecturas; escrituras Staff pendientes)
- Customer loyalty experience ⏳ (Home real; QR firmado pendiente)
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

- **155 tests pasando** (`npm test`): motor de lealtad (`loyalty`),
  sincronización de clientes Loyverse (`loyverse-sync`), sync de receipts
  (`receipts-sync-core`), motor SQL (`loyalty-engine`), claim atómico
  (`sync-claim`), single-flight, flujo de auth y navegación por pathname.
- `npm run build` compila sin errores (hay un aviso **preexistente** de
  tamaño de chunk de Vite > 500 kB, no introducido por el sync).
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
   `0004_loyverse_updated_event.sql`, `0005_loyalty_engine.sql`,
   `0006_loyverse_sync_claim.sql` y `0007_loyverse_receipts_sync.sql`
   (`supabase db push` o pégalas en el SQL Editor en orden).
3. Despliega las Edge Functions:
   ```
   supabase functions deploy loyverse-customers
   supabase functions deploy loyverse-receipts-sync
   ```
   (variables `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `LOYVERSE_ACCESS_TOKEN`
   y `SYNC_CRON_SECRET` configuradas en el proyecto — los tokens/secretos
   jamás en el frontend). `loyverse-receipts-sync` se invoca por un cron
   con el header `x-sync-secret` (ver sección "Probar el flujo" del
   checkpoint).
4. En Authentication → Providers habilita **Email** (y Google si quieres
   acceso con OAuth). El proveedor **Phone/SMS queda apagado**: la
   recuperación de contraseña usa el correo.

### Variables de entorno (`.env` / `.env.example`)

`.env.example` está commiteado y documenta **todas** las variables con
placeholders; los valores reales viven solo en `.env`, que está **gitignored**:

- **Frontend (públicas):** `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`,
  `VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL` (opcional).
- **Edge Functions (SOLO server, jamás `VITE_*`):** `LOYVERSE_ACCESS_TOKEN`
  (cliente/ventas) y `SYNC_CRON_SECRET` (secreto del scheduler que envían
  los cron al header `x-sync-secret` de `loyverse-receipts-sync`).
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

1. Migraciones aplicadas en remoto: `0001`–`0007` (incluye `0004`
   `loyverse_updated`, `0006` del claim atómico de sync y `0007` del sync
   de receipts).
2. Edge Function `loyverse-customers` desplegada y activa (`verify_jwt =
   true`) con `_shared/syncClaim.js` y `loyverseCore.js` actualizado.
3. `loyverse-receipts-sync` **validada con una corrida real** (979 receipts
   procesados; checkpoint en `loyverse_sync_state`). El **scheduler/cron
   formal** que la invoque con `x-sync-secret` sigue pendiente de
   definirse en el ambiente productivo.

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
    loyalty/               loyaltyService + rewardService (lecturas reales en
                           Supabase con fallback demo; reglas 8ª visita,
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
tests/loyalty.test.mjs              suite del motor de fidelización (node --test)
tests/loyalty-engine.test.mjs       RPCs del motor SQL (register/cancel/redeem, idempotencia)
tests/loyverse-sync.test.mjs        lógica de sync Loyverse (normalización y conflicto)
tests/receipts-sync-core.test.mjs   lógica pura del sync de receipts (external_sale_id, cancelaciones)
tests/sync-claim.test.mjs           claim atómico de concurrencia (lease, token, liberación)
tests/single-flight.test.mjs        guard single-flight del frontend
tests/auth.test.mjs                 suite del flujo de auth (contraseña + recuperación OTP)
tests/navigation.test.mjs           suite de navegación por pathname (sin router)

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
  config.toml                          subjects + content_path de templates (fuente única: email-templates/)
  migrations/                          0001–0007 (esquema, RPCs, loyalty_engine, sync_claim, loyverse_sync_state)
  functions/_shared/loyaltyEngineCore.js
  functions/_shared/syncClaim.js       claim atómico por fila
  functions/_shared/receiptsSyncCore.js lógica pura compartida del sync de receipts
  functions/loyverse-customers/        Edge Function (verify_jwt = true) — sync de clientes
  functions/loyverse-receipts-sync/    Edge Function (verify_jwt = false, x-sync-secret) — sync de receipts
  functions/loyalty-engine/            función del motor de lealtad (escrituras, ver Roadmap)
  templates/                           ELIMINADO — reemplazado por email-templates/ (raíz del repo)
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
| Motor de fidelización (monto mínimo, límite diario, 8ª visita, expiración, cancelación/reversión, idempotencia) | Real — reglas en Postgres (RPCs `0005`/`0007`) + `services/`, cubierto por tests |
| Datos de lealtad — **lecturas del cliente** (tarjeta, ciclo, visitas, recompensas) | Real (Postgres, RLS) — Home/Recompensas/Actividad/Perfil; refleja 2/8 |
| Datos de lealtad — **escrituras** (venta manual, canje, cancelación desde la app) | Mock — pendiente migrar a las RPCs transaccionales (`register_visit`/`cancel_visit`/`redeem_reward`) y eliminar `ensureLoyaltyProfile`/`mockDatabase` |
| Sync de receipts Loyverse | Real — Edge `loyverse-receipts-sync` (secret, ventana 30 días, watermark `loyverse_sync_state`); corrida real validada (979 receipts); scheduler cron formal pendiente |
| Auth Cliente (correo/teléfono + contraseña; OTP solo recuperación; Google; sesión persistente, Supabase) | Real, con `.env`; demo mock sin `.env` (facade `authService`) |
| Perfil `customers` + `customer_code` | Real (Postgres, RLS) cuando está configurado |
| Sync Loyverse (crear/vincular/actualizar clientes sin duplicar, con reintento, conflicto de identidad y auditoría `loyverse_updated`) | Real vía Edge Function desplegada (`verify_jwt = true`); migraciones `0001`–`0007` aplicadas en remoto; concurrencia validada en el ambiente real |
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

Migrar las **escrituras Staff** al motor transaccional real
(`registerSale`/`cancelSale`/`redeemReward` desde la app sobre las RPCs
`register_visit`/`cancel_visit`/`redeem_reward`) y eliminar el DEV bridge
(`ensureLoyaltyProfile` + `mockDatabase`) al cierre de esa migración;
definir el **scheduler cron** de `loyverse-receipts-sync` en el ambiente
productivo; QR con token firmado (con `LoyverseSalesAdapter` cuando haya
acceso real a ventas). En paralelo, cerrar la entrega de los emails
branded en producción: publicar el dominio, hospedar
`wordmark-cream.png` en su ruta definitiva y retirar los comentarios
`[LOGO_URL_PROVISIONAL]` (y decidir el disparador de `welcome.html`).

## Documentation

- `docs/CURRENT_STATUS.md` — estado actual verificable del proyecto.
- `docs/AUTH_AND_LOYVERSE_FLOW.md` — flujo de auth y sincronización con Loyverse.
- `docs/AUTH_AUDIT.md` — auditoría AUTH-1/AUTH-2 (SMTP, plantillas de email, Google OAuth) y actualizaciones recientes.
- `docs/SALMOS_EMAIL_DESIGN.md` — diseño aprobado de los 5 emails branded.
- `docs/FASE_D1_DESIGN.md` — diseño de la Fase D (motor de lealtad).
- `AUTH_UX_DESIGN.md` — decisiones de UX del flujo de autenticación.
- `Salmos_Estructura_de_Datos.md` — auditoría original y modelo de datos completo.
