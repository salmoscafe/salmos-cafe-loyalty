-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0017: verificación OTP del canje.
-- Ruta: supabase/migrations/0017_reward_claim_otp.sql
-- Aplicar con: supabase db push  (después de 0016)
--
-- Objetivo:
--   Convertir el flujo de canje en:
--     claim_start → pending → (Staff verifica OTP) → verified → redeem
--   y hacer que public.redeem_reward() RECHACE cualquier canje que no
--   tenga una claim 'verified' válida para esa recompensa.
--
-- NOTA DE DISEÑO (seguridad de la pepper):
--   La pepper HMAC del OTP es un secret EXCLUSIVO de la Edge Function y
--   JAMÁS entra a PostgreSQL (ni a una tabla ni como argumento, para no
--   quedar en logs de statement). Por eso:
--     * La Edge computa el candidato HMAC-SHA256(pepper, salt:otp:rewardId)
--       y lo pasa como `p_candidate_hash`.
--     * La RPC hace la comparación en tiempo constante contra
--       reward_claims.otp_hash y la transición atómica pending → verified.
--   El `salt` viaja embebido en otp_hash (formato `saltHex:hexHMAC`,
--   ver 0016/claim_start); la Edge lo extrae del hash almacenado.
--
-- Reglas de negocio:
--   * Solo Staff/Admin verifican (defense-in-depth; grants: service_role).
--   * El OTP es de un solo uso y TTL 5 min (backend); la expiración se
--     DERIVA de expires_at (sin cron): pending AND expires_at <= now().
--   * Máximo una claim 'verified' por recompensa (índice parcial de
--     0016). Si ya existe otra verified, se rechaza: NO se cancela/
--     invalida silenciosamente una verificación previa.
--   * redeem_reward exige exactamente una claim 'verified' y la consume
--     (verified → redeemed) en la MISMA transacción que marca el reward
--     redeemed: no hay ventana de inconsistencia reward/claim.
--
-- Alcance:
--   * Crea public.constant_time_equal(text,text).
--   * Crea public.verify_reward_claim(uuid,text,text,text).
--   * Reemplaza public.redeem_reward(uuid,text,text) (misma firma).
--   * NO modifica migraciones históricas.
-- ---------------------------------------------------------------

