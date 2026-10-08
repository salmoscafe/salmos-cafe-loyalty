-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0025: formato E.164 MX obligatorio en customers.phone.
-- Ruta: supabase/migrations/0025_customers_phone_e164_mx_check.sql
-- Aplicar con: supabase db push — SOLO con aprobación.
--
-- Solo esquema: NO modifica, inserta ni borra filas.
--
-- customers.phone pasa a ser NULL o '+52' seguido de exactamente 10
-- dígitos ASCII. Es equivalente a canonical_mx_phone(phone) = phone y a
-- la salida de toE164Mx() del frontend, pero NO llama a la función:
-- canonical_mx_phone no tiene EXECUTE para anon/authenticated (0022) y
-- un CHECK que la llamara rompería el INSERT de ensureCustomerProfile.
--
-- Unicidad: con este CHECK, customers_phone_unique_key (0008, sobre los
-- dígitos) equivale a unicidad del valor canónico. El índice NO se toca:
-- ensureCustomerProfile identifica el conflicto por su nombre.
--
-- ADD CONSTRAINT valida todas las filas existentes bajo ACCESS EXCLUSIVE
-- dentro de la misma sentencia; si alguna no cumple, falla sin efectos.
-- Rollback: alter table public.customers
--             drop constraint customers_phone_e164_mx_check;
-- ---------------------------------------------------------------
do $$
declare
  v_bad int;
begin
  perform set_config('lock_timeout', '5s', true);

  select count(*) into v_bad
    from public.customers
   where phone is not null
     and phone !~ '^\+52[0-9]{10}$';
  if v_bad > 0 then
    raise exception '0025 abortada: % customers con teléfono fuera de E.164 MX; no se agrega el CHECK', v_bad;
  end if;

  alter table public.customers
    add constraint customers_phone_e164_mx_check
    check (phone is null or phone ~ '^\+52[0-9]{10}$');
end;
$$;

comment on constraint customers_phone_e164_mx_check on public.customers is
  '0025: phone es NULL o E.164 MX exacto (+52 + 10 dígitos). Equivale a canonical_mx_phone(phone) = phone sin depender de esa función privada.';
