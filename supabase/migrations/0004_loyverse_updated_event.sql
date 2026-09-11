-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0004: evento de auditoría `loyverse_updated`.
-- Ruta: supabase/migrations/0004_loyverse_updated_event.sql
-- Aplicar con: supabase db push  (o pegar en el SQL Editor)
--
-- La tabla `customer_sync_events` (0001) restringe `event_type` con una
-- CHECK que no incluye `loyverse_updated`. Esta migración amplía la CHECK
-- (drop + add, sin datos que migrar: es una expansión no destructiva).
-- No toca 0003 (ya aplicada en remoto).
-- ---------------------------------------------------------------

alter table public.customer_sync_events
  drop constraint customer_sync_events_event_type_check;

alter table public.customer_sync_events
  add constraint customer_sync_events_event_type_check
  check (
    event_type in (
      'loyverse_linked',
      'loyverse_created',
      'loyverse_already_linked',
      'loyverse_conflict',
      'loyverse_error',
      'loyverse_updated'
    )
  );