-- ====================================================================
-- 0) Comparación en tiempo constante (evita timing sobre el hash)
-- ====================================================================
-- Compara dos cadenas byte a byte sin cortocircuito por contenido.
-- La longitud no es secreta (el formato `saltHex:hexHMAC` es fijo), así
-- que el retorno temprano por longitud distinta no filtra el OTP.
create or replace function public.constant_time_equal(a text, b text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  ba bytea := convert_to(coalesce(a, ''), 'UTF8');
  bb bytea := convert_to(coalesce(b, ''), 'UTF8');
  diff integer := 0;
  i integer;
begin
  if a is null or b is null then
    return false;
  end if;
  if octet_length(ba) <> octet_length(bb) then
    return false;
  end if;
  for i in 0 .. octet_length(ba) - 1 loop
    diff := diff | (get_byte(ba, i) # get_byte(bb, i));
  end loop;
  return diff = 0;
end;
$$;

-- ====================================================================
-- 1) verify_reward_claim — Staff/Admin valida el OTP de una recompensa
-- ====================================================================
-- Recibe el hash candidato ya computado por la Edge (con la pepper) y:
--   * localiza y bloquea la claim 'pending' de la recompensa;
--   * rechaza reward inexistente/redimida/cancelada/vencida;
--   * rechaza claim inexistente, expirada, ya verificada o ya redimida;
--   * compara el candidato con otp_hash en tiempo constante;
--   * transiciona pending → verified (verified_at, verified_by).
--
-- El actor (p_actor_id/p_actor_role) llega derivado de la sesión por la
-- Edge; assert_loyalty_actor es la segunda barrera.
--
-- Errores: SQLSTATE P0001 (negocio) con HINT estable que la Edge mapea a
-- un código de error específico (ver loyaltyEngineCore.mapRpcError):
--   OTP_INVALID, OTP_EXPIRED, CLAIM_NOT_FOUND, CLAIM_ALREADY_VERIFIED,
--   CLAIM_ALREADY_REDEEMED, REWARD_NOT_FOUND, REWARD_ALREADY_REDEEMED,
--   REWARD_NOT_AVAILABLE, REWARD_EXPIRED.
create or replace function public.verify_reward_claim(
  p_reward_id      uuid,
  p_candidate_hash text,
  p_actor_id       text,
  p_actor_role     text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reward         public.rewards%rowtype;
  v_claim          public.reward_claims%rowtype;
  v_other_verified uuid;
  v_now            timestamptz := now();
begin
  perform public.assert_loyalty_actor(p_actor_id, p_actor_role);

  -- Solo Staff/Admin/System verifican (la Edge ya lo garantizó).
  if p_actor_role is null or p_actor_role not in ('staff', 'admin', 'system') then
    raise exception 'No autorizado.'
      using errcode = '42501';
  end if;

  if p_candidate_hash is null or btrim(p_candidate_hash) = '' then
    raise exception 'Código OTP incorrecto.'
      using errcode = 'P0001', hint = 'OTP_INVALID';
  end if;

  -- ---------------------------------------------------------------
  -- Bloquear la recompensa: serializa verify/redeem por recompensa
  -- (mismo orden de locks que redeem_reward → sin deadlock).
  -- ---------------------------------------------------------------
  select * into v_reward
    from public.rewards
   where id = p_reward_id
   for update;
  if not found then
    raise exception 'Recompensa no encontrada.'
      using errcode = 'P0001', hint = 'REWARD_NOT_FOUND';
  end if;
  if v_reward.status = 'redeemed' then
    raise exception 'Esta recompensa ya fue redimida.'
      using errcode = 'P0001', hint = 'REWARD_ALREADY_REDEEMED';
  end if;
  if v_reward.status = 'cancelled' then
    raise exception 'Esta recompensa ya no está disponible.'
      using errcode = 'P0001', hint = 'REWARD_NOT_AVAILABLE';
  end if;
  if v_reward.expires_at <= v_now then
    raise exception 'Esta recompensa ya venció.'
      using errcode = 'P0001', hint = 'REWARD_EXPIRED';
  end if;

  -- ---------------------------------------------------------------
  -- Localizar y bloquear la claim pendiente (máx. una por reward).
  -- ---------------------------------------------------------------
  select * into v_claim
    from public.reward_claims
   where reward_id = p_reward_id
     and status = 'pending'
   for update;

  if not found then
    -- Distinguir el motivo para el Staff (actor autorizado), sin exponer
    -- el hash ni datos del OTP.
    if exists (
      select 1 from public.reward_claims
       where reward_id = p_reward_id and status = 'verified'
    ) then
      raise exception 'Esta recompensa ya tiene un código verificado.'
        using errcode = 'P0001', hint = 'CLAIM_ALREADY_VERIFIED';
    end if;
    if exists (
      select 1 from public.reward_claims
       where reward_id = p_reward_id and status = 'redeemed'
    ) then
      raise exception 'La solicitud de canje ya fue redimida.'
        using errcode = 'P0001', hint = 'CLAIM_ALREADY_REDEEMED';
    end if;
    raise exception 'No hay una solicitud de código vigente para esta recompensa.'
      using errcode = 'P0001', hint = 'CLAIM_NOT_FOUND';
  end if;

  -- ---------------------------------------------------------------
  -- Expiración derivada (sin cron): pending AND expires_at <= now().
  -- ---------------------------------------------------------------
  if v_claim.expires_at <= v_now then
    raise exception 'El código OTP ya venció. Solicita uno nuevo.'
      using errcode = 'P0001', hint = 'OTP_EXPIRED';
  end if;

  -- ---------------------------------------------------------------
  -- Comparación en tiempo constante contra el hash almacenado.
  -- ---------------------------------------------------------------
  if not public.constant_time_equal(p_candidate_hash, v_claim.otp_hash) then
    raise exception 'Código OTP incorrecto.'
      using errcode = 'P0001', hint = 'OTP_INVALID';
  end if;

  -- ---------------------------------------------------------------
  -- Invariante de 0016: máximo UNA claim 'verified' por recompensa.
  -- Bajo el lock de la recompensa no debería existir otra, pero se
  -- verifica explícitamente: NO se cancela una verificación previa.
  -- ---------------------------------------------------------------
  select id into v_other_verified
    from public.reward_claims
   where reward_id = p_reward_id
     and status = 'verified'
     and id <> v_claim.id
   limit 1;
  if v_other_verified is not null then
    raise exception 'Esta recompensa ya tiene un código verificado.'
      using errcode = 'P0001', hint = 'CLAIM_ALREADY_VERIFIED';
  end if;

  -- ---------------------------------------------------------------
  -- Transición atómica pending → verified (UPDATE condicional, segunda
  -- barrera). El índice parcial puede lanzar 23505 si otra verified
  -- apareció; se mapea al mismo error de negocio.
  -- ---------------------------------------------------------------
  begin
    update public.reward_claims
       set status      = 'verified',
           verified_at = v_now,
           verified_by = p_actor_id
     where id = v_claim.id
       and status = 'pending'
     returning * into v_claim;
  exception
    when unique_violation then
      raise exception 'Esta recompensa ya tiene un código verificado.'
        using errcode = 'P0001', hint = 'CLAIM_ALREADY_VERIFIED';
  end;

  if not found then
    raise exception 'La solicitud de código cambió durante la verificación. Intenta nuevamente.'
      using errcode = 'P0001', hint = 'CLAIM_NOT_FOUND';
  end if;

  -- ---------------------------------------------------------------
  -- Auditoría de la verificación (no incluye el OTP ni el hash).
  -- ---------------------------------------------------------------
  insert into public.audit_logs (
    actor_id, actor_role, customer_id, cycle_id,
    visit_id, reward_id, sale_id, action, detail
  ) values (
    p_actor_id, p_actor_role, v_reward.customer_id, v_reward.cycle_id,
    null, p_reward_id, null, 'CLAIM_VERIFIED',
    jsonb_build_object(
      'claim_id',    v_claim.id,
      'verified_at', v_claim.verified_at,
      'verified_by', p_actor_id
    )
  );

  return jsonb_build_object(
    'ok',           true,
    'reward_id',    p_reward_id,
    'claim_id',     v_claim.id,
    'claim_status', 'verified',
    'verified_at',  v_claim.verified_at,
    'verified_by',  v_claim.verified_by,
    'expires_at',   v_claim.expires_at
  );
end;
$$;

-- ====================================================================
-- 2) redeem_reward — reemplazo protegido por OTP verificado
-- ====================================================================
-- Misma firma que 0005. Cambios respecto a la versión anterior:
--   * Exige una claim 'verified' de la recompensa (FOR UPDATE). Sin ella
--     no hay canje posible: devuelve REWARD_NOT_VERIFIED. Esta es la
--     protección REAL del RPC (no depende de que la UI siga el flujo).
--   * Consume la claim (verified → redeemed) en la MISMA transacción que
--     marca el reward redeemed → sin ventana de inconsistencia.
--   * Lock de recompensa y de claim en el mismo orden que
--     verify_reward_claim → sin deadlock.
--
-- Concurrencia:
--   * SELECT ... FOR UPDATE sobre la recompensa serializa las redenciones.
--   * UPDATE ... WHERE status='available' es la segunda barrera.
--   * La claim verified se bloquea y se consume condicionalmente
--     (WHERE status='verified'), de modo que dos redeems concurrentes
--     solo consumen una vez.
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
  v_claim         public.reward_claims%rowtype;
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
      using errcode = 'P0001', hint = 'REWARD_NOT_FOUND';
  end if;

  -- ---------------------------------------------------------------
  -- Validar estado de la recompensa.
  -- ---------------------------------------------------------------
  if v_reward.status = 'redeemed' then
    raise exception 'Esta recompensa ya fue redimida.'
      using errcode = 'P0001', hint = 'REWARD_ALREADY_REDEEMED';
  end if;
  if v_reward.status = 'cancelled' then
    raise exception 'Esta recompensa ya no está disponible.'
      using errcode = 'P0001', hint = 'REWARD_NOT_AVAILABLE';
  end if;

  -- Segunda barrera contra la expiración.
  if v_reward.expires_at <= v_op_ts then
    raise exception 'Esta recompensa ya venció.'
      using errcode = 'P0001', hint = 'REWARD_EXPIRED';
  end if;

  -- ---------------------------------------------------------------
  -- PROTECCIÓN 0017: exigir una claim 'verified' válida. Se bloquea la
  -- claim para que ningún otro redeem la consuma en paralelo.
  -- ---------------------------------------------------------------
  select * into v_claim
    from public.reward_claims
   where reward_id = p_reward_id
     and status = 'verified'
   for update;

  if not found then
    raise exception 'Esta recompensa no tiene una verificación OTP válida.'
      using errcode = 'P0001', hint = 'REWARD_NOT_VERIFIED';
  end if;

  -- ---------------------------------------------------------------
  -- Marcar la recompensa como redimida (UPDATE condicional, segunda
  -- barrera de concurrencia sobre el status).
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
      using errcode = 'P0001', hint = 'REWARD_ALREADY_REDEEMED';
  end if;

  -- ---------------------------------------------------------------
  -- Consumir la claim verificada (verified → redeemed) en la MISMA
  -- transacción. UPDATE condicional: si otro tx ya la consumió, no
  -- hay fila y se aborta (defensa; el FOR UPDATE ya la bloqueó).
  -- ---------------------------------------------------------------
  update public.reward_claims
     set status      = 'redeemed',
         redeemed_at = v_op_ts
   where id = v_claim.id
     and status = 'verified'
   returning * into v_claim;

  if not found then
    raise exception 'Esta recompensa no tiene una verificación OTP válida.'
      using errcode = 'P0001', hint = 'REWARD_NOT_VERIFIED';
  end if;

  -- ---------------------------------------------------------------
  -- Siguiente ciclo: reutilizar el activo si ya existe (visita
  -- registrada entre required_visits y redención); si no, crear uno.
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
      'redeemed_at',      v_reward.redeemed_at,
      'redeemed_by',      p_actor_id,
      'claim_id',         v_claim.id,
      'claim_verified_at', v_claim.verified_at,
      'claim_verified_by', v_claim.verified_by,
      'new_cycle_id',     v_new_cycle_id,
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
    'claim_id',          v_claim.id,
    'claim_status',      'redeemed',
    'claim_verified_at', v_claim.verified_at,
    'claim_verified_by', v_claim.verified_by,
    'claim_redeemed_at', v_claim.redeemed_at,
    'new_cycle_id',      v_new_cycle_id,
    'new_cycle_number',  v_cycle_number
  );
