// Suite de la lógica pura del motor de lealtad (D1.2-1).
// Importa DIRECTAMENTE supabase/functions/_shared/loyaltyEngineCore.js
// (sin Deno, sin Supabase, sin red): el core es puro e importable desde
// Node. Corre con: node --test tests/  (pero la ruta exacta es
// `node --test "tests/*.test.mjs"`, ver package.json).
//
// Cubre (spec D1.2-1 §20):
//   * validación de payload (visit/cancel/redeem)
//   * política de actores (customer nunca pasa; sin staff falso)
//   * timezone de negocio America/Tijuana (incl. DST) con `now` inyectable
//   * mapeo a RPCs de 0005 (argumentos EXACTOS)
//   * escaneo de seguridad: SUPABASE_SERVICE_ROLE_KEY solo del lado servidor

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  BUSINESS_TIMEZONE,
  OPERATIONS,
  buildCancelVisitArgs,
  buildRedeemRewardArgs,
  buildRegisterVisitArgs,
  buildResponseBody,
  buildErrorResponseBody,
  buildRpcArgs,
  decideActorPolicy,
  errorOf,
  getBusinessDate,
  isFutureDate,
  mapRpcError,
  parseBearer,
  parseJsonBody,
  requireVerifiedStaff,
  validateOperation,
  validatePayload,
} from "../supabase/functions/_shared/loyaltyEngineCore.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");

const UUID_A = "11111111-2222-4333-8444-555555555555";
const UUID_B = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function customerUser(overrides = {}) {
  return { id: UUID_A, email: "a@example.com", ...overrides };
}

// ---------------------------------------------------------------
// validateOperation
// ---------------------------------------------------------------
test("validateOperation acepta las tres operaciones", () => {
  for (const op of OPERATIONS) assert.equal(validateOperation(op).ok, true);
});

test("validateOperation rechaza operación desconocida", () => {
  const res = validateOperation("explode");
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_OPERATION");
});

// ---------------------------------------------------------------
// validatePayload — visita
// ---------------------------------------------------------------
test("validatePayload visit válido normaliza datos", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "sale-0001",
    amount: 120.5,
    storeId: "S-TJ-01",
    employeeId: "emp-7",
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, {
    customerId: UUID_A,
    externalSaleId: "sale-0001",
    amount: 120.5,
    storeId: "S-TJ-01",
    employeeId: "emp-7",
  });
});

test("validatePayload visit acepta campos opcionales ausentes", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "sale-0002",
    amount: 80,
  });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { customerId: UUID_A, externalSaleId: "sale-0002", amount: 80 });
});

test("validatePayload visit rechaza customerId faltante", () => {
  const res = validatePayload("visit", { operation: "visit", externalSaleId: "x", amount: 80 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "MISSING_CUSTOMER_ID");
});

test("validatePayload visit rechaza customerId no-UUID", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: "no-es-uuid",
    externalSaleId: "x",
    amount: 80,
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_UUID");
});

test("validatePayload visit rechaza externalSaleId faltante", () => {
  const res = validatePayload("visit", { operation: "visit", customerId: UUID_A, amount: 80 });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "MISSING_EXTERNAL_SALE_ID");
});

test("validatePayload visit rechaza amount no numérico", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "x",
    amount: "80",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "INVALID_AMOUNT");
});

test("validatePayload visit rechaza amount <= 0 o no finito", () => {
  for (const amount of [0, -5, NaN, Infinity]) {
    const res = validatePayload("visit", {
      operation: "visit",
      customerId: UUID_A,
      externalSaleId: "x",
      amount,
    });
    assert.equal(res.ok, false, `amount=${amount} debería rechazarse`);
    assert.equal(res.error.code, "INVALID_AMOUNT");
  }
});

// El mínimo $50 MXN NO se valida aquí: es regla de negocio del RPC.
test("validatePayload visit NO aplica el mínimo de $50 (lo hace el RPC)", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "x",
    amount: 30,
  });
  assert.equal(res.ok, true);
});

