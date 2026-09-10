-- ---------------------------------------------------------------
-- Salmos Café Loyalty — esquema de fidelización.
-- Ruta: supabase/migrations/0002_loyalty_schema.sql
-- Aplicar con: supabase db push  (después de 0001)
--
-- Decisiones aprobadas en la auditoría del modelo:
--   customers → loyalty_cycles → loyalty_visits / rewards
--   customers → customer_sync_events (sin cambios)
--   audit_logs  (separada de customer_sync_events)
--
-- Principios:
--   * El progreso de un ciclo se DERIVA de loyalty_visits. NO se
--     guarda contador en loyalty_cycles.
--   * Idempotencia por venta/recibo: external_sale_id UNIQUE.
--   * Máximo UNA visita activa por cliente y día: índice único
--     parcial (customer_id, visit_date) WHERE status = 'active'.
--   * El cliente SOLO LEE lo suyo (RLS SELECT). INSERT/UPDATE/DELETE
--     sobre loyalty y audit quedan exclusivamente en Edge Functions
--     (service role / SECURITY DEFINER, validando el JWT primero).
--   * Los timestamps y expirations los decide el backend; nunca el
--     reloj del navegador. expires_at se guarda real; "expired" se
--     deriva en lectura (available AND expires_at < now()).
--
-- Fuera de alcance (etapa posterior): motor de lealtad, registerSale,
-- webhooks, cancelaciones, redención. Aquí solo estructura.
-- ---------------------------------------------------------------

-- ------------------------------------------------------------------
-- 1) customers.email_verified
--    El código (supabaseAuthService) ya escribía este campo en el
--    INSERT, pero la columna no existía en 0001. Se declara ahora.
-- ------------------------------------------------------------------
alter table public.customers
  add column email_verified boolean not null default false;

-- ------------------------------------------------------------------
-- 2) loyalty_cycles — historial de ciclos de la tarjeta.
-- ------------------------------------------------------------------
create table public.loyalty_cycles (
  id            uuid primary key default gen_random_uuid(),
  customer_id   uuid not null references public.customers(id) on delete cascade,
  cycle_number  integer not null,
  status        text not null default 'active' check (status in ('active', 'completed')),
  started_at    timestamptz not null default now(),
  completed_at  timestamptz,
  created_at    timestamptz not null default now(),

  -- Un solo ciclo por número dentro de cada cliente (consecutivo:
  -- lo asigna la Edge Function con max+1 bajo este UNIQUE; ante una
  -- carrera el 23505 es reintentable).
  constraint loyalty_cycles_customer_number_key unique (customer_id, cycle_number),

  -- Estado coherente con su timestamp (sin NULLs intermedios).
  constraint loyalty_cycles_state_check check (
    (status = 'active'    and completed_at is null) or
    (status = 'completed' and completed_at is not null)
  )
);

comment on table public.loyalty_cycles is
  'Ciclos de la tarjeta Salmos. El conteo de visitas se deriva de loyalty_visits.';
comment on column public.loyalty_cycles.status is
  'Estados mínimos V1: active | completed. expired/cancelled quedan reservados para reglas futuras.';

-- Búsqueda rápida del ciclo vigente de un cliente.
create index loyalty_cycles_customer_status_idx
  on public.loyalty_cycles (customer_id, status);

-- ------------------------------------------------------------------
-- 3) loyalty_visits — UNA fila por visita válida de Salmos.
--    Fuente de verdad del progreso de la tarjeta.
-- ------------------------------------------------------------------
create table public.loyalty_visits (
  id               uuid primary key default gen_random_uuid(),
  customer_id      uuid not null references public.customers(id) on delete cascade,
  cycle_id         uuid not null references public.loyalty_cycles(id) on delete cascade,
  external_sale_id text not null,
  amount           numeric(10,2) not null check (amount >= 50),
  visit_date       date not null,
  store_id         text,
  employee_id      text,
  status           text not null default 'active' check (status in ('active', 'cancelled')),
  cancelled_at     timestamptz,
  cancelled_by     text,
  created_at       timestamptz not null default now(),

  -- Idempotencia: la misma venta/recibo jamás genera dos visitas.
  constraint loyalty_visits_external_sale_id_key unique (external_sale_id),

  -- Una visita activa no puede tener datos de cancelación, y viceversa.
  constraint loyalty_visits_state_check check (
    (status = 'active'    and cancelled_at is null) or
    (status = 'cancelled' and cancelled_at is not null)
  )
);

comment on table public.loyalty_visits is
  'Visitas válidas de la tarjeta Salmos. external_sale_id: "manual_ext_<uuid>" hoy; "loyverse_receipt_<receipt_id>" cuando se conecte el POS.';
comment on column public.loyalty_visits.visit_date is
  'Día de negocio de la visita (lo calcula el backend), independiente de created_at para no depender de zonas horarias.';