end;
$$;

-- ====================================================================
-- 3) Grants y revocaciones
-- ====================================================================
-- Solo service_role (la Edge Function) puede invocar estas funciones.
-- authenticated/anon quedan fuera aunque llamen la REST API directamente.
revoke all on function public.constant_time_equal(text, text)             from public;
revoke all on function public.verify_reward_claim(uuid, text, text, text) from public;
revoke all on function public.redeem_reward(uuid, text, text)             from public;

grant execute on function public.constant_time_equal(text, text)             to service_role;
grant execute on function public.verify_reward_claim(uuid, text, text, text) to service_role;
grant execute on function public.redeem_reward(uuid, text, text)             to service_role;

-- ====================================================================
-- 4) Comentarios de funciones
-- ====================================================================
comment on function public.constant_time_equal(text, text) is
  'Comparación de cadenas en tiempo constante (sin cortocircuito por contenido). Usada para verificar otp_hash sin filtrar el OTP por timing.';
comment on function public.verify_reward_claim(uuid, text, text, text) is
  'RPC transaccional: verifica el OTP de una recompensa (pending → verified). Recibe el hash candidato ya computado por la Edge con la pepper HMAC (la pepper jamás entra a PostgreSQL). Compara en tiempo constante contra reward_claims.otp_hash y exige máximo una claim verified por recompensa.';
comment on function public.redeem_reward(uuid, text, text) is
  'RPC transaccional: redime una recompensa EXIGIENDO una claim verified válida (0017) y la consume (verified → redeemed) en la misma transacción. Abre el siguiente ciclo. Sin claim verified devuelve REWARD_NOT_VERIFIED: la protección vive en la base, no en la UI.';
