# Salmos Café Loyalty — Current Status

Estado del proyecto sobre `main` @ `483eeae`
(`feat(loyalty): update reward cycle to 7 visits`). Los cambios de las
pantallas Cliente (Activity/Home/Rewards) están pendientes de stage (ver
checkpoint "Mejoras UI/copy" abajo). Todo lo documentado aquí fue verificado
contra el código real y el proyecto remoto; nada se da por sentado de la
documentación.

Última actualización: 2026-09-16.

---

## Checkpoint — CP3.3-A Scheduler del Loyverse Receipts Sync (GitHub Actions)

**Fecha:** 16 de septiembre de 2026.

**Objetivo:** lograr la ejecución automática de la Edge `loyverse-receipts-sync`
(único bloqueador productivo del audit CP3.3) cada 5 minutos, sin tocar la
lógica de la función, RPCs, migraciones, loyalty rules, QR, Claim/OTP/Redeem,
`loyverse-customers` ni `loyalty-engine`.

- **Audit CP3.3 (base):** VEREDICTO "1 — listo para scheduler/deploy". El sync
  es funcional; no necesita cambios de código. Scheduler era lo único faltante.
- **Proveedor elegido — GitHub Actions** (no Vercel Cron, no pg_cron):
  - El repo `salmoscafe/salmos-cafe-loyalty` es **público** → minutos
    ilimitados en el plan estándar gratis de Actions (límites solo para
    repos privados).
  - Vercel Cron en Hobby **mínimo 1 vez por día** (no cumple la cadencia de la
    regla de negocio $50/1-por-día, que el sync ya aplica) y no hay hosting
    Vercel en el repo.
  - GitHub Actions soporta `schedule` con cron por minuto; se usa `*/5 * * * *`
    (UTC) acorde al imperativo de frecuencia del checkpoint.
- **Workflow** `.github/workflows/loyverse-receipts-sync.yml`:
  - `on.schedule` `*/5 * * * *` + `on.workflow_dispatch` (prueba manual).
  - `concurrency` group `loyverse-receipts-sync` + `cancel-in-progress: true`
    (un run por vez; seguro porque la Edge ya tiene claim atómico con lease).
  - `permissions: contents: read` (solo `actions/checkout@v4`).
  - Step único: `Invoke-RestMethod` (PowerShell Core) POST a
    `vars.SYNC_URL` con header `x-sync-secret: secrets.SYNC_CRON_SECRET` y body
    `{}` (`timeout-minutes: 10`; `exit 1` con status HTTP si falla).
  - **No contiene** `SUPABASE_SERVICE_ROLE_KEY` ni ningún valor de secreto.
- **Configuración remota realizada y verificada:** repository secret
  `SYNC_CRON_SECRET` y repository variable `SYNC_URL` configurados en GitHub
  Actions; el workflow corre **automáticamente cada 5 minutos** (schedule) y
  también manualmente (`workflow_dispatch`). La autenticación `x-sync-secret`
  contra la Edge funcionó correctamente.
- **Ejecución real verificada (QA 2026-09-16):** el workflow llamó a
  `loyverse-receipts-sync`; la Edge respondió `Sync OK` y procesó **12
  receipts** (`pages: 1`, `registered: 0`, `no_customer: 12`). Los 12 recibos
  (del 1-0999 al 1-1010) tenían `customer_id: null` en la API de Loyverse.
- **`no_customer` es una condición operacional, no un fallo del sync:** esas
  ventas se cobraron **sin asignar cliente en el POS de Loyverse**, por eso el
  receipt no trae `customer_id`. La arquitectura es intencional: **Salmos NO
  asigna clientes en Loyverse**; el cliente debe asignarse desde el POS.
  Contra prueba de control: el receipt histórico `1-0759` sí trae
  `customer_id` (`f1f60b21-…`, tienda Salmos, 105 MXN) y su visita se registró.
- **CP3.3-A: COMPLETO.** Validaciones finales: 359/359 tests pass, `npm run
  build` exitoso (solo el aviso preexistente de chunk Vite > 500 kB), `npm
  audit` 0.
- **Pendiente (únicamente la prueba operativa final):** realizar una venta
  ≥ $50 MXN asignando **explícitamente un cliente** durante el checkout en
  Loyverse; confirmar vía API que el receipt trae `customer_id`; esperar o
  ejecutar el sync (≤ 5 min); comprobar que el cliente es identificado y que
  la visita aparece en Supabase. No modificar la lógica de sync hasta que esa
  prueba revele un error adicional.

---

## Nota — `supabase secrets list` NO expone valores (corrige nota previa)

En la auditoría CP3.3 se anotó que `supabase secrets list` (CLI v2.116.0)
habría impreso los **valores** de los secrets en texto plano. **Verificado en
CP3.3-A que es incorrecto:** la salida en v2.116.0 devuelve los valores
**encriptados/hasheados** (64 caracteres hex), nunca el valor real — p. ej.,
`SMTP_PORT` aparece como `ad3b8537…` y no como un número de puerto, y
`SUPABASE_URL` como un hash y no como la URL real. Por lo tanto **no hubo
fuga de secrets por el terminal**. Se mantiene la recomendación operativa de
no imprimir ni compartir la salida cruda de `supabase secrets list`
(precaución estándar), pero sin tratarla como incidente.

---

## Checkpoint — CP3.2.1 Ajuste de UI del Staff según arquitectura real

**Fecha:** 16 de septiembre de 2026.

**Objetivo:** corregir la *presentación* (no la lógica) para que quede clara la
separación entre compra y recompensa, tras el audit READ-ONLY que confirmó que
la compra real NO depende del Scanner de Salmos pero la UI lo sugería.

- **Compra normal (intacta en arquitectura):** cliente llega → Staff
  identifica/asigna directo en el POS de Loyverse → ticket → productos → pago
  → receipt → `loyverse-receipts-sync` → Salmos procesa la visita. **Salmos
  NO escanea al cliente en este flujo.**
- **Recompensa:** cliente muestra su QR → Staff valida en Salmos (Claim/OTP/
  Redeem en un checkpoint posterior; aquí NO se implementaron).
- **`StaffHome.jsx`**: se eliminó el tile "Asignar cliente al ticket" (no debe
  existir una acción en Salmos que sugiera asignar clientes al ticket). El
  tile primario se renombró de "Escanear cliente" → **"Validar recompensa"**.
  Se agregó el panel: *"Las ventas se registran directamente en Loyverse"* +
  *"Salmos registra tu visita automáticamente después de la compra"*.
- **`CustomerFound.jsx`**: se reencuadró como **pantalla de validación de
  cliente/recompensa** (mantiene cliente, progreso, recompensa y
  `loyverse_mapped`); se quitó el hand-off de cobro al POS (que la hacía ver
  como paso previo a una compra) y se reemplazó por una nota de validación que
  apunta al futuro Claim/OTP/Redeem.
- **`Scanner.jsx`**: **intacto** (base del futuro flujo de validación; no se
  cambió el QR ni el lookup).
- **`App.jsx`**: sin cambios funcionales (navegación home → scanner → found ya
  era correcta en real; RegisterSale solo se alcanza en demo). No existe ruta
  real Staff → Scanner → RegisterSale.
- **Tests**: nuevo `tests/staff-ui-flow.test.mjs` (ausencia de la acción
  eliminada, etiqueta "Validar recompensa", nota Loyverse, gating `isDemo` de
  "Registrar compra", Scanner sin `registerSale`, textos sin instrucciones de
  cobro/ticket). **N total pass** (ver validación final).
- **Sin commit y sin push.** Intacto: QR / `QrModal.jsx` / `QrCode.jsx` /
  `loyverse-receipts-sync` / `loyverse-customers` / `redeem_reward` /
  migraciones / loyalty engine / reglas de lealtad / scheduler / OTP.

---

## Checkpoint — CP3.2 Flujo operativo Staff ↔ Loyverse (hand-off al POS)

