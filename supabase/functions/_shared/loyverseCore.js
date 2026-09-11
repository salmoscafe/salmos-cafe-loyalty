// ---------------------------------------------------------------
// loyverseCore — Lógica pura de sincronización Salmos⇄Loyverse.
// Vive del lado servidor (Edge Function) y es el único lugar donde se
// decide: buscar por email → buscar por teléfono → vincular o crear.
//
// Es 100% agnóstico del transporte: recibe un `transport` con
//   { listByEmail(email), listByPhone(phone), create(payload),
//     update(customerId, payload) }
// y no depende de Deno ni de Supabase, por eso es unit-testable con
// node --test (ver tests/loyverse-sync.test.mjs).
//
// API de Loyverse (v1.0, https://api.loyverse.com/v1.0/customers):
//   * GET  /customers?email=...&limit=1          filtra por EMAIL.
//   * GET  /customers?limit=250&cursor=...       NO filtra por teléfono:
//                                                se lista+y-filtra acá.
//   * POST /customers                            crea con name, email,
//                                                phone_number, customer_code.
//   * PUT  /customers/{id}                       actualiza SOLO los campos
//                                                que se envían; los campos
//                                                derivados del POS (total_*)
//                                                nunca viajan ni se tocan.
//   * Las listas devuelven { customers: [...], cursor? } (cursor opcional).
//   * Rate limit: 300 req / 300 s por cuenta.
// ---------------------------------------------------------------

export function normalizeEmail(value) {
  if (value == null) return null;
  const v = String(value).trim().toLowerCase();
  return v || null;
}

export function normalizePhone(value) {
  if (value == null) return null;
  const digits = String(value).replace(/\D/g, "");
  return digits || null;
}

// Formato E.164 para el campo phone_number de Loyverse (≤ 15 chars).
// Si el valor ya viene con "+", se conserva el país; si no, se asume +52.
export function toE164(value, defaultCountryCode = "52") {
  const digits = normalizePhone(value);
  if (!digits) return null;
  const hasPlus = String(value).trim().startsWith("+");
  const e164 = hasPlus ? `+${digits}` : `+${defaultCountryCode}${digits}`;
  return e164.length <= 15 ? e164 : e164.slice(0, 15);
}

function sameCustomer(a, b) {
  if (!a || !b) return false;
  if (a.id && b.id) return a.id === b.id;
  if (a.email && b.email) return normalizeEmail(a.email) === normalizeEmail(b.email);
  if (a.phone_number && b.phone_number) return normalizePhone(a.phone_number) === normalizePhone(b.phone_number);
  return false;
}

function pickUnique(list) {
  const ids = new Set((list || []).filter(Boolean).map((c) => c.id));
  return ids.size === 1 ? list[0] : null;
}

// Resuelve a qué cliente de Loyverse apunta esta persona.
//   linked    → id del cliente a vincular (email, teléfono o ambos).
//   conflict  → NO se decide: email→X y teléfono→Y, o teléfono ambiguo.
//   none      → no hay cliente: hay que crear.
export function resolveLoyverseTarget({ emailMatches, phoneMatches }) {
  const emails = emailMatches || [];
  const phones = phoneMatches || [];
  const emailTarget = emails.length ? emails[0] : null;
  const phoneTarget = phones.length ? pickUnique(phones) : null;

  if (emailTarget && phones.length) {
    if (phoneTarget && sameCustomer(emailTarget, phoneTarget)) {
      return { status: "linked", loyverseCustomerId: emailTarget.id, audit: { via: "email_and_phone", id: emailTarget.id } };
    }
    return {
      status: "conflict",
      audit: {
        code: phoneTarget ? "email_phone_conflict" : "ambiguous_phone",
        emailCustomerId: emailTarget.id,
        phoneCustomerIds: phones.map((c) => c.id),
      },
    };
  }
  if (emailTarget) {
    return { status: "linked", loyverseCustomerId: emailTarget.id, audit: { via: "email", id: emailTarget.id } };
  }
  if (phones.length) {
    if (!phoneTarget) {
      return { status: "conflict", audit: { code: "ambiguous_phone", phoneCustomerIds: phones.map((c) => c.id) } };
    }
    return { status: "linked", loyverseCustomerId: phoneTarget.id, audit: { via: "phone", id: phoneTarget.id } };
  }
  return { status: "none", audit: { via: null } };
}

