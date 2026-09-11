# Auth y flujo Loyverse — Salmos Café Loyalty (Fase 1, completa)

Fuente de verdad del flujo de autenticación de **cliente** y de la
sincronización con Loyverse. Complementa `README.md` (vista general) y
`AUTH_UX_DESIGN.md` (decisión de UX).

## Contrato público (frontend)

Todo pasa por el facade `src/services/auth/authService.js`, que enruta a la
implementación **real** (`supabaseAuthService.js`) cuando hay `.env`, o al
**mock** (`mockAuthService.js`) en modo demo. Las pantallas solo ven este
contrato; ambas implementaciones lo cumplen idéntico.

| Método | Uso |
|---|---|
| `signUpWithEmail({ email, password, name, phone })` | Registro con correo + contraseña. `phone` opcional (contacto + alias). Devuelve `mode: "complete"` (sesión lista) o `"confirm_email"` (si Supabase exige confirmar). |
| `signInWithPassword({ identifier, password })` | Login. `identifier` = correo **o** teléfono. |
| `forgotPasswordStart({ identifier })` | Inicia recuperación; envía OTP **al correo** y devuelve `maskedContact`. |
| `forgotPasswordVerify({ code })` | Valida el código de un solo uso. |
| `forgotPasswordResend()` | Reenvía el código. |
| `setNewPassword({ newPassword })` | Guarda la contraseña nueva (exige haber verificado el OTP). |
| `signInWithGoogle()` | Dispara OAuth; la sesión llega vía redirect → `onSessionChange`. |
| `checkSecondaryContact({ method, value })` | Prechequea si un teléfono/correo ya está en uso (usado al registrarse). |
| `resendConfirmationEmail({ email })` | Reenvía el correo de confirmación de cuenta. |
| `getSession / onSessionChange / signOutClient / retryLoyverseSync / cancelPending` | Sesión y provisioning. |

Los errores vuelven como `{ ok: false, error: { code, message } }` con `message`
en español, definidos en `src/services/auth/authErrors.js`.

## Decisiones de arquitectura (resueltas con el socio)

1. **Auth primaria = correo o teléfono + contraseña.** El OTP por correo es
   **solo** el mecanismo de recuperación de contraseña, nunca el login.
2. **Teléfono = alias + contacto.** Para entrar con teléfono, el cliente se
   resuelve a email con un RPC servidor (`resolve_email_for_login`, migración
   0003). La contraseña la valida siempre Supabase Auth (GoTrue).
3. **SMS apagado.** No hay proveedor Twilio configurado; por eso la
   recuperación siempre va al correo, aunque pidas con teléfono. Si algún día
   se habilita SMS, todo lo demás no cambia.
4. **Google.** OAuth estándar de Supabase. Si el correo de Google ya tiene una
   cuenta, se muestra conflicto amigable e invitación a entrar con correo y
   contraseña (no se pisa la cuenta).
5. **Un perfil `customers` por usuario auth.** `auth_user_id` es UNIQUE; el
   perfil se asegura de forma idempotente en cada alta de sesión.

## Login por teléfono (detalle técnico)

El navegador **no puede** leer filas de `customers` de otros usuarios (RLS).
Para resolver "teléfono → email" de la cuenta, la migración `0003` define el
RPC seguro:

```sql
-- Lo que la app manda tras normalizar a E.164 (+52…): el usuario escribe
-- 10 dígitos y `phoneIdentifierForLogin` (supabaseAuthService.js) los
-- convierte ANTES de llamar al RPC.
select public.resolve_email_for_login('+526641234567');
-- devuelve el email SOLO si hay UNA coincidencia exacta por dígitos; si el
-- teléfono es ambiguo o inexistente devuelve NULL.
```

- `SECURITY DEFINER`, `set search_path = public`, grants solo a
  `anon`/`authenticated`. No enumera ni filtra datos: devuelve un email o NULL.
