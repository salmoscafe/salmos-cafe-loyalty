// Suite del guard "single-flight" de la sincronización Loyverse.
//
// Causa raíz del bug de duplicados: dos sincronizaciones CONCURRENTES
// (buildSession en el arranque + Retry del SyncBanner, o dos llamadas
// solapadas) pasaban simultáneamente por "no existe → crear" y cada una
// creaba un cliente Loyverse nuevo, dejando dos clientes idénticos.
//
// La búsqueda+creación no es atómica contra la API de Loyverse, así que
// el app NUNCA debe lanzar dos sync en paralelo para el mismo cliente:
// el single-flight colapsa cualquier solape a UNA sola llamada remota.
//
// Correr con: node --test tests/

import test from "node:test";
import assert from "node:assert/strict";

import {
  coalesce,
  isSingleFlightActive,
  resetSingleFlight,
} from "../src/services/loyverse/singleFlight.js";
import { createOrLinkLoyverseCustomer } from "../src/services/loyverse/loyverseCustomerService.js";

test("coalesce: llamadas concurrentes comparten UNA sola ejecución", async () => {
  resetSingleFlight();
  let runs = 0;
  const slow = async () => {
    runs++;
    await new Promise((r) => setTimeout(r, 20));
    return { id: "lv_once", n: runs };
  };

  const [a, b, c] = await Promise.all([coalesce(slow), coalesce(slow), coalesce(slow)]);

  assert.equal(runs, 1, "el fn subyacente corre una sola vez pese a 3 llamadas");
  assert.ok(a === b && b === c, "las tres llamadas comparten la misma promesa");
});

test("coalesce: tras terminar, la siguiente llamada ejecuta de nuevo", async () => {
  resetSingleFlight();
  let runs = 0;
  const fn = async () => ({ n: ++runs });

  const first = await coalesce(fn);
  const second = await coalesce(fn);

  assert.equal(first.n, 1);
  assert.equal(second.n, 2);
});

test("coalesce: un rechazo libera el slot para el siguiente intento", async () => {
  resetSingleFlight();
  const boom = async () => {
    throw new Error("transient boom");
  };

  await assert.rejects(coalesce(boom), /transient boom/);
  assert.equal(isSingleFlightActive(), false, "el slot queda libre tras el fallo");
});

test("servicio: doble llamada concurrente devuelve el MISMO resultado (dedup)", async () => {
  resetSingleFlight();
  const profile = {
    name: "Ember Test",
    email: "embertracker.app@gmail.com",
    phone: null,
    customer_code: "SC-QXHKY4DC",
  };

  const p1 = createOrLinkLoyverseCustomer(profile);
  const p2 = createOrLinkLoyverseCustomer(profile);
  const [r1, r2] = await Promise.all([p1, p2]);

  assert.ok(r1 === r2, "ambas llamadas comparten la misma sincronización (sin duplicar remoto)");
});

test("servicio: perfil ya vinculado (id + synced) -> already_synced sin red", async () => {
  resetSingleFlight();
  const profile = {
    name: "Ember Test",
    email: "embertracker.app@gmail.com",
    customer_code: "SC-QXHKY4DC",
    loyverse_customer_id: "lv_abc",
    loyverse_sync_status: "synced",
  };

  const res = await createOrLinkLoyverseCustomer(profile);

  assert.equal(res.status, "already_synced");
  assert.equal(res.loyverseCustomerId, "lv_abc");
  assert.equal(isSingleFlightActive(), false, "no entra al single-flight: no hay red");
});