-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0006: claim atómico de sincronización Loyverse.
-- Ruta: supabase/migrations/0006_loyverse_sync_claim.sql
-- Aplicar con: supabase db push  (después de 0005)
--
-- La Edge Function `loyverse-customers` puede recibir dos invocaciones
-- concurrentes del MISMO usuario (doble pestaña / doble submit antes del
-- guard single-flight / reintento de sesión). Antes de esta migración las
-- dos podían cruzar sus búsquedas y crear CLIENTES DUPLICADOS en Loyverse
-- (el fix b0351f5 solo cubre el caso en que el segundo create FALLA).
--
-- Estas columnas implementan un bloqueo server-side por fila:
--   * loyverse_sync_claim     uuid          → token del holder (NULL = libre).
--   * loyverse_sync_claim_at  timestamptz   → instante en que se tomó el
--     claim; habilita la expiración segura de claims abandonados
--     (crash / red caída / tab cerrado).
--
-- Exclusión mutua (adquisición atómica en UNA sentencia; ver .or() en
-- la Edge Function, que produce exactamente este UPDATE):
--   update public.customers
--      set loyverse_sync_claim    = <uuid>,
--          loyverse_sync_claim_at = now()
--    where auth_user_id = <uid>
--      and (loyverse_sync_claim is null
--           or loyverse_sync_claim_at < now() - interval '10 minutes')
--    returning auth_user_id;
--   → un segundo UPDATE concurrente espera al primero (lock de fila en
--     Postgres) y re-evalúa el WHERE sobre el commit: con claim vigente
--     no matchea (0 filas) → el perdedor responde "sync en curso" sin
--     llegar a llamar a la API de Loyverse.
--
-- Liberación (SOLO el dueño del token; nunca pisa un claim ajeno):
--   update public.customers
--      set loyverse_sync_claim    = null,
--          loyverse_sync_claim_at = null
--    where auth_user_id = <uid> and loyverse_sync_claim = <uuid>;
--
-- Expiración segura (claims abandonados):
--   * El lease de 10 minutos empieza en loyverse_sync_claim_at y NO se
--     reanuda en lecturas posteriores: un holder lento conserva su claim
--     salvo en el techo del lease; un claim huérfano se recupera pasado
--     ese lapso (la siguiente adquisición lo toma).
--   * Tras un robo legítimo (claim vencido), la liberación del holder
--     antiguo NO borra el claim nuevo porque el WHERE exige el token
--     específico que ya no está presente.
--
-- No se toca RLS ni grants: la columna vive en `customers`, y la póliza
-- existente (customers_own_all: auth.uid() = auth_user_id) ya autoriza el
-- UPDATE del dueño; la Edge Function usa el JWT del usuario.
-- ---------------------------------------------------------------

alter table public.customers
  add column loyverse_sync_claim uuid,
  add column loyverse_sync_claim_at timestamptz;

comment on column public.customers.loyverse_sync_claim is
  'Token UUID del claim de sincronización Loyverse. NULL = nadie sincronizando. Solo la Edge Function lo manipula, con el JWT del dueño de la fila.';

comment on column public.customers.loyverse_sync_claim_at is
  'Instante en que se tomó loyverse_sync_claim. Habilita la expiración segura: un claim de más de 10 minutos se considera abandonado y otra invocación puede tomarlo; la liberación sigue siendo exclusiva del token original.';