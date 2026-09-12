// Suite de exclusión mutua server-side (claim) para la sincronización
// Loyverse. Corre la lógica REAL de la migración 0006 +
// supabase/functions/_shared/syncClaim.js contra un `db` y un `transport`
// mínimos que emulan las semánticas de Postgres (sentencia única) y de la
// API de Loyverse. Correr con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import { normalizeEmail } from "../supabase/functions/_shared/loyverseCore.js";
import { createOrLinkLoyverseCustomer } from "../supabase/functions/_shared/loyverseCore.js";
import {
  acquireSyncClaim,
  releaseSyncClaim,
  runLoyverseSync,
  SYNC_CLAIM_LEASE_MS,
} from "../supabase/functions/_shared/syncClaim.js";

// ---------------------------------------------------------------
// `db` emulado: simula la SENTENCIA ÚNICA de la migración 0006. El WHERE
// (claim IS NULL OR claim_at < cutoffIso) se evalúa sobre el estado actual
// de la fila; si está vigente devuelve count 0 (perdedor) tal y como lo
// haría Postgres tras serializar los dos UPDATE concurrentes por el lock
// de fila. `release` respeta el scope auth_user_id + token.
// ---------------------------------------------------------------
function makeClaimDb() {
  const row = { auth_user_id: "u-123", loyverse_sync_claim: null, loyverse_sync_claim_at: null };
  const calls = [];
  const db = {
    row,
    calls,
    async claim({ authUserId, claim, claimAt, cutoffIso }) {
      calls.push({ op: "claim", authUserId, claim, claimAt, cutoffIso });
      const active =
        row.loyverse_sync_claim !== null &&
        !(row.loyverse_sync_claim_at !== null && row.loyverse_sync_claim_at < cutoffIso);
      if (row.auth_user_id !== authUserId || active) return { count: 0 };
      row.loyverse_sync_claim = claim;
      row.loyverse_sync_claim_at = claimAt;
      return { count: 1 };
    },
    async release({ authUserId, claim }) {
      calls.push({ op: "release", authUserId, claim });
      if (row.auth_user_id !== authUserId || row.loyverse_sync_claim !== claim) {
        return { error: null };
      }
      row.loyverse_sync_claim = null;
      row.loyverse_sync_claim_at = null;
      return { error: null };
    },
  };
  return db;
}

// ---------------------------------------------------------------
// `transport` emulado (semántica fiel de la API de Loyverse):
//   * hiddenInFirstPass  → el registro aún no era visible en la 1ª búsqueda
//     (carrera del doble submit): se ve al rebuscar tras el 400/409.
//   * duplicateError     → formato real del error "ya existe" al crear.
// ---------------------------------------------------------------
function makeStoreTransport(opts = {}) {
  const customers = [];
  const calls = [];
  let emailSearches = 0;
  const hidden = (c) => opts.hiddenInFirstPass && emailSearches <= 1;

  const transport = {
    calls,
    customers,
    seed(list) {
      customers.push(...list.map((c) => ({ ...c })));
    },
    async listByEmail(email) {
      emailSearches++;
      calls.push({ op: "listByEmail", email });
      return customers.filter((c) => !hidden(c) && normalizeEmail(c.email) === normalizeEmail(email));
    },
    async listByPhone(phone) {
      calls.push({ op: "listByPhone", phone });
      const digits = String(phone).replace(/\D/g, "");
      if (!digits) return [];
      return customers.filter((c) => !hidden(c) && String(c.phone_number || "").replace(/\D/g, "") === digits);
    },
    async create(payload) {
      calls.push({ op: "create", payload });
      if (customers.some((c) => c.customer_code && c.customer_code === payload.customer_code)) {
        const { status = 400, body = "customer_code already taken" } = opts.duplicateError || {};
        const error = new Error(`Loyverse request failed with ${status}`);
        error.status = status;
        error.body = body;
        throw error;
      }
      const created = { id: `lv_${customers.length + 1}`, ...payload };
      customers.push(created);
      return created;
    },
    async update(customerId, payload) {
      calls.push({ op: "update", customerId, payload });
      customers.find((c) => c.id === customerId) && Object.assign(customers.find((c) => c.id === customerId), payload);
      return {};
    },
  };
  return transport;
}

function makeProfile(overrides = {}) {
  return {
    id: "profile-1",
    auth_user_id: "u-123",
    name: "Javier Castro",
    email: "javier@example.com",
    phone: "6641234567",
    customer_code: "SC-AAAAAAAA",
    loyverse_customer_id: null,
    loyverse_sync_status: "pending",
    ...overrides,
  };
}

