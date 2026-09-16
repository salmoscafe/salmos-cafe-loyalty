import React, { useEffect, useState } from "react";
import { Icon } from "../../components/common/icons.jsx";
import { rewardService, REQUIRED_VISITS, authService } from "../../services/index.js";
import { PrimaryButton, SecondaryButton, Spinner } from "../../components/common/ui.jsx";

// CHECKPOINT 3.1 + 3.2 + 3.2.1 — Pantalla de validación de cliente/recompensa.
// Recibe el resultado del scan (scanCustomerToken) y lo muestra homogéneo:
//   * REAL (Supabase): `customer {id,name,customer_code,loyverse_mapped}`,
//     `cycle/progress/reward` del lookup (lectura pura en la Edge).
//   * DEMO (mock): `customer`, `card`, `cycle` mock + rewardService.
//
// CP3.2.1 — separación de flujos: esta pantalla NO es un paso previo a una
// compra. La compra normal ocurre directo en el POS de Loyverse y Salmos
// jamás escanea al cliente durante ella. El scan de Salmos se reserva a la
// VALIDACIÓN DE RECOMPENSA (el cliente muestra su QR para canjear). Por eso
// aquí solo hay: cliente, progreso, recompensa y `loyverse_mapped` (booleano
// derivado en servidor, jamás el id real). Evolucionará a Claim/OTP/Redeem
// en un checkpoint posterior; "Registrar compra"/"Canjear" solo existen en
// demo (RegisterSale = contingencia) y en real no hay botones que muten nada.
export function CustomerFoundScreen({ result, staff, onBack, onRegisterSale, onRedeemed }) {
  const isDemo = authService.isDemoMode;

  const customer = result?.customer || null;
  const card = result?.card || null; // solo demo
  const cycle = result?.cycle || null;
  const progress = result?.progress || null;
  const reward = result?.reward !== undefined ? result.reward : undefined;

  const [demoReward, setDemoReward] = useState(undefined);
  const [redeeming, setRedeeming] = useState(false);
  const [redeemError, setRedeemError] = useState(null);

  // Modo demo: la recompensa se carga con el rewardService del mock.
  useEffect(() => {
    if (!isDemo || !card) return;
    let cancelled = false;
    rewardService.getCurrentReward(card.id).then((r) => !cancelled && setDemoReward(r));
    return () => {
      cancelled = true;
    };
  }, [isDemo, card]);

  async function handleRedeem() {
    setRedeeming(true);
    setRedeemError(null);
    const res = await rewardService.redeemReward({ cardId: card.id, actorId: staff.id, actorRole: staff.role });
    setRedeeming(false);
    if (!res.ok) {
      setRedeemError(res.error);
      return;
    }
    onRedeemed(res);
  }

  // Progreso normalizado entre los dos modos.
  const visits = progress?.visits ?? cycle?.visits ?? 0;
  const required = progress?.required ?? cycle?.requiredVisits ?? REQUIRED_VISITS;
  const remaining = progress?.remaining ?? Math.max(required - visits, 0);
  const unlocked = progress?.unlocked ?? visits >= required;
  const customerCode = customer?.customer_code ?? card?.cardNumber ?? "";

  const shownReward = isDemo ? demoReward : reward;
  const rewardLoading = isDemo ? !card || demoReward === undefined : false;

  // CP3.2 — booleano derivado en el servidor (edge → buildLookupResult).
  // En demo la respuesta no lo trae (undefined) → null y no se pinta nada.
  // Nunca contiene el loyverse_customer_id real.
  const loyverseMapped =
    typeof result?.customer?.loyverse_mapped === "boolean" ? result.customer.loyverse_mapped : null;

  return (
    <div className="sc-screen">
      <button className="sc-back-link" onClick={onBack}>
        <Icon.ArrowLeft className="sc-icon-sm" /> Escanear otro
      </button>

      <div className="sc-found-card">
        <div className="sc-avatar sc-avatar--lg">{customer?.name?.charAt(0) || "?"}</div>
        <p className="sc-found-name">{customer?.name || "Cliente"}</p>
        <p className="sc-found-number">{customerCode}</p>
        <p className="sc-found-progress">
          {visits}/{required} visitas
        </p>
        {unlocked ? (
          <p className="sc-found-number">Recompensa lista para canjear</p>
        ) : (
          <p className="sc-found-number">{remaining} visita{remaining === 1 ? "" : "s"} restante{remaining === 1 ? "" : "s"}</p>
        )}
      </div>

      {!isDemo && loyverseMapped !== null && (
        <div className={"sc-loyverse-status" + (loyverseMapped ? " sc-loyverse-status--ok" : " sc-loyverse-status--warn")}>
          <p className="sc-loyverse-status__title">
            {loyverseMapped ? "✓ Cliente vinculado a Loyverse" : "⚠ Cliente no vinculado a Loyverse"}
          </p>
          {loyverseMapped ? (
            <p className="sc-loyverse-status__sub">El cliente está vinculado con su contacto en Loyverse.</p>
          ) : (
            <p className="sc-loyverse-status__sub">
              El cliente aún no está vinculado con un contacto en Loyverse; su actividad de lealtad puede no
              registrarse hasta vincularlo.
            </p>
          )}
        </div>
      )}

      {!isDemo && (
        <div className="sc-found-hint">
          <Icon.Gift className="sc-icon" />
          <p>
            El QR de Salmos se usa para validar la identidad y la recompensa del cliente. El canje
            (Claim/OTP/Redeem) se implementa en un siguiente paso.
          </p>
        </div>
      )}

      {rewardLoading && <Spinner label="Verificando recompensas…" />}

      {!rewardLoading && shownReward && (
        <div className="sc-reward-current sc-reward-current--ready">
          <div className="sc-reward-current__icon">
            <Icon.Gift className="sc-icon" />
          </div>
          <div>
            <p className="sc-reward-current__name">
              {isDemo ? shownReward.label : "Café gratis"}
            </p>
            <p className="sc-reward-current__meta">
              {isDemo
                ? "Lista para canjear"
                : rewardMeta(shownReward)}
            </p>
          </div>
        </div>
      )}

      {!rewardLoading && !shownReward && unlocked && (
        <p className="sc-found-number">Sin recompensa activa. Consulta con tu Staff.</p>
      )}

      {redeemError && <p className="sc-login__error">{redeemError}</p>}

      {isDemo && (
        <>
          <PrimaryButton onClick={onRegisterSale}>Registrar compra</PrimaryButton>
          {shownReward && (
            <SecondaryButton onClick={handleRedeem} disabled={redeeming}>
              {redeeming ? "Canjeando…" : "Canjear recompensa"}
            </SecondaryButton>
          )}
        </>
      )}
    </div>
  );
}

function rewardMeta(reward) {
  if (!reward?.expires_at) return "Disponible";
  const date = new Date(reward.expires_at).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
  return `Vence el ${date}${reward?.max_value ? ` · hasta $${reward.max_value}` : ""}`;
}