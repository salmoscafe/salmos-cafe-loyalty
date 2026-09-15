-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0011: versículo asignado por visita
-- Ruta: supabase/migrations/0011_visit_verse_id.sql
-- Aplicar con: supabase db push  (después de 0009 y 0010)
--
-- PROBLEMA que resuelve: hasta 0010, el ticket mostraba el pasaje
-- "del día" calculado por fecha (TicketVerse → getDailyShortPassage).
-- Eso hacía que TODOS los tickets de un mismo día mostraran el MISMO
-- versículo. A partir de esta migración, cada visita recibe un
-- verse_id ALEATORIO al crearse y lo conserva para siempre: cada
-- ticket muestra el versículo que le tocó en su registro, aunque se
-- vuelva a sincronizar el mismo recibo.
--
-- Diseño (regla de negocio del ticket, NO de lealtad):
--   1) loyalty_visits.verse_id int  → id del pasaje en
--      src/data/bible-verses.json (ids estables 1..150). NULL SOLO en
--      visitas históricas previas a 0011; el ticket cae al versículo
--      del día como fallback (comportamiento anterior).
--   2) bible_verse_pool             → ids de pasajes ELIGIBLES para un
--      ticket: los que cumplen los límites del ticket (texto <= 160
--      chars y <= 3 líneas, igual que MAX_TICKET_CHARS/MAX_TICKET_LINES
--      de psalms.js). La selección aleatoria NUNCA saldrá de aquí, así
--      el ticket conserva su diseño compacto. Fuente: dataset actual
--      (49 pasajes); si el dataset cambiara, hay que actualizar el pool.
--      El frontend MITIGA la deriva: un verse_id que no exista (o que
--      no se encuentre en el dataset) cae al versículo del día.
--   3) register_visit_with_receipt se actualiza (misma firma de 0010,
--      sin parámetros nuevos: el RPC se mantiene 100% compatible con
--      la Edge Function) para asignar verse_id sobre la visita:
--        verse_id = coalesce(verse_id, p_verse_id, random del pool)
--      * visita NUEVA (verse_id null)  → p_verse_id si se pasó, si no
--        se toma uno aleatorio del pool (crypto de Postgres:
--        ORDER BY gen_random_uuid()).
--      * visita REUTILIZADA (idempotencia por external_sale_id) →
--        coalesce conserva el verse_id existente: resincronizar el
--        mismo recibo NUNCA cambia el versículo ya asignado. Si la
--        visita histórica aún no tenía verse_id, se llena en el
--        primer re-sync y queda fijo desde ahí.
--   La aleatoriedad vive en el REGISTRO (servidor), nunca en el render
--   de React. El core puro (receiptsSyncCore) expone
--   pickRandomVerseId/resolveVerseId como espejo testeable de esta
--   regla; la BD es la fuente de verdad.
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) Columna verse_id en loyalty_visits (NULL = visita histórica)
-- ====================================================================
alter table public.loyalty_visits
  add column verse_id integer;

comment on column public.loyalty_visits.verse_id is
  'id del pasaje (src/data/bible-verses.json) asignado al crear la visita: versículo FIJO de ese ticket. NULL = visita histórica previa a 0011 (el ticket cae al versículo del día). Nunca se regenera al resincronizar (coalesce en register_visit_with_receipt).';

-- ====================================================================
-- 2) Pool de versículos elegibles para el ticket (pasajes cortos)
-- ====================================================================
create table public.bible_verse_pool (
  verse_id integer primary key
);

insert into public.bible_verse_pool (verse_id) values
  (2), (5), (8), (11), (15), (16), (21), (26), (28), (29),
  (34), (38), (45), (46), (47), (51), (55), (58), (60), (61),
  (62), (72), (73), (77), (78), (80), (82), (91), (92), (94),
  (96), (98), (102), (103), (105), (106), (107), (112), (119), (123),
  (124), (127), (133), (134), (136), (137), (138), (139), (145);

comment on table public.bible_verse_pool is
  'Ids de pasajes elegibles para el ticket de fidelidad: texto <= 160 chars y <= 3 líneas (límites de psalms.js). Si el dataset cambia, actualizar este pool y TICKET_VERSE_IDS en receiptsSyncCore.js.';

-- ====================================================================
-- 3) register_visit_with_receipt: asigna verse_id (misma firma que
--    0010, sin parámetros nuevos → la Edge Function no cambia).
-- ====================================================================
drop function if exists public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz);

create or replace function public.register_visit_with_receipt(
  p_customer_id      uuid,
  p_external_sale_id text,
  p_amount           numeric,
  p_visit_date       date        default null,
  p_store_id         text        default null,
  p_employee_id      text        default null,
  p_source           text        default 'manual',
  p_actor_id         text        default 'system',
  p_actor_role       text        default 'staff',
  p_items            jsonb       default null,
  p_receipt_date     timestamptz default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_result   jsonb;
  v_visit_id uuid;
begin
  v_result := public.register_visit(
    p_customer_id,
    p_external_sale_id,
    p_amount,
    p_visit_date,
    p_store_id,
    p_employee_id,
    p_source,
    p_actor_id,
    p_actor_role
  );

  -- register_visit siempre devuelve visit_id (nueva o reutilizada).
  v_visit_id := (v_result ->> 'visit_id')::uuid;
  if v_visit_id is not null then
    update public.loyalty_visits
       set items        = coalesce(p_items, items),
           receipt_date = coalesce(p_receipt_date, receipt_date),
           verse_id     = coalesce(
                            verse_id,            -- re-sync: conserva el ya asignado
                            (select verse_id      -- visita nueva: aleatorio del pool
                               from public.bible_verse_pool
                              order by gen_random_uuid()
                              limit 1)
                          )
     where id = v_visit_id;
  end if;

  return v_result;
end;
$$;

comment on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) is
  'RPC del sync de receipts: llama a register_visit (0007, reglas intactas) y persiste el detalle del ticket (items normalizados + receipt_date de Loyverse + verse_id asignado al crear la visita / conservado al resincronizar). Solo service_role.';

-- ====================================================================
-- 4) Grants — únicamente service_role (la Edge Function)
-- ====================================================================
revoke all on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) from public;

grant execute on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) to service_role;