**Fecha:** 16 de septiembre de 2026.

**Objetivo:** dejar clara la responsabilidad de cada sistema en una venta con
lealtad: Salmos identifica al cliente por QR y **el cobro se hace solo en el
POS de Loyverse** (Salmos no crea tickets, productos ni cobros). El receipt
de Loyverse es la venta canónica que `loyverse-receipts-sync` convierte en
`loyalty_visits`. Sin venta manual en producción, sin Claim/OTP/redeem, sin
segundo POS, sin migraciones.

- **Flujo final Staff ↔ Loyverse (CP3.2):**
  1. El cliente muestra su QR (`customer_code`).
  2. Staff escanea en la app Salmos → lookup real en la Edge `loyalty-engine`.
  3. Salmos muestra cliente + progreso + recompensa y un **indicador
     `loyverse_mapped`** (booleano derivado en servidor; **jamás el id real**).
  4. Staff abre el ticket en el POS de Loyverse y **asigna al cliente
     existente** buscándolo por nombre/teléfono/correo (el POS no busca por
     `customer_code`), agrega productos y cobra normalmente.
  5. Loyverse genera el receipt → `loyverse-receipts-sync` lo procesa en
     Supabase (idempotente por `external_sale_id`, fecha de negocio en
     America/Tijuana, ignora receipts sin `customer_id` o sin mapeo
     `unmapped_customer`, mínimo `$50`).
  6. La visita se registra con las reglas actuales (7 visitas, máx 1/día).

- **Cómo se evita duplicar visitas / doble registro:** en modo real
  `CustomerFound` no muestra ni "Registrar compra" ni "Canjear" (existen solo
  en demo); la única vía de alta de visita es el sync del receipt de Loyverse,
  que es idempotente. `RegisterSale` queda como demo/contingencia.
- **Core** (`supabase/functions/_shared/loyaltyEngineCore.js`):
  `buildLookupResult` deriva `loyverse_mapped: Boolean(customer.loyverse_customer_id)`
  y **strippea** la columna del response (nunca expone el id real). La Edge
  (`serveLookup`) añade `loyverse_customer_id` al SELECT **solo** para derivar
  el booleano.
- **Frontend**: `CustomerFound.jsx` pinta el indicador de vínculo (verde
  "Cliente vinculado a Loyverse" / ámbar "Cliente no vinculado…") + tarjeta de
  hand-off al POS (solo modo real; la demo queda intacta). `StaffHome.jsx`
  renombra el tile "Registrar venta" → "Asignar cliente al ticket" (sigue
  abriendo el escáner; no crea un segundo POS).
- **Tests**: 4 nuevos en `tests/loyalty-engine-lookup.test.mjs` (mapped
  true/false/null + no-fuga del id real) y actualizados (claves `customer`
  ahora incluyen `loyverse_mapped`; el test anti-fuga verifica clave y valor).
  **351/351 pass** (347 previos + 4 nuevos); `npm run build` OK (aviso de
  chunk preexistente); `npm audit` 0; `git diff --check` limpio (solo avisos
  LF/CRLF).
- **Sin commit y sin push** (igual que los checkpoints anteriores). CP3.3-A
  (scheduler de `loyverse-receipts-sync`): ver checkpoint correspondiente
  abajo; luego CP3.4 Staff Activity real; después el flujo de redención (Claim + OTP +
  `redeem_reward` + descuento en Loyverse).

---

## Checkpoint — CP3.1 Customer Lookup real (Staff → scanner QR → Supabase)

**Fecha:** 16 de septiembre de 2026.

**Objetivo:** Staff escanea `customer_code` del QR → Edge Function
`loyalty-engine` (operación `lookup`, server-side con `service_role`) →
cliente real + ciclo activo + progreso + recompensa. **Sin abrir RLS, sin
mock en modo real, sin migraciones nuevas, sin tocar QR/ventas/redeem.**

- **Edge `loyalty-engine`** (`supabase/functions/loyalty-engine/index.ts`):
  nueva rama `lookup` (lectura pura, sin RPC, sin escribir tablas). Usa el
  mismo pipeline de CP1 (JWT `auth.getUser` → rol desde `public.profiles` con
  `service_role`) + `decideLookupPolicy` (solo staff/admin activo; customer,
  inactivo, sin perfil y sin sesión quedan denegados con códigos propios).
  Consultas `customers` por `customer_code`, ciclo activo, conteo de
  `loyalty_visits` activas y `rewards` disponible (vencidas/redimidas →
  `null`). Respuesta: `{ customer, cycle, progress, reward }`.
- **Core** (`supabase/functions/_shared/loyaltyEngineCore.js`):
  `validateLookupPayload`, `decideLookupPolicy`, `buildLookupResult` (puro,
  `now` inyectable) y `lookup` en `OPERATIONS`/`CUSTOMER_DENIALS`.
- **Frontend**: `src/services/loyalty/loyaltyEdgeClient.js` (nuevo, patrón
  `adminEdgeClient`: JWT Bearer, `VITE_LOYALTY_ENGINE_FUNCTION_URL` con
  fallback `${VITE_SUPABASE_URL}/functions/v1/loyalty-engine`);
  `staffService.scanCustomerToken()` bifurca demo (mock) / real (Edge);
  `CustomerFound.jsx` muestra el shape lookup (progreso X/Y, faltantes,
  recompensa+vence) y en modo real deshabilita Canjear/Registrar; `App.jsx`
  transporta el resultado completo.
- **Tests**: `tests/loyalty-engine-lookup.test.mjs` (core) y
  `tests/loyalty-edge-client.test.mjs` (frontend). **347/347 pass** (296
  previos + 51 nuevos); `npm run build` OK (aviso de chunk preexistente);
  `npm audit` 0; `git diff --check` limpio (solo avisos LF/CRLF).
- **Sin commit y sin push** (igual que los checkpoints anteriores). El
  flujo operativo Staff ↔ Loyverse y el orden de los checkpoints posteriores
  quedan descritos en la sección CP3.2 (ver arriba).

---

## Checkpoint — Regla de loyalty de 7 visitas

**Fecha:** 15 de septiembre de 2026.

**Objetivo:** cerrar documentalmente la implementación de la regla oficial
actual de lealtad: **la recompensa se genera al alcanzar 7 visitas válidas**
(antes 8). Este checkpoint es **solo documentación**: no se realizan cambios
de código ni de migraciones.

### Decisión: migraciones intactas

- Ninguna migración existente fue modificada; `0001`–`0011` permanecen
  intactas (`0005_loyalty_engine.sql` conserva su `required_visits DEFAULT 8`
  como regla histórica).
- La nueva regla se introduce con una **migración nueva**:
  `0012_required_visits_7.sql`.
- Principio documentado en el README (futuro, sin implementar): un cambio
  posterior de la regla debe ser otra migración (`0012 → 7 visitas` ·
  `0013 → 8 visitas`), nunca una edición de migraciones ya aplicadas.

### Migración 0012

`supabase/migrations/0012_required_visits_7.sql`:

1. Cambia el default de `required_visits` a `7`.
2. Actualiza **únicamente** ciclos activos con `required_visits = 8` a `7`.
3. **NO** modifica ciclos completados/históricos.
4. **NO** modifica ciclos activos con otro valor.
5. Es **idempotente / no destructiva**.

### Cambios de código

- `src/data/mockDatabase.js`: `REQUIRED_VISITS = 7` (fallback mock/frontend).
- `src/services/admin/adminService.js`: el fallback pasa de `?? 8` a
  `?? REQUIRED_VISITS` — la regla se lee de
  `public.loyalty_cycles.required_visits` como **fuente de verdad**, sin
  número hardcodeado.
- `tests/loyalty.test.mjs`: lógica invertida a 7 y asserts de QA para el
  ciclo nuevo (`requiredVisits === 7`).
- `tests/send-ticket-email.test.mjs`: fixtures (`required_visits = 7`) y
  regex del correo.
