# Security Hardening — App Salmos LC

> Documento técnico de la fase de *Security Hardening* (migraciones `0018`–`0023`,
> Edge Functions `auth-phone-login` y `loyverse-customers`).
> Última actualización: **2026-10-07**.
> Proyecto Supabase: `salmoscafe's Project` · ref `gyugkrvdgxofnkfhzbeq`.
> Este documento **no contiene secretos**: no incluye keys, tokens, contraseñas
> ni datos personales. Los teléfonos de ejemplo son ficticios.

---

## 1. Estado general

### Objetivo

Cerrar las brechas de autorización e identidad detectadas en la auditoría del
2026-10-07, sin reescribir la arquitectura:

- RPCs `SECURITY DEFINER` que `anon`/`authenticated` podían ejecutar y que
  confiaban en `p_actor_role` / `p_actor_id` enviados por quien llamaba.
- Fuga **teléfono → email** en el login por teléfono.
- Tabla `bible_verse_pool` sin RLS.
- `customerCode` del cliente con prioridad sobre el de la base en
  `loyverse-customers`.
- Doble código de país (`+5252…`) al normalizar teléfonos hacia Loyverse.
- Teléfono del registro que nunca llegaba a `customers.phone`, y teléfono
  editable por el cliente sin verificación.

### Estrategia

Cambios **incrementales y aditivos**:

- Cada corrección es una migración nueva o un cambio acotado. Las
  migraciones históricas (`0001`–`0017`) no se editan.
- No se crearon tablas nuevas ni se cambiaron reglas de lealtad (7 visitas,
  $50 mínimo, 1 visita/día, $150, vigencia 3 meses).
- Las firmas de RPC usadas por Edge Functions y frontend se conservaron.
- Cada fase pasó por: auditoría → diseño → implementación local → tests sobre
  Postgres real (PGlite) → revisión → aplicación remota controlada.

### Estado actual

| Elemento | Estado |
|---|---|
| Migraciones `0018`–`0023` | **Aplicadas en remoto.** `supabase migration list` reportó local y remoto sincronizados hasta `0023` (verificación del equipo, 2026-10-07). |
| Edge `auth-phone-login` | **Desplegada** (reportado por el equipo). |
| Edge `loyverse-customers` (fix `customerCode` + E.164) | **Desplegada** (reportado por el equipo). |
| Frontend (login por teléfono vía Edge, `ensureCustomerProfile`) | **En el repositorio.** El frontend aún no tiene hosting de producción publicado. |
| Tests | `npm test` → **528/528** pasando en 32 archivos de test · `npm run build` → OK. |

> Los estados "aplicado / desplegado" provienen de la verificación remota hecha
> por el equipo con la CLI y el dashboard. Este documento no sustituye esa
> verificación: ante duda, volver a correr `supabase migration list`.

### Edge Functions relacionadas

| Función | `verify_jwt` | Rol en esta fase |
|---|---|---|
| `auth-phone-login` | `false` | **Nueva.** Login y recuperación por teléfono sin exponer el email (sección 5). |
| `loyverse-customers` | `true` | `customerCode` confiable y normalización E.164 (secciones 6 y 8). |
| `loyalty-engine` | `true` | Sin cambios de código. Ya derivaba el actor de `auth.getUser` + `public.profiles`; `0018` vuelve a validarlo en la base. |
| `loyverse-receipts-sync` | `false` | Sin cambios. Llama a las RPCs con `service_role` y actor `system`, compatible con `0018`. |

### Pruebas de seguridad

Los tests de seguridad corren sobre **PostgreSQL 17 real embebido**
(`@electric-sql/pglite`, solo devDependency). El harness
`tests/helpers/supabaseSqlHarness.mjs` emula los roles `anon` /
`authenticated` / `service_role`, `auth.uid()` / `auth.role()` y los
*default privileges* de Supabase, y aplica todas las migraciones en orden.

| Suite | Tests | Qué demuestra |
|---|---|---|
| `rpc-authorization` | 19 | `0018`: matriz de EXECUTE; anon/customer no ejecutan RPCs internas; spoofing de actor rechazado; staff/admin/system legítimos siguen funcionando |
| `bible-verse-pool-security` | 6 | `0019` |
| `login-alias-security` | 8 | `0020`: `resolve_email_for_login` solo `service_role`; `email_is_registered` booleano |
| `auth-phone-login-core` | 15 | Política de la Edge: sin email en respuestas, sin oráculo de existencia, piso de latencia |
| `auth-phone-login-client` | 8 | Frontend: teléfono → Edge → `setSession`; email sin cambios |
| `loyverse-customer-code` | 12 | `customerCode` confiable / 409 |
| `loyverse-phone-e164` | 11 | Fix `+52` |
| `phone-identity-migrations` | 9 | `0021`, `0022`, `0023`; incluye una réplica exacta de los permisos remotos |
| `customer-profile-phone` | 8 | `ensureCustomerProfile` |

