# Fase D1 — Diseño: migración del motor de lealtad de Mock a Supabase

> **Estado:** Diseño entregado para revisión. **Aprobación pendiente** — no se
> implementa nada hasta que el usuario apruebe este documento. La última
> entrega (Fase C) está desplegada en git (`7fc1f6b`) pero pendiente de
> deployment en Supabase (migración 0004 + redeploy de `loyverse-customers`);
> esa pendiente es independiente y no bloquea D1.
>
> Reglas respetadas durante la elaboración: sin cambios de código, sin
> migraciones, sin commits, sin deploy.

---

## 1. Resumen ejecutivo

El motor de fidelización de Salmos hoy vive **íntegramente en memoria**
(`src/data/mockDatabase.js`). Las tablas de lealtad en Supabase
(`loyalty_cycles`, `loyalty_visits`, `rewards`, `audit_logs`, migración 0002)
existen pero están **vacías y sin uso**. Fase D (Loyverse Receipts → Salmos
Visits) no puede construirse sobre el mock; primero hay que migrar el motor a
Supabase.

**Arquitectura recomendada (Opción E):**

- **RPCs PostgreSQL (`SECURITY DEFINER`)** como la única vía de **escritura**
  transaccional: `register_visit`, `cancel_visit`, `redeem_reward`.
- **Edge Function `loyalty-engine`** (JWT autenticado) como capa de API que el
  frontend invoca para esas escrituras; convalida reglas de negocio y reenvía al
  RPC.
- **El frontend lee directamente de Supabase** (RLS SELECT-only) para ciclos,
  visitas y recompensas del cliente autenticado.

Razones: las escrituras deben ser transaccionales y auditadas (RI en Postgres es
garantizable); las lecturas son de bajo riesgo y ya están cubiertas por RLS de la
migración 0002. El mock queda eliminado al final de la fase, tras una estrategia
de feature flag.

---

## 2. Estado real (verificado)

| Pieza | Dónde vive hoy | Estado |
|---|---|---|
| Reglas de negocio (validación de venta) | `salesService.registerSale / cancelSale` | Mock (código JS) |
| Ciclos de tarjeta | `loyaltyService.addVisit` + `mockDatabase.loyaltyCycles` | Mock |
| Recompensas y expiración | `rewardService` + `mockDatabase.rewards` | Mock |
| Auditoría de negocio | `mockDatabase.logAudit` → `auditLogs[]` | Mock (arreglo en memoria) |
| Tablas Supabase de lealtad | `supabase/migrations/0002_loyalty_schema.sql` | Existen, **vacías**, sin uso |
| Auth real de clientes | Supabase `customers` + RLS (0001) | En producción |
| Sync Loyverse de clientes | Edge Function `loyverse-customers` (Fase C) | En producción remoto |
| Puente mock de desarrollo | `customerService.ensureLoyaltyProfile` (DEV BRIDGE) | Temporal, se elimina |

Todos los datos del mock son **datos de desarrollo de ejemplo** (Javier Castro,
María López, tarjetas `SC-004821`, etc.) y un ciclo completado sembrado en
memoria. **No se migran a Supabase**: se arranca desde cero con los clientes
reales ya existentes en `customers`.

---

## 3. Esquema Supabase actual (relevado de las 4 migraciones)

### 3.1 `customers` (0001)
`id` (uuid PK), `auth_user_id` (unique, FK auth.users), `name`, `email`, `phone`,
`customer_code` (`SC-XXXXXXXX`, unique), `loyverse_customer_id` (unique),
`loyverse_sync_status` (`pending|synced|failed|conflict`), `profile` (jsonb),
`created_at`, `updated_at`, `email_verified` (añadido en 0002). RLS: cliente
solo sobre su fila.

### 3.2 `loyalty_cycles` (0002)
`id`, `customer_id` FK, `cycle_number` (UNIQUE `(customer_id, cycle_number)`),
`status` (`active|completed`, CHECK coherente con `completed_at`), `started_at`,
`completed_at`, `created_at`. Índice `(customer_id, status)`.

