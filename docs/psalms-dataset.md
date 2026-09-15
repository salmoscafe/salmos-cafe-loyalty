# Dataset de Salmos — Checkpoint

Estado del dataset local de pasajes de Salmos que la aplicación consumirá
(todavía **sin integración** con UI o lógica). Este documento describe el
proceso de construcción y el estado verificado del archivo, **no** duplica el
contenido de `src/data/bible-verses.json`.

Fecha del checkpoint: 2026-09-15.

---

## 1. Objetivo del dataset

Proveer a la aplicación una colección **local y offline** de pasajes de
Salmos en español (texto RVR1960), lista para ser consumida directamente
desde:

```
src/data/bible-verses.json
```

Cada pasaje incluye su referencia canónica, su numeración (capítulo y
versículos inicial/final) y sus etiquetas temáticas, más el texto bíblico en
texto plano.

## 2. Por qué se creó

- La aplicación necesita contenido bíblico de Salmos con etiquetas temáticas
  (p. ej. "confianza", "paz", "fortaleza") para mostrar pasajes al usuario.
- No debe existir ninguna dependencia de red en runtime (ni GitHub, ni HTTP,
  ni API bíblica) para obtener los textos: todo vive en el archivo local.
- Se parte de una curaduría de **150 referencias únicas y verificadas**,
  ordenadas por capítulo/versículo, sin duplicados, con IDs consecutivos.

## 3. Archivo principal

`src/data/bible-verses.json` — **único** archivo permanente de esta etapa.

Estado verificado:

- 150 referencias.
- 150 referencias **únicas**.
- IDs consecutivos del 1 al 150.
- 19 categorías/tags.
- 150 textos RVR1960 poblados.
- 54 pasajes individuales (un solo versículo).
- 96 rangos (varios versículos).
- 1,406/1,406 versículos consecutivos resueltos, 0 huecos.
- 0 referencias sin resolver.
- ~28,200 caracteres de texto total.

## 4. Estructura de los registros

Cada registro tiene exactamente esta forma:

```json
{
  "id": 1,
  "reference": "Salmos 1:1-3",
  "book": "Salmos",
  "chapter": 1,
  "startVerse": 1,
  "endVerse": 3,
  "tags": ["dirección", "sabiduría"],
  "text": "..."
}
```

Campos:

| Campo | Descripción |
|---|---|
| `id` | Entero consecutivo 1–150, identifica de forma estable al pasaje |
| `reference` | Referencia legible, única, formato `Salmos C:V` o `Salmos C:V1-V2` |
| `book` | Siempre `"Salmos"` |
| `chapter` | Número de capítulo (1–150) |
| `startVerse` | Primer versículo del pasaje |
| `endVerse` | Último versículo del pasaje (≥ `startVerse`) |
| `tags` | Arreglo de etiquetas temáticas (19 categorías) |
| `text` | Texto bíblico RVR1960 en texto plano, sin HTML ni metadatos |

## 5. Las 150 referencias

Agrupadas por capítulo (todas son únicas; IDs 1–150 en orden de capítulo →
versículo):

- **Cap. 1–9:** `Salmos 1:1-3`, `2:12`, `3:3-5`, `4:6-8`, `4:8`, `5:11-12`,
  `6:6-9`, `7:10`, `8:1-4`, `9:9-10`.
- **Cap. 13–20:** `13:5`, `13:5-6`, `15:1-2`, `16:7-8`, `16:8`, `16:11`,
  `18:1-2`, `18:16-19`, `18:28-29`, `18:30-32`, `18:46`, `18:46-49`,
  `19:1-4`, `19:7-11`, `19:12-14`, `20:7`.
- **Cap. 23–34:** `23:1-4`, `23:4`, `23:6`, `24:3-5`, `25:1-2`, `25:4-5`,
  `25:6-7`, `27:1`, `27:4-5`, `27:13-14`, `28:7`, `29:11`, `30:5`,
  `31:7-8`, `31:14-15`, `31:19-20`, `31:23-24`, `32:1-2`, `32:8`, `32:10`,
  `33:5`, `33:18-19`, `33:20-22`, `34:1-3`, `34:8`, `34:11-14`, `34:13-14`,
  `34:17-18`, `34:18`.
- **Cap. 36–48:** `36:5-7`, `37:3-5`, `37:7`, `37:23-24`, `37:27`, `37:34`,
  `39:7`, `40:1-3`, `40:11-12`, `41:1-3`, `42:5`, `42:11`, `43:5`,
  `44:5-8`, `46:1-3`, `47:1-2`, `48:14`.
- **Cap. 50–73:** `50:15`, `51:10-12`, `51:16-17`, `52:8-9`, `52:9`,
  `54:4`, `55:16-18`, `55:22`, `56:3-4`, `57:10`, `59:16-17`, `61:1-2`,
  `61:1-3`, `62:1-2`, `62:5-8`, `63:1-4`, `63:3-4`, `66:19-20`, `68:5`,
  `68:19`, `71:5-6`, `71:14`, `71:20-21`, `73:24`, `73:25-26`, `73:26`.
