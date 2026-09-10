# Salmos Café — Identidad y Registro (UX/UI, sin implementación)

Diseño de la experiencia de Login/Registro de cliente. No toca código —
`LoginScreen.jsx` y `authService.js` actuales quedan intactos hasta la
siguiente etapa. Este documento es el contrato que seguirá esa
implementación.

---

## 1. Flujo completo

Idea central: **una sola pantalla que cambia de estado**, no una serie de
pantallas separadas para cada caso. El usuario nunca declara "soy nuevo"
o "ya tengo cuenta" — Salmos lo determina.

```
                         ┌─────────────────────┐
                         │   ESTADO: identify    │
                         │  (correo o teléfono   │
                         │   + Continuar con     │
                         │   Google)             │
                         └──────────┬───────────┘
                                    │
              ┌─────────────────────┼─────────────────────┐
              │ envía correo/tel     │                     │ toca Google
              ▼                     │                      ▼
     ┌──────────────────┐           │            ┌────────────────────┐
     │ ESTADO: checking  │           │            │  Supabase OAuth     │
     │ (loading breve,   │           │            │  (popup/redirect,   │
     │  dentro del botón)│           │            │  fuera de la app)   │
     └─────────┬─────────┘           │            └──────────┬──────────┘
               │                     │                       │
     lookup por identidad ───────────┘             vuelve con identidad
               │                                    verificada de Google
     ┌─────────┴─────────┐                                   │
     │                   │                         ┌─────────┴─────────┐
     ▼                   ▼                         │                   │
┌──────────┐     ┌───────────────┐          identidad existe    identidad nueva
│ EXISTENTE │     │     NUEVO      │                │                   │
│           │     │                │                ▼                   ▼
│ "Ya tienes│     │ "Vamos a crear │        ┌──────────────┐   ┌──────────────────┐
│ una cuenta│     │  tu cuenta"    │        │ sesión activa │   │ ESTADO:           │
│ en Salmos"│     │                │        │ → Home         │   │ google_confirm     │
│           │     │ Nombre (+dato  │        └──────────────┘   │ (confirmar nombre, │
│ ESTADO:   │     │ secundario     │                            │  teléfono opcional)│
│ existing_ │     │ opcional)      │                            └─────────┬──────────┘
│ verify    │     │                │                                      │
│ (código)  │     │ ESTADO:        │                                      │
└─────┬─────┘     │ new_details    │                                      │
      │           └───────┬────────┘                                     │
      │                   │                                              │
      │           ┌───────┴────────┐                                     │
      │           │ ESTADO:         │                                     │
      │           │ new_verify      │                                     │
      │           │ (mismo código   │                                     │
      │           │  que existing)  │                                     │
      │           └───────┬────────┘                                     │
      │                   │                                              │
      └─────────┬─────────┘                                              │
                │                                                         │
                ▼                                                         │
      ┌───────────────────┐                                              │
      │ ESTADO:             │◄─────────────────────────────────────────────┘
      │ provisioning         │
      │ "Estamos preparando  │
      │ tu tarjeta Salmos"   │
      └──────────┬──────────┘
                 │
                 ▼
             Home (sesión activa)
```

**Errores** no son pantallas nuevas: son un banner/inline dentro del
estado activo (`identify`, `existing_verify`, `new_details`,
`new_verify`, `google_confirm` o `provisioning`), más el caso especial de
`session_expired`, que reabre `identify` con contexto. Ver §4.

---

## 2. Pantallas necesarias

Es **una sola pantalla real** (`AuthScreen`, evolución de `LoginScreen`)
con seis estados internos. Se documenta cada estado como si fuera una
pantalla porque UX/contenido cambia por completo, pero en código es un
solo componente con una máquina de estados — así se cumple la
recomendación de §5 de minimizar pantallas.

### 2.1 `identify` — Punto de entrada

- **Propósito:** capturar un identificador (correo o teléfono) o iniciar
  Google, sin saber todavía si la cuenta existe.
- **Campos:** un input que cambia de tipo con un selector pequeño
  "Correo / Teléfono" (correo por default). Para teléfono, el input
  incluye selector de país (+52 por default, dado el mercado de Salmos).
- **Botones:** `Continuar` (primario, deshabilitado hasta que el campo
  sea válido) · `Continuar con Google` (secundario) · enlace pequeño
  para alternar Correo/Teléfono si no se usa el selector.
