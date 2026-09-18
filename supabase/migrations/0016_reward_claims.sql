-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0016: solicitudes de canje (reward_claims).
-- Ruta: supabase/migrations/0016_reward_claims.sql
-- Aplicar con: supabase db push  (después de 0015)
--
-- Alance de ESTE checkpoint:
--   ÚNICAMENTE crea public.reward_claims (la estructura de solicitudes
--   de canje con OTP). La compuerta OTP sobre `redeem_reward` (exigir
--   una claim 'verified' antes de canjear) queda FUERA de esta
--   migración: `public.redeem_reward()` sigue siendo la versión actual
--   de 0005, sin compuerta OTP. El OTP validado llegará en un
--   checkpoint/migración posterior.
--
-- Objetivo:
--   Registrar la solicitud de canje de una recompensa mediante un OTP
--   dinámico de uso único. El OTP NUNCA se guarda en claro: solo su
--   hash. El cliente lo solicita para SU recompensa; Staff/Admin lo
--   valida en barra (validación futura). Esta migración NO toca la
--   RPC de canje.
--
-- Ciclo de vida de un claim (y su significado):
--   pending   → OTP generado por el backend, aún NO validado.
--   verified  → OTP validado por Staff/Admin; recompensa todavía NO
--               consumida. Estado obligatorio antes de canjear (futuro).
--   redeemed  → canje definitivo realizado. Exige verificación previa
--               (verified_at + verified_by) y redeemed_at.
--   cancelled → claim invalidado (OTP vencido, reemplazado por uno
--               nuevo o anulado). Nunca consumido. Puede ocurrir antes
--               o después de la verificación, pero jamás después del
--               canje.
--
-- Reglas de negocio:
--   * OTP dinámico, de uso único, TTL 5 minutos (calculado por backend).
--   * Guardar SOLO el hash (otp_hash), jamás el OTP en claro.
--   * Un nuevo OTP invalida el anterior: máximo UNA claim 'pending'
--     por recompensa (índice único parcial). La Edge Function debe
--     cancelar la pendiente previa antes de insertar la nueva; si no,
--     el índice rechaza el INSERT (23505).
--   * Un claim solo es válido mientras status='pending' y
--     expires_at > now(). "expired" se deriva en lectura; no es estado.
--
-- Alcance:
--   * Crea public.reward_claims. NO modifica public.redeem_reward()
--     ni migraciones previas.
--   * El frontend no escribe aquí: INSERT/UPDATE/DELETE son de la
--     Edge Function (service_role / SECURITY DEFINER, validando JWT).
--   * Sin triggers ni lógica de transición todavía: la estructura
--     soporta pending → verified → redeemed y pending/verified →
--     cancelled; el control de transiciones vive en el backend.
-- ---------------------------------------------------------------

-- ------------------------------------------------------------------
-- 1) Tabla reward_claims
-- ------------------------------------------------------------------
create table public.reward_claims (
  id          uuid primary key default gen_random_uuid(),

  reward_id   uuid not null
    references public.rewards(id) on delete restrict,

  customer_id uuid not null
    references public.customers(id) on delete restrict,

  -- Solo el hash del OTP (p. ej. SHA-256 + pepper). Nunca en claro.
  otp_hash    text not null,

  -- Lo calcula el backend (now() + 5 min). Nunca el reloj del cliente.
  expires_at  timestamptz not null,

  status      text not null default 'pending'
    check (status in ('pending', 'verified', 'redeemed', 'cancelled')),

  verified_at timestamptz,
  verified_by text,
  redeemed_at timestamptz,

  created_at  timestamptz not null default now(),

  -- El hash no puede ser vacío (evita filas "válidas" sin secreto).
  constraint reward_claims_otp_hash_check check (btrim(otp_hash) <> ''),

  -- El vencimiento es posterior a la creación (TTL positivo).
  constraint reward_claims_expiry_check check (expires_at > created_at),

  -- pending: OTP generado, aún sin validar → sin verificación ni canje.
  constraint reward_claims_pending_state_check check (
    status <> 'pending'
    or (verified_at is null and verified_by is null and redeemed_at is null)
  ),

  -- verified y redeemed exigen OTP validado por Staff/Admin.
  -- Esto es lo que atará el canje definitivo a una verificación previa:
  -- no puede existir un 'redeemed' sin 'verified_at' + 'verified_by'.
  constraint reward_claims_verified_state_check check (
    status not in ('verified', 'redeemed')
    or (verified_at is not null and verified_by is not null)
  ),

  -- Verificación coherente: timestamp y actor van juntos o ninguno.
  -- (cancelled admite ambos casos: invalidado antes o después de validar.)
  constraint reward_claims_verification_pair_check check (
    (verified_at is null) = (verified_by is null)
  ),

  -- canje definitivo ⇔ redeemed_at. Un claim no 'redeemed' nunca tiene
  -- redeemed_at, por lo que cancelled/verified quedan sin consumo.
  constraint reward_claims_redeemed_state_check check (
    (redeemed_at is not null) = (status = 'redeemed')
  )
);