test("validatePayload visit rechaza storeId/employeeId/paymentMethod con tipo inválido", () => {
  const bad = { customerId: UUID_A, externalSaleId: "x", amount: 80 };
  assert.equal(validatePayload("visit", { ...bad, storeId: 5 }).error.code, "INVALID_STORE_ID");
  assert.equal(validatePayload("visit", { ...bad, employeeId: {} }).error.code, "INVALID_EMPLOYEE_ID");
  assert.equal(validatePayload("visit", { ...bad, paymentMethod: null }).error.code, "INVALID_PAYMENT_METHOD");
});

// paymentMethod pertenece a la transacción, NO al modelo loyalty_visits
// (0005 no agrega columna; decisión aprobada). La validación lo acepta
// solo formalmente; buildRegisterVisitArgs jamás lo envía al RPC.
test("validatePayload visit acepta paymentMethod pero el RPC no lo recibe", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "x",
    amount: 80,
    paymentMethod: "tarjeta",
  });
  assert.equal(res.ok, true);
  assert.equal(res.data.paymentMethod, "tarjeta");
  const args = buildRegisterVisitArgs(res.data, {
    visitDate: "2026-09-12",
    actor: { actorId: "staff-1", actorRole: "staff" },
  });
  assert.equal(args.paymentMethod, undefined);
  assert.equal(Object.hasOwn(args, "paymentMethod"), false);
});

// ---------------------------------------------------------------
// validatePayload — cancel / redeem
// ---------------------------------------------------------------
test("validatePayload cancel válido", () => {
  const res = validatePayload("cancel", { operation: "cancel", visitId: UUID_A });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { visitId: UUID_A });
});

test("validatePayload cancel rechaza sin visitId o UUID inválido", () => {
  const missing = validatePayload("cancel", { operation: "cancel" });
  assert.equal(missing.error.code, "MISSING_VISIT_ID");
  const badUuid = validatePayload("cancel", { operation: "cancel", visitId: "abc" });
  assert.equal(badUuid.error.code, "INVALID_UUID");
});

test("validatePayload redeem válido", () => {
  const res = validatePayload("redeem", { operation: "redeem", rewardId: UUID_B });
  assert.equal(res.ok, true);
  assert.deepEqual(res.data, { rewardId: UUID_B });
});

test("validatePayload redeem rechaza sin rewardId o UUID inválido", () => {
  const missing = validatePayload("redeem", { operation: "redeem" });
  assert.equal(missing.error.code, "MISSING_REWARD_ID");
  const badUuid = validatePayload("redeem", { operation: "redeem", rewardId: "zzz" });
  assert.equal(badUuid.error.code, "INVALID_UUID");
});

// ---------------------------------------------------------------
// Campos prohibidos: actorId/actorRole y visitDate puestos por el cliente
// ---------------------------------------------------------------
test("validatePayload rechaza actorId/actorRole del payload", () => {
  for (const op of OPERATIONS) {
    const withRole = validatePayload(op, {
      operation: op,
      actorRole: "staff",
      customerId: UUID_A,
      externalSaleId: "x",
      amount: 80,
    });
    assert.equal(withRole.ok, false, `actorRole no debe aceptarse en ${op}`);
    assert.equal(withRole.error.code, "ACTOR_FIELDS_NOT_ALLOWED");
  }
});

test("validatePayload rechaza visitDate/visit_date del payload", () => {
  const res = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "x",
    amount: 80,
    visitDate: "2026-09-10",
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "VISIT_DATE_NOT_ALLOWED");
  const res2 = validatePayload("visit", {
    operation: "visit",
    customerId: UUID_A,
    externalSaleId: "x",
    amount: 80,
    visit_date: "2026-09-10",
  });
  assert.equal(res2.error.code, "VISIT_DATE_NOT_ALLOWED");
});

test("validatePayload rechaza cuerpo no-objeto (JSON array/null/string)", () => {
  for (const body of [[], null, "hola", 42]) {
    const res = validatePayload("visit", body);
    assert.equal(res.ok, false);
    assert.equal(res.error.code, "INVALID_PAYLOAD");
  }
});

// ---------------------------------------------------------------
// Política de actores — sin identidad Staff, todo autenticado es customer
// ---------------------------------------------------------------
test("customer JWT no puede registrar su propia visita (SELF_VISIT_NOT_ALLOWED)", () => {
  const res = decideActorPolicy({ operation: "visit", user: customerUser() });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "SELF_VISIT_NOT_ALLOWED");
  assert.equal(res.error.status, 403);
});