- **Mensajes:** ninguno en reposo. "Bienvenido a Salmos Café" como
  título; subtítulo breve ("Inicia sesión o crea tu cuenta en un
  momento").
- **Estados:** reposo → `checking` (spinner dentro de `Continuar`,
  botón deshabilitado, sin bloquear el resto de la UI) → error inline
  si el formato es inválido o si falla la verificación (ver §4).
- **Siguiente paso:** según el resultado del lookup, transiciona a
  `existing_verify`, `new_details`, o —vía Google— directo a sesión
  activa o a `google_confirm`.

### 2.2 `existing_verify` — Usuario con cuenta

- **Propósito:** confirmar que quien tiene el correo/teléfono es
  realmente el dueño, mediante un código de un solo uso (ver
  justificación del método en §5).
- **Campos:** input de 6 dígitos (`inputMode="numeric"`, auto-avance).
- **Botones:** `Confirmar` (primario) · `Reenviar código` (secundario,
  con cuenta regresiva de 30s) · `Usar otro método` (texto, regresa a
  `identify` limpio).
- **Mensajes:** "Ya tienes una cuenta en Salmos." + "Enviamos un código
  a j\*\*\*@example.com" (correo/teléfono enmascarado, nunca completo).
- **Estados:** `sending_code` (breve, al entrar) → reposo → `verifying`
  (al confirmar) → error inline (código incorrecto/expirado, ver §4).
- **Siguiente paso:** código correcto → sesión activa → Home
  directamente (usuario existente no necesita `provisioning`).

### 2.3 `new_details` — Usuario nuevo, datos mínimos

- **Propósito:** recolectar solo lo indispensable antes de verificar.
- **Campos:** el identificador ya capturado se muestra como texto fijo
  (no editable aquí, ej. "Creando cuenta para **javier@example.com**").
  `Nombre` (requerido). El dato de contacto secundario (teléfono si
  entró por correo, o viceversa) se muestra como **opcional**, con
  copy tipo "Teléfono (opcional) — para avisos importantes de tu
  tarjeta".
- **Botones:** `Continuar` (primario, requiere solo Nombre).
- **Mensajes:** "Vamos a crear tu cuenta."
- **Estados:** reposo → error inline si el dato secundario ya
  pertenece a otra cuenta (caso 7/8, ver §4) → `checking`.
- **Siguiente paso:** → `new_verify` (mismo componente de código que
  `existing_verify`, reutilizado).

### 2.4 `new_verify` — Verificación de usuario nuevo

Mismo componente visual que `existing_verify`; cambia solo el copy de
cabecera ("Confirma tu correo/teléfono para terminar") y el destino al
completarse: → `provisioning` en vez de sesión directa, porque todavía
falta crear el perfil Salmos.

### 2.5 `google_confirm` — Confirmación ligera (solo Google + nuevo)

- **Propósito:** Google ya entrega nombre y correo verificados: no hace
  falta pedir nada obligatorio. Esta pantalla es una confirmación, no
  un formulario.
- **Campos:** nombre pre-llenado y editable (por si el nombre de Google
  no es el que quiere usar en Salmos). Teléfono opcional.
- **Botones:** `Confirmar y crear mi cuenta` (primario).
- **Mensajes:** "Vamos a crear tu cuenta con estos datos de Google."
- **Siguiente paso:** → `provisioning` (no requiere código: Google ya
  verificó la identidad).

### 2.6 `provisioning` — Transición final

- **Propósito:** cubrir el trabajo detrás de escena (crear identidad en
  Supabase, crear el customer/card de Salmos, y — más adelante —
  buscar/crear el Customer en Loyverse) sin mostrar nada técnico.
- **Campos/botones:** ninguno. Pantalla completa, sin acción del
  usuario.
- **Mensajes:** "Estamos preparando tu tarjeta Salmos." con un
  subtítulo breve ("Esto toma solo un momento."). Nunca menciona
  Supabase, Loyverse, API ni sincronización.
- **Estados:** `working` (spinner) → éxito (avanza solo, sin
  interacción) → error inline con `Reintentar` si algo falla (ver §4).
- **Siguiente paso:** Home, con sesión ya activa.

---

## 3. Qué reutilizar del proyecto actual

| Elemento actual | Decisión |
|---|---|
| `LoginScreen.jsx` | **Evoluciona**, no se descarta: su estructura (Wordmark + título + form + `Field`/`PrimaryButton`) es la base visual de `AuthScreen`. Cambia de "un formulario" a "una máquina de estados dentro del mismo layout". |
| `authService.getSession/signOutClient` | **Se mantienen igual** — la sesión sigue siendo `{ customer } \| null`; nada de esto cambia con el nuevo flujo. |
| `authService.signInClient({ email })` | **Se reemplaza** por el contrato nuevo de §5 (`identifyAccount`, `requestCode`, `verifyCode`, `signInWithGoogle`, `completeRegistration`) — ver nota técnica al final. |
| `authIdentities` (mock) | **Se mantiene el concepto** (customer_id ↔ provider ↔ provider_id) — es exactamente el modelo que evita cuentas duplicadas y ya está en `PLAN.md`. |
| `components/ui.jsx` (`Field`, `PrimaryButton`, `SecondaryButton`) | **Se reutilizan tal cual** para los inputs de código, nombre y teléfono. |
| `BrandMark`, `.sc-login*` en `styles.css` | **Se reutilizan y se extienden** (nuevas clases para el selector Correo/Teléfono, el input de código, y el estado `provisioning` de pantalla completa) — sin tocar la identidad visual existente. |
| Home / Rewards / Activity / Profile / QR / BottomNav | **Sin cambios.** Esta tarea termina exactamente donde hoy termina `LoginScreen`: al llamar `onSignedIn()`. |
| Flujo de Staff/Admin | **Sin cambios** — esta tarea es exclusivamente el login de cliente. |

---

## 4. Estados de autenticación

Taxonomía completa, mapeada a los 15 casos que pediste cubrir.

| Estado | Cuándo ocurre | Qué ve el usuario | Caso(s) cubierto(s) |
|---|---|---|---|
| **loading** | Cualquier llamada en curso (`checking`, `sending_code`, `verifying`, `working`) | Spinner **dentro del control activo** (botón o pantalla), nunca un overlay bloqueante genérico | — |
| **existing_account** | El lookup encuentra una identidad con ese correo/teléfono | "Ya tienes una cuenta en Salmos." → pasa a verificación | 1, 2, 3 |
| **new_account** | El lookup no encuentra nada | "Vamos a crear tu cuenta." → pide nombre | 4, 5, 6 |
| **verification** | Se envió un código (existente o nuevo) | Input de 6 dígitos + "Código enviado a…" + reenviar | 1, 2, 4, 5 |
| **conflict** | El dato secundario en `new_details` ya pertenece a otra cuenta | Banner inline: "Este teléfono ya está en otra cuenta de Salmos. ¿Es tuya? [Iniciar sesión con ese teléfono] · [Usar otro]" — nunca fusiona cuentas en silencio | 7, 8 |
| **cancelled** | El usuario cierra/navega fuera durante `new_details`, `new_verify` o `google_confirm` | No se crea ninguna cuenta parcial (nada se persiste hasta `provisioning`); al volver, arranca limpio en `identify` | 9, 14 |
| **error_transient** | Falla de red/Supabase temporal | Banner inline "Algo salió mal. Intenta de nuevo." + botón `Reintentar`, el dato ya escrito no se pierde | 10 |
| **error_code_invalid** | Código de 6 dígitos incorrecto | Input se marca en rojo, mensaje "Ese código no es correcto.", intentos limitados antes de forzar reenvío | 11 |
| **error_code_expired** | Código vencido (ventana típica 5–10 min) | "Este código venció." + botón `Enviar uno nuevo` reemplaza al de confirmar | 12 |
| **error_password** *(solo si se habilita contraseña como alternativa a código — ver nota en §5)* | Contraseña incorrecta | "Esa contraseña no es correcta." + enlace "¿La olvidaste?" | 13 |
| **session_expired** | El usuario vuelve con un token vencido | `AuthScreen` se reabre directamente en `identify`, con un mensaje sutil arriba: "Tu sesión terminó, vuelve a entrar." — nunca un error agresivo | 15 |
| **success** | Sesión creada/confirmada | Transición inmediata a Home (usuario existente) o a `provisioning` → Home (usuario nuevo) | — |

---

## 5. Recomendación final

**Una pantalla, seis estados**, como se describe arriba — no seis
pantallas. Esto ya minimiza la navegación: el usuario nunca "avanza" en
un wizard con flechas de retroceso, solo ve el contenido cambiar en el
mismo lugar.

**Método de verificación recomendado: código de un solo uso (OTP) por
correo o SMS, no contraseña.** Encaja mejor con "premium pero sencillo"
(nadie recuerda una contraseña para su tarjeta de café), evita pantallas
de "recuperar contraseña", y Supabase lo soporta de forma nativa tanto
para email como para teléfono con la misma UI de código. Dejé definido
el estado `error_password` en §4 por si el equipo decide ofrecer
contraseña como alternativa más adelante, pero no es el default que
recomiendo.

**Google se resuelve solo, sin pantalla propia** salvo el caso raro de
usuario nuevo (`google_confirm`), y ahí es una confirmación de un
campo, no un formulario.

### Nota técnica para quien implemente Supabase (no es parte de esta entrega)

Un diseño ingenuo de "primero pregunto si el correo existe, luego
decido qué mostrar" **no se puede implementar tal cual con Supabase
Auth**: por diseño, Supabase no expone un endpoint que confirme "este
correo ya tiene cuenta" (es una protección contra enumeración de
usuarios). En la práctica, `identifyAccount` del diagrama de arriba se
implementará enviando el código primero (`signInWithOtp` con
`shouldCreateUser: false` para probar existencia sin crear nada) y
usando el resultado de esa llamada para decidir `existing_verify` vs.
`new_details` — el usuario no nota la diferencia, pero la secuencia
técnica interna no es un "lookup" separado como sugiere el diagrama
conceptual. Lo dejo anotado para que el siguiente agente no lo
descubra a medio camino.

### Contrato de servicio esperado (para diseñar, no para programar ahora)

```text
authService.identifyAccount({ email? , phone? })
  → { status: "existing" | "new", maskedContact }

authService.requestCode({ email?, phone?, forNewAccount: boolean })
authService.verifyCode({ code })
  → { ok, session } | { ok:false, error: "invalid" | "expired" }

authService.signInWithGoogle()
  → { status: "existing"|"new", session? , googleProfile? }

authService.completeRegistration({ name, secondaryContact? , googleProfile? })
  → dispara "provisioning": crea auth identity + customer + card
  → { ok, session } | { ok:false, error }
```

Esto reemplaza a `signInClient` tal como existe hoy; `getSession` y
`signOutClient` no cambian.
