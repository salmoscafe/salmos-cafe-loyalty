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
- **Migraciones `0001`–`0026`** presentes localmente y aplicadas en remoto
  (verificación del equipo; la última, `0026`, el 2026-10-08). Ver sección G.
- **Security Hardening `0018`–`0026`: aplicado**, incluida la identidad
  telefónica (`0021`–`0025`) y la Fase 2A de `customer_sync_events` (`0026`
  + `loyverse-customers` v17). Resumen abajo; detalle en
  [`docs/security-hardening.md`](docs/security-hardening.md),
  [`docs/security-hardening-phone.md`](docs/security-hardening-phone.md) y la
  sección Q.
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
| `loyverse-customers` v17: `customerCode` y teléfono siempre de `customers` (`409` si el body difiere); eventos con `service_role` | ✅ Desplegada (v17) |
| `body.phone` en `loyverse-customers` (`customers.phone` autoritativo, sin fallback a `user.phone`) | ✅ Resuelto — Fase 2A / v17 (fix `1f617af`) |
| `body.name` en `loyverse-customers` (el body aún tiene prioridad para el nombre) | ⏳ Pendiente (bajo) |
| `0024` backfill controlado de teléfonos (whitelist de 3 usuarios aprobados) | ✅ Aplicada (`f10ce69`) |
| `0025` — `CHECK` E.164 MX en `customers.phone` (`+52` + 10 dígitos) | ✅ Aplicada (`2d715c5`) |
| `0026` — `customer_sync_events` backend-only (escritura solo `service_role`) | ✅ Aplicada — Fase 2A |
| CAPTCHA / Bot Protection en Supabase Auth (hoy Disabled) | ⏳ Pendiente |

Fuente de verdad del teléfono: **`customers.phone`** (canónico
`+52XXXXXXXXXX`, obligatorio desde `0025`). Detalle, contratos y pendientes:
[`docs/security-hardening.md`](docs/security-hardening.md),
[`docs/security-hardening-phone.md`](docs/security-hardening-phone.md) y la
sección Q.

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
3. La Edge Function lee la fila `customers` del usuario con su JWT (RLS) y
   toma `customerCode` y teléfono **solo** de esa fila (si el body difiere →
   `409`). Resuelve el cliente de Loyverse: busca por **email** → busca por
   **teléfono** → **vincula** o **crea**, con reglas conservadoras y defensa
   de concurrencia (claim atómico por fila). El resultado queda en
   `loyverse_customer_id`; esa columna, el claim y los eventos de
   `customer_sync_events` se escriben con `service_role`.
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
            (lee con JWT; escribe con service_role) /v1.0/customers
                                                    (token SOLO aquí)