test("customer JWT no puede cancelar ni redimir (staff-only)", () => {
  const cancel = decideActorPolicy({ operation: "cancel", user: customerUser() });
  assert.equal(cancel.allowed, false);
  assert.equal(cancel.error.code, "CUSTOMER_CANCEL_NOT_ALLOWED");

  const redeem = decideActorPolicy({ operation: "redeem", user: customerUser() });
  assert.equal(redeem.allowed, false);
  assert.equal(redeem.error.code, "CUSTOMER_REDEEM_NOT_ALLOWED");
});

test("sin sesión -> UNAUTHORIZED", () => {
  for (const noUser of [undefined, null, {}]) {
    const res = decideActorPolicy({ operation: "visit", user: noUser });
    assert.equal(res.allowed, false);
    assert.equal(res.error.code, "UNAUTHORIZED");
    assert.equal(res.error.status, 401);
  }
});

test("NUNCA se concede staff por payload: role/fake/staff no existe en el core", () => {
  // El core no lee actorRole del body (lo rechaza en validación) y la
  // política deriva el rol SIEMPRE como customer. Un payload que intente
  // suplantar staff es denegado igual.
  const res = decideActorPolicy({
    operation: "visit",
    user: customerUser({ actorRole: "staff", staffToken: "secreto" }),
  });
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "SELF_VISIT_NOT_ALLOWED");
});

test("requireVerifiedStaff queda denegado hasta que exista auth staff real", () => {
  const res = requireVerifiedStaff();
  assert.equal(res.allowed, false);
  assert.equal(res.error.code, "STAFF_AUTH_REQUIRED");
  assert.equal(res.error.status, 403);
});

// ---------------------------------------------------------------
// Timezone de negocio — America/Tijuana, NUNCA UTC
// ---------------------------------------------------------------
test("BUSINESS_TIMEZONE es America/Tijuana", () => {
  assert.equal(BUSINESS_TIMEZONE, "America/Tijuana");
});

test("fecha de negocio: 2026-09-11T23:30 local -> 2026-09-11", () => {
  // 23:30 en Tijuana (PDT, -07:00) == 2026-09-12T06:30Z.
  const now = new Date("2026-09-12T06:30:00Z");
  assert.equal(getBusinessDate(now, BUSINESS_TIMEZONE), "2026-09-11");
});

test("fecha de negocio: 2026-09-12T00:05 local -> 2026-09-12", () => {
  // 00:05 en Tijuana (PDT, -07:00) == 2026-09-12T07:05Z.
  const now = new Date("2026-09-12T07:05:00Z");
  assert.equal(getBusinessDate(now, BUSINESS_TIMEZONE), "2026-09-12");
});

test("fecha de negocio: medianoche UTC NO es medianoche en Tijuana (UTC-slice es incorrecto)", () => {
  // 2026-09-12T00:00:00Z == 2026-09-11T17:00 PDT. Un corte de
  // toISOString().slice(0,10) diría '2026-09-12' → ERROR. El core da 11.
  const midnightUtc = new Date("2026-09-12T00:00:00Z");
  assert.equal(getBusinessDate(midnightUtc, BUSINESS_TIMEZONE), "2026-09-11");
});

test("fecha de negocio cruza correctamente el inicio de DST (primavera 2026)", () => {
  // DST de EE.UU./Tijuana 2026: inicia domingo 8-mar 02:00 PST -> 03:00 PDT.
  // Instante anterior a la transición: 2026-03-08T09:59Z == 01:59 PST (mar 8).
  assert.equal(getBusinessDate(new Date("2026-03-08T09:59:00Z"), BUSINESS_TIMEZONE), "2026-03-08");
  // Instante posterior a la transición: 2026-03-08T10:00Z == 03:00 PDT (mar 8).
  assert.equal(getBusinessDate(new Date("2026-03-08T10:00:00Z"), BUSINESS_TIMEZONE), "2026-03-08");
  // Día previo: 2026-03-07T23:30 local (PST) == 2026-03-08T07:30Z -> 7 de marzo.
  assert.equal(getBusinessDate(new Date("2026-03-08T07:30:00Z"), BUSINESS_TIMEZONE), "2026-03-07");
});

