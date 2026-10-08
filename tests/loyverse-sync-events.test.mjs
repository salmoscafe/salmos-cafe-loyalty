// ---------------------------------------------------------------
// loyverse-sync-events.test.mjs — Fase 2A (0026): writer de
// customer_sync_events.
//   * Unitarios de supabase/functions/_shared/syncEvents.js con un
//     cliente y un logger falsos (sin red, sin Deno).
//   * Estáticos sobre supabase/functions/loyverse-customers/index.ts:
//     todos los eventos se escriben con `admin` (service_role), con
//     authUserId/traceId del servidor, sin campos del body, y ninguna
//     respuesta depende del resultado del registro.
// ---------------------------------------------------------------
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildSyncEventRow,
  recordSyncEvent,
  SYNC_EVENTS_TABLE,
  SYNC_EVENT_INSERT_FAILED,
} from "../supabase/functions/_shared/syncEvents.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FUNCTIONS_DIR = join(REPO_ROOT, "supabase", "functions");
const EDGE_PATH = join(FUNCTIONS_DIR, "loyverse-customers", "index.ts");

const TRACE = "6f1c2b8e-1d3a-4c5e-9f00-0000000000aa";
const UID = "aaaaaaaa-0000-4000-8000-0000000000a1";
const EVENT_TYPES = [
  "loyverse_linked",
  "loyverse_created",
  "loyverse_already_linked",
  "loyverse_conflict",
  "loyverse_error",
  "loyverse_updated",
];

// Fórmula histórica de logSyncEvent (HEAD bf3c686), para comparar formato.
const legacyRow = ({ authUserId, traceId, eventType, detail }) => ({
  auth_user_id: authUserId,
  trace_id: traceId,
  event_type: eventType,
  detail: { ...detail, traceId },
});

function fakeClient({ result = { data: null, error: null }, throws } = {}) {
  const calls = [];
  return {
    calls,
    from(table) {
      return {
        async insert(row) {
          calls.push({ table, row });
          if (throws !== undefined) throw throws;
          return result;
        },
      };
    },
  };
}

function spyLogger() {
  const entries = [];
  const logger = (entry) => entries.push(entry);
  return { entries, logger };
}

// detail con datos que NUNCA deben aparecer en el log de fallo.
const SENSITIVE_DETAIL = {
  code: "email_phone_conflict",
  emailCustomerId: "lv-third-party-email",
  phoneCustomerIds: ["lv-third-party-phone"],
  requestedCustomerCode: "SC-SECRETCODE",
};
const SECRET_MESSAGE = "duplicate key value violates unique constraint; Key (email)=(victim@example.com)";

const baseEvent = (over = {}) => ({
  authUserId: UID,
  traceId: TRACE,
  eventType: "loyverse_conflict",
  detail: SENSITIVE_DETAIL,
  ...over,
});

function assertSafeLogEntry(entry, { code }) {
  assert.deepEqual(entry, {
    event: SYNC_EVENT_INSERT_FAILED,
    traceId: TRACE,
    eventType: "loyverse_conflict",
    authUserId: UID,
    code,
  });
  const text = JSON.stringify(entry);
  for (const leak of ["lv-third-party", "SC-SECRETCODE", "victim@example.com", "duplicate key", "detail", "message"]) {
    assert.equal(text.includes(leak), false, `el log no incluye ${leak}`);
  }
}

