-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0024: backfill controlado de customers.phone.
-- Ruta: supabase/migrations/0024_customers_phone_backfill.sql
-- Aplicar con: supabase db push — SOLO con aprobación.
--
-- Qué hace: copia a public.customers.phone el teléfono de registro de
-- EXACTAMENTE tres usuarios aprobados tras auditoría manual (whitelist por
-- auth_user_id + últimos 2 dígitos aprobados). NO es un backfill genérico:
-- ningún otro usuario con metadata.phone se toca, aunque exista.
--
-- Fuente: auth.identities.identity_data.phone (identidad 'email'), que
-- debe coincidir EXACTAMENTE con auth.users.raw_user_meta_data.phone y
-- estar ya en E.164 MX. Ninguna fuente sustituye a la otra.
--   Por qué identity_data: en Supabase Auth v2.196.0 el registro crea la
--   identidad 'email' con {sub, email} + las claves de options.data, y
--   updateUser({ data }) solo escribe raw_user_meta_data. Es evidencia
--   fuerte de procedencia (observada en la auditoría 2026-10-07), NO un
--   historial inmutable garantizado por Supabase ni una verificación SMS.
--
-- Reglas (todas por candidato; cualquier fallo ABORTA TODO, 0 cambios):
--   * auth.users existe; exactamente 1 identidad 'email'.
--   * identity_data.phone y metadata.phone: string, iguales, E.164 MX
--     exacto (canonical_mx_phone(x) = x), y terminan en los 2 dígitos
--     aprobados.
--   * exactamente 1 customers por auth_user_id (FK único).
--   * customers.phone IS NULL  → se escribe.
--     customers.phone = teléfono aprobado → ya aplicado (sin cambio).
--     cualquier otro valor → ABORTA (nunca sobrescribe).
--   * ningún OTRO customer tiene ese número en ninguna forma equivalente
--     (comparación canónica, no por dígitos crudos).
--
-- Entornos sin estos usuarios (local, harness, branches): si NINGUNO de
-- los tres auth_user_id existe, la migración no hace nada (NOTICE).
-- Si existen algunos pero no todos → ABORTA.
--
-- Concurrencia: LOCK TABLE customers IN SHARE ROW EXCLUSIVE MODE (igual
-- que 0021) ANTES de leer customers. Exige READ COMMITTED: cada sentencia
-- del DO toma un snapshot nuevo, posterior al lock. En REPEATABLE READ /
-- SERIALIZABLE el snapshot sería previo al lock → la migración aborta.
-- Atomicidad: todo en un único bloque DO; RAISE EXCEPTION revierte lock,
-- UPDATE y auditoría juntos.
--
-- Auditoría (public.audit_logs, actor 'system'):
--   action = phone_backfill_applied, customer_id = fila actualizada,
--   detail = { source, reason, last2 }  ← nunca el teléfono completo.
-- Idempotencia: re-ejecución tras éxito → 0 cambios, 0 auditorías nuevas.
-- ---------------------------------------------------------------
do $$
declare
  -- Whitelist aprobada (auth_user_id completos, verificados contra la base).
  v_ids   constant uuid[] := array[
    'c57de3bb-a171-4f2b-8f72-b66842b9f56e',
    'f1737efb-5447-413d-aca0-194583057b05',
    '5ec49f9f-19e3-4ff7-a8f9-7938c91ef321'
  ]::uuid[];
  v_last2 constant text[] := array['20', '13', '18'];

  v_present     int;
  v_tag         text;
  v_ident_count int;
  v_ident_phone jsonb;
  v_meta_phone  jsonb;
  v_canon       text;
  v_cust_count  int;
  v_cust_id     uuid;
  v_cust_phone  text;
  v_pending_ids uuid[] := '{}';
  v_pending_ph  text[] := '{}';
  v_all_canon   text[] := '{}';
  v_updated     int;