comment on column public.loyalty_visits.amount is
  'Monto de la compra. El mínimo de $50 MXN es regla de negocio V1 y está forzada por CHECK.';

-- Máximo UNA visita activa por cliente y día (la cancelación permite
-- registrar una nueva el mismo día sin chocar con este índice).
create unique index loyalty_visits_one_active_per_day_idx
  on public.loyalty_visits (customer_id, visit_date)
  where status = 'active';

-- Consultas "visitas de un ciclo" (derivación del progreso).
create index loyalty_visits_cycle_idx
  on public.loyalty_visits (cycle_id);

-- Historial / actividad por cliente.
create index loyalty_visits_customer_created_idx
  on public.loyalty_visits (customer_id, created_at desc);

-- ------------------------------------------------------------------
-- 4) rewards — recompensa por ciclo (máximo 1), vence a los 3 meses.
-- ------------------------------------------------------------------
create table public.rewards (
  id          uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers(id) on delete cascade,
  cycle_id    uuid not null references public.loyalty_cycles(id) on delete cascade,
  label       text not null default 'Café gratis',
  max_value   numeric(10,2) not null default 150 check (max_value > 0),
  earned_at   timestamptz not null default now(),
  expires_at  timestamptz not null,
  status      text not null default 'available' check (status in ('available', 'redeemed', 'cancelled')),
  redeemed_at timestamptz,
  redeemed_by text,
  created_at  timestamptz not null default now(),

  -- La 8ª visita es la única que genera reward → máximo 1 por ciclo.
  constraint rewards_cycle_id_key unique (cycle_id),

  -- Vence después de ganarse. (El estado "expired" se deriva en
  -- lectura: available AND expires_at < now(); sin cron en V1.)
  constraint rewards_expiry_check check (expires_at > earned_at),

  -- Coherencia estado ↔ timestamps/actor de redención.
  constraint rewards_state_check check (
    (status = 'redeemed' and redeemed_at is not null and redeemed_by is not null) or
    (status <> 'redeemed' and redeemed_at is null)
  )
);

comment on column public.rewards.expires_at is
  'Timestamp real calculado por el backend (earned_at + 3 meses). Nunca el reloj del navegador.';

-- Recompensas del cliente (listados / historial).
create index rewards_customer_status_idx
  on public.rewards (customer_id, status);

-- ------------------------------------------------------------------
-- 5) audit_logs — auditoría de negocio (no confundir con
--    customer_sync_events, que es sincronización técnica con Loyverse).
-- ------------------------------------------------------------------
create table public.audit_logs (
  id          uuid primary key default gen_random_uuid(),
  actor_id    text not null,
  actor_role  text not null check (actor_role in ('customer', 'staff', 'admin', 'system')),
  customer_id uuid references public.customers(id) on delete set null,
  cycle_id    uuid references public.loyalty_cycles(id) on delete set null,
  visit_id    uuid references public.loyalty_visits(id) on delete set null,
  reward_id   uuid references public.rewards(id) on delete set null,
  sale_id     text,
  action      text not null,
  detail      jsonb,
  created_at  timestamptz not null default now()
);

comment on table public.audit_logs is
  'Auditoría de negocio: quién, qué, cuándo y sobre qué. La escriben las Edge Functions (service role o funciones SECURITY DEFINER); el cliente no tiene ningún permiso aquí.';

create index audit_logs_customer_created_idx
  on public.audit_logs (customer_id, created_at desc);

create index audit_logs_cycle_created_idx
  on public.audit_logs (cycle_id, created_at desc);

-- ------------------------------------------------------------------
-- 6) RLS — el cliente SOLO LEE lo suyo. Nada de mutaciones desde la
--    app: las operaciones sensibles son de la Edge Function, que corre
--    con service role (BYPASSRLS) o funciones SECURITY DEFINER que
--    verifican el JWT del usuario antes de actuar.
-- ------------------------------------------------------------------
alter table public.loyalty_cycles enable row level security;
alter table public.loyalty_visits enable row level security;
alter table public.rewards enable row level security;
alter table public.audit_logs enable row level security;

create policy "loyalty_cycles_client_select" on public.loyalty_cycles
  for select to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = loyalty_cycles.customer_id
        and c.auth_user_id = auth.uid()
    )
  );

create policy "loyalty_visits_client_select" on public.loyalty_visits
  for select to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = loyalty_visits.customer_id
        and c.auth_user_id = auth.uid()
    )
  );

create policy "rewards_client_select" on public.rewards
  for select to authenticated
  using (
    exists (
      select 1 from public.customers c
      where c.id = rewards.customer_id
        and c.auth_user_id = auth.uid()
    )
  );

-- audit_logs: RLS habilitada y SIN políticas → solo service_role
-- (BYPASSRLS) puede acceder. El cliente jamás la ve ni la toca.