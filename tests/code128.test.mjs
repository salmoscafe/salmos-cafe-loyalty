// Suite del barcode REAL del ticket (Code 128, juego B).
// Importa DIRECTAMENTE src/lib/code128.js (puro, sin DOM): corre con
// `node --test "tests/*.test.mjs"`.
//
// Cubre:
//   * integridad de la tabla de patrones ISO/IEC 15417
//   * ensamblado del símbolo (start B + datos + checksum + stop)
//   * golden test de "A" contra los patrones canónicos
//   * rechazo de valores no codificables (vacío / no-ASCII / no string)
//   * selección del valor REAL (folio > external_sale_id > id)
//   * drawCode128: dimensiones del canvas y ajuste a maxWidth

import test from "node:test";
import assert from "node:assert/strict";

import {
  CODE128_PATTERNS,
  code128PixelWidth,
  code128ValueFor,
  drawCode128,
  encodeCode128,
} from "../src/lib/code128.js";

// ---------------------------------------------------------------
// Integridad de la tabla canónica (ISO/IEC 15417)
// ---------------------------------------------------------------
test("patrones: 0..105 suman 11 módulos, stop suma 13, todos 1-4 y barra/espacio alternados", () => {
  for (let value = 0; value <= 105; value++) {
    const pattern = CODE128_PATTERNS[value];
    assert.equal(pattern.length, 6, `símbolo ${value} debe tener 6 elementos (3 barras + 3 espacios)`);
    let sum = 0;
    for (const ch of pattern) {
      const width = Number(ch);
      assert.ok(width >= 1 && width <= 4, `ancho de elemento 1..4 en símbolo ${value}`);
      sum += width;
    }
    assert.equal(sum, 11, `símbolo ${value} suma 11 módulos`);
  }

  const stop = CODE128_PATTERNS[106];
  assert.equal(stop, "2331112", "stop debe ser 2331112 (13 módulos, 4 barras)");
  assert.equal([...stop].reduce((a, c) => a + Number(c), 0), 13);
});

// ---------------------------------------------------------------
// Ensamblado del símbolo (checksum, longitud, límites de barra)
// ---------------------------------------------------------------
test("encodeCode128: checksum de '1-0002' = 35 y 101 módulos", () => {
  // start B (104) + 6 datos (`1`→17, `-`→13, `0`→16 ×3, `2`→18) + checksum + stop
  const encoded = encodeCode128("1-0002");
  assert.ok(encoded);
  assert.equal(encoded.check, 35);
  // 11*(1 start + 6 datos + 1 check) + 13 stop = 101
  assert.equal(encoded.modules.length, 101);
  assert.equal(encoded.symbolCount, 9);
});

test("encodeCode128: comienza y termina en barra (1) — zonas de silencio limpias", () => {
  const encoded = encodeCode128("1-0002");
  assert.equal(encoded.modules[0], 1, "primer módulo debe ser barra");
  assert.equal(encoded.modules[encoded.modules.length - 1], 1, "último módulo (fin del stop) debe ser barra");
});

test("encodeCode128: rechaza valores vacíos, no-ASCII y no-string", () => {
  assert.equal(encodeCode128(""), null);
  assert.equal(encodeCode128("ñ"), null, "fuera de ASCII 32..126 no se codifica");
  assert.equal(encodeCode128("123\u00e9"), null, "acentos/signos extendidos se rechazan");
  assert.equal(encodeCode128(123), null);
  assert.equal(encodeCode128(null), null);
  assert.equal(encodeCode128(undefined), null);
});

test("encodeCode128: espacio (ASCII 32) sí es codificable en juego B", () => {
  // valor 0 (espacio) es válido en Code 128 B; un símbolo de datos → 3 símbolos + stop
  const encoded = encodeCode128(" ");
  assert.ok(encoded);
  assert.equal(encoded.modules.length, 11 * 3 + 13);
});

// ---------------------------------------------------------------
// Golden test — "A" contra los 4 símbolos canónicos (independiente
// de la tabla: las cadenas esperadas se escriben a mano)
// ---------------------------------------------------------------
test("encodeCode128: golden test de 'A' (startB + 'A' + checksum34 + stop)", () => {
  const encoded = encodeCode128("A");
  const expectedBits = [
    "11010010000", // start B = 211214
    "10100011000", // 'A' (valor 33) = 111323
    "10001011000", // checksum 34 = 131123
    "1100011101011", // stop = 2331112
  ].join("");
  assert.equal(encoded.modules.join(""), expectedBits);
  assert.equal(encoded.check, 34);
});

// ---------------------------------------------------------------
// Selección del valor REAL a codificar (folio > external > id)
// ---------------------------------------------------------------
test("code128ValueFor: folio (receipt_number de Loyverse) tiene prioridad", () => {
  assert.equal(
    code128ValueFor({ folio: "1-0002", externalSaleId: "loyverse_receipt_store-tj-1_1-0002", id: "abc" }),
    "1-0002"
  );
});

test("code128ValueFor: cae a external_sale_id si no hay folio", () => {
  assert.equal(
    code128ValueFor({ folio: "", externalSaleId: "loyverse_receipt_store-tj-1_1-0002", id: "abc" }),
    "loyverse_receipt_store-tj-1_1-0002"
  );
});

test("code128ValueFor: cae al id interno como último recurso real", () => {
  assert.equal(code128ValueFor({ folio: null, externalSaleId: undefined, id: "sale_abc123" }), "sale_abc123");
  assert.equal(code128ValueFor({}), "");
});

// ---------------------------------------------------------------
// drawCode128 — dimensiones del canvas y ajuste a maxWidth
// ---------------------------------------------------------------
function fakeCanvas() {
  const calls = [];
  return {
    width: 0,
    height: 0,
    hidden: false,
    getContext() {
      return {
        fillRect(...args) { calls.push(["fillRect", ...args]); },
        fillStyle: "",
      };
    },
    _calls: calls,
  };
}

test("drawCode128: dimensiones = (módulos + 2×silencio) × módulo; dibuja barras", () => {
  const canvas = fakeCanvas();
  const encoded = drawCode128(canvas, "1-0002", { moduleWidth: 2, barHeight: 34, quiet: 8 });
  assert.ok(encoded);
  // 101 módulos + 16 de silencio = 117 → 117 × 2 = 234px
  assert.equal(canvas.width, 234);
  assert.equal(canvas.height, 34);
  assert.equal(code128PixelWidth("1-0002", { moduleWidth: 2, quiet: 8 }), 234);
  // El fondo se pinta (blanco) y al menos una barra negra por cada patrón
  const fills = canvas._calls.filter((c) => c[0] === "fillRect");
  assert.ok(fills.length >= 10, "se dibujan múltiples barras");
});

test("drawCode128: encaja en maxWidth reduciendo el módulo sin desbordar", () => {
  const canvas = fakeCanvas();
  drawCode128(canvas, "1-0002", { moduleWidth: 2, barHeight: 34, quiet: 8, maxWidth: 154 });
  assert.equal(canvas.width, 117, "117 módulos totales × 1px …");
  assert.ok(canvas.width <= 154);
});

test("drawCode128: null sin canvas o sin valor codificable", () => {
  assert.equal(drawCode128(null, "1-0002"), null);
  const canvas = fakeCanvas();
  assert.equal(drawCode128(canvas, "ñ"), null);
  assert.equal(drawCode128(canvas, ""), null);
});