-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0005: RPCs transaccionales del motor de lealtad.
-- Ruta: supabase/migrations/0005_loyalty_engine.sql
-- Aplicar con: supabase db push  (después de 0004)
--
-- Este archivo implementa la D1.1 de la migración Mock → Supabase:
--   • Columnas nuevas: required_visits (cycles), source (visits).
--   • Índice único parcial para máximo 1 ciclo activo por cliente.
--   • Tres RPCs transaccionales (register_visit, cancel_visit, redeem_reward).
--   • Función auxiliar para validación de actor (assert_loyalty_actor).
--   • Función auxiliar visit_summary para estandarizar el retorno JSON.
--   • Auditoría transaccional (audit_logs).
--   • Grants estrictos: service_role exclusivamente.
--
-- Decisión de diseño:
--   DECISIÓN PENDIENTE — BUSINESS TIMEZONE: no existe zona horaria de
--   negocio definida en el repositorio. El parámetro p_visit_date de
--   register_visit acepta un valor del caller y lo valida
--   (no puede ser futuro); cuando el valor es NULL, se usa current_date
--   (reloj del clúster PostgreSQL). La Edge Function en D1.2 calculará
--   este valor en servidor para que el frontend nunca lo controle.
--
-- Seguridad:
--   SECURITY DEFINER + set search_path = public (consistente con 0003).
--   Solo service_role puede invocar las RPCs. La función assert_loyalty_actor
--   valida: actor_id/actor_role válidos, auth.uid() coherente con el actor
--   cuando hay JWT de usuario, auth.role() = service_role cuando no lo hay.
-- ---------------------------------------------------------------

-- ====================================================================
-- 0) Columnas nuevas
-- ====================================================================

-- required_visits en loyalty_cycles: cuántas visitas activas se necesitan
-- para completar el ciclo. El motor no hardcodea 8: lee cycle.required_visits.
-- El default (8) se aplica al crear ciclos omitiendo la columna en el INSERT.
alter table public.loyalty_cycles
  add column required_visits integer not null default 8;

alter table public.loyalty_cycles
  add constraint loyalty_cycles_required_visits_check
  check (required_visits > 0);

comment on column public.loyalty_cycles.required_visits is
  'Número de visitas activas necesarias para completar el ciclo y generar la recompensa. Default 8 para Salmos V1; permite cambiar la regla en el futuro sin reescribir ciclos históricos.';

-- source en loyalty_visits: origen de la compra. 'manual' para registros de
-- Staff; 'loyverse' para receipts del POS (Fase D2). El CHECK ya prepara el
-- modelo para D2 sin romper nada.
alter table public.loyalty_visits
  add column source text not null default 'manual';

alter table public.loyalty_visits
  add constraint loyalty_visits_source_check
  check (source in ('manual', 'loyverse'));

comment on column public.loyalty_visits.source is
  'Origen de la visita: manual (Staff) o loyverse (POS, Fase D2). Prepara el motor para recibir receipts sin romper compatibilidad.';

-- NOTA: payment_method NO se agrega en D1.1 (decisión aprobada).
-- El método de pago pertenece a la transacción/venta/receipt, no a la visita.

-- ====================================================================
-- 1) Índice único parcial: máximo 1 ciclo activo por cliente
-- ====================================================================
-- Segunda barrera de integridad además de la lógica transaccional.
-- Si dos operaciones concurrentes intentan crear un ciclo active para el
-- mismo cliente, una recibe unique_violation (23505) y la RPC la reintentará.
create unique index loyalty_cycles_one_active_per_customer_idx
  on public.loyalty_cycles (customer_id)
  where status = 'active';

comment on index public.loyalty_cycles_one_active_per_customer_idx is
  'Garantiza máximo 1 ciclo activo por cliente como segunda barrera de integridad además de la lógica transaccional en register_visit/redeem_reward.';

