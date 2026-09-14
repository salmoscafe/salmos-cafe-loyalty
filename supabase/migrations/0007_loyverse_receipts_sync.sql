-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0007: sync de receipts Loyverse (Fase D2-v1).
-- Ruta: supabase/migrations/0007_loyverse_receipts_sync.sql
-- Aplicar con: supabase db push  (después de 0006)
--
-- Esta migración habilita la Edge Function `loyverse-receipts-sync`:
--   1) loyalty_visits.triggered_reward_id → resuelve la DECISIÓN
--      PENDIENTE de 0005: la visita que generó la recompensa queda
--      EXPLÍCITA (antes se derivaba por max(created_at)).
--   2) cancel_visit usa triggered_reward_id cuando existe (fallback a
--      la derivación histórica para filas pre-0007).
--   3) cancel_visit_by_sale: wrapper para cancelar por external_sale_id
--      (el receipt cancelado llega sin conocer el UUID de la visita);
--      no-op idempotente si la visita nunca se registró.
--   4) loyverse_sync_state: tabla de checkpoint incremental del sync
--      (watermark updated_at, cursor, claim atomico server-side, estado
--      y error de la ultima corrida), estilo 0006.
--
-- Seguridad:
--   register_visit / cancel_visit / visit_summary se recrean con
--   CREATE OR REPLACE (mismas firmas y grants de 0005; aquí se
--   re-declaran revoke/grant por robustez). cancel_visit_by_sale y la
--   tabla loyverse_sync_state quedan EXCLUSIVAMENTE para service_role
--   (Edge Function): RLS habilitada sin políticas (igual que audit_logs).
--
-- Fuera de alcance (fase posterior): deploy, cron, secrets, frontend.
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) loyalty_visits.triggered_reward_id
-- ====================================================================
alter table public.loyalty_visits
  add column triggered_reward_id uuid references public.rewards(id) on delete set null;

-- Lecturas "visitas generadoras" (cancel/reportes): índice parcial.
create index loyalty_visits_triggered_reward_idx
  on public.loyalty_visits (triggered_reward_id)
  where triggered_reward_id is not null;

comment on column public.loyalty_visits.triggered_reward_id is
  'Id de la recompensa que ESTA visita generó (la visita que empujó el conteo activo a required_visits). Explicita la decisión pendiente de 0005 (antes: derivación por max(created_at) bajo serialización). NULL = la visita no generó recompensa.';

-- ====================================================================
-- 2) visit_summary: expone el vínculo generador (diagnóstico)
-- ====================================================================
create or replace function public.visit_summary(p_visit_id uuid)
returns jsonb
language sql
security definer
set search_path = public
stable
as $$
  select jsonb_build_object(
    'ok',             true,
    'reused',         false,
    'visit_id',       v.id,
    'sale_id',        v.external_sale_id,
    'visit_date',     v.visit_date,
    'status',         v.status,
    'amount',         v.amount,
    'source',         v.source,
    'store_id',       v.store_id,
    'employee_id',    v.employee_id,
    'triggered_reward_id', v.triggered_reward_id,
    'cycle_id',       v.cycle_id,
    'cycle_number',   cy.cycle_number,
    'required_visits', cy.required_visits,
    'active_visits',  (select count(*)
                         from public.loyalty_visits av
                        where av.cycle_id = v.cycle_id
                          and av.status = 'active'),
    'cycle_status',   cy.status,
    'reward_id',      r.id,
    'reward_label',   r.label,
    'reward_status',  r.status,
    'reward_max_value',    r.max_value,
    'reward_earned_at',    r.earned_at,
    'reward_expires_at',   r.expires_at
  )
  from public.loyalty_visits v
  join public.loyalty_cycles cy on cy.id = v.cycle_id
  left join public.rewards r    on r.cycle_id = cy.id
  where v.id = p_visit_id;
$$;

