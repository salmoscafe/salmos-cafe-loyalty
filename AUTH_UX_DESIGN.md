# Salmos Café — Identidad, Registro y Recuperación (UX/UI)

Diseño de la experiencia de Login/Registro de cliente, **decidido con el
socio**:

- El login **primario** es **correo o teléfono + contraseña**.
- El **OTP por correo** existe **solo para recuperar la contraseña**
  (no es el método de login).
- Google entra como alternativa; no requiriere pantalla propia.

La implementación de esta fase está en `src/components/auth/` y
`src/services/auth/` (ver `docs/AUTH_AND_LOYVERSE_FLOW.md` para el detalle
técnico de contrato y Supabase).

---

## 1. Flujo completo

Idea central: **una sola pantalla que cambia de estado**, no una serie de
pantallas separadas.

```
        ┌─────────────────────────────────────────────┐
        │  ESTADO: login                               │
        │  Correo o teléfono + Contraseña              │
        │  [Iniciar sesión]  ·  ¿Olvidaste tu contraseña?│
        │  ¿No tienes cuenta? Regístrate aquí          │
        │  o  [Continuar con Google]                   │
        └──────┬───────────────────────────┬───────────┘
               │                           │
       correo/tel +                        │ toca Google
       contraseña                          ▼
               │                   ┌──────────────────┐
               ▼                   │ Supabase OAuth     │
     ┌────────────────────┐        │ (redirect a       │
     │ ESTADO: provisioning│        │  Google y de       │
     │ (arma perfil Salmos │        │  vuelta a la app)  │
     │  + client Loyverse) │        └─────────┬─────────┘
     └─────────┬──────────┘                  │
               │                      sesión lista → sesión activa
               ▼                             (provisioning tmb aplica)
            ┌──────────────────────┐
            │  ¿Olvidaste?   │
            ▼
  ┌─────────────────────────────────────────────┐
  │  ESTADO: reset_identifier                    │
  │  Correo o teléfono → [Enviar código]         │
  └──────────────────────┬──────────────────────┘
                         ▼
  ┌─────────────────────────────────────────────┐
  │  ESTADO: reset_otp                          │
  │  Código de 6 dígitos enviado al correo      │
  └──────────────────────┬──────────────────────┘
                         ▼
  ┌─────────────────────────────────────────────┐
  │  ESTADO: new_password                       │
  │  Contraseña nueva + confirmación → [Guardar]│
  └──────────────────────┬──────────────────────┘
                         ▼
                 vuelve a login con un aviso:
                 "Contraseña actualizada. Entra con tu nueva contraseña."
```

**Errores** no son pantallas nuevas: son banners inline dentro del estado
activo (`login`, `register`, `reset_*`, `new_password` o `provisioning`),
más el caso `session_expired`, que reabre `login` con contexto. Ver §4.

---

## 2. Pantallas necesarias

Es **una sola pantalla real** (`AuthScreen`) con seis estados internos.
La UI implementa `LoginForm`, `RegisterForm`, `ResetForm`,
`OtpVerification`, `NewPasswordForm` y `ProvisioningState`, todos dentro
del mismo layout.

### 2.1 `login` — Punto de entrada

- **Propósito:** entrar con el identificador de cuenta (correo o teléfono)
  y la contraseña, o usar Google.
- **Campos:** un único input de identificador (correo *o* teléfono, no hay
  selector de método: el sistema distingue solo) + campo de contraseña.
  Enlace "¿Olvidaste tu contraseña?" debajo.
- **Botones:** `Iniciar sesión` (primario) · `Continuar con Google`
  (secundario) · enlace "¿No tienes cuenta? Regístrate aquí".
- **Mensajes:** "Entra a tu tarjeta" + subtítulo. En demo, caja de
  credenciales de prueba.
