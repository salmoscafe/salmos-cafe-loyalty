-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0010: detalle del receipt en la visita
-- Ruta: supabase/migrations/0010_loyverse_receipt_details.sql
-- Aplicar con: supabase db push  (después de 0009)
--
-- La vista Cliente reproduce el ticket (recibo) real del POS
-- (referencia: salmos-activity-demo.html). Para eso necesita el
-- desglose que hoy NO se guarda:
--   1) loyalty_visits.items        jsonb        → line_items del receipt
--      de Loyverse (nombre, cantidad, precio-unitario y total por línea,
--      normalizados por receiptsSyncCore). Se guarda el JSON tal cual
--      llegó normalizado; NULL = receipt sin detalle (visitas anteriores
--      a esta migración / registros manuales).
--   2) loyalty_visits.receipt_date timestamptz → instante REAL de la
--      compra (receipt_date de Loyverse). created_at sigue siendo el
--      instante de sincronización; el ticket muestra receipt_date.
--
-- Estas columnas son datos del ticket, NO reglas de negocio: no se toca
-- register_visit (reglas/validaciones intactas). El registro con detalle
-- lo hace la RPC NUEVA `register_visit_with_receipt`:
--   * valida TODO con register_visit (idempotencia, mínimo $50, 1 por día,
--     ciclo, reward) — el negocio sigue viviendo exactamente donde estaba;
--   * y SOLO después persiste items/receipt_date sobre la visita
--     registrada (nueva o reutilizada por idempotencia).
-- La Edge Function `loyverse-receipts-sync` pasa a invocar esta RPC.
--
-- Seguridad: igual que las demás — solo service_role (la Edge). La
-- lectura del cliente ya está cubierta por la policy de RLS de 0002
-- (loyalty_visits_client_select); las columnas nuevas no la extienden.
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) Columnas de detalle en loyalty_visits
-- ====================================================================
alter table public.loyalty_visits
  add column items        jsonb,
  add column receipt_date timestamptz;

comment on column public.loyalty_visits.items is
  'line_items del receipt de Loyverse normalizados por el sync: [{ name, quantity, unit_price, total }]. NULL = ticket sin detalle (registros previos a 0010 o manuales).';

comment on column public.loyalty_visits.receipt_date is
  'Instante real de la compra (receipt_date de Loyverse). created_at sigue siendo el instante de sincronización; la vista Cliente muestra receipt_date.';

-- ====================================================================
-- 2) register_visit_with_receipt: register_visit + detalle del ticket
-- ====================================================================
-- No reimplementa ni copia el negocio: delega TODO en
-- public.register_visit (0007) y, sobre el resultado (visita nueva o
-- reutilizada por idempotencia), persiste items/receipt_date. Así las
-- reglas de 0005/0007 (mínimo $50, 1 visita/día, ciclo, reward,
-- idempotencia por external_sale_id UNIQUE) quedan EXACTAMENTE iguales.
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
           receipt_date = coalesce(p_receipt_date, receipt_date)
     where id = v_visit_id;
  end if;

  return v_result;
end;
$$;

comment on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) is
  'RPC del sync de receipts: llama a register_visit (0007, reglas intactas) y persiste el detalle del ticket (items normalizados + receipt_date de Loyverse) sobre la visita registrada o reutilizada. Solo service_role.';

-- ====================================================================
-- 3) Grants — únicamente service_role (la Edge Function)
-- ====================================================================
revoke all on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) from public;

grant execute on function public.register_visit_with_receipt(uuid,text,numeric,date,text,text,text,text,text,jsonb,timestamptz) to service_role;