**Validación negativa (alcance acotado):** se comprobó que los tests de los
exploits/casos correspondientes a `0018`, `0019`, `0020` y `customerCode`
fallan sin la migración o el fix respectivo. Esa validación negativa **no** se
realizó para las 9 suites completas.

---

## 2. Migración `0018` — RPC authorization hardening

**Superficie protegida:** RPCs del motor de lealtad (`register_visit`,
`register_visit_with_receipt`, `cancel_visit`, `cancel_visit_by_sale`,
`redeem_reward`, `verify_reward_claim`, `visit_summary`,
`assert_loyalty_actor`, `constant_time_equal`) y funciones de trigger
(`handle_new_user`, `set_updated_at`).

**Riesgo (verificado):**

- Las migraciones revocaban EXECUTE solo a `PUBLIC`. Supabase otorga EXECUTE a
  `anon` y `authenticated` por *default privileges*, así que estas funciones
  eran invocables vía `/rest/v1/rpc/*`.
- `assert_loyalty_actor` aceptaba un JWT de usuario con
  `p_actor_role = 'customer'`.
- En conjunto, un cliente autenticado podía **registrarse sellos a sí mismo**
  y **cancelar visitas ajenas** por `external_sale_id`. Reproducido sobre
  Postgres real antes del fix.

**Cambio conceptual:**

- `assert_loyalty_actor` (misma firma):
  - exige `auth.role() = 'service_role'` y **ninguna** sesión de usuario;
  - acepta solo los roles `staff`, `admin` y `system`;
  - para `staff`/`admin` comprueba en `public.profiles` que `p_actor_id`
    exista con **ese** rol exacto y `active = true`.
- `p_actor_id` / `p_actor_role` quedan como metadato de auditoría; nunca son
  autorización por sí solos.
- EXECUTE explícito sobre todas las sobrecargas de las RPCs internas:
  `revoke` a `PUBLIC`, `anon` y `authenticated`; `grant` a `service_role`.
- Las funciones de login por alias se re-declararon con anon/authenticated.
  `0020` y `0022` las ajustan después.
- `alter default privileges for role postgres in schema public revoke execute
  on functions from anon, authenticated`: las funciones futuras ya no quedan
  expuestas automáticamente.

**Estado:** ✅ completada y aplicada.

---

## 3. Migración `0019` — `bible_verse_pool` lockdown

**Problema:** la tabla se creó en `0011` sin RLS. Con los default privileges
de Supabase, `anon` y `authenticated` podían leer, insertar, actualizar y
**borrar** el pool vía `/rest/v1`.

**Modelo de acceso (determinado por sus consumidores reales):**

- El único lector es `register_visit_with_receipt` (`SECURITY DEFINER`, dueño
  `postgres`).
- El frontend no consulta la tabla: los textos viven en el dataset local.

| Rol | Acceso después de `0019` |
|---|---|
| `anon` | Ninguno (sin SELECT) |
| `authenticated` | Ninguno (sin SELECT) |
| `service_role` | **Solo SELECT** (diagnóstico). Escrituras revocadas. |
| `postgres` (migraciones) | Mantenimiento del pool |

**Cambios:**

- RLS activado **sin policies**.
- `revoke all` a `PUBLIC`, `anon` y `authenticated`.
- A `service_role` se le revoca INSERT/UPDATE/DELETE/TRUNCATE/MAINTAIN y se
  le deja SELECT.

Los **49 `verse_id`** se conservan; no se tocan datos. La asignación aleatoria
de versículos a visitas sigue funcionando.

**Estado:** ✅ completada y aplicada.

---

## 4. Migración `0020` — login alias lockdown

**`resolve_email_for_login(text)`:**

- Sigue siendo `SECURITY DEFINER`, con la misma firma y la misma regla de
  coincidencia (email exacto o dígitos del teléfono; **solo** si hay una
  única cuenta).
- Ahora devuelve el email de **`auth.users`** de la cuenta vinculada
  (`customers.auth_user_id`), no `customers.email`, que el cliente puede
  editar.