- **Cap. 84–103:** `84:1-4`, `84:10-12`, `84:11-12`, `85:10`, `86:5`,
  `86:6-7`, `86:11`, `86:15`, `90:12`, `91:1-2`, `91:9-11`, `92:12-15`,
  `94:17-18`, `94:19`, `95:1-7`, `96:1-4`, `98:1-4`, `100:1-5`, `100:4-5`,
  `101:2-3`, `101:6`, `103:1-5`, `103:8-13`, `103:17-18`.
- **Cap. 107–150:** `107:1`, `111:10`, `112:7-8`, `113:1-3`, `116:7`,
  `117:1-2`, `118:1-4`, `119:1-2`, `119:9-11`, `119:33-35`, `119:71`,
  `119:81`, `119:97-105`, `119:105`, `119:114`, `119:116`, `119:130`,
  `121:1-4`, `125:1-2`, `126:5-6`, `130:5-7`, `131:1-2`, `136:1`,
  `138:7-8`, `139:23-24`, `145:8-9`, `147:10-11`, `150:1-6`.

## 6. Tags (19 categorías)

`adoración`, `alabanza`, `amor`, `ansiedad`, `bondad`, `confianza`,
`consuelo`, `dirección`, `esperanza`, `fortaleza`, `gratitud`,
`misericordia`, `obediencia`, `paz`, `perseverancia`, `protección`,
`sabiduría`, `santidad`, `transformación`.

## 7. Fuente utilizada para poblar el texto

Para extraer el texto de los 150 pasajes se inspeccionó (sin clonar el repo):

- Repositorio externo: `mrk214/bible-data-es-spa`.
- Archivo: `data/es___spa___spa/RVR1960_vid_149.json`.
- Snapshot identificado/disponible:
  `https://mrk214.github.io/snapshots/es___spa___spa/RVR1960_vid_149.json`.

**Aviso de derechos y licencia:**

- La licencia `MIT` del repositorio externo cubre la estructura/el código del
  dataset, **no** el texto bíblico.
- El texto RVR1960 embebido en el archivo lleva el aviso original del
  dataset:
  > Texto bíblico Reina-Valera 1960® © Sociedades Bíblicas en América
  > Latina, 1960. Derechos renovados 1988, Sociedades Bíblicas Unidas.
  > `publisher: United Bible Societies`.

El dataset externo es **solo una herramienta de extracción puntual**. No
forma parte del runtime de la aplicación (ver sección 15).

### Estructura detectada del JSON fuente

- **Raíz**: objeto con metadatos y `books[]`.
- **`books[]`**: arreglo de libros; `PSA` corresponde a **Salmos**.
- **`PSA`**: `{ book_usfm, name, chapters[] }` con `name: "Salmos"`.
- **`chapters[]`**: cada capítulo se identifica por `chapter_usfm`
  (formato `PSA.<n>`, p. ej. `PSA.23`).
- **Versículos**: dentro de cada capítulo, el arreglo `items[]` contiene
  ítems de tipo `verse` con `verse_numbers: [n]` y `lines[]` (una línea por
  estrofa).
- **Extracción del contenido textual**: se unen las `lines` de cada ítem
  `verse` con saltos de línea (`\n`), conservando la poesía del salmo.
- **Eliminación de HTML y metadatos**: el texto final NO incluye números de
  versículo, `<span>`, clases CSS, atributos `data-usfm` ni metadatos del
  dataset. Los ítems `heading1`/`label` (títulos, superscripciones como
  "Salmo de David") se excluyen por no ser texto de versículo.

## 8. Cómo se realizó la extracción

1. Se descargó el JSON fuente a un directorio temporal fuera del repo.
2. Se localizó `PSA` en `books[]` y se construyó un mapa
   `capítulo → (versículo → texto)` a partir de los ítems `verse`.
3. Para cada registro de `bible-verses.json` se usó su `chapter`,
   `startVerse` y `endVerse` para seleccionar exactamente los versículos del
   pasaje.
4. El texto quedó como concatenación de los versículos del rango respetando
   el orden.
5. Se validó contra una copia previa que los campos existentes no cambiaron
   y que solo se agregó `text`.

El script de extracción era **temporal** y fue eliminado al terminar; no
existe ningún archivo de extracción ni dump del dataset externo dentro del
repositorio.

## 9. Tratamiento de rangos

- `startVerse === endVerse` → se usa únicamente ese versículo.
- `startVerse < endVerse` → se extraen TODOS los versículos desde
  `startVerse` hasta `endVerse`, en orden, y se combinan en un único string
  (un `\n` entre versículos).
- Nunca se agregan versículos fuera del rango (p. ej. `Salmos 23:1-4`
  contiene solamente 23:1–23:4).

