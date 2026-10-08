-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0026: customer_sync_events solo la escribe el
-- backend (service_role). Fase 2A del hardening de customer_sync_events.
-- Ruta: supabase/migrations/0026_customer_sync_events_backend_only.sql
-- Aplicar con: supabase db push — SOLO con aprobación y SOLO después de
-- desplegar y verificar la versión de loyverse-customers que escribe los
-- eventos con service_role (la versión previa escribía con el JWT del
-- usuario e ignoraba el error del INSERT: aplicar esta migración antes
-- perdería eventos en silencio).
--
-- Estado previo (0001 + defaults de Supabase, sin grants explícitos):
--   * anon y authenticated: SELECT, INSERT, UPDATE, DELETE, TRUNCATE,
--     REFERENCES, TRIGGER (default privileges del esquema public).
--   * policy sync_events_own_all FOR ALL TO authenticated
--     (auth.uid() = auth_user_id): el dueño podía insertar, modificar y
--     borrar sus propios eventos (incluidos los escritos por service_role).
--
-- Cambio (mínimo; solo grants y policies):
--   * anon: sin privilegios sobre la tabla.
--   * authenticated: solo SELECT (sus filas, por RLS). Sin INSERT, UPDATE,
--     DELETE, TRUNCATE (no lo cubre RLS), REFERENCES ni TRIGGER.
--   * La policy FOR ALL se reemplaza por una solo FOR SELECT: sin policy
--     de escritura, un GRANT accidental futuro no reabre la escritura
--     (INSERT lo rechaza RLS; UPDATE/DELETE no ven filas).
--   * service_role y postgres NO cambian (service_role es el writer).
--   * No toca columnas, constraints, índices, event_type, datos ni default
--     privileges.
--
-- Idempotente (REVOKE/GRANT repetibles; DROP POLICY IF EXISTS antes del
-- CREATE). Cualquier estado parcial es igual o más restrictivo que el
-- final (sin policy, el SELECT propio devuelve 0 filas).
-- Rollback: migración nueva que restaure grants y sync_events_own_all;
-- nunca editar esta.
-- ---------------------------------------------------------------

revoke all on table public.customer_sync_events from anon;

revoke insert, update, delete, truncate, references, trigger
  on table public.customer_sync_events from authenticated;

grant select
  on table public.customer_sync_events
  to authenticated;

drop policy if exists "sync_events_own_all"
  on public.customer_sync_events;

drop policy if exists "sync_events_select_own"
  on public.customer_sync_events;

create policy "sync_events_select_own"
  on public.customer_sync_events
  for select
  to authenticated
  using (auth.uid() = auth_user_id);
