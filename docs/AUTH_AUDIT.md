# Auditoría técnica — Sistema de Autenticación de Salmos Café Loyalty

Fecha: 2026-09-11 · Commit auditado: `86b364f` (`feat: implement Supabase loyalty engine D1.1`)
Tipo: **auditoría de solo lectura** (no se modificó ningún archivo del proyecto excepto este).

- Alcance: email+password, verificación de email, recuperación de contraseña (OTP), Google OAuth, SMTP, identidad `auth → customers → Loyverse`, sesiones y compatibilidad con el motor de lealtad D1.1.
- Método: lectura completa del código real (frontend, mock, facade, Edge Function, migraciones, config.toml, tests, docs) y verificación de cada token requerido. **Nada se da por sentado de la documentación; todo se contrastó con el código.**
- Criterio de clasificación: **IMPLEMENTADO** (código real y funcional) · **PARCIALMENTE IMPLEMENTADO** (hay código, falta configuración/integración) · **DOCUMENTADO PERO NO IMPLEMENTADO** (solo en docs/UI) · **NO IMPLEMENTADO** (ausente).
- Criterio de ejecución (esta actualización): **HECHO** (verificable en repo) · **PENDIENTE MANUAL** (requiere acción con datos externos o dashboard) · **BLOQUEADO POR DATO EXTERNO** (no se puede completar sin un dato que no existe aún).

---

## 0. Actualización (2026-09-11) — Ejecución AUTH-1 / AUTH-2

Aplicación parcial de **AUTH-1** (Google OAuth) y **AUTH-2** (SMTP + plantillas): se entregó todo lo que no depende de credenciales/dominio externos. **Nada se inventó** (ni URLs de producción, ni credenciales, ni proveedor SMTP); lo que no tiene dato externo quedó marcado.

