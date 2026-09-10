import React, { useEffect, useRef, useState } from "react";
import { AuthMessage } from "./AuthMessage.jsx";
import { PrimaryButton, SecondaryButton } from "../common/ui.jsx";

const LENGTH = 6;
const RESEND_SECONDS = 30;

// Componente OTP reutilizable — lo usan tanto existing_verify como
// new_verify (mismo componente, distinto copy alrededor).
//
// Convención de prueba en esta etapa mock (ver authService.js):
// "123456" siempre es válido · "000000" siempre simula vencido ·
// cualquier otro valor de 6 dígitos simula "código incorrecto".
export function OtpVerification({ title, subtitle, maskedContact, onVerify, onResend, onUseAnotherMethod }) {
  const [digits, setDigits] = useState(Array(LENGTH).fill(""));
  const [status, setStatus] = useState("idle"); // idle | verifying | invalid | expired | transient
  const [cooldown, setCooldown] = useState(RESEND_SECONDS);
  const inputsRef = useRef([]);

  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown((c) => c - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  useEffect(() => {
    if (digits.every((d) => d !== "") && status !== "verifying") {
      handleVerify(digits.join(""));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [digits]);

  function setDigitAt(index, value) {
    setDigits((prev) => {
      const next = [...prev];
      next[index] = value;
      return next;
    });
  }

  function handleChange(index, raw) {
    const value = raw.replace(/\D/g, "");
    if (!value) {
      setDigitAt(index, "");
      return;
    }
    setDigitAt(index, value.slice(-1));
    if (index < LENGTH - 1) inputsRef.current[index + 1]?.focus();
  }

  function handleKeyDown(index, e) {
    if (e.key === "Backspace" && !digits[index] && index > 0) {
      inputsRef.current[index - 1]?.focus();
    }
  }

  function handlePaste(e) {
    const text = e.clipboardData.getData("text").replace(/\D/g, "").slice(0, LENGTH);
    if (!text) return;
    e.preventDefault();
    const next = Array(LENGTH).fill("");
    for (let i = 0; i < text.length; i++) next[i] = text[i];
    setDigits(next);
    inputsRef.current[Math.min(text.length, LENGTH - 1)]?.focus();
  }

  async function handleVerify(code) {
    setStatus("verifying");
    const res = await onVerify(code);
    if (res?.ok) return; // AuthScreen se encarga de la transición
    setStatus(res?.error === "expired" ? "expired" : res?.error === "transient" ? "transient" : "invalid");
    setDigits(Array(LENGTH).fill(""));
    inputsRef.current[0]?.focus();
  }

  async function handleResend() {
    setStatus("idle");
    setDigits(Array(LENGTH).fill(""));
    setCooldown(RESEND_SECONDS);
    await onResend();
    inputsRef.current[0]?.focus();
  }

  return (
    <div className="sc-auth-otp">
      <p className="sc-auth-eyebrow">{title}</p>
      <p className="sc-auth-sub">{subtitle || `Enviamos un código a ${maskedContact}`}</p>

      <div className="sc-otp-row" onPaste={handlePaste}>
        {digits.map((d, i) => (
          <input
            key={i}
            ref={(el) => (inputsRef.current[i] = el)}
            className={"sc-otp-box" + (status === "invalid" || status === "expired" ? " sc-otp-box--error" : "")}
            inputMode="numeric"
            pattern="[0-9]*"
            maxLength={1}
            value={d}
            autoFocus={i === 0}
            disabled={status === "verifying"}
            onChange={(e) => handleChange(i, e.target.value)}
            onKeyDown={(e) => handleKeyDown(i, e)}
            aria-label={`Dígito ${i + 1} de ${LENGTH}`}
          />
        ))}
      </div>

      {status === "invalid" && <AuthMessage tone="error">Ese código no es correcto.</AuthMessage>}
      {status === "expired" && (
        <AuthMessage
          tone="error"
          action={{ label: "Enviar uno nuevo", onClick: handleResend }}
        >
          Este código venció.
        </AuthMessage>
      )}
      {status === "transient" && (
        <AuthMessage tone="error" action={{ label: "Reintentar", onClick: () => handleVerify(digits.join("")) }}>
          Algo salió mal. Intenta de nuevo.
        </AuthMessage>
      )}

      <PrimaryButton
        type="button"
        disabled={digits.some((d) => d === "") || status === "verifying"}
        onClick={() => handleVerify(digits.join(""))}
      >
        {status === "verifying" ? "Verificando…" : "Confirmar"}
      </PrimaryButton>

      <div className="sc-auth-otp__actions">
        <SecondaryButton type="button" disabled={cooldown > 0} onClick={handleResend}>
          {cooldown > 0 ? `Reenviar código (${cooldown}s)` : "Reenviar código"}
        </SecondaryButton>
        <button type="button" className="sc-auth-link" onClick={onUseAnotherMethod}>
          Usar otro método
        </button>
      </div>

      <p className="sc-login__demo-hint">Prueba: 123456 válido · 000000 vencido · otro = incorrecto</p>
    </div>
  );
}
