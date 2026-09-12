# Estructura de Datos --- Salmos Café

**Proyecto:** App Salmos Café\
**Documento:** Arquitectura y estructura de datos\
**Versión:** 1.0\
**Estado:** Diseño inicial --- previo a implementación completa

------------------------------------------------------------------------

## 1. Objetivo

Este documento define cómo se organizarán los datos de la aplicación de
lealtad de **Salmos Café** y cómo se relacionarán:

-   La cuenta del cliente.
-   El perfil del cliente en Salmos.
-   El cliente correspondiente en Loyverse.
-   Las ventas/recibos de Loyverse.
-   Las visitas de la tarjeta de lealtad.
-   Los ciclos de 8 visitas.
-   Las recompensas.
-   Las cancelaciones y reembolsos.
-   La auditoría de operaciones.

La intención es que **Loyverse siga siendo el sistema que registra las
ventas del POS**, mientras que **Supabase sea el sistema que administra
la cuenta y la lógica propia de Salmos**.

------------------------------------------------------------------------

# 2. Principio general de arquitectura

La aplicación tendrá tres capas principales:

``` text
┌──────────────────────┐
│      APP SALMOS      │
│   React / Vercel     │
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│       SUPABASE       │
│                      │
│ Auth                 │
│ Customers            │
│ Loyalty              │
│ Rewards              │
│ Audit                 │
│ Edge Functions       │
└──────────┬───────────┘
           │
           │ conexión segura
           ▼
┌──────────────────────┐
│       LOYVERSE       │
│                      │
│ Customers            │
│ Receipts             │
│ Stores               │
│ Employees            │
│ Items                │
└──────────────────────┘
```

### Responsabilidad de cada sistema

  -----------------------------------------------------------------------
  Sistema                             Responsabilidad
  ----------------------------------- -----------------------------------
  App Salmos                          Interfaz que utiliza el cliente,
                                      staff y administración

  Supabase Auth                       Cuenta, inicio de sesión y
                                      contraseña

  Supabase Database                   Perfil Salmos, visitas, ciclos,
                                      recompensas, auditoría

  Supabase Edge Functions             Comunicación segura con Loyverse

  Loyverse                            POS, clientes POS, tickets/recibos
                                      y catálogo

  Vercel                              Hosting de la aplicación web
  -----------------------------------------------------------------------

**Regla importante:** el navegador no debe contener ni utilizar
directamente el token privado de Loyverse.

------------------------------------------------------------------------

# 3. Identidad del cliente

Un cliente puede existir en dos sistemas:

``` text
Supabase Auth
     │
     │ auth_user_id
     ▼
Salmos customers
     │
     │ loyverse_customer_id
     ▼
Loyverse Customer
```

Esto significa que **no son tres clientes diferentes**.

Es el mismo cliente representado en distintos sistemas.

## 3.1 Supabase Auth

Supabase Auth será responsable de:

-   Crear la cuenta.
-   Iniciar sesión.
-   Cerrar sesión.
-   Administrar la contraseña.
-   Recuperar la contraseña.
-   Mantener la sesión.

La contraseña **no se almacena en nuestra tabla `customers`**.

------------------------------------------------------------------------

# 4. Tabla `customers`

Esta tabla representa al cliente dentro del ecosistema Salmos.

### Campos principales propuestos

  Campo                    Propósito
  ------------------------ ----------------------------------------
  `id`                     ID interno del cliente Salmos
  `auth_user_id`           Relación con Supabase Auth
  `name`                   Nombre del cliente
  `email`                  Correo
  `phone`                  Teléfono
  `customer_code`          Código estable del cliente Salmos
  `loyverse_customer_id`   ID del cliente equivalente en Loyverse
  `loyverse_sync_status`   Estado de sincronización
  `loyverse_sync_claim`    Token UUID del claim de sincronización (0006)
  `loyverse_sync_claim_at` Instante del claim; expiración a los 10 min (0006)
  `created_at`             Fecha de creación
  `updated_at`             Última actualización

### Relación

``` text
auth.users.id
       │
       ▼
customers.auth_user_id
       │
       ▼
customers.loyverse_customer_id
       │
       ▼
loyverse customer.id
```

### Regla

`loyverse_customer_id` debe ser único.

Esto evita que dos cuentas Salmos terminen vinculadas accidentalmente al
mismo cliente de Loyverse.