**Ojo:** NO existe `required_visits` — el mock lo tiene como dato; aquí la
derivación de progreso se hace contando `loyalty_visits` activas del ciclo. La
migración 0002 guarda `required_visits` implícito (8), no como columna.

### 3.3 `loyalty_visits` (0002)
`id`, `customer_id` FK, `cycle_id` FK, `external_sale_id` (UNIQUE),
`amount` (`>= 50` CHECK), `visit_date` (date), `store_id`, `employee_id`,
`status` (`active|cancelled`, CHECK coherente con `cancelled_at`),
`cancelled_at`, `cancelled_by`, `created_at`.
Índice único parcial **`(customer_id, visit_date) WHERE status='active'`** →
máximo UNA visita activa por cliente y día. Índices por `cycle_id` y por
`(customer_id, created_at desc)`.

**Comentario de la tabla (0002):** `external_sale_id` = `"manual_ext_<uuid>"`
hoy, `"loyverse_receipt_<receipt_id>"` cuando se conecte el POS.

### 3.4 `rewards` (0002)
`id`, `customer_id` FK, `cycle_id` FK (UNIQUE → máximo 1 reward por ciclo),
`label` (default `'Café gratis'`), `max_value` (default 150), `earned_at`,
`expires_at` (CHECK `> earned_at`), `status` (`available|redeemed|cancelled`,
CHECK coherente con `redeemed_at/redeemed_by`), `redeemed_at`, `redeemed_by`,
`created_at`. Índice `(customer_id, status)`.

### 3.5 `audit_logs` (0002)
`id`, `actor_id`, `actor_role` (`customer|staff|admin|system`), `customer_id`,
`cycle_id`, `visit_id`, `reward_id`, `sale_id` (text), `action`, `detail` (jsonb),
`created_at`. RLS habilitada **sin políticas** → solo `service_role` accede.
Índices por customer y por cycle.

### 3.6 Resto
- `customer_sync_events` (0001): sync técnico Loyverse; 0004 amplió su CHECK con
  `loyverse_updated`. No se toca en D1.
- `0003_auth_alias_rpc.sql`: RPC de alias de auth, no relacionado a lealtad.

---

## 4. Mapa Mock → Supabase y problemas detectados

| Regla actual (mock) | Destino en Supabase | Dificultad |
|---|---|---|
| Contador `cycle.visits` guardado como dato | Derivado de `loyalty_visits` activas del ciclo (`count`) | Media — hay que reescribir la derivación |
| `requiredVisits` en el ciclo | No existe en esquema; se propone columna con default 8 (ver §19.1) | Baja |
| `addVisit` interno de `salesService` | RPC `register_visit` | Alta — transaccionalidad y concurrencia |
| `cancelSale` + reversión de reward/ciclo | RPC `cancel_visit` | Alta |
| `redeemReward` + apertura inmediata del siguiente ciclo | RPC `redeem_reward` | Media |
| `deriveStatus("expired")` en lectura | Se mantiene igual en el cliente o se deriva en SQL | Baja |
| `paymentMethod` de la venta hoy en `sales[]` (mock) | No existe en `loyalty_visits`; se propone columna (ver §19.1) | Baja |
| `branchId` / `employeeId` | Ya existen (`store_id`, `employee_id`) | Baja |
| `logAudit` (memoria) | INSERT a `audit_logs` dentro del mismo RPC | Media |

**5 problemas detectados al mapear:**
1. **El progreso se guarda como contador** en el mock (`cycle.visits`) pero debe
   **derivarse** de `loyalty_visits` en Postgres; cualquier lógica en el frontend
   que asuma el contador debe migrar a un cálculo.
2. **`required_visits` no existe en el esquema 0002** (la derivación es implícita
   a 8) — si algún día cambia la regla, necesitamos la columna.
