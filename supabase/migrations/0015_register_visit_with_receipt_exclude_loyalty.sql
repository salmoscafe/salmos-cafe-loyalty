-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0015: barrera defensiva excluded_customer en
-- register_visit_with_receipt (defensa en profundidad).
-- Ruta: supabase/migrations/0015_register_visit_with_receipt_exclude_loyalty.sql
-- Aplicar con: supabase db push  (después de 0014 — asume
--   public.customers.exclude_loyalty, creado en 0014)
--
-- Propósito:
--   register_visit_with_receipt es la entrada ESPECÍFICA del sync de
--   Loyverse. La primera barrera vive en receiptsSyncCore.decideReceiptAction
--   (reason 'staff_customer', así la RPC ni se invoca en el camino normal).
--   Esta segunda barrera garantiza que, aunque un receipt llegue directo a
--   register_visit_with_receipt con p_source='loyverse' y un cliente con
--   exclude_loyalty=true, NUNCA se registre la visita en la base.
--
-- Restricciones explicitas de la feature:
--   * NO toca register_visit (el flujo manual source='manual' queda intacto).
--   * La barrera SOLO aplica cuando p_source = 'loyverse'.
--   * No cambia rewards, ciclos, límite diario, idempotencia,
--     external_sale_id ni cancelaciones: es un raise P0001 ANTES de
--     llamar a register_visit, con el mismo patrón de error del proyecto.
--   * El motivo es identificable como 'excluded_customer' en el mensaje
--     (P0001 → counts.business_skipped + conflicts del sync, sin bloquear
--     el watermark, igual que cualquier otro P0001).
-- ---------------------------------------------------------------

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
  -- Barrera defensiva (0015): clients exclusivamente en el sync de
  -- Loyverse. register_visit (flujo manual) NO se toca.
  if p_source = 'loyverse'
     and exists (
       select 1
         from public.customers c
        where c.id = p_customer_id
          and c.exclude_loyalty = true
     )
  then
    raise exception 'excluded_customer: el cliente no participa en el loyalty sync (customers.exclude_loyalty).'
      using errcode = 'P0001';
  end if;

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
  'RPC del sync de receipts: barrera excluded_customer (0015) cuando p_source=loyverse y customers.exclude_loyalty=true (P0001); luego llama a register_visit (0007, reglas intactas) y persiste el detalle del ticket (items normalizados + receipt_date de Loyverse + verse_id asignado al crear la visita / conservado al resincronizar). Solo service_role.';

-- ====================================================================
-- Grants — únicamente service_role (la Edge Function)
-- ====================================================================
revoke all on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) from public;

grant execute on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) to service_role;