-- ====================================================================
-- 3) register_visit: registra la visita generadora de forma explícita
-- ====================================================================
-- Idéntico al de 0005 salvo por una línea: al alcanzar required_visits
-- y obtener/revivir la recompensa, se graba v.triggered_reward_id en la
-- visita recién insertada (la que empujó el conteo a required_visits).
create or replace function public.register_visit(
  p_customer_id     uuid,
  p_external_sale_id text,
  p_amount          numeric,
  p_visit_date      date     default null,
  p_store_id        text     default null,
  p_employee_id     text     default null,
  p_source          text     default 'manual',
  p_actor_id        text     default 'system',
  p_actor_role      text     default 'staff'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit_date   date;
  v_cycle        public.loyalty_cycles%rowtype;
  v_visit_id     uuid;
  v_reward       public.rewards%rowtype;
  v_existing     public.loyalty_visits%rowtype;
  v_active_visits integer;
begin
  -- ---------------------------------------------------------------
  -- Validación de actor (defense-in-depth; la Edge Function ya lo hace).
  -- ---------------------------------------------------------------
  perform public.assert_loyalty_actor(p_actor_id, p_actor_role, p_customer_id);

  -- ---------------------------------------------------------------
  -- Origen de la visita.
  -- ---------------------------------------------------------------
  if p_source is null or p_source not in ('manual', 'loyverse') then
    raise exception 'Origen de visita inválido.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- external_sale_id es requerido (clave de idempotencia).
  -- ---------------------------------------------------------------
  if p_external_sale_id is null or btrim(p_external_sale_id) = '' then
    raise exception 'external_sale_id es requerido.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Cliente existente.
  -- ---------------------------------------------------------------
  if not exists (select 1 from public.customers where id = p_customer_id) then
    raise exception 'Cliente no encontrado.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Monto mínimo (CHECK de la tabla es la segunda barrera).
  -- ---------------------------------------------------------------
  if p_amount is null or p_amount < 50 then
    raise exception 'El monto mínimo para generar una visita es $50 MXN.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Fecha de visita: validación y default.
  -- La Edge Function de receipts calcula la fecha de negocio del recibo
  -- en America/Tijuana (nunca UTC, nunca el navegador).
  -- ---------------------------------------------------------------
  v_visit_date := coalesce(p_visit_date, current_date);
  if v_visit_date > current_date then
    raise exception 'La fecha de visita no puede estar en el futuro.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Idempotencia: si external_sale_id ya existe, devolver la visita
  -- existente sin duplicar. Funciona incluso bajo concurrencia gracias
  -- al UNIQUE en loyalty_visits.external_sale_id.
  -- ---------------------------------------------------------------
  select * into v_existing
    from public.loyalty_visits
   where external_sale_id = p_external_sale_id;
  if found then
    return (select public.visit_summary(v_existing.id) || '{"reused":true}'::jsonb);
  end if;

  -- ---------------------------------------------------------------
  -- Pre-check determinístico del límite diario.
  -- ---------------------------------------------------------------
  if exists (
    select 1
      from public.loyalty_visits
     where customer_id  = p_customer_id
       and visit_date   = v_visit_date
       and status       = 'active'
  ) then
    raise exception 'Este cliente ya registró una visita válida hoy.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Obtener o crear el ciclo activo (FOR UPDATE serializa).
  -- ---------------------------------------------------------------
  loop
    select * into v_cycle
      from public.loyalty_cycles
     where customer_id = p_customer_id
       and status      = 'active'
     order by started_at desc
     limit 1
     for update;
    exit when found;

    begin
      insert into public.loyalty_cycles (customer_id, cycle_number, status, started_at)
      select p_customer_id, coalesce(max(cycle_number), 0) + 1, 'active', now()
        from public.loyalty_cycles
       where customer_id = p_customer_id;
      continue; -- re-seleccionar para obtener FOR UPDATE
    exception
      when unique_violation then
        continue;
    end;
  end loop;

  -- ---------------------------------------------------------------
  -- Insertar la visita.
  -- ---------------------------------------------------------------
  begin
    insert into public.loyalty_visits (
      customer_id, cycle_id, external_sale_id, amount,
      visit_date, store_id, employee_id, source, status
    ) values (
      p_customer_id, v_cycle.id, p_external_sale_id, p_amount,
      v_visit_date, p_store_id, p_employee_id, p_source, 'active'
    )
    returning id into v_visit_id;
  exception
    when unique_violation then
      select * into v_existing
        from public.loyalty_visits
       where external_sale_id = p_external_sale_id;
      if found then
        return (select public.visit_summary(v_existing.id) || '{"reused":true}'::jsonb);
      end if;
      raise exception 'Este cliente ya registró una visita válida hoy.'
        using errcode = 'P0001';
  end;

  -- ---------------------------------------------------------------
  -- Auditoría de la visita registrada.
  -- ---------------------------------------------------------------
  insert into public.audit_logs (
    actor_id, actor_role, customer_id, cycle_id,
    visit_id, reward_id, sale_id, action, detail
  ) values (
    p_actor_id, p_actor_role, p_customer_id, v_cycle.id,
    v_visit_id, null, p_external_sale_id, 'VISIT_ADDED',
    jsonb_build_object(
      'amount',      p_amount,
      'source',      p_source,
      'store_id',    p_store_id,
      'employee_id', p_employee_id,
      'visit_date',  v_visit_date
    )
  );

  -- ---------------------------------------------------------------
  -- Conteo derivado de loyalty_visits (no contador mutable).
  -- ---------------------------------------------------------------
  select count(*) into v_active_visits
    from public.loyalty_visits
   where cycle_id = v_cycle.id
     and status   = 'active';

  -- ---------------------------------------------------------------
  -- Si se alcanzó required_visits: completar ciclo y crear recompensa.
  -- La recompensa es idempotente gracias al UNIQUE(cycle_id) en rewards.
  -- Si el reward previo del ciclo estaba CANCELLED, se REVIVE a
  -- available con una nueva ventana (equivale a cycle.rewardId=null).
  -- ---------------------------------------------------------------
  if v_active_visits >= v_cycle.required_visits then
    update public.loyalty_cycles
       set status       = 'completed',
           completed_at = now()
     where id = v_cycle.id;

    insert into public.rewards (
      customer_id, cycle_id, label, max_value,
      earned_at, expires_at, status
    ) values (
      v_cycle.customer_id, v_cycle.id, 'Café gratis', 150,
      now(), now() + interval '3 months', 'available'
    )
    on conflict (cycle_id) do update
      set status     = excluded.status,
          earned_at  = excluded.earned_at,
          expires_at = excluded.expires_at
      where public.rewards.status = 'cancelled';

    -- Obtener la recompensa (recién creada, revivida o la existente).
    select * into v_reward
      from public.rewards
     where cycle_id = v_cycle.id;

    -- 0007: marcar la visita generadora. La recompensa disponible ya
    -- existía | se creó | se revivió en esta transacción; la visita
    -- insertada es la que empujó el conteo a required_visits.
    update public.loyalty_visits
       set triggered_reward_id = v_reward.id
     where id = v_visit_id;

    insert into public.audit_logs (
      actor_id, actor_role, customer_id, cycle_id,
      visit_id, reward_id, sale_id, action, detail
    ) values (
      p_actor_id, p_actor_role, p_customer_id, v_cycle.id,
      v_visit_id, v_reward.id, p_external_sale_id, 'REWARD_EARNED',
      jsonb_build_object(
        'required_visits', v_cycle.required_visits,
        'active_visits',   v_active_visits,
        'reward_id',       v_reward.id,
        'triggered_visit_id', v_visit_id,
        'expires_at',      v_reward.expires_at
      )
    );
  end if;

  -- ---------------------------------------------------------------
  -- Retorno: el resumen completo de la visita.
  -- ---------------------------------------------------------------
  return public.visit_summary(v_visit_id);
end;
$$;

-- ====================================================================
-- 4) cancel_visit: usa triggered_reward_id (fallback pre-0007)
-- ====================================================================
-- Idéntico al de 0005 salvo por la identificación de la visita
-- generadora: primero el vínculo explícito (0007), luego la derivación
-- histórica por max(created_at) para filas anteriores a esta migración.
create or replace function public.cancel_visit(
  p_visit_id   uuid,
  p_actor_id   text,
  p_actor_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit       public.loyalty_visits%rowtype;
  v_cycle       public.loyalty_cycles%rowtype;
  v_reward      public.rewards%rowtype;
  v_generator   uuid;
  v_active_after integer;
  v_reverts     boolean := false;
begin
  perform public.assert_loyalty_actor(p_actor_id, p_actor_role);

  -- ---------------------------------------------------------------
  -- Bloquear la visita.
  -- ---------------------------------------------------------------
  select * into v_visit
    from public.loyalty_visits
   where id = p_visit_id
   for update;
  if not found then
    raise exception 'Visita no encontrada.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Idempotencia: si ya está cancelada, devolver sin efectos.
  -- ---------------------------------------------------------------
  if v_visit.status = 'cancelled' then
    return jsonb_build_object(
      'ok',              true,
      'already_cancelled', true,
      'visit_id',        v_visit.id,
      'status',          'cancelled',
      'cycle_id',        v_visit.cycle_id,
      'cycle_status',    (select cy.status from public.loyalty_cycles cy where cy.id = v_visit.cycle_id),
      'active_visits',   (select count(*) from public.loyalty_visits v where v.cycle_id = v_visit.cycle_id and v.status = 'active'),
      'reward',          (select to_jsonb(r) from public.rewards r where r.cycle_id = v_visit.cycle_id)
    );
  end if;

  -- ---------------------------------------------------------------
  -- Bloquear el ciclo asociado.
  -- ---------------------------------------------------------------
  select * into v_cycle
    from public.loyalty_cycles
   where id = v_visit.cycle_id
   for update;
  if not found then
    raise exception 'Ciclo no encontrado.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Si la recompensa del ciclo fue redimida, bloquear la cancelación.
  -- ---------------------------------------------------------------
  select * into v_reward
    from public.rewards
   where cycle_id = v_visit.cycle_id;

  if found and v_reward.status = 'redeemed' then
    raise exception 'No se puede cancelar: la recompensa de esta visita ya fue redimida.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Ciclo completed: solo cancela si la visita es la que generó la
  -- recompensa y esta sigue disponible.
  -- ---------------------------------------------------------------
  if v_cycle.status = 'completed' then
    if not found or v_reward.status <> 'available' then
      raise exception 'No se puede cancelar: el ciclo ya se completó y no hay recompensa disponible para revertir.'
        using errcode = 'P0001';
    end if;

    -- Identificar la visita que generó la recompensa. Con la columna
    -- triggered_reward_id (0007) el vínculo es EXPLÍCITO; para filas
    -- históricas (pre-0007) se conserva la derivación por
    -- max(created_at) bajo la serialización del FOR UPDATE del ciclo.
    select v.id into v_generator
      from public.loyalty_visits v
     where v.triggered_reward_id = v_reward.id
       and v.cycle_id            = v_visit.cycle_id
     limit 1;
    if v_generator is null then
      select v.id into v_generator
        from public.loyalty_visits v
       where v.cycle_id = v_visit.cycle_id
         and v.status   = 'active'
       order by v.created_at desc
       limit 1;
    end if;

    if v_generator is null or v_visit.id <> v_generator then
      raise exception 'No se puede cancelar: el ciclo ya se completó con una recompensa asociada a otra visita.'
        using errcode = 'P0001';
    end if;

    v_reverts := true;
  end if;

  -- ---------------------------------------------------------------
  -- Aplicar reversión.
  -- ---------------------------------------------------------------
  update public.loyalty_visits
     set status       = 'cancelled',
         cancelled_at = now(),
         cancelled_by = p_actor_id
   where id = v_visit.id;

  if v_reverts then
    -- Cancelar la recompensa disponible.
    update public.rewards
       set status = 'cancelled'
     where id = v_reward.id;

    -- Reabrir el ciclo.
    update public.loyalty_cycles
       set status       = 'active',
           completed_at = null
     where id = v_visit.cycle_id;

    insert into public.audit_logs (
      actor_id, actor_role, customer_id, cycle_id,
      visit_id, reward_id, sale_id, action, detail
    ) values (
      p_actor_id, p_actor_role, v_visit.customer_id, v_visit.cycle_id,
      v_visit.id, v_reward.id, v_visit.external_sale_id,
      'REWARD_CANCELLED',
      jsonb_build_object('reward_id', v_reward.id, 'reverted_cycle', true)
    );
  end if;

  insert into public.audit_logs (
    actor_id, actor_role, customer_id, cycle_id,
    visit_id, reward_id, sale_id, action, detail
  ) values (
    p_actor_id, p_actor_role, v_visit.customer_id, v_visit.cycle_id,
    v_visit.id, null, v_visit.external_sale_id,
    'VISIT_REVERTED',
    jsonb_build_object('cancelled_by', p_actor_id, 'reverts_reward', v_reverts)
  );

  -- ---------------------------------------------------------------
  -- Retorno.
  -- ---------------------------------------------------------------
  select count(*) into v_active_after
    from public.loyalty_visits
   where cycle_id = v_visit.cycle_id
     and status   = 'active';

  -- Re-leer ciclo y reward tras las mutaciones para el retorno.
  select * into v_cycle
    from public.loyalty_cycles
   where id = v_visit.cycle_id;

  select * into v_reward
    from public.rewards
   where cycle_id = v_visit.cycle_id;

  return jsonb_build_object(
    'ok',              true,
    'already_cancelled', false,
    'visit_id',        v_visit.id,
    'status',          'cancelled',
    'cycle_id',        v_visit.cycle_id,
    'cycle_status',    v_cycle.status,
    'active_visits',   v_active_after,
    'reward',          (select to_jsonb(r) from public.rewards r where r.cycle_id = v_visit.cycle_id),
    'closed_reward',   v_reverts
  );
end;
$$;

-- ====================================================================
-- 5) cancel_visit_by_sale: cancelar por external_sale_id
-- ====================================================================
-- La Edge Function de receipts ve un receipt CANCELADO sin conocer el
-- UUID de la visita. Este wrapper localiza por external_sale_id
-- (UNIQUE en loyalty_visits) y delega en cancel_visit.
--
-- Idempotente:
--   * Sin visita registrada (el recibo se canceló antes de sincronizarse)
--     → éxito sin efectos (visit_found=false).
--   * Visita ya cancelada → cancel_visit responde already_cancelled.
--   * Reward redimida / ciclo incoherente → P0001 de negocio se propaga.
create or replace function public.cancel_visit_by_sale(
  p_external_sale_id text,
  p_actor_id         text,
  p_actor_role       text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit_id uuid;
begin
  perform public.assert_loyalty_actor(p_actor_id, p_actor_role);

  if p_external_sale_id is null or btrim(p_external_sale_id) = '' then
    raise exception 'external_sale_id es requerido.'
      using errcode = 'P0001';
  end if;

  select id into v_visit_id
    from public.loyalty_visits
   where external_sale_id = p_external_sale_id;

  if not found then
    return jsonb_build_object(
      'ok',               true,
      'visit_found',      false,
      'already_cancelled', false,
      'external_sale_id', p_external_sale_id
    );
  end if;

  return public.cancel_visit(v_visit_id, p_actor_id, p_actor_role);
end;
$$;

comment on function public.cancel_visit_by_sale(text, text, text) is
  'RPC transaccional: cancela la visita identificada por su external_sale_id (receipt de Loyverse). No-op idempotente si la venta jamás registró visita (visit_found=false); delega en cancel_visit para la reversión y sus bloqueos (reward redimida, visita no generadora).';

-- ====================================================================
-- 6) loyverse_sync_state — checkpoint incremental del sync de receipts
-- ====================================================================
-- Estado del pipeline `loyverse-receipts-sync`. Una fila GLOBAL
-- (store_id NULL) mantiene el watermark de updated_at y el cursor de
-- paginación; el claim atomico serializa las corridas (estilo 0006).
-- Los receipts cancelados cambian su updated_at en Loyverse → la
-- ventana incremental los vuelve a listar y el sync cancela la visita.
--
-- Adquisición atómica del claim (UNA sentencia; ver .or() de la Edge):
--   update public.loyverse_sync_state
--      set sync_token    = <uuid>,
--          sync_token_at = now()
--    where id = <state_id>
--      and (sync_token is null
--           or sync_token_at < now() - interval '10 minutes')
--    returning id;
-- Liberación SOLO del token del dueño (nunca pisa un claim ajeno):
--   update public.loyverse_sync_state
--      set sync_token = null, sync_token_at = null
--    where id = <state_id> and sync_token = <uuid>;
create table public.loyverse_sync_state (
  id             uuid primary key default gen_random_uuid(),
  store_id       text,
  cursor         text,
  updated_at_min timestamptz not null default (now() - interval '90 days'),
  updated_at_max timestamptz,
  processed      integer not null default 0 check (processed >= 0),
  last_run_at    timestamptz,
  last_status    text not null default 'idle'
    check (last_status in ('idle', 'running', 'ok', 'error')),
  last_error     text,
  error_detail   jsonb,
  sync_token     uuid,
  sync_token_at  timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

comment on table public.loyverse_sync_state is
  'Checkpoint del sync de receipts Loyverse. store_id NULL = fila única global (todas las sucursales); un índice único parcial la garantiza. Solo la Edge Function (service_role) la toca.';

-- Máximo UNA fila global (store_id NULL) y UNA fila por sucursal.
create unique index loyverse_sync_state_all_stores_idx
  on public.loyverse_sync_state ((1))
  where store_id is null;

create unique index loyverse_sync_state_store_idx
  on public.loyverse_sync_state (store_id)
  where store_id is not null;

comment on column public.loyverse_sync_state.sync_token is
  'Token UUID del claim de corrida. NULL = nadie sincronizando. La Edge lo manipula con service_role; otro claim vigente (o uno abandonado hace < 10 min) bloquea la corrida concurrente.';

comment on column public.loyverse_sync_state.sync_token_at is
  'Instante en que se tomó sync_token. Habilita la expiración segura de claims abandonados (el lease no se reanuda); la liberación sigue siendo exclusiva del token original.';

comment on column public.loyverse_sync_state.updated_at_min is
  'Watermark incremental: solo se listan receipts con updated_at >= updated_at_min. Al terminar una corrida exitosa avanza a updated_at_max (el tope de la ventana, fijado al inicio); ante error no avanza y la ventana se reprocesa (idempotente por external_sale_id UNIQUE).';

-- updated_at automático (reutiliza el trigger de 0001).
create trigger loyverse_sync_state_set_updated_at
  before update on public.loyverse_sync_state
  for each row
  execute function public.set_updated_at();

-- RLS habilitada SIN políticas → solo service_role (BYPASSRLS) accede;
-- el cliente jamás la ve ni la toca (mismo patrón que audit_logs).
alter table public.loyverse_sync_state enable row level security;

-- ====================================================================
-- 7) Grants y revocaciones
-- ====================================================================
-- CREATE OR REPLACE conserva los grants de 0005, pero se re-declaran
-- revoke/grant por robustez (un push fresco o manual no debe dejar
-- ejecución pública accidental). cancel_visit_by_sale es nueva.
revoke all on function public.visit_summary(uuid)                      from public;
revoke all on function public.register_visit(uuid,text,numeric,date,text,text,text,text,text) from public;
revoke all on function public.cancel_visit(uuid,text,text)             from public;
revoke all on function public.cancel_visit_by_sale(text,text,text)    from public;

grant execute on function public.visit_summary(uuid)                     to service_role;
grant execute on function public.register_visit(uuid,text,numeric,date,text,text,text,text,text) to service_role;
grant execute on function public.cancel_visit(uuid,text,text)            to service_role;
grant execute on function public.cancel_visit_by_sale(text,text,text)   to service_role;

-- La tabla queda SIN permisos para anon/authenticated (RLS sin políticas
-- + revoke explícito por si algún default grant futuro la expone).
-- service_role es el único consumidor (Edge Function).
revoke all on table public.loyverse_sync_state from public;
revoke all on table public.loyverse_sync_state from anon;
revoke all on table public.loyverse_sync_state from authenticated;
grant select, insert, update, delete on table public.loyverse_sync_state to service_role;