3. **No hay `source` ni `payment_method`** en `loyalty_visits`; al conectar el POS
   (Fase D2) será necesario distinguir manual vs Loyverse y registrar el método.
4. **La apertura del siguiente ciclo no está prevista** en el esquema (no hay
   UNIQUE parcial sobre ciclos); al crear el ciclo siguiente en `redeem_reward`
   puede haber carrera entre dos redenciones simultáneas.
5. **`cancelSale` bloquea según un contador y un "ciclo ya completado"**, lógica
   que en SQL requiere `SELECT ... FOR UPDATE` y conteo real de visitas activas
   para reproducirse sin estados intermedios corruptos.

---

## 5. Arquitectura propuesta (Opción E)

```
┌─────────────────────┐        SELECT (RLS)         ┌──────────────────────┐
│   Frontend (React)  │ ─────────────────────────► │  Supabase (Postgres)  │
│                     │  ciclos/visitas/rewards      │  loyalty_cycles       │
│  cliente: lectura   │  del cliente autenticado      │  loyalty_visits       │
│  staff/admin: misma │                              │  rewards               │
│  lectura + RPC vía  │                              │  audit_logs            │
│  Edge Function      │                              └──────────────────────┘
│                     │        POST (JWT)                ▲
│                     │ ──────────────────────────►      │ service_role
└─────────┬───────────┘   /functions/v1/loyalty-engine  ┌┴─────────────────────┐
          │                                             │ loyalty-engine       │
          │                     integra el JWT          │ (Edge Function)      │
          │                     valida reglas           │   → INSERT/UPDATE    │
          └─────────────────────────────────────────────►  vía RPC SECURITY    │
                                                          │  DEFINER (tx)       │
                                                          └─────────────────────┘
```

Principios:
- **Escrituras = RPC transaccionales** (`SECURITY DEFINER` + `SECURITY INVOKER`
  restringido). Un RPC ejecuta toda la mutación en una sola transacción: si algo
  falla, nada se escribe.
- **Edge Function como único invocador externo de las escrituras**: recibe el
  JWT del Staff/Admin autenticado, valida (rol, permisos, formato), y ejecuta el
  RPC con `service_role`. Nunca el navegador inserta directamente.
- **Lecturas = SELECT directo** cubierto por las políticas RLS de 0002 (el
  cliente solo ve lo suyo).
- **`external_sale_id` UNIQUE como clave de idempotencia genérica**: hoy
  `manual_ext_<uuid>`, mañana `loyverse_receipt_<receipt_id>`. Un mismo recibo
  de Loyverse jamás duplicará una visita.
- **`visit_date` calculada por el backend** (zona del negocio), no por el
  navegador.
- **No hay datos del mock que migrar**; Supabase empieza desde cero con los
  clientes reales.

---

## 6. Diseño de ciclos (`loyalty_cycles`)

- El **ciclo vigente** de un cliente es el `active`; si no hay ninguno (entre el
  8/8 y el canje, igual que hoy en `currentCycleForCard`), se usa el **más
  reciente** para que la tarjeta siga mostrando «recompensa lista» y no resetee
  a 0/8.
- El progreso **se deriva**: `SELECT count(*) FROM loyalty_visits WHERE
  cycle_id = :id AND status = 'active'`.
- El ciclo se **crea** en `register_visit` cuando el cliente no tiene uno
  activo (equivalente a `addVisit`). `cycle_number` = `max+1` bajo el UNIQUE
  `(customer_id, cycle_number)`; ante colisión (23505) se reintenta.
- El ciclo se **completa** en la 8ª visita (`status='completed'`,
  `completed_at=now()`).
- El **siguiente ciclo se crea** en `redeem_reward`, en la misma transacción
  que marca la recompensa como redeemed.
- **Cancelación de la visita 8**: revierte la recompensa (`cancelled`) y vuelve
  el ciclo a `active` (`completed_at=NULL`).

---

## 7. Diseño de visitas (`loyalty_visits`)

