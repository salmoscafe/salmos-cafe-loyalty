-- ---------------------------------------------------------------
-- Salmos Café Loyalty — alias de identificación para login.
-- Ruta: supabase/migrations/0003_auth_alias_rpc.sql
-- Aplicar con: supabase db push  (después de 0002)
--
-- Para qué sirve:
--   El cliente se registra con email + contraseña (y teléfono como
--   contacto). Para permitir "inicio de sesión con teléfono +
--   contraseña" SIN depender de un proveedor SMS, resolvemos el
--   teléfono → email de la cuenta con este RPC del lado servidor.
--
--   El navegador NO puede leer la fila `customers` de otra persona
--   (RLS), así que la resolución es una función SECURITY DEFINER que
--   corre como owner (postgres), omite RLS y devuelve SOLO el email
--   cuando el identificador coincide con EXACTAMENTE una cuenta.
--
--   Seguridad:
--     * Devuelve el email solo si hay UNA coincidencia (teléfono
--       ambiguo o inexistente → NULL). No filtra ni enumera datos.
--     * search_path fijo → no se puede secuestrar búsquedas con
--       objetos públicos.
--     * Es el mínimo necesario para el login por alias; la verificación
--       de credenciales la hace SIEMPRE Supabase Auth (GoTrue), nunca
--       esta función.
-- ---------------------------------------------------------------

-- Búsquedas de login (email / teléfono E.164) y de checkSecondaryContact.
create index if not exists customers_email_idx on public.customers (email);
create index if not exists customers_phone_idx on public.customers (phone);

create or replace function public.resolve_email_for_login(p_identifier text)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select
    case count(*)
      when 1 then min(c.email)
      else null
    end
  from public.customers c
  where c.email is not null
    and (
      lower(btrim(c.email)) = lower(btrim(p_identifier))
      or (
        c.phone is not null
        and regexp_replace(coalesce(p_identifier, ''), '\D', '', 'g') <> ''
        and regexp_replace(c.phone, '\D', '', 'g')
            = regexp_replace(p_identifier, '\D', '', 'g')
      )
    );
$$;

-- No exponerla a todo el mundo: solo anon (pre-login) y authenticated.
revoke all on function public.resolve_email_for_login(text) from public;
grant execute on function public.resolve_email_for_login(text) to anon, authenticated;

comment on function public.resolve_email_for_login(text) is
  'Devuelve el email de la cuenta única cuyo correo o teléfono coincide con el identificador (login por alias). NULL si no hay coincidencia única. Nunca valida contraseñas: eso es de Supabase Auth.';

-- ---------------------------------------------------------------
-- phone_is_registered — pre-chequeo de registro (checkSecondaryContact).
--
--   El frontend anónimo NO puede consultar `customers` directamente
--   (RLS anon = none), así que un SELECT siempre devolvería "libre".
--   Esta función corre como owner (SECURITY DEFINER), omite RLS y
--   devuelve SOLO si el teléfono existe (booleano). No expone email,
--   ni filas, ni el resto del perfil.
--   Coincide por dígitos: "6641234567" == "+526641234567".
-- ---------------------------------------------------------------
create or replace function public.phone_is_registered(p_phone text)
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1
    from public.customers c
    where c.phone is not null
      and regexp_replace(coalesce(p_phone, ''), '\D', '', 'g') <> ''
      and regexp_replace(c.phone, '\D', '', 'g')
          = regexp_replace(p_phone, '\D', '', 'g')
  );
$$;

revoke all on function public.phone_is_registered(text) from public;
grant execute on function public.phone_is_registered(text) to anon, authenticated;

comment on function public.phone_is_registered(text) is
  'Indica si el teléfono ya está registrado (sólo existencia, por dígitos). Usado por checkSecondaryContact antes del registro; no devuelve email ni filas. Coincide por dígitos (E.164 normalizado en la app).';