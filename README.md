# Salmos Café Loyalty

## A. Qué es Salmos Café Loyalty App

Programa de lealtad de **Salmos Café**: una SPA (React + Vite) con tres
experiencias por URL — **Cliente** (`/`), **Staff** (`/Staff`) y **Admin**
(`/Admin`). Cada compra elegible suma una visita y la **7ª visita** del ciclo
gana una recompensa (una bebida o hasta **$150 MXN**).

La cuenta del cliente vive en **Supabase** (Auth + PostgreSQL 17 + Edge
Functions) y se sincroniza con el registro de clientes del **POS Loyverse**
(crear, vincular y actualizar) sin duplicados. Los **receipts** de Loyverse se
sincronizan vía Edge Function y generan/revientan visitas con reglas de
negocio reales en Postgres.

Un rasgo distintivo: cada ticket de fidelidad incluye un **versículo de
Salmos** (RVR1960, dataset local de 150 pasajes, sin red en runtime) y un
**código de barras Code 128** real, con exportación a PDF y envío por correo.

No es un proyecto de demostración ni un scaffold: la base, la
autenticación de cliente y la sincronización con Loyverse (clientes y
receipts) están implementadas y verificadas. **No está "production
complete"** (ver secciones N y O).

## B. Estado actual del proyecto

- **Regla de lealtad vigente: 7 visitas** (migración `0012`). Histórica: 8
  visitas (ver sección P).
- **Lecturas del cliente (Home, Recompensas, Actividad, Perfil,
  Configuración) consumen datos reales de Supabase** (RLS: solo lo suyo).
  El progreso de la tarjeta se **deriva** de `loyalty_visits` (no hay
  contador almacenado); el estado `expired` también se deriva en lectura.
- **Motor de escrituras del flujo Staff** (registrar venta manual, canjear,
  cancelar desde la app): **sigue sobre mock** (`mockDatabase`), a la espera
  de migrarlo a las RPCs transaccionales reales (`register_visit` /
  `cancel_visit` / `redeem_reward`).
- **Sync de receipts Loyverse**: real (Edge `loyverse-receipts-sync`,
  invocada cada 5 min por GitHub Actions con `x-sync-secret`).
- **Auth Cliente**: Supabase Auth real; el login por teléfono pasa por la
  Edge `auth-phone-login` (el email nunca llega al navegador).
  **Auth Staff/Admin**: Supabase Auth + rol en `public.profiles` (`0013`);
  el PIN solo existe en modo demo (sin `.env`).
- **Migraciones `0001`–`0023`** presentes localmente; `supabase migration
  list` reportó local = remoto hasta `0023` (verificación del equipo,
  2026-10-07). Ver sección G.
- **Security Hardening `0018`–`0023`: aplicado.** Resumen abajo; detalle en
  [`docs/security-hardening.md`](docs/security-hardening.md).
- QA 2026-09-15 (histórico): 297 receipts procesados, 4 visitas
  reconstruidas para el cliente de prueba (order `4 → 3 → 2 → 1` en
  Actividad).

### Qué es real y qué sigue siendo mock (resumen)

| Pieza | Estado |
|---|---|
| Lecturas del Cliente (tarjeta, ciclo, visitas, recompensas, ticket + versículo) | Real (Postgres, RLS) |
| Escrituras del Cliente | El cliente nunca escribe sus visitas (regla de diseño) |
| Motor de lealtad (reglas en Postgres: RPCs `0005`/`0007`/`0010`, `0012`) | Real |
| Escrituras Staff desde la app (venta manual, canjear, cancelar) | Mock — pendiente migrar a las RPCs |
| Sync de clientes Loyverse (crear/vincular/actualizar) | Real (Edge Function, service_role) |
| Sync de receipts Loyverse | Real (Edge Function, cron externo) |
| Auth Cliente (email/teléfono + contraseña, OTP recuperación, Google) | Real con `.env` (teléfono vía Edge `auth-phone-login`); demo mock sin `.env` |
| Auth Staff/Admin | Real con `.env` (Supabase Auth + `public.profiles`); PIN solo en demo |
| QR | Visual — `customer_code` sirve hoy de token; firmado pendiente |
| Email templates de Auth (branded) | Real en `email-templates/`; envío `welcome.html` sin disparador |
| SMTP (Auth y send-ticket) | Config definida; entrega real pendiente (SMTP en el entorno de la Edge) |
| Admin Dashboard y Clientes | Reales contra el mock |
| Admin Ventas/Recompensas/Staff/Config | Stubs navegables |
| Loyverse en ventas (UI) | No conectado — `ManualSalesAdapter` es la única fuente |

### Security Hardening (resumen)

| Pieza | Estado |
|---|---|
| `0018` — RPCs internas solo `service_role` + actor validado contra `profiles` | ✅ Aplicada |
| `0019` — `bible_verse_pool` sin acceso para anon/authenticated (49 pasajes intactos) | ✅ Aplicada |
| `0020` — `resolve_email_for_login` solo `service_role`; `email_is_registered` | ✅ Aplicada |
| `0021`–`0023` — teléfono canónico E.164 MX, `phone_is_registered`, cliente sin UPDATE de `customers.phone` | ✅ Aplicadas |
| Edge `auth-phone-login` (login/recuperación por teléfono sin exponer email) | ✅ Desplegada |
| `loyverse-customers`: `customerCode` confiable (409) + fix E.164 `+52` | ✅ Desplegada |
| Validación de `body.phone`/`body.name` en `loyverse-customers` | ⏳ Pendiente |
| `0024` backfill de teléfonos de registro · `0025` unicidad canónica | ⏳ Pendiente |
| `customer_sync_events` solo `service_role` · CAPTCHA (hoy Disabled) | ⏳ Pendiente |