// ---------------------------------------------------------------
// Unitarios del writer.
// ---------------------------------------------------------------
test("caso 1 — éxito: inserta en customer_sync_events la fila exacta, no lanza y no registra error", async () => {
  const client = fakeClient();
  const { entries, logger } = spyLogger();
  const event = baseEvent({ eventType: "loyverse_created", detail: { created: true, id: "lv-1" } });
  const out = await recordSyncEvent(client, event, { logger });
  assert.deepEqual(out, { ok: true });
  assert.equal(entries.length, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(client.calls[0].table, "customer_sync_events");
  assert.equal(SYNC_EVENTS_TABLE, "customer_sync_events");
  assert.deepEqual(client.calls[0].row, {
    auth_user_id: UID,
    trace_id: TRACE,
    event_type: "loyverse_created",
    detail: { created: true, id: "lv-1", traceId: TRACE },
  });
});

test("caso 2 — Supabase devuelve { error }: no lanza, indica fallo y registra solo datos técnicos", async () => {
  const client = fakeClient({
    result: { data: null, error: { code: "42501", message: SECRET_MESSAGE, details: SECRET_MESSAGE, hint: null } },
  });
  const { entries, logger } = spyLogger();
  const out = await recordSyncEvent(client, baseEvent(), { logger });
  assert.deepEqual(out, { ok: false, code: "42501" });
  assert.equal(entries.length, 1);
  assertSafeLogEntry(entries[0], { code: "42501" });
});

test("caso 3 — el insert lanza: no se propaga y se registra un fallo técnico seguro", async () => {
  for (const thrown of [Object.assign(new Error(SECRET_MESSAGE), { code: "ECONNRESET" }), new Error(SECRET_MESSAGE), SECRET_MESSAGE, null]) {
    const client = fakeClient({ throws: thrown });
    const { entries, logger } = spyLogger();
    const out = await recordSyncEvent(client, baseEvent(), { logger });
    const code = thrown?.code ?? null;
    assert.deepEqual(out, { ok: false, code });
    assert.equal(entries.length, 1);
    assertSafeLogEntry(entries[0], { code });
  }
});

test("caso 3b — un error.code no textual (objeto) nunca llega al log; un logger que falla tampoco rompe", async () => {
  const client = fakeClient({ result: { data: null, error: { code: { message: SECRET_MESSAGE } } } });
  const { entries, logger } = spyLogger();
  assert.deepEqual(await recordSyncEvent(client, baseEvent(), { logger }), { ok: false, code: null });
  assertSafeLogEntry(entries[0], { code: null });

  const failing = fakeClient({ result: { data: null, error: { code: "57014" } } });
  const out = await recordSyncEvent(failing, baseEvent(), {
    logger: () => {
      throw new Error("logger caído");
    },
  });
  assert.deepEqual(out, { ok: false, code: "57014" });
});

test("caso 3c — sin logger explícito, el fallo sale por console.error como JSON técnico", async (t) => {
  const printed = [];
  t.mock.method(console, "error", (line) => printed.push(line));
  const client = fakeClient({ result: { data: null, error: { code: "23503", message: SECRET_MESSAGE } } });
  await recordSyncEvent(client, baseEvent());
  assert.equal(printed.length, 1);
  assertSafeLogEntry(JSON.parse(printed[0]), { code: "23503" });
});

test("caso 4 — el traceId del servidor prevalece sobre un traceId dentro de detail", async () => {
  const client = fakeClient();
  await recordSyncEvent(client, baseEvent({ detail: { via: "email", traceId: "evil-trace" } }), { logger: () => {} });
  const { row } = client.calls[0];
  assert.equal(row.trace_id, TRACE);
  assert.equal(row.detail.traceId, TRACE);
});

test("caso 5 — formato idéntico al histórico para todos los detail que produce la Edge y los 6 event_type", () => {
  const details = [
    undefined,
    {},
    { known: true },
    { via: "email", id: "lv-1" },
    { via: "email_and_phone", id: "lv-1", updated: true, fields: ["phone"] },
    { created: true, id: "lv-2" },
    { code: "identity_conflict", fields: ["email"], loyverseCustomerId: "lv-3", via: "email" },
    { code: "customer_code_mismatch", requestedCustomerCode: "SC-ZZZZZZZZ" },
    { message: "Loyverse request failed with 503", status: 503 },
  ];
  for (const eventType of EVENT_TYPES) {
    for (const detail of details) {
      const event = { authUserId: UID, traceId: TRACE, eventType, detail };
      const row = buildSyncEventRow(event);
      assert.deepEqual(row, legacyRow(event));
      assert.deepEqual(Object.keys(row), ["auth_user_id", "trace_id", "event_type", "detail"]);
      assert.equal(row.event_type, eventType, "el literal no se transforma");
    }
  }
});

// ---------------------------------------------------------------
// Estáticos sobre la Edge Function.
// ---------------------------------------------------------------
const stripComments = (src) =>
  src
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
const edge = stripComments(readFileSync(EDGE_PATH, "utf8"));
const squash = (s) => s.replace(/\s+/g, " ").trim();

// Bloque de argumentos de cada `await logSyncEvent(<cliente>, { ... })`.
function logSyncEventCalls(src) {
  const calls = [];
  const re = /await logSyncEvent\((\w+),\s*\{/g;
  let m;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < src.length) {
      if (src[i] === "{") depth++;
      else if (src[i] === "}") depth--;
      i++;
    }
    calls.push({ client: m[1], args: src.slice(re.lastIndex, i - 1) });
  }
  return calls;
}

test("estático 1/2 — las 4 llamadas reales usan admin; no queda ningún logSyncEvent(supabase…)", () => {
  const calls = logSyncEventCalls(edge);
  assert.equal(calls.length, 4);
  assert.deepEqual(calls.map((c) => c.client), ["admin", "admin", "admin", "admin"]);
  assert.equal(/logSyncEvent\(\s*supabase\b/.test(edge), false);
  assert.match(edge, /async function logSyncEvent\(admin, event\) \{\s*return recordSyncEvent\(admin, event\);\s*\}/);
  assert.match(edge, /import \{ recordSyncEvent \} from "\.\.\/_shared\/syncEvents\.js";/);
});

test("estático — ninguna Edge Function escribe customer_sync_events fuera del writer compartido", () => {
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(ts|js|mjs)$/.test(name)) files.push(p);
    }
  };
  walk(FUNCTIONS_DIR);
  const offenders = files.filter((p) => {
    if (p.endsWith(join("_shared", "syncEvents.js"))) return false;
    return /customer_sync_events/.test(stripComments(readFileSync(p, "utf8")));
  });
  assert.deepEqual(offenders, []);
  const shared = readFileSync(join(FUNCTIONS_DIR, "_shared", "syncEvents.js"), "utf8");
  assert.match(shared, /client\.from\(SYNC_EVENTS_TABLE\)\.insert\(buildSyncEventRow\(event\)\)/);
  assert.equal(/\.(update|delete|upsert)\(/.test(stripComments(shared)), false, "el writer solo inserta");
});