-- ====================================================================
-- 2) Función auxiliar: validación de actor
-- ====================================================================
-- SECURITY DEFINER para que pueda leer customers sin depender de RLS del caller.
-- Si auth.uid() está presente (JWT de usuario), el actor debe ser demostrable:
--   role='customer' → customers.auth_user_id = auth.uid() y el id text coincide.
-- Si no hay JWT, solo service_role (Edge Function) puede invocar.
create or replace function public.assert_loyalty_actor(
  p_actor_id   text,
  p_actor_role text,
  p_customer_id uuid default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if p_actor_id is null or btrim(p_actor_id) = '' then
    raise exception 'Actor no identificado.'
      using errcode = 'P0001';
  end if;

  if p_actor_role is null
     or p_actor_role not in ('customer', 'staff', 'admin', 'system')
  then
    raise exception 'Rol de actor inválido.'
      using errcode = 'P0001';
  end if;

  if v_uid is not null then
    -- Sesión con JWT de usuario: el actor debe ser demostrable.
    -- Solo se permite actor = customer vinculado a auth.uid(); staff/admin/
    -- system no se pueden verificar aún (no existe tabla staff en BD).
    if p_actor_role <> 'customer'
       or not exists (
         select 1
           from public.customers c
          where c.auth_user_id = v_uid
            and c.id::text = p_actor_id
            and (p_customer_id is null or c.id = p_customer_id)
       )
    then
      raise exception 'No autorizado.'
        using errcode = '42501';
    end if;
  else
    -- Sin JWT de usuario: solo el rol service_role (Edge Function) puede invocar.
    if auth.role() <> 'service_role' then
      raise exception 'No autorizado.'
        using errcode = '42501';
    end if;
  end if;
end;
$$;

-- ====================================================================
-- 3) Función auxiliar: resumen de visita en JSON
-- ====================================================================
-- Retorna un JSONB estandarizado con la visita, su ciclo, conteo activo y
-- recompensa. Usado por register_visit en paths de idempotencia y por la
-- respuesta principal. SECURITY DEFINER para evitar limitaciones de RLS
-- en las consultas internas (el caller es siempre service_role).
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
-- 4) RPC register_visit — registrar una visita
-- ====================================================================
-- Punto de entrada transaccional para registrar una compra válida.
-- Equivale a salesService.registerSale() + loyaltyService.addVisit() del mock.
--
-- Garantías de BD:
--   • Idempotencia por external_sale_id UNIQUE (ON CONFLICT implícito en retry).
--   • Máximo 1 visita activa por cliente/día: índice parcial (customer_id,
--     visit_date) WHERE status = 'active' → unique_violation controlado.
--   • Máximo 1 ciclo activo por cliente: índice parcial (customer_id)
--     WHERE status = 'active' → retry ante 23505.
--   • Conteo de visitas derivado de loyalty_visits (no contador mutable).
--   • reward_cycle_id UNIQUE → máximo 1 reward por ciclo.
--
-- DECISIÓN PENDIENTE — BUSINESS TIMEZONE:
--   p_visit_date puede ser proporcionado por el caller (D1.1) o computado
--   en servidor (current_date cuando NULL). D1.2 (Edge Function) calculará
--   la fecha de negocio en servidor y rechazará valores manipulados por el
--   cliente; el RPC ya valida que la fecha no sea futura.
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
  -- Validación de actor (defense-in-depth; la Edge Function D1.2 ya lo hace).
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
  -- DECISIÓN PENDIENTE — BUSINESS TIMEZONE (ver cabecera).
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
  -- Pre-check determinístico del límite diario (amigable vs unique_violation).
  -- Se evalúa antes del insert para dar un mensaje claro.
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
  -- Obtener o crear el ciclo activo.
  -- FOR UPDATE sobre el ciclo: serializa las visitas concurrentes
  -- para el mismo cliente, evitando carreras en conteo/reward.
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

    -- No existe ciclo activo: crear uno con cycle_number = max+1.
    -- required_visits usa el DEFAULT 8 de la columna (no se hardcodea).
    begin
      insert into public.loyalty_cycles (customer_id, cycle_number, status, started_at)
      select p_customer_id, coalesce(max(cycle_number), 0) + 1, 'active', now()
        from public.loyalty_cycles
       where customer_id = p_customer_id;
      continue; -- re-seleccionar para obtener FOR UPDATE
    exception
      when unique_violation then
        -- Otra transacción creó el ciclo (23505 en el UNIQUE parcial o en
        -- (customer_id, cycle_number)). Reintentar la selección.
        continue;
    end;
  end loop;

  -- ---------------------------------------------------------------
  -- Insertar la visita.
  -- Si surge unique_violation aquí, puede ser:
  --   a) external_sale_id duplicado bajo concurrencia (reentrega)
  --   b) límite diario (índice parcial)
  -- Se reenvía a idempotencia o error controlado.
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
      -- Reintentar idempotencia (el otro tx pudo haber insertado este
      -- mismo external_sale_id bajo concurrencia).
      select * into v_existing
        from public.loyalty_visits
       where external_sale_id = p_external_sale_id;
      if found then
        return (select public.visit_summary(v_existing.id) || '{"reused":true}'::jsonb);
      end if;
      -- Si no es idempotencia, es el límite diario.
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
  -- Si el reward previo del ciclo estaba CANCELLED (cancelación de la
  -- visita generadora), se REVIVE a available con una nueva ventana
  -- (earned_at/expires_at) — equivalente al cycle.rewardId=null del mock.
  -- Los estados available/redeemed NO se reescriben (WHERE status='cancelled').
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
-- 5) RPC cancel_visit — cancelar una visita
-- ====================================================================
-- Revierte una visita y, si corresponde, la recompensa que generó.
-- Equivale a salesService.cancelSale() del mock.
--
-- Reglas:
--   • Visita inexistente → error controlado.
--   • Visita ya cancelada → idempotente (resultado sin efectos colaterales).
--   • Recompensa ya redimida → BLOQUEAR (la recompensa no se revierte).
--   • Ciclo completed + recompensa available → solo cancela si la visita es la
--     que generó la recompensa (activa más reciente del ciclo).
--   • Ciclo completed sin recompensa available → BLOQUEAR (estado incoherente).
--   • Ciclo active → cancelar la visita (y la reward si esta la generó en el
--     paso 8 que ya completó el ciclo).
--
-- Identificación de la visita que generó la recompensa:
--   Se deriva como la visita activa con max(created_at) en el ciclo.
--   Esto es correcto bajo el modelo serializado (FOR UPDATE en el ciclo):
--   las visitas se insertan en orden estricto; la última en insertarse es la
--   que empujó el conteo a required_visits.
--   DECISIÓN PENDIENTE: una columna loyalty_visits.triggered_reward_id
--   haría la derivación explícita; se recomienda revisar esto para D1.2.
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
  -- (La recompensa no se revierte una vez utilizada.)
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
  -- recompensa y esta sigue disponible. Cualquier otra deja un
  -- ciclo completed con menos visitas → se bloquea.
  -- ---------------------------------------------------------------
  if v_cycle.status = 'completed' then
    if not found or v_reward.status <> 'available' then
      raise exception 'No se puede cancelar: el ciclo ya se completó y no hay recompensa disponible para revertir.'
        using errcode = 'P0001';
    end if;

    -- Identificar la visita que generó la recompensa: la activa más
    -- reciente (bajo serialización FOR UPDATE, es la que empujó a 8/8).
    -- DECISIÓN PENDIENTE para D1.2: columna triggered_reward_id haría
    -- esta derivación explícita.
    select v.id into v_generator
      from public.loyalty_visits v
     where v.cycle_id = v_visit.cycle_id
       and v.status   = 'active'
     order by v.created_at desc
     limit 1;

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
-- 6) RPC redeem_reward — redimir una recompensa
-- ====================================================================
-- Marca la recompensa como redimida y abre el siguiente ciclo en la
-- misma transacción. Equivale a rewardService.redeemReward() del mock.
--
-- Concurrencia:
--   • SELECT ... FOR UPDATE sobre la recompensa serializa las llamadas.
--   • UPDATE ... WHERE status='available' es la segunda barrera.
--   • El UNIQUE parcial (customer_id) WHERE status='active' en cycles
--     impide la creación de dos ciclos activos concurrentes.
--   • El loop de retry maneja unique_violation en la inserción del ciclo.
--
-- Reglas:
--   • Recompensa no encontrada → error.
--   • Recompensa no disponible (redeemed/cancelled) → error.
--   • Recompensa vencida → error (expired se deriva en lectura; el RPC
--     aquí hace la segunda barrera antes de permitir el canje).
--   • Si ya existe un ciclo activo para el cliente (visita post-completion
--     pero pre-redención), reutilizarlo en vez de crear uno duplicado.
create or replace function public.redeem_reward(
  p_reward_id   uuid,
  p_actor_id    text,
  p_actor_role  text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward        public.rewards%rowtype;
  v_new_cycle_id  uuid;
  v_cycle_number  integer;
  v_op_ts         timestamptz := now();
begin
  perform public.assert_loyalty_actor(p_actor_id, p_actor_role);

  -- ---------------------------------------------------------------
  -- Bloquear la recompensa (serializa todas las redenciones de la
  -- misma recompensa).
  -- ---------------------------------------------------------------
  select * into v_reward
    from public.rewards
   where id = p_reward_id
   for update;
  if not found then
    raise exception 'Recompensa no encontrada.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Validar estado de la recompensa.
  -- ---------------------------------------------------------------
  if v_reward.status = 'redeemed' then
    raise exception 'Esta recompensa ya fue redimida.'
      using errcode = 'P0001';
  end if;
  if v_reward.status = 'cancelled' then
    raise exception 'Esta recompensa ya no está disponible.'
      using errcode = 'P0001';
  end if;

  -- Segunda barrera contra la expiración (la primera es la derivación
  -- en lectura: available AND expires_at < now()). Aquí validamos antes
  -- de marcar como redeemed.
  if v_reward.expires_at <= v_op_ts then
    raise exception 'Esta recompensa ya venció.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Marcar como redimida (UPDATE condicional como segunda barrera
  -- de concurrencia sobre el status).
  -- ---------------------------------------------------------------
  update public.rewards
     set status       = 'redeemed',
         redeemed_at  = v_op_ts,
         redeemed_by  = p_actor_id
   where id = p_reward_id
     and status = 'available'
   returning * into v_reward;

  if not found then
    -- Caso concurrente: entre el SELECT FOR UPDATE y este UPDATE,
    -- otro tx ya marcó redeemed.
    raise exception 'Esta recompensa ya fue redimida.'
      using errcode = 'P0001';
  end if;

  -- ---------------------------------------------------------------
  -- Siguiente ciclo: reutilizar el activo si ya existe (visita
  -- registrada entre 8/8 y redención); si no, crear uno nuevo.
  -- El UNIQUE parcial (customer_id) WHERE status='active' impide
  -- duplicar ciclos activos; el loop retry maneja 23505.
  -- ---------------------------------------------------------------
  select id, cycle_number
    into v_new_cycle_id, v_cycle_number
    from public.loyalty_cycles
   where customer_id = v_reward.customer_id
     and status      = 'active'
   order by started_at desc
   limit 1;

  if v_new_cycle_id is null then
    loop
      begin
        insert into public.loyalty_cycles (customer_id, cycle_number, status, started_at)
        select v_reward.customer_id, coalesce(max(cycle_number), 0) + 1, 'active', v_op_ts
          from public.loyalty_cycles
         where customer_id = v_reward.customer_id
        returning id, cycle_number into v_new_cycle_id, v_cycle_number;
        exit; -- insert exitoso
      exception
        when unique_violation then
          -- Reintentar: buscar el ciclo activo que otra transacción creó.
          select id, cycle_number
            into v_new_cycle_id, v_cycle_number
            from public.loyalty_cycles
           where customer_id = v_reward.customer_id
             and status      = 'active'
           order by started_at desc
           limit 1;
          if v_new_cycle_id is not null then
            exit;
          end if;
          -- Si no se encontró (race con cancelación), reintentar el insert.
      end;
    end loop;
  end if;

  -- ---------------------------------------------------------------
  -- Auditoría.
  -- ---------------------------------------------------------------
  insert into public.audit_logs (
    actor_id, actor_role, customer_id, cycle_id,
    visit_id, reward_id, sale_id, action, detail
  ) values (
    p_actor_id, p_actor_role, v_reward.customer_id, v_reward.cycle_id,
    null, v_reward.id, null, 'REWARD_REDEEMED',
    jsonb_build_object(
      'redeemed_at',     v_reward.redeemed_at,
      'redeemed_by',     p_actor_id,
      'new_cycle_id',    v_new_cycle_id,
      'new_cycle_number', v_cycle_number
    )
  );

  -- ---------------------------------------------------------------
  -- Retorno.
  -- ---------------------------------------------------------------
  return jsonb_build_object(
    'ok',                true,
    'reward_id',         v_reward.id,
    'reward_status',     'redeemed',
    'redeemed_at',       v_reward.redeemed_at,
    'redeemed_by',       v_reward.redeemed_by,
    'reward_cycle_id',   v_reward.cycle_id,
    'new_cycle_id',      v_new_cycle_id,
    'new_cycle_number',  v_cycle_number
  );