- `email-templates/welcome.html`: "Acumula 7 visitas".
- `docs/SALMOS_EMAIL_DESIGN.md`: "Acumula 7 visitas".

### Tests

```text
npm test
246/246 passing · 0 failures
```

Cobertura (documentada también en el README): 6 visitas → sin recompensa;
7 visitas → recompensa; 8.ª visita → pertenece al siguiente ciclo y no genera
una segunda recompensa; ciclo nuevo → `requiredVisits = 7`; cancelación de la
7.ª visita; recompensa redimida; expiración.

### Build

```text
npm run build
Build exitoso
```

Único aviso: chunk Vite > 500 kB (preexistente, no introducido en este
cambio).

### Validación Supabase

El proyecto remoto es `gyugkrvdgxofnkfhzbeq` ("salmoscafe's Project", org
`ulanwatdntyuydbjdysl`). La migración `0012` quedó aplicada en remoto (ver
Sincronización).

### Sincronización

- Antes de aplicar: `0001`–`0011` **local = remoto**; `0012` local y
  pendiente en remoto.
- Se ejecutó `supabase db push`, que aplicó `0012_required_visits_7.sql`.
- Verificación posterior con `supabase migration list`:

```text
0001 | 0001
0002 | 0002
0003 | 0003
0004 | 0004
0005 | 0005
0006 | 0006
0007 | 0007
0008 | 0008
0009 | 0009
0010 | 0010
0011 | 0011
0012 | 0012
```

- Local y remoto quedan **sincronizados hasta `0012`**, sin pendientes.
- Sin secretos en este proceso ni en las migraciones documentadas.

### Históricos

- **Ciclos nuevos** → `required_visits = 7`.
- **Ciclos activos existentes con 8** → actualizados a `7` por `0012`.
- **Ciclos completados/históricos** → conservan su valor; `0012` no los
  modifica.

### Referencias históricas a 8 visitas

