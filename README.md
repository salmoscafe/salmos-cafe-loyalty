# Salmos Café Loyalty — V1

Frontend del programa de lealtad de Salmos Café, con el motor de
fidelización real (no solo UI) implementado en `src/services/` sobre un
mock en memoria (`src/data/mockDatabase.js`), listo para reemplazar por
Supabase sin reescribir pantallas.

Ver `PLAN.md` para la auditoría original y el modelo de datos completo.

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

Ver `tests/loyalty.test.mjs` para las 14 reglas verificadas (correr con
`npm test`).

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

Fase 1 (parcial): auth real de **cliente** sobre Supabase + vínculo
automático con el cliente correcto de Loyverse, sin duplicados.

- `identifyAccount` hace un *probe* anti-enumeración con
  `signInWithOtp({ shouldCreateUser: false })`: sin error → cuenta
  existente; "Signups not allowed for otp" → cuenta nueva. La UI ve
  exactamente los mismos estados que el mock.
- `completeRegistration` asegura la fila `customers` (con
  `customer_code` `SC-XXXXXXXX` como token QR) y dispara la sincronización
  Loyverse **solo a través de la Edge Function** — nunca directo.
- `retryLoyverseSync` re-dispara la sync desde el perfil/Home si quedó
  "failed" (banner "Reintentar sincronización" en modo real).
- Staff y Admin siguen siendo mock en esta fase (su auth real es un paso
  posterior).

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
2. Aplica la migración `supabase/migrations/0001_customers.sql`
   (`supabase db push` o pégalo en el SQL Editor).
3. Despliega la Edge Function:
   ```
   supabase functions deploy loyverse-customers
   ```
   (variables `SUPABASE_URL`, `SUPABASE_ANON_KEY` y `LOYVERSE_ACCESS_TOKEN`
   configuradas en el proyecto — el token de Loyverse jamás en el frontend).
4. En Auth providers habilita Email/Phone y (si quieres) Google + SMS.

Regla de la Edge Function (en `supabase/functions/_shared/loyverseCore.js`,
probada unitariamente): busca por email → busca por teléfono (la API de
Loyverse **no** filtra por `phone_number`, así que se página y filtra) →
vincula si coincide con uno solo → **conflicto** si email y teléfono
apuntan a clientes distintos (no crea un tercero) → crea solo si no
existe, con `customer_code` como nombre estable e idempotente.

## Credenciales de la demo

- **Cliente:** `javier@example.com`.
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
    auth/                  facade authService (Supabase real ↔ mock demo)
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
    auth/                  piezas del flujo AuthScreen
    loyalty/               StampTrack, SyncBanner — visuales de fidelización
  screens/client/          Home, Recompensas, Actividad, Perfil, Configuración
  screens/staff/           Home, Escanear, Cliente encontrado,
                            Registrar venta (con sucursal), Confirmación, Actividad
  screens/admin/           Dashboard (con desglose por sucursal), Clientes + stubs
  lib/
    supabase/client.js     ÚNICA creación del cliente Supabase (null en demo)
    utils/env.js           única lectura del entorno (Vite / tests)
    delay.js               util de pausa simulada
  App.jsx                  orquestador raíz + el selector de modo (dev-only)
  styles.css               identidad visual completa (paleta real del logo)
tests/loyalty.test.mjs      suite del motor de fidelización (node --test)
tests/loyverse-sync.test.mjs  lógica de sync Loyverse (normalización y conflicto)
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
| Auth Cliente (identify → OTP → sesión persistente, Supabase) | Real, con `.env`; demo mock sin `.env` (facade `authService`) |
| Perfil `customers` + `customer_code` | Real (Postgres, RLS) cuando está configurado |
| Sync Loyverse (crear/vincular sin duplicar, con reintento y conflicto) | Real vía Edge Function; lógica probada en `tests/loyverse-sync.test.mjs` |
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