- UNA fila por visita válida. Validaciones en el RPC `register_visit`:
  - Cliente existe.
  - Sucursal/empleado válidos (si aplican).
  - `amount >= 50` (el CHECK de 0002 ya lo fuerza en BD).
  - Máximo UNA visita **activa** por cliente y día (índice único parcial
    `(customer_id, visit_date) WHERE status='active'`); una `cancelled` permite
    registrar otra el mismo día.
  - Idempotencia por `external_sale_id`: si el RPC recibe uno ya existente,
    devuelve la visita registrada (sin duplicar).
- `visit_date` = día de negocio calculado por el backend; `store_id` y
  `employee_id` se trasladan desde la venta.
- Se propone añadir `source` (`'manual'|'loyverse'`, default `'manual'`) y
  `payment_method` (default `'No especificado'`). (Ver §19.1.)

---

## 8. Diseño de recompensas (`rewards`)

- La **8ª visita** del ciclo crea el reward (`label='Café gratis'`,
  `max_value=150`, `earned_at=now()`, `expires_at=earned_at + 3 meses`). El
  UNIQUE `(cycle_id)` garantiza máximo 1 por ciclo.
- `expired` **se deriva en lectura** (`status='available' AND expires_at <
  now()`), nunca se escribe — igual que `deriveStatus` de hoy y como indica el
  comentario de 0002.
- `redeem_reward`: marca `redeemed` con `redeemed_at`/`redeemed_by=actorId` y
  abre el ciclo siguiente en la misma transacción. Rechaza recompensas no
  disponibles o vencidas.
- **Regla de cancelación:** si la venta que **generó** la recompensa fue
  cancelada después de redimir, la cancelación se **bloquea** (igual que hoy:
  «Esta venta generó una recompensa que ya fue redimida»).

---

## 9. Cancelaciones

`cancel_visit(external_sale_id o sale_id, actor, ...)` — transaccional:

| Caso | Comportamiento |
|---|---|
| Venta generadora sin reward redimido | Visita → `cancelled`; reward (si la disparó) → `cancelled`; ciclo → `active` si era la visita 8 |
| Venta no generadora dentro de ciclo aún activo | Visita → `cancelled`; el progreso derivado baja naturalmente |
| Venta no generadora dentro de ciclo ya `completed` | **Bloqueo** (una venta posterior lo cerró): revertir dejaría un ciclo completed con menos de 8 visitas |
| Reward ya redimido | **Bloqueo** (la recompensa no se revierte) |
| Venta ya cancelada | Error idempotente/estado |
| Venta inexistente | Error |

Todas las reglas de bloqueo se evalúan con `SELECT ... FOR UPDATE` sobre la
visita y el ciclo para evitar carreras (ver §11).

---

## 10. Idempotencia

- **Clave única:** `loyalty_visits.external_sale_id` (UNIQUE).
- Hoy el frontend genera `manual_ext_<uuid>`; en D2 Loyverse mandará
  `loyverse_receipt_<receipt_id>` (vía sync en otra función, fuera de D1).
- Estrategia del RPC: `INSERT ... ON CONFLICT (external_sale_id) DO NOTHING`
  dentro de la transacción; si no se insertó, recuperar la fila existente y
  devolverla con bandera `reused: true` — comportamiento equivalente a
  `buildResultFromExistingSale` del mock.

---

## 11. Concurrencia

- **1 visita/activa/día:** índice único parcial `(customer_id, visit_date) WHERE
  status='active'` — dos `register_visit` simultáneos: solo sobrevive uno (el
  otro recibe `23505` → error amigable «ya registró visita hoy»).
- **Ciclo siguiente:** al crear el ciclo post-redeem, el UNIQUE
  `(customer_id, cycle_number)` reintenta `max+1`; este RPC añade garantía extra
  con `SELECT ... FOR UPDATE` del ciclo redimido.