- **EXECUTE:** solo `service_role`. `anon` y `authenticated` ya **no** pueden
  ejecutarla.
- Su único consumidor es la Edge `auth-phone-login` (sección 5).

**`email_is_registered(text) → boolean`** (nueva):

- Reemplaza el uso público de `resolve_email_for_login` en el pre-chequeo del
  registro.
- Solo devuelve existencia; `anon` y `authenticated` pueden ejecutarla.

**Prerequisito de despliegue:** `auth-phone-login` y el frontend que la usa
debían existir antes de aplicar `0020`. Con un frontend anterior, el login
por teléfono llamaba a `resolve_email_for_login` como anon.

**Estado:** ✅ completada y aplicada.

---

## 5. Edge Function `auth-phone-login`

**Propósito:** login y recuperación de contraseña **por teléfono** sin que el
email de la cuenta llegue al navegador.

```text
navegador ──(teléfono + contraseña)──▶ auth-phone-login
   Edge: teléfono → email (RPC resolve_email_for_login, service_role) → Supabase Auth
navegador ◀──(solo tokens de sesión, o un error genérico)──
```

### Contrato (`POST`, JSON)

| `operation` | Campos | Respuesta exitosa |
|---|---|---|
| `password` | `phone`, `password` | `200 { ok: true, session: { access_token, refresh_token, expires_in, expires_at, token_type } }` |
| `recover_start` | `phone` | `200 { ok: true }`, **siempre igual** exista o no la cuenta |
| `recover_verify` | `phone`, `code` (6–10 dígitos) | `200 { ok: true, session: {…} }` |

### Errores

| Situación | Respuesta |
|---|---|
| Body inválido, campos extra (incluido `email`), `phone` con `@` | `400 invalid_request` |
| Teléfono inexistente, ambiguo **o** contraseña incorrecta | `401 invalid_credentials` (idénticos) |
| Correo sin confirmar, alcanzable **solo** con la contraseña correcta | `403 email_not_confirmed` |
| OTP incorrecto o teléfono inexistente en `recover_verify` | `401 otp_invalid` (idénticos) |
| Límite de Supabase Auth | `429 rate_limited` |
| Configuración o base no disponible | `503 service_unavailable` |

### Garantías

- **Nunca devuelve el email interno**, ni en éxito ni en error. La sesión se
  reduce a tokens: se descarta el objeto `user`.
- **Nunca devuelve ni registra** contraseña ni OTP. No hay `console.*` en la
  función.
- **Sin oráculo de existencia:**
  - para un teléfono sin cuenta también se consulta a Supabase Auth, con un
    email señuelo de dominio reservado (`*.invalid`), que nunca puede
    existir;
  - todas las respuestas que dependen de la cuenta tardan al menos **800 ms**.
- La contraseña y el OTP los valida **solo Supabase Auth** (GoTrue). No hay
  criptografía, almacenamiento de secretos ni sesiones propias.
- El frontend instala la sesión con `supabase.auth.setSession(...)`; después
  el comportamiento es idéntico al login por email.

### Rate limiting

- La Edge **no implementa rate limiting propio**: se apoya en los límites de
  Supabase Auth (`/token`, `/otp`, `/verify`).
- Para que esos límites cuenten **por IP del usuario** y no por IP de la Edge,
  la función reenvía la IP del cliente en `sb-forwarded-for`, usando la
  secret key.
- Requiere **Authentication → Rate Limits → IP Address Forwarding** activado
  en el proyecto.

**Implementación:** `supabase/functions/auth-phone-login/index.ts` +
`supabase/functions/_shared/authPhoneLoginCore.js` (lógica pura testeable).

---

## 6. Vulnerabilidad `customerCode` — ✅ cerrada

**Antes:** `const customerCode = body.customerCode || profile.customer_code`.
Un cliente podía mandar a Loyverse el código QR de **otra** persona.

**Ahora** (`resolveTrustedCustomerCode` en `_shared/loyverseCore.js`, usado
por `loyverse-customers`):

- La fuente confiable es `customers.customer_code` del usuario autenticado
  (columna `NOT NULL`).
- El `customerCode` del body **no** es fuente de identidad; como mucho
  confirma el valor de la base (el frontend lo envía por compatibilidad).