export function isDuplicateCustomerCodeError(error) {
  const message = String(error?.message || "").toLowerCase();
  const body = String(error?.body || "");
  return (
    error?.status === 400 &&
    (message.includes("customer_code") || body.toLowerCase().includes("customer_code"))
  );
}

// --------------------- Actualización de identidad -----------------------
//
// Reglas conservadoras (decididas con el socio, ver docs/CURRENT_STATUS.md):
//   * Email/teléfono IDÉNTICOS (tras normalizar)  → nada que hacer.
//   * Email/teléfono FALTANTES en Loyverse       → rellenar (fill).
//   * Email/teléfono DIFERENTES (ambos presentes)→ NUNCA se sobrescriben:
//     se bloquea toda la sincronización (conflicto identity_conflict) y se
//     guía al cliente a vincular correo y teléfono o recuperar su contraseña.
//   * customer_code null en Loyverse             → se establece (fill).
//   * customer_code DIFERENTE (no nulo)          → se omite y se registra en
//     auditoría (nunca se pisa el código del POS).
//   * Nombre vacío en Loyverse                   → se rellena (fill).
//   * Nombre DIFERENTE (no vacío)                → se omite y se registra.
//   * Datos del POS (total_visits, total_spent, total_points, ventas) NO
//     se leen ni se mandan jamás en el update.
//
// `fill` solo se aplica cuando la base de Loyverse está incompleta y Salmos
// tiene el dato; nunca cuando hay dos valores distintos.

// Compara los datos de Salmos con el cliente Loyverse ya resuelto y devuelve:
//   { fills, block, skipped }
//   fills   → { campo: valor } a mandar por PUT (solo rellenos seguros).
//   block   → campos que NO se sobrescriben y bloquean el sync
//             (`email`/`phone` por regla conservadora).
//   skipped → campos que se omiten sin bloquear (`name`/`customer_code`),
//             se registran en auditoría.
export function computeIdentityUpdates({ name, email, phone, customerCode, loyverse }) {
  const fills = {};
  const block = [];
  const skipped = [];
  const lv = loyverse || {};

  const lvEmail = normalizeEmail(lv.email);
  const salmosEmail = normalizeEmail(email);
  if (salmosEmail) {
    if (!lvEmail) fills.email = salmosEmail;
    else if (lvEmail !== salmosEmail) block.push("email");
  }

  const lvPhoneRaw = normalizePhone(lv.phone_number);
  // Ambos lados se normalizan a la MISMA clave E.164: así "+526641234567"
  // (Loyverse) y "6641234567" (Salmos, sin prefijo) son el mismo número.
  const lvPhoneKey = lvPhoneRaw ? normalizePhone(toE164(lv.phone_number)) : null;
  const salmosPhoneKey = phone ? normalizePhone(toE164(phone)) : null;
  const salmosE164 = toE164(phone);
  if (phone) {
    if (!lvPhoneRaw) fills.phone_number = salmosE164;
    else if (lvPhoneKey !== salmosPhoneKey) block.push("phone");
  }

  const lvCode = String(lv.customer_code || "").trim();
  const salmosCode = String(customerCode || "").trim();
  if (salmosCode) {
    if (!lvCode) fills.customer_code = salmosCode.slice(0, 40);
    else if (lvCode !== salmosCode) skipped.push("customer_code");
  }

  const lvName = String(lv.name || "").trim();
  const salmosName = String(name || "").trim();
  if (salmosName) {
    if (!lvName) fills.name = salmosName.slice(0, 64);
    else if (lvName !== salmosName) skipped.push("name");
  }

  return { fills, block, skipped };
}

function pickResolvedCustomer(emailMatches, phoneMatches) {
  const emailTarget = (emailMatches || [])[0] || null;
  if (emailTarget) return emailTarget;
  return pickUnique(phoneMatches || []) || null;
}