test("fecha de negocio cruza correctamente el fin de DST (otoño 2026)", () => {
  // DST de EE.UU./Tijuana 2026: termina domingo 1-nov 02:00 PDT -> 01:00 PST.
  // La 01:30 local existe DOS veces (offset -07:00 y -08:00); ambas → 1 de nov.
  assert.equal(getBusinessDate(new Date("2026-11-01T08:30:00Z"), BUSINESS_TIMEZONE), "2026-11-01"); // 01:30 PDT
  assert.equal(getBusinessDate(new Date("2026-11-01T09:30:00Z"), BUSINESS_TIMEZONE), "2026-11-01"); // 01:30 PST
  // 23:30 local del 1-nov (PST) == 2026-11-02T07:30Z → sigue siendo 1-nov.
  assert.equal(getBusinessDate(new Date("2026-11-02T07:30:00Z"), BUSINESS_TIMEZONE), "2026-11-01");
});

test("getBusinessDate lanza en Date inválida o no Date", () => {
  assert.throws(() => getBusinessDate(new Date("no-sirve")), TypeError);
  assert.throws(() => getBusinessDate("2026-09-12"), TypeError);
});

test("isFutureDate usa la fecha de negocio inyectada", () => {
  const now = new Date("2026-09-12T07:05:00Z"); // 2026-09-12 en Tijuana
  assert.equal(isFutureDate("2026-09-13", now, BUSINESS_TIMEZONE), true);
  assert.equal(isFutureDate("2026-09-12", now, BUSINESS_TIMEZONE), false);
  assert.equal(isFutureDate("2026-09-11", now, BUSINESS_TIMEZONE), false);
  assert.equal(isFutureDate(null, now, BUSINESS_TIMEZONE), false);
});

// ---------------------------------------------------------------
// Mapeo a RPCs — argumentos EXACTOS de 0005_loyalty_engine.sql
// ---------------------------------------------------------------
const ACTOR = { actorId: "system-edge", actorRole: "staff" };

test("buildRegisterVisitArgs coincide con la firma register_visit(uuid,text,numeric,date,text,text,text,text,text)", () => {
  const data = {
    customerId: UUID_A,
    externalSaleId: "sale-099",
    amount: 150,
    storeId: "S-TJ-01",
    employeeId: "emp-9",
  };
  const args = buildRegisterVisitArgs(data, { visitDate: "2026-09-12", actor: ACTOR, source: "manual" });
  assert.deepEqual(args, {
    p_customer_id: UUID_A,
    p_external_sale_id: "sale-099",
    p_amount: 150,
    p_visit_date: "2026-09-12",
    p_store_id: "S-TJ-01",
    p_employee_id: "emp-9",
    p_source: "manual",
    p_actor_id: "system-edge",
    p_actor_role: "staff",
  });
});

test("buildRegisterVisitArgs usa null para opcionales ausentes", () => {
  const args = buildRegisterVisitArgs(
    { customerId: UUID_A, externalSaleId: "s1", amount: 80 },
    { visitDate: "2026-09-12", actor: ACTOR }
  );
  assert.equal(args.p_store_id, null);
  assert.equal(args.p_employee_id, null);
  assert.equal(args.p_source, "manual");
});

test("buildCancelVisitArgs coincide con la firma cancel_visit(uuid,text,text)", () => {
  const args = buildCancelVisitArgs({ visitId: UUID_B }, ACTOR);
  assert.deepEqual(args, { p_visit_id: UUID_B, p_actor_id: "system-edge", p_actor_role: "staff" });
});

test("buildRedeemRewardArgs coincide con la firma redeem_reward(uuid,text,text)", () => {
  const args = buildRedeemRewardArgs({ rewardId: UUID_A }, ACTOR);
  assert.deepEqual(args, { p_reward_id: UUID_A, p_actor_id: "system-edge", p_actor_role: "staff" });
});

test("buildRpcArgs despacha según la operación", () => {
  const visit = buildRpcArgs("visit", { customerId: UUID_A, externalSaleId: "s", amount: 80 }, { visitDate: "2026-09-12", actor: ACTOR });
  assert.equal(visit.p_customer_id, UUID_A);
  assert.equal(buildRpcArgs("cancel", { visitId: UUID_B }, { actor: ACTOR }).p_visit_id, UUID_B);
  assert.equal(buildRpcArgs("redeem", { rewardId: UUID_A }, { actor: ACTOR }).p_reward_id, UUID_A);
});

