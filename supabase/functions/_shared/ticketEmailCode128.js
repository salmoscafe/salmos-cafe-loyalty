// ---------------------------------------------------------------
// ticketEmailCode128 — mirror server-side del barcode REAL del ticket
// (src/lib/code128.js + src/components/activity/Code128Barcode.jsx).
//
// MOTIVO del mirror: src/ no se empaqueta al desplegar Edge Functions
// con el CLI estándar (los _shared sí). Este módulo reproduce 1:1:
//   * la selección del valor (folio > external_sale_id > id),
//   * la codificación Code 128 juego B (ISO/IEC 15417): start B (104)
//     + (charCode - 32) por carácter + checksum mod 103 + stop (106).
//
// El valor y los módulos generados deben ser IDÉNTICOS a los de la
// app: la suite tests/send-ticket-email.test.mjs verifica la paridad
// byte a byte con src/lib/code128.js para folios reales.
// ---------------------------------------------------------------

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

// Folio corto del ticket para el recibo/correo: el último segmento de
// external_sale_id (receipt_number de Loyverse:
// `loyverse_receipt_<store>_<receipt_number>` → `<receipt_number>`);
// si no hay external_sale_id, id truncado a 8. Copia literal de
// salesService.buildFolio (src/services/sales/salesService.js).
export function folioFor(visit) {
  const externalSaleId = visit?.external_sale_id;
  const id = visit?.id;
  if (typeof externalSaleId === "string" && externalSaleId !== "") {
    const parts = externalSaleId.split("_");
    const last = parts[parts.length - 1];
    if (last) return last;
  }
  return id ? String(id).slice(0, 8) : "";
}

// Valor REAL que codifica el barcode del email — el mismo que la app
// (code128ValueFor con `folio` ya resuelto por folioFor):
// folio > external_sale_id > id. Nunca se inventa un valor.
export function code128ValueFor(visit) {
  return (
    folioFor(visit) ||
    String(visit?.external_sale_id || "") ||
    String(visit?.id || "")
  );
}

// Codifica `value` (ASCII 32..126, juego B) a una secuencia de
// módulos (0 = blanco, 1 = barra). Espejo exacto de
// src/lib/code128.js:encodeCode128. Devuelve null si no se puede.
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