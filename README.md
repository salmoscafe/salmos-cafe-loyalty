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

## Project Status

- **En desarrollo activo.**
- ✅ Base funcional: app + motor de fidelización real (reglas verificadas por tests).
- ✅ Autenticación de cliente en Supabase (correo/teléfono + contraseña, OTP solo para recuperación, Google).
- ✅ Sincronización Loyverse: crear, vincular y **actualizar conservadoramente** a clientes existentes (Fase C — código y tests terminados).
- ⚠️ **Deployment pendiente**: la migración `0004` y la Edge Function `loyverse-customers` actualizada aún **no** se han aplicado al ambiente real.
- ⏳ Siguiente paso: migrar el motor de lealtad a Supabase.

## Development Status

| Fase | Estado | Contenido |
|---|---|---|
| Fase A — Foundation | ✅ | Estructura de la app, arquitectura `services/`, reglas de lealtad (sobre mock) |
| Fase B — Authentication | ✅ | Supabase Auth real de cliente |
| Fase C — Loyverse Sync | ✅ | Crear/vincular/actualizar clientes (código + tests; deployment pendiente) |
| Fase D — Loyalty | ⏳ | Motor sobre mock → migrar a Supabase |
| Fase E — Sales / POS | ⏳ | `ManualSalesAdapter` hoy; ventas Loyverse no conectadas |

## Roadmap

- Foundation ✅
- Authentication ✅
- Loyverse integration ✅
- Loyverse customer sync ✅
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

- **61 tests pasando** (`npm test`): motor de lealtad, flujo de auth y
  sincronización Loyverse (crear/vincular/actualizar/conflicto).
- `npm run build` compila sin errores (hay un aviso **preexistente** de
  tamaño de chunk de Vite > 500 kB, no introducido por Fase C).
- `npm audit` reporta **0 vulnerabilidades**.

## Cómo correrlo

```bash
npm install
npm run dev
npm test        # motor de fidelización + sync Loyverse, sin navegador
```

Abre la URL que imprime Vite. Verás un selector "Cliente / Staff / Admin"
flotando arriba — **eso es una herramienta de desarrollo**, no un feature
del producto. En producción son experiencias separadas, cada una con su
propio guard de autenticación.

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
   `0002_loyalty_schema.sql` y `0003_auth_alias_rpc.sql`
   (`supabase db push` o pégalas en el SQL Editor en orden).
3. Despliega la Edge Function:
   ```
   supabase functions deploy loyverse-customers
   ```
   (variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `LOYVERSE_ACCESS_TOKEN`
   configuradas en el proyecto — el token de Loyverse jamás en el frontend).
4. En Authentication → Providers habilita **Email** (y Google si quieres
   acceso con OAuth). El proveedor **Phone/SMS queda apagado**: la
   recuperación de contraseña usa el correo.

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

## Seguridad

- El token de Loyverse vive **solo server-side** (Edge Function); el
  navegador nunca llama a `api.loyverse.com`.
- Crear/actualizar clientes ocurre **dentro de la Edge Function**, autenticada
  con el JWT del usuario (`verify_jwt`).
- **RLS activo**: cada usuario solo accede a su fila en Postgres.
- No se exponen secretos ni datos sensibles al frontend; los errores se
  traducen a mensajes amigables.

## Pending deployment (MUY IMPORTANTE)

La Fase C está terminada en código y tests, pero **aún no se ha aplicado al
ambiente real**:

1. `supabase db push` para aplicar la migración
   `supabase/migrations/0004_loyverse_updated_event.sql` (acepta el evento
   de auditoría `loyverse_updated`).
2. Redeploy de la Edge Function:
   `supabase functions deploy loyverse-customers`.

Hasta hacerlo, el ambiente real **no** tendrá el auto-update de clientes ni
podrá auditar `loyverse_updated` (mientras tanto, cualquier template de
`Loyverse Customer Updated` seguirá fallando al insertar el evento).

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
  App.jsx                  orquestador raíz + el selector de modo (dev-only)
  styles.css               identidad visual completa (paleta real del logo)
tests/loyalty.test.mjs      suite del motor de fidelización (node --test)
tests/loyverse-sync.test.mjs  lógica de sync Loyverse (normalización y conflicto)
tests/auth.test.mjs         suite del flujo de auth (contraseña + recuperación OTP)
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
| Sync Loyverse (crear/vincular/actualizar clientes sin duplicar, con reintento, conflicto de identidad y auditoría `loyverse_updated`) | Real vía Edge Function; lógica probada en `tests/loyverse-sync.test.mjs`. **Deployment pendiente**: migración `0004` y redeploy de la función aún no aplicados |
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
`customerService`) se elimina junto con `mockDatabase`.

## Documentation

- `docs/CURRENT_STATUS.md` — estado actual verificable del proyecto.
- `docs/AUTH_AND_LOYVERSE_FLOW.md` — flujo de auth y sincronización con Loyverse.
- `AUTH_UX_DESIGN.md` — decisiones de UX del flujo de autenticación.
- `Salmos_Estructura_de_Datos.md` — auditoría original y modelo de datos completo.