function runSync({ db, transport, profile = makeProfile(), options = {} }) {
  return runLoyverseSync({
    db,
    transport,
    authUserId: profile?.auth_user_id ?? null,
    profile,
    name: profile?.name,
    email: profile?.email,
    phone: profile?.phone,
    customerCode: profile?.customer_code,
    ...options,
  });
}

// 1) Primera sincronización: el claim se adquiere para el trabajo, se crea
//    el cliente en Loyverse y el claim queda liberado al terminar.
test("sync normal: adquiere el claim, crea en Loyverse y lo libera al final", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();
  const outcome = await runSync({ db, transport });

  assert.equal(outcome.status, "done");
  assert.equal(outcome.result.status, "created");
  assert.ok(outcome.result.loyverseCustomerId);
  assert.ok(transport.calls.some((c) => c.op === "create"));
  assert.ok(db.calls.some((c) => c.op === "claim"), "debió tomar el claim");
  assert.equal(db.row.loyverse_sync_claim, null, "claim liberado tras el sync");
  assert.equal(db.row.loyverse_sync_claim_at, null);
});

// 2) Perfil ya vinculado: already_linked SIN tomar claim y SIN red.
test("ya-synced: already_linked sin claim ni llamadas a Loyverse", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();
  const profile = makeProfile({ loyverse_customer_id: "lv_known", loyverse_sync_status: "synced" });
  const outcome = await runSync({ db, transport, profile });

  assert.equal(outcome.status, "already_linked");
  assert.equal(outcome.loyverseCustomerId, "lv_known");
  assert.equal(db.calls.length, 0, "no se toma el claim");
  assert.equal(transport.calls.length, 0, "no se llama a Loyverse");
});

// 2b) Sin fila `customers` (no_profile): la sync no avanza ni intenta
//     claimear (el claim vive en la fila; no habría dónde guardarlo).
test("sin fila customers: no_profile, sin claim ni llamadas a Loyverse", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();
  const outcome = await runSync({ db, transport, profile: null });

  assert.equal(outcome.status, "no_profile");
  assert.equal(db.calls.length, 0, "no se intenta claim sin fila");
  assert.equal(transport.calls.length, 0, "no se llama a Loyverse");
});

// 3) Carrera real: mientras el claim de la invocación A está vigente, la
//    invocación B no puede avanzar y la GANADORA es la única que crea.
test("concurrencia: mientras A tiene el claim, B no crea; solo una llega al create", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();
  const profile = makeProfile();

  const acqA = await acquireSyncClaim(db, profile.auth_user_id, { now: () => Date.now() });
  assert.equal(acqA.acquired, true);

  const outcomeB = await runSync({ db, transport, profile });
  assert.equal(outcomeB.status, "busy");
  assert.equal(transport.calls.length, 0, "el perdedor no llama a la API de Loyverse");

  const resultA = await createOrLinkLoyverseCustomer({
    transport,
    name: profile.name,
    email: profile.email,
    phone: profile.phone,
    customerCode: profile.customer_code,
    knownLoyverseCustomerId: null,
  });
  assert.equal(resultA.status, "created");
  const creates = transport.calls.filter((c) => c.op === "create");
  assert.equal(creates.length, 1, "exactamente UNA invocación llega a crear");
});

// 4) Contrato de la señal busy: retriable=true, sin crear ni actualizar.
test("perdedor del claim: busy retriable, sin llamadas a Loyverse", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();
  const profile = makeProfile();

  const acq = await acquireSyncClaim(db, profile.auth_user_id, { now: () => Date.now() });
  assert.equal(acq.acquired, true);

  const outcome = await runSync({ db, transport, profile });
  assert.equal(outcome.status, "busy");
  assert.equal(outcome.retriable, true);
  assert.equal(transport.calls.filter((c) => c.op === "create").length, 0);
  assert.equal(transport.calls.filter((c) => c.op === "update").length, 0);
});

// 5) Tras un sync exitoso el claim queda libre: una segunda sync inmediata
//    adquiere de nuevo y rebusca/vincula (nunca duplica).
test("tras el exito el claim queda libre y la segunda sync reusa el mismo cliente", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport();

  const first = await runSync({ db, transport });
  assert.equal(first.status, "done");
  assert.equal(db.row.loyverse_sync_claim, null);

  const second = await runSync({ db, transport });
  assert.equal(second.status, "done");
  assert.equal(second.result.status, "linked", "la segunda rebusca y vincula");
  assert.equal(transport.customers.filter((c) => normalizeEmail(c.email) === "javier@example.com").length, 1);
});

