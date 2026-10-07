-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0020: login por teléfono sin fuga de email.
-- Ruta: supabase/migrations/0020_login_alias_lockdown.sql
-- Aplicar con: supabase db push — SOLO con aprobación y DESPUÉS de
-- desplegar la Edge `auth-phone-login` y el frontend que la usa (el
-- frontend anterior llama a resolve_email_for_login como anon).
--
-- Problema (auditoría 2026-10-07):
--   public.resolve_email_for_login (0003) era ejecutable por anon y
--   devolvía el EMAIL de la cuenta cuyo teléfono coincidiera: cualquiera
--   podía mapear teléfono → email. Además devolvía customers.email, que
--   el propio cliente puede editar (grant update(email) de 0008), en vez
--   del email real de Supabase Auth.
--
-- Cambios:
--   1) resolve_email_for_login: misma firma y misma regla de coincidencia
--      (email exacto o dígitos del teléfono; SOLO si hay UNA cuenta), pero
--        * devuelve auth.users.email de la cuenta vinculada
--          (customers.auth_user_id), la identidad que GoTrue autentica;
--        * EXECUTE solo para service_role (la Edge auth-phone-login).
--          anon/authenticated ya no pueden invocarla.
--   2) email_is_registered(text) → boolean (anon/authenticated): reemplaza
--      el uso de resolve_email_for_login en el pre-chequeo del registro
--      (checkSecondaryContact). Devuelve solo existencia del correo que
--      el propio usuario escribió — la misma información que ya obtenía
--      el frontend (antes recibía de vuelta el mismo email) — y nunca
--      datos de otra cuenta. Simétrica a phone_is_registered (0003).
--
-- No cambia: tablas, datos, perfiles, reglas de lealtad, phone_is_registered.
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT).
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) resolve_email_for_login — solo uso interno (service_role)
-- ====================================================================
create or replace function public.resolve_email_for_login(p_identifier text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select
    case count(*)
      when 1 then min(u.email)
      else null
    end
  from public.customers c
  join auth.users u on u.id = c.auth_user_id
  where u.email is not null
    and (
      (c.email is not null and lower(btrim(c.email)) = lower(btrim(p_identifier)))
      or (
        c.phone is not null
        and regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g') <> ''
        and regexp_replace(c.phone, '\D', '', 'g')
            = regexp_replace(p_identifier, '\D', '', 'g')
      )
    );
$$;

revoke all on function public.resolve_email_for_login(text) from public, anon, authenticated;
grant execute on function public.resolve_email_for_login(text) to service_role;

comment on function public.resolve_email_for_login(text) is
  '0020: USO INTERNO (service_role / Edge auth-phone-login). Devuelve el email de Supabase Auth (auth.users) de la cuenta única cuyo correo o teléfono coincide; NULL si no hay coincidencia única. Nunca valida contraseñas (eso es GoTrue) y NUNCA debe exponerse a anon/authenticated.';

-- ====================================================================
-- 2) email_is_registered — pre-chequeo de registro (solo booleano)
-- ====================================================================
create or replace function public.email_is_registered(p_email text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
      from public.customers c
     where c.email is not null
       and btrim(coalesce(p_email, '')) <> ''
       and lower(btrim(c.email)) = lower(btrim(p_email))
  );
$$;

revoke all on function public.email_is_registered(text) from public;
grant execute on function public.email_is_registered(text) to anon, authenticated, service_role;

comment on function public.email_is_registered(text) is
  '0020: indica si el correo ya está registrado (solo existencia). Usado por checkSecondaryContact antes del registro; no devuelve email, filas ni datos de otra cuenta. Sustituye el uso público de resolve_email_for_login.';