**Claim de sincronización (migración 0006):** `loyverse_sync_claim` +
`loyverse_sync_claim_at` implementan un **bloqueo por fila** para que dos
invocaciones concurrentes de la Edge Function `loyverse-customers` del mismo
perfil no puedan cruzar la búsqueda+creación y duplicar clientes en Loyverse.
Lo toma la Edge con un UPDATE condicional atómico; expira a los 10 minutos y se
libera solo con el token del dueño.

------------------------------------------------------------------------

# 5. Cliente en Loyverse

Loyverse tiene su propio registro de cliente.

Por ejemplo, en las pruebas realizadas existe un cliente con:

-   Nombre: Javier Ibrahim
-   Email: `javiercastro9912@gmail.com`
-   Teléfono: `6642676820`
-   ID Loyverse: `f1f60b21-d57e-4b11-ac0d-a76341df841a`

El ID de Loyverse es el dato importante para realizar la relación.

No debemos depender únicamente del nombre.

------------------------------------------------------------------------

# 6. Recibos de Loyverse

Los recibos son la fuente de información de las ventas realizadas en el
POS.

Un recibo puede contener:

-   `receipt_number`
-   `receipt_type`
-   `refund_for`
-   `receipt_date`
-   `cancelled_at`
-   `total_money`
-   `customer_id`
-   `employee_id`
-   `store_id`
-   `pos_device_id`
-   `line_items`
-   `payments`

Ejemplo conceptual:

``` text
Loyverse Receipt
│
├── receipt_number: 1-0784
├── receipt_type: SALE
├── total_money: 180
├── customer_id: f1f60b21...
├── employee_id: ...
├── store_id: ...
└── line_items: [...]
```

En las pruebas realizadas se comprobó que un recibo puede tener
`customer_id` asociado al cliente.

Cuando `customer_id` está presente:

``` text
Receipt.customer_id
        │
        ▼
Loyverse Customer.id
        │
        ▼
Salmos customers.loyverse_customer_id
```

Esto permite identificar a qué cuenta Salmos pertenece una venta.

------------------------------------------------------------------------

# 7. Importante: `customer_id` puede ser NULL

No todos los tickets tienen cliente asociado.

En los datos probados existen numerosos recibos con:

``` text
customer_id: null
```

Por lo tanto, **un ticket sin cliente no puede asignarse automáticamente
a una cuenta Salmos solamente por el ticket**.

Esto debe considerarse en el diseño.

La aplicación no debe inventar una relación entre una venta y un
cliente.

------------------------------------------------------------------------

# 8. Visitas de Salmos

Las visitas de Salmos **no deben depender de `total_visits` de
Loyverse**.

Loyverse registra información propia del cliente, pero las reglas de la
tarjeta de Salmos son diferentes.

Por eso tendremos una estructura propia:

``` text
loyverse receipt
       │
       ▼
loyalty visit
```

Una visita representa la decisión de Salmos:

> "Este ticket cuenta como una visita válida para el programa de
> lealtad."

------------------------------------------------------------------------

# 9. Tabla `loyalty_visits`

Esta tabla debe guardar cada visita válida y su origen.

### Campos propuestos

  Campo              Propósito
  ------------------ -------------------------------------------------------
  `id`               ID interno de la visita
  `customer_id`      Cliente Salmos
  `cycle_id`         Ciclo al que pertenece
  `receipt_number`   Ticket de Loyverse que originó la visita
  `receipt_id`       ID interno/identificador de recibo si está disponible
  `visit_date`       Fecha de la visita
  `amount`           Monto considerado
  `store_id`         Sucursal donde ocurrió
  `status`           Estado de la visita
  `created_at`       Fecha de registro

### Regla fundamental

Un mismo recibo no debe generar dos visitas.

Debe existir una protección de idempotencia, por ejemplo mediante una
restricción única sobre la combinación adecuada de cliente + recibo o,
preferentemente, sobre el identificador estable del recibo cuando esté
disponible.

------------------------------------------------------------------------

# 10. Reglas actuales de una visita

Según las reglas definidas para Salmos:

1.  Compra mínima: **\$50 MXN**.
2.  Una compra genera como máximo **1 visita**.
3.  Un cliente puede obtener como máximo **1 visita por día**.
4.  La visita debe estar asociada a una venta válida.
5.  Una venta cancelada no debe conservar una visita válida.
6.  Una venta reembolsada/cancelada debe poder provocar la reversión
    correspondiente.