## 10. Tratamiento de `Selah`

El dataset fuente representa `Selah` como un ítem `label` separado; sin
embargo, en el texto impreso RVR1960 `Selah` es **parte del texto del
versículo**. Por eso en `bible-verses.json`:

- `Selah` queda incorporado **dentro de `text`**, al final del versículo al
  que pertenece (en línea, respetando la puntuación de la fuente, p. ej.
  `... su monte santo. Selah`).
- No se trata como un versículo independiente, no incrementa la numeración y
  no genera registros adicionales.
- En pasajes de rango queda dentro del texto combinado, en la posición del
  versículo correspondiente.

Casos afectados y validados:

| Pasaje (registro) | Versículo con `Selah` |
|---|---|
| `Salmos 3:3-5` | 3:4 |
| `Salmos 44:5-8` | 44:8 |
| `Salmos 46:1-3` | 46:3 |
| `Salmos 62:5-8` | 62:8 |
| `Salmos 68:19` | 68:19 |
| `Salmos 84:1-4` | 84:4 |

## 11. Tratamiento de labels de Salmos 119

Las **letras acrósticas** de Salmos 119 (labels como `Alef`, `Bet`,
`Guímel`, … `Nun` …) fueron **excluidas** del texto: son cabeceras de
estrofa, no forman parte del texto del versículo al que se asocian. Los
versículos de Salmos 119 presentes en el dataset contienen únicamente su
texto bíblico.

## 12. Validaciones realizadas (1406/1406)

Sobre `src/data/bible-verses.json`, al cierre del poblamiento:

- 150 registros; 150 referencias únicas; IDs 1–150 consecutivos.
- Todos con `tags` (19 categorías).
- `chapter` válido (1–150) y `startVerse <= endVerse`.
- 150/150 textos `text` poblados, string, no vacíos, sin HTML (`<`, `>`,
  `data-usfm`).
- Cobertura 1,406/1,406 versículos consecutivos en los capítulos usados;
  0 huecos; 0 referencias sin resolver.
- Campos originales (`id`, `reference`, `book`, `chapter`, `startVerse`,
  `endVerse`, `tags`) intactos vs. la copia previa; se agregó únicamente
  `text` (mismas claves, mismo orden por registro).
- Números de versículo y atributos USFM eliminados del texto final.
- Texto conservado **línea por línea** (poesía de Salmos preservada vía
  `lines.join("\n")`).
- **Comparación doble** entre la vía `items` y la vía del HTML renderizado:
  **1,406/1,406 coincidencias** (normalizando separadores de línea/espaciado);
  incluye los 6 casos de `Selah` y la exclusión de los labels acrósticos de
  Salmos 119.
- **Spot checks** (revisión manual del texto resultante):
  - `Salmos 23:1-4`
  - `Salmos 27:13-14`
  - `Salmos 46:1-3`
  - `Salmos 4:8` (pasaje de un solo versículo)
  - `Salmos 103:8-13` (rango largo)
  - `Salmos 2:12` (referencia agregada para completar las 150)

> Nota: los scripts de validación fueron temporales y eliminados al terminar;
> las conclusiones quedan registradas aquí como evidencia verificada.

## 13. Tests del proyecto

```
node --test "tests/*.test.mjs"
```

Resultado en el checkpoint: **180/180 pass** (sin modificar ningún test
existente; esta etapa no agregó ni cambió pruebas).

## 14. Build del proyecto

```
npm run build
```

Resultado: **success** (Vite). Único warning conocido: el **preexistente** de
chunk > 500 kB (`assets/index-*.js`), ajeno a esta etapa.

## 15. El dataset es local — sin dependencia externa en runtime

- La aplicación consumirá únicamente `src/data/bible-verses.json`.
- **No** habrá dependencia de GitHub, HTTP, ni de una API bíblica para
  obtener estos textos durante la ejecución.
- El repositorio externo `mrk214/bible-data-es-spa` y su snapshot fueron
  usados **una sola vez** para extraer los textos; no son parte del runtime.
- `src/data/bible-verses.json` es autocontenido: referencia + numeración +
  tags + texto en plano.

## 16. Estado actual y siguiente etapa

**Estado (cerrado en este checkpoint):**

- Dataset de Salmos construido y validado: 150 pasajes, 19 tags, textos
  RVR1960 completos, cobertura 1,406/1,406, sin dependencias externas.
- Documentación de esta etapa: este documento.
- Sin commit ni push aún de esta documentación/dataset (ver sección Git).

**Siguiente etapa (NO implementada todavía):**

- Integrar `src/data/bible-verses.json` con la UI y/o lógica de la
  aplicación (selección de pasajes por tag, visualización del texto, etc.).
- Cualquier integración deberá consumir el archivo local; no se debe
  introducir una fuente remota de textos bíblicos.
- Respetar y conservar el aviso de derechos de RVR1960 citado en la
  sección 7 en cualquier presentación del texto al usuario.