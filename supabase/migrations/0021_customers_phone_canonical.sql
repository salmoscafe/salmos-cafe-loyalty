-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0021: normalización de teléfonos legacy.
-- Ruta: supabase/migrations/0021_customers_phone_canonical.sql
-- Aplicar con: supabase db push — SOLO con aprobación.
--
-- Objetivo: que customers.phone (fuente oficial del teléfono) quede en
-- formato canónico E.164 MX (+52XXXXXXXXXX) cuando eso es SEGURO.
--
--   6645550000    → +526645550000
--   526645550000  → +526645550000
--   +526645550000 → (ya canónico, sin cambio)
--   cualquier otra cosa → no se toca (invalid_format)
--
-- Clasificación (previa a cualquier escritura):
--   invalid_format                   no normaliza a E.164 MX → se conserva tal cual.
--   already_canonical                ya está en E.164 MX → sin cambio ni auditoría.
--   collides_with_canonical_customer otro cliente YA tiene ese número en forma
--                                    canónica → este NO se toca.
--   ambiguous_duplicate              dos o más filas no canónicas terminarían en el
--                                    mismo número → NINGUNA se toca.
--   normalize                        caso seguro → se reescribe en E.164 MX.
--
-- Por qué la comparación canónica: customers_phone_unique_key (0008)
-- compara DÍGITOS crudos, así que "6645550007" y "+526645550007" pueden
-- coexistir sin violar el índice aunque sean el mismo número. Esta
-- migración nunca crea ese duplicado silencioso. El índice NO se cambia
-- aquí (fase posterior, cuando no queden conflictos).
--
-- Seguridad / concurrencia:
--   * LOCK TABLE ... SHARE ROW EXCLUSIVE: las lecturas siguen; altas y
--     cambios concurrentes esperan al final de la transacción.
--   * El UPDATE exige que la fila conserve el valor original leído
--     (c.phone = valor_original): nunca un UPDATE global por resultado.
--   * Todo vive en un único bloque DO (lock + clasificación + escritura +
--     auditoría en la misma transacción), válido aunque el runner no abra
--     una transacción explícita.
--
-- Auditoría (public.audit_logs, actor 'system'):
--   action = phone_normalize_applied | phone_normalize_skipped
--   detail = { reason, from_format, last2 }   ← NUNCA el teléfono completo.
--
-- Idempotencia: lo normalizado pasa a already_canonical (sin auditoría);
-- los omitidos no se re-auditan (NOT EXISTS por cliente + motivo).
--
-- Estado remoto conocido (diagnóstico 2026-10-07): 0 teléfonos legacy →
-- en remoto esta migración no modifica filas; queda como salvaguarda.
-- ---------------------------------------------------------------

do $$
begin
  lock table public.customers in share row exclusive mode;

  with rows as (
    select c.id,
           c.phone,
           regexp_replace(c.phone, '\D', '', 'g') as digits
      from public.customers c
     where c.phone is not null
       and btrim(c.phone) <> ''
  ),
  canon as (
    select r.*,
           case
             when length(r.digits) = 10                          then '+52' || r.digits
             when length(r.digits) = 12 and r.digits like '52%'  then '+'   || r.digits
             else null
           end as canonical,
           case
             when length(r.digits) = 10                          then '10_digits'
             when length(r.digits) = 12 and r.digits like '52%'  then '12_digits_52'
             else 'other'
           end as from_format
      from rows r
  ),
  classified as (
    select k.*,
           case
             when k.canonical is null                         then 'invalid_format'
             when k.phone = k.canonical                       then 'already_canonical'
             when exists (select 1 from canon o
                           where o.id <> k.id and o.canonical = k.canonical and o.phone = o.canonical)
                                                              then 'collides_with_canonical_customer'
             when exists (select 1 from canon o
                           where o.id <> k.id and o.canonical = k.canonical)
                                                              then 'ambiguous_duplicate'
             else 'normalize'
           end as status
      from canon k
  ),
  applied as (
    update public.customers c
       set phone = k.canonical
      from classified k
     where k.id = c.id
       and k.status = 'normalize'
       and c.phone = k.phone            -- protección: el valor original no cambió
    returning c.id
  )
  insert into public.audit_logs (actor_id, actor_role, customer_id, action, detail)
  select 'migration_0021',
         'system',
         k.id,
         case when k.status = 'normalize' then 'phone_normalize_applied' else 'phone_normalize_skipped' end,
         jsonb_build_object(
           'reason',      k.status,
           'from_format', k.from_format,
           'last2',       right(k.digits, 2)
         )
    from classified k
   where k.status <> 'already_canonical'
     and (k.status <> 'normalize' or k.id in (select id from applied))
     and not exists (
           select 1
             from public.audit_logs a
            where a.customer_id = k.id
              and a.action in ('phone_normalize_applied', 'phone_normalize_skipped')
              and a.detail ->> 'reason' = k.status
         );
end;
$$;