comment on table public.reward_claims is
  'Solicitudes de canje con OTP dinámico de uso único. Solo guarda el hash del OTP; el OTP en claro nunca toca la base de datos.';
comment on column public.reward_claims.otp_hash is
  'Hash del OTP (nunca el OTP en claro). Se compara en la Edge Function, no en el cliente.';
comment on column public.reward_claims.expires_at is
  'Vencimiento real calculado por el backend (created_at + 5 min). "expired" se deriva en lectura: pending AND expires_at <= now().';
comment on column public.reward_claims.status is
  'pending: OTP generado sin validar. verified: OTP validado, recompensa aún NO consumida. redeemed: canje definitivo (exige verificación previa). cancelled: claim invalidado; puede conservar verified_at/verified_by para auditoría, pero NUNCA consume la recompensa ni es elegible para canje.';
comment on constraint reward_claims_verified_state_check on public.reward_claims is
  'El canje definitivo (redeemed) solo puede existir sobre un claim previamente verificado: verified_at y verified_by obligatorios en verified y redeemed.';
comment on constraint reward_claims_redeemed_state_check on public.reward_claims is
  'redeemed_at existe si y solo si status = redeemed; cancelled y verified nunca consumen la recompensa.';

-- ------------------------------------------------------------------
-- 2) Índices
-- ------------------------------------------------------------------
-- Máximo UNA claim pendiente por recompensa: al generar un OTP nuevo la
-- Edge Function cancela el pendiente anterior; si no lo hace, este índice
-- rechaza el INSERT (23505) y garantiza que un OTP viejo no siga vivo.
create unique index reward_claims_one_pending_per_reward_idx
  on public.reward_claims (reward_id)
  where status = 'pending';

-- Máximo UNA claim verificada por recompensa. El canje definitivo
-- (checkpoint OTP posterior) buscará exactamente un candidato 'verified'
-- y hará un único UPDATE ... WHERE status='verified'; este índice
-- garantiza que ese UPDATE tenga como máximo UNA fila objetivo, de forma
-- atómica. Además, como su predicado es status='verified', una claim
-- 'cancelled' o 'redeemed' queda FUERA del índice: una verificación
-- invalidada jamás puede ocupar el cupo ni ser elegida por el canje.
create unique index reward_claims_one_verified_per_reward_idx
  on public.reward_claims (reward_id)
  where status = 'verified';

comment on index public.reward_claims_one_verified_per_reward_idx is
  'Máximo una claim verified por recompensa: objetivo único y atómico del canje. Excluye cancelled/redeemed, por lo que una verificación invalidada nunca es elegible.';

-- Historial de solicitudes por recompensa.
create index reward_claims_reward_idx
  on public.reward_claims (reward_id, created_at desc);

-- Historial / actividad de claims por cliente.
create index reward_claims_customer_idx
  on public.reward_claims (customer_id, created_at desc);

-- ------------------------------------------------------------------
-- 3) RLS + privilegios mínimos
-- ------------------------------------------------------------------
-- El frontend NO inserta, actualiza ni borra: toda mutación sensible es
-- de la Edge Function (service_role / SECURITY DEFINER). El cliente solo
-- puede LEER sus propios claims, y aun así con columnas limitadas:
-- otp_hash (y verified_by) quedan FUERA del grant column-level.
alter table public.reward_claims enable row level security;

revoke all on table public.reward_claims from anon, authenticated;

grant select (
  id, reward_id, customer_id, expires_at, status,
  verified_at, redeemed_at, created_at
) on public.reward_claims to authenticated;

grant all on table public.reward_claims to service_role;

create policy reward_claims_customer_select
  on public.reward_claims
  for select
  to authenticated
  using (
    customer_id in (
      select c.id
        from public.customers c
       where c.auth_user_id = auth.uid()
    )
  );