| Body | Resultado |
|---|---|
| ausente / `null` / `""` | se usa el valor de la base |
| igual al de la base (sin distinguir mayúsculas ni espacios) | se usa el valor de la base |
| distinto | **`409 customer_code_mismatch`**, **sin llamar a Loyverse** |
| no string | `400 invalid_body` |

**Auditoría:**

- El rechazo queda en `customer_sync_events` como
  `event_type = 'loyverse_conflict'`, con
  `detail.code = 'customer_code_mismatch'`.
- Se escribe con `service_role`.

---

## 7. Teléfono como identidad — estado real

**Principio:**

- El teléfono enviado por el cliente **no** es fuente de identidad.
- La fuente de verdad es `customers.phone`.
- El teléfono del body solo debería servir para confirmar el valor de la
  base.

**Lo que SÍ está implementado:**

- `0023`: el cliente ya **no puede cambiar** `customers.phone` (sección 11).
- `0021`: normalización segura de teléfonos legacy (sección 9).
- `0022`: `phone_is_registered` canónico (sección 10).
- `ensureCustomerProfile` persiste el teléfono del registro en forma canónica
  al crear el perfil (sección 13).
- Normalización E.164 correcta hacia Loyverse (sección 8).

**Lo que todavía NO está implementado:**

- **La validación de `body.phone` en `loyverse-customers` no existe aún.**
  El código actual sigue resolviendo
  `const phone = body.phone || profile?.phone || user.phone || null`. Es
  decir, el body todavía tiene prioridad, y `auth.users.phone` aún es un
  último recurso.
- El diseño aprobado (pendiente):
  - body ausente → `customers.phone`;
  - body igual (canónico) → continuar;
  - body distinto → `409 phone_mismatch`, auditoría
    (`loyverse_conflict` / `detail.code = 'phone_mismatch'`, sin el teléfono
    completo) y **sin** llamada a Loyverse.
- Lo mismo aplica, con menor severidad, a `body.name`.

---

## 8. Loyverse — normalización E.164 (fix `+52`) ✅

**Bug:**

- `createOrLinkLoyverseCustomer` pasaba a `computeIdentityUpdates` el
  teléfono ya reducido a dígitos (`526645550000`).
- `toE164` solo respetaba el código de país si el valor empezaba con `+`, así
  que el resultado era `+52526645550000`.
- Efectos: rellenos corruptos en Loyverse e `identity_conflict` falsos contra
  clientes con el mismo número.

**Corrección** (`_shared/loyverseCore.js`):

- `computeIdentityUpdates` recibe el teléfono original. La búsqueda
  (`listByPhone`) sigue usando dígitos.
- `toE164` trata `52` + 10 dígitos sin `+` como número que ya trae el código
  de país.

| Entrada (ficticia) | Salida |
|---|---|
| `6645550000` | `+526645550000` |
| `526645550000` | `+526645550000` |
| `+526645550000` | `+526645550000` |
| `+16641234567` | `+16641234567` (otros países sin cambio) |

Ningún teléfono MX válido produce `+5252…` (cubierto por tests).

---

## 9. Migración `0021` — `customers_phone_canonical`

Normaliza `customers.phone` legacy a **E.164 MX** (`+52XXXXXXXXXX`) **solo
cuando es seguro**.

- `lock table public.customers in share row exclusive mode`, dentro de un
  único bloque `DO`.
- Clasificación previa a escribir:

| Estado | Acción |
|---|---|
| `invalid_format` | No se toca (no normaliza a E.164 MX) |
| `already_canonical` | Sin cambio ni auditoría |
| `collides_with_canonical_customer` | No se toca: otro cliente ya tiene el número canónico |
| `ambiguous_duplicate` | No se toca **ninguna** de las filas que terminarían iguales |
| `normalize` | Se reescribe, con `WHERE c.phone = <valor original>` |

- La comparación es **canónica**, porque `customers_phone_unique_key` compara
  dígitos crudos y no detecta `6645550007` contra `+526645550007`. El índice
  **no se modificó**.
- **Auditoría** en `audit_logs` (`actor_role = 'system'`):
  - `action = phone_normalize_applied | phone_normalize_skipped`;
  - `detail = { reason, from_format, last2 }`. **Nunca** el teléfono completo.
- **Idempotente:** una segunda ejecución no hace cambios ni duplica la
  auditoría.
- **Estado remoto observado:** el snapshot verificado después de aplicar
  `0018`–`0023` muestra los 7 registros actuales de `customers.phone` en
  `NULL`. Con ese estado, no había valores almacenados en `customers.phone`
  que pudieran requerir normalización en ese momento. El resultado de la
  migración **no** se auditó directamente (no se consultó `audit_logs`).