7.  Una misma venta nunca debe procesarse dos veces.

Ejemplo:

``` text
Compra = $50
→ 1 visita

Compra = $100
→ 1 visita

Compra = $500
→ 1 visita
```

El monto no multiplica las visitas.

------------------------------------------------------------------------

# 11. Ciclos de lealtad

La tarjeta de Salmos funciona mediante ciclos.

``` text
Ciclo 1
1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
                                      │
                                      ▼
                                  RECOMPENSA
                                      │
                                      ▼
                                 Nuevo ciclo
```

Por ello conviene separar:

-   La visita individual.
-   El ciclo al que pertenece.
-   La recompensa generada.

------------------------------------------------------------------------

# 12. Tabla `loyalty_cycles`

### Campos propuestos

  Campo            Propósito
  ---------------- --------------------------------
  `id`             ID del ciclo
  `customer_id`    Cliente
  `cycle_number`   Número consecutivo del ciclo
  `started_at`     Inicio del ciclo
  `completed_at`   Fecha en que llegó a 8 visitas
  `expires_at`     Fecha de expiración si aplica
  `status`         Estado del ciclo
  `created_at`     Fecha de creación

### Estados posibles

Ejemplo:

``` text
ACTIVE
COMPLETED
EXPIRED
CANCELLED
```

No es necesario implementar todos inmediatamente; la lista final debe
definirse junto con las reglas de negocio.

------------------------------------------------------------------------

# 13. Recompensas

Cuando el cliente llega a la visita número 8 se genera una recompensa.

Regla actual:

-   Se obtiene en la **8.ª visita**.
-   Puede utilizarse para **una bebida**.
-   Alternativamente, representa hasta **\$150 MXN de consumo**, según
    las reglas de Salmos.
-   Expira cada 3 meses.
-   Una recompensa utilizada no puede volver a utilizarse.

------------------------------------------------------------------------

# 14. Tabla `rewards`

### Campos propuestos

  Campo                  Propósito
  ---------------------- ---------------------------
  `id`                   ID de recompensa
  `customer_id`          Cliente
  `cycle_id`             Ciclo que la generó
  `earned_at`            Fecha en que fue obtenida
  `expires_at`           Fecha de expiración
  `status`               Estado
  `redeemed_at`          Fecha de uso
  `redemption_receipt`   Ticket asociado al canje
  `redemption_amount`    Valor utilizado
  `created_at`           Fecha de creación

### Estados conceptuales

``` text
AVAILABLE
REDEEMED
EXPIRED
CANCELLED
```

------------------------------------------------------------------------

# 15. Expiración

La recompensa tiene una vigencia de 3 meses.

Ejemplo:

``` text
Recompensa obtenida
10 septiembre 2026

Expira
10 diciembre 2026
```

La fecha exacta debe calcularse de forma consistente desde el backend.

No debe depender del reloj del navegador.

------------------------------------------------------------------------

# 16. Cancelaciones y reembolsos

Loyverse permite identificar situaciones como:

``` text
receipt_type: REFUND
refund_for: 1-0809
```

También puede existir:

``` text
cancelled_at
```

Por lo tanto, el sistema Salmos debe poder relacionar:

``` text
Venta original
     │
     ▼
Visita Salmos
     │
     ▼
Cancelación / refund
     │
     ▼
Reversión de visita
```

### Caso especial

Si una cancelación afecta la visita número 8:

``` text
7 visitas
+
8ª visita
=
recompensa generada

↓ cancelan la venta

recompensa deja de ser válida
y el ciclo vuelve a quedar abierto
```

Esto ya fue contemplado en las pruebas de la lógica actual.

------------------------------------------------------------------------

# 17. Historial

Los ciclos anteriores no deben eliminarse cuando comienza un ciclo
nuevo.

Ejemplo:

``` text
Cliente
│
├── Ciclo 1 → completado
│   ├── 8 visitas
│   └── recompensa
│
├── Ciclo 2 → activo
│   ├── 3 visitas
│   └── ...
│
└── Ciclo 3 → futuro
```

Esto permite mostrar posteriormente:

-   visitas actuales;
-   recompensas;
-   ciclos anteriores;
-   historial de actividad.

------------------------------------------------------------------------

# 18. Auditoría

Las operaciones importantes deben quedar registradas.

La aplicación ya contempla una tabla de auditoría conceptual:

``` text
audit_logs
```