begin
  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception '0024 abortada: requiere READ COMMITTED (actual: %)', current_setting('transaction_isolation');
  end if;
  perform set_config('lock_timeout', '5s', true);

  select count(*) into v_present from auth.users u where u.id = any (v_ids);
  if v_present = 0 then
    raise notice '0024: ningún usuario aprobado existe en esta base; sin cambios.';
    return;
  elsif v_present <> array_length(v_ids, 1) then
    raise exception '0024 abortada: solo % de % usuarios aprobados existen', v_present, array_length(v_ids, 1);
  end if;

  lock table public.customers in share row exclusive mode;

  for i in 1 .. array_length(v_ids, 1) loop
    v_tag := left(v_ids[i]::text, 8) || '…' || right(v_ids[i]::text, 4);

    -- Identidad 'email' (snapshot del registro) y metadata actual.
    select count(*) into v_ident_count
      from auth.identities i2
     where i2.user_id = v_ids[i] and i2.provider = 'email';
    if v_ident_count <> 1 then
      raise exception '0024 abortada [%]: identidades email = %', v_tag, v_ident_count;
    end if;
    select i2.identity_data -> 'phone' into v_ident_phone
      from auth.identities i2
     where i2.user_id = v_ids[i] and i2.provider = 'email';

    select u.raw_user_meta_data -> 'phone' into v_meta_phone
      from auth.users u where u.id = v_ids[i];

    if jsonb_typeof(v_ident_phone) is distinct from 'string'
       or jsonb_typeof(v_meta_phone) is distinct from 'string' then
      raise exception '0024 abortada [%]: teléfono ausente o no-string en identity/metadata', v_tag;
    end if;
    if v_ident_phone #>> '{}' <> v_meta_phone #>> '{}' then
      raise exception '0024 abortada [%]: identity_data y metadata no coinciden', v_tag;
    end if;

    v_canon := public.canonical_mx_phone(v_ident_phone #>> '{}');
    if v_canon is null or v_canon <> v_ident_phone #>> '{}' then
      raise exception '0024 abortada [%]: teléfono no es E.164 MX exacto', v_tag;
    end if;
    if right(v_canon, 2) <> v_last2[i] then
      raise exception '0024 abortada [%]: últimos 2 dígitos no coinciden con lo aprobado', v_tag;
    end if;

    -- Customer por la relación canónica (FK único auth_user_id).
    select count(*) into v_cust_count
      from public.customers c
     where c.auth_user_id = v_ids[i];
    if v_cust_count <> 1 then
      raise exception '0024 abortada [%]: customers por auth_user_id = %', v_tag, v_cust_count;
    end if;
    select c.id, c.phone into v_cust_id, v_cust_phone
      from public.customers c
     where c.auth_user_id = v_ids[i];

    -- Unicidad canónica frente a CUALQUIER otro customer (bajo el lock).
    if exists (select 1 from public.customers o
                where o.id <> v_cust_id
                  and o.phone is not null
                  and public.canonical_mx_phone(o.phone) = v_canon) then
      raise exception '0024 abortada [%]: el teléfono aprobado ya pertenece a otro customer', v_tag;
    end if;

    if v_canon = any (v_all_canon) then
      raise exception '0024 abortada [%]: dos candidatos con el mismo teléfono', v_tag;
    end if;
    v_all_canon := v_all_canon || v_canon;

    if v_cust_phone is null then
      v_pending_ids := v_pending_ids || v_cust_id;
      v_pending_ph  := v_pending_ph  || v_canon;
    elsif v_cust_phone = v_canon then
      null;  -- ya aplicado: sin cambio
    else
      raise exception '0024 abortada [%]: customers.phone ya tiene otro valor; no se sobrescribe', v_tag;
    end if;
  end loop;

  if coalesce(array_length(v_pending_ids, 1), 0) = 0 then
    raise notice '0024: los % usuarios aprobados ya tienen el teléfono aprobado; sin cambios.', array_length(v_ids, 1);
    return;
  end if;

  update public.customers c
     set phone = p.phone
    from unnest(v_pending_ids, v_pending_ph) as p(id, phone)
   where c.id = p.id
     and c.phone is null;
  get diagnostics v_updated = row_count;
  if v_updated <> array_length(v_pending_ids, 1) then
    raise exception '0024 abortada: se esperaban % filas y se actualizaron %', array_length(v_pending_ids, 1), v_updated;
  end if;

  insert into public.audit_logs (actor_id, actor_role, customer_id, action, detail)
  select 'migration_0024', 'system', p.id, 'phone_backfill_applied',
         jsonb_build_object('source', 'auth.identities.identity_data',
                            'reason', 'approved_whitelist',
                            'last2',  right(p.phone, 2))
    from unnest(v_pending_ids, v_pending_ph) as p(id, phone);

  raise notice '0024: % teléfonos escritos en customers.phone.', v_updated;
end;
$$;