- **Cancelación:** `SELECT ... FOR UPDATE` sobre la visita y el ciclo evita que
  una cancelación y una redención simultáneas corrompan el estado.
- **Opcional (propuesto):** índice único parcial sobre `loyalty_cycles
  (customer_id) WHERE status='active'` → máximo un ciclo activo por cliente, y
  la creación del siguiente ciclo en `redeem_reward` queda en la misma
  transacción de la redención (que ya bloquea el reward). (Ver §19.1.)

---

## 12. Redención (`redeem_reward`)

- La invoca **Staff** confirmando el QR del cliente que muestra su recompensa
  «lista».
- En una sola transacción: valida que exista reward `available` y no vencido →
  marca `redeemed` con actor → crea el ciclo siguiente `active` (0 visitas) →
  escribe `audit_logs` (`REWARD_REDEEMED`).
- Devuelve el reward redimido y el nuevo ciclo para que el frontend pueda
  refrescar.

---

## 13. Auditoría

- Cada RPC escribe `audit_logs` en la **misma transacción** que la mutación
  (`VISIT_ADDED`, `PURCHASE_REGISTERED` en la venta catalogada, `VISIT_REVERTED`,
  `REWARD_CANCELLED`, `REWARD_EARNED`, `REWARD_REDEEMED`), con
  `actor_id`/`actor_role` del JWT validado por la Edge Function.
- `audit_logs` queda sin políticas RLS (solo `service_role`), como diseñó 0002.
- `customer_sync_events` sigue separada: es sincronización técnica con
  Loyverse, no auditoría de negocio.

---

## 14. RLS

- **Lecturas cliente:** las políticas de 0002 (`loyalty_*_client_select`) ya
  limitan cada SELECT a `c.auth_user_id = auth.uid()`. Se conservan tal cual.
- **Escrituras:** el navegador **no** tiene permisos; las mutaciones solo
  ocurren desde la Edge Function (service role) o los RPC `SECURITY DEFINER`
  que verifican el actor vía JWT. `audit_logs` continúa restringida.
- No se agregan políticas nuevas de escritura en D1.

---

## 15. Frontend — mapa de componentes afectados

Hoy los screens consumen el mock vía `card` (`card.id`, `card.cardNumber`,
`card.customerId`) y `customer`; con Supabase el ancla pasa a ser el
`customer.id` (UUID real).

| Pantalla | Servicios usados hoy | Cambio en D1 |
|---|---|---|
| `client/Home.jsx` | `REQUIRED_VISITS`, `customer.loyverseSyncStatus`, `card.cardNumber`, `cycle`, `currentReward` | Leer ciclo/recompensa desde Supabase vía `customer.id` |
| `client/Rewards.jsx` | `getPastRewards(card.id)` | Consulta directa `rewards` (RLS) |
| `client/Activity.jsx` | `getSalesForCustomer` + `getRewardsForCard(card.id)` | Consulta `sales`/`visits` y `rewards` |
| `client/Profile.jsx` | `getCycleHistory(card.id)` + `getRewardsForCard` | Oscila de `card.id` a `customer.id` |
| `client/Settings.jsx` | auth | Sin cambios en dominio lealtad |
| `staff/CustomerFound.jsx` | `getCurrentReward(card.id)` + `redeemReward({cardId,...})` | Invocar Edge Function `loyalty-engine/redeem` |
| `staff/RegisterSale.jsx` | `staffService.listBranches` (mock) + `onSubmit → registerSale` | Invocar Edge Function `loyalty-engine/visit` |
| `staff/Confirmation.jsx` | resultado de `registerSale` | Adaptar forma del resultado |
| `staff/StaffActivity.jsx` | `getAllSales` | Consulta `sales`/`visits` |
| `staff/Scanner.jsx` | scan QR | Sin cambios de dominio (el token sigue resolviéndose en backend) |
| `staff/StaffHome.jsx` | navegación | Sin cambios |
| `admin/Dashboard.jsx` | `getAllSales`, agregados | Consulta con `service_role`/admin over Supabase |
| `admin/Customers.jsx` | `searchCustomers` (mock) | Consulta `customers` |
| Componente `loyalty/StampTrack.jsx` | `visits/required` | Sin cambios (recibe valores ya resueltos) |

