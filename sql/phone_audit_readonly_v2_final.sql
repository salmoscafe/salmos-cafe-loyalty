-- Los duplicados de auth.users son potenciales, no necesariamente una violación de un índice en esa tabla.
-- Auditoría de lectura: metadata.phone vs customers.phone (solo conteos)
-- Requiere: public.canonical_mx_phone(text) existente (migración 0022/0027)
-- El índice de unicidad de phone en customers es parcial + digits_only (0008)
-- NO devuelve teléfonos, IDs, correos ni nombres.
WITH c_base AS (
  SELECT count(*)::int AS total_customers, count(phone)::int AS cust_has_phone, count(*) FILTER (WHERE phone IS NULL)::int AS cust_phone_null, count(*) FILTER (WHERE phone IS NOT NULL AND nullif(regexp_replace(phone, '\D', '', 'g'), '') IS NULL)::int AS cust_phone_empty_after_norm, count(*) FILTER (WHERE phone IS NOT NULL AND nullif(regexp_replace(phone, '\D', '', 'g'), '') IS NOT NULL AND public.canonical_mx_phone(phone) IS NULL)::int AS cust_phone_malformed_e164, count(*) FILTER (WHERE phone IS NOT NULL AND public.canonical_mx_phone(phone) IS NOT NULL)::int AS cust_phone_canon_ok
  FROM public.customers
),
u_base AS (
  SELECT count(*)::int AS total_users, count(raw_user_meta_data->>'phone')::int AS auth_has_meta_phone, count(*) FILTER (WHERE raw_user_meta_data->>'phone' IS NULL)::int AS auth_meta_phone_null, count(*) FILTER (WHERE raw_user_meta_data->>'phone' IS NOT NULL AND nullif(regexp_replace(raw_user_meta_data->>'phone', '\D', '', 'g'), '') IS NULL)::int AS auth_meta_phone_empty_after_norm, count(*) FILTER (WHERE raw_user_meta_data->>'phone' IS NOT NULL AND nullif(regexp_replace(raw_user_meta_data->>'phone', '\D', '', 'g'), '') IS NOT NULL AND public.canonical_mx_phone(raw_user_meta_data->>'phone') IS NULL)::int AS auth_meta_phone_malformed, count(*) FILTER (WHERE raw_user_meta_data->>'phone' IS NOT NULL AND public.canonical_mx_phone(raw_user_meta_data->>'phone') IS NOT NULL)::int AS auth_meta_phone_canon_ok
  FROM auth.users
),
c_norm AS (
  SELECT id, auth_user_id, phone, nullif(regexp_replace(phone, '\D', '', 'g'), '') AS phone_digits, public.canonical_mx_phone(phone) AS phone_canon_e164
  FROM public.customers
),
u_norm AS (
  SELECT id, raw_user_meta_data->>'phone' AS meta_phone_raw, nullif(regexp_replace(raw_user_meta_data->>'phone', '\D', '', 'g'), '') AS meta_phone_digits, public.canonical_mx_phone(raw_user_meta_data->>'phone') AS meta_phone_canon_e164
  FROM auth.users
),
v AS (
  SELECT count(*) FILTER (WHERE c.phone_digits IS NOT NULL AND u.meta_phone_digits IS NOT NULL AND c.phone_digits = u.meta_phone_digits)::int AS linked_match_digits, count(*) FILTER (WHERE c.phone_canon_e164 IS NOT NULL AND u.meta_phone_canon_e164 IS NOT NULL AND c.phone_canon_e164 = u.meta_phone_canon_e164)::int AS linked_match_canon_e164, count(*) FILTER (WHERE c.phone_digits IS NULL AND u.meta_phone_digits IS NULL)::int AS linked_both_null_or_empty, count(*) FILTER (WHERE (c.phone_digits IS NOT NULL AND u.meta_phone_digits IS NULL) OR (c.phone_digits IS NULL AND u.meta_phone_digits IS NOT NULL))::int AS linked_discordant_presence, count(*) FILTER (WHERE c.phone_digits IS NOT NULL AND u.meta_phone_digits IS NOT NULL AND c.phone_digits <> u.meta_phone_digits)::int AS linked_diff_digits
  FROM c_norm c JOIN u_norm u ON u.id = c.auth_user_id
),
cust_dups_digits AS (
  SELECT count(*) FILTER (WHERE phone_digits IS NOT NULL)::int AS cust_digits_nonnull, count(DISTINCT phone_digits) FILTER (WHERE phone_digits IS NOT NULL)::int AS cust_digits_distinct_nonnull, (count(*) FILTER (WHERE phone_digits IS NOT NULL) - count(DISTINCT phone_digits) FILTER (WHERE phone_digits IS NOT NULL))::int AS cust_digits_duplicates
  FROM c_norm
),
auth_dups_digits AS (
  SELECT count(*) FILTER (WHERE meta_phone_digits IS NOT NULL)::int AS auth_digits_nonnull, count(DISTINCT meta_phone_digits) FILTER (WHERE meta_phone_digits IS NOT NULL)::int AS auth_digits_distinct_nonnull, (count(*) FILTER (WHERE meta_phone_digits IS NOT NULL) - count(DISTINCT meta_phone_digits) FILTER (WHERE meta_phone_digits IS NOT NULL))::int AS auth_digits_duplicates
  FROM u_norm
),
orphans AS (
  SELECT count(*) FILTER (WHERE c.id IS NULL)::int AS auth_users_without_customer, count(*) FILTER (WHERE u.id IS NULL)::int AS customers_without_auth_user
  FROM u_norm u FULL OUTER JOIN c_norm c ON c.auth_user_id = u.id
)
SELECT
  c_base.total_customers, c_base.cust_has_phone, c_base.cust_phone_null, c_base.cust_phone_empty_after_norm, c_base.cust_phone_malformed_e164, c_base.cust_phone_canon_ok,
  u_base.total_users, u_base.auth_has_meta_phone, u_base.auth_meta_phone_null, u_base.auth_meta_phone_empty_after_norm, u_base.auth_meta_phone_malformed, u_base.auth_meta_phone_canon_ok,
  v.linked_match_digits, v.linked_match_canon_e164, v.linked_both_null_or_empty, v.linked_discordant_presence, v.linked_diff_digits,
  cust_dups_digits.cust_digits_nonnull, cust_dups_digits.cust_digits_distinct_nonnull, cust_dups_digits.cust_digits_duplicates,
  auth_dups_digits.auth_digits_nonnull, auth_dups_digits.auth_digits_distinct_nonnull, auth_dups_digits.auth_digits_duplicates,
  orphans.auth_users_without_customer, orphans.customers_without_auth_user
FROM c_base CROSS JOIN u_base CROSS JOIN v CROSS JOIN cust_dups_digits CROSS JOIN auth_dups_digits CROSS JOIN orphans;
