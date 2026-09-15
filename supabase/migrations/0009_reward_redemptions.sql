-- ---------------------------------------------------------------
-- Salmos Café Loyalty — 0009: evidencia de redención en Loyverse.
-- ---------------------------------------------------------------

create table public.reward_redemptions (
  id uuid primary key default gen_random_uuid(),

  reward_id uuid not null
    references public.rewards(id) on delete restrict,

  customer_id uuid not null
    references public.customers(id) on delete restrict,

  redemption_type text not null
    check (redemption_type in ('BEVERAGE', 'CONSUMPTION_150')),

  loyverse_receipt_id text not null,
  loyverse_receipt_number text,

  loyverse_discount_id text not null,
  loyverse_discount_name text not null,

  discount_amount numeric(10,2) not null
    check (discount_amount > 0),

  redeemed_at timestamptz not null,
  created_at timestamptz not null default now(),

  constraint reward_redemptions_loyverse_event_key
    unique (loyverse_receipt_id, loyverse_discount_id)
);

create index reward_redemptions_reward_idx
  on public.reward_redemptions (reward_id);

create index reward_redemptions_customer_idx
  on public.reward_redemptions (customer_id, redeemed_at desc);

create index reward_redemptions_receipt_idx
  on public.reward_redemptions (loyverse_receipt_id);

comment on table public.reward_redemptions is
  'Evidencia de redenciones de recompensas Salmos detectadas en receipts de Loyverse.';

comment on column public.reward_redemptions.redemption_type is
  'Tipo de recompensa: BEVERAGE o CONSUMPTION_150. Se determina por el discount ID de Loyverse, no por el monto.';

comment on constraint reward_redemptions_loyverse_event_key on
  public.reward_redemptions is
  'Idempotencia: el mismo discount aplicado al mismo receipt solo puede generar una redención.';

-- RLS: la tabla no será modificada directamente por el frontend.
alter table public.reward_redemptions enable row level security;

revoke all on table public.reward_redemptions from anon, authenticated;
grant select on table public.reward_redemptions to authenticated;
grant all on table public.reward_redemptions to service_role;

create policy reward_redemptions_customer_select
  on public.reward_redemptions
  for select
  to authenticated
  using (
    customer_id in (
      select c.id
        from public.customers c
       where c.auth_user_id = auth.uid()
    )
  );