---

## 10. Migración `0022` — `phone_is_registered` pendiente/canónico

**Helper privado `public.canonical_mx_phone(text)`:**

- `IMMUTABLE`.
- Reglas: 10 dígitos → `+52…`; `52` + 10 → `+52…`; resto → `NULL`.
- **Sin EXECUTE** para `PUBLIC`, `anon` y `authenticated`.

**`public.phone_is_registered(p_phone text) → boolean`** (misma firma):

- `SECURITY DEFINER`, `search_path = public`.
- Devuelve `true` si el número canónico está:
  1. en `customers.phone`, o
  2. en `auth.users.raw_user_meta_data.phone` de un usuario que **todavía no
     tiene** fila en `customers` **y** que está confirmado
     (`email_confirmed_at`) o se creó hace menos de 24 h.
- La metadata se usa **solo** para cubrir la ventana del registro. En cuanto
  existe la fila `customers`, se ignora.
- Metadata no-string, vacía o no normalizable se ignora. Entrada inválida →
  `false`.
- Solo devuelve un booleano: nunca cuántos ni quiénes.
- **Sigue disponible para `anon` y `authenticated`**, porque `RegisterForm` →
  `checkSecondaryContact` la llama **antes** de tener sesión.
- `resolve_email_for_login` **sigue restringida** a `service_role` (`0020`).
- La enumeración de teléfonos por este RPC es una decisión de producto
  conocida (sección 16).

---

## 11. Migración `0023` — `revoke_customer_phone_update`

| Rol | UPDATE sobre `public.customers` después de `0023` |
|---|---|
| `anon` | Ninguno |
| `authenticated` | Solo `name`, `email`, `profile` (sobre su fila, por la policy `customers_update`) |
| `service_role` | Completo |

- Se implementa con `revoke update` a nivel tabla para `anon` y
  `authenticated`, más `grant update (name, email, profile)` a
  `authenticated`.
- INSERT, SELECT, DELETE, policies y RLS **no cambiaron**.
- El INSERT inicial del perfil puede seguir fijando `phone`.
- Se verificó contra una réplica exacta de los permisos remotos previos:
  `anon` con UPDATE en las 15 columnas y `authenticated` en
  `email, name, phone, profile`.
- Ningún flujo de la app hacía UPDATE de `customers` como cliente. Las
  escrituras de columnas `loyverse_*` las hace `loyverse-customers` con
  `service_role`.

---

## 12. Problema conocido del registro (snapshot)

- Durante el registro por email, el teléfono se guarda en
  `auth.users.raw_user_meta_data.phone`, porque la fila `customers` aún no
  existe.
- Hasta esta fase, `ensureCustomerProfile` **no** lo copiaba a
  `customers.phone`.

**Snapshot de la base remota**, verificado por el equipo **después de aplicar
`0018`–`0023`**:

| Métrica | Valor |
|---|---|
| `public.customers` | 7 filas |
| con `customers.phone` | 0 (las 7 en `NULL`) |
| con teléfono en `raw_user_meta_data.phone` | 3 |

> Son cifras de un momento concreto, no una garantía permanente. Volver a
> consultarlas antes de diseñar o aplicar `0024`.

**Pendiente de auditoría:**

- Todavía **no** se ha auditado individualmente la relación entre esos 3
  usuarios con `raw_user_meta_data.phone` y las filas de `customers`.
- Esa auditoría debe hacerse **antes** de diseñar `0024` (sección 15).
- Mientras ningún `customers.phone` tenga valor, el login por teléfono no
  puede resolver ninguna cuenta, porque se basa en `customers.phone`.

---

## 13. `ensureCustomerProfile` (frontend)

Archivo: `src/services/auth/supabaseAuthService.js`.

- **Solo actúa al crear** la fila `customers`. Si ya existe, la devuelve tal
  cual: la metadata nunca se vuelve a leer ni sobrescribe `customers.phone`.
- **Origen del teléfono al crear** (`initialProfilePhone`):
  1. el teléfono **explícito** recibido como parámetro (prioridad);
  2. fallback: `user.user_metadata.phone`, solo si es string.
- **Canonicalización** con `toE164Mx`. Si no normaliza a E.164 MX, se guarda
  `null`, nunca texto crudo.
- **`auth.users.phone` (GoTrue) no se usa**: sin proveedor SMS no es fuente
  válida.