end;
$$;

-- ====================================================================
-- 7) Grants y revocaciones
-- ====================================================================
-- Solo service_role puede invocar las RPCs y las funciones auxiliares.
-- authenticated/anon NO pueden ejecutar ninguna de estas funciones,
-- incluso si el frontend intenta llamarlas directamente vía REST.
-- Las Edge Functions (D1.2) invocarán estas RPCs con la key de
-- service_role.

-- revoke: eliminar cualquier grant heredado de DEFAULT GRANTS
revoke all on function public.assert_loyalty_actor(text, text, uuid)    from public;
revoke all on function public.visit_summary(uuid)                      from public;
revoke all on function public.register_visit(uuid,text,numeric,date,text,text,text,text,text) from public;
revoke all on function public.cancel_visit(uuid,text,text)             from public;
revoke all on function public.redeem_reward(uuid,text,text)            from public;

-- grant: solo service_role
grant execute on function public.assert_loyalty_actor(text,text,uuid)    to service_role;
grant execute on function public.visit_summary(uuid)                     to service_role;
grant execute on function public.register_visit(uuid,text,numeric,date,text,text,text,text,text) to service_role;
grant execute on function public.cancel_visit(uuid,text,text)            to service_role;
grant execute on function public.redeem_reward(uuid,text,text)           to service_role;

