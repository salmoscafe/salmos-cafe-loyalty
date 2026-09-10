-- ---------------------------------------------------------------
-- Salmos Café Loyalty — migración inicial de clientes reales.
-- Ruta: supabase/migrations/0001_customers.sql
-- Aplicar con: supabase db push  (o pegar en el SQL Editor)
--
-- Reglas de negocio:
--   * Un auth_user == una fila customers (auth_user_id único).
--   * customer_code (SC-XXXXXXXX) es el token QR y también el
--     customer_code que recibe Loyverse (nombre estable, idempotente).
--   * loyverse_customer_id se rellena tras la Edge Function; es único
--     para que nunca dos usuarios Salmos apunten al mismo cliente.
-- ---------------------------------------------------------------

create extension if not exists "pgcrypto";

-- Cliente fiel de Salmos (uno por usuario autenticado).
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null unique references auth.users(id) on delete cascade,
  name text not null,
  email text,
  phone text,
  customer_code text not null unique
    check (customer_code ~ '^SC-[0-9A-HJ-NP-Z]{8}$'),
  loyverse_customer_id text unique,
  loyverse_sync_status text not null default 'pending'
    check (loyverse_sync_status in ('pending', 'synced', 'failed', 'conflict')),
  profile jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists customers_auth_user_idx on public.customers (auth_user_id);

-- Diagnóstico de sync sin exponer prompts/tokens.
create table public.customer_sync_events (
  id uuid primary key default gen_random_uuid(),
  auth_user_id uuid not null references auth.users(id) on delete cascade,
  trace_id text,
  event_type text not null check (
    event_type in (
      'loyverse_linked',
      'loyverse_created',
      'loyverse_already_linked',
      'loyverse_conflict',
      'loyverse_error'
    )
  ),
  detail jsonb,
  created_at timestamptz not null default now()
);

create index if not exists customer_sync_events_user_idx
  on public.customer_sync_events (auth_user_id, created_at desc);

-- ------------------------------------------------------------------
-- RLS: cada usuario solo ve/escribe SU fila. La Edge Function ejecuta
-- con el JWT del usuario, así que herea exactamente esta política.
-- ------------------------------------------------------------------
alter table public.customers enable row level security;
alter table public.customer_sync_events enable row level security;

create policy "customers_own_all" on public.customers
  for all to authenticated
  using (auth.uid() = auth_user_id)
  with check (auth.uid() = auth_user_id);

create policy "sync_events_own_all" on public.customer_sync_events
  for all to authenticated
  using (auth.uid() = auth_user_id)
  with check (auth.uid() = auth_user_id);

-- updated_at automático.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger customers_set_updated_at
  before update on public.customers
  for each row
  execute function public.set_updated_at();