Fuente de verdad del teléfono: **`customers.phone`** (canónico
`+52XXXXXXXXXX`). Detalle, contratos y pendientes:
[`docs/security-hardening.md`](docs/security-hardening.md).

## C. Arquitectura

```
App Salmos (React/Vite, src/)
  ├─ Cliente  (/)
  ├─ Staff    (/Staff)
  └─ Admin    (/Admin)
        │  services/ (barrel único)
        ▼
Supabase (PostgreSQL 17 + Auth + Edge Functions)
        ▲                          │
        │ (JWT del usuario, RLS)   │ (service_role / x-sync-secret)
        │                          ▼
  api.loyverse.com ──► Edge Functions ──► Supabase ──► App
  (clientes, receipts)        (server-side SOLO)
```

- **App Salmos**: SPA React, experiencias por `pathname` (sin router
  externo: `/` → Cliente, `/Staff` → Staff, `/Admin` → Admin). Las pantallas
  importan **solo** desde `services/index.js` (barrel único).
- **Supabase**: fuente de verdad de identidad, reglas de lealtad (RPCs
  transaccionales idempotentes), datos y estado del sync. Toda escritura
  sensible pasa por RPCs `SECURITY DEFINER` con grants exclusivos de
  `service_role`; el cliente solo lee **su** fila (RLS).
- **Loyverse (API v1.0)**: POS como fuente de verdad de ventas/receipts y
  del catálogo de clientes. **Únicamente server-side** desde Edge Functions;
  el navegador jamás llama a `api.loyverse.com` y el `LOYVERSE_ACCESS_TOKEN`
  jamás sale del servidor.

Flujo de datos de una venta:

```
Loyverse (POS) ──► Edge loyverse-receipts-sync ──► RPC register_visit_with_receipt
                                                        │
                                                        ▼
                                             loyalty_visits (items, receipt_date, verse_id)
                                                        │
                                                        ▼
                                             App Salmos (Activity → ticket, PDF, correo)
```

## D. Reglas actuales de loyalty

Regla vigente oficial (migración `0012_required_visits_7.sql`, 2026-09-15):

- **Una recompensa se genera al alcanzar 7 visitas válidas** en el ciclo.
- Compra mínima válida: **$50 MXN**.
- **Máximo 1 visita válida por cliente por día** (across ambas sucursales;
  índice único parcial `(customer_id, visit_date) WHERE status = 'active'`).
- La recompensa es **1 bebida o hasta $150 MXN** de consumo.
- Vigencia de la recompensa: **3 meses** desde que se gana (`expires_at =
  earned_at + interval '3 months'`); el estado `expired` se **deriva en
  lectura** (`available` + `now > expires_at`), nunca depende de un cron.
- Una visita posterior a completar un ciclo **pertenece al siguiente ciclo**
  y no genera una segunda recompensa del ciclo anterior.
- Cancelar una compra **revierte la visita**:
  - Si la visita era la 7ª generadora → invalida la recompensa
    (`rewards.status = 'cancelled'`) y **reabre el ciclo** (`active`).
  - Una recompensa **ya redimida no se puede cancelar/revertir** (la RPC
    bloquea con `P0001` sin modificar nada).
  - Cancelar un receipt nunca registrado es un no-op idempotente.
- **Idempotencia**: `external_sale_id` UNIQUE (`loyverse_receipt_<store>_
  <receipt_number>`) — reenviar la misma venta reutiliza el resultado, nunca
  duplica.
- Dos sucursales (`branch_1`, `branch_2`) comparten la misma
  tarjeta/ciclo del cliente.

### Fuente de verdad

El requisito de visitas se lee de **`public.loyalty_cycles.required_visits`**
(donde están los datos), no de un número hardcodeado:

- La RPC `register_visit` (0007) compara `v_active_visits >=
  v_cycle.required_visits` para decidir el cierre del ciclo.
- Fallback mock/frontend: `REQUIRED_VISITS = 7` en
  `src/data/mockDatabase.js` (copia de diagnóstico, no autoridad).
- `adminService` lee la regla de Supabase con fallback `?? REQUIRED_VISITS`.

El **progreso** de la tarjeta se deriva de `loyalty_visits` (orden
cronológico por `receipt_date` → `visit_date` → `created_at`); **no hay
contador almacenado** en el esquema.

## E. Flujo Cliente → Supabase → Loyverse

1. El cliente se registra/inicia sesión en **Supabase Auth** (email o
   teléfono + contraseña; OTP solo para recuperación; Google opcional).
2. El alta de sesión asegura la fila `customers` (con `customer_code`
   `SC-XXXXXXXX` como token QR) y dispara la **sincronización Loyverse**
   **solo a través de la Edge Function** `loyverse-customers` — nunca
   directo.