- Con un identificador "correo" no se usa el RPC: GoTrue resuelve y la UI no
  confirma si la cuenta existe (anti-enumeración).
- Teléfono desconocido → "No encontramos una cuenta con ese correo o teléfono."
- Teléfono con 2+ cuentas → NULL → mismo mensaje; se invita a usar el correo.
- Pre-chequeo de registro (`checkSecondaryContact`, H3): antes de registrarse
  el anon NO puede leer `customers` (RLS), así que se usa la función servidor
  `phone_is_registered` (migración 0003): devuelve **solo** un booleano de
  existencia por dígitos — sin email, filas ni perfil. El correo se comprueba
  con el mismo resolver (coincidencia única). Ninguna de las dos abre RLS.

## Recuperación de contraseña (OTP al correo)

```
Login ──¿Olvidaste tu contraseña?──► introducir correo o teléfono
   │                                   │
   ◄── resolve_email_for_login ────────┘ (si es teléfono)
   ▼
supabase.auth.signInWithOtp({ email, shouldCreateUser:false })  → llega el código
   ▼
verifyOtp({ type:"email", email, token })  (crea sesión efímera de reset)
   ▼
updateUser({ password })  → setNewPassword  → vuelve a Login y entra con credenciales
```

No queda sesión abierta tras la recuperación: el flujo termina en el login y el
cliente entra con su contraseña nueva.

## Registro y alta de sesión (provisioning)

1. `signUpWithEmail` crea el usuario en Supabase Auth (`user_metadata: name,
   phone`). Si confirma email está activado, la cuenta queda pendiente.
2. Al iniciar sesión, `getSession` (llamado por `App.onSignedIn`) ejecuta
   `buildSession`:
   - asegura la fila `customers` (idempotente; `customer_code` `SC-…` único);
   - siembra el mock de lealtad (`ensureLoyaltyProfile`, DEV bridge);
   - llama a la Edge Function `loyverse-customers` para crear/vincular (y, si
     corresponde, actualizar) el cliente de Loyverse (nunca directo desde el
     navegador).
3. Si el sync falla, la sesión **se entrega igual** y `SyncBanner` ofrece
   retry. `retryLoyverseSync` re-dispara desde el perfil/Home.

## Sincronización con Loyverse: crear, vincular y actualizar (Fase 1 + Fase C)

El flujo completo decide en la capa pura
`supabase/functions/_shared/loyverseCore.js` (unit-testable) y ejecuta contra
la API de Loyverse SOLO en la Edge Function (dueña de
`LOYVERSE_ACCESS_TOKEN`).

1. **Buscar**: email (filtro oficial `?email=…&limit=1`) y teléfono (la API no
   filtra; se pagina `limit=250` con tope de 15 páginas y se filtra por
   dígitos). Si el perfil ya tiene `loyverse_customer_id` + `synced`, sale
   `already_linked` **sin red**.
2. **Crear**: si no existe, `POST /v1.0/customers` con `name`, `email`,
   `phone_number` (E.164 +52), `customer_code`. Duplicado por `customer_code`
   (400) → rebusca y vincula.
3. **Vincular**: si existe (email y/o teléfono), se vincula al cliente
   existente sin crear (nunca duplicados). Si email→X y teléfono→Y (distintos)
   o el teléfono es ambiguo → conflicto (409, no retriable).
4. **Actualizar (Fase C, reglas conservadoras)**: al resolver a UN cliente
   existente, `computeIdentityUpdates` compara los datos de Salmos contra los
   de Loyverse:
   - idénticos (tras normalizar) → **no** hay `PUT` (idempotencia de red);
   - faltantes en Loyverse (email, teléfono, `customer_code` null o nombre
     vacío) → se **rellenan** con un `PUT` parcial (status `updated`, evento
     `loyverse_updated`);
   - email/teléfono **distintos** → **NUNCA** se sobrescriben: bloquea con
     409 `loyverse_identity_conflict` (status conflict). El cliente debe
     entrar con esa cuenta (o recuperar su contraseña) y dejar correo y
     teléfono enlazados; SyncBanner muestra esa guía;
   - nombre / `customer_code` distintos (ambos no vacíos) → **no** se
     sobrescriben; se omiten y se registran en el detalle de auditoría
     (`detail.skippedFields`);
   - datos del POS (`total_visits`, `total_spent`, `total_points`, ventas)
     **jamás** se leen ni viajan en el `PUT`.