> Nota: documentos y checkpoints anteriores a `0012` pueden mencionar la
> regla anterior de **8 visitas** (p. ej. `0005_loyalty_engine.sql` con
> `required_visits DEFAULT 8`, la sección "Actualización 2026-09-15 — QA
> aprobado" más abajo, el checkpoint del README de 2026-09-14, etc.). Son
> **históricos** y se conservan tal cual. La regla **vigente** es de **7
> visitas** desde la migración `0012_required_visits_7.sql`.

### Estado de Git

- `supabase/migrations/0012_required_visits_7.sql` presente (nuevo).
- Cambios funcionales de esta tarea ya realizados y validados (tests + build).
- Cambios **preexistentes ajenos a esta tarea** en
  `src/screens/client/Activity.jsx`, `Home.jsx` y `Rewards.jsx` — no son de la
  regla de 7 visitas.
- **Sin commit y sin push** (igual que los checkpoints documentales previos).

### Próximo paso pendiente

Antes de cualquier `git add`/`commit`: **separar los cambios por tarea** (la
regla de 7 visitas por un lado; los preexistentes de Activity/Home/Rewards por
otro). No se ejecuta en este checkpoint.

---

## Checkpoint — Mejoras UI/copy de Activity/Home/Rewards

**Fecha:** 16 de septiembre de 2026.

**Objetivo:** documentar los cambios de presentación (UI/copy) de las
pantallas Cliente que quedaron pendientes de stage en el checkpoint de la
regla de 7 visitas. **Sin cambios de lógica de loyalty y sin tocar la regla
de 7 visitas.** Sin commit todavía.

### Activity.jsx

- Timeline de actividad con **títulos más cortos y emojis** ("🎉 ¡Conseguiste
  una recompensa!", "☕ Recompensa canjeada", "Recompensa cancelada",
  "Recompensa vencida").
- `label` de la recompensa pasa a **metadata secundaria**
  (`.sc-timeline__meta`) en los eventos que no son compras (`!isPurchase`);
  las compras no tienen `label`.
- **Logging de errores de carga** con `console.error("[Activity] load", e)`
  además del mensaje amigable.

### Home.jsx

- Nuevo estado visual `ready = unlocked || remaining === 0`: **`remaining ===
  0` se trata como recompensa lista** (ciclo 7/7 completado mientras aún no
  llega `currentReward`).
- Copy: "🎉 ¡Tu recompensa está lista!" y "Disponible para canjear".
- Evita el mensaje contradictorio "Te faltan 0 visitas".

### Rewards.jsx

- Copy "¡Disponible para canjear!" para la recompensa vigente; la rama
  `remaining === 0` también lo muestra (evita "0 visitas restantes").
- La recompensa vigente vuelve a mostrar su fecha de expiración:
  "¡Disponible para canjear! · Vence el {fecha}" (`currentReward.expiresAt`).
  Se detectó y corrigió una pérdida de transparencia de la expiración; la
  regla de 3 meses no cambió y el dato sigue siendo el real de los
  servicios.

### Compatibilidad

Los 3 cambios son de **presentación/copy** y son **compatibles con la regla
de 7 visitas**: leen `cycle.requiredVisits` / `REQUIRED_VISITS` (sin números
hardcodeados) y no alteran el motor de lealtad.

### Estado de Git

Cambios sin stage, **sin commit ni push** (pendiente de decisión del equipo).

---

## Actualización 2026-09-15 — QA aprobado: detalle del ticket (receipt_date, items, verse_id) y orden cronológico

Checkpoint de cierre documental. Reglas de negocio **sin cambios** (recompensa en la 8ª visita, mínimo $50, **1 visita válida por día**, $150/bebida, 3 meses, cancelación revierte).

- **Migraciones nuevas** (ver `supabase/migrations/`): `0008` (hardening de identidad, ya rastreada), `0009` (evidencia de redención en receipts), `0010` (`loyalty_visits.items` = line_items normalizados + `loyalty_visits.receipt_date` = instante REAL del cobro; `created_at` sigue siendo el instante de sincronización), `0011` (`loyalty_visits.verse_id` fijo por visita + `bible_verse_pool`).
- **Edge `loyverse-receipts-sync`**: ahora registra con `register_visit_with_receipt` (0010) cuando existe la RPC; si aún no está aplicada (PGRST202) cae a `register_visit` (mismas reglas) y cuenta `detail_unavailable` — nunca inventa un ticket. La lógica pura (`_shared/receiptsSyncCore.js`) expone `normalizeLineItems`, `buildReceiptTimestamp` y `buildRegisterVisitWithReceiptArgs`.
- **Orden de visitas (Actividad)**: `saleOrdering.js` ordena de más reciente a más antigua por fecha REAL del ticket (`receipt_date` → `visit_date` → `created_at`); `salesService.computeCycleProgress` deriva el progreso histórico cronológicamente (1..N), sin contador almacenado.
- **Versículo persistido**: cada visita conserva su `verse_id` (0011); el ticket lo imprime (`TicketVerse`/`resolveTicketPassage`); visitas históricas caen al versículo del día como fallback.
- **QA real ejecutado y APROBADO** (ambiente de pruebas, cliente Javier):
  - Se limpió **solo** el historial de `loyalty_visits` del cliente (nada de Loyverse se tocó).
  - `loyverse_sync_state.updated_at_min` retrocedido temporalmente a `2026-09-07` y se reejecutó el sync.
  - Resultado: `receipts: 297` · `registered: 4` · `reused: 0` · `detail_unavailable: 0`.
  - Tickets reconstruidos: `1-0759 → visita 1` · `1-0784 → visita 2` · `1-0980 → visita 3` · `1-0997 → visita 4`. Los 4 con `receipt_date` de Loyverse y `verse_id` persistido.
  - **Activity verificado manualmente**: muestra `4 → 3 → 2 → 1`; items de cada ticket correctos.
- **Tests: 223/223** (`npm test`); **build OK** (`npm run build`, solo el aviso preexistente de chunk Vite > 500 kB).
- PENDIENTE (sin cambios respecto a lo documentado): escrituras Staff sobre RPCs, SMTP real para el envío de tickets por correo (`send-ticket` responde `email_not_configured`). El scheduler cron de `loyverse-receipts-sync` quedó definido en CP3.3-A (ver arriba).

---

## Actualización 2026-09-11 — UI Cleanup + Routing (UI/Routing phase)

Confirmado contra el repo local y remoto:

- **HEAD**: `6c0183b` (`feat: implement loyalty engine edge function`) · branch `main` · remote `salmoscafe/salmos-cafe-loyalty`.
- **Switcher de demo Cliente/Staff/Admin eliminado.** Ya no existe en `App.jsx` ni en `styles.css` (`.sc-dev-switcher`, `.sc-dev-switcher__btn*` removidos).
- **Navegación por pathname, sin dependencias nuevas**: `src/lib/navigation.js` (`resolveAppMode`/`modePath`) + listener `popstate` en `App.jsx`. `/` → Cliente, `/Staff` → Staff, `/Admin` → Admin. URL directa funciona tras recargar (fallback SPA de Vite dev).
- **Espacio del switcher eliminado**: `.sc-phone` ya no reserva `margin-top` (ni el `40px` del media query); no queda espacio artificial debajo de la parte superior.
- **UI Auth limpia**:
  - Login: título serif **"Bienvenido"** como único titular (el logo ya
    comunica la marca; el subtítulo "Entra a tu tarjeta" se eliminó).
  - Eyebrows unificados: `.sc-eyebrow-plain` y `.sc-auth-eyebrow` comparten regla (OTP/reset intactos).
  - `.sc-auth-switch` ahora tiene definición CSS consistente (antes heredaba de `<p>`).
  - Logo con más aire arriba vía `padding-top` consistente en `.sc-auth`.
  - Botón Google con **icono oficial inline** (SVG en `icons.jsx`); `SecondaryButton` acepta `icon` (misma altura/tipografía/borde/radius).
- **Sin cambios de lógica**: authService (incluido `signInWithGoogle` y `devSetGoogleMode`, usados por `tests/auth.test.mjs`), Loyverse/Fase C, D1.1/D1.2-1 y migraciones 0001–0005 intactos. `.env.example` fuera del commit. **Sin deploy.**
- **Tests**: `npm test` → **112/112** (106 previos + 6 nuevos de navegación en `tests/navigation.test.mjs`). `npm run build` → OK (aviso de chunk >500 kB preexistente). `git diff --check` limpio.
- Commit de la fase: `feat: refine auth ui and app navigation` (ver sección Git/GitHub abajo).

---

## Actualización 2026-09-12 — Corrección de concurrencia Loyverse (sync claim) + QA real

Hardening de la sincronización Loyverse contra la **condición de carrera** que
históricamente creó clientes duplicados en Loyverse, validado con una **QA real
concurrente** contra la Edge Function desplegada.

- **Incidencia original (histórica, NO de esta implementación):** dos
  invocaciones concurrentes de `loyverse-customers` podían leer el mismo perfil
  `customers` como no sincronizado y **ambas** llegar a Loyverse a crear un
  cliente. Eso produjo **dos clientes Loyverse duplicados** para el perfil QA
  (`salmoscafe497@gmail.com`, `customer_code: SC-F8XJRZBS`):
  - `c85906ca-25ce-482c-b486-c65d055f1b05`
  - `39b8b3cc-6bff-46f0-91f0-7bdaa6575cfb`

  Ambos son **históricos y no se eliminaron ni modificaron**; la corrección
  previene duplicados nuevos, no limpia los existentes.
- **Solución implementada — claim atómico server-side** (bloqueo por fila):
  - `supabase/migrations/0006_loyverse_sync_claim.sql`: añade
    `customers.loyverse_sync_claim` (uuid, token del holder) y
    `customers.loyverse_sync_claim_at` (timestamptz, instante de toma). Sin
    cambios de RLS/grants: la póliza `customers_own_all` ya autoriza el UPDATE
    del dueño (la Edge actúa con el JWT del usuario).
  - `supabase/functions/_shared/syncClaim.js` (`acquireSyncClaim` /
    `releaseSyncClaim` / `runLoyverseSync`, agnóstico de transporte) integrado
    en `supabase/functions/loyverse-customers/index.ts`.
  - Adquisición **atómica en UNA sentencia** (`WHERE claim IS NULL OR
    claim_at < now() - interval '10 minutes'`): un segundo UPDATE concurrente
    bloquea en el lock de fila y re-evalúa el WHERE sobre el commit → 0 filas
    para el perdedor.
  - **Lease de 10 minutos** (`SYNC_CLAIM_LEASE_MS`): un claim abandonado
    (crash / red caída / tab cerrado) expira y la siguiente adquisición lo
    toma; el lease NO se reanuda en lecturas (un holder lento conserva su
    claim salvo en el techo del lease).
  - **Liberación exclusiva por token**: el WHERE de liberación exige
    `loyverse_sync_claim = <token del dueño>`; tras un robo legítimo de un
    claim vencido, el holder antiguo nunca pisa el claim nuevo.
  - **Perdedor** → `HTTP 409`, `code: "loyverse_sync_in_progress"`,
    `retriable: true`, **sin llamar a la API de Loyverse**.
  - **Perfil ya `synced`** → `already_linked` antes de tocar el claim ni la red.
  - Se conserva la **defensa adicional contra duplicados** del fix `b0351f5`:
    si Loyverse responde un error de duplicado al crear (400/409/422, cualquier
    formato) se rebusca y vincula (`afterDuplicateCode`), y una "creación" sin
    `id` se trata como 502 retriable (nunca `synced` con id nulo).
- **Desplegado:** migraciones `0001`–`0006` aplicadas en remoto; Edge Function
  `loyverse-customers` redeployada (**version 3**, ACTIVE, `verify_jwt = true`).
- **QA real concurrente (contra la función desplegada):** se resetearon las
  columnas de sync del perfil QA (`loyverse_customer_id = NULL`,
  `loyverse_sync_status = pending`, claim y claim_at NULL) y se lanzaron **dos
  invocaciones simultáneas reales** con el payload válido
  `{"operation":"link_or_create"}`:
  - **Request A** → `409`, `code: "loyverse_sync_in_progress"`,
    `retriable: true`, traceId `1e0795e1-065c-4820-be8f-9f4177ff6ec2`.
  - **Request B** → `200`, `status: "linked"`,
    `loyverseCustomerId: "c85906ca-25ce-482c-b486-c65d055f1b05"`.

  Resultado: **solo una** invocación tomó el claim y continuó hacia Loyverse.
- **Estado final verificado en Supabase:** `loyverse_customer_id =
  c85906ca-25ce-482c-b486-c65d055f1b05`, `loyverse_sync_status = synced`,
  `loyverse_sync_claim = NULL`, `loyverse_sync_claim_at = NULL` → enlace
  exitoso, claim liberado, sin bloqueo activo.
- **Eventos de sincronización verificados:** la QA produjo **1 nuevo**
  `loyverse_linked` y **0 nuevos** `loyverse_created`. Los registros
  `loyverse_created` preexistentes (2026-09-12T17:56:54Z) pertenecen a la
  **incidencia histórica**, NO a esta implementación.
- **Verificación directa en Loyverse:** `GET /v1.0/customers?email=
  salmoscafe497@gmail.com` devuelve exactamente los **dos** clientes históricos
  (`c85906ca-…` y `39b8b3cc-…`); la QA **no** creó ningún cliente adicional.
- **Tests:** `npm test` → **130/130 pass** (10 nuevos en
  `tests/sync-claim.test.mjs`).
- **Estado git (sin commit ni push):** `HEAD b0351f5`; modificado
  `supabase/functions/loyverse-customers/index.ts`; nuevos
  `supabase/functions/_shared/syncClaim.js`,
  `supabase/migrations/0006_loyverse_sync_claim.sql` y
  `tests/sync-claim.test.mjs`.

---

## Estado general

- V1 de lealtad con **motor de fidelización real** en `src/services/` sobre
  un mock en memoria, y **auth de cliente real** sobre Supabase (Auth +
  Postgres + Edge Function) para la vinculación con Loyverse.
- Auth de cliente concluido (registro/login por correo o teléfono +
  contraseña; OTP solo recuperación; Google; sesión persistente).
- Sincronización **crear/vincular/actualizar** con Loyverse funcionando de
  punta a punta y comprobada con cliente real en los caminos crear/vincular
  (ver "Real End-to-End Tests"); la actualización automática de clientes
  existentes está implementada con reglas conservadoras (solo rellena
  campos incompletos; nunca sobrescribe valores distintos).
- **Staff y Admin siguen en mock** (PIN). El motor de lealtad (visitas,
  ciclos, recompensas) sigue en `src/data/mockDatabase.js` — en memoria.

## Arquitectura actual

- **React 18 + Vite 6** (`@vitejs/plugin-react`), SPA tipo app móvil
  (Cliente), flujos Staff y Admin en el mismo bundle. La experiencia se
  resuelve por **pathname** (`/`, `/Staff`, `/Admin`) en
  `src/lib/navigation.js` — tres despliegues/productos separados en
  producción (ver "Actualización 2026-09-11" al inicio).
- **Separación UI / services**: las pantallas importan SOLO de
  `src/services/index.js` (barrel único). Los servicios son async y de una
  sola responsabilidad; no importan componentes.
- **Facade de auth** `src/services/auth/authService.js`: decide entre
  implementación real (`supabaseAuthService`) y mock (`mockAuthService`)
  según `isSupabaseConfigured` (presencia de variables de entorno). Staff y
  Admin delegan siempre al mock en esta fase.
- **Cliente Supabase único** en `src/lib/supabase/client.js` (`createClient`
  con `persistSession`, `autoRefreshToken`, `detectSessionInUrl`); `null` si
  no hay entorno → modo demo.
- **Entorno centralizado**: `src/lib/utils/env.js` (`readEnv`, único lector
  de `import.meta.env`). `src/lib/phone.js` normaliza teléfonos a E.164 +52.
- **Edge Function** `loyverse-customers` es la única que habla con
  `api.loyverse.com`; el frontend solo llama a la función vía
  `loyverse/loyverseEdgeClient.js`.

### Estructura de carpetas (verificada)

```
src/
  main.jsx, App.jsx, styles.css
  data/mockDatabase.js          mock en memoria (lealtad + staff + branches)
  services/
    index.js                    barrel único de las pantallas
    auth/                       authService (facade) + supabaseAuthService +
                                mockAuthService + authErrors
    customers/  customerService (perfil, token QR, DEV bridge ensureLoyaltyProfile)
    loyalty/    loyaltyService (ciclos, addVisit interno) + rewardService
    sales/      salesService (registerSale/cancelSale) + salesAdapters + ticketService
    staff/      staffService (PIN, scan, actividad)
    admin/      adminService (dashboard, clientes)
    loyverse/   loyverseEdgeClient + loyverseCustomerService
  components/
    common/  layout/  auth/  loyalty/
  screens/
    client/  staff/  admin/
  lib/
    supabase/client.js  utils/env.js  phone.js  customerCode.js  delay.js
    format.js  brandAssets.js
supabase/
  config.toml           CLI Supabase (project local, Postgres 17)
  migrations/           0001_customers.sql · 0002_loyalty_schema.sql · 0003_auth_alias_rpc.sql · 0004_loyverse_updated_event.sql
  functions/
    loyverse-customers/index.ts     Edge Function (desplegada; el update ya está en el código local, aún no desplegado)
    _shared/loyverseCore.js          lógica pura (unit-testable)
  .temp/                metadatos del CLI (linked-project.json: ref del proyecto)
tests/  loyalty.test.mjs · loyverse-sync.test.mjs · auth.test.mjs
docs/   AUTH_AND_LOYVERSE_FLOW.md · CURRENT_STATUS.md (este documento)
```

## Git / GitHub

> Nota: esta subsección describe el checkpoint histórico (Fase C). El
> estado actual (HEAD `6c0183b`, fase UI/Routing commiteada y pushed, sin
> `.env.example` en staging) está en la **Actualización 2026-09-11** al
> inicio de este documento.

- **Branch**: `main`
- **HEAD**: `0b3f41ba99904febdf04cb1c5cfbf1f7e0eee722`
- **Último commit**: `0b3f41b feat: implement customer authentication and loyverse linking`
- **Working tree** (tras esta Fase C, **sin commit ni push**):
  - Modificados: `README.md` (checkpoint), `SyncBanner.jsx`,
    `supabaseAuthService.js`, `loyverseCustomerService.js`,
    `loyverseCore.js`, `loyverse-customers/index.ts`,
    `tests/loyverse-sync.test.mjs`, `docs/CURRENT_STATUS.md`,
    `docs/AUTH_AND_LOYVERSE_FLOW.md`.
  - Nuevos: `docs/CURRENT_STATUS.md` (creado en el checkpoint),
    `supabase/migrations/0004_loyverse_updated_event.sql`.
- **Remote**: `origin → https://github.com/salmoscafe/salmos-cafe-loyalty.git`
- **Sincronización**: local y `origin/main` **iguales** (0 ahead / 0 behind);
  `0b3f41b` ya está en el remoto. Los cambios de la Fase C NO se han
  commiteado ni empujado.
- **Historial reciente**:
  - `0b3f41b` feat: implement customer authentication and loyverse linking
  - `314921b` chore: update vite and fix npm vulnerabilities
  - `c735fc2` chore: initial Salmos Cafe loyalty app

## Supabase

- **Proyecto remoto vinculado**: `gyugkrvdgxofnkfhzbeq` ("salmoscafe's
  Project", org `ulanwatdntyuydbjdysl`), Postgres 17.
- **Migraciones aplicadas en remoto** (verificado con
  `supabase migration list --linked`): `0001`, `0002`, `0003` — todas
  coinciden con las locales. La **`0004` nueva es local** (validada en
  Postgres descartable) y **aún NO está aplicada en remoto**: requiere
  `supabase db push` al desplegar la Fase C.
- **Auth (providers esperados)**: Email habilitado; Google como alternativa;
  **Phone/SMS deliberadamente apagado** (no hay credenciales Twilio, por eso
  la recuperación de contraseña siempre va al correo). Confirmaciones de
  email dependen de la configuración del proyecto (el código soporta ambos
  modos: `mode: "complete"` vs `"confirm_email"`).
- `.env.local` (ignorada por git) contiene: `VITE_SUPABASE_URL`,
  `VITE_SUPABASE_ANON_KEY`, `VITE_LOYVERSE_CUSTOMERS_FUNCTION_URL`.
  `LOYVERSE_ACCESS_TOKEN` **no** está en el frontend (vive solo en la Edge
  Function).

## Authentication

Implementación real: `src/services/auth/supabaseAuthService.js`.

| Capacidad | Estado real |
|---|---|
| Email/password | `signUpWithEmail` — valida formato y ≥8 chars; crea en GoTrue; devuelve `mode: "complete"` (sesión) o `"confirm_email"` según el proyecto |
| Confirmación de email | Soportada (`mode: "confirm_email"` + `resendConfirmationEmail`); `ensureCustomerProfile` guarda `email_verified` |
| Recuperación por OTP | `forgotPasswordStart/Verify/Resend` + `setNewPassword` — OTP al **correo** (`signInWithOtp` con `shouldCreateUser:false`), sesión efímera de reset (`verifyOtp`), luego `updateUser({password})` |
| Login por email | Directo a GoTrue (`signInWithPassword`) — sin RPC, anti-enumeración |
| Login por teléfono | `resolveLoginEmail` → RPC `resolve_email_for_login` (devuelve email solo si UNA coincidencia por dígitos) → GoTrue valida contraseña. Normaliza a E.164 antes del RPC (`phoneIdentifierForLogin`) |
| Google OAuth | `signInWithOAuth(google)` con redirect al origin; la sesión llega vía `detectSessionInUrl`/`onAuthStateChange`; correo existente → conflicto amigable (no se pisa la cuenta) |
| Session persistence | `persistSession: true` + `autoRefreshToken: true`; `getSession` reconstruye perfil (`buildSession`) en cada carga |
| Logout | `signOutClient` → `supabase.auth.signOut()` |

Pre-chequeo de registro: `checkSecondaryContact` usa RPCs seguros
(`phone_is_registered` para teléfono — solo existencia booleana; el mismo
resolver para email) porque el anon no puede leer `customers` (RLS).

## Customers

- Tabla `public.customers` (0001): `auth_user_id` UNIQUE (1 auth_user = 1
  fila), `name`, `email`, `phone` (E.164 +52), `customer_code`
  (`SC-XXXXXXXX`, UNIQUE + CHECK formado), `loyverse_customer_id` (UNIQUE),
  `loyverse_sync_status` (`pending|synced|failed|conflict`),
  `loyverse_sync_claim` (uuid, token del claim de sync — 0006),
  `loyverse_sync_claim_at` (timestamptz, instante de toma — 0006), `profile`
  (jsonb), `email_verified` (0002), timestamps. Trigger `set_updated_at`.
- **RLS**: `customers_own_all` (solo `authenticated`, `auth.uid() =
  auth_user_id`). El anon no lee nada.
- `ensureCustomerProfile` crea la fila idempotente al alta de sesión;
  ante carrera (23505) relee y devuelve la existente.
- **DEV BRIDGE**: `customerService.ensureLoyaltyProfile` siembra el mock de
  lealtad claveado por `auth_user_id` para que Home/Rewards/Activity sigan
  funcionando hasta migrar el motor a Supabase. Es código temporal.
- `customer_sync_events`: log técnico de sync (eventos
  `loyverse_linked/created/already_linked/conflict/error`), RLS propia.

## Loyalty

- Motor REAL en `src/services/loyalty/` + `src/services/sales/` sobre el
  mock (`src/data/mockDatabase.js`):
  - Compra mínima **$50 MXN** (`MIN_SALE_AMOUNT`).
  - Máximo **1 visita válida por cliente por día**.
  - **8ª visita** → recompensa "Café gratis" hasta **$150 MXN**, vence a
    los **3 meses** (derivado en lectura, sin cron) — `REQUIRED_VISITS=8`,
    `REWARD_MAX_VALUE=150`, `REWARD_EXPIRY_MONTHS=3`.
  - `registerSale` (único punto de entrada, Staff) valida e invoca
    `addVisit` (interno). `cancelSale` revierte visita/recompensa y bloquea
    si la recompensa ya fue redimida.
  - Idempotencia por `external_sale_id`.
- **Esquema Supabase ya existe** (0002: `loyalty_cycles`, `loyalty_visits`,
  `rewards`, `audit_logs`, con RLS de solo-lectura para el cliente; el
  motor transaccional en Edge Function es la siguiente fase de migración) —
  pero **hoy el motor en ejecución es el mock**; el esquema 0002 está creado
  pero sin datos/lógica usada todavía.
- Roles: **Cliente** no muta lealtad (SOLO lee). **Staff** registra/cancela
  ventas (mock). **Admin** lee dashboard/clientes (mock).

## Loyverse Integration

**Piezas**:
- `src/services/loyverse/loyverseEdgeClient.js` — única puerta del
  frontend; llama a la Edge Function con el JWT; nunca toca
  `api.loyverse.com` ni tiene token.
- `src/services/loyverse/loyverseCustomerService.js` — normaliza el
  resultado para la UI (`synced | failed | conflict`).
- `supabase/functions/loyverse-customers/index.ts` — Edge Function
  desplegada; autentica el JWT (`auth.getUser`), valida `operation ===
  "link_or_create"`, lee la fila `customers` del propio usuario (RLS), y
  escribe `loyverse_customer_id` + `loyverse_sync_status`. Es la dueña de
  `LOYVERSE_ACCESS_TOKEN`.
- `supabase/functions/_shared/loyverseCore.js` — lógica pura de la decisión,
  agnóstica del transporte (unit-testable en Node).

**Comportamiento actual (verificado en el código):**

- **A) Cliente Salmos NO existe en Loyverse** → la core busca por email
  (sin resultados) y por teléfono (sin resultados) → `status: "none"` →
  **crea** en `POST /v1.0/customers` con `name`, `email`, `phone_number` (E.164
  +52) y `customer_code`. La Edge Function actualiza la fila Salmos a
  `loyverse_customer_id = <id creado>` y `loyverse_sync_status = synced`;
  registra `loyverse_created`.
- **B) Cliente Salmos YA existe en Loyverse** → resuelve al cliente
  existente (email y/o teléfono) y **vincula** sin crear:
  `status: "linked"` → mismo update de la fila + evento `loyverse_linked`.