| Item | Estado | Evidencia |
|---|---|---|
| Plantilla "Confirmación" (diseño #1) | **HECHO** | `email-templates/confirm-signup.html` + `[auth.email.template.confirmation]` |
| Plantilla "Recuperación" (diseño #2) | **HECHO** (uso condicional) | `email-templates/reset-password.html`. Con el flujo actual (`signInWithOtp`) la recuperación dispara **magic_link**, no esta plantilla; se deja lista para `resetPasswordForEmail` (decisión previa documentada en §5/§6) |
| Plantilla "Código OTP" (diseño #3) | **HECHO** | `email-templates/otp.html` — contiene solo `{{ .Token }}` (sin `ConfirmationURL`), por lo que GoTrue lo entrega como **OTP de 6 dígitos**; es el correo real de la recuperación de la app |
| Plantilla "Cambio de correo" (diseño #4) | **HECHO** | `email-templates/change-email.html` + `[auth.email.template.email_change]` (dispara en AUTH-6) |
| Plantilla "Bienvenida" (diseño #5) | **HECHO** (archivo) / **PENDIENTE MANUAL** (disparador) | `email-templates/welcome.html`; Supabase Auth no envía welcome nativo → requiere hook/Edge Function o automatización del proveedor de email |
| Asuntos / preheaders | **HECHO** | Asuntos en `config.toml`; preheaders ocultos en cada HTML; copy y visual según `docs/SALMOS_EMAIL_DESIGN.md` |
| Redirects locales | **HECHO** | `additional_redirect_urls = ["http://127.0.0.1:3000"]` (se corrigió `https`→`http`; URLs de producción pendientes) |
| `[auth.external.google]` (AUTH-1) | **PENDIENTE MANUAL** | Bloque comentado en `config.toml` con `env(GOOGLE_CLIENT_ID/SECRET)`; exige credenciales de Google Cloud Console + activarlo en dashboard remoto. Descomentar sin `.env` rompería `supabase start`, por eso queda comentado |
| `[auth.email.smtp]` (AUTH-2) | **PENDIENTE MANUAL** | Bloque comentado con `env(SMTP_*)`; exige proveedor + dominio + SPF/DKIM/DMARC + definir remitente |
| Seguridad | **Verificado** | Sin secretos en git (`rg` sin hits reales); `.env`/`.env.*`/`supabase/.temp` ignorados; solo `.env.example` tracked y con placeholders; sin SMTP password ni Google secret en el frontend (`readEnv` de `VITE_` públicos); redirects restringidos a allow-list |

**Verificación final:** `npm test` → **61/61** · `npm run build` → OK (warning de chunk >500 kB preexistente, no nuevo).

**No se tocó `src/`**: el código de Google OAuth ya era correcto (`signInWithOAuth`) y AUTH-1/AUTH-2 son config/infra. Archivos modificados: `supabase/config.toml`, `.env.example`, `docs/AUTH_AUDIT.md` (este) y 5 nuevos en `email-templates/` (única fuente de plantillas; la carpeta legacy `supabase/templates/` se eliminó al unificar rutas en `config.toml` → `./email-templates/*`, ver Actualización 2026-09-12).

**Cadena para producción (al tener dominio y credenciales):** (1) descomentar `[auth.external.google]` y `[auth.email.smtp]` en `config.toml` y rellenar `.env` (gitignored); (2) replicar en el dashboard remoto (`Authentication → Providers / SMTP / Email Templates`); (3) definir en producción `site_url` + `additional_redirect_urls` y los redirects de Google Cloud Console; (4) confirmar `enable_confirmations` ON/OFF (decisión §17). Los templates aplican igual en local y remoto.

### Actualización UI (2026-09-11) — limpieza de presentación del login

Cambios **solo de presentación**, sin tocar ningún servicio de auth:

- Título del login: **"Bienvenido"** (Instrument Serif) como único titular (el logo comunica Salmos Café; el subtítulo "Entra a tu tarjeta" se eliminó).
- **Icono oficial de Google** inline (SVG en `src/components/common/icons.jsx`, `Icon.Google`); `SecondaryButton` acepta un `icon` opcional conservando altura/tipografía/borde/radius.
- Navegación por **pathname** (`/`, `/Staff`, `/Admin`) en `src/lib/navigation.js`; el selector de demo Cliente/Staff/Admin fue eliminado.
- Consistencia tipográfica: `.sc-eyebrow-plain`/`.sc-auth-eyebrow` unificados; `.sc-auth-switch` ahora tiene estilos explícitos.
- **Contrato de auth intacto**: `authService.signInWithGoogle()`, `devSetGoogleMode` y todo el facade mock/real sin cambios — `tests/auth.test.mjs` (Google existente/nuevo) sigue pasando. `npm test` → **112/112** · `npm run build` OK · **sin deploy**.

### Actualización (2026-09-12) — hardening de concurrencia Loyverse (registro)

Registro formal de la corrección de la condición de carrera de la
sincronización de clientes con Loyverse y de su validación en producción
(no es una re-auditoría; complementa `docs/CURRENT_STATUS.md`):

- **Problema histórico:** dos invocaciones concurrentes de `loyverse-customers`
  podían cruzar sus búsquedas y crear un **cliente duplicado** en Loyverse (2
  duplicados históricos en el perfil QA; se conservan tal cual, no se tocan).
- **Fix:** migración `0006` (claim atómico `loyverse_sync_claim` /
  `loyverse_sync_claim_at` en `customers`) + `_shared/syncClaim.js` +
  `index.ts`. Perdedor → `409 loyverse_sync_in_progress` (`retriable: true`)
  sin llamar a la API; lease de 10 min; liberación solo por el token del
  dueño; `already_linked` antes del claim.
- **Despliegue:** migraciones `0001`–`0006` aplicadas en remoto y Edge Function
  `loyverse-customers` redeployada (**v3**, ACTIVE, `verify_jwt = true`) →
  avanza el cierre de despliegue pendiente descrito en §§8/11 y en el plan
  AUTH-7 (0004 y 0005 quedan aplicadas).
- **QA real concurrente:** dos invocaciones simultáneas con
  `{"operation":"link_or_create"}` → A: `409` (traceId
  `1e0795e1-…ff6ec2`); B: `200` `linked` a `c85906ca-…`; **1** nuevo
  `loyverse_linked`, **0** `loyverse_created`.
- **Tests:** `npm test` → **130/130** (10 en `tests/sync-claim.test.mjs`).

### Actualización (2026-09-12) — fuente única de plantillas de email (`email-templates/`)

Unificación de las plantillas de email en una única carpeta canónica:

- **`email-templates/`** (raíz del repo) es ahora la única fuente de verdad para las 5 plantillas:
  `confirm-signup.html`, `reset-password.html`, `otp.html`, `change-email.html`, `welcome.html` +
  `assets/wordmark-cream.png` (PNG fuente del logo).
- `supabase/config.toml` apunta los 4 type keys nativos a esa carpeta
  (`content_path = "./email-templates/*.html"`, resuelto relativo a la raíz del repo — comportamiento
  verificado del CLI). Se elimina la duplicación; **`supabase/templates/` ya no existe**.
- Logo de las plantillas: URL provisional `https://salmos-cafe.com/email-assets/wordmark-cream.png`
  marcada como PROVISIONAL en el HTML (sin dominio publicado todavía; al publicar se hospeda el PNG
  en esa ruta y se retira el comentario).
- Footer de marca: eslogan **"Donde el café es un verso al paladar."** en las 5 plantillas (reemplaza
  "Tu café, tus visitas, tus recompensas."); `docs/SALMOS_EMAIL_DESIGN.md` actualizado.
- `welcome.html` **no tiene trigger nativo** de Supabase Auth — envío sigue PENDIENTE MANUAL.
- **Verificación:** `npm test` → **130/130** · `npm run build` → OK · `supabase start` con las 4
  plantillas resueltas correctamente.

> El cuerpo de esta auditoría (fecha 2026-09-11, commit `86b364f`) refleja el
> estado de su fecha; esta sección es la actualización que la supera en lo que
> respecta a despliegue y concurrencia.

---

## 1. Resumen ejecutivo

El sistema de autenticación de **cliente** está **sustancialmente implementado y bien arquitectonizado**:

- **Email + contraseña**: completo (`signUp` / `signInWithPassword` / pre-chequeos / reenvío de confirmación).
- **Login por teléfono (alias)**: completo, con RPC seguro `resolve_email_for_login` (SECURITY DEFINER) para no romper RLS; la contraseña la valida **siempre** GoTrue.
- **Verificación de email**: completa; el modo real (`complete` vs `confirm_email`) depende de la configuración del proyecto Supabase. En `config.toml` local `enable_confirmations = false` (sesión inmediata); el remoto puede diferir y el código cubre ambos.
- **Recuperación de contraseña**: completa vía **OTP al correo** (`signInWithOtp` → `verifyOtp` → `updateUser`). Correctamente **no** se usa `resetPasswordForEmail` (link mágico) porque el diseño decidió código de 6 dígitos.
- **OTP**: implementado **solo** como recuperación (decision de negocio: el login es correo/teléfono + contraseña). SMS está deliberadamente apagado.
- **Google OAuth**: **parcialmente implementado**. El código de cliente (`signInWithOAuth`) y el flujo de UI existen y están probados contra el mock, **pero el proveedor NO está habilitado** en la configuración Supabase (no hay `[auth.external.google]` en `config.toml`). En modo real, el botón de Google fallaría hasta configurarlo.
- **Identidad customers/Auth/Loyverse**: completo y de punta a punta (RLS por `auth.uid()`, alta idempotente de perfil, `customer_code` único, Edge Function `loyverse-customers` autenticada con JWT, token de Loyverse solo server-side, `SyncBanner` para reintento/conflicto).
- **SMTP propio**: NO configurado. Se usa el correo **built-in** de Supabase (`no-reply@supabase.co` en remoto; `local_smtp` de inspección en local). Para entrega confiable con marca propia hace falta SMTP custom (SPF/DKIM/DMARC).
- **Seguridad**: patrón sólido (RLS en todas las tablas, RPCs SECURITY DEFINER con `search_path` fijo y grants mínimos, `verify_jwt=true` en la Edge Function, errores traducidos en `authErrors.js`, token Loyverse jamás en el navegador). Riesgo conocido y aceptado: oráculo email↔teléfono (H2/H3).
- **Compatibilidad con D1.1**: sin fricción. `assert_loyalty_actor` (0005) depende exactamente del modelo actual (`customers.auth_user_id = auth.uid()`); los RPC de lealtad solo los invoca `service_role`; D1.1 no toca `customers` ni el flujo de auth.

**Lo que falta (en orden de prioridad):** configurar Google y SMTP (destraba dos botones/flujos reales), aplicar migraciones pendientes al remoto (0004, 0005) y redeploy de la Edge Function, y, ya en código, cambio de contraseña/email dentro de Settings.

---

## 2. Estado actual real (inventario y clasificación)

| Capacidad | Estado | Dónde vive | Notas |
|---|---|---|---|
| Registro email+password | **IMPLEMENTADO** | `supabaseAuthService.signUpWithEmail` + mock | Valida formato y ≥8 chars; devuelve `mode: complete\ | confirm_email`. |
| Login email | **IMPLEMENTADO** | `signInWithPassword` | Directo a GoTrue; email no registrado → `INVALID_CREDENTIALS` (anti-enumeración). |
| Login teléfono (alias → email) | **IMPLEMENTADO** | `resolveLoginEmail` + RPC `resolve_email_for_login` (0003) | Normaliza E.164 +52 antes del RPC; solo devuelve email si hay coincidencia única. |
| Verificación de email | **IMPLEMENTADO** (según config del proyecto) | `mode: confirm_email` + `resendConfirmationEmail` | `config.toml` local `enable_confirmations = false` → sesión inmediata en local. |
| Recuperación por OTP al correo | **IMPLEMENTADO** | `forgotPasswordStart/Verify/Resend` + `setNewPassword` | `signInWithOtp{shouldCreateUser:false}` → `verifyOtp` (sesión efímera) → `updateUser`. |
| OTP | **IMPLEMENTADO** (solo recovery) | `OtpVerification` + servicios | 6 dígitos, cooldown 30s, auto-avance; `123456`/`000000` demo. |
| Google OAuth | **PARCIALMENTE IMPLEMENTADO** | `signInWithGoogle` + botón `LoginForm` + mock | Código frontend ✅; bloque `[auth.external.google]` comentado y listo en `config.toml` ✅; faltan credenciales Google Cloud + dashboard (**PENDIENTE MANUAL**, §0). |
| Pre-chequeo de registro | **IMPLEMENTADO** | `checkSecondaryContact` + RPCs `phone_is_registered` y resolver | Los RPCs no abren RLS (SECURITY DEFINER). |
| Alta de perfil `customers` | **IMPLEMENTADO** | `ensureCustomerProfile` (idempotente, `customer_code` único) | RLS `customers_own_all`; carrera 23505 → relee. |
| Vinculación Loyverse | **IMPLEMENTADO** | Edge Function `loyverse-customers` + `loyverseCore.js` | Crear/vincular/actualizar conservador; conflicto → 409; evento `loyverse_updated` requiere 0004 (remoto ⏳). |
| Sesión persistente | **IMPLEMENTADO** | `lib/supabase/client.js` (`persistSession`, `autoRefreshToken`, `detectSessionInUrl`) | `getSession` reconstruye perfil en cada carga. |
| Cerrar sesión | **IMPLEMENTADO** | `signOutClient` → `auth.signOut()` | — |
| SMTP propio | **PENDIENTE MANUAL** (plantillas ✅) | `email-templates/*.html` + `config.toml` | Plantillas propias (diseño aprobado) ya configuradas en `[auth.email.template.*]`; falta proveedor, dominio, SPF/DKIM/DMARC y remitente (datos externos, §0). |
| Cambio de contraseña (Settings) | **NO IMPLEMENTADO** | `Settings.jsx` es solo-lectura | Solo existe la recuperación (fuera de sesión). |
| Cambio de email/teléfono (Settings) | **NO IMPLEMENTADO** | — | — |
| Gestión de sesiones (lista/revocar) | **NO IMPLEMENTADO** | — | Supabase las gestiona; sin UI ni endpoints propios. |
| MFA | **NO IMPLEMENTADO** / fuera de V1 | `config.toml` todo deshabilitado | — |
| Auth Staff/Admin | **NO IMPLEMENTADO** (mock PIN) | `mock` (facade delega siempre al mock) | Fase posterior. |
| CAPTCHA / rate-limit de auth | **NO IMPLEMENTADO** (rate-limits nativos de Supabase) | `config.toml [auth.rate_limit]` | Sin CAPTCHA ni PostgREST rate limiting sobre RPCs. |

### Tokens requeridos: verificación

| Token | ¿Presente? | Ubicación |
|---|---|---|
| `signUp` | ✅ | `supabaseAuthService.js:273` y mock |
| `signInWithPassword` | ✅ | `supabaseAuthService.js:293` y mock |
| `signInWithOtp` | ✅ | `supabaseAuthService.js:358` (recovery) |
| `verifyOtp` | ✅ | `supabaseAuthService.js:370` (recovery) |
| `signInWithOAuth` / `google` | ✅ | `supabaseAuthService.js:402` (código; provider NO habilitado en config) |
| `resetPasswordForEmail` | ❌ (por diseño) | Se usa OTP en su lugar; decisión documentada en `AUTH_UX_DESIGN.md` |
| `updateUser` | ✅ | `supabaseAuthService.js:389` (password nuevo) |
| `onAuthStateChange` | ✅ | `supabaseAuthService.js:232` (solo dispara relectura de sesión) |
| `getSession` | ✅ | `supabaseAuthService.js:219` y mock |
| `auth.uid()` | ✅ | RLS 0001/0002 y `assert_loyalty_actor` (0005) |
| `auth_user_id` | ✅ | `customers` (0001, FK + UNIQUE) |
| `email_verified` | ✅ | Columna en `customers` (0002), escrita en `ensureCustomerProfile` |
| `customers` / `loyverse_customer_id` | ✅ | 0001; flujo completo |

---

## 3. Email/password

**Estado: IMPLEMENTADO.**

- **Registro (`signUpWithEmail`)**: valida email (`EMAIL_RE`) y contraseña ≥8 (`MIN_PASSWORD`), envía `user_metadata {name, phone}` a GoTrue. Si el proyecto exige confirmación no hay sesión → `mode: "confirm_email"` y la UI invita a revisar la bandeja. En `config.toml` local eso está apagado → `mode: "complete"`.
- **Login (`signInWithPassword`)**: el identificador se resuelve (correo directo a GoTrue; teléfono vía RPC), y **la contraseña siempre la valida GoTrue** (nunca el RPC ni el frontend).
- **Contrato idéntico en mock y real** (facade `authService.js`): en modo demo (sin `.env`) todo corre en memoria.
- **Errores amigables**: `authErrors.js` traduce códigos crudos a `{ code, message }` en español; la UI nunca muestra errores de Supabase crudos.

Hallazgos:
- En modo real sin las variables `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY`, el facade cae al mock (demo) — correcto.
- `checkSecondaryContact` detecta en caliente si el correo/teléfono ya está en uso (sin abrir RLS), usado al registrarse.

---

## 4. Verificación de email

**Estado: IMPLEMENTADO (comportamiento dictado por la configuración del proyecto).**

- `signUpWithEmail` devuelve `mode: "complete"` (sesión inmediata) o `"confirm_email"` según devuelva GoTrue una sesión o no.
- Si el proyecto tiene `email confirmations = on`, la UI muestra el aviso de confirmación y devuelve al login; existe `resendConfirmationEmail` (`auth.resend({type:"signup"})`).
- El estado se refleja en `customers.email_verified` (columna añadida en 0002), alimentado desde `user.email_confirmed_at`.

Estado de la configuración:
- `config.toml`: `[auth.email] enable_confirmations = false` (local). Sin confirmación, el flujo `confirm_email` no se ejerce en local.
- **Pendiente de decidir**: confirmaciones ON u OFF en el proyecto remoto de producción. El código soporta ambos.

---

## 5. Recuperación de contraseña

**Estado: IMPLEMENTADO (OTP al correo).**

- **Inicio** (`forgotPasswordStart`): resuelve el identificador (correo/teléfono) y llama `signInWithOtp({ email, options: { shouldCreateUser: false } })` → llega un **código de un solo uso** al correo. Devuelve `maskedContact` (`j***@domain`).
- **Verificación** (`forgotPasswordVerify`): `verifyOtp({ type:"email", email, token })` → valida el código y deja una **sesión efímera de reset**.
- **Nueva contraseña** (`setNewPassword`): `updateUser({ password })` con esa sesión efímera. Después se limpia `pending` y **no queda sesión abierta**: el flujo termina en login con el aviso "Contraseña actualizada. Entra con tu contraseña nueva."
- **Reenvío** (`forgotPasswordResend`): reutiliza el identificador en `pending`.
- **UI**: `ResetForm` (identificador) → `OtpVerification` (6 dígitos, cooldown 30s de reenvío, sniff de OTP_EXPIRED/transient) → `NewPasswordForm` (validación ≥8 y coincidencia).
- **Seguridad**: los servicios exigen el orden OTP-verificado antes de aceptar el password nuevo (en el real lo garantiza el estado de Supabase; en el mock `pending.verified`).

Hallazgo menor: en el mock, `forgotPasswordStart` responde `ACCOUNT_NOT_FOUND` para cuentas inexistentes mientras que el login con email inexistente responde `INVALID_CREDENTIALS`; es intencional (espejo del real) aunque técnicamente es un oráculo de existencia. Documentado y aceptado.

---

## 6. OTP

**Estado: IMPLEMENTADO (solo como recuperación de contraseña, nunca como login).**

- Decisión de negocio explícita: "OTP por correo solo para recuperar la contraseña" (`AUTH_UX_DESIGN.md` §5).
- No hay proveedor SMS (Twilio apagado en `config.toml`); la recuperación siempre va al correo, incluso si se pide con teléfono.
- Parámetros: `otp_length = 6`, `otp_expiry = 3600` (1 h), `max_frequency = "1s"`.
- **`resetPasswordForEmail` (link mágico) no se usa** — decisión documentada; el código usa el flujo de código OTP que encaja con el diseño UI.
- En demo: `123456` es siempre válido, `000000` vence, cualquier otro → inválido.

---

## 7. Google OAuth

**Estado: PARCIALMENTE IMPLEMENTADO.**

Qué hay:
- Código: `signInWithGoogle` → `supabaseClient.auth.signInWithOAuth({ provider: "google", options: { redirectTo: window.location.origin } })`.
- La sesión vuelve por redirect y la recogen `detectSessionInUrl: true` + `onSessionChange`; en demo el mock simula "Google existente" y "Google nuevo".
- Manejo de conflicto: un email de Google que ya tiene cuenta nativa produce `GOOGLE_CONFLICT` ("Entra con tu correo y contraseña") — el mapeo existe en `authErrors.js` y el flujo no pisa la cuenta.

Qué falta (imprescindible para que funcione en real):
1. Crear proyecto/credenciales de OAuth en **Google Cloud Console** (client_id/client_secret de OAuth 2.0). **DATO EXTERNO — PENDIENTE MANUAL.**
2. Descomentar `[auth.external.google]` en `config.toml` (bloque ya escrito con `env(GOOGLE_CLIENT_ID/SECRET)`) y activar el provider en el dashboard remoto. *(Ejecución de AUTH-1, ver §0.)*
3. Verificar `site_url`/`additional_redirect_urls` (hoy apuntan a local; producción pendiente).

**Hoy, en modo real, el botón "Continuar con Google" no puede completar el login** mientras no haya credenciales y provider activo. Es el gap más visible de la Fase B y su cierre quedó **PENDIENTE MANUAL**.

---

## 8. customers / Auth / Loyverse (identidad)

**Estado: IMPLEMENTADO y de punta a punta.**

Modelo de identidad (a conservar):
```
Supabase Auth (auth.users) ──1:1──► customers (auth_user_id UNIQUE)
                                        │  customer_code = SC-XXXXXXXX (QR, UNIQUE)
                                        │  email · phone (E.164) · email_verified
                                        ▼  loyverse_customer_id (UNIQUE) · loyverse_sync_status
                                   Edge Function loyverse-customers ──► api.loyverse.com
                                        (JWT del usuario · RLS · token server-side)
```

Piezas verificadas:
- **RLS**: `customers_own_all` (solo `authenticated`, `auth.uid() = auth_user_id`); el anon no lee nada. `customer_sync_events` y `loyalty_*` también restringidos; `audit_logs` solo `service_role`.
- **Alta idempotente**: `ensureCustomerProfile` crea la fila si no existe y ante carrera (23505) relee. `loyverse_sync_status` nace `pending`.
- **Vinculación Loyverse**: `runLoyverseSync` → Edge Function `loyverse-customers` (nunca llamada directa). Estados `synced / failed / conflict` se escriben en `customers`; falla → sesión se entrega igual y `SyncBanner` ofrece `retryLoyverseSync`.
- **Lógica de sincronización** (`loyverseCore.js`): busca por email (filtro oficial) → por teléfono (paginado) → vincula si hay UNO → conflicto si email y teléfono apuntan a distintos → crea solo si no existe. Actualización **conservadora** (rellena incompletos; nunca sobrescribe; email/teléfono distintos bloquean con `identity_conflict`).
- **Auditoría**: `customer_sync_events` (evento `loyverse_updated` requiere la CHECK ampliada por 0004 — **aún sin aplicar en remoto**).
- **DEV BRIDGE**: `ensureLoyaltyProfile` siembra el mock de lealtad con el `auth_user_id` real. Es **temporal**: se elimina cuando el motor de lealtad migre a Supabase (D1.2+).

Hallazgo: hoy el motor de lealtad en ejecución sigue siendo el mock (datos en memoria, se pierden al recargar). El esquema 0002 existe en Supabase pero sin datos/lógica activa; eso es el siguiente paso (D1), no un defecto de auth.

---

## 9. SMTP

**Estado: NO IMPLEMENTADO (usa el correo de Supabase).**

- `config.toml`: `[auth.email.smtp]` está **comentado** (bloque listo con `env(SMTP_*)`) → en local se usa `[local_smtp]` (servidor de inspección, no envía); en remoto, el **built-in** de Supabase (`no-reply@supabase.co`).
- Implicación: la entrega de "correo de confirmación" y "código de recuperación" depende de la infraestructura de Supabase y no lleva marca propia; deliverability (SPF/DKIM) no está bajo control del proyecto.
- El código **no depende** del proveedor: no hay ninguna lógica de envío en `src/`; todo pasa por los métodos de `supabase-js` (`signUp`/`signInWithOtp`/`resend`).
- **Avance AUTH-2 (ver §0):** las 5 plantillas de email (`confirm-signup`, `reset-password`, `otp` OTP, `change-email`, `welcome`) ya existen en `email-templates/` con el diseño aprobado de `docs/SALMOS_EMAIL_DESIGN.md`, y las 4 nativas están cableadas en `[auth.email.template.*]` (content_path relativo a la raíz del repo). Lo único pendiente es el dato externo: proveedor SMTP, dominio, SPF/DKIM/DMARC y el remitente (`no-reply@salmos…` vs `hola@…`).

---

## 10. Seguridad

Controles **presentes y verificados**:
- **RLS** en `customers`, `customer_sync_events`, `loyalty_cycles/visits`, `rewards`, `audit_logs`. El anon no lee `customers`.
- **RPCs 0003**: `resolve_email_for_login` y `phone_is_registered` son `SECURITY DEFINER`, `set search_path = public`, `stable`, con `revoke … from public` y grants solo `anon`/`authenticated`. Devuelven lo mínimo (un email si es coincidencia única; un booleano). No validan contraseñas.
- **Edge Function**: requiere `Authorization: Bearer <JWT>`, verifica con `auth.getUser`, corre bajo la RLS del usuario; `LOYVERSE_ACCESS_TOKEN` solo server-side (`verify_jwt = true`).
- **Errores**: `authErrors.js` traduce todo; no llegan stack traces ni códigos crudos a la UI.
- **Secretos**: `.env`/`.env.local` fuera de git; el mock no contiene secretos; `LOYVERSE_ACCESS_TOKEN` no es `VITE_*`.
- **Anti-enumeración** en login por email (credenciales inválidas genéricas).

Riesgos y gaps (con estado):
1. **Oráculo email ↔ teléfono (H2/H3) — aceptado y documentado.** `resolve_email_for_login` (`anon`) devuelve el email si conoces el teléfono; `phone_is_registered` confirma existencia. No expone contraseñas ni perfiles. Mitigación futura: mover resolver+login a una Edge Function con rate limiting. **No se reescribe ahora** (decisión de fase).
2. **Sin rate limiting en PostgREST** sobre los RPCs (el rate-limit nativo de Auth aplica a endpoints de Auth, no a los RPC).
3. **Tokens en `localStorage`** (default de Supabase con `persistSession`) — exposición a XSS; trade-off aceptado de SPA.
4. **`rate_limit.email_sent = 2`/hora** en `config.toml`: correcto contra spam, pero hay que confirmar el alcance en producción (por usuario vs global) para no frustrar recuperaciones.
5. **Sin CAPTCHA / lockout de intentos** en login/registro.
6. **`secure_password_change = false`**: Supabase no exige re-autenticación reciente para cambios de password (relevante cuando se añada "cambiar contraseña" en Settings).
7. **`enable_manual_linking = false`**: los conflictos de identidad (Google/email) no se resuelven por linking manual.

---

## 11. Compatibilidad con el motor de lealtad D1.1 (0005)

**Compatibilidad total; sin fricción.**

- `assert_loyalty_actor` (0005) usa exactamente el modelo actual: con JWT (`auth.uid()` presente) solo acepta `role = 'customer'` cuando `customers.auth_user_id = auth.uid()` y el `actor_id` coincide con `customers.id`; sin JWT solo `auth.role() = 'service_role'`. Esto encaja con el login real de cliente existente.
- Grants de 0005: `revoke all … from public` + `grant … to service_role` exclusivamente → el frontend **no puede** llamar `register_visit`/`cancel_visit`/`redeem_reward` por REST. Correcto: el cliente jamás incrementa sus propias visitas.
- 0005 no altera `customers` ni toca `auth.users` → **el flujo de auth no cambia**.
- `ensureLoyaltyProfile` (DEV bridge) seguirá cubriendo Home/Rewards/Activity contra el mock hasta D1.2; no rompe auth, es temporero y está etiquetado como tal.
- Pendiente de despliegue (relativo a auth/Loyverse): migración **0004** (CHECK de `loyverse_updated`) y **0005** aún **no aplicadas en remoto**; la Edge Function desplegada es la v1 (create/link); el update conservador está solo en código local. Ver README "Pending deployment".

---

## 12. Arquitectura propuesta

### Arquitectura actual (verificada)
```
VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY
             │ sí
React UI ──► authService (facade) ──► supabaseAuthService ──► supabase.auth
(Login/Register/Reset/OTP/NewPwd)        │ (signUp, signInWithPassword,
             │ sin .env ──► mockAuthService (demo)            signInWithOtp, verifyOtp,
                                                              updateUser, OAuth)
                                          │  teléfono → resolve_email_for_login (RPC 0003, SECURITY DEFINER)
                                          ▼
                                     customers (Postgres, RLS auth.uid()=auth_user_id)
                                          │
                                          ▼
                              loyverseEdgeClient ──► Edge loyverse-customers ──► api.loyverse.com
                                 (JWT del usuario)     (token server-side)
```

### Arquitectura objetivo (producción, misma identidad)
```
React UI ─► authService (facade) ─► supabase.auth          ← core de auth (email/password/OTP/OAuth)
   │        (login, registro, recovery, sesión)
   │
   ├─ Pre-chequeos y login por teléfono (fase AUTH-5):
   │     Navegador ─► Edge auth-proxy (resolver + signInWithPassword + rate-limit)
   │                  ─► customers (RLS)   [el navegador nunca ve emails resueltos]
   │
   ├─ Post-login (provisioning) — ya en su lugar:
   │     supabaseAuthService ─► customers (RLS) ─► Edge loyverse-customers ─► Loyverse
   │
   └─ Settings (fase AUTH-4/AUTH-6): updateUser (password/email) con re-auth si aplica
```

Principios que **se mantienen**: facade único, contrato idéntico mock/real, RLS por `auth.uid()`, Edge Function como única puerta a Loyverse, errores traducidos (`authErrors.js`), token de Loyverse nunca en el navegador, `service_role` solo en servidor.

---

## 13. Plan de implementación (AUTH-1 … AUTH-10)

Orden propuesto por valor/esfuerzo; puede reordenarse.

| ID | Tarea | Tipo | Prioridad | Depende de |
|---|---|---|---|---|
| AUTH-1 | Configurar Google OAuth (Google Cloud Console + provider en Supabase + redirects `site_url`/`additional_redirect_urls`) | Config/infra (no-code) | Alta | — |
| AUTH-2 | Configurar SMTP custom (dominio, SPF/DKIM/DMARC, proveedor, remitente) + plantillas de email en español | Config/infra (no-code) | Alta | Dominio del proyecto |
| AUTH-3 | Revisar `[auth.rate_limit] email_sent` / `max_frequency` y `secure_password_change` para producción | Config | Media | — |
| AUTH-4 | Cambio de contraseña dentro de Settings (`updateUser`, con confirmación de contraseña actual) | Código | Media | AUTH-3 |
| AUTH-5 | Mover resolver+login a Edge Function (mitigar oráculo H2/H3) + rate limiting/CAPTCHA | Código + infra | Media | — |
| AUTH-6 | Cambio de email con doble confirmación (aprovecha `double_confirm_changes = true`) y de teléfono/contacto | Código | Baja | AUTH-2 |
| AUTH-7 | Cierre de despliegue pendiente: `supabase db push` para 0004 y 0005 + redeploy de la Edge Function | Deploy | Alta (cierre D1) | — |
| AUTH-8 | Sesiones multi-dispositivo (ver / terminar sesiones) | Código | Baja | — |
| AUTH-9 | Auth Staff/Admin real (tabla `staff` en BD + PIN hash o Supabase) — sustituye el mock | Código | Posterior | — |
| AUTH-10 | Hardening: CAPTCHA en registro/login, lockout por intentos, auditoría de eventos de auth | Código + infra | Baja | — |

Nada de esto se ejecuta durante la auditoría; queda como plan.
**Actualización AUTH-1/AUTH-2 (ver §0):** la parte de código/config-sin-secretos ya se ejecutó (plantillas + bloque Google/SMTP listos). Quedan de AUTH-1/AUTH-2 solo datos externos (credenciales Google Cloud, dominio, proveedor SMTP) y su aplicación en dashboard remoto — marcados PENDIENTE MANUAL.

---

## 14. Test plan

**Unitarios (mock, `node --test`)** — ya existen 25 en `tests/auth.test.mjs`; ampliar:
- Recuperación completa real-mode (identificador teléfono → código a correo → password nuevo entra). *(Existe para email; añadir el path de teléfono en el mock ya espejado.)*
- Cambio de contraseña en sesión autenticada (AUTH-4) con contraseña actual incorrecta → 403.
- Cambio de email con doble confirmación y actualización de `customers.email`/`email_verified` (AUTH-6).
- Google: error de proveedor no habilitado → código amigable; conflicto de email existente → `GOOGLE_CONFLICT`.
- Errores: `toFriendlyError` para respuestas nuevas (p. ej. `reauthentication needed`, `over_email_send_rate_limit`).

**Integración contra el proyecto real (requiere .env / AUTH-1, AUTH-2):**
- Registro con confirmaciones OFF y ON (verificar ambos `mode`).
- Login email + teléfono (10 dígitos y E.164). 
- `resolve_email_for_login`: coincidencia única / ambigua / inexistente; `phone_is_registered` para teléfono nuevo y en uso.
- Recuperación real: llega el correo (SMTP configurado), código correcto/inválido/vencido, contraseña nueva entra.
- Google nuevo y Google existente (con conflicto amigable) tras AUTH-1.
- Provisioning+Loyverse: crear / vincular / conflicto de identidad — ya probado E2E en `CURRENT_STATUS.md`.

**Seguridad (queries SQL con `anon`, `authenticated`, `service_role`):**
- `anon` no puede SELECT/INSERT en `customers`, `loyalty_*`, `rewards`, `audit_logs`.
- Grants de RPCs 0003 (anon+authenticated) y 0005 (solo service_role) verificables con `\df+` / `information_schema`.
- Edge Function: 401 sin JWT; con JWT de otro usuario no ve filas ajenas.

**UI (flujo AuthScreen):** login, register, reset_identifier → reset_otp → new_password, provisioning, errores inline (credenciales, OTP vencido, email no confirmado, red), sesión expirada.

**Regresión:** `npm test` debe seguir en 61/61 base + las nuevas suites; `npm run build` sin errores nuevos.

---

## 15. Riesgos

| Riesgo | Prob. | Impacto | Mitigación |
|---|---|---|---|
| Botón Google falla en modo real (provider no configurado) | Alta (hoy) | Medio | AUTH-1 |
| Entrega pobre/rechazos de emails de confirmación y OTP (built-in Supabase) | Media | Alto | AUTH-2 (SMTP + SPF/DKIM/DMARC) |
| `rate_limit.email_sent = 2/h` limita recuperaciones legítimas si es global | Media | Medio | AUTH-3 |
| Oráculo email↔teléfono (H2/H3) explotable por `anon` | Conocido/aceptado | Bajo (no expone credenciales) | AUTH-5 |
| Tokens en `localStorage` (XSS) | Baja (sin XSS conocido) | Alto | Buenas prácticas CSP; revisar YKV |
| `0004`/`0005` sin aplicar en remoto: `loyverse_updated` y RPCs de lealtad indisponibles | Alta (hoy) | Medio | AUTH-7 |
| Cambio de email futuro rompe identidad Loyverse (email distinto → `identity_conflict`) | Media (tras AUTH-6) | Alto | AUTH-6 con doble confirmación + sync conservador ya existente |
| Conflicto Google vs cuenta nativa misma dirección | Media (tras AUTH-1) | Bajo | Mapeo `GOOGLE_CONFLICT` + guía en UI (ya existe) |

---

## 16. Criterios de aceptación

1. Cada capacidad tiene estado real verificado (filas de §2) y coincide con el código, no solo con la documentación.
2. Google: login completo en real (nuevo y existente) con el remitente y redirects correctos; conflicto de email muestra `GOOGLE_CONFLICT` sin pisar la cuenta.
3. Recuperación: el correo legítimo llega (SMTP), el código correcto permite password nuevo, y tras `verifyOtp`+`updateUser` **no** queda sesión activa inesperada.
4. Promedio `mode` correcto según confirmaciones del proyecto (complete / confirm_email) en registro y el aviso de bandeja cuando aplica.
5. Identidad: 1 auth_user = 1 customer; `customer_code` UNIQUE; `loyverse_customer_id` UNIQUE; provisioning crea/víncula sin duplicados y con auditoría.
6. Seguridad: `anon` no lee `customers`; grants de RPCs y funciones verificados; errores nunca crudos en la UI.
7. Compatibilidad D1.1: `assert_loyalty_actor` valida al customer con JWT y rechaza todo lo demás; RPCs de lealtad solo `service_role`.
8. `npm test` 61/61 o más, `npm run build` OK, sin prints de secretos ni `.env` en git.

---

## 17. Decisiones pendientes

1. **Confirmaciones de email ON u OFF en producción** (cambia `mode` del registro y la experiencia).
2. **Proveedor y remitente de SMTP** (`no-reply@` vs `hola@…`; SendGrid/Resend/Postmark/…) y dominio de la marca.
3. **Google OAuth definitivo**: habilitar el proveedor y reconciliar usuarios con cuenta nativa del mismo correo (hoy: conflicto amigable → login con password).
4. **Alcance de `rate_limit.email_sent`** en producción (por usuario o global) y valor objetivo.
5. **Cambio de contraseña/email en Settings en V1** o diferir (hoy solo recovery fuera de sesión).
6. **MFA / CAPTCHA**: si entran en V1 o quedan para hardening (AUTH-10).
7. **Auth Staff/Admin**: tabla `staff` en BD con PIN hash vs Supabase Auth (AUTH-9).
8. (Herencia de D1.1, no de auth) **BUSINESS TIMEZONE** en `register_visit`; la Edge Function D1.2 calculará `visit_date` en servidor.

---

## 18. Recomendación final

**Qué tenemos:** un sistema de autenticación de cliente completo y robusto en el patrón correcto: contraseña como auth primaria (correo o teléfono + contraseña), OTP **solo** para recuperación, alta idempotente de perfil `customers` bajo RLS, y sincronización Loyverse exclusivamente por Edge Function con el token en el servidor. El código distingue bien implementación real vs mock (demo), traduce errores y protege la cuenta con RLS/grants mínimos.

**Qué falta para "producción real de la Fase B":**
1. **Configurar Google OAuth** (AUTH-1) — el único botón de la UI que hoy no puede funcionar en modo real.
2. **Configurar SMTP propio** (AUTH-2) — para que confirmación y recuperación lleguen con marca y sin depender del built-in.
3. **Revisar límites de email + `secure_password_change`** (AUTH-3).
4. **Cierre de despliegue D1** (AUTH-7): aplicar 0004 y 0005 al remoto y redeploy de la Edge Function (esto ya no es auth, pero condiciona la sincronización que la Fase B dispara).

**Qué NO tocar aún:** el flujo de auth real (está correcto y validado), el patrón RLS/SECURITY DEFINER, ni el D1.1 recién validado. La mitigación del oráculo (AUTH-5) y el cambio de contraseña/email en Settings (AUTH-4/AUTH-6) quedan como mejoras ordenadas, no urgencias.

**Resumen de una frase:** la autenticación está implementada con método y seguridad; las prioridades son configuración (Google + SMTP), cierre de despliegue (0004/0005) y, en segundo término, añadir autogestión de cuenta (password/email) en Settings.