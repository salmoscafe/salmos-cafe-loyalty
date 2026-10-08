# Security Hardening — `customers.phone` y `loyverse-customers`

**Proyecto:** Salmos Café Loyalty<br>
**Fecha de cierre:** 2026-10-07<br>
**Estado:** Cerrado y verificado<br>
**Supabase Project:** `gyugkrvdgxofnkfhzbeq`<br>
**Repositorio:** `salmoscafe/salmos-cafe-loyalty`

---

## 1. Resumen

Se completó una fase de hardening de seguridad relacionada con el teléfono de los clientes y su uso en la integración con Loyverse.

El objetivo principal fue garantizar que:

1. `customers.phone` sea el único teléfono considerado autoritativo para un cliente.
2. Los teléfonos almacenados en `customers.phone` tengan formato E.164 mexicano válido.
3. Un cliente no pueda modificar directamente su teléfono desde el cliente autenticado. Este control **no se introdujo en esta fase**: existe desde la migration `0023_revoke_customer_phone_update.sql` (commit `9cf06ea`), que dejó a `authenticated` sin `UPDATE` de `customers.phone`. Esta fase lo da por supuesto y no lo modifica.
4. `loyverse-customers` no confíe en un teléfono enviado por el cliente como fuente de verdad.
5. Un teléfono enviado en el request únicamente funcione como comprobación de consistencia.
6. Un teléfono inválido o diferente no continúe hacia la sincronización con Loyverse.

La implementación fue probada localmente y posteriormente desplegada y verificada contra la función real de Supabase.

---

## 2. Cambios de base de datos

### Migration 0024

**Archivo:**

`supabase/migrations/0024_customers_phone_backfill.sql`

Se realizó un backfill controlado de exactamente tres registros históricos previamente aprobados.

La migración fue diseñada para modificar únicamente esos valores conocidos y no realizar modificaciones generales sobre los teléfonos existentes.

**Commit:**

`f10ce69`

`security: backfill approved customer phones`

---

### Migration 0025

**Archivo:**

`supabase/migrations/0025_customers_phone_e164_mx_check.sql`

Se agregó el constraint:

`customers_phone_e164_mx_check`

Regla:

```text
phone IS NULL
OR phone = +52 seguido exactamente de 10 dígitos ASCII
```

Ejemplos válidos:

```text
+521234567890
+526645551234
```

Ejemplos rechazados:

```text
6645551234
+1...
+52 6645551234
+52-664-555-1234
+52664555123
+5266455512345
```

El constraint no utiliza `canonical_mx_phone()` deliberadamente.

`canonical_mx_phone()` permanece restringida a `service_role`; utilizarla dentro de un `CHECK` habría introducido un problema de permisos para operaciones realizadas por clientes autenticados.

La unicidad continúa siendo responsabilidad de:

`customers_phone_unique_key`

El índice existente no fue reemplazado ni modificado.

**Commit:**

`2d715c5`

`security: enforce MX E.164 customer phones`

---

## 3. Fuente autoritativa del teléfono

Antes del hardening, `loyverse-customers` resolvía el teléfono mediante:

```js
phone = body.phone || profile?.phone || user.phone || null
```

Esto permitía que un valor controlado por el cliente (`body.phone`) tuviera prioridad sobre el valor almacenado en `customers`.

El comportamiento fue cambiado.

La fuente autoritativa ahora es:

```text
customers.phone
```

El `body.phone` ya no puede sustituir ese valor.

El teléfono enviado por el cliente únicamente sirve como comprobación de consistencia.

También se eliminó el fallback hacia `user.phone`.

No se modificó en esta fase el manejo de `name`. La metadata de autenticación continúa participando en el fallback de nombre existente, y ese comportamiento queda explícitamente fuera del alcance de este hardening.

---

## 4. Comportamiento de `loyverse-customers`

La función continúa requiriendo:

```text
operation = "link_or_create"
```

Una vez validada la operación, el comportamiento de `phone` es el siguiente.

### A. `body.phone` ausente

Se utiliza:

```text
customers.phone
```

como fuente de verdad.

---

### B. `body.phone = null`

Se utiliza:

```text
customers.phone
```

como fuente de verdad.

---

### C. `body.phone = ""`

Se considera ausente y se utiliza:

```text
customers.phone
```

---