// 6) Fallo de Loyverse: el error se propaga PERO el claim se libera (un
//    error no deja la fila bloqueada para el siguiente reintento).
test("error de Loyverse: se propaga pero el claim se libera", async () => {
  const db = makeClaimDb();
  const transport = {
    calls: [],
    async listByEmail() {
      return [];
    },
    async listByPhone() {
      return [];
    },
    async create() {
      const error = new Error("Loyverse request failed with 500");
      error.status = 500;
      throw error;
    },
  };

  await assert.rejects(runSync({ db, transport }), /500/);
  assert.equal(db.row.loyverse_sync_claim, null, "claim liberado incluso en error");
  assert.equal(db.row.loyverse_sync_claim_at, null);
});

// 7) Liberación con scope: un token ajeno NO limpia el claim vigente, y
//    tampoco lo hace otro usuario; solo el dueño con su token.
test("release ajeno nunca limpia el claim (scope auth_user_id + token)", async () => {
  const db = makeClaimDb();
  const acq = await acquireSyncClaim(db, "u-123", { now: () => Date.now() });
  assert.equal(acq.acquired, true);

  await releaseSyncClaim(db, "u-123", "claim-wrong");
  assert.equal(db.row.loyverse_sync_claim, acq.claim, "token incorrecto no limpia");

  await releaseSyncClaim(db, "u-999", acq.claim);
  assert.equal(db.row.loyverse_sync_claim, acq.claim, "otro usuario no puede liberarlo");

  await releaseSyncClaim(db, "u-123", acq.claim);
  assert.equal(db.row.loyverse_sync_claim, null, "el dueño con su token sí libera");
});

// 8) Regresión b0351f5 a través del claim: un create que falla por
//    duplicado (400 con mensaje genérico, carrera del doble submit) se
//    rebusca, se vincula y nunca crea un duplicado. El claim se libera.
test("duplicate-create sigue rebuscando y vinculando a traves del claim", async () => {
  const db = makeClaimDb();
  const transport = makeStoreTransport({
    hiddenInFirstPass: true,
    duplicateError: { status: 400, body: "Customer already exists" },
  });
  transport.seed([
    {
      id: "lv_1",
      name: "Javier Castro",
      email: "javier@example.com",
      phone_number: "+526641234567",
      customer_code: "SC-AAAAAAAA",
    },
  ]);

  const outcome = await runSync({ db, transport });
  assert.equal(outcome.status, "done");
  assert.equal(outcome.result.status, "linked");
  assert.equal(outcome.result.audit.afterDuplicateCode, true);
  assert.equal(outcome.result.loyverseCustomerId, "lv_1");
  assert.equal(transport.customers.length, 1, "no se crea un duplicado");
  assert.equal(db.row.loyverse_sync_claim, null);
});

// 9) Expiración segura de claims abandonados:
//    * mientras el claim está VIGENTE (< lease) no se roba;
//    * pasado el lease (holder colgó) el claim se recupera;
//    * el holder original que resurge NO puede liberar el claim robado.
test("claims abandonados: fresco no se roba, vencido sí, el viejo no libera el nuevo", async () => {
  const db = makeClaimDb();
  let clock = 1_000_000;
  let seq = 0;
  const nowFn = () => clock;
  const newIdFn = () => `c-${++seq}`;

  const acq1 = await acquireSyncClaim(db, "u-123", { leaseMs: SYNC_CLAIM_LEASE_MS, now: nowFn, newId: newIdFn });
  assert.equal(acq1.acquired, true);

  clock += 30_000;
  const early = await acquireSyncClaim(db, "u-123", { leaseMs: SYNC_CLAIM_LEASE_MS, now: nowFn, newId: newIdFn });
  assert.equal(early.acquired, false, "claim vigente no se roba");
  assert.equal(db.row.loyverse_sync_claim, acq1.claim);

  await releaseSyncClaim(db, "u-123", acq1.claim);
  assert.equal(db.row.loyverse_sync_claim, null);

  const acq2 = await acquireSyncClaim(db, "u-123", { leaseMs: SYNC_CLAIM_LEASE_MS, now: nowFn, newId: newIdFn });
  assert.equal(acq2.acquired, true);

  clock += SYNC_CLAIM_LEASE_MS + 60_000;
  const recovery = await acquireSyncClaim(db, "u-123", { leaseMs: SYNC_CLAIM_LEASE_MS, now: nowFn, newId: newIdFn });
  assert.equal(recovery.acquired, true, "claim vencido se recupera");
  assert.equal(db.row.loyverse_sync_claim, recovery.claim);

  await releaseSyncClaim(db, "u-123", acq2.claim);
  assert.equal(db.row.loyverse_sync_claim, recovery.claim, "el holder viejo no libera el claim ajeno");
});