- **C) Campos de búsqueda**:
  - **email**: filtro oficial de la API `?email=...&limit=1`
    (`listByEmail`).
  - **teléfono**: la API **no filtra** por `phone_number` → se pagina la
    lista (`limit=250`, tope 15 páginas) y se filtra por dígitos
    (`listByPhone`).
  - **customer_code**: NO se usa para buscar; solo como payload al crear (y
    en el manejo del duplicado `customer_code`, donde se rebusca, no por
    código sino devolviendo al mismo cliente).
  - **ID conocido**: si `profile.loyverse_customer_id` ya existe → salida
    temprana `already_linked` **sin red**.
- **D) Campos que actualiza** (en Loyverse, cliente ya resuelto):
  **solo RELLENA campos incompletos** vía `PUT /v1.0/customers/{id}` con
  un payload parcial (`name`, `email`, `phone_number`, `customer_code`),
  únicamente los campos que la base de Loyverse NO tiene y Salmos sí.
  NUNCA envía campos del POS. Si no hay nada que rellenar → no hay PUT
  (idempotencia de red).
- **E) Campos que NO actualiza nunca**:
  - **Nunca sobrescribe** un valor distinto ya presente en Loyverse:
    - email/teléfono distintos → **bloquea** la sincronización con
      conflicto conservador de identidad (`identity_conflict` → 409
      `loyverse_identity_conflict`, no retriable). El cliente es guiado a
      entrar con esa cuenta / recuperar su contraseña y a dejar correo Y
      teléfono enlazados (SyncBanner).
    - nombre/customer_code distintos (ambos no vacíos) → **no bloquea**:
      se omite el cambio y se registra en el detalle de auditoría
      (`detail.skippedFields`).
  - Datos derivados del POS: `total_visits`, `total_spent`,
    `total_points`, historial de ventas/receipts — jamás se leen ni viajan.