3. La Edge Function (con el JWT del usuario, RLS) resuelve el cliente de
   Loyverse: busca por **email** → busca por **teléfono** → **vincula** o
   **crea**, con reglas conservadoras y defensa de concurrencia (claim
   atómico por fila). El resultado queda en `loyverse_customer_id`.
4. Un **cron externo** invoca `loyverse-receipts-sync` con `x-sync-secret`:
   consulta `GET /v1.0/receipts` por ventana `updated_at` incremental y, por
   cada receipt elegible, registra la visita (o la revierte si fue cancelado)
   vía RPCs de Postgres.
5. La app (Cliente) lee **sus** visitas/ciclos/recompensas directamente de
   Supabase (RLS) y renderiza la tarjeta, el ticket (con versículo
   persistido `verse_id`), opciones de PDF y correo.

```
UI ── authService/ ──► Supabase Auth ──► customers (Postgres, RLS)
     (facade)         (registro/login)      │
                                            ▼
            Edge Function loyverse-customers ──► api.loyverse.com
            (JWT del usuario, RLS)               /v1.0/customers
                                                    (token SOLO aquí)
```

## F. Base de datos

### Tablas `public` (resumen)

| Tabla | Propósito |
|---|---|
| `customers` | Un cliente por `auth_user_id`; `customer_code` único `SC-XXXXXXXX`; `loyverse_customer_id` único; columnas de claim de sync (`loyverse_sync_claim`/`_at`) y estado (`loyverse_sync_status`) |
| `customer_sync_events` | Auditoría de sync de clientes (`loyverse_linked`, `created`, `updated`, `conflict`, `error`) |
| `loyalty_cycles` | Ciclo de fidelidad del cliente; **`required_visits`** (`7` vigente; default histórico `8`); `status` (`active`/`completed`) |
| `loyalty_visits` | Cada compra elegible registrada: `external_sale_id` UNIQUE, `amount`, `visit_date`, `store_id`, `employee_id`, `timestamp`, `source`, `status` (`active`/`cancelled`), `items` (jsonb), `receipt_date`, `verse_id` |
| `rewards` | Recompensas: `status` (`available`/`redeemed`/`cancelled`), `max_value` (150), `expires_at` (3 meses), `triggered_reward_id` |
| `reward_redemptions` | Evidencia de redención detectada en los receipts (idempotente por receipt + discount) |
| `audit_logs` | Traza de eventos de lealtad (`VISIT_ADDED`, `REWARD_EARNED`, …) |
| `loyverse_sync_state` | Checkpoint/watermark del sync de receipts (`updated_at_min`/`_max`, `cursor`, `last_status`, claim) |
| `bible_verse_pool` | 49 pasajes elegibles para el ticket (`verse_id`); == `TICKET_VERSE_IDS` |

### Seguridad y diseño de datos

- **RLS activo**: cada usuario solo lee/escribe su fila (`auth.uid() =
  auth_user_id`). Las RPCs de escritura corren `SECURITY DEFINER` (grants
  exclusivos de `service_role`); el navegador no las invoca con permisos de
  cliente.
- **`customers`** (migración `0008`, H1): el frontend solo tiene
  `SELECT` + `INSERT`/`UPDATE` limitados a columnas públicas (name, email,
  phone, profile, customer_code); las columnas internas `loyverse_*` solo las
  escribe la Edge Function con `service_role`.
- **Identidad de contacto**: email/teléfono normalizados con índices únicos
  parciales (C4); el email de identidad siempre viene de GoTrue.
- **Progreso y expiración derivados**: sin contador almacenado, sin cron de
  expiración (derivado en lectura).
- **Idempotencia**: `external_sale_id` UNIQUE + índices únicos parciales.

## G. Migraciones

Todas las migraciones viven en `supabase/migrations/`. Se aplican con
`supabase db push` (o en orden en el SQL Editor).

