-- ---------------------------------------------------------------
-- 0027_ensure_own_customer.sql
-- Ruta: supabase/migrations/0027_ensure_own_customer.sql
-- Proyecto: App Salmos LC
-- Aplicar con: supabase db push (SOLO autorizado; despliegue controlado).
--   En local se valida con el harness de tests (tests/helpers/supabaseSqlHarness.mjs).
--
-- DECISIÓN APROBADA (veredicto del diseño):
--   * NO se usan triggers. auth.users es la fuente de verdad (email, email_verified,
--     name/phone desde raw_user_meta_data) y customers es la "tabla de negocio".
--   * Esta migración es ADITIVA: crea la RPC public.ensure_own_customer() que el
--     frontend usará en registro/sesión. NO revoca permisos (eso es 0028, posterior
--     y previsto solo tras validar esta función). NO toca customers.phone /
--     phone_verified_at / resolve_email_for_login / loyverse-customers.
--
-- CONTRATO (requisitos del diseño):
--   * require auth.uid() -> 42501 si es NULL (anon o claims sin sub).
--   * interacción limitada a UNA fila de auth.users (el usuario llamante).
--   * NUNCA modifica una fila existente (idempotente: devuelve la ya creada).
--   * phone canonicalizado con public.canonical_mx_phone (≡ toE164Mx del frontend).
--   * customer_code generado server-side con el MISMO alfabeto que
--     src/lib/customerCode.js: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' (31 símbolos,
--     sin ambigüedad óptica), formato SC-XXXXXXXX conforme al CHECK
--     customers_customer_code_check (^SC-[0-9A-HJ-NP-Z]{8}$).
--   * 23505 clasificado por constraint_name:
--       - customers_phone_unique_key  -> reinserta SIN phone y devuelve
--                                        _conflict_phone = true (mismo código).
--       - customers_customer_code_key -> reintenta con un código nuevo (≤ 6).
--       - customers_auth_user_id_key  -> otro proceso creó la fila: relee y la
--                                        devuelve tal cual.
--       - customers_email_unique_key  -> error definitivo EMAIL_ALREADY_REGISTERED
--                                        (errcode P0001) para el operador.
--   * concurrencia (punto 2 del diseño): pg_advisory_xact_lock por HASHTEXTEXTENDED
--     del uid serializa llamadas simultáneas del MISMO usuario (se libera en commit).
--     Filas creadas por OTROS procesos que no usan el lock (admin, backfills,
--     loyverse-customers) se absorben con el 23505 de auth_user_id -> relectura:
--     el INSERT de la RPC espera el write real del otro proceso y, si este gana,
--     devuelve su fila; si aborta, inserta la nuestra. No hay actualización en
--     ningún camino.
--   * security definer, set search_path = public, owner postgres (el owner ejecuta
--     y a su vez la RPC llama canonical_mx_phone, que solo service_role/postgres
--     pueden ejecutar — válido dentro del definer).
--   * execute SOLO para authenticated (revoke anon / service_role / PUBLIC;
--     los default privileges de Supabase otorgan EXECUTE a los tres roles).
--
-- TIPO DE RETORNO: returns table(...) con el contrato del frontend (id, auth_user_id,
--   name, email, email_verified, phone, customer_code, loyverse_customer_id,
--   loyverse_sync_status, created_at, _conflict_phone).
--   NO se usa `returns public.customers` a propósito: esa forma expondría también
--   la columna exclude_loyalty, sobre la que authenticated NO tiene SELECT (0014);
--   con PostgREST un RPC así tiende a fallar por permiso. El returns table explícito
--   hace verificable que exclude_loyalty NO se filtra.
--
-- email de salida: SIEMPRE el email de auth (fuente de verdad), no el caché de
-- customers. email_verified se deriva de auth.email_confirmed_at. En el camino
-- "fila existente" el caché customers.email NO se reescribe (no hay update).
-- ---------------------------------------------------------------

create or replace function public.ensure_own_customer()
returns table (
  id                   uuid,
  auth_user_id         uuid,
  name                 text,
  email                text,
  email_verified       boolean,
  phone                text,
  customer_code        text,
  loyverse_customer_id text,
  loyverse_sync_status text,
  created_at           timestamptz,
  _conflict_phone      boolean
)
language plpgsql
volatile
security definer
set search_path = public
as $function$
declare
  caller_uid uuid;
  u          auth.users%rowtype;
  c          public.customers%rowtype;
  v_name     text;
  v_email    text;
  new_code   text;
  attempts   int := 0;
  c1         text;
  c2         text;
