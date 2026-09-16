-- ---------------------------------------------------------------
-- Salmos Café — CHECKPOINT 1: Profiles & Roles.
-- Ruta: supabase/migrations/0013_profiles_roles.sql
-- Aplicar con: supabase db push
--
-- Objetivo:
--   Unificar autenticación (Supabase Auth) con autorización (roles).
--   Una sola cuenta Supabase Auth por persona. El rol vive en
--   public.profiles, NO en user_metadata ni app_metadata.
--
-- Relación:
--   auth.users.id = profiles.id = customers.auth_user_id
--
-- Roles: customer | staff | admin
--
-- Trigger: al registrarse un nuevo usuario en auth.users, se crea
-- automáticamente su perfil con role='customer'. Los perfiles de
-- staff/admin se crean vía service_role (AdminDashboard futuro).
-- ---------------------------------------------------------------

-- ------------------------------------------------------------------
-- 1) Tabla profiles
-- ------------------------------------------------------------------
create table public.profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       text not null default 'customer'
               check (role in ('customer', 'staff', 'admin')),
  name       text,
  active     boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.profiles is
  'Perfiles de rol para customer/staff/admin. Fuente de verdad del rol del usuario.';

comment on column public.profiles.role is
  'customer | staff | admin. Determina qué experiencia ve el usuario y qué operaciones puede ejecutar.';

comment on column public.profiles.active is
  'false = deshabilitado. Un empleado inactivo no puede iniciar sesión en Staff/Admin.';

-- ------------------------------------------------------------------
-- 2) RLS — solo SELECT propio; INSERT/UPDATE/DELETE vía service_role
-- ------------------------------------------------------------------
-- No creamos policies de INSERT/UPDATE/DELETE: service_role tiene
-- BYPASSRLS y puede administrar los perfiles libremente.
-- El cliente solo puede leer SU propio perfil.
alter table public.profiles enable row level security;

create policy "profiles_own_select"
  on public.profiles
  for select
  to authenticated
  using (auth.uid() = id);

-- ------------------------------------------------------------------
-- 3) updated_at automático (reutiliza la función de 0001)
-- ------------------------------------------------------------------
create trigger profiles_set_updated_at
  before update on public.profiles
  for each row
  execute function public.set_updated_at();

-- ------------------------------------------------------------------
-- 4) Trigger: crear perfil customer automáticamente al registrarse
-- ------------------------------------------------------------------
-- Cuando un usuario se registra en Supabase Auth (signUp), se crea
-- automáticamente su fila en profiles con role='customer'.
-- Esto garantiza que TODO usuario autenticado tenga un perfil.
-- Los perfiles de staff/admin se crean vía service_role (futuro
-- AdminDashboard). El trigger SOLO crea customers.
-- ------------------------------------------------------------------
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, role, name)
  values (
    new.id,
    'customer',
    coalesce(
      new.raw_user_meta_data ->> 'name',
      new.raw_user_meta_data ->> 'full_name',
      split_part(new.email, '@', 1),
      'Cliente Salmos'
    )
  );
  return new;
end;
$$;

comment on function public.handle_new_user() is
  'Trigger: crea un perfil customer automáticamente cuando un usuario se registra en Supabase Auth.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row
  execute function public.handle_new_user();