Debe permitir conocer:

-   quién realizó una acción;
-   qué acción realizó;
-   cuándo ocurrió;
-   sobre qué entidad;
-   y, cuando sea necesario, qué cambió.

Ejemplos:

``` text
CLIENTE_LOGIN
CUSTOMER_CREATED
LOYVERSE_CUSTOMER_LINKED
VISIT_CREATED
VISIT_REVERSED
REWARD_EARNED
REWARD_REDEEMED
REWARD_EXPIRED
SALE_SYNCED
```

La lista final de acciones se definirá durante la implementación.

------------------------------------------------------------------------

# 19. Sucursales

Los recibos de Loyverse contienen:

``` text
store_id
```

Actualmente las pruebas muestran una tienda de Salmos en Loyverse.

La estructura debe permitir múltiples sucursales aunque actualmente
exista una sola.

No debemos diseñar la base de datos suponiendo que Salmos siempre tendrá
una única sucursal.

Por ejemplo:

``` text
Receipt
   │
   └── store_id
          │
          ▼
     Salmos Store
```

La implementación de una tabla propia `stores` puede dejarse para una
fase posterior si no es necesaria todavía.

------------------------------------------------------------------------

# 20. Empleados

Los recibos también contienen:

``` text
employee_id
```

Esto permite saber qué empleado registró la venta en Loyverse.

Actualmente no es necesario copiar todos los empleados de Loyverse a
Supabase.

Si posteriormente Salmos necesita cuentas para Staff, se podrá crear una
relación explícita:

``` text
Supabase Staff User
        │
        ▼
Loyverse Employee
```

Esto debe diseñarse por separado de la cuenta del cliente.

------------------------------------------------------------------------

# 21. Productos

Los recibos contienen los productos vendidos dentro de `line_items`.

Los datos de Items de Loyverse también proporcionan:

-   `item_id`
-   `variant_id`
-   `sku`
-   nombre
-   precio
-   tienda
-   disponibilidad

Es importante **no identificar productos únicamente por nombre**, porque
Loyverse puede tener productos con nombres iguales pero IDs o variantes
diferentes.

Para futuras funciones de catálogo, promociones o recompensas
específicas se deben utilizar:

``` text
item_id
variant_id
sku
```

como identificadores técnicos.

------------------------------------------------------------------------

# 22. Flujo completo de una venta

El flujo esperado es:

``` text
                    LOYVERSE
                       │
                       │ nueva venta
                       ▼
                 Receipt
                       │
                       │ customer_id
                       ▼
              Cliente Loyverse
                       │
                       │ loyverse_customer_id
                       ▼
                 Cliente Salmos
                       │
                       ▼
              Motor de lealtad
                       │
             ┌─────────┴─────────┐
             │                   │
       ¿Monto >= $50?      ¿Ya visitó hoy?
             │                   │
             └─────────┬─────────┘
                       ▼
                 Visita válida
                       │
                       ▼
                Loyalty Cycle
                       │
                  ¿Es la #8?
                       │
                 ┌─────┴─────┐
                NO           SÍ
                 │            │
                 ▼            ▼
            Continúa       Reward
            el ciclo       disponible
```

------------------------------------------------------------------------

# 23. Seguridad

La comunicación con Loyverse debe pasar por el backend.

### Incorrecto

``` text
Navegador
   │
   └── LOYVERSE_ACCESS_TOKEN
             │
             ▼
        Loyverse API
```

### Correcto

``` text
Navegador
   │
   ▼
Supabase Edge Function
   │
   │ token privado
   ▼
Loyverse API
```

El token de Loyverse nunca debe enviarse al navegador ni guardarse en
variables `VITE_*`.

------------------------------------------------------------------------

# 24. Idempotencia

Este es uno de los puntos más importantes del sistema.

Si el mismo recibo se consulta dos veces:

``` text
Consulta 1
Receipt 1-0784
→ +1 visita

Consulta 2
Receipt 1-0784
→ NO +1 visita
```

El sistema debe reconocer que el recibo ya fue procesado.

Esto evita errores como:

``` text
1 ticket
→ 2 visitas
→ 3 visitas
→ 4 visitas
```

La base de datos debe ayudar a garantizar esta regla mediante
restricciones únicas y transacciones apropiadas.

------------------------------------------------------------------------

# 25. Fuente de verdad