```

## F. Base de datos

### Tablas `public` (resumen)

| Tabla | Propósito |
|---|---|
| `customers` | Un cliente por `auth_user_id`; `customer_code` único `SC-XXXXXXXX`; `loyverse_customer_id` único; columnas de claim de sync (`loyverse_sync_claim`/`_at`) y estado (`loyverse_sync_status`) |
| `customer_sync_events` | Auditoría técnica del sync de clientes (`loyverse_linked`, `loyverse_created`, `loyverse_updated`, `loyverse_already_linked`, `loyverse_conflict`, `loyverse_error`); solo la escribe el backend (`0026`) |
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
- **`customers`** (migraciones `0008`, H1, y `0023`): el frontend solo
  tiene `SELECT`, `INSERT` de columnas públicas (`auth_user_id`, name, email,
  phone, customer_code, profile) y `UPDATE` de `name`, `email`, `profile`
  (sin `phone` desde `0023`); las columnas internas `loyverse_*` solo las
  escribe la Edge Function con `service_role`.
- **`customers.phone`**: `customers_phone_e164_mx_check` (`0025`) impide
  guardar teléfonos fuera de `+52` + 10 dígitos; `customers_phone_unique_key`
  (`0008`, sobre los dígitos) evita duplicar el mismo número aunque se
  escriba con otra puntuación o formato equivalente.
- **`customer_sync_events`** (`0026`): solo `service_role` escribe;
  `authenticated` solo lee sus propios eventos (policy
  `sync_events_select_own`); `anon` sin privilegios.
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
| `0024_customers_phone_backfill.sql` | **Security:** backfill `NULL → teléfono` solo para 3 `auth_user_id` aprobados; fuente `identity_data` = metadata; aborta ante cualquier anomalía (ver sección Q) |
| `0025_customers_phone_e164_mx_check.sql` | **Security:** `CHECK` `customers.phone` `NULL` o `+52` + 10 dígitos; solo esquema, no toca filas (la unicidad la sigue dando `customers_phone_unique_key` de `0008`) |
| `0026_customer_sync_events_backend_only.sql` | **Security (Fase 2A):** `customer_sync_events` backend-only: `anon` sin privilegios, `authenticated` solo `SELECT` de sus filas (`sync_events_select_own` reemplaza a `sync_events_own_all`); no toca esquema, datos ni `service_role` |

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
- **Aplicado hasta `0026`** (verificación del equipo): el 2026-10-07
  `supabase migration list` mostró local = remoto hasta `0023`; después se
  aplicaron `0024` y `0025` con sus pre-checks, y el 2026-10-08 `0026`, tras
  desplegar y verificar `loyverse-customers` v17 (sección Q).

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
| `loyverse-customers` | `true` | Sync/creación/vínculo de clientes (v17) | JWT del usuario (verificado) + `service_role` para columnas internas y para `customer_sync_events`; `customerCode` y teléfono siempre de `customers` (si el body difiere → `409`) |
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
- `loyverseCore.js` también resuelve los datos confiables del sync:
  `resolveTrustedCustomerCode` y `resolveTrustedPhone` (`customers` es la
  única fuente; el body solo puede confirmar el valor).
- `syncClaim.js` — claim atómico server-side (lease 10 min) contra el
  doble sync de clientes/receipts.
- `syncEvents.js` — writer único de `customer_sync_events` (Fase 2A):
  siempre con `service_role`; si el INSERT falla registra
  `customer_sync_event_insert_failed` (solo `traceId`, `eventType`,
  `authUserId` y código de error) sin cambiar la respuesta.
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

- **`npm test` → 577/577 pasando en 35 archivos de test** · 0 fallos
  (`node --test`, 2026-10-08). El baseline previo a la Fase 2A (545/545 en
  33 archivos) también se verificó sin fallos.
- **Tests de seguridad** sobre PostgreSQL 17 real embebido
  (`@electric-sql/pglite`, devDependency) con el harness
  `tests/helpers/supabaseSqlHarness.mjs` (roles anon/authenticated/
  service_role y default privileges de Supabase): `rpc-authorization`,
  `bible-verse-pool-security`, `login-alias-security`,
  `auth-phone-login-core`, `auth-phone-login-client`,
  `loyverse-customer-code`, `loyverse-customer-phone`,
  `loyverse-phone-e164`, `phone-identity-migrations`,
  `customer-profile-phone`, `customer-sync-events-permissions` y
  `loyverse-sync-events` (Fase 2A).
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
tests/                        35 archivos node --test (*.test.mjs) + helpers/ (harness SQL)
email-templates/              fuente única de los 5 emails branded (confirm-signup,
                              reset-password, otp, change-email, welcome) + assets/
scripts/                      build-templates-payload.py, patch-email-templates.ps1
supabase/
  config.toml                 proyecto local, auth, templates, verify_jwt de funciones
  migrations/                 0001-0026 (G)
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
- ✅ Security Hardening `0018`–`0026` aplicado + Edges `auth-phone-login` y
  `loyverse-customers` (v17) desplegadas (ver `docs/security-hardening.md`,
  `docs/security-hardening-phone.md` y sección Q).
- ✅ 577/577 tests pasando en 35 archivos de test (2026-10-08); build OK
  (la Fase 2A no cambió el frontend).

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
- ✅ **Fase 2A**: desplegada (v17), aplicada (`0026`) y documentada en este
  commit de `main` del 2026-10-08 (`index.ts`, `_shared/syncEvents.js`,
  `0026`, 2 tests y este README).
- ⏳ **Security (siguiente fase)** — hallazgos abiertos de la sección Q:
  - `body.name` en `loyverse-customers` (el body aún tiene prioridad sobre
    el nombre; impacto bajo).
  - Ventana de `phone_is_registered` para usuarios confirmados sin fila.
  - Email del `INSERT` de `customers` desde Supabase Auth.
  - Verificación del teléfono (SMS) o alta de la fila desde el backend.
  - Revocar grants sobrantes de `anon`/`authenticated` en `customers` y
    `audit_logs` (defensa en profundidad).
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

## Q. Auditoría de identidad telefónica

- **Fecha:** 2026-10-08 (actualización; la auditoría inicial es del
  2026-10-07).
- **Estado:** auditoría completada + hardening posterior aplicado y
  verificado en remoto.
- **Etapas** (se documentan por separado; ninguna reescribe a la anterior):
  1. **Auditoría inicial** (2026-10-07, `main` @ `f10ce69`, migraciones
     `0001`–`0024`): solo inspección, sin cambios. Privilegios y policies se
     verificaron sobre el modelo local (harness
     `tests/helpers/supabaseSqlHarness.mjs`) porque esa sesión no tenía
     acceso de lectura al proyecto remoto.
  2. **Hardening posterior:** `0025` (`2d715c5`); `customers.phone` como
     única fuente del teléfono en `loyverse-customers` (`1f617af`, desplegada
     como v16); **Fase 2A** de `customer_sync_events`: `0026` +
     `_shared/syncEvents.js` + `loyverse-customers` **v17**.
  3. **Verificación remota** (equipo, 2026-10-08): código desplegado,
     migraciones, grants, policies y un probe controlado (ver "Verificación
     remota").

### Alcance

Archivos inspeccionados:

- Auth y frontend: `src/services/auth/*` (`supabaseAuthService`,
  `phoneLoginEdgeClient`, `authErrors`, `authService`, `mockAuthService`),
  `src/lib/supabase/client.js`, `src/components/auth/RegisterForm.jsx` y
  `AuthScreen.jsx`, `src/screens/client/Profile.jsx` y `Settings.jsx`,
  `src/services/customers`, `src/services/loyverse/loyverseCustomerService.js`
  y `src/services/loyverse/loyverseEdgeClient.js`.
- Edge Functions: las 6 funciones; en especial
  `supabase/functions/loyverse-customers/index.ts` y
  `supabase/functions/_shared/` (`loyverseCore.js`, `syncClaim.js`,
  `syncEvents.js`).
- Migraciones `0001`–`0026` (en especial `0021`–`0026`). Historial git
  consultado de forma pasiva.

### Migraciones de identidad y teléfono (`0021`–`0026`)

| Migración | Qué aporta |
|---|---|
| `0021` | Canonicaliza `customers.phone` legacy a `+52XXXXXXXXXX` solo en casos seguros; audita sin teléfono completo |
| `0022` | `phone_is_registered` compara en forma canónica y también considera el teléfono de la metadata de Auth del registro pendiente (usuarios confirmados o creados hace menos de 24 h); helper privado `canonical_mx_phone` |
| `0023` | Sin UPDATE directo de `customers.phone`: `anon` sin UPDATE; `authenticated` solo UPDATE de `name`, `email`, `profile` |
| `0024` | Backfill controlado `NULL → teléfono` solo para los 3 registros históricos aprobados (whitelist); aborta ante cualquier anomalía |
| `0025` | `CHECK` `customers_phone_e164_mx_check`: `customers.phone` es `NULL` o `+52` + 10 dígitos (E.164 MX); impide guardar teléfonos en otro formato. No crea unicidad: los duplicados los sigue evitando `customers_phone_unique_key` (`0008`). Solo esquema, no toca filas |
| `0026` | Fase 2A: `customer_sync_events` solo la escribe el backend (`service_role`); `authenticated` solo lee sus propios eventos; `anon` sin privilegios |

### Writers de `customers.phone`

| Ubicación | Operación | Fuente del teléfono | Quién | ¿Sobrescribe? | Tipo |
|---|---|---|---|---|---|
| `ensureCustomerProfile` (`supabaseAuthService.js`) | `INSERT` de la fila propia (1 vez) | parámetro explícito → `user_metadata.phone`, canonicalizado con `toE164Mx`; si no normaliza, `NULL` | usuario autenticado (RLS: solo su `auth_user_id`) | No: si la fila existe la devuelve; nunca hace UPDATE | Legítimo |
| `ensureCustomerProfile`, rama `23505` en `customers_phone_unique_key` | re-`INSERT` con `phone = NULL` + `phoneConflict` | — | usuario autenticado | No toca al otro customer | Legítimo |
| `0021_customers_phone_canonical.sql` | `UPDATE` legacy → E.164 MX (casos seguros) | el propio `customers.phone` | migración (`postgres`) | Solo normaliza formato | Legítimo (una vez) |
| `0024_customers_phone_backfill.sql` | `UPDATE NULL → teléfono` | `auth.identities.identity_data.phone` = metadata | migración (`postgres`) | No (abortaría) | Legítimo (whitelist de 3) |
| PostgREST `POST /customers` directo | `INSERT` de la fila propia | lo que envíe el cliente; desde `0025` solo `NULL` o `+52` + 10 dígitos | usuario autenticado sin fila previa | No (sin UPDATE de `phone` ni DELETE) | **Indirecto** (ver hallazgos) |
| `auth.updateUser({ data })` (Supabase Auth) | escribe `raw_user_meta_data` | lo que envíe el cliente | cualquier usuario con sesión (la app no lo usa: solo `updateUser({ password })`) | Solo llega a `customers.phone` si la fila **aún no existe** | **Indirecto** |
| `loyverse-customers` (`index.ts`) | `UPDATE` solo de `loyverse_*` y claim; `INSERT` en `customer_sync_events` (todo con `service_role`) | — | Edge (secret key) | No toca `phone`: lo lee de `customers` | Parece capaz, no lo hace |
| `admin-employees` | `INSERT/UPDATE` en `profiles`, `createUser` con `{ name }` | — | admin | No toca `customers` | Falso positivo |
| `ensureLoyaltyProfile` (`customerService.js`) | escribe `mockDatabase` en memoria | — | frontend | No toca Supabase | Dev bridge |

Ninguna función SQL/RPC escribe `customers` (solo leen `0018`, `0020` y
`0022`); `0025` no escribe, solo restringe el formato. Solo
`customers_set_updated_at` (BEFORE UPDATE) se dispara sobre la tabla. No
existe pantalla, endpoint ni RPC para **cambiar** el teléfono: `Profile.jsx`
lo muestra en solo lectura y "Datos personales" en `Settings.jsx` es un texto
sin acción. El historial git no muestra ningún escritor adicional eliminado.

### Flujo actual

1. **Registro:** `RegisterForm` acepta solo dígitos (máx. 10), exige
   exactamente 10 y envía `"+52 " + 10 dígitos`. Antes de enviar consulta
   `phone_is_registered` (anon).
2. `signUpWithEmail` guarda `toE164Mx(phone)` (`+52XXXXXXXXXX`) en
   `raw_user_meta_data.phone`. Supabase Auth copia esa clave a
   `auth.identities.identity_data` de la identidad `email`.
3. **Primer inicio de sesión** (email, teléfono vía `auth-phone-login`,
   recuperación u OAuth): `buildSession → ensureCustomerProfile(user, {})`
   crea la fila con el teléfono de la metadata, canonicalizado; si no
   normaliza, `NULL`; si el número ya es de otro cliente (`23505`), la fila
   se crea con `NULL` y `phoneConflict`. `auth.users.phone` no se usa.
4. **Inicios posteriores:** `ensureCustomerProfile` devuelve la fila
   existente antes de cualquier escritura. La metadata no se vuelve a leer y
   `customers.phone` no cambia aunque el login no aporte teléfono.
5. **Recuperación de contraseña:** solo `updateUser({ password })`.
6. **Sync con Loyverse:** `loyverseCustomerService` → `loyverseEdgeClient`
   envía `{ operation: "link_or_create", name, email, phone: profile.phone,
   customerCode }` a `loyverse-customers`. La Edge toma el teléfono **solo**
   de `customers.phone` y nunca lo escribe (ver "Edge Functions").

**Defecto histórico resuelto:** `buildSession → ensureCustomerProfile(user,
{})` creaba la fila con `phone = NULL` porque no leía la metadata. Desde
`9cf06ea` una fila nueva toma el teléfono de la metadata, y una fila
existente nunca se reescribe: el `{}` de un login posterior no puede borrar
un teléfono. Las 3 filas históricas afectadas con teléfono recuperable se
corrigieron con `0024` (usuarios aprobados 1, 2 y 3). No se identificó
ningún flujo legítimo actual que elimine o sobrescriba un `customers.phone`
existente.

### Protecciones

- **Privilegios de `customers` (modelo local):** `authenticated` puede INSERT
  (`auth_user_id, name, email, phone, customer_code, profile`) y UPDATE
  **solo** `name, email, profile`; sin DELETE. `anon` sin UPDATE. Policies
  `customers_select/insert/update` limitadas a `auth.uid() = auth_user_id`;
  RLS activado y **sin** policies para `anon`.
- **Formato:** `customers_phone_e164_mx_check` (`0025`) impide guardar un
  teléfono que no sea `NULL` o `+52` + 10 dígitos.
- **Unicidad:** `auth_user_id` único (1 fila por usuario).
  `customers_phone_unique_key` (`0008`) compara solo los dígitos, así que
  evita duplicar el mismo número aunque se intente escribir con otra
  puntuación o formato equivalente.
- **RPCs:** `resolve_email_for_login` solo `service_role`;
  `phone_is_registered` y `email_is_registered` (anon/authenticated) solo
  devuelven booleano; `canonical_mx_phone` privado; las RPCs del motor de
  lealtad, solo `service_role`.
- **`customer_sync_events`** (`0026`): escritura solo `service_role`; ver
  "Fase 2A".

### Edge Functions

- `auth-phone-login` (pública): solo lee y nunca devuelve email.
- `loyverse-customers` **v17** — comportamiento vigente:
  - `customers.phone` es la fuente autoritativa; `body.phone` ya no puede
    sustituirlo.
  - `body.phone` ausente, `null` o `""` → se usa `customers.phone`.
  - `body.phone` no-string → `400 invalid_body`.
  - `body.phone` string distinto del de `customers`, no canónico, o con
    `customers.phone` vacío → `409 phone_mismatch`, **sin llamar a
    Loyverse**.
  - Sin fallback a `user.phone` ni a la metadata; esta función nunca
    actualiza `customers.phone`.
  - `customerCode` siempre de `customers` (distinto → `409
    customer_code_mismatch`, auditado y sin llamar a Loyverse); email siempre
    de Supabase Auth.
  - Eventos de `customer_sync_events` escritos con `service_role` (Fase 2A).
  - Comportamiento anterior, **ya no vigente**:
    `phone = body.phone || profile?.phone || user.phone || null`.
  - `body.name` sigue teniendo prioridad sobre `customers.name` (ver
    hallazgos).

### Fase 2A — `customer_sync_events`

**Problema** (auditoría de `customer_sync_events`, 2026-10-07): la policy
`sync_events_own_all` (`FOR ALL`) permitía al dueño insertar, modificar y
borrar sus propios eventos, y 3 de los 4 puntos de escritura de
`customer_sync_events` en la Edge usaban el JWT del usuario, así que un
evento real y uno fabricado eran indistinguibles.

**Implementación:**

- `supabase/functions/loyverse-customers/index.ts`: las 4 llamadas de
  `logSyncEvent` usan el cliente `admin` (`service_role`).
- `supabase/functions/_shared/syncEvents.js` (nuevo): writer único con la
  misma forma de fila (`auth_user_id`, `trace_id`, `event_type`, `detail`,
  con el `traceId` del servidor). Si el INSERT falla (`{ error }` o
  excepción) registra `customer_sync_event_insert_failed` con solo `traceId`,
  `eventType`, `authUserId` y el código de error (sin `detail`, sin
  `error.message`, sin datos de contacto). El fallo **no** interrumpe la
  operación principal ni cambia la respuesta HTTP.
- `supabase/migrations/0026_customer_sync_events_backend_only.sql`: `anon`
  sin privilegios; `authenticated` solo `SELECT`; `sync_events_own_all`
  reemplazada por `sync_events_select_own`. Sin policy de escritura, un
  `GRANT` accidental futuro no reabre la escritura. No toca columnas,
  constraints, índices, datos, `event_type`, `service_role` ni default
  privileges.
- Orden aplicado: deploy y verificación de la Edge (v17) → después `0026`.

**Estado remoto confirmado (2026-10-08):**

| Rol | Privilegios sobre `customer_sync_events` |
|---|---|
| `anon` | Ninguno |
| `authenticated` | Solo `SELECT`, y por RLS solo sus propios eventos. `INSERT`, `UPDATE`, `DELETE`, `TRUNCATE`, `REFERENCES` y `TRIGGER` revocados |
| `service_role` | Todos (sin cambios) |

Única policy: `sync_events_select_own` (`FOR SELECT TO authenticated USING
(auth.uid() = auth_user_id)`). `sync_events_own_all` ya no existe.

### Hallazgos (vigentes al 2026-10-08)

- 🔴 **Crítico:** ninguno.
- ✅ **RESUELTO — Fase 2A / v17: `body.phone` en `loyverse-customers`.**
  Antes (Alto): `phone = body.phone || profile.phone || user.phone` permitía
  crear o completar el cliente de Loyverse con un teléfono arbitrario y
  sondear si un número existía en Loyverse. Corregido en `1f617af`
  (desplegado primero como v16) y vigente en v17 (ver "Edge Functions").
- ✅ **RESUELTO — `0026`: `customer_sync_events`.** Antes (Medio): editable
  y borrable por su dueño (`sync_events_own_all`) y escrito con el JWT del
  usuario. Ver "Fase 2A".
- ✅ **Mitigado: teléfonos no canónicos y duplicados.** El `CHECK` de
  `0025` impide guardar un `customers.phone` fuera de `+52` + 10 dígitos; el
  índice `customers_phone_unique_key` (`0008`) impide duplicar un número
  escribiéndolo con otra puntuación o formato.
- 🟡 **Medio — teléfono inicial no verificado.** Al **crear** su fila
  `customers` (por la app o con un `INSERT` directo vía PostgREST), un
  usuario autenticado puede declarar como teléfono inicial cualquier número
  **libre** en formato válido que no ha demostrado controlar. Ocurre
  únicamente al crear la fila: RLS la limita a su propio `auth.uid()`, no
  permite sobrescribir un `customers.phone` existente (sin UPDATE de
  `phone`) y no da acceso al teléfono ni a la fila de otro usuario.
  **Corrección futura:** verificación por SMS o creación de la fila desde el
  backend.
- 🟡 **Medio — reserva de números vía metadata.** Un usuario confirmado sin
  fila `customers` (por ejemplo, que nunca abrió la app) puede escribir
  cualquier número en su metadata con la API de Auth (`updateUser({ data
  })`), y `phone_is_registered` lo reportará como ocupado **sin límite de
  tiempo** (`0022` solo limita a 24 h a los no confirmados). Si el número
  está libre y en formato válido, pasaría a su `customers.phone` al crear la
  fila. **Corrección futura:** limitar la ventana también a confirmados, o
  resolver el pre-chequeo en una Edge con rate limit.
- 🟡 **Medio — relacionado (email, no teléfono).** Un usuario puede crear su
  fila con el **email** de otra persona; cuando esa persona inicie sesión,
  `ensureCustomerProfile` choca con `customers_email_unique_key`, no encuentra
  fila propia y la sesión falla. **Corrección futura:** que el INSERT tome el
  email de Supabase Auth (columna no insertable por el cliente o trigger).
- 🔵 **Bajo — `body.name` en `loyverse-customers`.** `name = body.name ||
  customers.name || metadata.name`: el body aún tiene prioridad. Solo afecta
  el nombre en Loyverse: se usa al crear el cliente o para rellenar un nombre
  vacío, y un nombre distinto nunca se sobrescribe (`skippedFields`). No toca
  `customers`. **Corrección futura:** misma regla que el teléfono.
- 🔵 **Bajo — grants de tabla amplios en `customers` y `audit_logs` (modelo
  local; en remoto solo se verificaron los de `customer_sync_events`):**
  `anon` conserva `SELECT/INSERT/DELETE/TRUNCATE` y `authenticated` conserva
  `TRUNCATE`. RLS bloquea las operaciones de fila y PostgREST no expone
  `TRUNCATE`, así que no es explotable por la API, pero conviene revocarlos
  como defensa en profundidad.
- 🔵 **Bajo — divergencia esperada Auth ↔ customers.** Un usuario puede
  cambiar `raw_user_meta_data.phone` con la API de Auth, pero eso **no**
  modifica `customers.phone`: Supabase Auth no la propaga, ningún trigger ni
  función la copia y la app solo la lee al crear la fila. Poder modificar la
  metadata no equivale a poder modificar `customers.phone`, que es el que
  manda (también para Loyverse desde v16).
- 🟢 **Correcto:**
  - `customers.phone` no puede ser actualizado directamente por `anon` ni
    `authenticated` (`0023`).
  - El formato de `customers.phone` está restringido a `+52XXXXXXXXXX`
    (`0025`).
  - `loyverse-customers` ya no confía en `body.phone`.
  - `customer_sync_events` ya no puede ser escrito, modificado ni eliminado
    directamente por usuarios autenticados (`0026`).
  - Ningún flujo de la app actualiza, sobrescribe ni pone en `NULL` un
    `customers.phone` existente; el cliente no puede hacer DELETE de
    `customers`; `0024` realizó un backfill controlado de exactamente tres
    registros históricos previamente aprobados y no abrió un mecanismo
    general de escritura de teléfonos; `auth-phone-login` no escribe nada.

### Pendientes

`body.name` en `loyverse-customers` ·
ventana de `phone_is_registered` para usuarios confirmados sin fila · email
del INSERT desde Supabase Auth · verificación del teléfono (SMS) o alta de la
fila desde el backend · revocar grants sobrantes en `customers` y
`audit_logs` · CAPTCHA.

### Verificación remota

Ejecutada por el equipo el 2026-10-08 (CLI de Supabase y SQL de solo
lectura):

- `loyverse-customers` desplegada como **v17**.
- `index.ts` y `_shared/syncEvents.js` remotos coinciden con el código local.
- `0026` aplicada; grants de `anon`, `authenticated` y `service_role` y la
  policy, confirmados (tabla de la Fase 2A).
- **Probe controlado único** con `customerCode = "PHASE2A-PROBE"` (valor
  artificial: el `CHECK` de `customer_code` lo hace imposible para un cliente
  real). El mismatch se resuelve antes de cualquier llamada a Loyverse.
  - Respuesta: `HTTP 409 Conflict`, `code: customer_code_mismatch`.
  - Se registró el `customer_sync_events` correspondiente: `loyverse_conflict`
    con el `traceId` de la respuesta, sin teléfono, email ni secretos.
  - No se creó ningún customer con `PHASE2A-PROBE`; total de customers
    después del probe: 7.

Verificación local: `npm test` → 577/577 en 35 archivos (baseline previo:
545/545 en 33).

### Qué no se modificó

- **Auditoría inicial (2026-10-07):** solo inspección. No cambió código,
  migraciones, Edge Functions, RLS, RPCs, configuración, base de datos remota
  ni `docs/`; solo este README.
- **Hardening posterior:** sí cambió código y base de datos, en fases
  separadas y autorizadas: `0024` (`f10ce69`), `0025` (`2d715c5`),
  `loyverse-customers` (`1f617af`, v16), `docs/security-hardening-phone.md`
  (`bf3c686`) y la Fase 2A (v17 + `0026`, documentada en este commit de
  `main` del 2026-10-08).
- **En ninguna etapa** se modificaron el modelo de datos de
  `customer_sync_events` (columnas, constraints, índices, `event_type`),
  `audit_logs`, `loyverse-receipts-sync`, `loyalty-engine` ni las demás Edge
  Functions.

## R. Auditoría Fase 2B — `audit_logs`

- **Fecha:** 2026-10-08 · **Referencia:** `main` @ `0b20398` (migraciones
  `0001`–`0026`).
- **Estado:** auditoría completada — **sin cambios funcionales**. Solo se
  actualizó este README.
- **Método:** inspección estática del repo, historial git (pasivo) y modelo
  local (harness `tests/helpers/supabaseSqlHarness.mjs`, PGlite en memoria
  con `0001`–`0026` y pruebas con rollback). **Verificación remota: no
  realizada** (esta sesión no tiene acceso al proyecto); queda una consulta
  de solo lectura en "Pendientes".

### Alcance

Migraciones `0002` (definición), `0005`, `0007`, `0015`, `0017`, `0018`,
`0021`, `0024`; Edge Functions `loyalty-engine`, `loyverse-receipts-sync`
(y revisión de las 6); `_shared/loyaltyEngineCore.js`,
`_shared/receiptsSyncCore.js`; frontend `src/data/mockDatabase.js`,
`src/services/{auth,loyalty,sales,staff}` y
`src/screens/staff/StaffActivity.jsx`; tests.

### Estructura (`0002`)

| Columna | Tipo / constraint | Quién la fija |
|---|---|---|
| `id` | `uuid` PK, default `gen_random_uuid()` | PostgreSQL |
| `actor_id` | `text not null` | RPC (parámetro `p_actor_id`, validado; ver "Proveniencia") |
| `actor_role` | `text not null`, `CHECK` en `customer`/`staff`/`admin`/`system` | RPC (`p_actor_role`, validado) |
| `customer_id`, `cycle_id`, `visit_id`, `reward_id` | `uuid` null, FK `on delete set null` | RPC (filas leídas dentro de la transacción) |
| `sale_id` | `text` null | RPC |
| `action` | `text not null` (sin `CHECK`) | Literal fijo en cada RPC |
| `detail` | `jsonb` null | RPC (`jsonb_build_object` con datos de la operación) |
| `created_at` | `timestamptz not null default now()` | PostgreSQL (ningún `INSERT` lo envía) |

Sin columnas de IP, user-agent ni trace ID. Índices: PK,
`(customer_id, created_at desc)` y `(cycle_id, created_at desc)`. Sin
triggers ni vistas dependientes.

### Writers encontrados

| Ubicación | Operación | Actor | Fuente del actor | Datos | ¿Puede alterar auditoría? | Tipo |
|---|---|---|---|---|---|---|
| `register_visit` (`0007`; vía `register_visit_with_receipt`, `0015`) | `INSERT` `VISIT_ADDED` / `REWARD_EARNED` | staff/admin o `system` | `p_actor_id`/`p_actor_role` validados por `assert_loyalty_actor` | visita, monto, ciclo, recompensa | No (solo `INSERT`) | Legítimo |
| `cancel_visit` (`0007`; vía `cancel_visit_by_sale`) | `INSERT` `VISIT_REVERTED` / `REWARD_CANCELLED` | ídem | ídem | visita, recompensa revertida | No | Legítimo |
| `verify_reward_claim` (`0017`) | `INSERT` `CLAIM_VERIFIED` | staff/admin | ídem | claim, recompensa | No | Legítimo |
| `redeem_reward` (`0017`) | `INSERT` `REWARD_REDEEMED` | staff/admin | ídem | recompensa, `redeemed_by` | No | Legítimo |
| `0021`, `0024` (migraciones) | `INSERT` `phone_normalize_*` / backfill | `system` | literal en la migración (`postgres`) | resultado sin teléfono completo | No | Legítimo (una vez) |
| `loyalty-engine` (Edge) | `rpc()` con `service_role` a las RPCs anteriores | staff/admin | `auth.getUser(token)` → `public.profiles` (rol y `active`) | — | No | Indirecto (legítimo) |
| `loyverse-receipts-sync` (Edge) | `rpc()` con `service_role` | `system` | constante `SYNC_ACTOR` (`loyverse-receipts-sync`) | — | No | Indirecto (legítimo) |
| `logAudit` (`src/data/mockDatabase.js`) | `push` a un arreglo en memoria | lo que pase el llamador | modo demo | — | No toca Supabase | Mock / dev bridge |
| `loyalty-engine` `lookup` | — | — | — | — | Comentario "no escribe audit_logs" | Falso positivo |

Ningún código hace `UPDATE` ni `DELETE` sobre `audit_logs` (ni RPC, ni Edge,
ni frontend, ni scripts). El frontend no escribe la tabla real.

### Lectores encontrados

| Ubicación | Qué lee | ¿Decisión de negocio? |
|---|---|---|
| `tests/phone-identity-migrations.test.mjs` | Filas de `0021` (como `postgres`, en PGlite) | No (test) |
| `staffService.getRecentActivityForStaff` → `StaffActivity.jsx` | Arreglo **mock** en memoria, no la tabla | No |

Ninguna RPC, Edge Function ni pantalla lee `public.audit_logs`. **La
integridad de `audit_logs` es principalmente forense/operacional.**

### Proveniencia del actor

- El actor nunca viene del cliente. `loyalty-engine` rechaza `actorId` /
  `actorRole` en el payload y lo deriva de la sesión (`auth.getUser`) +
  `public.profiles` (rol y `active`, leídos con `service_role`).
  `loyverse-receipts-sync` usa un actor fijo `system`.
- `assert_loyalty_actor` (`0018`), llamada por todas las RPCs escritoras,
  exige `auth.role() = 'service_role'` **sin** sesión de usuario; para
  `staff`/`admin` comprueba que `p_actor_id` sea un perfil activo con ese rol
  exacto; acepta `system`; rechaza `customer`.
- Con `0018`, `anon` y `authenticated` no tienen `EXECUTE` sobre ninguna de
  esas RPCs. No hay suplantación de actor posible desde un cliente.
- **Historial:** antes de `0018` las RPCs eran ejecutables por
  `anon`/`authenticated` (default privileges) y `assert_loyalty_actor`
  aceptaba `actor_role = 'customer'` con el propio `customers.id`; un cliente
  podía registrarse visitas (y su `VISIT_ADDED`). Corregido en `0018`
  (`9cf06ea`).

### Timestamps

`created_at` lo genera PostgreSQL (`default now()`); ninguna RPC lo envía y
ningún cliente puede insertar. Nadie puede fijar fechas futuras o anteriores
a la creación del usuario desde la API, ni reescribir eventos históricos
(sin `UPDATE`/`DELETE` en código y bloqueado por RLS para clientes).

### RLS y privilegios (modelo local)

| Rol | Privilegios de tabla | Efecto real |
|---|---|---|
| `anon` | `SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER` (default privileges) | RLS sin policies: 0 filas en SELECT/UPDATE/DELETE, INSERT rechazado. `TRUNCATE` (no cubierto por RLS) funciona en SQL, pero PostgREST no lo expone y ninguna RPC ejecuta SQL dinámico |
| `authenticated` | Igual que `anon` | Igual que `anon` |
| `service_role` | Todos (BYPASSRLS) | Writer legítimo vía RPCs |
| `postgres` | Owner | Migraciones |

RLS activada, no forzada; **ninguna policy** (decisión de `0002`: "solo
service_role"). Sin privilegios por columna.

### Edge Functions

| Función | JWT | Autentica | Cliente que escribe | Actor | ¿Actor del body? | Hallazgo |
|---|---|---|---|---|---|---|
| `loyalty-engine` | `verify_jwt = true` + `auth.getUser` | Usuario + rol en `profiles` | `service_role` (RPC) | sesión + `profiles` | No (rechazado) | Ninguno |
| `loyverse-receipts-sync` | `false` | `x-sync-secret` == `SYNC_CRON_SECRET` | `service_role` (RPC) | `system` fijo | No | Ninguno en auditoría (comparación del secreto con `!==`, no de tiempo constante; teórico) |
| `loyverse-customers`, `send-ticket`, `auth-phone-login`, `admin-employees` | — | — | — | — | — | No tocan `audit_logs` |

### RPC

| Función | Tipo | Escribe `audit_logs` | `EXECUTE` | Valida autorización |
|---|---|---|---|---|
| `register_visit` | SECURITY DEFINER | INSERT | solo `service_role` | `assert_loyalty_actor` |
| `register_visit_with_receipt` | SECURITY DEFINER | vía `register_visit` | solo `service_role` | vía `register_visit` |
| `cancel_visit` | SECURITY DEFINER | INSERT | solo `service_role` | `assert_loyalty_actor` |
| `cancel_visit_by_sale` | SECURITY DEFINER | vía `cancel_visit` | solo `service_role` | `assert_loyalty_actor` + `cancel_visit` |
| `verify_reward_claim` | SECURITY DEFINER | INSERT | solo `service_role` | `assert_loyalty_actor` |
| `redeem_reward` | SECURITY DEFINER | INSERT | solo `service_role` | `assert_loyalty_actor` |

Las únicas funciones SECURITY DEFINER ejecutables por `anon`/`authenticated`
son `phone_is_registered` y `email_is_registered`, que no tocan
`audit_logs`. Ninguna función hace `UPDATE`/`DELETE` de la tabla.

### Pruebas locales (PGlite, con rollback)

| Prueba | Esperado | Obtenido |
|---|---|---|
| P1 — authenticated inserta su propio evento | Rechazo | `42501` RLS |
| P2 — authenticated inserta evento de otro usuario | Rechazo | `42501` RLS |
| P3 — authenticated modifica su evento | Sin efecto | 0 filas |
| P4 — authenticated modifica evento de backend (`system`) | Sin efecto | 0 filas |
| P5 — authenticated borra su evento | Sin efecto | 0 filas |
| P6 — authenticated borra evento de backend | Sin efecto | 0 filas |
| P7 — authenticated inserta con fecha futura | Rechazo | `42501` RLS |
| P8 — authenticated fabrica acción `admin` | Rechazo | `42501` RLS |
| P9 — `anon`: SELECT / INSERT / UPDATE / DELETE | Sin acceso | 0 filas / `42501` / 0 / 0 |
| P9 — `anon`/authenticated: `TRUNCATE` en SQL | — | Permitido en SQL (no expuesto por API) |
| Extra — authenticated/anon llaman `register_visit` | Rechazo | `42501` permission denied |
| Extra — `service_role` con actor `admin` sin perfil | Rechazo | `42501` "No autorizado." |

El conteo final de la tabla no cambió.

### Comparación con `customer_sync_events`

| Característica | `customer_sync_events` (tras `0026`) | `audit_logs` |
|---|---|---|
| Usuario puede INSERT | No | No |
| Usuario puede UPDATE | No | No (0 filas) |
| Usuario puede DELETE | No | No (0 filas) |
| Usuario puede SELECT | Sí, solo lo suyo | No |
| Backend puede INSERT | Sí (`service_role`) | Sí (RPCs con `service_role`) |
| Actor determinado por JWT | Sí (`user.id` verificado) | Sí (sesión + `profiles`) o `system` fijo |
| Actor proporcionado por cliente | No | No |
| Timestamp controlado por DB | Sí | Sí |
| Eventos usados para decisiones | No | No |
| Riesgo de manipulación por clientes | Ninguno tras `0026` | Ninguno |

`audit_logs` ya tiene, desde `0002`/`0018`, un aislamiento igual o más
estricto que el que `0026` dio a `customer_sync_events`. **No necesita un
hardening equivalente**; solo queda la limpieza de grants de defensa en
profundidad.

### Hallazgos

- 🔴 **Crítico:** ninguno.
- 🟠 **Alto:** ninguno.
- 🟡 **Medio:** ninguno.
- 🔵 **Bajo — grants de tabla amplios.** `anon` y `authenticated` conservan
  todos los privilegios de tabla sobre `audit_logs` (default privileges),
  incluido `TRUNCATE`, que RLS no cubre. Hoy no es explotable (PostgREST no
  expone `TRUNCATE`, RLS sin policies bloquea las filas y ninguna RPC hace
  SQL dinámico). **Corrección futura:** `REVOKE` de todos los privilegios de
  `anon`/`authenticated` en una migración (mismo hallazgo que la sección Q).
- 🟢 **Informativo:**
  - Writers únicamente vía RPCs SECURITY DEFINER ejecutables solo por
    `service_role`, con actor validado por `assert_loyalty_actor`.
  - Sin `UPDATE`/`DELETE` en código; `created_at` lo fija la base.
  - Nadie lee la tabla para decisiones: integridad forense/operacional.
  - `service_role` puede modificar o borrar filas (no hay inmutabilidad a
    nivel de base); ningún código lo hace. Frontera aceptada, como en `0026`.
  - Las FKs `on delete set null` vacían referencias si se borra un
    cliente, ciclo, visita o recompensa (solo `service_role`/`postgres`
    pueden borrar esas filas).
  - `actor_role` admite `customer` en el `CHECK`, pero ningún writer actual
    lo usa (`assert_loyalty_actor` lo rechaza desde `0018`).
  - `logAudit` del frontend es un mock en memoria (modo demo), sin efecto en
    Supabase.

### Pendientes

- Verificación remota de solo lectura (SQL Editor). Valores esperados según el
  modelo local: `a_rls` `enabled=t`, `b_policies` `0`, `d_triggers` `0`,
  `e_writer_funcs` con `anon=false auth=false`, `g_future_rows` `0`. En
  `f_by_role_action`, cualquier fila con `actor_role = customer` sería
  anterior a `0018` y conviene revisarla:

```sql
select 'a_rls' as k, format('enabled=%s forced=%s', relrowsecurity, relforcerowsecurity) as v from pg_class where oid = 'public.audit_logs'::regclass
union all select 'b_policies', count(*)::text from pg_policies where schemaname = 'public' and tablename = 'audit_logs'
union all select 'c_priv', r || ': ' || coalesce(string_agg(p, ',' order by p) filter (where has_table_privilege(r, 'public.audit_logs', p)), '-') from unnest(array['anon','authenticated','service_role']) r, unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p group by r
union all select 'd_triggers', count(*)::text from pg_trigger where tgrelid = 'public.audit_logs'::regclass and not tgisinternal
union all select 'e_writer_funcs', p.proname || ' secdef=' || p.prosecdef || ' anon=' || has_function_privilege('anon', p.oid, 'execute') || ' auth=' || has_function_privilege('authenticated', p.oid, 'execute') from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc ~* 'audit_logs'
union all select 'f_by_role_action', actor_role || ' / ' || action || ' = ' || count(*) from public.audit_logs group by actor_role, action
union all select 'g_future_rows', count(*)::text from public.audit_logs where created_at > now()
union all select 'h_total', count(*)::text from public.audit_logs
order by 1, 2;
```

- Revocar los grants sobrantes de `anon`/`authenticated` (🔵), junto con los
  de `customers` (sección Q).
- Opcional: inmutabilidad también frente a `service_role` (trigger que
  rechace `UPDATE`/`DELETE`) si se quiere un registro append-only estricto.

**No se modificó** en esta auditoría: código, migraciones, Edge Functions,
RPCs, RLS, grants, configuración, base de datos remota ni tests; solo este
README.

## Documentation

- [`docs/security-hardening.md`](docs/security-hardening.md) — **Security
  Hardening `0018`–`0023`**: estado, contratos, fuente de verdad del teléfono
  y pendientes de seguridad.
- [`docs/security-hardening-phone.md`](docs/security-hardening-phone.md) —
  hardening de identidad telefónica: `0024`, `0025` y `customers.phone` como
  única fuente en `loyverse-customers`.
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