| Migración | Propósito |
|---|---|
| `0001_customers.sql` | `customers` + `customer_sync_events`; RLS por `auth.uid()`; `customer_code` `SC-XXXXXXXX` único |
| `0002_loyalty_schema.sql` | `loyalty_cycles`, `loyalty_visits`, `rewards`, `audit_logs`; índices (idempotencia, 1 visita/día); RLS client-select; escrituras solo Edge/service_role |
| `0003_auth_alias_rpc.sql` | `resolve_email_for_login` y `phone_is_registered` (login por teléfono sin romper RLS) |
| `0004_loyverse_updated_event.sql` | Evento de auditoría `loyverse_updated` |
| `0005_loyalty_engine.sql` | RPCs `register_visit`, `cancel_visit`, `redeem_reward`, `assert_loyalty_actor`, `visit_summary`; columnas `required_visits` (default 8 **histórico**) y `source` |
| `0006_loyverse_sync_claim.sql` | Claim atómico de sync de clientes (`loyverse_sync_claim`/`_at`) |
| `0007_loyverse_receipts_sync.sql` | RPCs `0005` recreadas (`triggered_reward_id`), `cancel_visit_by_sale`; tabla `loyverse_sync_state`; reglas: `external_sale_id` requerido, `amount < 50` → error, `v_active_visits >= required_visits` → completar ciclo + reward |
| `0008_customers_identity_hardening.sql` | Hardening H1/C4: grants mínimos, índices únicos normalizados, columnas internas server-side |
| `0009_reward_redemptions.sql` | `reward_redemptions` (evidencia de redenciones detectadas en receipts) |
| `0010_loyverse_receipt_details.sql` | `loyalty_visits.items` (jsonb) + `receipt_date` (fecha REAL del cobro); RPC `register_visit_with_receipt` (valida con `register_visit` y persiste el detalle) |
| `0011_visit_verse_id.sql` | `loyalty_visits.verse_id` + `bible_verse_pool` (49 pasajes); asignación conservada ante re-sync |
| `0012_required_visits_7.sql` | **Regla vigente**: default `required_visits = 7`; actualiza **solo** ciclos activos con `required_visits = 8` a `7`. No toca completados ni activos con otro valor. Idempotente/no destructiva |
| `0013_profiles_roles.sql` | `public.profiles`: rol (`customer`/`staff`/`admin`) y `active` por cuenta de Supabase Auth |
| `0014_customers_exclude_loyalty.sql` | `customers.exclude_loyalty`: excluye clientes (p. ej. staff) del loyalty sync |
| `0015_register_visit_with_receipt_exclude_loyalty.sql` | Segunda barrera `excluded_customer` en `register_visit_with_receipt` |
| `0016_reward_claims.sql` | `reward_claims` (solicitudes de canje) |
| `0017_reward_claim_otp.sql` | Canje con OTP verificado por Staff; `redeem_reward` exige claim `verified` |
| `0018_rpc_authorization_hardening.sql` | **Security:** RPCs internas solo `service_role`; `assert_loyalty_actor` valida staff/admin activos en `profiles` |
| `0019_bible_verse_pool_lockdown.sql` | **Security:** RLS en `bible_verse_pool`; anon/authenticated sin acceso; `service_role` solo SELECT |
| `0020_login_alias_lockdown.sql` | **Security:** `resolve_email_for_login` solo `service_role`; nueva `email_is_registered` |
| `0021_customers_phone_canonical.sql` | **Security:** normaliza `customers.phone` legacy a E.164 MX solo en casos seguros; auditoría sin teléfono completo |
| `0022_phone_is_registered_pending.sql` | **Security:** `phone_is_registered` canónico + metadata del registro pendiente; helper privado `canonical_mx_phone` |
| `0023_revoke_customer_phone_update.sql` | **Security:** anon sin UPDATE; authenticated solo UPDATE de `name`, `email`, `profile` |

### Regla sobre migraciones (documental, vigente)

> **Las migraciones históricas no se modifican.** Un cambio de regla de
> negocio es SIEMPRE una migración nueva:

```
0005 → regla histórica: 8 visitas   (no se edita)
0012 → regla actual:   7 visitas
00NN → (futuro, si cambia) → 8 visitas  (ejemplo de principio, no existe)
```

### Estado remoto del proyecto Supabase

- Proyecto remoto: ref `gyugkrvdgxofnkfhzbeq`. Proyecto local
  (`supabase/config.toml`): `project_id = "App_Salmos_LC"`, API `:54321`,
  `max_rows = 1000`, PostgreSQL 17, Edge runtime Deno 2.
- **Sincronizado hasta `0023`** (2026-10-07): `supabase migration list`,
  ejecutado por el equipo, mostró local = remoto hasta
  `0023_revoke_customer_phone_update`. Siguiente migración prevista: `0024`
  (pendiente; ver `docs/security-hardening.md`).

## H. Autenticación

### Cliente (Supabase Auth real)

- **Registro**: email + contraseña (el email es la identidad; el teléfono es
  contacto + alias de login). Con `email confirmations = on` la cuenta queda
  pendiente hasta confirmar desde el correo (plantilla `confirm-signup.html`).
- **Login por email o teléfono + contraseña**: con email, directo contra
  GoTrue. Con teléfono, el frontend llama a la Edge **`auth-phone-login`**,
  que resuelve el email del lado servidor (`resolve_email_for_login`, solo
  `service_role` desde `0020`), valida con GoTrue y devuelve **solo tokens de
  sesión** (`setSession`); errores genéricos, sin revelar si el teléfono
  existe. La recuperación por teléfono usa la misma Edge.
- **Recuperación de contraseña por OTP**: `signInWithOtp` + código de 6
  dígitos por correo (plantilla `otp.html`, `{{ .Token }}`, sin link). Sin
  proveedor SMS configurado, el código va al correo incluso si se pide con
  teléfono. El SMS/OTP por SMS está analizado y **no implementado**.
- **Google OAuth**: opción de acceso por redirect; bloque de
  `config.toml` **comentado** hasta tener credenciales; un correo ya
  registrado no se pisa (conflicto amigable).
- Los errores se traducen a mensajes amigables en español
  (`src/services/auth/authErrors.js`).

### Staff y Admin

- **Con Supabase configurado**: email + contraseña en Supabase Auth; el rol
  se lee de `public.profiles` (`role` + `active`, migración `0013`), nunca de
  `user_metadata`. Los empleados se gestionan con la Edge `admin-employees`.
- **Modo demo (sin `.env`)**: PIN mock — Staff `1234` (Ana Beltrán), `5678`
  (Marco Reyes), `2468` (Luisa Padilla); Admin `9999` (Diana Salazar).

## I. Integración Loyverse

### Edge Functions (`supabase/functions/`)

