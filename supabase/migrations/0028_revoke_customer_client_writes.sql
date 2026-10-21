-- ---------------------------------------------------------------
-- 0028_revoke_customer_client_writes.sql
-- Ruta: supabase/migrations/0028_revoke_customer_client_writes.sql
-- Proyecto: App Salmos LC
-- Aplicar con: supabase db push (SOLO autorizado; despliegue controlado).
--
-- DECISIÓN APROBADA (0027 es la pieza aditiva; 0028 cierra la puerta):
--   El cliente (navegador) ya NO escribe customers: toda creación la hace
--   la RPC public.ensure_own_customer() (0027) con SECURITY DEFINER. Este
--   archivo revoca la ESCRITURA DIRECTA residual a anon y authenticated,
--   "a nivel de tabla y de columna cuando corresponda" (fase 3 aprobada).
--
--   * anon:          ha quedado con INSERT/DELETE/TRUNCATE/REFERENCES/
--                    TRIGGER de tabla (default privileges de Supabase).
--                    Se limpia TODO y se deja SOLO SELECT (inofensivo y
--                    conservador; la RLS ya bloquea incluso el SELECT).
--   * authenticated: conserva GRANT por columna de 0008 (INSERT:
--                    auth_user_id, name, email, phone, customer_code,
--                    profile) y de 0023 (UPDATE: name, email, profile).
--                    Se revocan esos grants por columna y se limpia el
--                    resto de la tabla quedando solo table SELECT + RLS.
--   * service_role / postgres: intactos (lo usan las Edge Functions:
--                    loyverse-customers, auth-phone-login, ...).
--   * Políticas RLS y el trigger handle_new_user NO se tocan.
--
-- COMPROBACIÓN EFECTIVA (has_table_privilege / has_column_privilege,
-- ver tests/0028-revoke-customer-client-writes.test.mjs):
--   anon:            SELECT únicamente.
--   authenticated:   SELECT únicamente (ni INSERT ni UPDATE por columna).
--   service_role:    CUALQUIER operación (mantiene DEFAULT + grants).
--   public.ensure_own_customer(): EXECUTE solo authenticated → el REGISTRO
--   completo sigue funcionando por el camino nuevo (0027).
--
-- ROLLBACK: revertir estas líneas (volver a otorgar las columnas de 0008
-- y 0023 a authenticated y el INSERT de tabla a anon):
--   grant insert (auth_user_id, name, email, phone, customer_code, profile)
--         on public.customers to authenticated;
--   grant update (name, email, profile) on public.customers to authenticated;
--   grant insert, select, update, delete, truncate, references, trigger
--         on public.customers to anon;
--   grant select on public.customers to authenticated;  -- (si se degradó)
-- ---------------------------------------------------------------

-- anon: solo SELECT (tabla).
revoke all on table public.customers from anon;
grant select on table public.customers to anon;

-- authenticated: revocar los grants por columna Y limpiar la tabla sin degradar SELECT.
revoke insert (auth_user_id, name, email, phone, customer_code, profile)
  on public.customers from authenticated;
revoke update (name, email, profile) on public.customers from authenticated;
revoke insert, update, delete, truncate, references, trigger
  on table public.customers from authenticated;

comment on table public.customers is
  'Escritura de clientes SOLO vía public.ensure_own_customer() (0027) o service_role. anon/authenticated: SELECT por RLS.';