- **F) Cómo evita duplicados**: búsqueda por email → búsqueda por teléfono →
  una sola operación de creación solo si `none`; `customer_code` UNIQUE en
  `customers` (lado Salmos) y manejo del error 400/409/422 de duplicado en
  Loyverse con cualquier formato de la API (rebusca y vincula). Además
  (Fase D2): **single-flight del lado cliente** — la búsqueda+creación no es
  atómica contra la API, así que el app colapsa toda sincronización
  concurrente (sync automático del arranque + Retry, o llamadas solapadas)
  a UNA sola llamada remota (`coalesce` en
  `src/services/loyverse/singleFlight.js`, usado por
  `loyverseCustomerService`). Y la Edge Function propaga como 502 retriable
  cualquier fallo al grabar el vínculo local (`loyverse_customer_id`), en
  vez de responder éxito con el id "perdido". Además (0006): **claim atómico
  server-side** por fila (`loyverse_sync_claim`/`_at`, `syncClaim.js`) —
  dos invocaciones concurrentes del mismo perfil no pueden cruzar la
  búsqueda+creación; el perdedor responde `409 loyverse_sync_in_progress`
  (`retriable: true`) sin tocar la API de Loyverse.
- **G) Cómo maneja conflictos** (`resolveLoyverseTarget`):
  - email→X y teléfono→Y (distintos) → **conflicto** `email_phone_conflict`
    (no crea un tercero).
  - teléfono con 2+ clientes → **conflicto** `ambiguous_phone`.
  - sin identificadores → `no_identifiers`.
  - ya resuelto a UN cliente pero con email/teléfono distintos a los de
    Salmos → **conflicto conservador** `identity_conflict` (nuevo, Fase C).
  En conflicto: la Edge Function marca `loyverse_sync_status = failed`,
  registra `loyverse_conflict` y responde 409 (`loyverse_customer_conflict`
  o `loyverse_identity_conflict`), no retriable.