-- ====================================================================
-- 8) Comentarios de funciones
-- ====================================================================

comment on function public.assert_loyalty_actor(text, text, uuid) is
  'Valida que p_actor_id y p_actor_role sean coherentes con la sesión. Si hay JWT de usuario (auth.uid()), el actor debe ser el customer vinculado. Sin JWT, solo service_role puede invocar. Segunda defensa contra suplantación de actor.';
comment on function public.visit_summary(uuid) is
  'Devuelve un JSONB con la visita, su ciclo (conteo derivado), recompensa y metadatos. Usado por register_visit para estandarizar el retorno. SECURITY DEFINER para evitar limitaciones de RLS.';
comment on function public.register_visit(uuid,text,numeric,date,text,text,text,text,text) is
  'RPC transaccional: registra una visita válida. Equivale a salesService.registerSale() + loyaltyService.addVisit() del mock. Garantiza: idempotencia por external_sale_id, máximo 1 visita/día, conteo derivado, reward en required_visits, auditoría transaccional.';
comment on function public.cancel_visit(uuid,text,text) is
  'RPC transaccional: cancela una visita y revierte su recompensa si corresponde. Equivale a salesService.cancelSale() del mock. Bloquea: reward ya redimido, visita que no generó la recompensa en ciclo completed.';
comment on function public.redeem_reward(uuid,text,text) is
  'RPC transaccional: redime una recompensa y abre el siguiente ciclo en la misma operación. Equivale a rewardService.redeemReward() del mock. Concurrencia protegida por FOR UPDATE + UPDATE condicional + UNIQUE parcial en cycles.';
