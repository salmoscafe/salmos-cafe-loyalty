// ---------------------------------------------------------------
// supabaseSqlHarness — Postgres 17 embebido (PGlite, WASM) que emula
// lo mínimo de Supabase para probar AUTORIZACIÓN real de las RPCs:
//
//   * roles anon / authenticated / service_role (BYPASSRLS)
//   * schema auth con auth.users, auth.uid(), auth.role(), auth.jwt()
//     leyendo request.jwt.claims igual que PostgREST/Supabase
//   * los DEFAULT PRIVILEGES de Supabase: todo objeto nuevo en public
//     (tablas, funciones, secuencias) queda con GRANT a anon,
//     authenticated y service_role. Esto reproduce el estado REMOTO
//     observado (anon podía ejecutar las RPCs SECURITY DEFINER).
//
// Aplica supabase/migrations/*.sql en orden y expone helpers para
// ejecutar SQL "como" anon / authenticated(uid) / service_role.
// No toca ninguna base remota.
// ---------------------------------------------------------------
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(HERE, "..", "..");
export const MIGRATIONS_DIR = join(REPO_ROOT, "supabase", "migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
grant usage on schema auth to anon, authenticated, service_role;

create table auth.users (
  id                 uuid primary key default gen_random_uuid(),
  email              text,
  phone              text,
  raw_user_meta_data jsonb default '{}'::jsonb,
  email_confirmed_at timestamptz,
  created_at         timestamptz default now()
);

create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(auth.jwt() ->> 'sub', '')::uuid
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(auth.jwt() ->> 'role', '')
$$;
grant execute on all functions in schema auth to anon, authenticated, service_role;

grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export function listMigrations({ upTo } = {}) {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort()
    .filter((f) => (upTo ? f.slice(0, 4) <= upTo : true));
}

export async function createDatabase({ upTo } = {}) {
  const db = new PGlite();
  await db.exec(SUPABASE_SHIM);
  for (const file of listMigrations({ upTo })) {
    // pgcrypto no existe en PGlite; las migraciones solo lo usan por
    // gen_random_uuid(), que es nativo desde Postgres 13.
    const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf8").replace(
      /create extension if not exists "?pgcrypto"?\s*;/gi,
      "-- (harness) pgcrypto omitido: gen_random_uuid() es nativo"
    );
    try {
      await db.exec(sql);
    } catch (error) {
      throw new Error(`Fallo aplicando ${file}: ${error.message}`);
    }
  }
  return db;
}

// Ejecuta `sql` con el rol y claims indicados, dentro de una
// transacción que SIEMPRE hace rollback (no contamina otros tests).
// Devuelve { ok, rows, error, code }.
export async function runAs(db, who, sql, params = []) {
  const claims =
    who.role === "postgres"
      ? null
      : JSON.stringify({ role: who.role, ...(who.uid ? { sub: who.uid } : {}) });
  try {
    return await db.transaction(async (tx) => {
      if (claims) {
        await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
        await tx.exec(`set local role ${who.role}`);
      }
      const res = await tx.query(sql, params);
      await tx.rollback();
      return { ok: true, rows: res.rows };
    });
  } catch (error) {
    return { ok: false, error: error.message, code: error.code };
  }
}

// Igual que runAs pero CONFIRMA la transacción (para preparar datos
// por el mismo camino que usaría la Edge Function). Lanza si falla.
export async function commitAs(db, who, sql, params = []) {
  return db.transaction(async (tx) => {
    if (who.role !== "postgres") {
      const claims = JSON.stringify({ role: who.role, ...(who.uid ? { sub: who.uid } : {}) });
      await tx.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await tx.exec(`set local role ${who.role}`);
    }
    const res = await tx.query(sql, params);
    return res.rows;
  });
}

export const POSTGRES = Object.freeze({ role: "postgres" });
export const ANON = Object.freeze({ role: "anon" });
export const SERVICE = Object.freeze({ role: "service_role" });
export const asUser = (uid) => ({ role: "authenticated", uid });