- **H) Idempotencia**:
  1. `loyverse_customer_id` + `synced` → `already_linked` sin red (la Edge
     Function retorna `already_linked` y la app `retryLoyverseSync` ya no
     llama).
  2. `external_sale_id` UNIQUE a nivel lealtad (mock) y
     `loyalty_visits.external_sale_id UNIQUE` (Supabase).
3. Doble submit al crear → error de duplicado (400/409/422, incluye el
      `customer_code` con cualquier formato del mensaje) → rebusca y vincula
      (`afterDuplicateCode: true`) **sin updates**.
   4. Carrera en `customer_code`/`auth_user_id` de Salmos → detecta 23505 y
      relee la fila existente.
   5. Respuesta de Loyverse "creada" **sin id** → se trata como fallo
      retriable, jamás se graba `synced` con `loyverse_customer_id` nulo.
   6. Vínculo local fallido tras crear el remoto: el reintento rebusca por
      email y **reusa** el mismo cliente (nunca crea otro) — probado como
      regresión en `tests/loyverse-sync.test.mjs`.
- **I) Si Loyverse falla**: la Edge Function loguea `loyverse_error`, marca
  `loyverse_sync_status = failed` y responde 502 `loyverse_unavailable`
  (retriable). La app entrega la sesión igual y `SyncBanner` ofrece
  **Reintentar** (`retryLoyverseSync`). El cliente Salmos queda con su QR
  y su perfil; la vinculación se completa después. Un fallo en el `PUT` de
  actualización usa exactamente el mismo patrón (502 retriable).
- **J) Cliente existente pero incompleto/desactualizado** (Fase C):
  al resolver a un cliente existente se comparan los campos contra Salmos:
  idénticos → nada; faltantes en Loyverse → se rellenan (`updated`,
  evento `loyverse_updated`); email/teléfono distintos → conflicto
  bloqueante; nombre/customer_code distintos (no vacíos) → se omiten y se
  auditan. Reglas definidas y documentadas en `loyverseCore.js`
  (`computeIdentityUpdates`).

## Edge Functions

- Única función: **`loyverse-customers`** (TypeScript, `Deno.serve`).
- **Desplegada en remoto**: `ACTIVE`, **version 3**, `verify_jwt = true`
  (verificado con `supabase functions list`; la v3 incluye
  `syncClaim.js` + el fix `b0351f5`).
- Variables esperadas en el proyecto: `SUPABASE_URL`, `SUPABASE_ANON_KEY`,
  `LOYVERSE_ACCESS_TOKEN` (este último solo lado servidor).
- Operación aceptada: `{ operation: "link_or_create" }`. Respuestas
  amigables: `already_linked | created | linked | updated | conflict`;
  errores con `traceId` (`srv_not_configured`, `unauthorized`,
  `invalid_body`, `invalid_operation`, `loyverse_customer_conflict`,
  `loyverse_identity_conflict`, `loyverse_sync_in_progress`,
  `loyverse_unavailable`). Concurrencia: adquiere el claim de `customers`
  (0006) antes de tocar la API; si otro sync está en curso responde
  `409 loyverse_sync_in_progress` (`retriable: true`) **sin** llamar a
  Loyverse, y un perfil ya `synced` responde `already_linked` antes del
  claim/red.
- Shared code (`_shared/loyverseCore.js`, `_shared/syncClaim.js`) es agnóstico
  de Deno → se prueba con `node --test`.

## Database Migrations

| Migración | Qué hace | Aplicada |
|---|---|---|
| `0001_customers.sql` | `customers`, `customer_sync_events`, RLS, trigger `set_updated_at` | Remoto ✅ |
| `0002_loyalty_schema.sql` | `email_verified`, `loyalty_cycles`, `loyalty_visits`, `rewards`, `audit_logs` (+RLS de solo lectura) | Remoto ✅ |
| `0003_auth_alias_rpc.sql` | RPC `resolve_email_for_login` (login por alias) + RPC `phone_is_registered` (pre-chequeo) + índices email/teléfono | Remoto ✅ |
| `0004_loyverse_updated_event.sql` | Amplía la CHECK de `customer_sync_events.event_type` para permitir `loyverse_updated` (drop + add del constraint) | Remoto ✅ |
| `0005_loyalty_engine.sql` | `assert_loyalty_actor` + RPCs de lealtad (`register_visit`/`cancel_visit`/`redeem_reward`), grants solo `service_role` | Remoto ✅ |
| `0006_loyverse_sync_claim.sql` | Claim atómico de sync Loyverse: `customers.loyverse_sync_claim` (uuid) + `customers.loyverse_sync_claim_at` (timestamptz); sin cambios de RLS/grants | Remoto ✅ |

Regla: **no** crear una migración nueva para reemplazar 0003 (ya aplicada en
remoto); los cambios van en `0004+` (esta Fase C usa `0004`; el claim de
concurrencia usa `0006`).

### RPCs

- **`resolve_email_for_login(p_identifier text)`**: `SECURITY DEFINER`,
  `search_path` fijo, STABLE; devuelve `min(email)` solo si `count(*) = 1`
  (coincidencia por email normalizado o por dígitos de teléfono), si no
  `NULL`. Grants solo `anon` + `authenticated`. Sirve para login por
  teléfono y recuperación; **no valida contraseñas** (eso siempre GoTrue).
- **`phone_is_registered(p_phone text)`**: `SECURITY DEFINER`, devuelve un
  **booleano de existencia** por dígitos (sin email ni filas). Para el
  pre-chequeo de registro. Grants solo `anon` + `authenticated`.
- **Riesgos/limitaciones conocidos**: ver "Known Limitations" — ambos son
  invocables por `anon` (por diseño, pre-login) y suponen un oráculo de
  existencia email↔teléfono.

## Tests

`npm test` (node --test, sin navegador): suites verificadas:

- `tests/loyalty.test.mjs` (13): monto mínimo, 1 visita/día, 8ª visita,
  expiración 3 meses, cancelación/reversión/bloqueo, idempotencia por
  `externalSaleId`, sucursales compartidas, barrel sin `addVisit`.
- `tests/loyverse-sync.test.mjs` (26): crear con `customer_code`+E.164,
  vincular por email, vincular por teléfono (paginado), email+teléfono
  mismo cliente, conflictos (email_phone / teléfono ambiguo / sin ids /
  identity_conflict por email o teléfono distinto), doble submit
  `customer_code`, idempotencia "dos veces → mismo cliente", ya-vinculado
  sin red, normalización, `resolveLoyverseTarget`,
  `isDuplicateCustomerCodeError`, y la suite de actualización:
  idéntico sin PATCH, relleno de campos faltantes en una actualización,
  `customer_code` null → set, diferencia segura (email con
  espacios/mayúsculas) sin update, email/teléfono distintos → conflicto
  conservador, nombre/`customer_code` distintos → omitidos y auditados,
  campos del POS nunca viajan, error de update se propaga (502 retriable),
  `audit.updated` solo con update real, matriz pura de
  `computeIdentityUpdates`, y la regresión de duplicados: repro
  "crear remoto + vínculo local fallido → reintento reusa el id", 400 de
  duplicado con mensaje genérico → rebusca y vincula, y create sin id →
  error retriable.
