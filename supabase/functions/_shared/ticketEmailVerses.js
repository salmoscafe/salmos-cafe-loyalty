// ---------------------------------------------------------------
// ticketEmailVerses - espejo server-side de la resolucion del versiculo
// del ticket (src/lib/ticketVerse.js + src/lib/psalms.js).
//
// MOTIVO del mirror: el bundler estandar del CLI de Supabase excluye
// archivos fuera de supabase/functions/ (src/ no se empaqueta al
// desplegar); el soporte de imports fuera de supabase/ requiere el flag
// experimental --use-api (issues conocidos de bundling).
//
// CONTENIDO: solo los 49 pasajes ELEGIBLES del ticket (texto <= 160 chars
// y <= 3 lineas), en el MISMO orden que aparecen en src/data/bible-verses.json.
// El conjunto elegible del dataset == TICKET_VERSE_IDS de receiptsSyncCore
// (verificado por tests/send-ticket-email.test.mjs), asi que tanto el
// lookup por verse_id como el fallback por fecha coinciden 1:1 con la app.
//
// Algoritmos copiados literalmente (sin reglas de lealtad):
//   * MAX_TICKET_CHARS / MAX_TICKET_LINES      (psalms.js)
//   * dateSeed / getDailyShortPassageForEmail  (psalms.js)
//   * resolveTicketPassageForEmail             (ticketVerse.js)
// La suite de paridad verifica byte a byte: id, texto, referencia y fallback.
// ---------------------------------------------------------------

export const MAX_TICKET_CHARS = 160;
export const MAX_TICKET_LINES = 3;