### D. `body.phone` no es string

La función devuelve:

```json
{
  "ok": false,
  "code": "invalid_body",
  "traceId": "...",
  "retriable": false
}
```

HTTP:

```text
400
```

No continúa hacia Loyverse.

---

### E. `body.phone` es un string diferente o inválido

Si el valor enviado:

- no tiene formato E.164 MX válido;
- tiene espacios adicionales;
- utiliza otro formato;
- o es diferente del valor almacenado;

la función devuelve:

```json
{
  "ok": false,
  "code": "phone_mismatch",
  "traceId": "...",
  "retriable": false
}
```

HTTP:

```text
409
```

El teléfono confiable no se incluye en la respuesta.

La sincronización con Loyverse no continúa.

Este comportamiento incluye específicamente el caso:

```text
customers.phone = NULL
body.phone = un número
```

que produce `409 phone_mismatch`.

---

### F. No existe fila en `customers`

Si no existe el perfil correspondiente en `customers`, se conserva el comportamiento existente:

```json
{
  "ok": false,
  "code": "customer_setup_required",
  "traceId": "...",
  "retriable": false
}
```

HTTP:

```text
409
```

En este caso, el `body.phone` no se utiliza para crear o completar el perfil.

Se conserva también el caso previo: si además no hay un nombre disponible (body, perfil ni metadata), la función responde antes con `400 missing_name`.

---

### G. `body.phone` coincide exactamente

Si el valor enviado coincide exactamente con `customers.phone`, la operación continúa utilizando **el valor proveniente de la base de datos**, no el valor proporcionado por el cliente como fuente de verdad.

---

## 5. Comparación exacta

La implementación utiliza comparación exacta entre el teléfono proporcionado y el teléfono confiable almacenado.

Por lo tanto:

```text
+526645551234
```

y:

```text
  +526645551234
```

no se consideran iguales.

Tampoco se realiza `trim()` ni normalización silenciosa del valor enviado durante esta comprobación.

La canonicalización corresponde al momento de almacenamiento en `customers.phone`.

La comparación exacta fue verificada mediante:

- los tests locales;
- el código desplegado;
- la comparación del código desplegado contra el commit aprobado.

La prueba realizada directamente en producción con un número diferente únicamente demuestra el rechazo de un número distinto; no demuestra por sí sola el comportamiento de `trim()` frente al mismo número.

---

## 6. Cambios de código

### `supabase/functions/_shared/loyverseCore.js`

Se agregó lógica compartida para:

- identificar teléfonos E.164 MX;
- validar el formato canónico;
- resolver el teléfono confiable desde el perfil del cliente.

### `supabase/functions/loyverse-customers/index.ts`

Se modificó la resolución del teléfono para:

- eliminar el fallback a `user.phone`;
- utilizar `customers.phone` como fuente autoritativa;
- validar el tipo de `body.phone`;
- detectar discrepancias;
- detener la operación antes de la sincronización cuando existe un mismatch.

### Tests

Se agregó:

`tests/loyverse-customer-phone.test.mjs`

El archivo cubre los casos de validación, comparación, ausencia del teléfono, mismatch y protección contra regresiones.

---

## 7. Pruebas locales

Ambos cambios se validaron antes de su despliegue. Los resultados se agrupan por origen para que cada garantía sea trazable a su prueba.

### Migration `0025` (Postgres local, roles reales)

```text
42/42 — verificaciones de base de datos
16/16 — tests existentes de ensureCustomerProfile
```

Cubren:

- `NULL` y teléfono canónico válido;
- rechazo con `23514` de teléfonos no canónicos, espacios, guiones, longitudes incorrectas, prefijos internacionales y caracteres Unicode no válidos;
- duplicados (`23505` en `customers_phone_unique_key`);
- reintento con `phone = NULL` (`phoneConflict`);
- protección contra bypass mediante `service_role`;
- índice, permisos, RLS, policies y datos existentes sin cambios.

### `loyverse-customers`

```text
17/17 — tests/loyverse-customer-phone.test.mjs
49/49 — tests relacionados existentes (loyverse-customer-code, loyverse-phone-e164, loyverse-sync)
```

Cubren:

- rechazo del `body.phone` cuando no coincide, no es canónico o no es string;
- prevención de la llamada a Loyverse en los caminos negativos;
- ningún teléfono distinto de `customers.phone` llega a Loyverse;
- sin fallback a `user.phone` ni a metadata;
- ausencia de actualización de `customers.phone`.

### Paridad JavaScript ↔ SQL

```text
20/20 inputs — isCanonicalMxPhone ≡ CHECK de 0025
```

### Suite completa

```text
545/545 — 33 archivos
```

---

## 8. Deployment

La función fue desplegada mediante:

```powershell
supabase functions deploy loyverse-customers
```

Deployment confirmado mediante:

```powershell
supabase functions list
```

Resultado relevante:

```text
NAME                 STATUS   VERSION
loyverse-customers   ACTIVE   16
```

La versión 16 quedó activa en producción.

---

## 9. Verificación del código desplegado

El deployment se descargó fuera del repositorio de trabajo para su inspección:

```text
C:\temp\salmos-verify
```

y se comparó contra los archivos correspondientes del código local.

Archivos comparados:

```text
supabase/functions/loyverse-customers/index.ts
supabase/functions/_shared/loyverseCore.js
```

No se encontraron diferencias de contenido.

Las únicas advertencias observadas fueron relacionadas con finales de línea LF/CRLF en Windows.

Conclusión:

> La versión 16 activa de `loyverse-customers` corresponde al código aprobado localmente.

---

## 10. Pruebas contra producción

Después de verificar el deployment se realizaron pruebas controladas contra la función desplegada.

Las pruebas negativas utilizaron una sesión autenticada existente y no requirieron crear registros de producción.

### Prueba 1 — tipo incorrecto

Request:

```json
{
  "operation": "link_or_create",
  "phone": 1234567890
}
```

Resultado:

```text
HTTP 400
code: invalid_body
retriable: false
```

La respuesta también incluyó `traceId`.

**Resultado:** aprobado.

---

### Prueba 2 — teléfono diferente

Request utilizado:

```json
{
  "operation": "link_or_create",
  "phone": "+520000000000"
}
```

Resultado:

```text
HTTP 409
code: phone_mismatch
retriable: false
```

**Resultado:** aprobado.

No se reveló el teléfono almacenado en `customers`.

---

### Prueba 3 — número diferente con espacios

Request:

```json
{
  "operation": "link_or_create",
  "phone": "  +520000000000  "
}
```

Resultado:

```text
HTTP 409
code: phone_mismatch
retriable: false
```

**Resultado:** aprobado.

Esta prueba confirma que un valor diferente continúa siendo rechazado aunque contenga espacios.

No se considera evidencia independiente del comportamiento de `trim()` frente al mismo número. Esa propiedad está respaldada por los tests locales y por el código desplegado, que fue comparado contra el commit aprobado.

---

## 11. Camino legítimo no ejecutado en producción

No se ejecutó deliberadamente el camino exitoso de:

- `body.phone` omitido;
- `body.phone` igual al teléfono confiable.

La razón es evitar disparar una sincronización real con Loyverse durante una prueba de producción utilizando una cuenta que pudiera no estar sincronizada.

Estos caminos sí fueron cubiertos mediante los tests locales y mediante revisión del código desplegado.

Por lo tanto, este documento **no afirma que una sincronización legítima completa haya sido ejecutada en producción durante esta fase**.

---

## 12. Control de llamadas a Loyverse

Los casos negativos están diseñados en el código para detenerse antes de la sincronización con Loyverse.

Esta propiedad está respaldada por:

- los tests locales;
- la revisión del flujo de código;
- la identidad entre el código desplegado y el commit aprobado.

No se presenta como una observación directa de una llamada de producción, ya que la plataforma no proporciona en esta verificación un mecanismo equivalente para observar internamente esa llamada.

---

## 13. Auditoría de cambios remotos

Durante la verificación de `0025` se comprobó que no existieran cambios accidentales en:

- cantidad de clientes;
- políticas RLS;
- grants;
- funciones existentes;
- índices;
- datos históricos aprobados;
- registros de auditoría.

La migración `0025` no generó registros adicionales en `audit_logs`.

La verificación remota mostró que los únicos cambios esperados asociados con `0025` fueron:

- avance del historial de migraciones;
- existencia y validación del nuevo constraint.

No se detectaron cambios no relacionados.

---

## 14. Git

Commits incluidos en esta fase:

```text
f10ce69 security: backfill approved customer phones
2d715c5 security: enforce MX E.164 customer phones
1f617af security: use customers.phone as the only phone source in loyverse-customers
```

Estado final del branch:

```text
1f617af (HEAD -> main, origin/main, origin/HEAD)
2d715c5
f10ce69
```

`main` se encuentra sincronizado con `origin/main`.

Los cambios no relacionados del working tree no forman parte de estos commits.

---

## 15. Archivos de trabajo no relacionados

Durante la revisión del repositorio se identificaron archivos fuera del alcance de esta fase.

En el entorno de Windows utilizado para el desarrollo permanecieron:

```text
README.md
Salmos_Estructura_de_Datos.txt
postcss.config.mjs
```

Además, una inspección que representa los cambios de finales de línea puede mostrar como modificados:

```text
src/screens/staff/CustomerFound.jsx
supabase/migrations/0009_reward_redemptions.sql
supabase/migrations/0013_profiles_roles.sql
```

Esos cambios corresponden a diferencias CRLF/LF y no forman parte de la implementación de este hardening.

Ninguno de esos archivos fue incluido en los commits de seguridad descritos en este documento.

---

## 16. Rollback

### Migration 0025

La eliminación del constraint no debe realizarse ejecutando SQL manualmente como mecanismo normal de rollback.

Para conservar la correspondencia entre el esquema remoto y el historial de migraciones, el rollback debe realizarse mediante **una nueva migration explícita**, previamente revisada y aprobada, que contenga:

```sql
ALTER TABLE public.customers
DROP CONSTRAINT customers_phone_e164_mx_check;
```

La nueva migration deberá desplegarse mediante el flujo normal de Supabase.

No se considera necesario realizar este rollback actualmente.

---

### Código de `loyverse-customers`

Revertir el commit en Git únicamente modifica el repositorio; **no revierte el deployment de Supabase**.

Un rollback completo requiere:

1. revertir o seleccionar el commit de código aprobado;
2. verificar localmente el estado resultante;
3. ejecutar nuevamente:

```powershell
supabase functions deploy loyverse-customers
```

4. verificar la versión activa de la función;
5. realizar las pruebas de verificación correspondientes.

No se considera necesario realizar este rollback actualmente.

---

## 17. Estado final

**Estado: CERRADO**

La fase se considera completada porque:

- [x] `customers.phone` tiene formato E.164 MX obligatorio cuando no es `NULL`.
- [x] El teléfono almacenado es la fuente autoritativa.
- [x] `loyverse-customers` no utiliza `user.phone` como fallback.
- [x] `body.phone` no puede sustituir el teléfono confiable.
- [x] Los tipos inválidos son rechazados.
- [x] Los teléfonos inconsistentes son rechazados.
- [x] Los mismatches no exponen el teléfono confiable.
- [x] Los casos negativos están cubiertos por tests y por el flujo de código desplegado.
- [x] Tests locales completos pasan.
- [x] Deployment remoto verificado.
- [x] Código desplegado comparado contra el commit aprobado.
- [x] Pruebas negativas ejecutadas contra producción.
- [x] Commits publicados en `origin/main`.
- [x] Los cambios no relacionados permanecen fuera de los commits de seguridad.

**Limitación de verificación:** el camino legítimo de sincronización (`body.phone` omitido o igual al teléfono confiable) no se ejecutó en producción, deliberadamente, para no disparar una sincronización real con Loyverse (ver sección 11). Está cubierto por los tests locales y por la identidad entre el código desplegado y el commit aprobado.

---

## 18. Trabajo posterior

Queda explícitamente fuera de esta fase cualquier hardening adicional relacionado con:

- prioridad de `body.name`;
- `customer_sync_events`;
- `audit_logs`;
- otros endpoints de Loyverse;
- frontend;
- cambios adicionales de autenticación.

Estos temas deben evaluarse y documentarse como fases independientes para mantener una trazabilidad clara.

---

**Conclusión:** La protección de `customers.phone` y el uso de ese valor como fuente autoritativa en `loyverse-customers` quedó implementada, desplegada, probada y verificada. Las afirmaciones de producción están limitadas a los casos que realmente fueron ejecutados, mientras que el resto de garantías se atribuyen explícitamente a los tests y al código desplegado.