| Función | `verify_jwt` | Rol | Protección |
|---|---|---|---|
| `loyverse-customers` | `true` | Sync/creación/vínculo de clientes | JWT del usuario (RLS) + `service_role` para columnas internas; `customerCode` siempre de la BD (mismatch → `409`) |
| `loyverse-receipts-sync` | `false` | Sync de receipts (scheduled) | Header `x-sync-secret` == `SYNC_CRON_SECRET`; claim atómico en `loyverse_sync_state`; service_role |
| `send-ticket` | `true` | Enviar el ticket por correo | JWT del usuario; verificación de propiedad del ticket; correo destino SIEMPRE de GoTrue/customers |
| `loyalty-engine` | `true` | Escrituras de lealtad (ver Roadmap) | JWT + validación de actor en el core; `0018` revalida el actor en la BD |
| `auth-phone-login` | `false` | Login y recuperación por teléfono | Pública; nunca devuelve email/password/OTP; respuestas genéricas; límites de Supabase Auth por IP |
| `admin-employees` | `true` | Alta/listado/actualización de empleados | JWT + rol `admin` activo leído de `public.profiles` |

### `_shared/` (lógica pura, unit-testable con `node --test`)

- `loyaltyEngineCore.js` — **no duplica reglas de negocio** ($50, 1
  visita/día, 7ª visita, expiración…: viven en PostgreSQL; RPCs `0005`/
  `0007`/`0010`). Valida formato, operación, actor y timezone
  (`America/Tijuana`); el actor NUNCA viene del payload; `visit_date` se
  calcula en servidor.
- `loyverseCore.js` — orquestación cliente: email → teléfono → vincular /
  crear / conflict. H1: un match SOLO por teléfono NO vincula
  (`phone_requires_verification`); email+teléfono a clientes distintos =
  `identity_conflict`; la actualización es conservadora (nunca sobrescribe un
  valor distinto ni toca `total_*` del POS); ante un create duplicado,
  rebusca y vincula.
- `receiptsSyncCore.js` — Clasificación de receipts (`register` / `cancel` /
  `ignore`), `external_sale_id = loyverse_receipt_<store>_<receipt_number>`,
  ventana `LOYVERSE_WINDOW_DAYS = 30`, monto mínimo $50, cliente no mapeado
  → nunca auto-crear, `TICKET_VERSE_IDS` (49 pasajes) y asignación de
  `verse_id` con Web Crypto (nunca `Math.random`).
- `syncClaim.js` — claim atómico server-side (lease 10 min) contra el
  doble sync de clientes/receipts.
- `smtpConn.js` — resolución del puerto SMTP (Gmail: implicit TLS 465).
- `ticketEmail*.js` — render de los correos del ticket (versículos, Code
  128, `assertNoFakeData`).

### Reglas del sync de receipts

- Receipt sin `customer_id` → `no_customer`, ignorado.
- Receipt cancelado → `cancel_visit_by_sale` (no-op si nunca se registró).
- `total_money < $50` → `below_minimum`, ignorado.
- Cliente de Loyverse no mapeado a Salmos → `unmapped_customer`, ignorado
  (**nunca se auto-crea** un cliente ni una visita).
- Resto → registra visita con `register_visit_with_receipt` (que valida TODO
  con `register_visit` y persiste items/`receipt_date`/`verse_id`).
- **Watermark**: `loyverse_sync_state.updated_at_min` solo avanza si la
  corrida termina sin errores de infraestructura; los conflictos de negocio
  (`P0001`) se cuentan/reportan sin bloquear el avance.
- Si `0010` no está aplicada aún (RPC ausente, `PGRST202`), se registra con
  `register_visit` (mismas reglas) y se cuenta `detail_unavailable`.

## J. Tests y validación

- **`npm test` → 528/528 pasando en 32 archivos de test** · 0 fallos
  (`node --test`, 2026-10-07).
- **Tests de seguridad (96)** sobre PostgreSQL 17 real embebido
  (`@electric-sql/pglite`, devDependency) con el harness
  `tests/helpers/supabaseSqlHarness.mjs` (roles anon/authenticated/
  service_role y default privileges de Supabase): `rpc-authorization`,
  `bible-verse-pool-security`, `login-alias-security`,
  `auth-phone-login-core`, `auth-phone-login-client`,
  `loyverse-customer-code`, `loyverse-phone-e164`,
  `phone-identity-migrations`, `customer-profile-phone`.
- Cobertura de loyalty (documentada también en `docs/CURRENT_STATUS.md`):
  6 visitas → sin recompensa · 7 visitas → recompensa · 8.ª visita →
  pertenece al siguiente ciclo y no genera una segunda recompensa · ciclo
  nuevo → `requiredVisits = 7` · cancelación de la 7.ª visita · recompensa
  redimida · expiración.
- **`npm run build` → OK**. Único aviso: **preexistente** de chunk
  Vite > 500 kB (`index-*.js` ~595 kB, gzip ~197 kB); sin errores.
- QA real (histórico, 2026-09-15): 297 receipts procesados, 4 visitas
  reconstruidas (`1-0759→v1`, `1-0784→v2`, `1-0980→v3`, `1-0997→v4`), con
  `receipt_date` real y `verse_id` persistido; Activity `4 → 3 → 2 → 1`.

## K. Cómo ejecutar el proyecto localmente

```bash
npm install
npm run dev      # desarrollo (Vite)
npm test         # 432/432, sin navegador
npm run build    # build de producción
```