- `tests/single-flight.test.mjs` (5): `coalesce` comparte UNA ejecución
  para llamadas concurrentes, nueva ejecución tras terminar, liberación
  del slot tras rechazo, dedup a nivel servicio (mismo resultado), perfil
  ya vinculado → `already_synced` sin red.
- `tests/sync-claim.test.mjs` (10): sync normal (adquiere el claim, crea en
  Loyverse y lo libera al final), `already_linked` sin claim ni red,
  `no_profile`, carrera con claim → solo una invocación llega al create,
  perdedor `busy` retriable sin llamadas a Loyverse, claim liberado tras
  éxito y la siguiente sync reusa el mismo cliente.
- `tests/auth.test.mjs` (25): registro, login email/teléfono (E.164 y 10
  dígitos), duplicados, bounds de contraseña/email, recuperación OTP
  completa, `checkSecondaryContact` (teléfono/email en uso, 10 dígitos),
  Google, error temporal.

Total corriente: **130/130 pass** (25 auth + 13 loyalty + 26 loyverse-sync
+ 5 single-flight + 45 loyalty-engine + 6 navigation + 10 sync-claim).

## Real End-to-End Tests

Pruebas funcionales reales (con el proyecto remoto y la cuenta Loyverse
real, reportadas y observadas por el equipo):

**PRUEBA 1 — Cliente existente en Loyverse**
Se registró un cliente Salmos cuyo email ya existía en Loyverse:
- Salmos: `customer_code` generado; `loyverse_customer_id` asignado;
  `loyverse_sync_status = synced`.
- Loyverse: se encontró el cliente existente; **no** se creó duplicado.
- Camino verificado: `existing customer → link`.

**PRUEBA 2 — Cliente inexistente en Loyverse**
Se registró un segundo cliente: **Carlos Rivera** (`salmoscafe497@gmail.com`):
- Loyverse: cliente **nuevo** creado; `customer_code: SC-EJ8D2E4D`;
  `total_visits: 0`; `total_spent: 0`; vinculado correctamente desde
  Salmos.
- Camino verificado: `new customer → create + link`.

> **Nota (snapshot histórico).** Los datos de esta prueba —email
> `salmoscafe497@gmail.com`, nombre "Carlos Rivera" y `customer_code
> SC-EJ8D2E4D`— corresponden al estado registrado en su fecha y **no deben
> utilizarse como fuente del estado actual**: para el mismo email existe un
> registro QA posterior con `customer_code: SC-F8XJRZBS` y dos clientes
> Loyverse históricos (`c85906ca-…` y `39b8b3cc-…`). La prueba se conserva
> tal cual como snapshot; el estado actual de la incidencia de concurrencia
> está documentado en la **Actualización 2026-09-12** de este documento.

**PRUEBA 3 — Concurrencia (QA real contra la función desplegada, 2026-09-12)**
El perfil QA (`salmoscafe497@gmail.com`) se resetearon a `pending` +
claim NULL y se lanzaron **dos invocaciones simultáneas reales** con
`{"operation":"link_or_create"}`:
- Request A → `409` `loyverse_sync_in_progress` (`retriable: true`, traceId
  `1e0795e1-065c-4820-be8f-9f4177ff6ec2`).
- Request B → `200` `status: "linked"`, `loyverseCustomerId:
  c85906ca-25ce-482c-b486-c65d055f1b05`.

Solo UNA invocación tomó el claim y llegó a Loyverse. Estado final: `synced`,
claim `NULL`; **1** nuevo `loyverse_linked`, **0** nuevos `loyverse_created`;
en Loyverse siguen existiendo exactamente los 2 clientes históricos del perfil
(sin cliente adicional).

Conclusión: los caminos crear/vincular y la defensa de concurrencia (claim
atómico server-side) están comprobados en ambiente real (además de cubiertos
por las unidades de `tests/loyverse-sync.test.mjs` y
`tests/sync-claim.test.mjs`).

## Security

- `LOYVERSE_ACCESS_TOKEN` es **solo servidor** (Edge Function). El frontend
  **no** lo contiene; no es una `VITE_*`; el navegador jamás llama a
  `api.loyverse.com`.
- `.env.local` / `.env` **no se versionan** (`.gitignore` líneas 7, 20-22).
  Solo `.env.example` está en git.
- RLS activa en `customers`, `customer_sync_events`, `loyalty_*`,
  `rewards`, `audit_logs`. El anon no lee `customers`. La Edge Function
  actúa con el JWT del usuario (verifica `auth.getUser`) y por lo tanto bajo
  la RLS del propio usuario.
- La Edge Function exige `Authorization: Bearer <JWT>` y tiene
  `verify_jwt = true`.
- Errores crudos nunca llegan a la UI: `authErrors.js` traduce a frases
  amigables.
- Secret scan periódico: sin claves en `src/`/`tests/`/migraciones (solo
  comentarios y `readEnv`).

## Known Limitations

1. **Login por teléfono = resolución teléfono → email.** Para entrar con
   teléfono, el frontend llama a `resolve_email_for_login`, que devuelve el
   email de la cuenta (solo si hay coincidencia única). No es "inicio por
   teléfono real" (sin SMS): es alias→email→contraseña en GoTrue.
2. **Riesgo de enumeración email↔teléfono (aceptado y documentado).**
   `resolve_email_for_login` (y el booleano de `phone_is_registered`) son
   invocables por `anon`: quien conozca un teléfono puede resolver el email
   o confirmar que está registrado. **No** expone contraseñas ni el resto
   del perfil. Es un riesgo **conocido y deliberadamente aceptado** en esta
   fase; mitigación futura (Edge Function que haga resolver+login en el
   servidor + rate limiting/CAPTCHA) está documentada en
   `docs/AUTH_AND_LOYVERSE_FLOW.md` y NO debe implementarse como parte de
   este checkpoint.
3. **No hay rate limiting de PostgREST** por defecto sobre esos RPCs.
4. **Staff y Admin siguen en mock** (PIN en memoria); su auth real es una
   fase posterior.
5. **Motor de lealtad en mock**: visitas/ciclos/recompensas viven en
   memoria (se pierden al recargar). El esquema Supabase 0002 existe pero la
   lógica transaccional (Edge Function de `registerSale`/`cancelSale`) es la
   siguiente migración.
6. **QR no firmado**: `customer_code` hoy se usa como token visual; firma
   planificada (Fase 2).
7. **Actualización de clientes Loyverse (Fase C, conservadora)**: Salmos
   solo **rellena** campos incompletos de un cliente existente. Un email o
   teléfono **distinto** bloquea la sincronización (`identity_conflict`,
   409, no retriable): el cliente debe entrar con esa cuenta / recuperar su
   contraseña y dejar correo y teléfono enlazados. Nombre y
   `customer_code` distintos (no vacíos) **no se sobrescriben**; se omiten
   y quedan registrados en la auditoría (`detail.skippedFields`).
8. **Loyverse en ventas no conectado**: `ManualSalesAdapter` es la única
   fuente de ventas hoy.

## Next Recommended Step

**Migrar el motor de lealtad (visitas/ciclos/recompensas) a Supabase**: el
esquema `0002` ya existe (`loyalty_cycles`, `loyalty_visits`, `rewards`,
`audit_logs`, RLS de solo lectura); falta la Edge Function transaccional de
`registerSale`/`cancelSale` (misma idempotencia por `external_sale_id`,
mismas reglas: $50, 1 visita/día, 8ª visita, vence 3 meses) para reemplazar
el mock en memoria y el DEV bridge `ensureLoyaltyProfile`. Cierre posterior
de Fase C: **sin commit y sin push** — todo sigue sobre `0b3f41b` con los
cambios de actualización Loyverse pendientes de commitear/desplegar.