5. **Auditoría**: eventos en `customer_sync_events` (`loyverse_created`,
   `loyverse_linked`, `loyverse_updated`, `loyverse_already_linked`,
   `loyverse_conflict`, `loyverse_error`) — `loyverse_updated` se registra
   SOLO cuando hubo una actualización real. El tipo lo permite la migración
   `0004` (la CHECK de `event_type` de 0001 no lo incluía).

Cambios de comportamiento esperado (documentados y cubiertos en tests):
un cliente existente cuyo **teléfono difiere** del de Salmos ya no se vincula
en silencio; pasa a conflicto conservador (antes se vinculaba sin tocar nada).

## Google (OAuth)

- `signInWithGoogle` usa `signInWithOAuth({ provider: "google" })` con redirect
  al origin; `detectSessionInUrl` y `onAuthStateChange` recogen la sesión al
  volver.
- En demo (mock), el botón simula el acceso: sesión inmediata (cuenta seed o
  cuenta nueva con email `@gmail.com` de prueba).
- La Edge Function de Loyverse sigue siendo el único camino para vincular el
  cliente de Loyverse del nuevo usuario de Google.

## Seguridad

- `LOYVERSE_ACCESS_TOKEN` vive **solo** en la Edge Function; no es una `VITE_*`
  y el navegador nunca toca `api.loyverse.com`.
- `resolve_email_for_login` devuelve un email o NULL; no expone teléfonos ni
  hashes, y no filtra listas.
- Errores crudos de Supabase nunca llegan al cliente: `authErrors.js` los
  traduce a frases amigables.
- `.env` no se versiona; el mock no contiene secretos.

## Riesgo conocido — "oráculo" email ↔ teléfono (H2)

Aceptado y documentado en esta fase; **no se reescribe el flujo de auth ahora**.

- `resolve_email_for_login` puede ser invocado por **`anon`** (está a propósito:
  es pre-login). Quien conozca un teléfono registrado puede obtener el **email**
  de esa cuenta, o confirmar si un teléfono/correo está registrado.
- **Lo que NO expone**: contraseñas, hashes, el resto del perfil de `customers`,
  ni listas. Devuelve un email único o NULL.
- `phone_is_registered` (H3) añade otro oráculo más débil: booleano de
  existencia del teléfono. Se eligió así para que el pre-chequeo de registro
  NO use el oráculo email↔teléfono.
- No hay rate limiting en PostgREST por defecto.
- **Mitigación futura recomendada** (no para esta fase):
  1. Mover la resolución **y** el `signInWithPassword` a una Edge Function
     (el navegador nunca vería emails resueltos);
  2. Añadir rate limiting / dirección permitida / CAPTCHA a los endpoints de
     auth;
  3. Revisar si `phone_is_registered` merece restricción extra (p. ej. moverlo
     a una Edge Function con límites).

## Riesgos externos (requieren config en Supabase, fuera del código)

- Habilitar **Email** y **Google** en Authentication → Providers y configurar
  los redirect URLs del proyecto.
- Confirmaciones de email (`email confirmations`) condicionan el modo
  `confirm_email` del registro según el proyecto.
- Provider **Phone/SMS**: apagado a propósito (sin credenciales Twilio).
- Desplegar la Edge Function `loyverse-customers` con sus variables
  (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `LOYVERSE_ACCESS_TOKEN`).