- **URLs**: `/` = Cliente, `/Staff` = Staff, `/Admin` = Admin (la SPA
  resuelve la primera ruta del pathname, sin router externo).
- **Sin `.env`**: la app corre en **modo demo** (auth mock en memoria,
  reglas de loyalty del fallback `mockDatabase`).
- **Con `.env`** (`VITE_SUPABASE_URL` + `VITE_SUPABASE_PUBLISHABLE_KEY`): registro,
  login y lecturas de lealtad pasan a **Supabase real** (RLS).

Supabase local/remoto:

```bash
supabase start                 # stack local (Postgres 17, Studio, Edge)
supabase db push               # aplica migraciones 0001-0017 (remoto: requiere SUPABASE_DB_PASSWORD)
supabase functions deploy loyalty-engine
supabase functions deploy loyverse-customers
supabase functions deploy loyverse-receipts-sync
supabase functions deploy admin-employees
supabase functions deploy send-ticket
```

(`loyverse-receipts-sync` la invoca un cron externo con el header
`x-sync-secret`.)

### Credenciales de la demo

- **Cliente:** `javier@example.com` / `demo1234` (también teléfono
  `+52 664 123 4567`). OTP demo: `123456` válido, `000000` vencido.
- **Escáner de Staff:** campo "Simular escaneo" precargado con `SC-004821`
  (tarjeta de Javier).

## L. Variables de entorno / configuración

`.env.example` está commiteado y documenta **todas** las variables con
placeholders; los valores reales viven solo en `.env` (**gitignored**).

| Variable | Dónde | Rol |
|---|---|---|
| `VITE_SUPABASE_URL` | Frontend (pública) | URL del proyecto Supabase (`https://gyugkrvdgxofnkfhzbeq.supabase.co`) |
| `VITE_SUPABASE_PUBLISHABLE_KEY` | Frontend (pública) | Publishable key (`sb_publishable_...`), sustituye a la legacy `VITE_SUPABASE_ANON_KEY` |
| `VITE_LOYALTY_ENGINE_FUNCTION_URL` | Frontend (opcional) | URL de la Edge `loyalty-engine` (default: `${VITE_SUPABASE_URL}/functions/v1/loyalty-engine`) |
| `VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL` | Frontend (opcional) | URL de la Edge `loyverse-customers` (default: `${VITE_SUPABASE_URL}/functions/v1/loyverse-customers`) |
| `LOYVERSE_ACCESS_TOKEN` | Edge (SOLO servidor) | Token de Loyverse leer/escribir |
| `SYNC_CRON_SECRET` | Edge (SOLO servidor) | Secreto compartido del cron (`x-sync-secret`) para `loyverse-receipts-sync` |
| `LOYALTY_OTP_PEPPER` | Edge `loyalty-engine` (SOLO servidor) | Clave HMAC-SHA256 del OTP de canje (`claim_start`/`claim_verify`). Fail-closed: si falta, 503. Nunca `VITE_*` |
| `SMTP_HOST/PORT/USER/PASS` | Auth y Edge `send-ticket` | SMTP custom / envío del ticket (bloques comentados en `config.toml` hasta tener proveedor/dominio) |
| `SMTP_SENDER_EMAIL / SMTP_SENDER_NAME / SMTP_APP_URL` | Edge `send-ticket` | Remitente y CTA del correo del ticket |
| `SMTP_ADMIN_EMAIL` | Auth | `[auth.email.smtp]` |
| `GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET` | Auth | `[auth.external.google]` (comentado hasta tener credenciales) |

Reglas: los tokens/secretos **jamás** van al bundle (nunca `VITE_*`); los
secretos reales **nunca** se suben a Git.

## M. Estructura de carpetas importante

```
src/
  App.jsx                     orquestador raíz + resolución por URL
  data/mockDatabase.js        "backend falso" (fallback demo) — REQUIRED_VISITS=7
  data/bible-verses.json      dataset local de 150 pasajes RVR1960 (sin red)
  services/                   motor de fidelización real; barrel ÚNICO services/index.js
    loyalty/                  loyaltyService (lecturas reales + fallback demo), rewardService (deriveStatus)
    sales/                    salesService (única puerta de ventas), ManualSalesAdapter, ticketService
    customers/  staff/  admin/  loyverse/  auth/
  screens/client/             Home, Rewards, Activity, Profile, Settings
  screens/staff/              StaffLogin, StaffHome, Scanner, CustomerFound, RegisterSale, Confirmation, StaffActivity
  screens/admin/              Dashboard, Customers, ComingSoon
  components/loyalty/         StampTrack, SyncBanner, DailyVerse (oculto del Home por diseño)
  components/activity/        TicketVerse, ReceiptPrinter, Code128Barcode
  lib/                        supabase/client.js, utils/env.js, phone.js, psalms.js,
                              ticketVerse.js, saleOrdering.js, code128.js, receiptPdf.js
tests/                        32 archivos node --test (*.test.mjs) + helpers/ (harness SQL)
email-templates/              fuente única de los 5 emails branded (confirm-signup,
                              reset-password, otp, change-email, welcome) + assets/
scripts/                      build-templates-payload.py, patch-email-templates.ps1
supabase/
  config.toml                 proyecto local, auth, templates, verify_jwt de funciones
  migrations/                 0001-0023 (G)
  functions/                  6 Edge Functions + _shared/ (I)
```

