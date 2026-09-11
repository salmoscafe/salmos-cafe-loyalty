# Salmos Café — Diseño visual de emails

Diseño aprobado de los 5 emails de Salmos Café. Este documento responde
una sola pregunta: **cómo deben verse y qué deben decir**. No es una
guía de implementación.

---

## Sistema visual compartido

Los cinco emails son la misma familia: mismo header, mismo cuerpo,
mismo tono, mismo footer. Solo cambian el título, el texto y —cuando
aplica— la caja especial (botón u OTP).

```
┌───────────────────────────────────────────┐
│                                             │
│                                             │
│              𝒮almos Café                   │   ← fondo navy (#1F3355)
│                                             │      wordmark en crema, centrado
│                                             │      mucho aire arriba y abajo
│                                             │
├───────────────────────────────────────────┤
│                                             │
│                                             │
│   Título del correo                        │   ← serif itálica, navy, grande
│                                             │      (el elemento con más presencia
│   Un párrafo breve, dos o tres líneas       │      después del header)
│   como máximo. Tono cercano, directo.       │   ← texto de cuerpo, gris oscuro cálido
│                                             │
│             ┌────────────────────┐         │
│             │  Texto del botón   │         │   ← botón navy, texto crema, centrado
│             └────────────────────┘         │      única acción visible del correo
│                                             │
│   Texto secundario pequeño y discreto,      │   ← opcional; siempre más chico
│   casi invisible hasta que se necesita.     │      y más claro que el cuerpo
│                                             │
│   ┌────────────────────────────────┐       │
│   │  Mensaje de seguridad, en una   │       │   ← caja fondo crema suave,
│   │  caja aparte y con tono tranquilo│      │      texto espresso, esquinas
│   └────────────────────────────────┘       │      redondeadas, sin ícono de alerta
│                                             │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│              Salmos Café                    │   ← wordmark pequeño, itálica,
│        Tu café, tus visitas,                │      espresso sobre crema clara
│           tus recompensas.                  │
│                                             │
│   Este correo se envió porque hubo una      │   ← una sola línea, gris, casi
│   acción en tu cuenta de Salmos Café.       │      ilegible a propósito
│                                             │
└───────────────────────────────────────────┘
```

