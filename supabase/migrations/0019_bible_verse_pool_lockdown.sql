-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0019: bible_verse_pool solo interna.
-- Ruta: supabase/migrations/0019_bible_verse_pool_lockdown.sql
-- Aplicar con: supabase db push  (después de 0018) — SOLO con aprobación.
--
-- Problema (auditoría 2026-10-07):
--   public.bible_verse_pool (0011) se creó SIN RLS. Con los default
--   privileges de Supabase, anon y authenticated tenían SELECT, INSERT,
--   UPDATE y DELETE sobre la tabla vía /rest/v1/bible_verse_pool:
--   cualquiera podía vaciar el pool (las visitas nuevas quedarían con
--   verse_id NULL) o meter ids fuera del dataset de Salmos.
--
-- Modelo de acceso (determinado por sus consumidores reales):
--   * Único lector: public.register_visit_with_receipt (0011/0015),
--     SECURITY DEFINER, owner postgres → lee la tabla como owner; no
--     depende de grants ni de RLS del caller.
--   * El frontend NO la consulta: el texto de los versículos vive en el
--     dataset local (src/data/bible-verses.json + TICKET_VERSE_IDS en
--     receiptsSyncCore.js). Los ids del pool no son datos públicos que
--     la app necesite leer de la base.
--   * Mantenimiento del pool: por migración (rol postgres).
--   → Tabla INTERNA: sin acceso para anon/authenticated; service_role
--     conserva solo lectura (diagnóstico); escrituras solo por migración.
--
-- Qué NO cambia: los 49 ids, la asignación aleatoria de verse_id, la
-- firma de las RPCs. Idempotente.
-- ---------------------------------------------------------------

alter table public.bible_verse_pool enable row level security;
-- Sin policies: anon/authenticated no ven ni escriben filas aunque
-- alguien vuelva a otorgar privilegios por error (defensa en profundidad).

revoke all on table public.bible_verse_pool from public, anon, authenticated;
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.bible_verse_pool from service_role;
grant select on table public.bible_verse_pool to service_role;

comment on table public.bible_verse_pool is
  'Ids de pasajes elegibles para el ticket de fidelidad: texto <= 160 chars y <= 3 líneas (límites de psalms.js). Si el dataset cambia, actualizar este pool (por migración) y TICKET_VERSE_IDS en receiptsSyncCore.js. 0019: tabla interna — RLS sin policies, sin acceso anon/authenticated; service_role solo SELECT; la lee register_visit_with_receipt (SECURITY DEFINER).';