## N. Qué está terminado

- ✅ Base funcional: app + motor de fidelización real (reglas verificadas por
  tests).
- ✅ Motor de lealtad SQL (migraciones `0001`–`0007` + `0010`/`0011`/`0012`)
  y RPCs transaccionales.
- ✅ Regla vigente de **7 visitas** (`0012`), con migraciones históricas
  intactas.
- ✅ Lecturas del Cliente reales (Home, Recompensas, Actividad, Perfil,
  Configuración) directamente de Supabase (RLS), incl. detalle del ticket
  (`items`, `receipt_date`, `verse_id` persistido) y orden cronológico.
- ✅ Autenticación de Cliente en Supabase (correo/teléfono + contraseña; OTP
  solo recuperación; Google opcional; sesión persistente).
- ✅ Sync de clientes Loyverse (Fase C): crear, vincular y **actualizar
  conservadoramente**; defensa de concurrencia (claim atómico + single-flight)
  validada en el ambiente real.
- ✅ Sync de receipts (Fase D2-v1): Edge `loyverse-receipts-sync`, watermark,
  ventana 30 días, idempotencia, cancelaciones; QA real aprobado (4 visitas
  reconstruidas).
- ✅ Ticket: versículo por visita (`verse_id` → pool de 49), Code 128, PDF,
  envío por correo (`send-ticket` con nodemailer; SMTP pendiente).
- ✅ Email templates branded (5) cableados en `config.toml` + scripts de
  despliegue verificados.
- ✅ Dataset local de Salmos (150 pasajes RVR1960), `psalms.js`,
  `TicketVerse`.
- ✅ Auth real de Staff/Admin (`profiles`, `0013`) y gestión de empleados
  (`admin-employees`).
- ✅ Security Hardening `0018`–`0023` aplicado + Edges `auth-phone-login` y
  `loyverse-customers` desplegadas (ver `docs/security-hardening.md`).
- ✅ 528/528 tests pasando en 32 archivos de test; build OK.

## O. Qué está pendiente

- ⏳ Migrar las **escrituras Staff** al motor real (venta manual, canje,
  cancelación) sobre las RPCs (`register_visit`/`cancel_visit`/
  `redeem_reward`) y eliminar el DEV bridge (`ensureLoyaltyProfile` +
  `mockDatabase`).
- ✅ Scheduler formal de `loyverse-receipts-sync` en GitHub Actions
  (`.github/workflows/loyverse-receipts-sync.yml`): ejecución cada 5 min,
  POST a `vars.SYNC_URL` con `x-sync-secret: secrets.SYNC_CRON_SECRET`,
  `concurrency` con `cancel-in-progress: true`, `timeout-minutes: 10`.
  **Verificado end-to-end (QA 2026-09-16):** el workflow ejecutó la Edge
  (`Sync OK`, 12 receipts procesados). Los 12 traían `customer_id: null` →
  `no_customer` (ventas cobradas sin asignar cliente en el POS de Loyverse,
  no un fallo del sync). Queda solo la **prueba controlada**: venta ≥ $50 MXN
  asignando explícitamente un cliente en Loyverse → confirmar `customer_id` en
  el receipt vía API → esperar/ejecutar el sync → verificar la visita en
  Supabase.
- ⏳ QR con **token firmado**.
- ⏳ Emails branded en producción: publicar dominio, hospedar el logo en su
  URL definitiva (hoy URL provisional en `[LOGO_URL_PROVISIONAL]`), retirar
  comentarios, definir el disparador de `welcome.html`, y **SPF/DKIM/DMARC**
  para la entrega real.
- ⏳ SMTP real de `send-ticket` en el entorno de la Edge (hoy responde
  `email_not_configured` si no hay credenciales).
- ⏳ Credenciales reales de Google OAuth (bloque comentado en `config.toml`).
- ⏳ **Security (siguiente fase)** — detalle en
  `docs/security-hardening.md` § Pending:
  - `0024`: backfill controlado `raw_user_meta_data.phone → customers.phone`
    (auditar antes los registros actuales; solo casos `ok`).
  - `0025`: unicidad sobre el teléfono canónico (después del backfill).
  - Validar `body.phone`/`body.name` en `loyverse-customers` (hoy el body
    todavía tiene prioridad).
  - `customer_sync_events`: evaluar escritura/lectura solo `service_role`.
  - CAPTCHA / Bot Protection en Supabase Auth (hoy Disabled).
- ⏳ Publicar el frontend (hosting + variables `VITE_*` + URL Configuration
  de Auth).
- ⏳ Conectar ventas Loyverse a la UI (hoy `ManualSalesAdapter`).
- ⏳ Commit de las **mejoras UI/copy** de Activity/Home/Rewards (checkpoint
  2026-09-16 en `docs/CURRENT_STATUS.md`; cambios sin stage).

## P. Historial importante de decisiones

- **Regla de fidelidad 8 → 7 visitas.** Originalmente la recompensa se
  generaba en la 8ª visita (`0005` con `required_visits DEFAULT 8`). Por
  decisión de negocio (2026-09-15) la regla vigente es **7 visitas**,
  introducida con una migración **nueva** (`0012`) que actualiza solo ciclos
  activos; **ninguna migración histórica fue modificada**.