Además:
- `services/index.js` (barrel): adecuar exports (hoy excluye `addVisit`);
  probablemente resuelva el servicio Supabase según feature flag.
- `services/sales/salesAdapters.js`: adaptar `ManualSalesAdapter` al nuevo
  transporte (Edge Function) manteniendo el contrato `normalized`.
- `components/loyalty/SyncBanner.jsx`: sigue leyendo `loyverseSyncStatus`.

---

## 16. Compatibilidad con Fase C

**22 archivos de Fase C/estructura quedan intactos en D1** (no se modifican):
`supabase/functions/loyverse-customers/index.ts`,
`supabase/functions/_shared/loyverseCore.js`, migraciones `0001`–`0004`,
`src/services/loyverse/*`, `src/services/auth/supabaseAuthService.js`
(excepto la llamada al DEV bridge que se elimina), `customer_sync_events` y su
RLS, `customers` y su RLS, `SyncBanner` y el flujo `loyverse_sync_status`.
El DEV bridge `ensureLoyaltyProfile` es **código de transición** (marcado en el
propio archivo) y se elimina en D1 — no forma parte del alcance protegido.

---

## 17. Migración `0005_loyalty_engine.sql` (propuesta)

Sin ejecutar nada todavía. Contenido propuesto (a validar en PostgreSQL
descartable durante D1.1):

1. `alter table public.loyalty_cycles add column required_visits integer not
   null default 8 check (required_visits > 0);`
2. `alter table public.loyalty_visits add column source text not null default
   'manual' check (source in ('manual','loyverse'));`
3. `alter table public.loyalty_visits add column payment_method text not null
   default 'No especificado';`
4. *(Opcional)* índice único parcial `(customer_id) WHERE status='active'` sobre
   `loyalty_cycles`.
5. RPCs en `security definer`:
   - `register_visit(p_customer_id, p_external_sale_id, p_amount, p_visit_date,
     p_store_id, p_employee_id, p_payment_method, p_actor_id, p_actor_role)` →
     INSERT con `ON CONFLICT (external_sale_id) DO NOTHING`, `SELECT FOR UPDATE`
     del ciclo activo (o creación), conteo de visitas activas, creación del
     reward en la 8ª visita, `audit_logs`. Retorna `(visit_id, cycle_id,
     reward_id, reused)`.
   - `cancel_visit(p_visit_id, p_actor_id, p_actor_role)` → validaciones de §9,
     `FOR UPDATE`, reversión de visita (+reward y ciclo si corresponde),
     `audit_logs`.
   - `redeem_reward(p_reward_id, p_actor_id, p_actor_role)` → validación de
     disponibilidad/vencimiento, marca `redeemed`, crea ciclo siguiente,
     `audit_logs`.
6. `audit_logs` se llena desde los propios RPC (misma tx).

La regla de validación durante la creación (descartable en puerto 55433 con
stubs de `auth`, mismo patrón usado con 0004) evita tocar el entorno remoto.

---

## 18. Archivos a modificar / nuevos / intactos

**Nuevos:**
- `supabase/migrations/0005_loyalty_engine.sql` (columna + RPCs).
- `supabase/functions/loyalty-engine/index.ts` (Edge Function API layer:
  `POST /visit`, `POST /cancel`, `POST /redeem`; valida JWT y reglas; ejecuta
  los RPC con `service_role`).

**Modificados:**
- `src/services/sales/salesService.js` (register/cancel contra Edge Function o
  RPC, manteniendo contrato de retorno).
- `src/services/loyalty/loyaltyService.js` (lecturas desde Supabase; `addVisit`
  deja de existir).
