// Suite unitaria del camino REAL de rewardService.redeemReward
// ({ rewardId }). Verifica que, con Supabase configurado, el canje se
// enruta por la Edge `loyalty-engine` vía callLoyaltyEdge:
//   * envía operation: "redeem" y rewardId;
//   * NO depende de actorId/actorRole del frontend (los resuelve el
//     servidor);
//   * JWT en Authorization Bearer;
//   * una respuesta exitosa del Edge se devuelve correctamente;
//   * una respuesta de error del Edge se propaga correctamente.
//
// Es unitaria: mockea los módulos de Supabase/entorno y NUNCA hace una
// llamada real a Supabase ni a Loyverse. Requiere el flag
// --experimental-test-module-mocks (ver script "test" en package.json).
//
// Corre con: npm test

import test, { mock } from "node:test";
import assert from "node:assert/strict";

const TEST_JWT = "test-jwt-token";
const ENGINE_URL = "https://example.test/functions/v1/loyalty-engine";
const REWARD_ID = "11111111-1111-1111-1111-111111111111";

// ---------------------------------------------------------------
// Mocks de módulo: simulan "Supabase configurado" sin red.
//   * env.js        → expone la URL de la Edge.
//   * supabase/client.js → cliente con getSession (JWT) y
//     isSupabaseConfigured = true. Nunca se crea un cliente real.
// Se registran ANTES de importar rewardService (los imports del
// servicio resuelven estos módulos mockeados).
// ---------------------------------------------------------------
mock.module("../src/lib/utils/env.js", {
  namedExports: {
    readEnv(key, fallback = "") {
      if (key === "VITE_LOYALTY_ENGINE_FUNCTION_URL") return ENGINE_URL;
      return fallback;
    },
  },
});

mock.module("../src/lib/supabase/client.js", {
  namedExports: {
    isSupabaseConfigured: true,
    supabaseClient: {
      auth: {
        getSession: async () => ({ data: { session: { access_token: TEST_JWT } } }),
      },
    },
  },
});

const { redeemReward } = await import("../src/services/loyalty/rewardService.js");

// ---------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------
function stubFetch(response) {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return response;
  };
  return {
    calls,
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

// ---------------------------------------------------------------
// Camino REAL → callLoyaltyEdge (operation: "redeem")
// ---------------------------------------------------------------
test("redeemReward real llama a la Edge con operation 'redeem' y rewardId, sin actorId/actorRole", async () => {
  const stub = stubFetch(jsonResponse(200, { ok: true, operation: "redeem", result: { status: "redeemed" } }));
  try {
    await redeemReward({ rewardId: REWARD_ID });

    assert.equal(stub.calls.length, 1, "debe haber exactamente una llamada al Edge");

    const { url, options } = stub.calls[0];
    assert.equal(url, ENGINE_URL);
    assert.equal(options.method, "POST");
    assert.equal(options.headers.Authorization, `Bearer ${TEST_JWT}`, "el JWT viaja en Authorization Bearer");

    const body = JSON.parse(options.body);
    assert.equal(body.operation, "redeem");
    assert.equal(body.rewardId, REWARD_ID);
    assert.equal("actorId" in body, false, "el frontend NO envía actorId");
    assert.equal("actorRole" in body, false, "el frontend NO envía actorRole");
  } finally {
    stub.restore();
  }
});

test("redeemReward real devuelve correctamente la respuesta exitosa del Edge", async () => {
  const edgeBody = { ok: true, operation: "redeem", result: { reward_id: REWARD_ID, status: "redeemed" } };
  const stub = stubFetch(jsonResponse(200, edgeBody));
  try {
    const result = await redeemReward({ rewardId: REWARD_ID });
    assert.deepEqual(result, edgeBody);
  } finally {
    stub.restore();
  }
});

test("redeemReward real propaga correctamente la respuesta de error del Edge", async () => {
  const stub = stubFetch(
    jsonResponse(409, {
      ok: false,
      code: "REWARD_ALREADY_REDEEMED",
      message: "La recompensa ya fue canjeada.",
      retriable: false,
    }),
  );
  try {
    const result = await redeemReward({ rewardId: REWARD_ID });
    assert.equal(result.ok, false);
    assert.equal(result.error, "La recompensa ya fue canjeada.");
    assert.equal(result.code, "REWARD_ALREADY_REDEEMED");
    assert.equal(result.retriable, false);
  } finally {
    stub.restore();
  }
});

test("redeemReward real sin rewardId no llama a la Edge y devuelve error", async () => {
  const stub = stubFetch(jsonResponse(200, { ok: true }));
  try {
    const result = await redeemReward({});
    assert.equal(result.ok, false);
    assert.equal(stub.calls.length, 0, "no debe llamar al Edge sin rewardId");
  } finally {
    stub.restore();
  }
});