- **Principio de migraciones**: un cambio de regla posterior debe ser otra
  migración (`0013 → 8` si algún día volviera), nunca una edición de las ya
  aplicadas. Documentado en el README y en `docs/CURRENT_STATUS.md`.
- **Fuente de verdad de la regla**: `loyalty_cycles.required_visits` en la
  BD; el frontend/mock solo usa `REQUIRED_VISITS = 7` como fallback, nunca
  como autoridad.
- **Progreso derivado, no contador**: el esquema no guarda "N visitas";
  todo se deriva de `loyalty_visits`. El estado `expired` de la recompensa
  también se deriva en lectura (sin cron).
- **H1/C4 — endurecimiento de identidad (`0008`)**: el navegador dejó de
  escribir columnas internas de Loyverse (`loyverse_customer_id`,
  `loyverse_sync_status`, claims); las escrituras internas son SOLO
  `service_role` tras validar el JWT del dueño. La identidad de contacto
  siempre viene de GoTrue; match por teléfono solo NO vincula.
- **Doble defensa de concurrencia**: guard single-flight en el frontend +
  **claim atómico por fila** en la BD (`0006` para clientes,
  `loyverse_sync_state` para receipts; lease 10 min). El perdedor responde
  `409 … in_progress` (`retriable`) sin llamar a la API de Loyverse.
- **Idempotencia total del sync**: `external_sale_id` determinístico
  (`loyverse_receipt_<store>_<receipt_number>`) con UNIQUE; el watermark del
  sync solo avanza si la corrida termina sin errores de infraestructura; los
  errores de negocio (`P0001`) no bloquean el avance.
- **Transporte de correo: `nodemailer` (npm:nodemailer@^9)** sustituyó a
  `deno.land/x/smtp` (API Deno 1.x obsoleta → `Deno.writeAll is not a
  function`). Gmail: implicit TLS en 465 (`secure: puerto === 465`); 587 →
  STARTTLS automático.
- **Versículo por visita (`0011`)**: el ticket usa un `verse_id` **persistido**
  (se asigna con Web Crypto al registrar, nunca `Math.random`, y se conserva
  ante re-sync); visita pre-`0011` → versículo del día como fallback.
- **`receipt_date` real ≠ `created_at`** (`0010`): la fecha de negocio del
  ticket sale del receipt de Loyverse (nunca UTC ni el reloj del llamador);
  el orden de Actividad usa `receipt_date → visit_date → created_at`.
- **Regla de oro del frontend**: el cliente **nunca incrementa sus propias
  visitas**; el único camino público es `salesService.registerSale()` (Staff),
  y cancelar/redimir también los confirma Staff, nunca el cliente.
- **QA de prueba (2026-09-15)**: se limpió solo el historial de prueba del
  cliente Javier en `loyalty_visits` (nada de Loyverse se modificó/borró) y se
  reejecutó el sync con checkpoint retrocedido a `2026-09-07`.
- **Corrección documental en código (2026-09-16)**: comentario obsoleto
  "8ª visita" corregido en `supabase/functions/_shared/loyaltyEngineCore.js`
  para reflejar la regla vigente de **7 visitas** (sin cambios de lógica;
  auditoría verificó que no hay otros comentarios equivalentes en el código).
- **Checkpoint UI/copy de pantallas Cliente (2026-09-16, sin commit)**:
  mejoras de presentación en `Activity.jsx` (títulos cortos + emojis en el
  timeline; `label` como metadata secundaria en eventos no-compra;
  `console.error` en la carga), `Home.jsx` (`ready`: `remaining === 0` se
  muestra como recompensa lista; "Tu recompensa está lista" / "Disponible
  para canjear"; evita "Te faltan 0 visitas") y `Rewards.jsx` ("Disponible
  para canjear"; evita "0 visitas restantes"). Solo copy/UX — la regla de 7
  visitas y su lógica no se tocan. Se detectó y corrigió una pérdida de
  transparencia: la recompensa vigente volvió a mostrar su expiración
  ("¡Disponible para canjear! · Vence el {fecha}", `currentReward.expiresAt`)
  sin cambiar la regla de 3 meses.

## Documentation

- [`docs/security-hardening.md`](docs/security-hardening.md) — **Security
  Hardening `0018`–`0023`**: estado, contratos, fuente de verdad del teléfono
  y pendientes de seguridad.
- `docs/CURRENT_STATUS.md` — estado verificable del proyecto y checkpoint de la
  regla de 7 visitas.
- `docs/AUTH_AND_LOYVERSE_FLOW.md` — flujo de auth y sincronización con Loyverse.
- `docs/AUTH_AUDIT.md` — auditoría AUTH-1/AUTH-2 (SMTP, plantillas, Google OAuth).
- `docs/SALMOS_EMAIL_DESIGN.md` — diseño aprobado de los 5 emails branded.
- `docs/FASE_D1_DESIGN.md` — diseño de la Fase D (motor de lealtad; contiene
  referencias históricas a la regla de 8 visitas).
- `docs/psalms-dataset.md` — dataset de Salmos (150 pasajes, validación).
- `AUTH_UX_DESIGN.md` — decisiones de UX del flujo de autenticación.
- `Salmos_Estructura_de_Datos.md` — auditoría y modelo de datos original.