- `src/services/loyalty/rewardService.js` (consultas RLS + redeem vía Edge
  Function).
- `src/services/customers/customerService.js` (eliminar `ensureLoyaltyProfile`;
  `findCustomerByToken` resuelve en Supabase).
- `src/services/index.js` (barrel según feature flag).
- Screens del §15 según mapa.
- `src/services/sales/salesAdapters.js` (transporte).
- `src/lib/supabase/client.js` (configuración feature flag, si aplica).

**Eliminados al final de D1:**
- `src/data/mockDatabase.js` (tras D1.9).
- DEV bridge en `customerService.js`.

**Intactos:** los 22 archivos de Fase C/estructura (ver §16) + `auth/*`,
`ticketService.js`, `SyncBanner`, `StampTrack`, migraciones 0001–0004,
`customer_sync_events`, RLS existentes.

---

## 19. Decisiones pendientes (5)

1. **Aprobar Opción E** (RPCs transaccionales + Edge Function `loyalty-engine` +
   lecturas directas con RLS) frente a alternativas (todo dentro de la Edge
   Function; o Drizzle/ORM del lado cliente).
2. **Columnas de 0005:** confirmar `required_visits` (default 8) en cycles y
   `source`/`payment_method` en visits.
3. **Estrategia de transición:** feature flag
   `USE_SUPABASE_LOYALTY = isSupabaseConfigured` (alternar mock/Supabase durante
   la migración) + **no migrar datos del mock** (arrancar limpio en Supabase).
4. **Formato de `external_sale_id`:** mantener `manual_ext_<uuid>` hoy
   (preparado para `loyverse_receipt_<receipt_id>`), sin reescribir lo sembrado.
5. **UNIQUE parcial opcional** sobre ciclos activos por cliente (máximo 1 activo)
   como refuerzo de concurrencia — pendiente de aprobar antes de 0005.

---

## 20. Plan de implementación D1.1 – D1.10

Orden propuesto: **backend primero, frontend después, eliminación del mock al
final** (cada paso deja la app funcionando; el feature flag protege la
transición).

| Paso | Entregable | Verificación |
|---|---|---|
| **D1.1** | Migración 0005 (columnas + 3 RPCs) | Validación en PostgreSQL descartable (puerto 55433, stubs de `auth`), tests de RPC |
| **D1.2** | Edge Function `loyalty-engine` (visit/cancel/redeem) | Tests unitarios; smoke con curl + JWT |
| **D1.3** | Feature flag + capa de servicio Supabase en frontend | `npm run build` sin romper nada |
| **D1.4** | `salesService.registerSale/cancelSale` contra Supabase | Tests adaptados (61 suite) |
| **D1.5** | `loyaltyService`/`rewardService` lecturas Supabase | Mismo contrato de retorno en pantallas |
| **D1.6** | `CustomerFound` / redención vía Edge Function | Flujo staff → redeem → nuevo ciclo |
| **D1.7** | Pantallas cliente (Home/Rewards/Activity/Profile) | RLS lectura correcta por `customer.id` |
| **D1.8** | Pantallas staff/admin (RegisterSale/Activity/Dashboard/Customers) | Flujos manuales completos |
| **D1.9** | Eliminar `ensureLoyaltyProfile` + `mockDatabase` | Grep sin referencias; build+test verdes |
| **D1.10** | Migrar `tests/loyalty.test.mjs` contra Supabase real/docker + E2E | 61/61 (o la nueva matriz) verdes |

---

## 21. Criterios de aceptación (19)

1. Las escrituras de lealtad SOLO ocurren vía RPCs transaccionales; una falla a
   medio camino no deja mutaciones parciales.
2. El navegador no puede INSERT/UPDATE/DELETE tablas de lealtad (RLS + permisos
   revocados); las lecturas del cliente quedan en su fila.
3. Una venta con el mismo `external_sale_id` jamás genera dos visitas
   (`reused: true`, sin duplicado).
