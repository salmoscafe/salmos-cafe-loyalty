-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0018: endurecimiento de autorización de RPCs.
-- Ruta: supabase/migrations/0018_rpc_authorization_hardening.sql
-- Aplicar con: supabase db push  (después de 0017) — SOLO con aprobación.
--
-- Problema que corrige (auditoría 2026-10-07):
--   1) Las migraciones 0003–0017 hacen `revoke all … from public` +
--      `grant execute … to service_role`, pero Supabase otorga EXECUTE a
--      `anon` y `authenticated` por DEFAULT PRIVILEGES en el schema
--      public. Resultado (verificado en remoto con anon): todas las RPCs
--      SECURITY DEFINER del motor eran invocables vía /rest/v1/rpc/*.
--   2) public.assert_loyalty_actor() aceptaba un JWT de usuario si
--      p_actor_role = 'customer' y p_actor_id = su propio customers.id.
--      Combinado con (1), un cliente autenticado podía:
--        * registrarse visitas/sellos a sí mismo (register_visit), y
--        * cancelar visitas de OTROS clientes por external_sale_id
--          (cancel_visit_by_sale / cancel_visit),
--      porque esas RPCs no exigían staff/admin: confiaban en
--      p_actor_role / p_actor_id enviados por quien llama.
--
-- Arquitectura resultante (sin cambiar firmas ni consumidores):
--   Cliente → Supabase Auth → Edge Function (auth.getUser → public.profiles
--   role + active, server-side) → RPC con la SECRET KEY (service_role)
--   → assert_loyalty_actor:
--       * exige auth.role() = 'service_role' y SIN sesión de usuario;
--       * staff/admin: p_actor_id DEBE existir en public.profiles con ese
--         role exacto y active = true (p_actor_role deja de ser una
--         afirmación libre incluso para la Edge);
--       * 'system' (sync de Loyverse): solo con service_role;
--       * 'customer' ya no puede mutar el motor (ningún flujo lo usa:
--         claim_start no es RPC, el resto son operaciones staff).
--   p_actor_id / p_actor_role se conservan como metadato de AUDITORÍA
--   (audit_logs, cancelled_by, redeemed_by, verified_by) y nunca como
--   fuente de autorización por sí solos.
--
-- Qué NO cambia:
--   * Ninguna tabla, columna, índice ni dato.
--   * Ninguna regla de negocio (7 visitas, $50, 1/día, $150, 3 meses,
--     reversión por cancelación, nuevo ciclo).
--   * Ninguna firma de función (las Edge Functions no cambian).
--   * resolve_email_for_login / phone_is_registered siguen con anon +
--     authenticated (el login por alias las necesita antes de la sesión).
--
-- Idempotente: CREATE OR REPLACE + REVOKE/GRANT repetibles.
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) assert_loyalty_actor — el actor se valida contra el contexto
--    autenticado (auth.role/auth.uid) y public.profiles, nunca contra
--    lo que el caller afirma.
-- ====================================================================
create or replace function public.assert_loyalty_actor(
  p_actor_id    text,
  p_actor_role  text,
  p_customer_id uuid default null   -- conservado por compatibilidad de firma
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_actor_uuid uuid;
begin
  -- 1) Caller: SOLO service_role (Edge Functions con la secret key) y
  --    sin sesión de usuario. Un JWT de anon/authenticated jamás puede
  --    mutar el motor de lealtad, diga lo que diga el payload.
  if coalesce(auth.role(), '') <> 'service_role' or auth.uid() is not null then
    raise exception 'No autorizado.'
      using errcode = '42501';
  end if;

  -- 2) Actor identificado (metadato de auditoría obligatorio).
  if p_actor_id is null or btrim(p_actor_id) = '' then
    raise exception 'Actor no identificado.'
      using errcode = 'P0001';
  end if;

  -- 3) Roles que pueden operar el motor.
  if p_actor_role is null or p_actor_role not in ('staff', 'admin', 'system') then
    raise exception 'Rol de actor inválido.'
      using errcode = 'P0001';
  end if;

  -- 4) staff/admin: el rol se COMPRUEBA en public.profiles (fuente de
  --    verdad server-side). El id debe ser un uuid de un perfil activo
  --    con exactamente ese rol.
  if p_actor_role in ('staff', 'admin') then
    if p_actor_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'No autorizado.'
        using errcode = '42501';
    end if;
    v_actor_uuid := p_actor_id::uuid;

    if not exists (
      select 1
        from public.profiles pr
       where pr.id = v_actor_uuid
         and pr.role = p_actor_role
         and pr.active = true
    ) then
      raise exception 'No autorizado.'
        using errcode = '42501';
    end if;
  end if;
end;
$$;

comment on function public.assert_loyalty_actor(text, text, uuid) is
  '0018: guarda de autorización del motor. Exige auth.role() = service_role sin sesión de usuario; acepta actor_role staff/admin (verificado contra public.profiles: id, role exacto, active) o system. p_actor_id/p_actor_role son metadato de auditoría, nunca autorización por sí solos. p_customer_id se conserva por compatibilidad de firma.';

-- ====================================================================
-- 2) EXECUTE explícito por función (todas las sobrecargas existentes).
-- ====================================================================
do $$
declare
  r record;
begin
  -- 2a) RPCs internas del motor: SOLO service_role.
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in (
         'assert_loyalty_actor',
         'visit_summary',
         'register_visit',
         'register_visit_with_receipt',
         'cancel_visit',
         'cancel_visit_by_sale',
         'redeem_reward',
         'verify_reward_claim',
         'constant_time_equal'
       )
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;

  -- 2b) Funciones de trigger: nadie las invoca por RPC. Revocar a
  --     anon/authenticated no afecta el disparo de los triggers (el
  --     privilegio EXECUTE solo se comprueba al crear el trigger).
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('handle_new_user', 'set_updated_at')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    execute format('grant execute on function %s to service_role', r.sig);
  end loop;

  -- 2c) Login por alias (pre-sesión): anon + authenticated a propósito.
  --     Se re-declara explícitamente para que el estado sea legible.
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('resolve_email_for_login', 'phone_is_registered')
  loop
    execute format('revoke all on function %s from public', r.sig);
    execute format('grant execute on function %s to anon, authenticated, service_role', r.sig);
  end loop;
end;
$$;

-- ====================================================================
-- 3) Funciones FUTURAS en public: ya no se exponen solas a anon /
--    authenticated. Cada migración debe otorgar EXECUTE explícito (la
--    convención del proyecto ya es `revoke … from public` + grant).
--    Solo afecta funciones creadas por `postgres` (el rol de
--    `supabase db push`) en el schema public; tablas no cambian.
-- ====================================================================
alter default privileges for role postgres in schema public
  revoke execute on functions from anon, authenticated;