const PASSAGES = [
  {
    "id": 2,
    "reference": "Salmos 2:12",
    "book": "Salmos",
    "chapter": 2,
    "startVerse": 12,
    "endVerse": 12,
    "tags": [
      "confianza",
      "protección"
    ],
    "text": "Honrad al Hijo, para que no se enoje, y perezcáis en el camino;\nPues se inflama de pronto su ira.\nBienaventurados todos los que en él confían."
  },
  {
    "id": 5,
    "reference": "Salmos 4:8",
    "book": "Salmos",
    "chapter": 4,
    "startVerse": 8,
    "endVerse": 8,
    "tags": [
      "confianza"
    ],
    "text": "En paz me acostaré, y asimismo dormiré;\nPorque solo tú, Jehová, me haces vivir confiado."
  },
  {
    "id": 8,
    "reference": "Salmos 7:10",
    "book": "Salmos",
    "chapter": 7,
    "startVerse": 10,
    "endVerse": 10,
    "tags": [
      "fortaleza",
      "protección"
    ],
    "text": "Mi escudo está en Dios,\nQue salva a los rectos de corazón."
  },
  {
    "id": 11,
    "reference": "Salmos 13:5",
    "book": "Salmos",
    "chapter": 13,
    "startVerse": 5,
    "endVerse": 5,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Mas yo en tu misericordia he confiado;\nMi corazón se alegrará en tu salvación."
  },
  {
    "id": 15,
    "reference": "Salmos 16:8",
    "book": "Salmos",
    "chapter": 16,
    "startVerse": 8,
    "endVerse": 8,
    "tags": [
      "confianza"
    ],
    "text": "A Jehová he puesto siempre delante de mí;\nPorque está a mi diestra, no seré conmovido."
  },
  {
    "id": 16,
    "reference": "Salmos 16:11",
    "book": "Salmos",
    "chapter": 16,
    "startVerse": 11,
    "endVerse": 11,
    "tags": [
      "adoración",
      "alabanza",
      "gratitud"
    ],
    "text": "Me mostrarás la senda de la vida;\nEn tu presencia hay plenitud de gozo;\nDelicias a tu diestra para siempre."
  },
  {
    "id": 21,
    "reference": "Salmos 18:46",
    "book": "Salmos",
    "chapter": 18,
    "startVerse": 46,
    "endVerse": 46,
    "tags": [
      "fortaleza",
      "protección"
    ],
    "text": "Viva Jehová, y bendita sea mi roca,\nY enaltecido sea el Dios de mi salvación;"
  },
  {
    "id": 26,
    "reference": "Salmos 20:7",
    "book": "Salmos",
    "chapter": 20,
    "startVerse": 7,
    "endVerse": 7,
    "tags": [
      "confianza"
    ],
    "text": "Estos confían en carros, y aquellos en caballos;\nMas nosotros del nombre de Jehová nuestro Dios tendremos memoria."
  },
  {
    "id": 28,
    "reference": "Salmos 23:4",
    "book": "Salmos",
    "chapter": 23,
    "startVerse": 4,
    "endVerse": 4,
    "tags": [
      "ansiedad",
      "consuelo",
      "paz"
    ],
    "text": "Aunque ande en valle de sombra de muerte,\nNo temeré mal alguno, porque tú estarás conmigo;\nTu vara y tu cayado me infundirán aliento."
  },
  {
    "id": 29,
    "reference": "Salmos 23:6",
    "book": "Salmos",
    "chapter": 23,
    "startVerse": 6,
    "endVerse": 6,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Ciertamente el bien y la misericordia me seguirán todos los días de mi vida,\nY en la casa de Jehová moraré por largos días."
  },
  {
    "id": 34,
    "reference": "Salmos 27:1",
    "book": "Salmos",
    "chapter": 27,
    "startVerse": 1,
    "endVerse": 1,
    "tags": [
      "confianza"
    ],
    "text": "Jehová es mi luz y mi salvación; ¿de quién temeré?\nJehová es la fortaleza de mi vida; ¿de quién he de atemorizarme?"
  },
  {
    "id": 38,
    "reference": "Salmos 29:11",
    "book": "Salmos",
    "chapter": 29,
    "startVerse": 11,
    "endVerse": 11,
    "tags": [
      "consuelo",
      "fortaleza",
      "paz"
    ],
    "text": "Jehová dará poder a su pueblo;\nJehová bendecirá a su pueblo con paz."
  },
  {
    "id": 45,
    "reference": "Salmos 32:8",
    "book": "Salmos",
    "chapter": 32,
    "startVerse": 8,
    "endVerse": 8,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Te haré entender, y te enseñaré el camino en que debes andar;\nSobre ti fijaré mis ojos."
  },
  {
    "id": 46,
    "reference": "Salmos 32:10",
    "book": "Salmos",
    "chapter": 32,
    "startVerse": 10,
    "endVerse": 10,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Muchos dolores habrá para el impío;\nMas al que espera en Jehová, le rodea la misericordia."
  },
  {
    "id": 47,
    "reference": "Salmos 33:5",
    "book": "Salmos",
    "chapter": 33,
    "startVerse": 5,
    "endVerse": 5,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Él ama justicia y juicio;\nDe la misericordia de Jehová está llena la tierra."
  },
  {
    "id": 51,
    "reference": "Salmos 34:8",
    "book": "Salmos",
    "chapter": 34,
    "startVerse": 8,
    "endVerse": 8,
    "tags": [
      "amor",
      "bondad",
      "confianza",
      "misericordia"
    ],
    "text": "Gustad, y ved que es bueno Jehová;\nDichoso el hombre que confía en él."
  },
  {
    "id": 55,
    "reference": "Salmos 34:18",
    "book": "Salmos",
    "chapter": 34,
    "startVerse": 18,
    "endVerse": 18,
    "tags": [
      "ansiedad",
      "consuelo",
      "paz"
    ],
    "text": "Cercano está Jehová a los quebrantados de corazón;\nY salva a los contritos de espíritu."
  },
  {
    "id": 58,
    "reference": "Salmos 37:7",
    "book": "Salmos",
    "chapter": 37,
    "startVerse": 7,
    "endVerse": 7,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Guarda silencio ante Jehová, y espera en él.\nNo te alteres con motivo del que prospera en su camino,\nPor el hombre que hace maldades."
  },
  {
    "id": 60,
    "reference": "Salmos 37:27",
    "book": "Salmos",
    "chapter": 37,
    "startVerse": 27,
    "endVerse": 27,
    "tags": [
      "obediencia",
      "santidad",
      "transformación"
    ],
    "text": "Apártate del mal, y haz el bien,\nY vivirás para siempre."
  },
  {
    "id": 61,
    "reference": "Salmos 37:34",
    "book": "Salmos",
    "chapter": 37,
    "startVerse": 34,
    "endVerse": 34,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Espera en Jehová, y guarda su camino,\nY él te exaltará para heredar la tierra;\nCuando sean destruidos los pecadores, lo verás."
  },
  {
    "id": 62,
    "reference": "Salmos 39:7",
    "book": "Salmos",
    "chapter": 39,
    "startVerse": 7,
    "endVerse": 7,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Y ahora, Señor, ¿qué esperaré?\nMi esperanza está en ti."
  },
  {
    "id": 72,
    "reference": "Salmos 48:14",
    "book": "Salmos",
    "chapter": 48,
    "startVerse": 14,
    "endVerse": 14,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Porque este Dios es Dios nuestro eternamente y para siempre;\nÉl nos guiará aun más allá de la muerte."
  },
  {
    "id": 73,
    "reference": "Salmos 50:15",
    "book": "Salmos",
    "chapter": 50,
    "startVerse": 15,
    "endVerse": 15,
    "tags": [
      "confianza",
      "consuelo",
      "protección"
    ],
    "text": "E invócame en el día de la angustia;\nTe libraré, y tú me honrarás."
  },
  {
    "id": 77,
    "reference": "Salmos 52:9",
    "book": "Salmos",
    "chapter": 52,
    "startVerse": 9,
    "endVerse": 9,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Te alabaré para siempre, porque lo has hecho así;\nY esperaré en tu nombre, porque es bueno, delante de tus santos."
  },
  {
    "id": 78,
    "reference": "Salmos 54:4",
    "book": "Salmos",
    "chapter": 54,
    "startVerse": 4,
    "endVerse": 4,
    "tags": [
      "fortaleza",
      "protección"
    ],
    "text": "He aquí, Dios es el que me ayuda;\nEl Señor está con los que sostienen mi vida."
  },
  {
    "id": 80,
    "reference": "Salmos 55:22",
    "book": "Salmos",
    "chapter": 55,
    "startVerse": 22,
    "endVerse": 22,
    "tags": [
      "ansiedad",
      "consuelo",
      "fortaleza",
      "paz",
      "protección"
    ],
    "text": "Echa sobre Jehová tu carga, y él te sustentará;\nNo dejará para siempre caído al justo."
  },
  {
    "id": 82,
    "reference": "Salmos 57:10",
    "book": "Salmos",
    "chapter": 57,
    "startVerse": 10,
    "endVerse": 10,
    "tags": [
      "alabanza",
      "misericordia"
    ],
    "text": "Porque grande es hasta los cielos tu misericordia,\nY hasta las nubes tu verdad."
  },
  {
    "id": 91,
    "reference": "Salmos 68:5",
    "book": "Salmos",
    "chapter": 68,
    "startVerse": 5,
    "endVerse": 5,
    "tags": [
      "amor",
      "consuelo",
      "protección"
    ],
    "text": "Padre de huérfanos y defensor de viudas\nEs Dios en su santa morada."
  },
  {
    "id": 92,
    "reference": "Salmos 68:19",
    "book": "Salmos",
    "chapter": 68,
    "startVerse": 19,
    "endVerse": 19,
    "tags": [
      "fortaleza",
      "protección"
    ],
    "text": "Bendito el Señor; cada día nos colma de beneficios\nEl Dios de nuestra salvación. Selah"
  },
  {
    "id": 94,
    "reference": "Salmos 71:14",
    "book": "Salmos",
    "chapter": 71,
    "startVerse": 14,
    "endVerse": 14,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Mas yo esperaré siempre,\nY te alabaré más y más."
  },
  {
    "id": 96,
    "reference": "Salmos 73:24",
    "book": "Salmos",
    "chapter": 73,
    "startVerse": 24,
    "endVerse": 24,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Me has guiado según tu consejo,\nY después me recibirás en gloria."
  },
  {
    "id": 98,
    "reference": "Salmos 73:26",
    "book": "Salmos",
    "chapter": 73,
    "startVerse": 26,
    "endVerse": 26,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Mi carne y mi corazón desfallecen;\nMas la roca de mi corazón y mi porción es Dios para siempre."
  },
  {
    "id": 102,
    "reference": "Salmos 85:10",
    "book": "Salmos",
    "chapter": 85,
    "startVerse": 10,
    "endVerse": 10,
    "tags": [
      "bondad",
      "misericordia",
      "paz"
    ],
    "text": "La misericordia y la verdad se encontraron;\nLa justicia y la paz se besaron."
  },
  {
    "id": 103,
    "reference": "Salmos 86:5",
    "book": "Salmos",
    "chapter": 86,
    "startVerse": 5,
    "endVerse": 5,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Porque tú, Señor, eres bueno y perdonador,\nY grande en misericordia para con todos los que te invocan."
  },
  {
    "id": 105,
    "reference": "Salmos 86:11",
    "book": "Salmos",
    "chapter": 86,
    "startVerse": 11,
    "endVerse": 11,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Enséñame, oh Jehová, tu camino; caminaré yo en tu verdad;\nAfirma mi corazón para que tema tu nombre."
  },
  {
    "id": 106,
    "reference": "Salmos 86:15",
    "book": "Salmos",
    "chapter": 86,
    "startVerse": 15,
    "endVerse": 15,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Mas tú, Señor, Dios misericordioso y clemente,\nLento para la ira, y grande en misericordia y verdad,"
  },
  {
    "id": 107,
    "reference": "Salmos 90:12",
    "book": "Salmos",
    "chapter": 90,
    "startVerse": 12,
    "endVerse": 12,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Enséñanos de tal modo a contar nuestros días,\nQue traigamos al corazón sabiduría."
  },
  {
    "id": 112,
    "reference": "Salmos 94:19",
    "book": "Salmos",
    "chapter": 94,
    "startVerse": 19,
    "endVerse": 19,
    "tags": [
      "ansiedad",
      "consuelo",
      "paz"
    ],
    "text": "En la multitud de mis pensamientos dentro de mí,\nTus consolaciones alegraban mi alma."
  },
  {
    "id": 119,
    "reference": "Salmos 101:6",
    "book": "Salmos",
    "chapter": 101,
    "startVerse": 6,
    "endVerse": 6,
    "tags": [
      "obediencia",
      "santidad",
      "transformación"
    ],
    "text": "Mis ojos pondré en los fieles de la tierra, para que estén conmigo;\nEl que ande en el camino de la perfección, este me servirá."
  },
  {
    "id": 123,
    "reference": "Salmos 107:1",
    "book": "Salmos",
    "chapter": 107,
    "startVerse": 1,
    "endVerse": 1,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Alabad a Jehová, porque él es bueno;\nPorque para siempre es su misericordia."
  },
  {
    "id": 124,
    "reference": "Salmos 111:10",
    "book": "Salmos",
    "chapter": 111,
    "startVerse": 10,
    "endVerse": 10,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "El principio de la sabiduría es el temor de Jehová;\nBuen entendimiento tienen todos los que practican sus mandamientos;\nSu loor permanece para siempre."
  },
  {
    "id": 127,
    "reference": "Salmos 116:7",
    "book": "Salmos",
    "chapter": 116,
    "startVerse": 7,
    "endVerse": 7,
    "tags": [
      "ansiedad",
      "consuelo",
      "paz"
    ],
    "text": "Vuelve, oh alma mía, a tu reposo,\nPorque Jehová te ha hecho bien."
  },
  {
    "id": 133,
    "reference": "Salmos 119:71",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 71,
    "endVerse": 71,
    "tags": [
      "perseverancia",
      "sabiduría"
    ],
    "text": "Bueno me es haber sido humillado,\nPara que aprenda tus estatutos."
  },
  {
    "id": 134,
    "reference": "Salmos 119:81",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 81,
    "endVerse": 81,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Desfallece mi alma por tu salvación,\nMas espero en tu palabra."
  },
  {
    "id": 136,
    "reference": "Salmos 119:105",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 105,
    "endVerse": 105,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "Lámpara es a mis pies tu palabra,\nY lumbrera a mi camino."
  },
  {
    "id": 137,
    "reference": "Salmos 119:114",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 114,
    "endVerse": 114,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Mi escondedero y mi escudo eres tú;\nEn tu palabra he esperado."
  },
  {
    "id": 138,
    "reference": "Salmos 119:116",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 116,
    "endVerse": 116,
    "tags": [
      "esperanza",
      "perseverancia"
    ],
    "text": "Susténtame conforme a tu palabra, y viviré;\nY no quede yo avergonzado de mi esperanza."
  },
  {
    "id": 139,
    "reference": "Salmos 119:130",
    "book": "Salmos",
    "chapter": 119,
    "startVerse": 130,
    "endVerse": 130,
    "tags": [
      "dirección",
      "sabiduría"
    ],
    "text": "La exposición de tus palabras alumbra;\nHace entender a los simples."
  },
  {
    "id": 145,
    "reference": "Salmos 136:1",
    "book": "Salmos",
    "chapter": 136,
    "startVerse": 1,
    "endVerse": 1,
    "tags": [
      "amor",
      "bondad",
      "misericordia"
    ],
    "text": "Alabad a Jehová, porque él es bueno,\nPorque para siempre es su misericordia."
  }
];

function dateSeed(date) {
  return date.getFullYear() * 10000 + (date.getMonth() + 1) * 100 + date.getDate();
}

export function getPassageByIdForEmail(id) {
  return PASSAGES.find((passage) => passage.id === id) || null;
}

function isTicketEligible(passage) {
  return (
    passage.text.length <= MAX_TICKET_CHARS &&
    passage.text.split("\n").length <= MAX_TICKET_LINES
  );
}

export function getDailyShortPassageForEmail(date = new Date()) {
  const pool = PASSAGES.length > 0 ? PASSAGES : PASSAGES;
  return pool[dateSeed(date) % pool.length];
}

export function resolveTicketPassageForEmail({ verseId = null, date = null } = {}) {
  if (verseId != null && verseId !== "") {
    const passage = getPassageByIdForEmail(verseId);
    if (passage && isTicketEligible(passage)) return passage;
  }
  return getDailyShortPassageForEmail(date ?? new Date());
}