**Paleta:** navy (#1F3355) para el header, el título y el botón · crema
(#E3D4C0 / #F5EEE2) para el fondo general y las cajas secundarias ·
espresso (#33211D) para texto sobre crema · un trazo dorado (#C9A24B)
reservado únicamente para enmarcar el código OTP — en ningún otro lugar.

**Jerarquía tipográfica** (de mayor a menor presencia):
1. Wordmark del header — la marca siempre entra primero.
2. Título del correo — serif itálica, es lo segundo que se lee.
3. Código OTP (solo en ese correo) — cuando existe, compite directo con el título en protagonismo.
4. Cuerpo de texto — sans serif, tono de conversación.
5. Botón — texto corto, en mayúscula tipográfica visual por peso, no por caja.
6. Texto secundario / seguridad — siempre lo más discreto de la pantalla.
7. Footer — presente pero silencioso.

**Distribución general:** todo centrado, una sola columna, mucho
espacio en blanco entre bloques. Nunca dos acciones al mismo nivel.
Nunca más de un botón por correo. La caja de seguridad, cuando existe,
va al final, después de la acción principal — nunca antes.

---

## 1. Confirmación de correo

**Asunto:** Confirma tu correo en Salmos Café
**Preheader:** Un paso más y tu tarjeta está lista.

```
┌───────────────────────────────────────────┐
│                                             │
│              𝒮almos Café                   │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│   Confirma tu correo                       │
│                                             │
│   Estás a un paso de activar tu cuenta      │
│   de Salmos Café. Confirma tu correo y      │
│   tu tarjeta digital quedará lista para     │
│   empezar a acumular visitas.               │
│                                             │
│         ┌─────────────────────┐            │
│         │  Confirmar mi correo │            │
│         └─────────────────────┘            │
│                                             │
│   ¿El botón no funciona? Copia y pega el   │
│   enlace en tu navegador.                   │
│                                             │
│   ┌─────────────────────────────────┐      │
│   │  Si tú no creaste esta cuenta,   │      │
│   │  ignora este correo — no se      │      │
│   │  activará nada sin tu             │      │
│   │  confirmación.                    │      │
│   └─────────────────────────────────┘      │
│                                             │
├───────────────────────────────────────────┤
│              Salmos Café                    │
│        Tu café, tus visitas,                │
│           tus recompensas.                  │
└───────────────────────────────────────────┘
```

---

## 2. Recuperación de contraseña

**Asunto:** Restablece tu contraseña de Salmos Café
**Preheader:** Elige una nueva contraseña para tu cuenta.

```
┌───────────────────────────────────────────┐
│                                             │
│              𝒮almos Café                   │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│   Restablece tu contraseña                 │
│                                             │
│   Recibimos una solicitud para cambiar      │
│   la contraseña de tu cuenta de Salmos      │
│   Café. Toca el botón para elegir una       │
│   nueva.                                    │
│                                             │
│         ┌─────────────────────┐            │
│         │ Restablecer contraseña│           │
│         └─────────────────────┘            │
│                                             │
│   ¿El botón no funciona? Copia y pega el   │
│   enlace en tu navegador.                   │
│                                             │
│   ┌─────────────────────────────────┐      │
│   │  Si tú no solicitaste este        │      │
│   │  cambio, ignora este correo —     │      │
│   │  tu contraseña actual seguirá     │      │
│   │  funcionando.                     │      │
│   └─────────────────────────────────┘      │
│                                             │
├───────────────────────────────────────────┤
│              Salmos Café                    │
│        Tu café, tus visitas,                │
│           tus recompensas.                  │
└───────────────────────────────────────────┘
```

---

## 3. Código OTP

**Asunto:** Tu código de acceso a Salmos Café
**Preheader:** Este código es personal — no lo compartas.

Este es el único correo donde el título cede el protagonismo: el
código es lo primero que el ojo encuentra al abrir, incluso antes de
terminar de leer la frase de contexto. Nada decorativo alrededor —
la caja del código y una sola línea antes, una sola línea después.

```
┌───────────────────────────────────────────┐
│                                             │
│              𝒮almos Café                   │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│   Tu código de acceso                      │
│                                             │
│   Usa este código para entrar a tu          │
│   cuenta de Salmos Café:                    │
│                                             │
│      ┌───────────────────────────┐         │
│      │                           │         │
│      │      8   4   1   2  9  6  │         │
│      │                           │         │
│      └───────────────────────────┘         │
│        (marco dorado, fondo crema,          │
│         cifras enormes y muy espaciadas)    │
│                                             │
│   Este código deja de funcionar después     │
│   de unos minutos. Si ya no lo necesitas,   │
│   puedes ignorarlo.                         │
│                                             │
│   ┌─────────────────────────────────┐      │
│   │  Nunca compartas este código con  │      │
│   │  nadie. Ningún miembro del equipo │      │
│   │  de Salmos te lo pedirá por        │      │
│   │  ningún medio.                     │      │
│   └─────────────────────────────────┘      │
│                                             │
├───────────────────────────────────────────┤
│              Salmos Café                    │
│        Tu café, tus visitas,                │
│           tus recompensas.                  │
└───────────────────────────────────────────┘
```

---

## 4. Cambio de correo

**Asunto:** Confirma tu nuevo correo en Salmos Café
**Preheader:** Confirma este cambio para seguir usando tu cuenta.

```
┌───────────────────────────────────────────┐
│                                             │
│              𝒮almos Café                   │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│   Confirma tu nuevo correo                 │
│                                             │
│   Solicitaste cambiar el correo de tu       │
│   cuenta de Salmos Café. Confirma esta      │
│   dirección para completar el cambio.       │
│                                             │
│         ┌─────────────────────┐            │
│         │ Confirmar nuevo correo│           │
│         └─────────────────────┘            │
│                                             │
│   ¿El botón no funciona? Copia y pega el   │
│   enlace en tu navegador.                   │
│                                             │
│   ┌─────────────────────────────────┐      │
│   │  Si tú no solicitaste este        │      │
│   │  cambio, ignora este correo —     │      │
│   │  tu cuenta seguirá con el         │      │
│   │  correo anterior.                 │      │
│   └─────────────────────────────────┘      │
│                                             │
├───────────────────────────────────────────┤
│              Salmos Café                    │
│        Tu café, tus visitas,                │
│           tus recompensas.                  │
└───────────────────────────────────────────┘
```

---

## 5. Bienvenida

**Asunto:** Bienvenido a Salmos Café
**Preheader:** Tu tarjeta digital ya está lista.

El único correo sin caja de seguridad — no hay nada que advertir,
solo algo que celebrar, con moderación. El cuerpo crece a dos
párrafos cortos en vez de uno (bienvenida + cómo funciona), pero
sigue habiendo un solo botón y ninguna promoción.

```
┌───────────────────────────────────────────┐
│                                             │
│              𝒮almos Café                   │
│                                             │
├───────────────────────────────────────────┤
│                                             │
│   Bienvenido a Salmos Café                 │
│                                             │
│   Tu cuenta ya está lista. A partir de      │
│   ahora, cada visita que hagas en           │
│   cualquiera de nuestras sucursales suma    │
│   en tu tarjeta digital.                    │
│                                             │
│   Acumula 8 visitas y obtén una bebida o    │
│   consumo equivalente hasta $150 MXN.       │
│   Muestra tu código QR en caja — nosotros   │
│   nos encargamos del resto.                 │
│                                             │
│         ┌─────────────────────┐            │
│         │   Abrir mi tarjeta   │            │
│         └─────────────────────┘            │
│                                             │
├───────────────────────────────────────────┤
│              Salmos Café                    │
│        Tu café, tus visitas,                │
│           tus recompensas.                  │
└───────────────────────────────────────────┘
```

---

## Lo que hace que los cinco se sientan Salmos

- El wordmark en itálica script nunca cambia de lugar: siempre solo,
  centrado, sobre navy, con espacio alrededor — igual que en la
  tarjeta y en la app.
- El título de cada correo usa la misma serif itálica que el saludo
  de la app ("Hola, Javier.") — es la voz visual de la marca, no una
  fuente de sistema genérica.
- Un solo acento dorado por correo, nunca más: el marco del OTP. En
  el resto, el dorado no aparece — así conserva su peso cuando sí lo
  hace.
- El botón es siempre navy con texto crema — el mismo par de colores
  que la tarjeta digital y el botón "Mostrar mi QR" de la app.
- El tono habla como Salmos le hablaría a alguien que ya conoce:
  directo, cálido, sin "estimado usuario", sin signos de exclamación
  de marketing, sin urgencia artificial.