4. Máximo UNA visita activa por cliente y día; una cancelada permite otra el
   mismo día.
5. `visit_date` la calcula el backend, nunca el navegador.
6. El min de $50 MXN se respeta (CHECK 0002 + RPC).
7. El 8/8 genera exactamente UN reward por ciclo (UNIQUE `cycle_id`).
8. `expires_at = earned_at + 3 meses` lo calcula el backend; `expired` se deriva
   en lectura, nunca se persiste.
9. Redimir una recompensa abre el siguiente ciclo en la misma transacción.
10. Cancelar la venta que generó la recompensa (aún no redimida) revierte
    visita + reward y deja el ciclo `active`.
11. Cancelar una venta que NO generó la recompensa dentro de un ciclo ya
    `completed` se bloquea.
12. Cancelar una venta con recompensa ya redimida se bloquea.
13. Cancelar una venta ya cancelada o inexistente es idempotente/errores
    controlados.
14. Cada mutación escribe `audit_logs` con actor validado en la misma
    transacción.
15. El cliente solo ve sus ciclos/visitas/recompensas (RLS); audit_logs es
    inaccesible para clientes.
16. El frontend exhibe el mismo comportamiento que hoy (tarjeta, sellos,
    «Estás a N visitas», QR de canje) con datos reales.
17. El feature flag permite alternar mock/Supabase durante la transición sin
    cambios de pantalla.
18. Al terminar, no existe referencia a `mockDatabase` en el código y la suite
    (61 tests o la matriz actualizada) pasa en verde.
19. Los 22 archivos de Fase C/estructura permanecen sin cambios funcionales.

---

## 22. Notas de la auditoría Fase D (contexto)

- Loyverse `GET /receipts` no permite filtrar por `customer_id` directamente;
  hay que filtrar por `updated_at_min`/`created_at_min` + paginar con
  `cursor`/`limit`.
- `customer_id` puede venir `null` en receipts → se guardan como no atribuibles
  y NO generan visita.
- La tabla `loyverse_receipts` (staging) es **Fase D2**, no D1; aquí solo se deja
  listo `external_sale_id` para recibirla. `source='loyverse'` ya queda
  contemplado en visits desde D1.

## 23. Implementación D1.1 — correcciones y notas (validado en PostgreSQL 17)

Estado: `0005_loyalty_engine.sql` implementado y validado (53/53 checks RPC +
concurrencia + seguridad; 61/61 tests JS; build OK). Sin deploy.

- **Defaults en `register_visit`**: PostgreSQL no permite un parámetro con
  `default` en medio de la firma; el `p_source default 'manual'` (decisión del
  diseño) obligó a dar defaults también a `p_actor_id default 'system'` y
  `p_actor_role default 'staff'` (últimos parámetros). La Edge Function D1.2 usa
  la firma completa de 9 argumentos; los defaults no cambian el contrato.
- **Recompensa "revivida" al re-completar un ciclo**: `cancel_visit` sobre la
  visita generadora cancela la recompensa (status `cancelled`) y reabre el ciclo
  (active + `completed_at` NULL). Al volverse a alcanzar `required_visits`, el
  `INSERT ... ON CONFLICT (cycle_id)` reescribe la recompensa cancelada a
  `available` con nueva ventana (earned/expiry) vía `WHERE status='cancelled'`;
  los estados `available`/`redeemed` nunca se reescriben. Equivale al
  `cycle.rewardId = null` del mock y NO cambia el modelo de datos.
- **Columna pendiente** `loyalty_visits.triggered_reward_id` (para hacer
  explícita la visita generadora) se mantiene como `DECISIÓN PENDIENTE` para D1.2.
- **Actor**: los RPCs reciben `p_actor_id text`/`p_actor_role text` (staff/admin/
  system). Con JWT de usuario, `assert_loyalty_actor` solo acepta
  `customer` vinculado a `auth.uid()`; sin JWT, solo `service_role`. Los grants
  de ejecución son exclusivos de `service_role`.