Cada tipo de información debe tener un propietario claro.

  Información                   Fuente de verdad
  ----------------------------- ------------------
  Cuenta / contraseña           Supabase Auth
  Perfil Salmos                 Supabase
  Relación con Loyverse         Supabase
  Cliente POS                   Loyverse
  Venta                         Loyverse
  Productos vendidos            Loyverse
  Sucursal de la venta          Loyverse
  Empleado que registró venta   Loyverse
  Visita Salmos                 Supabase
  Ciclo de lealtad              Supabase
  Recompensa                    Supabase
  Historial de recompensas      Supabase
  Auditoría                     Supabase

------------------------------------------------------------------------

# 26. Modelo relacional simplificado

``` text
auth.users
    │
    │ 1:1
    ▼
customers
    │
    ├───────────────┐
    │               │
    │               ▼
    │        loyalty_cycles
    │               │
    │               ├────────── loyalty_visits
    │               │
    │               └────────── rewards
    │
    └── loyverse_customer_id
                │
                ▼
        Loyverse Customers
                │
                ▲
                │ customer_id
                │
        Loyverse Receipts
```

------------------------------------------------------------------------

# 27. Tablas iniciales recomendadas

La primera versión de la base de datos debería concentrarse en estas
tablas:

``` text
Supabase Auth
     │
     └── customers

customers
     │
     ├── loyalty_cycles
     │       │
     │       ├── loyalty_visits
     │       └── rewards
     │
     └── customer_sync_events

audit_logs
```

En la base real estas tablas se crean con las migraciones
`supabase/migrations/0001_customers.sql` (customers + customer_sync_events
+ RLS), `0002_loyalty_schema.sql` (ciclos/visitas/recompensas/auditoría +
RLS) y `0003_auth_alias_rpc.sql` (resolución de login por teléfono).

### `customer_sync_events`

Esta tabla ya forma parte de la arquitectura actual y sirve para
registrar eventos de sincronización entre Salmos y Loyverse.

No debe confundirse con `audit_logs`:

-   `customer_sync_events` → sincronización técnica.
-   `audit_logs` → auditoría de acciones del sistema/usuarios.

------------------------------------------------------------------------

# 28. Lo que NO debemos hacer

### No guardar la contraseña en `customers`

Supabase Auth la administra.

### No usar `total_visits` de Loyverse como tarjeta Salmos

Las reglas de Salmos son propias.

### No sumar visitas desde el frontend

El frontend solamente muestra información.

### No llamar directamente a Loyverse desde el navegador

Debe utilizarse una Edge Function.

### No confiar solamente en el nombre del cliente

Debe utilizarse el ID de Loyverse.

### No asumir que todos los tickets tienen cliente

`customer_id` puede ser `null`.

### No usar el monto para generar múltiples visitas

Una compra válida genera máximo una visita.

### No borrar ciclos anteriores

El historial debe conservarse.

### No procesar dos veces el mismo ticket

Debe existir idempotencia.

------------------------------------------------------------------------

# 29. Flujo de registro de cliente

El flujo conceptual será:

``` text
Usuario
  │
  ▼
Crear cuenta
  │
  ▼
Supabase Auth
  │
  ▼
Crear customers
  │
  ▼
Buscar cliente en Loyverse
  │
  ├── Encontrado
  │      │
  │      ▼
  │   Vincular ID
  │
  └── No encontrado
         │
         ▼
     Crear cliente
         │
         ▼
     Guardar ID
```

El criterio de búsqueda debe priorizar identificadores confiables como
email y teléfono normalizado, evitando crear duplicados.

------------------------------------------------------------------------

# 30. Flujo de inicio de sesión

El login normal no necesita consultar Loyverse.

``` text
Usuario
  │
  ▼
Email / teléfono + contraseña
  │
  ▼
Supabase Auth
  │
  ▼
customers
  │
  ▼
App Salmos
```

Loyverse solamente participa cuando necesitamos sincronizar información
relacionada con el POS.

### Login por teléfono (alias → email)

El navegador no puede leer filas de `customers` ajenas (RLS), así que para
entrar con teléfono se resuelve el correo de la cuenta mediante el RPC
seguro `resolve_email_for_login` (migración `0003`, `SECURITY DEFINER`,
`search_path` fijo, grants solo a `anon`/`authenticated`):

``` sql
-- La app normaliza a E.164 (+52…) ANTES de llamar al RPC
-- (phoneIdentifierForLogin en supabaseAuthService.js): "6641234567" → "+526641234567".
select public.resolve_email_for_login('+526641234567');
```

