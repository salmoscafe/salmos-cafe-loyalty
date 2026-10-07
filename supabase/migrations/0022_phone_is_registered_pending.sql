-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0022: phone_is_registered canónico + ventana
-- de registro pendiente.
-- Ruta: supabase/migrations/0022_phone_is_registered_pending.sql
-- Aplicar con: supabase db push — SOLO con aprobación (después de 0021).
--
-- Problemas que corrige:
--   1) phone_is_registered (0003) comparaba DÍGITOS crudos: "6645550007"
--      y "+526645550007" no se reconocían como el mismo número.
--   2) Ventana de registro: el teléfono de un registro por email vive
--      SOLO en auth.users.raw_user_meta_data.phone hasta el primer login
--      (cuando se crea public.customers). Mientras tanto el número
--      aparecía "libre" y otra persona podía registrarlo.
--
-- Diseño:
--   * public.canonical_mx_phone(text) → '+52XXXXXXXXXX' | NULL.
--     IMMUTABLE, pura, misma regla que src/lib/phone.js (toE164Mx).
--     Helper PRIVADO: sin EXECUTE para PUBLIC/anon/authenticated.
--   * public.phone_is_registered(p_phone text) → boolean (MISMA firma):
--     true si el número canónico está
--       A) en public.customers.phone, o
--       B) en raw_user_meta_data.phone de un usuario que AÚN NO tiene
--          fila en public.customers y que está confirmado
--          (email_confirmed_at) o se creó hace < 24 h.
--     En cuanto existe la fila customers, su metadata se ignora: la
--     metadata solo cubre la ventana previa, nunca es identidad
--     permanente. Registros abandonados (sin confirmar, > 24 h) no
--     reservan números. Metadata no-string, vacía o no normalizable se
--     ignora. Entrada inválida → false.
--   * Solo devuelve un booleano: nunca cuántos ni quiénes.
--
-- Exposición (decisión explícita): RegisterForm.jsx → checkSecondaryContact
-- → supabaseClient.rpc('phone_is_registered') se ejecuta ANTES de tener
-- sesión (rol anon). Por eso phone_is_registered conserva EXECUTE para
-- anon y authenticated (igual que 0003/0018). Lo que NO se expone es el
-- helper canonical_mx_phone. La enumeración por este RPC sigue siendo una
-- decisión de producto (rate limit/CAPTCHA: fase posterior).
--
-- Idempotente (CREATE OR REPLACE + REVOKE/GRANT).
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) Helper privado de canonicalización E.164 MX
-- ====================================================================
create or replace function public.canonical_mx_phone(p text)
returns text
language sql
immutable
set search_path = public
as $$
  select case
           when length(d) = 10                     then '+52' || d
           when length(d) = 12 and d like '52%'    then '+'   || d
           else null
         end
    from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

revoke all on function public.canonical_mx_phone(text) from public, anon, authenticated;
grant execute on function public.canonical_mx_phone(text) to service_role;

comment on function public.canonical_mx_phone(text) is
  '0022: canonicaliza un teléfono a E.164 MX (+52XXXXXXXXXX). 10 dígitos → +52…; 52+10 dígitos → +52…; resto → NULL. Helper interno (sin EXECUTE para anon/authenticated).';

-- ====================================================================
-- 2) phone_is_registered — misma firma, comparación canónica + ventana
-- ====================================================================
create or replace function public.phone_is_registered(p_phone text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  with q as (select public.canonical_mx_phone(p_phone) as canon)
  select coalesce(
           q.canon is not null
           and (
             exists (
               select 1
                 from public.customers c
                where c.phone is not null
                  and public.canonical_mx_phone(c.phone) = q.canon
             )
             or exists (
               select 1
                 from auth.users u
                where jsonb_typeof(u.raw_user_meta_data -> 'phone') = 'string'
                  and public.canonical_mx_phone(u.raw_user_meta_data ->> 'phone') = q.canon
                  and not exists (
                        select 1 from public.customers c2 where c2.auth_user_id = u.id
                      )
                  and (
                        u.email_confirmed_at is not null
                        or u.created_at >= now() - interval '24 hours'
                      )
             )
           ),
           false
         )
    from q
$$;

revoke all on function public.phone_is_registered(text) from public;
grant execute on function public.phone_is_registered(text) to anon, authenticated, service_role;

comment on function public.phone_is_registered(text) is
  '0022: indica (solo booleano) si un teléfono ya está ocupado, en forma canónica E.164 MX: en customers.phone, o en la metadata de un registro pendiente (sin fila customers; confirmado o creado hace < 24 h). Usado por checkSecondaryContact antes del registro (anon). No devuelve email, filas, cantidades ni identidades.';
