-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0014: exclusión administrativa del loyalty sync.
-- Ruta: supabase/migrations/0014_customers_exclude_loyalty.sql
-- Aplicar con: supabase db push  (después de 0013, antes de 0015)
--
-- Propósito:
--   UNA marca administrativa por cliente de Loyverse para excluirlo del
--   loyalty sync de `loyverse-receipts-sync`:
--     customers.exclude_loyalty = true  → sus receipts NO generan
--       loyalty_visits (decidido en receiptsSyncCore.decideReceiptAction
--       con reason 'staff_customer'; segunda barrera en
--       register_visit_with_receipt, migración 0015).
--     customers.exclude_loyalty = false (DEFAULT) → comportamiento actual.
--
--   NUNCA usa receipt.employee_id (el cajero NO es el comprador) ni
--   profiles.role: la exclusión pertenece al cliente de Loyverse.
--   La migración deja TODOS los clientes existentes en false.
--
-- Patrón (consistente con 0006/0008):
--   * Columna interna/admin sobre `customers`, como loyverse_sync_claim/
--     loyverse_sync_claim_at (0006), con comment on column que aclara que
--     solo la administración (service_role / DBA) la manipula.
--   * Seguridad heredada de 0008: `authenticated` tiene UPDATE column-level
--     SOLO sobre (name, email, phone, profile); una columna NUEVA no entra
--     en ese grant → el cliente autenticado NO puede modificar este flag.
--   * Adicionalmente se revoca SELECT column-level: el grant select
--     table-wide de 0008 sí cubriría columnas nuevas, y queremos que la
--     marca no sea legible ni por el dueño de la fila (dato exclusivo de
--     administración interna). Los consumidores del sync (service_role:
--     loyverse-receipts-sync, loyalty-engine) conservan lectura ilimitada.
-- ---------------------------------------------------------------

alter table public.customers
  add column exclude_loyalty boolean not null default false;

comment on column public.customers.exclude_loyalty is
  'Marca administrativa (solo service_role/DBA la escribe): true = el cliente NO participa en el loyalty sync de Loyverse (compras de staff/uso interno) — los receipts vinculados a este cliente loyverse_customer_id se ignoran con reason staff_customer y no generan loyalty_visits. false (default) = comportamiento normal. NO se excluye por receipt.employee_id ni por profiles.role. No la modifica el cliente autenticado (fuera de su grant de UPDATE); tampoco la lee.';

-- Seguridad: el cliente autenticado no debe leer ni escribir la marca.
--   * UPDATE/INSERT: ya bloqueados — los grants column-level de 0008
--     (update: name,email,phone,profile) no cubren columnas nuevas.
--   * SELECT: el grant table-level de 0008 (0008:45) SÍ cubriría la
--     columna nueva, por lo que se revoca a nivel columna. `select *`
--     del frontend (PostgREST) sigue funcionando: expande solo las
--     columnas accesibles (verified: supabaseAuthService usa select("*")).
revoke select (exclude_loyalty) on public.customers from authenticated;

-- service_role conserva el acceso a la marca (lectura para el sync y
-- futura escritura administrativa). Explícito para robustez (estilo 0007).
grant select (exclude_loyalty) on public.customers to service_role;