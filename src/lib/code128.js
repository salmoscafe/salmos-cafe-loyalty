// ---------------------------------------------------------------
// code128 — Codificación de CÓDIGO DE BARRAS REAL (Code 128, juego B).
//
// Sustituye el "barcode" decorativo (CSS repeating-linear-gradient)
// del ticket por barras reales que un lector de Code 128 sí puede
// escanear. Implementación local y pura (sin dependencias): funciona
// sin red y es unit-testable con node --test.
//
// Estructura Code 128 (juego B):
//   start B (104) + un símbolo por carácter (valor = charCode - 32,
//   solo ASCII 32..126) + checksum + stop (106).
//   checksum = (valor_inicial + Σ valor_i × (i+1)) mod 103.
//   Cada símbolo 0..105 son 11 módulos (3 barras + 3 espacios); el
//   stop (106) son 13 módulos (4 barras + 3 espacios).
//
// Valor a codificar: identificador REAL del ticket. En el ticket se
// usa `folio` = el receipt_number de Loyverse (último segmento de
// external_sale_id); es corto y cabe en el ancho del recibo (154px),
// por eso es PREFERIBLE a external_sale_id completo (demasiado largo
// para ser escaneable a ese ancho). El número visible bajo las barras
// es exactamente el valor codificado.
// ---------------------------------------------------------------

// Tabla canónica de patrones (elemento = ancho en módulos; alterna
// barra, espacio, barra… empezando en barra). Cada string suma 11
// módulos (13 el stop). Índice 0..105 = símbolos de datos/start;
// 106 = stop. Fuente: especificación ISO/IEC 15417 (Code 128).
const PATTERNS = [
  "212222", "222122", "222221", "121223", "121322", "131222", "122213", "122312", "132212", "221213",
  "221312", "231212", "112232", "122132", "122231", "113222", "123122", "123221", "223211", "221132",
  "221231", "213212", "223112", "312131", "311222", "321122", "321221", "312212", "322112", "322211",
  "212123", "212321", "232121", "111323", "131123", "131321", "112313", "132113", "132311", "211313",
  "231113", "231311", "112133", "112331", "132131", "113123", "113321", "133121", "313121", "211331",
  "231131", "213113", "213311", "213131", "311123", "311321", "331121", "312113", "312311", "332111",
  "314111", "221411", "431111", "111224", "111422", "121124", "121421", "141122", "141221", "112214",
  "112412", "122114", "122411", "142112", "142211", "241211", "221114", "413111", "241112", "134111",
  "111242", "121142", "121241", "114212", "124112", "124211", "411212", "421112", "421211", "212141",
  "214121", "412121", "111143", "111341", "131141", "114113", "114311", "411113", "411311", "113141",
  "114131", "311141", "411131", "211412", "211214", "211232", "2331112",
];

export const CODE128_PATTERNS = PATTERNS;

const START_B = 104;
const STOP = 106;
const CHECK_MOD = 103;

// Valor REAL a codificar en el barcode del ticket. Preferencia (en
// orden): folio = receipt_number de Loyverse, luego external_sale_id
// completo, luego el id interno. Nunca se inventa un valor: si no hay
// identificador real, no hay barcode (encodeCode128 devuelve null).
export function code128ValueFor(sale) {
  const folio = typeof sale?.folio === "string" && sale.folio !== "" ? sale.folio : "";
  const external = typeof sale?.externalSaleId === "string" && sale.externalSaleId !== "" ? sale.externalSaleId : "";
  const fallback = typeof sale?.id === "string" ? sale.id : "";
  return folio || external || fallback;
}

// Codifica `value` (ASCII 32..126, juego B) a una secuencia de
// módulos (0 = blanco, 1 = barra). Devuelve null si el valor no se
// puede codificar (vacío, fuera de ASCII imprimible, no string).
export function encodeCode128(value) {
  if (typeof value !== "string" || value.length === 0) return null;

  const data = [];
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 32 || code > 126) return null;
    data.push(code - 32);
  }

  let checksum = START_B;
  for (let i = 0; i < data.length; i++) {
    checksum += data[i] * (i + 1);
  }
  const check = checksum % CHECK_MOD;

  const symbols = [START_B, ...data, check, STOP];
  const modules = [];
  for (const symbol of symbols) {
    const pattern = PATTERNS[symbol];
    for (let i = 0; i < pattern.length; i++) {
      const width = pattern.charCodeAt(i) - 48;
      const isBar = i % 2 === 0;
      for (let k = 0; k < width; k++) modules.push(isBar ? 1 : 0);
    }
  }

  return { value, modules, check, symbolCount: symbols.length };
}

// Dibuja el barcode en un `<canvas>`. Obra con html2canvas (captura
// los píxeles del canvas), así el barcode se preserva en el PDF. El
// `moduleWidth` resultante = floor(maxWidth / totalMódulos) para que
// SIEMPRE quepa en el recibo (nunca desborda el layout). Para folios
// largos (external_sale_id completo) el ancho se topa contra
// maxWidth. Devuelve la codificación usada, o null si no se pudo.
export function drawCode128(canvas, value, { moduleWidth = 2, barHeight = 34, quiet = 8, maxWidth = Infinity } = {}) {
  const encoded = encodeCode128(value);
  if (!encoded || !canvas) return null;
  if (typeof canvas.getContext !== "function") return null;

  const quietModules = Math.max(0, Number(quiet) || 0);
  const totalModules = encoded.modules.length + quietModules * 2;
  const maxM = Number.isFinite(maxWidth) && maxWidth > 0 ? Math.max(1, Math.floor(maxWidth / totalModules)) : Number(moduleWidth) || 1;
  const mw = Math.max(1, Math.min(Math.max(1, Number(moduleWidth) || 1), maxM));

  const width = totalModules * mw;
  const height = Math.max(1, Number(barHeight) || 34);
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.fillStyle = "#101010";
  let x = quietModules * mw;
  for (const module of encoded.modules) {
    if (module === 1) ctx.fillRect(x, 0, mw, height);
    x += mw;
  }

  return encoded;
}

// Ancho natural (px, sin escalas) de la codificación con el módulo
// dado — útil para centrar el canvas y para tests.
export function code128PixelWidth(value, { moduleWidth = 2, quiet = 8 } = {}) {
  const encoded = encodeCode128(value);
  if (!encoded) return 0;
  return (encoded.modules.length + quiet * 2) * moduleWidth;
}