// ---------------------------------------------------------------
// Errores y cuerpos de respuesta (contrato D1.2)
// ---------------------------------------------------------------
test("errorOf construye la forma {code,message,status}", () => {
  assert.deepEqual(errorOf("X", "msg", 403), { code: "X", message: "msg", status: 403 });
});

test("mapRpcError traduce códigos controlados", () => {
  assert.equal(mapRpcError({ code: "P0001", message: "Monto mínimo $50 MXN." }).code, "RPC_REJECTED");
  assert.equal(mapRpcError({ code: "42501" }).code, "RPC_NOT_AUTHORIZED");
  assert.equal(mapRpcError({ code: "23505" }).code, "DUPLICATE");
  assert.equal(mapRpcError({}).code, "INTERNAL");
  assert.equal(mapRpcError({ code: "P0001", message: "X" }).status, 400);
});

test("buildResponseBody / buildErrorResponseBody respetan el contrato", () => {
  assert.deepEqual(buildResponseBody("visit", { reused: true }), { ok: true, operation: "visit", result: { reused: true } });
  assert.deepEqual(buildErrorResponseBody("E", "msg"), { ok: false, error: { code: "E", message: "msg" } });
});

// ---------------------------------------------------------------
// Helpers de transporte
// ---------------------------------------------------------------
test("parseBearer extrae el token correcto", () => {
  assert.equal(parseBearer("Bearer abc123"), "abc123");
  assert.equal(parseBearer(null), null);
  assert.equal(parseBearer("no-bearer"), null);
  assert.equal(parseBearer(""), null);
});

test("parseJsonBody valida JSON", () => {
  assert.deepEqual(parseJsonBody('{"a":1}'), { ok: true, data: { a: 1 } });
  assert.equal(parseJsonBody("no-json").ok, false);
  assert.equal(parseJsonBody("no-json").error.code, "INVALID_BODY");
});

// ---------------------------------------------------------------
// Escaneo de seguridad
// ---------------------------------------------------------------
// La service role key SOLO puede existir del lado servidor (Edge
// Function, vía Deno.env.get). Ningún test, ni el core, ni código
// frontend puede contenerla.
test("SUPABASE_SERVICE_ROLE_KEY no se filtra en src/ ni en el core", () => {
  const forbidden = "SUPABASE_SERVICE_ROLE_KEY";
  const files = [];

  const scanDir = (dir, acc) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) scanDir(full, acc);
      else if (/\.(js|mjs|ts|tsx|jsx|html)$/.test(entry.name)) acc.push(full);
    }
    return acc;
  };

  // Código frontend y el core puro: ni siquiera deben nombrar la variable
  // (solo existe del lado servidor de la Edge Function).
  files.push(...scanDir(join(REPO_ROOT, "src"), []));
  files.push(join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"));

  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!content.includes(forbidden), `${forbidden} aparece en ${file} — prohibido en cliente/core.`);
  }
});

test("ningún archivo nuevo filtra un VALOR de la service role key", () => {
  // El nombre de la variable puede citarse en descripciones de test; lo
  // prohibido es un valor literal: una asignación con un secreto real.
  const leakedValue = /SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+["']/;
  const files = [
    join(REPO_ROOT, "tests/loyalty-engine.test.mjs"),
    join(REPO_ROOT, "supabase/functions/loyalty-engine/index.ts"),
    join(REPO_ROOT, "supabase/functions/_shared/loyaltyEngineCore.js"),
  ];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.ok(!leakedValue.test(content), `valor de service role key filtrado en ${file}`);
  }
});

test("la Edge Function lee la service role key solo por Deno.env.get", () => {
  const edge = readFileSync(join(REPO_ROOT, "supabase/functions/loyalty-engine/index.ts"), "utf8");
  const readAsEnv = edge.includes('Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")');
  assert.equal(readAsEnv, true);
  // Ninguna asignación dura de la key (un valor literal nunca debe existir).
  assert.equal(/SUPABASE_SERVICE_ROLE_KEY\s*[:=]\s*["'][^"']+["']/.test(edge), false);
});