begin
  caller_uid := auth.uid();
  if caller_uid is null then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  select * into u from auth.users a where a.id = caller_uid;
  if u.id is null then
    raise exception 'No autorizado' using errcode = '42501';
  end if;

  -- Fuente de verdad para email/derivados (SÍEMPRE auth, no el caché).
  v_email := lower(btrim(u.email));
  v_name := btrim(coalesce(
    u.raw_user_meta_data->>'name',
    u.raw_user_meta_data->>'full_name',
    split_part(v_email, '@', 1),
    'Cliente Salmos'
  ));

  -- Serializa llamadas concurrentes del mismo usuario.
  perform pg_advisory_xact_lock(hashtextextended(caller_uid::text, 4242));

  -- Idempotente: la fila ya existe -> devolverla, jamás sobrescribirla.
  select * into c from public.customers p where p.auth_user_id = caller_uid;
  if c.id is not null then
    return query
      select c.id, c.auth_user_id, c.name, v_email, u.email_confirmed_at is not null,
             c.phone, c.customer_code, c.loyverse_customer_id,
             c.loyverse_sync_status, c.created_at, false;
    return;
  end if;

  loop
    attempts := attempts + 1;
    if attempts > 6 then
      raise exception 'No se pudo generar un customer_code unico' using errcode = '08000';
    end if;

    -- Genera código con el alfabeto CANONICO del frontend (31 símbolos).
    -- OJO: ::int REDONDEA en Postgres ((30.6)::int -> 31), por eso se acota con
    -- modulo para que la posicion quede SIEMPRE en 1..31 (el subquery nunca
    -- debe devolver un caracter vacio).
    new_code := 'SC-' || (
      select string_agg(substr('ABCDEFGHJKMNPQRSTUVWXYZ23456789', ((random() * 31)::int % 31) + 1, 1), '')
        from generate_series(1, 8)
    );

    begin
      insert into public.customers (auth_user_id, name, email, email_verified, phone, customer_code)
      values (caller_uid, v_name, v_email, u.email_confirmed_at is not null,
              public.canonical_mx_phone(u.raw_user_meta_data->>'phone'), new_code)
      returning * into c;

      return query
        select c.id, c.auth_user_id, c.name, v_email, u.email_confirmed_at is not null,
               c.phone, c.customer_code, c.loyverse_customer_id,
               c.loyverse_sync_status, c.created_at, false;
      return;

    exception when unique_violation then
      get stacked diagnostics c1 = constraint_name;

      if c1 = 'customers_phone_unique_key' then
        -- El teléfono formal ya pertenece a otro cliente: insertar sin phone
        -- y avisar al frontend para mantener la UX de phoneConflict actual.
        begin
          insert into public.customers (auth_user_id, name, email, email_verified, customer_code)
          values (caller_uid, v_name, v_email, u.email_confirmed_at is not null, new_code)
          returning * into c;

          return query
            select c.id, c.auth_user_id, c.name, v_email, u.email_confirmed_at is not null,
                   c.phone, c.customer_code, c.loyverse_customer_id,
                   c.loyverse_sync_status, c.created_at, true as _conflict_phone;
          return;

        exception when unique_violation then
          get stacked diagnostics c2 = constraint_name;
          if c2 = 'customers_email_unique_key' then
            raise exception 'EMAIL_ALREADY_REGISTERED' using errcode = 'P0001';
          elsif c2 = 'customers_auth_user_id_key' then
            select * into c from public.customers p where p.auth_user_id = caller_uid;
            if c.id is not null then
              return query
                select c.id, c.auth_user_id, c.name, v_email, u.email_confirmed_at is not null,
                       c.phone, c.customer_code, c.loyverse_customer_id,
                       c.loyverse_sync_status, c.created_at, false;
              return;
            end if;
          end if;
          -- Otra colisión (p. ej. código en el reintento sin phone): reintentar.
        end;

      elsif c1 = 'customers_customer_code_key' then
        -- Código ya en uso por otro cliente: reintentar con uno nuevo.
        null;

      elsif c1 = 'customers_auth_user_id_key' then
        -- Un proceso externo creó la fila entre el chequeo y nuestro INSERT:
        -- devolver la fila existente (idempotencia ante escritores "foráneos").
        select * into c from public.customers p where p.auth_user_id = caller_uid;
        if c.id is not null then
          return query
            select c.id, c.auth_user_id, c.name, v_email, u.email_confirmed_at is not null,
                   c.phone, c.customer_code, c.loyverse_customer_id,
                   c.loyverse_sync_status, c.created_at, false;
          return;
        end if;
        raise exception 'Concurrencia al crear el perfil del cliente' using errcode = '08000';

      elsif c1 = 'customers_email_unique_key' then
        -- El email de auth ya está asociado a otra fila de customers:
        -- incoherencia que debe resolver el operador, no colapsar en silencio.
        raise exception 'EMAIL_ALREADY_REGISTERED' using errcode = 'P0001';

      else
        raise;
      end if;
    end;
  end loop;
end;
$function$;

revoke all on function public.ensure_own_customer() from public, anon, service_role;
grant execute on function public.ensure_own_customer() to authenticated;

comment on function public.ensure_own_customer() is
  'Registro/sesión: crea (o devuelve) la fila customers del usuario autenticado.
   Fuente de verdad: auth.users. Ejecutable SOLO por authenticated.';