- **Conflicto de unicidad** (`customers_phone_unique_key`, el número ya es de
  otro cliente):
  - se crea la fila **sin teléfono**;
  - la sesión continúa;
  - el perfil devuelto lleva `phoneConflict: true`.
  - **Nunca** se sobrescribe ni modifica al otro cliente, ni se hace UPDATE.
- Otras violaciones únicas (carrera de `auth_user_id` o `customer_code`):
  relectura, igual que antes.
- **Google/OAuth** sin teléfono → `customers.phone = NULL`.

---

## 14. Fuente de verdad del teléfono

| Dato | Rol |
|---|---|
| **`customers.phone`** | **Teléfono canónico (`+52XXXXXXXXXX`) y fuente de verdad** para login por teléfono, `phone_is_registered`, Loyverse y validación de identidad. |
| `auth.users.raw_user_meta_data.phone` | **Transporte temporal** del registro: solo se lee al crear `customers` y en la ventana de `phone_is_registered`. |
| `auth.users.phone` | **No** es fuente de verdad del proyecto (no se usa). |
| Loyverse `phone_number` | **Copia derivada** de `customers.phone`, nunca al revés. |

---

## 15. Pending / Next Security Work

> ⚠️ Nada de esta sección está implementado ni aplicado todavía.

### `0024` — Backfill controlado `raw_user_meta_data.phone → customers.phone`

- **Antes** de crear o aplicar `0024`: auditar los registros actuales (3 en el
  snapshot de la sección 12) con un pre-chequeo de solo lectura.
- Clasificación propuesta:

| Clase | Acción |
|---|---|
| `ok` | Único migrable automáticamente |
| `invalid` | No se migra |
| `taken` | El número ya pertenece a otro cliente: no se migra |
| `duplicate` | La misma metadata en varias cuentas: no se migra |

- Auditoría sin el teléfono completo. Idempotente. Bloqueo de la tabla
  durante la ejecución.

### `0025` — Unicidad basada en el teléfono canónico

- Revisar o reemplazar `customers_phone_unique_key` (hoy compara dígitos
  crudos) por unicidad sobre `canonical_mx_phone(phone)`.
- **Después** del backfill y de resolver los conflictos marcados.

### Validación de `body.phone` (y `body.name`) en `loyverse-customers`

- Diseño aprobado, sin implementar (sección 7).

### `customer_sync_events`

- Hoy la policy `sync_events_own_all` (`for all to authenticated`) permite al
  cliente leer, insertar, editar y borrar **sus propios** eventos, incluidos
  los escritos con `service_role`.
- La tabla es historial técnico: no participa en decisiones de negocio ni de
  seguridad.
- Pendiente evaluar:
  - escritura solo con `service_role`;
  - sin acceso del cliente;
  - mover a `admin` todos los `logSyncEvent` de `loyverse-customers`, que hoy
    usan el JWT del usuario. **Es una dependencia que hay que cambiar en el
    mismo paso.**

### CAPTCHA / Bot Protection

- Actualmente **Disabled** en Supabase Auth.
- Es **hardening pendiente**, no una vulnerabilidad corregida.
- Si se activa, `auth-phone-login` tendría que reenviar el token de CAPTCHA a
  Supabase Auth.

### Otros pendientes relacionados

- Cambio de teléfono después del registro: solo vía Staff/Admin (backend) y,
  a futuro, verificación por SMS.
- Relleno del teléfono hacia Loyverse para clientes ya sincronizados
  (`already_linked` no reenvía datos).
- Hosting del frontend: variables `VITE_SUPABASE_URL` /
  `VITE_SUPABASE_PUBLISHABLE_KEY`, y *Site URL* / *Redirect URLs* en
  Authentication → URL Configuration.

---

## 16. Riesgos aceptados y conocidos

- **Enumeración por `phone_is_registered`:** el RPC público revela si un
  teléfono está ocupado. Es una decisión de producto, para el pre-chequeo del
  registro. Sin rate limiting propio. Mitigación futura: Edge con rate limit
  o CAPTCHA.
- **Teléfono sin verificación de propiedad:** sin proveedor SMS, cualquiera
  puede declarar un número libre al registrarse. `0023` limita ese riesgo al
  momento del alta.
- **Recuperación por email:** el flujo existente de recuperación por email
  conserva su comportamiento previo. Es independiente de la operación
  `recover_start` de `auth-phone-login`, que solo aplica a la recuperación por
  teléfono.