- Devuelve el email **solo si hay UNA coincidencia exacta** por dígitos
  de teléfono (o por email); ambigüedad o no-encontrado → `NULL`, y la UI
  invita a usar el correo.
- Nunca valida contraseñas ni expone teléfonos/filas: esa validación la
  hace **siempre** Supabase Auth.
- Pre-chequeo de registro (`checkSecondaryContact`): la migración `0003` añade
  `phone_is_registered(p_phone)` — `SECURITY DEFINER`, devuelve **solo**
  `true|false` de existencia por dígitos (sin email ni filas). RLS de
  `customers` sigue intacta y el anon no puede hacer SELECT.
- Riesgo aceptado (H2): `anon` puede invocar `resolve_email_for_login`
  (teléfono → email). Mitigación futura: resolver+login en una Edge Function
  y rate limiting/CAPTCHA — ver `docs/AUTH_AND_LOYVERSE_FLOW.md`.

------------------------------------------------------------------------

# 31. Evolución futura

Esta estructura permite agregar posteriormente:

-   Wallet.
-   Push notifications.
-   Tickets digitales.
-   Promociones.
-   Marketing.
-   Catálogo.
-   Pedidos en línea.
-   Métricas.
-   Segmentación de clientes.
-   Más sucursales.
-   Integración con otros POS.
-   Plantilla SaaS para otros cafés.

La idea es **no construir esas funciones todavía**, pero evitar que la
estructura actual impida agregarlas posteriormente.

------------------------------------------------------------------------

# 32. Estado actual del diseño

### Confirmado mediante pruebas de Loyverse

-   Existe API de clientes.
-   Existe API de recibos.
-   Los recibos contienen `customer_id`.
-   Los recibos contienen monto.
-   Los recibos contienen fecha.
-   Los recibos contienen `store_id`.
-   Los recibos contienen `employee_id`.
-   Los recibos pueden indicar refunds.
-   Los productos vendidos aparecen en `line_items`.
-   Los clientes pueden ser vinculados a tickets.
-   Existen tickets sin cliente asociado.

### Pendiente de implementación/verificación

-   Automatización de lectura de nuevos recibos.
-   Estrategia final de sincronización periódica/webhook.
-   Identificador técnico definitivo del recibo para idempotencia.
-   Flujo final de canje de recompensa en POS.
-   Reglas exactas para refunds parciales.
-   Modelo final de sucursales Salmos.
-   Roles y permisos de Staff/Admin.
-   Automatización de expiración de recompensas.

------------------------------------------------------------------------

# 33. Decisión arquitectónica principal

La decisión más importante de este documento es:

> **Loyverse registra lo que pasó en el POS; Supabase determina qué
> significa eso para el programa de lealtad de Salmos.**

Por ejemplo:

``` text
Loyverse dice:

"Se vendieron $180
a este cliente
en este ticket."

             ↓

Salmos decide:

"Cumple el mínimo,
no tiene otra visita hoy,
el ticket no ha sido procesado,
por lo tanto:

+1 visita."
```

Esta separación permite que Salmos tenga sus propias reglas sin intentar
modificar ni reemplazar el funcionamiento del POS.

------------------------------------------------------------------------

# 34. Resumen visual final

``` text
                         ┌───────────────┐
                         │   APP SALMOS  │
                         └───────┬───────┘
                                 │
                                 ▼
                    ┌────────────────────────┐
                    │       SUPABASE         │
                    │                        │
                    │ Auth                   │
                    │ Customers              │
                    │ Loyalty Cycles         │
                    │ Loyalty Visits         │
                    │ Rewards                │
                    │ Audit                  │
                    └───────────┬────────────┘
                                │
                         Edge Function
                                │
                                ▼
                    ┌────────────────────────┐
                    │       LOYVERSE         │
                    │                        │
                    │ Customers              │
                    │ Receipts               │
                    │ Stores                 │
                    │ Employees              │
                    │ Items                  │
                    └────────────────────────┘
```

**Principio final:**

``` text
Cuenta        → Supabase
Cliente POS   → Loyverse
Venta         → Loyverse
Visita        → Salmos / Supabase
Recompensa    → Salmos / Supabase
Historial     → Salmos / Supabase
```

Este documento debe considerarse la base de diseño antes de crear o
modificar las tablas definitivas de producción.