test("estático 3 — authUserId y traceId vienen del servidor (user.id y traceId)", () => {
  for (const { args } of logSyncEventCalls(edge)) {
    assert.match(args, /authUserId: user\.id,/);
    assert.match(args, /(^|\s)traceId(,|: traceId\b)/);
  }
});

test("estático 4/5 — el body no controla auth_user_id, trace_id, event_type ni detail (salvo requestedCustomerCode)", () => {
  const calls = logSyncEventCalls(edge);
  const bodyRefs = calls.flatMap(({ args }) => args.match(/body\.\w+[^\n]*/g) || []);
  assert.deepEqual(bodyRefs, ["body.customerCode).slice(0, 40),"]);
  const mismatch = calls.find((c) => c.args.includes("customer_code_mismatch"));
  assert.match(mismatch.args, /requestedCustomerCode: String\(body\.customerCode\)\.slice\(0, 40\)/);
  for (const field of ["authUserId", "traceId", "eventType"]) {
    assert.equal(new RegExp(`${field}:\\s*body\\.`).test(edge), false, `${field} no sale del body`);
  }
});

test("estático — event_type y detail de cada camino se conservan (los 6 literales, sin cambios)", () => {
  const calls = logSyncEventCalls(edge).map((c) => squash(c.args));
  assert.match(calls[0], /eventType: "loyverse_conflict", detail: \{ code: "customer_code_mismatch",/);
  assert.match(calls[1], /eventType: "loyverse_conflict", detail: result\.audit \|\| \{\},/);
  assert.ok(
    calls[2].includes(
      'eventType: result.status === "created" ? "loyverse_created" : result.status === "updated" ? "loyverse_updated" : result.status === "already_linked" ? "loyverse_already_linked" : "loyverse_linked", detail: result.audit || {},'
    ),
    calls[2]
  );
  assert.match(calls[3], /eventType: "loyverse_error", detail: \{ message: safeDetail\(error\?\.message \|\| error\), status: error\?\.status \},/);
  const literals = new Set(calls.join(" ").match(/"loyverse_[a-z_]+"/g).map((s) => s.slice(1, -1)));
  assert.deepEqual([...literals].sort(), [...EVENT_TYPES].sort());
});

test("estático 6 — el traceId sigue generándose en el servidor con crypto.randomUUID()", () => {
  assert.equal((edge.match(/const traceId = crypto\.randomUUID\(\);/g) || []).length, 1);
  assert.equal((edge.match(/\btraceId\s*=(?!=)/g) || []).length, 1, "sin reasignaciones de traceId");
});

test("estático 7 — ningún return ni condición depende del resultado de logSyncEvent", () => {
  const lines = edge.split("\n").filter((l) => /logSyncEvent\(/.test(l));
  for (const line of lines) {
    const t = line.trim();
    const isDefinition = t.startsWith("async function logSyncEvent(");
    const isStatement = /^await logSyncEvent\(admin, \{$/.test(t);
    assert.ok(isDefinition || isStatement, `uso inesperado: ${t}`);
  }
});

test("estático — las respuestas HTTP de loyverse-customers no cambian (snapshot de los 15 json(...))", () => {
  const responses = [];
  const re = /\bjson\(/g;
  let m;
  while ((m = re.exec(edge))) {
    // Solo respuestas: ni la definición `function json(` ni req.json()/res.json().
    if (edge.slice(Math.max(0, m.index - 9), m.index) === "function " || edge[m.index - 1] === ".") continue;
    let depth = 1;
    let i = re.lastIndex;
    while (depth > 0 && i < edge.length) {
      if (edge[i] === "(") depth++;
      else if (edge[i] === ")") depth--;
      i++;
    }
    responses.push(squash(edge.slice(m.index, i)));
  }
  assert.deepEqual(responses, [
    'json({ ok: false, code: "srv_not_configured", retriable: true }, 503)',
    'json({ ok: false, code: "unauthorized", retriable: false }, 401)',
    'json({ ok: false, code: "unauthorized", retriable: false }, 401)',
    'json({ ok: false, code: "invalid_body", retriable: false }, 400)',
    'json({ ok: false, code: "invalid_operation", retriable: false }, 400)',
    "json({ ok: false, code: codeCheck.code, traceId, retriable: false }, codeCheck.status)",
    "json({ ok: false, code: phoneCheck.code, traceId, retriable: false }, phoneCheck.status)",
    'json({ ok: false, code: "missing_name", retriable: false }, 400)',
    'json({ ok: false, code: "customer_setup_required", traceId, retriable: false }, 409)',
    'json({ ok: true, status: "already_linked", loyverseCustomerId: outcome.loyverseCustomerId })',
    'json({ ok: false, code: "loyverse_sync_in_progress", traceId, retriable: true }, 409)',
    "json( { ok: false, code, traceId, retriable: false }, 409 )",
    "json({ ok: true, status: result.status, loyverseCustomerId: result.loyverseCustomerId, })",
    'json({ ok: false, code: "loyverse_unavailable", traceId, retriable: true }, 502)',
    'json({ ok: false, code: "internal_error", retriable: true }, 500)',
  ]);
});
