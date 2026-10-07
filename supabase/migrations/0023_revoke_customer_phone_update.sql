-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0023: el cliente ya no puede cambiar su teléfono.
-- Ruta: supabase/migrations/0023_revoke_customer_phone_update.sql
-- Aplicar con: supabase db push — SOLO con aprobación.
--
-- Objetivo: customers.phone es la fuente oficial del teléfono (login por
-- teléfono, phone_is_registered, Loyverse). Hasta ahora el propio cliente
-- podía reescribirlo sin verificación vía PostgREST
-- (PATCH /rest/v1/customers?…  →  grant update (…, phone, …) de 0008),
-- lo que permitía "tomar" números libres después del registro.
--
-- Estado previo (0008 + defaults de Supabase):
--   * authenticated: SELECT; INSERT (auth_user_id, name, email, phone,
--     customer_code, profile); UPDATE (name, email, phone, profile) a
--     nivel COLUMNA; policy customers_update (auth.uid() = auth_user_id).
--   * anon: privilegios de tabla por defecto (incluye UPDATE) — RLS ya lo
--     bloqueaba (no hay policy para anon), pero el GRANT existe.
--
-- Cambio (mínimo, solo grants; no toca policies ni RLS):
--   * authenticated: se reconstruye el UPDATE por columnas SIN phone →
--     UPDATE (name, email, profile). Se hace con revoke a nivel tabla +
--     grant por columnas para que el resultado sea exacto aunque alguna
--     vez se haya otorgado UPDATE de tabla completa (en ese caso un
--     revoke solo de la columna no surtiría efecto).
--   * anon: se revoca UPDATE (ninguna pantalla actualiza customers sin
--     sesión; defensa en profundidad además de RLS).
--   * INSERT no cambia: la creación inicial del perfil
--     (ensureCustomerProfile) sigue pudiendo fijar el teléfono.
--   * service_role no cambia: los cambios futuros de teléfono serán por
--     backend (Staff/Admin y, después, verificación SMS).
--
-- Idempotente (REVOKE/GRANT repetibles).
-- ---------------------------------------------------------------

revoke update on table public.customers from anon;

revoke update on table public.customers from authenticated;
grant update (name, email, profile) on public.customers to authenticated;
