-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0008: endurecimiento de identidad customers.
-- Ruta: supabase/migrations/0008_customers_identity_hardening.sql
-- Aplicar con: supabase db push  (después de 0007)
--
-- H1 (el cliente deja de escribir columnas internas de Loyverse):
--   * Se revoca de `authenticated` el INSERT/UPDATE/DELETE genérico sobre
--     `customers` y se re-concede solo lo que el frontend necesita:
--       SELECT  (todas las columnas)
--       INSERT  (auth_user_id, name, email, phone, customer_code, profile)
--       UPDATE  (name, email, phone, profile)
--   * Las columnas internas loyverse_sync_claim, loyverse_sync_claim_at,
--     loyverse_sync_status y loyverse_customer_id quedan FUERA del grant:
--     solo la Edge Function `loyverse-customers` las escribe, con su
--     cliente service_role tras validar el JWT del dueño de la fila.
--
-- C4 (identidad de contacto única y no mutable por el cliente):
--   * UNIQUEs funcionales parciales sobre email y teléfono normalizados
--     (btrim(lower(email)) y dígitos sin símbolos) que ignoran filas sin
--     valor. La auditoría previa confirmó 0 duplicados antes de crearlos.
--   * email_verified deja de escribirlo el cliente (la autoridad de la
--     identidad es GoTrue vía user.email; el trigger de mantenimiento
--     keep_customers_email_in_sync se difiere).
--   * Políticas RLS explícitas por operación (mismo alcance auth.uid() =
--     auth_user_id) en lugar de la única policy `customers_own_all`.
--
-- La tabla customer_sync_events NO se toca (sus grants/policies viven).
-- NO se crea aquí el trigger keep_customers_email_in_sync (diferido).
-- ---------------------------------------------------------------

-- 1) Unicidad de identidad de contacto (C4). Excluyen NULL y vacíos para
--    que un cliente sin email/teléfono no bloquee al resto de la tabla.
create unique index if not exists customers_email_unique_key
  on public.customers (btrim(lower(email)))
  where email is not null and btrim(lower(email)) <> '';

create unique index if not exists customers_phone_unique_key
  on public.customers (regexp_replace(phone, '\D', '', 'g'))
  where phone is not null and regexp_replace(phone, '\D', '', 'g') <> '';

-- 2) Privilegios mínimos del frontend (H1). service_role conserva todos
--    sus privilegios: es quien escribe las columnas internas loyverse_*.
revoke insert, update, delete on public.customers from authenticated;

grant select on public.customers to authenticated;
grant insert (auth_user_id, name, email, phone, customer_code, profile)
  on public.customers to authenticated;
grant update (name, email, phone, profile)
  on public.customers to authenticated;

-- 3) Políticas RLS por operación (sustituyen a `customers_own_all`).
drop policy if exists "customers_own_all" on public.customers;

create policy "customers_select" on public.customers
  for select to authenticated
  using (auth.uid() = auth_user_id);

create policy "customers_insert" on public.customers
  for insert to authenticated
  with check (auth.uid() = auth_user_id);

create policy "customers_update" on public.customers
  for update to authenticated
  using (auth.uid() = auth_user_id)
  with check (auth.uid() = auth_user_id);