-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0012: recompensa en la 7.ª visita
-- Ruta: supabase/migrations/0012_required_visits_7.sql
-- Aplicar con: supabase db push  (después de 0011)
--
-- PROBLEMA que resuelve: la regla documentada era "8 visitas para
-- obtener la recompensa", pero la decisión de negocio aprobada es 7:
-- la 7.ª visita desbloquea la recompensa (luego se implementará el
-- canje en la 8.ª). 0005 creó required_visits con default 8 y el
-- motor (register_visit en 0007) NUNCA hardcodea el número: lee
-- cycle.required_visits. Por eso basta con:
--
--   1) Cambiar el default de la columna a 7: los ciclos NUEVOS que
--      omitan required_visits al insertarse adoptan la regla nueva.
--   2) Actualizar los ciclos EXISTENTES activos que hoy tienen 8:
--      adoptan la regla nueva sin esperar a un ciclo nuevo. Los
--      ciclos completed y los activos que ya tengan otro valor
--      quedan intactos (histórico no se reescribe).
--
-- Efecto observado en producción: un ciclo activo con 6 visitas y
-- required_visits=8 pasará a requerir 7; su próxima visita (la 7.ª)
-- completará el ciclo y generará la recompensa. Un ciclo completado
-- con 8 visitas conserva su historial tal cual.
-- ---------------------------------------------------------------

-- ====================================================================
-- 1) Default nuevo para los ciclos que se creen a partir de aquí
-- ====================================================================
alter table public.loyalty_cycles
  alter column required_visits set default 7;

-- ====================================================================
-- 2) Ciclos activos existentes adoptan la regla nueva (8 -> 7).
--    Filtro: status = 'active' AND required_visits = 8. Los ciclos
--    completados y los que ya tengan otro valor no se tocan.
-- ====================================================================
update public.loyalty_cycles
   set required_visits = 7
 where status = 'active'
   and required_visits = 8;

-- ====================================================================
-- 3) Refrescar el comentario de la columna (ya no es default 8)
-- ====================================================================
comment on column public.loyalty_cycles.required_visits is
  'Número de visitas activas necesarias para completar el ciclo y generar la recompensa. Default 7 para Salmos V1 (la 7.ª visita desbloquea; el canje vive en la 8.ª); permite cambiar la regla en el futuro sin reescribir ciclos históricos.';