- **Siguiente paso:** credenciales correctas → `provisioning`; error →
  banner inline (inválidas, correo sin confirmar con opción "Reenviar
  correo", temporal).

### 2.2 `register` — Cuenta nueva

- **Propósito:** crear cuenta con **correo + contraseña** (auth primaria).
  El teléfono es **opcional**: es solo de contacto (avisos de la tarjeta) y
  funciona como alias de login después.
- **Campos:** **Nombre** · **Correo** · **Teléfono (opcional, +52)** ·
  **Contraseña** (mínimo 8) · **Confirmar contraseña**.
- **Mensajes de validación locales:** correo inválido, contraseña débil o
  que no coincide, teléfono no mexicano (10 dígitos). Si el teléfono ya
  pertenece a otra cuenta → banner con "Ir a iniciar sesión" (prellenando
  ese teléfono).
- **Siguiente paso:** correo válido → sesión lista (`provisioning`), o —
  si Supabase requiere confirmación — mensaje "Revisa tu correo para
  confirmar tu cuenta" y vuelve a `login` con un aviso.

### 2.3 `reset_identifier` — "¿Olvidaste tu contraseña?"

- **Propósito:** recuperar contraseña con un código por correo.
- **Campos:** un input de identificador (correo o teléfono). El código
  **siempre va al correo** (no hay SMS configurado; si pides con teléfono,
  el sistema resuelve la cuenta y lo manda a su correo).
- **Botones:** `Enviar código` (primario) · "Volver al inicio de sesión".
- **Estado de error:** "No encontramos una cuenta con ese correo o
  teléfono." (no revela si el correo existe para evitar enumeración).

### 2.4 `reset_otp` — Código de un solo uso

- **Propósito:** verificar la identidad del dueño de la cuenta.
- **Campos:** input de 6 dígitos (`inputMode="numeric"`, auto-avance).
- **Botones:** `Confirmar` · `Reenviar código` (cuenta regresiva de 30s) ·
  "Usar otro método" (regresa a `login` limpio).
- **Mensajes:** "Enviamos un código a tu correo j\*\*\*@example.com"
  (enmascarado, nunca completo).
- **Errores:** código incorrecto · código vencido ("Este código venció.
  Envía uno nuevo") · temporal.

### 2.5 `new_password` — Contraseña nueva

- **Propósito:** definir la contraseña nueva (solo se llega con OTP
  verificado; los servicios exigen ese orden).
- **Campos:** contraseña nueva + confirmación (validación local ≥8 y
  coincidencia).
- **Botones:** `Guardar contraseña` · "Cancelar recuperación".
- **Siguiente paso:** vuelve a `login` con aviso "Contraseña actualizada.
  Entra con tu contraseña nueva."

### 2.6 `provisioning` — Transición final

- **Propósito:** cubrir lo que ocurre detrás de escena al abrir sesión
  (asegurar el perfil `customers`, sembrar la lealtad y vincular el
  cliente de **Loyverse** vía Edge Function) sin mostrar nada técnico.
- **Campos/botones:** ninguno; pantalla completa.
- **Mensajes:** "Estamos preparando tu tarjeta Salmos" / "Esto toma solo
  un momento". Nunca menciona Supabase, Loyverse ni API.
- **Estados:** `working` (spinner) → éxito (avanza solo) → error con
  `Reintentar` (no se pierde nada; la sesión se entrega igual aunque el
  sync a Loyverse falle y el banner `SyncBanner` ofrece reintento).

---

## 3. Qué reutilizar del proyecto actual

| Elemento actual | Decisión |
|---|---|
| `Field`, `PrimaryButton`, `SecondaryButton` (`components/ui.jsx`) | **Se reutilizan** tal cual. |
| `BrandMark`, `.sc-login*`, `.sc-phone-input`, `.sc-otp-row` en `styles.css` | **Se reutilizan y extienden** sin tocar la identidad visual existente. |
| `authService.getSession/signOutClient/onSessionChange/retryLoyverseSync` | **Se mantienen igual** — la sesión sigue siendo `{ customer } \| null`. |
| Contrato de auth del flujo OTP anterior | **Se reemplaza** por el contrato de contraseña de §7. |
| `authIdentities` (mock) | **Se mantiene el concepto** (customer_id ↔ provider ↔ provider_id) para no duplicar cuentas. |
| Google | **Solo como alternativa**, sin pantalla propia (`google_confirm` ya no existe): OAuth → sesión → provisioning. |
| Home / Rewards / Activity / Profile / QR / BottomNav | **Sin cambios.** Esta tarea termina donde termina `AuthScreen`: al completar `onSignedIn()`. |
| Flujo de Staff/Admin | **Sin cambios** — login de cliente únicamente. |

---

## 4. Estados de autenticación (taxonomía)

| Estado | Cuándo ocurre | Qué ve el usuario | Caso(s) cubierto(s) |
|---|---|---|---|
| **loading** | Cualquier llamada en curso | Spinner dentro del control activo | — |
| **login** | Entrada principal | Identificador + contraseña | 1–3, 15 |
| **register** | Cuenta nueva | Nombre, correo, teléfono opcional, contraseña ×2 | 4, 5, 6 |
| **conflict_phone** | El teléfono de registro ya pertenece a otra cuenta | Banner "Ese teléfono ya está asociado a otra cuenta." + "Ir a iniciar sesión" (prellena el teléfono) | 7, 8 |
| **confirm_email** | Supabase pide confirmar el correo antes de entrar | "Revisa tu correo…" y vuelve a login con aviso | 4* (con confirmaciones on) |
| **reset_identifier** | "¿Olvidaste tu contraseña?" | Correo o teléfono → código al correo | 12, 13 |
| **reset_otp** | Código enviado | Input de 6 dígitos + reenviar | 13 |
| **new_password** | OTP verificado | Contraseña nueva ×2 | 13 |
| **error_transient** | Falla de red/Supabase temporal | Banner inline "Algo salió mal. Intenta de nuevo." + `Reintentar`, los datos no se pierden | 10 |
| **error_credentials** | Credenciales inválidas | "Tu correo o contraseña no son correctos." | 11 |
| **error_code_invalid/expired** | OTP incorrecto/vencido (recuperación) | Input en rojo / "Este código venció. Envía uno nuevo" | 11, 12 |
| **session_expired** | Token vencido al volver | `AuthScreen` se reabre en `login` con "Tu sesión terminó, vuelve a entrar." | 15 |
| **success** | Sesión lista | `provisioning` → Home | — |

---

## 5. Recomendación final (decisión tomada)

- **Contraseña como auth primaria** (correo o teléfono + contraseña), porque
  el socio lo prefirió sobre el código cada vez.
- **OTP por correo solo como recuperación de contraseña**, lo que elimina
  las pantallas de "reestablecer cuenta" complicadas y usa los mecanismos
  nativos de Supabase (`signInWithOtp` + `verifyOtp` + `updateUser`).
- **Google sin pantalla propia**: el correo de Google llega verificado; si
  ya existe una cuenta con ese correo se muestra conflicto amigable (no se
  pisa nada).
- **Una pantalla, seis estados** — el usuario nunca navega un wizard: el
  contenido cambia en el mismo lugar.

---

## 6. Nota técnica para el login por teléfono (RPC seguro)

El navegador no puede leer filas `customers` de otros usuarios (RLS). Para
"entrar con teléfono", el frontend llama a la función **servidor**
`resolve_email_for_login` (migración `0003`, SECURITY DEFINER), que
devuelve el correo de la cuenta **solo si hay una coincidencia única** por
dígitos. La contraseña la valida siempre Supabase Auth. Para más detalle y
riesgos de configuración remota ver `docs/AUTH_AND_LOYVERSE_FLOW.md`.

---

## 7. Contrato de servicio (implementado)

```text
authService.signUpWithEmail({ email, password, name?, phone? })
  → { ok, mode: "complete" | "confirm_email" }
authService.signInWithPassword({ identifier, password })   // correo o teléfono
  → { ok } | { ok:false, error:{ code, message } }
authService.forgotPasswordStart({ identifier })            // código → correo
authService.forgotPasswordVerify({ code })
authService.forgotPasswordResend()
authService.setNewPassword({ newPassword })
authService.signInWithGoogle()
authService.checkSecondaryContact({ method, value })
authService.resendConfirmationEmail({ email })
authService.getSession() / onSessionChange() / signOutClient() / retryLoyverseSync()
```

Los errores son `{ code, message }` con frases en español definidas en
`src/services/auth/authErrors.js`; el contrato es idéntico en el mock y en
la implementación real (facade `src/services/auth/authService.js`).