// ----------------------------- Orquestación -----------------------------

// Orden de operación (clave para no duplicar):
//   1. Si ya tenemos loyverse_customer_id → idempotencia total (sin red).
//   2. Buscar por email (filtro oficial de la API).
//   3. Buscar por teléfono (la API no lo filtra; listar + filtrar).
//   4. Vincular si se encuentra uno compatible; conflicto si email y
//      teléfono apuntan a clientes distintos; crear solo si no existe.
//   5. Si crear falla por customer_code duplicado (doble submit), se
//      rebusca y vincula en vez de fallar.
export async function createOrLinkLoyverseCustomer({
  transport,
  name,
  email,
  phone,
  customerCode,
  knownLoyverseCustomerId,
}) {
  if (knownLoyverseCustomerId) {
    return { status: "already_linked", loyverseCustomerId: knownLoyverseCustomerId, audit: { known: true } };
  }

  const normalizedEmail = normalizeEmail(email);
  const normalizedPhone = normalizePhone(phone);
  if (!normalizedEmail && !normalizedPhone && !name) {
    return { status: "conflict", audit: { code: "no_identifiers" } };
  }

  const emailMatches = normalizedEmail ? await transport.listByEmail(normalizedEmail) : [];
  const phoneMatches = normalizedPhone ? await transport.listByPhone(normalizedPhone) : [];

  const resolution = resolveLoyverseTarget({ emailMatches, phoneMatches });
  if (resolution.status === "linked") {
    // Ya resuelto a UN cliente de Loyverse: se comparan los datos y se
    // decide si hay que actualizar (solo rellenos) o si hay conflicto de
    // identidad (email/teléfono distintos → bloque). Nunca se sobrescriben
    // valores distintos ni se tocan datos derivados del POS.
    const identity = computeIdentityUpdates({
      name,
      email: normalizedEmail,
      phone: normalizedPhone,
      customerCode,
      loyverse: pickResolvedCustomer(emailMatches, phoneMatches),
    });

    if (identity.block.length) {
      return {
        status: "conflict",
        audit: {
          code: "identity_conflict",
          fields: identity.block,
          loyverseCustomerId: resolution.loyverseCustomerId,
          via: resolution.audit.via,
        },
      };
    }

    if (Object.keys(identity.fills).length) {
      await transport.update(resolution.loyverseCustomerId, identity.fills);
      return {
        status: "updated",
        loyverseCustomerId: resolution.loyverseCustomerId,
        audit: {
          ...resolution.audit,
          updated: true,
          fields: Object.keys(identity.fills),
          skippedFields: identity.skipped,
        },
      };
    }

    return {
      status: "linked",
      loyverseCustomerId: resolution.loyverseCustomerId,
      audit: { ...resolution.audit, updated: false, skippedFields: identity.skipped },
    };
  }
  if (resolution.status === "conflict") {
    return { status: "conflict", audit: resolution.audit };
  }

  // No existe → crear.
  try {
    const created = await transport.create({
      name: String(name || "Cliente Salmos").slice(0, 64),
      email: normalizedEmail,
      phone_number: toE164(phone),
      customer_code: String(customerCode || "").slice(0, 40) || undefined,
    });
    return { status: "created", loyverseCustomerId: created.id, audit: { created: true, id: created.id } };
  } catch (error) {
    if (isDuplicateCustomerCodeError(error)) {
      // Alguien más acaba de crearlo (o ya existía con ese código):
      // rebuscar y vincular en lugar de fallar.
      const emailAgain = normalizedEmail ? await transport.listByEmail(normalizedEmail) : [];
      const phoneAgain = normalizedPhone ? await transport.listByPhone(normalizedPhone) : [];
      const retry = resolveLoyverseTarget({ emailMatches: emailAgain, phoneMatches: phoneAgain });
      if (retry.status === "linked") {
        return {
          status: "linked",
          loyverseCustomerId: retry.loyverseCustomerId,
          audit: { ...retry.audit, afterDuplicateCode: true },
        };
      }
    }
    throw error;
  }
}